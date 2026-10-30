import { NextRequest, NextResponse } from 'next/server';
import db from '@/lib/db';
import { authErrorResponse, requireRole } from '@/lib/auth';
import { canonicalSKUBrand } from '@/lib/sku-brand';
import { getSKUProductType } from '@/lib/sku-display';
import { ErrorCode, errorResponse, generateId, successResponse } from '@/lib/api-helpers';

type ManualSKU = {
  id: string;
  productType: string;
  brand: string;
  model: string;
  year: number | null;
  isActive: number;
  deleted: number;
  createdBy: string | null;
  updatedBy: string | null;
  createdAt: string;
  updatedAt: string;
};

const ALLOWED_PRODUCT_TYPES = new Set(['笔记本电脑', '平板电脑']);

function normalizeIdentity(input: Record<string, unknown>) {
  const productType = getSKUProductType(String(input.productType || '').trim());
  const brandRaw = String(input.brand || '').trim();
  const brand = canonicalSKUBrand(brandRaw);
  let sourceModel = String(input.model || '').trim().replace(/\s+/g, ' ');
  const yearRaw = input.year;
  let year: number | null = null;
  if (yearRaw !== undefined && yearRaw !== null && yearRaw !== '') {
    year = Number(yearRaw);
    if (!Number.isInteger(year) || year < 1900 || year > 2100) return { error: '型号年份必须在 1900 至 2100 之间' };
  }
  if (!ALLOWED_PRODUCT_TYPES.has(productType)) return { error: '产品类型只支持笔记本电脑或平板电脑' };
  if (!brand || brand.length > 80) return { error: '品牌不能为空且不能超过 80 个字符' };
  if (!sourceModel || sourceModel.length > 160) return { error: '型号不能为空且不能超过 160 个字符' };

  // Keep year in its own field so full product names do not repeat it. When
  // the form leaves the year blank but the model ends in one, split it out.
  if (year === null) {
    const suffix = sourceModel.match(/(?:\s+|[（(\[])(19\d{2}|20\d{2})(?:年|款)?[）)\]]?$/);
    if (suffix) {
      year = Number(suffix[1]);
      sourceModel = sourceModel.slice(0, sourceModel.length - suffix[0].length).trim();
    }
  }
  const model = year
    ? sourceModel.replace(new RegExp(`(?:\\s+|[（(\\[])?${year}(?:年|款)?[）)\\]]?$`), '').trim()
    : sourceModel;
  if (!model) return { error: '型号不能只填写年份' };
  return { value: { productType, brand, model, year } };
}

function duplicateExists(identity: { productType: string; brand: string; model: string; year: number | null }, exceptId?: string) {
  return Boolean(db.prepare(`
    SELECT id FROM manual_skus
    WHERE deleted = 0 AND productType = ? AND lower(trim(brand)) = lower(trim(?))
      AND lower(trim(model)) = lower(trim(?)) AND COALESCE(year, 0) = COALESCE(?, 0)
      AND (? IS NULL OR id <> ?)
    LIMIT 1
  `).get(identity.productType, identity.brand, identity.model, identity.year, exceptId || null, exceptId || null));
}

function now() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

function handleError(error: unknown, operation: string) {
  const authResponse = authErrorResponse(error);
  if (authResponse) return authResponse;
  const message = error instanceof Error ? error.message : String(error);
  if (/idx_manual_skus_identity|UNIQUE constraint failed/i.test(message)) {
    return NextResponse.json(errorResponse(ErrorCode.DUPLICATE_ENTRY, '该品牌、型号和年份已在手工 SKU 库中'), { status: 409 });
  }
  console.error(`${operation} error:`, error);
  return NextResponse.json(errorResponse(ErrorCode.DATABASE_ERROR, `${operation}失败`), { status: 500 });
}

/** Independent catalog used only by the manual-entry workflow. */
export async function GET(request: NextRequest) {
  try {
    await requireRole('admin');
    const { searchParams } = new URL(request.url);
    const productType = searchParams.get('productType') ? getSKUProductType(searchParams.get('productType')!.trim()) : '';
    const search = searchParams.get('search')?.trim() || '';
    const includeInactive = searchParams.get('includeInactive') === '1';
    const conditions = ['deleted = 0'];
    const params: Array<string> = [];
    if (!includeInactive) conditions.push('isActive = 1');
    if (productType) { conditions.push('productType = ?'); params.push(productType); }
    if (search) {
      conditions.push('(brand LIKE ? OR model LIKE ? OR (brand || \' \' || model) LIKE ? OR CAST(year AS TEXT) LIKE ?)');
      const pattern = `%${search}%`;
      params.push(pattern, pattern, pattern, pattern);
    }
    const items = db.prepare(`
      SELECT id, productType, brand, model, year, isActive, createdAt, updatedAt
      FROM manual_skus WHERE ${conditions.join(' AND ')}
      ORDER BY productType, brand COLLATE NOCASE, model COLLATE NOCASE, year DESC, id
    `).all(...params) as Array<Omit<ManualSKU, 'deleted' | 'createdBy' | 'updatedBy'>>;
    return NextResponse.json(successResponse({ items }));
  } catch (error) {
    return handleError(error, '获取手工 SKU');
  }
}

