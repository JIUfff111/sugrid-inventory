import { requireRole, requireUser, authErrorResponse } from '@/lib/auth';
import { NextRequest, NextResponse } from 'next/server';
import db from '@/lib/db';
import { errorResponse, formatDateTime, generateId, successResponse } from '@/lib/api-helpers';

const FIELD_KEYS = ['product', 'config', 'sn', 'purchasePrice', 'supplier', 'inboundDate'] as const;
const DEFAULT_FIELDS: LabelField[] = [
  { key: 'product', visible: true, order: 0, fontSize: 14, align: 'left', x: 3, y: 4 },
  { key: 'config', visible: true, order: 1, fontSize: 13, align: 'left', x: 5, y: 22 },
  { key: 'sn', visible: false, order: 2, fontSize: 8, align: 'left', x: 4, y: 34 },
  { key: 'purchasePrice', visible: false, order: 3, fontSize: 8, align: 'left', x: 4, y: 49 },
  { key: 'supplier', visible: false, order: 4, fontSize: 8, align: 'left', x: 4, y: 64 },
  { key: 'inboundDate', visible: true, order: 5, fontSize: 12, align: 'left', x: 3, y: 82 },
];
const DEFAULT_ELEMENTS: LabelElement[] = [
  {
    id: 'reference-divider',
    type: 'line',
    x: 2,
    y: 16,
    width: 96,
    height: 1,
    style: { stroke: '#111111', strokeWidth: 1.25, lineStyle: 'solid' },
  },
  {
    id: 'reference-barcode',
    type: 'barcode',
    x: 8,
    y: 42,
    width: 84,
    height: 31,
    contentKey: 'sn',
    style: { foreground: '#000000', background: '#ffffff', showText: true, fontSize: 9 },
  },
];

type LabelFieldKey = typeof FIELD_KEYS[number];
type LabelField = {
  key: LabelFieldKey;
  visible: boolean;
  order: number;
  fontSize: number;
  align: 'left' | 'center' | 'right';
  x?: number;
  y?: number;
};
type LabelElementType = 'line' | 'barcode';
type LabelElementStyle = {
  stroke?: string;
  strokeWidth?: number;
  lineStyle?: 'solid' | 'dashed' | 'dotted';
  foreground?: string;
  background?: string;
  showText?: boolean;
  fontSize?: number;
};
type LabelElement = {
  id: string;
  type: LabelElementType;
  x: number;
  y: number;
  width: number;
  height: number;
  contentKey?: LabelFieldKey;
  style: LabelElementStyle;
};
type LabelTemplate = {
  id: string;
  templateName: string;
  templateType: string;
  width: 60 | 80;
  height: 40 | 50;
  orientation: 'portrait' | 'landscape';
  fieldGap: number;
  layoutMode: 'flow' | 'free';
  fields: LabelField[];
  elements: LabelElement[];
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
};
type LabelTemplateRow = Omit<LabelTemplate, 'fields' | 'elements' | 'isDefault' | 'width' | 'height' | 'fieldGap' | 'layoutMode'> & {
  fields: string;
  isDefault: number;
  width: number;
  height: number;
};

function jsonError(message: string, status = 400) {
  return NextResponse.json(errorResponse('VALIDATION_ERROR', message), { status });
}

function normalizeFields(value: unknown): LabelField[] | null {
  if (!Array.isArray(value) || value.length !== FIELD_KEYS.length) return null;
  const seen = new Set<string>();
  const fields: LabelField[] = [];

  for (const entry of value) {
    if (!entry || typeof entry !== 'object') return null;
    const field = entry as Partial<LabelField>;
    if (!FIELD_KEYS.includes(field.key as LabelFieldKey) || seen.has(String(field.key))) return null;
    if (typeof field.visible !== 'boolean') return null;
    if (!Number.isInteger(field.order) || Number(field.order) < 0 || Number(field.order) >= FIELD_KEYS.length) return null;
    if (!Number.isInteger(field.fontSize) || Number(field.fontSize) < 6 || Number(field.fontSize) > 24) return null;
    if (!['left', 'center', 'right'].includes(String(field.align))) return null;
    const hasX = field.x !== undefined;
    const hasY = field.y !== undefined;
    if (hasX !== hasY) return null;
    if (hasX && (!Number.isFinite(Number(field.x)) || Number(field.x) < 0 || Number(field.x) > 100)) return null;
    if (hasY && (!Number.isFinite(Number(field.y)) || Number(field.y) < 0 || Number(field.y) > 100)) return null;
    seen.add(String(field.key));
    const normalizedField: LabelField = {
      key: field.key as LabelFieldKey,
      visible: field.visible,
      order: Number(field.order),
      fontSize: Number(field.fontSize),
      align: field.align as LabelField['align'],
    };
    if (hasX && hasY) {
      normalizedField.x = Number(field.x);
      normalizedField.y = Number(field.y);
    }
    fields.push(normalizedField);
  }

  if (seen.size !== FIELD_KEYS.length || new Set(fields.map((field) => field.order)).size !== FIELD_KEYS.length) return null;
  return fields.sort((a, b) => a.order - b.order);
}

