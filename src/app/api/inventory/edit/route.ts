import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import db from '@/lib/db';
import { assertInventoryEdit, assertInventoryView, assertWarehouseAccess, authErrorResponse, AuthError, requireUser } from '@/lib/auth';
import { errorResponse, ErrorCode, formatDateTime, successResponse } from '@/lib/api-helpers';
import { serializeInventoryStatus } from '@/lib/inventory-status';

const editableFields = ['sn', 'productType', 'brand', 'model', 'year', 'cpu', 'ram', 'gpu', 'storage', 'screen', 'touchScreen'] as const;
type EditableField = (typeof editableFields)[number];
type MachineData = Record<EditableField, string | number | null>;

function parseSnapshot(value: string) {
  try { return JSON.parse(value); } catch { return null; }
}

function loadHistory(inventoryId: string) {
  return (db.prepare(`SELECT l.id,l.beforeData,l.afterData,l.createdAt,COALESCE(u.realName,u.username,'未知用户') AS actorName
    FROM inventory_edit_logs l LEFT JOIN users u ON u.id=l.actorId
    WHERE l.inventoryId=? ORDER BY l.createdAt DESC,l.id DESC LIMIT 50`).all(inventoryId) as Array<Record<string, string>>)
    .map(row => ({ ...row, beforeData: parseSnapshot(row.beforeData), afterData: parseSnapshot(row.afterData) }));
}

function validationError(message: string) {
  return NextResponse.json(errorResponse(ErrorCode.VALIDATION_ERROR, message), { status: 400 });
}
function conflictError(message: string) {
  return NextResponse.json(errorResponse(ErrorCode.DUPLICATE_ENTRY, message), { status: 409 });
}

export async function GET(request: NextRequest) {
  try {
    const user = await requireUser();
    assertInventoryView(user);
    const inventoryId = request.nextUrl.searchParams.get('inventoryId')?.trim() || '';
    if (!inventoryId) return validationError('库存 ID 不能为空');
    const machine = db.prepare('SELECT warehouseId FROM inventory WHERE id=? AND deleted=0').get(inventoryId) as { warehouseId: string } | undefined;
    if (!machine) return NextResponse.json(errorResponse(ErrorCode.INVENTORY_NOT_FOUND, '库存记录不存在'), { status: 404 });
    assertWarehouseAccess(user, machine.warehouseId);
    return NextResponse.json(successResponse({ history: loadHistory(inventoryId) }));
  } catch (error) {
    return authErrorResponse(error) || NextResponse.json(errorResponse(ErrorCode.DATABASE_ERROR, error instanceof Error ? error.message : '获取机器资料修改记录失败'), { status: 500 });
  }
}

function normalizeMachineData(value: unknown): MachineData {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('机器资料格式不正确');
  const fields = value as Record<string, unknown>;
  if (Object.keys(fields).some(key => !editableFields.includes(key as EditableField))) throw new Error('机器资料包含不允许修改的字段');
  for (const key of editableFields) if (!(key in fields)) throw new Error(`缺少机器资料字段：${key}`);

  const text = (key: Exclude<EditableField, 'year' | 'touchScreen'>, required = false) => {
    const raw = fields[key];
    if (typeof raw !== 'string') throw new Error(`${key} 格式不正确`);
    const normalized = raw.trim();
    if (required && !normalized) throw new Error(`${key} 不能为空`);
    if (normalized.length > (key === 'sn' ? 120 : 160)) throw new Error(`${key} 长度超出限制`);
    if (/[\r\n\u0000-\u001f\u007f]/.test(normalized)) throw new Error(`${key} 不能包含换行或控制字符`);
    return normalized;
  };

  const yearValue = fields.year;
  let year: number | null = null;
  if (yearValue !== null && yearValue !== '') {
    year = Number(yearValue);
    if (!Number.isInteger(year) || year < 1900 || year > 2100) throw new Error('型号年份必须在 1900-2100 之间');
  }
  const touchValue = fields.touchScreen;
  if (touchValue !== null && typeof touchValue !== 'boolean' && touchValue !== 0 && touchValue !== 1) throw new Error('触屏选项格式不正确');

  return {
    sn: text('sn', true), productType: text('productType', true), brand: text('brand', true),
    model: text('model', true), year, cpu: text('cpu'), ram: text('ram'), gpu: text('gpu'),
    storage: text('storage'), screen: text('screen'),
    touchScreen: touchValue === null ? null : touchValue === true || touchValue === 1 ? 1 : 0,
  };
}