export async function POST(request: NextRequest) {
  try {
    const actor = await requireRole('admin');
    const body = await request.json() as Record<string, unknown>;
    const normalized = normalizeIdentity(body);
    if (normalized.error || !normalized.value) {
      return NextResponse.json(errorResponse(ErrorCode.VALIDATION_ERROR, normalized.error || 'SKU 信息不完整'), { status: 400 });
    }
    if (duplicateExists(normalized.value)) {
      return NextResponse.json(errorResponse(ErrorCode.DUPLICATE_ENTRY, '该品牌、型号和年份已在手工 SKU 库中'), { status: 409 });
    }
    const id = generateId('msku');
    const timestamp = now();
    db.prepare(`
      INSERT INTO manual_skus (id, productType, brand, model, year, isActive, deleted, createdBy, updatedBy, createdAt, updatedAt)
      VALUES (?, ?, ?, ?, ?, 1, 0, ?, ?, ?, ?)
    `).run(id, normalized.value.productType, normalized.value.brand, normalized.value.model, normalized.value.year, actor.id, actor.id, timestamp, timestamp);
    const item = db.prepare(`SELECT id, productType, brand, model, year, isActive, createdAt, updatedAt FROM manual_skus WHERE id = ?`).get(id);
    return NextResponse.json(successResponse({ item }), { status: 201 });
  } catch (error) {
    return handleError(error, '新增手工 SKU');
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const actor = await requireRole('admin');
    const body = await request.json() as Record<string, unknown>;
    const id = typeof body.id === 'string' ? body.id.trim() : '';
    if (!id) return NextResponse.json(errorResponse(ErrorCode.VALIDATION_ERROR, '手工 SKU ID 不能为空'), { status: 400 });
    const existing = db.prepare('SELECT * FROM manual_skus WHERE id = ? AND deleted = 0').get(id) as ManualSKU | undefined;
    if (!existing) return NextResponse.json(errorResponse(ErrorCode.NOT_FOUND, '手工 SKU 不存在'), { status: 404 });

    const hasIdentity = ['productType', 'brand', 'model', 'year'].some((key) => Object.hasOwn(body, key));
    let identity = { productType: existing.productType, brand: existing.brand, model: existing.model, year: existing.year };
    if (hasIdentity) {
      const normalized = normalizeIdentity({ ...identity, ...body });
      if (normalized.error || !normalized.value) return NextResponse.json(errorResponse(ErrorCode.VALIDATION_ERROR, normalized.error || 'SKU 信息不完整'), { status: 400 });
      const used = db.prepare(`
        SELECT 1 AS used FROM purchase_items WHERE manualSkuId = ?
        UNION ALL
        SELECT 1 AS used FROM inventory WHERE manualSkuId = ?
        LIMIT 1
      `).get(id, id);
      if (used && (identity.productType !== normalized.value.productType || identity.brand !== normalized.value.brand ||
          identity.model !== normalized.value.model || identity.year !== normalized.value.year)) {
        return NextResponse.json(errorResponse(ErrorCode.VALIDATION_ERROR, '该手工 SKU 已用于采购记录，身份字段不能修改；可停用后新建型号'), { status: 409 });
      }
      identity = normalized.value;
      if (duplicateExists(identity, id)) return NextResponse.json(errorResponse(ErrorCode.DUPLICATE_ENTRY, '该品牌、型号和年份已在手工 SKU 库中'), { status: 409 });
    }
    const isActive = typeof body.isActive === 'boolean' ? Number(body.isActive) : existing.isActive;
    const timestamp = now();
    db.prepare(`
      UPDATE manual_skus SET productType = ?, brand = ?, model = ?, year = ?, isActive = ?, updatedBy = ?, updatedAt = ?
      WHERE id = ? AND deleted = 0
    `).run(identity.productType, identity.brand, identity.model, identity.year, isActive, actor.id, timestamp, id);
    const item = db.prepare(`SELECT id, productType, brand, model, year, isActive, createdAt, updatedAt FROM manual_skus WHERE id = ?`).get(id);
    return NextResponse.json(successResponse({ item }));
  } catch (error) {
    return handleError(error, '更新手工 SKU');
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const actor = await requireRole('admin');
    const id = new URL(request.url).searchParams.get('id')?.trim() || '';
    if (!id) return NextResponse.json(errorResponse(ErrorCode.VALIDATION_ERROR, '手工 SKU ID 不能为空'), { status: 400 });
    const existing = db.prepare('SELECT id FROM manual_skus WHERE id = ? AND deleted = 0').get(id);
    if (!existing) return NextResponse.json(errorResponse(ErrorCode.NOT_FOUND, '手工 SKU 不存在'), { status: 404 });
    const timestamp = now();
    const used = db.prepare(`
      SELECT 1 AS used FROM purchase_items WHERE manualSkuId = ?
      UNION ALL
      SELECT 1 AS used FROM inventory WHERE manualSkuId = ?
      LIMIT 1
    `).get(id, id);
    if (used) {
      db.prepare('UPDATE manual_skus SET isActive = 0, updatedBy = ?, updatedAt = ? WHERE id = ?').run(actor.id, timestamp, id);
      return NextResponse.json(successResponse({ id, retainedForHistory: true }));
    }
    db.prepare('UPDATE manual_skus SET deleted = 1, isActive = 0, updatedBy = ?, updatedAt = ? WHERE id = ?').run(actor.id, timestamp, id);
    return NextResponse.json(successResponse({ id, retainedForHistory: false }));
  } catch (error) {
    return handleError(error, '删除手工 SKU');
  }
}