const ELEMENT_TYPES: LabelElementType[] = ['line', 'barcode'];
const ELEMENT_LINE_STYLES: LabelElementStyle['lineStyle'][] = ['solid', 'dashed', 'dotted'];

function readElementNumber(value: unknown, minimum: number, maximum: number): number | null {
  const number = Number(value);
  return Number.isFinite(number) && number >= minimum && number <= maximum ? number : null;
}

function normalizeElementStyle(value: unknown, type: LabelElementType): LabelElementStyle | null {
  if (value !== undefined && value !== null && (typeof value !== 'object' || Array.isArray(value))) return null;
  const style = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  const normalized: LabelElementStyle = {};
  if (style.stroke !== undefined) {
    if (typeof style.stroke !== 'string' || style.stroke.length > 32) return null;
    normalized.stroke = style.stroke;
  }
  if (style.strokeWidth !== undefined) {
    const strokeWidth = readElementNumber(style.strokeWidth, 0.25, 12);
    if (strokeWidth === null) return null;
    normalized.strokeWidth = strokeWidth;
  }
  if (style.lineStyle !== undefined) {
    if (!ELEMENT_LINE_STYLES.includes(style.lineStyle as LabelElementStyle['lineStyle'])) return null;
    normalized.lineStyle = style.lineStyle as LabelElementStyle['lineStyle'];
  }
  if (style.foreground !== undefined) {
    if (typeof style.foreground !== 'string' || style.foreground.length > 32) return null;
    normalized.foreground = style.foreground;
  }
  if (style.background !== undefined) {
    if (typeof style.background !== 'string' || style.background.length > 32) return null;
    normalized.background = style.background;
  }
  if (style.showText !== undefined) {
    if (typeof style.showText !== 'boolean') return null;
    normalized.showText = style.showText;
  }
  if (style.fontSize !== undefined) {
    const fontSize = readElementNumber(style.fontSize, 6, 24);
    if (fontSize === null) return null;
    normalized.fontSize = fontSize;
  }
  if (type === 'line' && (normalized.foreground !== undefined || normalized.background !== undefined || normalized.showText !== undefined || normalized.fontSize !== undefined)) {
    return null;
  }
  if (type === 'barcode' && (normalized.stroke !== undefined || normalized.strokeWidth !== undefined || normalized.lineStyle !== undefined)) {
    return null;
  }
  return normalized;
}

/**
 * Elements use percentage coordinates relative to the label canvas. Barcode
 * content is bound to one of the existing inventory fields through contentKey.
 * The optional array is intentionally independent from `fields` so old
 * templates that stored a bare fields array remain readable.
 */
function normalizeElements(value: unknown): LabelElement[] | null {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 100) return null;
  const seenIds = new Set<string>();
  const elements: LabelElement[] = [];

  for (const [index, entry] of value.entries()) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
    const raw = entry as Record<string, unknown>;
    if (!ELEMENT_TYPES.includes(raw.type as LabelElementType)) return null;
    const type = raw.type as LabelElementType;
    const x = readElementNumber(raw.x, 0, 100);
    const y = readElementNumber(raw.y, 0, 100);
    const width = readElementNumber(raw.width, 0.1, 100);
    const height = readElementNumber(raw.height, 0.1, 100);
    if (x === null || y === null || width === null || height === null || x + width > 100 || y + height > 100) return null;
    const requestedId = typeof raw.id === 'string' ? raw.id.trim() : '';
    const id = requestedId || `element-${index + 1}`;
    if (id.length > 64 || seenIds.has(id)) return null;
    const style = normalizeElementStyle(raw.style, type);
    if (style === null) return null;

    let contentKey: LabelFieldKey | undefined;
    const content = raw.content && typeof raw.content === 'object' && !Array.isArray(raw.content)
      ? raw.content as Record<string, unknown>
      : undefined;
    const requestedContentKey = raw.contentKey ?? raw.dataKey ?? raw.bindKey ?? content?.field ?? content?.key;
    if (requestedContentKey !== undefined) {
      if (!FIELD_KEYS.includes(requestedContentKey as LabelFieldKey)) return null;
      contentKey = requestedContentKey as LabelFieldKey;
    }
    if (type === 'barcode' && !contentKey) return null;
    if (type === 'line' && contentKey) return null;

    seenIds.add(id);
    elements.push({ id, type, x, y, width, height, ...(contentKey ? { contentKey } : {}), style });
  }
  return elements;
}