function machineSnapshot(row: Record<string, unknown>): MachineData {
  return {
    sn: String(row.sn || ''), productType: String(row.productType || ''), brand: String(row.brand || ''),
    model: String(row.model || ''), year: row.year == null ? null : Number(row.year), cpu: String(row.cpu || ''),
    ram: String(row.ram || ''), gpu: row.gpu == null ? '' : String(row.gpu), storage: String(row.storage || ''),
    screen: String(row.screen || ''), touchScreen: row.touchScreen == null ? null : Number(row.touchScreen),
  };
}

export async function POST(request: NextRequest) {
  try {
    const user = await requireUser();
    assertInventoryEdit(user);
    const body = await request.json() as Record<string, unknown>;
    const inventoryId = typeof body.inventoryId === 'string' ? body.inventoryId.trim() : '';
    const expectedSn = typeof body.expectedSn === 'string' ? body.expectedSn.trim() : '';
    if (!inventoryId || !expectedSn) return validationError('库存 ID 和原 SN 不能为空');

    let after: MachineData;
    try { after = normalizeMachineData(body.fields); } catch (error) { return validationError(error instanceof Error ? error.message : '机器资料格式不正确'); }

    const now = formatDateTime();
    const logId = randomUUID();
    const result = db.transaction(() => {
      const current = db.prepare('SELECT * FROM inventory WHERE id=? AND deleted=0').get(inventoryId) as Record<string, unknown> | undefined;
      if (!current) throw new AuthError('FORBIDDEN', '库存记录不存在或已删除');
      assertWarehouseAccess(user, String(current.warehouseId || ''));
      if (String(current.sn) !== expectedSn) throw new AuthError('FORBIDDEN', '机器资料已被其他人修改，请刷新后重试');
      const duplicate = db.prepare('SELECT id FROM inventory WHERE lower(sn)=lower(?) AND id<>? AND deleted=0 LIMIT 1').get(after.sn, inventoryId);
      if (duplicate) return { conflict: `SN [${after.sn}] 已被其他机器使用` };

      const before = machineSnapshot(current);
      if (JSON.stringify(before) === JSON.stringify(after)) return { changed: false, before, after };
      const updated = db.prepare(`UPDATE inventory SET sn=?,productType=?,brand=?,model=?,year=?,cpu=?,ram=?,gpu=?,storage=?,screen=?,touchScreen=?,updatedAt=?
        WHERE id=? AND sn=? AND deleted=0`).run(after.sn, after.productType, after.brand, after.model, after.year, after.cpu, after.ram, after.gpu || null, after.storage, after.screen, after.touchScreen, now, inventoryId, expectedSn);
      if (updated.changes !== 1) throw new AuthError('FORBIDDEN', '机器资料已被其他人修改，请刷新后重试');
      db.prepare('INSERT INTO inventory_edit_logs (id,inventoryId,actorId,beforeData,afterData,createdAt) VALUES (?,?,?,?,?,?)')
        .run(logId, inventoryId, user.id, JSON.stringify(before), JSON.stringify(after), now);
      return { changed: true, before, after };
    })();
    if (result.conflict !== undefined) return conflictError(result.conflict);

    const item = db.prepare("SELECT i.*,COALESCE(w.name,w.warehouseName) AS warehouseName,po.purchaseNo FROM inventory i LEFT JOIN warehouses w ON w.id=i.warehouseId LEFT JOIN purchase_orders po ON po.id=i.purchaseOrderId WHERE i.id=? AND i.deleted=0").get(inventoryId) as Record<string, unknown> & { id: string };
    return NextResponse.json(successResponse({ item: serializeInventoryStatus(item), history: loadHistory(inventoryId), changed: result.changed }));
  } catch (error) {
    if (error instanceof AuthError) return NextResponse.json(errorResponse(error.code, error.message), { status: error.status });
    return authErrorResponse(error) || NextResponse.json(errorResponse(ErrorCode.DATABASE_ERROR, error instanceof Error ? error.message : '更新机器资料失败'), { status: 500 });
  }
}