function normalizeDimensions(width: unknown, height: unknown) {
  const valid = (Number(width) === 60 && Number(height) === 40)
    || (Number(width) === 80 && Number(height) === 50);
  return valid ? { width: Number(width), height: Number(height) } : null;
}

function normalizeFieldGap(value: unknown): number | null {
  const spacing = Number(value);
  return Number.isFinite(spacing) && spacing >= 0 && spacing <= 8 ? spacing : null;
}

function normalizeLayoutMode(value: unknown): 'flow' | 'free' | null {
  return value === undefined || value === null ? 'flow' : value === 'flow' || value === 'free' ? value : null;
}

function readStoredLayoutMode(value: unknown): 'flow' | 'free' {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) as unknown : value;
    if (parsed && typeof parsed === 'object' && 'layoutMode' in parsed) {
      return normalizeLayoutMode((parsed as { layoutMode?: unknown }).layoutMode) || 'flow';
    }
  } catch {
    // Legacy or malformed JSON is rendered as a flow layout.
  }
  return 'flow';
}

function readStoredElements(value: unknown): LabelElement[] {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) as unknown : value;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return normalizeElements((parsed as { elements?: unknown }).elements) || [];
    }
  } catch {
    // Legacy or malformed JSON has no drawable elements.
  }
  return [];
}

function serialize(row: LabelTemplateRow): LabelTemplate {
  let fields = DEFAULT_FIELDS;
  let elements: LabelElement[] = [];
  let fieldGap = 1;
  let layoutMode: 'flow' | 'free' = 'flow';
  try {
    const parsed = JSON.parse(row.fields) as unknown;
    const storedFields = Array.isArray(parsed) ? parsed : parsed && typeof parsed === 'object' ? (parsed as { fields?: unknown }).fields : undefined;
    const normalized = normalizeFields(storedFields);
    if (normalized) fields = normalized;
    if (!Array.isArray(parsed) && parsed && typeof parsed === 'object') {
      const normalizedGap = normalizeFieldGap((parsed as { fieldGap?: unknown }).fieldGap);
      if (normalizedGap !== null) fieldGap = normalizedGap;
      layoutMode = readStoredLayoutMode(parsed);
      const normalizedElements = normalizeElements((parsed as { elements?: unknown }).elements);
      if (normalizedElements) elements = normalizedElements;
    }
  } catch {
    // Keep a usable default view for malformed legacy rows without rewriting them.
  }
  return {
    ...row,
    width: row.width as LabelTemplate['width'],
    height: row.height as LabelTemplate['height'],
    fieldGap,
    layoutMode,
    fields,
    elements,
    isDefault: Boolean(row.isDefault),
  };
}

function ensureDefaultTemplate() {
  const activeTemplates = db.prepare(`
    SELECT id, isDefault FROM label_templates WHERE deleted = 0 ORDER BY createdAt ASC, id ASC
  `).all() as Array<{ id: string; isDefault: number }>;
  if (activeTemplates.length > 0) {
    const defaults = activeTemplates.filter((template) => template.isDefault);
    if (defaults.length === 1) return;
    const keepId = defaults[0]?.id || activeTemplates[0].id;
    const now = formatDateTime();
    const repairDefault = db.transaction(() => {
      db.prepare('UPDATE label_templates SET isDefault = 0, updatedAt = ? WHERE deleted = 0').run(now);
      db.prepare('UPDATE label_templates SET isDefault = 1 WHERE id = ? AND deleted = 0').run(keepId);
    });
    repairDefault();
    return;
  }
  const user = db.prepare('SELECT id FROM users ORDER BY createdAt LIMIT 1').get() as { id: string } | undefined;
  if (!user) throw new Error('系统用户尚未初始化');
  const now = formatDateTime();
  db.prepare(`
    INSERT INTO label_templates
      (id, templateName, templateType, width, height, orientation, fields, isDefault, deleted, createdBy, createdAt, updatedAt)
    VALUES (?, ?, 'inventory', 60, 40, 'landscape', ?, 1, 0, ?, ?, ?)
  `).run(generateId('label'), '默认库存标签', JSON.stringify({ fields: DEFAULT_FIELDS, fieldGap: 1, layoutMode: 'free', elements: DEFAULT_ELEMENTS }), user.id, now, now);
}

function currentUserId() {
  const row = db.prepare('SELECT id FROM users ORDER BY createdAt LIMIT 1').get() as { id: string } | undefined;
  return row?.id;
}

export async function GET() {
  try {
    await requireUser();
    ensureDefaultTemplate();
    const rows = db.prepare(`
      SELECT id, templateName, templateType, width, height, orientation, fields, isDefault, createdAt, updatedAt
      FROM label_templates WHERE deleted = 0
      ORDER BY isDefault DESC, updatedAt DESC, templateName COLLATE NOCASE
    `).all() as LabelTemplateRow[];
    return NextResponse.json(successResponse(rows.map(serialize)));
  } catch (error) {
    const authFailure = authErrorResponse(error);
    if (authFailure) return authFailure;
    console.error('GET /api/label-templates error:', error);
    return NextResponse.json(errorResponse('DATABASE_ERROR', error instanceof Error ? error.message : '读取标签模板失败'), { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    await requireRole('admin');
    const body = await request.json() as Record<string, unknown>;
    const templateName = typeof body.templateName === 'string' ? body.templateName.trim() : '';
    const dimensions = normalizeDimensions(body.width, body.height);
    const fields = normalizeFields(body.fields);
    const elements = normalizeElements(body.elements);
    const fieldGap = body.fieldGap === undefined ? 1 : normalizeFieldGap(body.fieldGap);
    const layoutMode = normalizeLayoutMode(body.layoutMode);
    const orientation = body.orientation;
    if (!templateName || templateName.length > 40) return jsonError('模板名称不能为空且不能超过 40 个字符');
    if (!dimensions) return jsonError('标签尺寸仅支持 60 × 40 mm 或 80 × 50 mm');
    if (!fields) return jsonError('标签字段配置无效');
    if (!elements) return jsonError('标签元素配置无效');
    if (fieldGap === null) return jsonError('字段间距必须在 0 到 8 mm 之间');
    if (layoutMode === null) return jsonError('字段布局模式无效');
    if (orientation !== 'portrait' && orientation !== 'landscape') return jsonError('标签方向无效');
    ensureDefaultTemplate();
    const userId = currentUserId();
    if (!userId) return jsonError('系统用户尚未初始化', 500);

    const id = generateId('label');
    const now = formatDateTime();
    const create = db.transaction(() => {
      if (body.isDefault === true) db.prepare('UPDATE label_templates SET isDefault = 0, updatedAt = ? WHERE deleted = 0').run(now);
      db.prepare(`
        INSERT INTO label_templates
          (id, templateName, templateType, width, height, orientation, fields, isDefault, deleted, createdBy, createdAt, updatedAt)
        VALUES (?, ?, 'inventory', ?, ?, ?, ?, ?, 0, ?, ?, ?)
      `).run(id, templateName, dimensions.width, dimensions.height, orientation, JSON.stringify({ fields, fieldGap, layoutMode, elements }), body.isDefault === true ? 1 : 0, userId, now, now);
    });
    create();
    const row = db.prepare(`SELECT id, templateName, templateType, width, height, orientation, fields, isDefault, createdAt, updatedAt FROM label_templates WHERE id = ?`).get(id) as LabelTemplateRow;
    return NextResponse.json(successResponse(serialize(row)), { status: 201 });
  } catch (error) {
    const authFailure = authErrorResponse(error);
    if (authFailure) return authFailure;
    const message = error instanceof Error ? error.message : '创建标签模板失败';
    if (message.includes('UNIQUE constraint failed')) return jsonError('模板名称已存在', 409);
    console.error('POST /api/label-templates error:', error);
    return NextResponse.json(errorResponse('DATABASE_ERROR', message), { status: 500 });
  }
}

export async function PATCH(request: NextRequest) {
  try {
    await requireRole('admin');
    const body = await request.json() as Record<string, unknown>;
    const id = typeof body.id === 'string' ? body.id.trim() : '';
    if (!id) return jsonError('模板 ID 不能为空');
    const existing = db.prepare('SELECT id, isDefault, fields FROM label_templates WHERE id = ? AND deleted = 0').get(id) as { id: string; isDefault: number; fields: string } | undefined;
    if (!existing) return NextResponse.json(errorResponse('NOT_FOUND', '标签模板不存在'), { status: 404 });
    const now = formatDateTime();

    if (body.action === 'setDefault') {
      const setDefault = db.transaction(() => {
        db.prepare('UPDATE label_templates SET isDefault = 0, updatedAt = ? WHERE deleted = 0').run(now);
        db.prepare('UPDATE label_templates SET isDefault = 1, updatedAt = ? WHERE id = ? AND deleted = 0').run(now, id);
      });
      setDefault();
    } else {
      const templateName = typeof body.templateName === 'string' ? body.templateName.trim() : '';
      const dimensions = normalizeDimensions(body.width, body.height);
      const fields = normalizeFields(body.fields);
      const elements = body.elements === undefined ? readStoredElements(existing.fields) : normalizeElements(body.elements);
      const fieldGap = body.fieldGap === undefined ? 1 : normalizeFieldGap(body.fieldGap);
      const layoutMode = normalizeLayoutMode(body.layoutMode);
      const orientation = body.orientation;
      if (!templateName || templateName.length > 40) return jsonError('模板名称不能为空且不能超过 40 个字符');
      if (!dimensions) return jsonError('标签尺寸仅支持 60 × 40 mm 或 80 × 50 mm');
      if (!fields) return jsonError('标签字段配置无效');
      if (!elements) return jsonError('标签元素配置无效');
      if (fieldGap === null) return jsonError('字段间距必须在 0 到 8 mm 之间');
      if (layoutMode === null) return jsonError('字段布局模式无效');
      if (orientation !== 'portrait' && orientation !== 'landscape') return jsonError('标签方向无效');
      const update = db.transaction(() => {
        if (body.isDefault === true) db.prepare('UPDATE label_templates SET isDefault = 0, updatedAt = ? WHERE deleted = 0').run(now);
        db.prepare(`
          UPDATE label_templates SET templateName = ?, width = ?, height = ?, orientation = ?, fields = ?, isDefault = ?, updatedAt = ?
          WHERE id = ? AND deleted = 0
        `).run(templateName, dimensions.width, dimensions.height, orientation, JSON.stringify({ fields, fieldGap, layoutMode, elements }), body.isDefault === true ? 1 : existing.isDefault, now, id);
      });
      update();
    }

    const row = db.prepare(`SELECT id, templateName, templateType, width, height, orientation, fields, isDefault, createdAt, updatedAt FROM label_templates WHERE id = ?`).get(id) as LabelTemplateRow;
    return NextResponse.json(successResponse(serialize(row)));
  } catch (error) {
    const authFailure = authErrorResponse(error);
    if (authFailure) return authFailure;
    const message = error instanceof Error ? error.message : '更新标签模板失败';
    if (message.includes('UNIQUE constraint failed')) return jsonError('模板名称已存在', 409);
    console.error('PATCH /api/label-templates error:', error);
    return NextResponse.json(errorResponse('DATABASE_ERROR', message), { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  try {
    await requireRole('admin');
    const id = new URL(request.url).searchParams.get('id')?.trim() || '';
    if (!id) return jsonError('模板 ID 不能为空');
    const template = db.prepare('SELECT id, isDefault FROM label_templates WHERE id = ? AND deleted = 0').get(id) as { id: string; isDefault: number } | undefined;
    if (!template) return NextResponse.json(errorResponse('NOT_FOUND', '标签模板不存在'), { status: 404 });
    if (template.isDefault) return jsonError('请先将其他模板设为默认，再删除当前模板', 409);
    db.prepare('UPDATE label_templates SET deleted = 1, updatedAt = ? WHERE id = ?').run(formatDateTime(), id);
    return NextResponse.json(successResponse({ id }));
  } catch (error) {
    const authFailure = authErrorResponse(error);
    if (authFailure) return authFailure;
    console.error('DELETE /api/label-templates error:', error);
    return NextResponse.json(errorResponse('DATABASE_ERROR', error instanceof Error ? error.message : '删除标签模板失败'), { status: 500 });
  }
}
