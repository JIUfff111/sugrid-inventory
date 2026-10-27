/**
 * 采购订单 API
 * POST   /api/purchase-orders       创建采购单（草稿或确认入库）
 * GET    /api/purchase-orders       获取采购单列表或详情
 * PATCH  /api/purchase-orders       更新草稿或确认入库
 * DELETE /api/purchase-orders?id=   删除草稿
 */

import { NextRequest, NextResponse } from 'next/server';
import db from '@/lib/db';
import { canonicalSKUBrand } from '@/lib/sku-brand';
import { getSKUProductType } from '@/lib/sku-display';
import { AuthError, requireRole } from '@/lib/auth';
import {
  successResponse,
  errorResponse,
  ErrorCode,
  generateId,
  parsePaginationParams,
  createPaginatedResponse,
  formatDateTime,
} from '@/lib/api-helpers';

type PurchaseItemInput = {
  id?: string;
  skuId?: string;
  productType?: string;
  brand?: string;
  model?: string;
  year?: number | string | null;
  cpu?: string;
  ram?: string;
  gpu?: string | null;
  storage?: string;
  screen?: string;
  touchScreen?: boolean | null;
  sn?: string;
  purchasePrice?: number | string;
  remark?: string | null;
  skuRemark?: string | null;
};

type NormalizedItem = {
  id: string;
  skuId: string | null;
  productType: string;
  brand: string;
  model: string;
  year: number | null;
  cpu: string;
  ram: string;
  gpu: string | null;
  storage: string;
  screen: string;
  touchScreen: number | null;
  sn: string;
  purchasePrice: number;
  remark: string | null;
  skuRemark: string | null;
};

type OrderBody = {
  id?: unknown;
  supplierId?: unknown;
  warehouseId?: unknown;
  supplierOrderNo?: unknown;
  purchaseDate?: unknown;
  purchasedBy?: unknown;
  remark?: unknown;
  items?: unknown;
  status?: unknown;
  action?: unknown;
};

type OrderRow = {
  id: string;
  purchaseNo: string;
  supplierOrderNo: string;
  supplierId: string;
  supplierName: string;
  purchaseDate: string;
  purchasedBy: string;
  totalAmount: number;
  totalQuantity: number;
  isInbounded: number;
  remark: string | null;
  createdAt: string;
  updatedAt: string;
};

type PurchaseItemRow = {
  id: string;
  skuId: string | null;
  productType: string;
  brand: string;
  model: string;
  year: number | null;
  cpu: string;
  ram: string;
  gpu: string | null;
  storage: string;
  screen: string;
  touchScreen: number | null;
  sn: string;
  purchasePrice: number;
  remark: string | null;
  skuRemark: string | null;
  createdAt: string;
};

type DraftItemRow = PurchaseItemRow & { purchaseOrderId: string; deleted: number };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}


function resolvePurchasedBy(value: unknown, actorId: string): string | null {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  if (raw === '当前用户') return actorId;
  const user = db.prepare(`
    SELECT id FROM users
    WHERE id = ? OR username = ? OR realName = ?
    LIMIT 1
  `).get(raw, raw, raw) as { id: string } | undefined;
  return user?.id || null;
}

function generatePurchaseNo(): string {
  const today = new Date();
  const dateStr = `${today.getFullYear()}${String(today.getMonth() + 1).padStart(2, '0')}${String(today.getDate()).padStart(2, '0')}`;
  const prefix = `CG${dateStr}`;
  const row = db.prepare(`
    SELECT purchaseNo FROM purchase_orders
    WHERE purchaseNo LIKE ? ORDER BY purchaseNo DESC LIMIT 1
  `).get(`${prefix}%`) as { purchaseNo: string } | undefined;
  const next = row ? parseInt(row.purchaseNo.slice(prefix.length), 10) + 1 : 1;
  return `${prefix}${String(next).padStart(3, '0')}`;
}

function normalizeItems(items: unknown): NormalizedItem[] {
  if (!Array.isArray(items)) return [];
  return items.map((item: PurchaseItemInput) => ({
    id: typeof item?.id === 'string' ? item.id.trim() : '',
    skuId: typeof item?.skuId === 'string' ? item.skuId.trim() || null : null,
    productType: String(item?.productType || '笔记本电脑').trim(),
    brand: canonicalSKUBrand(String(item?.brand || '')),
    model: String(item?.model || '').trim(),
    year: item?.year === undefined || item?.year === null || item?.year === ''
      ? null
      : Number.isInteger(Number(item.year)) ? Number(item.year) : null,
    cpu: String(item?.cpu || '').trim(),
    ram: String(item?.ram || '').trim(),
    gpu: item?.gpu === undefined || item?.gpu === null ? null : String(item.gpu).trim() || null,
    storage: String(item?.storage || '').trim(),
    screen: String(item?.screen || '').trim(),
    touchScreen: item?.touchScreen === undefined || item?.touchScreen === null
      ? null
      : item.touchScreen ? 1 : 0,
    sn: String(item?.sn || '').trim(),
    purchasePrice: item?.purchasePrice === undefined || item?.purchasePrice === null || item?.purchasePrice === ''
      ? 0
      : Number(item.purchasePrice),
    remark: item?.remark === undefined || item?.remark === null ? null : String(item.remark).trim() || null,
    skuRemark: item?.skuRemark === undefined || item?.skuRemark === null ? null : String(item.skuRemark).trim() || null,
  }));
}

function resolveMatchedSkuId(item: NormalizedItem): string | null {
  const candidates = db.prepare(`
    SELECT id, productType FROM skus
    WHERE deleted = 0 AND brand = ? AND model = ? AND year IS ?
    ORDER BY CASE WHEN id = ? THEN 0 ELSE 1 END, id
  `).all(item.brand, item.model, item.year, item.skuId || '') as Array<{ id: string; productType: string }>;
  const productType = getSKUProductType(item.productType);
  return candidates.find((candidate) => getSKUProductType(candidate.productType) === productType)?.id || null;
}

function validateOrderFields(body: OrderBody): string | null {
  if (!String(body?.supplierId || '').trim()) return '供应商不能为空';
  if (!String(body?.purchaseDate || '').trim()) return '采购时间不能为空';
  if (!String(body?.purchasedBy || '').trim()) return '采购人不能为空';
  return null;
}

function validateItems(items: NormalizedItem[], requireSnAndPrice: boolean): string | null {
  if (items.length === 0) return '至少添加一台机器';
  const seen = new Set<string>();
  for (const item of items) {
    if (!item.brand || !item.model || !item.cpu || !item.ram || !item.storage) {
      return '机器配置缺少必填项';
    }
    if (!Number.isFinite(item.purchasePrice) || item.purchasePrice < 0) return '采购价格格式不正确';
    if (requireSnAndPrice && !item.sn) return '确认入库时所有机器必须填写 SN';
    if (requireSnAndPrice && item.purchasePrice <= 0) return '确认入库时所有机器必须填写采购价格';
    if (item.sn) {
      if (seen.has(item.sn)) return `本次提交中 SN [${item.sn}] 重复`;
      seen.add(item.sn);
    }
  }
  return null;
}

function findSupplier(supplierId: string) {
  return db.prepare('SELECT id, supplierName FROM suppliers WHERE id = ? AND deleted = 0').get(supplierId) as
    { id: string; supplierName: string } | undefined;
}

function checkSnConflicts(items: NormalizedItem[], allowedItemIds = new Set<string>()): string | null {
  for (const item of items) {
    if (!item.sn) continue;
    const purchaseItems = db.prepare('SELECT id FROM purchase_items WHERE sn = ?').all(item.sn) as Array<{ id: string }>;
    const purchaseItem = purchaseItems.find((row) => !allowedItemIds.has(row.id));
    const inventory = db.prepare('SELECT id FROM inventory WHERE sn = ?').get(item.sn);
    if (purchaseItem || inventory) return `SN [${item.sn}] 已存在，请检查`;
  }
  return null;
}

function orderRow(id: string) {
  return db.prepare(`
    SELECT id, purchaseNo, supplierOrderNo, supplierId, supplierName,
      purchaseDate, purchasedBy, totalAmount, totalQuantity, isInbounded,
      remark, createdAt, updatedAt
    FROM purchase_orders WHERE id = ? AND deleted = 0
  `).get(id) as OrderRow | undefined;
}

function orderDetail(id: string) {
  const order = orderRow(id);
  if (!order) return undefined;
  const items = (db.prepare(`
    SELECT id, skuId, productType, brand, model, year, cpu, ram, gpu, storage, screen,
      touchScreen, sn, purchasePrice, remark, skuRemark, createdAt
    FROM purchase_items WHERE purchaseOrderId = ? AND deleted = 0 ORDER BY createdAt, id
  `).all(id) as PurchaseItemRow[]).map((item) => ({
    ...item,
    sn: String(item.sn || '').startsWith('__draft_') ? '' : item.sn,
    touchScreen: item.touchScreen === null || item.touchScreen === undefined
      ? undefined
      : Boolean(item.touchScreen),
  }));
  return { ...order, items };
}

function inventoryIdsForOrder(orderId: string) {
  return (db.prepare(`
    SELECT id
    FROM inventory
    WHERE purchaseOrderId = ? AND deleted = 0
    ORDER BY createdAt, id
  `).all(orderId) as Array<{ id: string }>).map((row) => row.id);
}

function insertItemsAndInventory(order: Pick<OrderRow, 'id' | 'supplierId' | 'supplierName' | 'purchaseDate'> & { warehouseId: string; actorId: string }, items: NormalizedItem[], inbound: boolean, now: string) {
  const insertItem = db.prepare(`
    INSERT INTO purchase_items (
      id, purchaseOrderId, productType, brand, model, year, cpu, ram, gpu, storage,
      screen, touchScreen, sn, purchasePrice, remark, skuRemark, skuId, recordedBy, createdAt
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertInventory = db.prepare(`
    INSERT INTO inventory (
      id, purchaseOrderId, purchaseItemId, sn, productType, brand, model, year,
      cpu, ram, gpu, storage, screen, touchScreen, purchasePrice,
      supplierId, supplierName, status, inboundDate, remark, skuRemark,
      deleted, createdAt, updatedAt, warehouseId
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'in_stock', ?, ?, ?, 0, ?, ?, ?)
  `);

  for (const item of items) {
    const itemId = generateId('pi');
    const sn = item.sn || `__draft_${itemId}`;
    insertItem.run(
      itemId, order.id, item.productType, item.brand, item.model, item.year, item.cpu, item.ram,
      item.gpu, item.storage, item.screen, item.touchScreen, sn, item.purchasePrice,
      item.remark, item.skuRemark, resolveMatchedSkuId(item), order.actorId, now
    );
    if (inbound) {
      const inventoryId = generateId('inv');
      insertInventory.run(
        inventoryId, order.id, itemId, sn, item.productType, item.brand, item.model, item.year,
        item.cpu, item.ram, item.gpu, item.storage, item.screen, item.touchScreen,
        item.purchasePrice, order.supplierId, order.supplierName, order.purchaseDate,
        item.remark, item.skuRemark, now, now, order.warehouseId
      );
      recordInbound(inventoryId, order, now);
    }
  }
}

function replaceDraftItemsAndInventory(
  order: Pick<OrderRow, 'id' | 'supplierId' | 'supplierName' | 'purchaseDate'> & { warehouseId: string; actorId: string },
  items: NormalizedItem[],
  inbound: boolean,
  now: string,
) {
  const existing = db.prepare(`
    SELECT id, purchaseOrderId, productType, brand, model, year, cpu, ram, gpu, storage,
      screen, touchScreen, sn, purchasePrice, remark, skuRemark, createdAt, deleted
    FROM purchase_items WHERE purchaseOrderId = ? AND deleted = 0
  `).all(order.id) as DraftItemRow[];
  const existingById = new Map(existing.map((item) => [item.id, item]));
  const reused = items
    .map((item) => item.id ? existingById.get(item.id) : undefined)
    .filter((item): item is DraftItemRow => Boolean(item));
  const reusedIds = new Set(reused.map((item) => item.id));

  // Move reused rows to unique temporary values first, so two edited rows may swap SNs safely.
  const moveToTemporarySn = db.prepare('UPDATE purchase_items SET sn = ? WHERE id = ? AND purchaseOrderId = ? AND deleted = 0');
  reused.forEach((item, index) => {
    moveToTemporarySn.run(`__rewrite_${order.id}_${Date.now()}_${index}_${Math.random().toString(36).slice(2, 8)}`, item.id, order.id);
  });

  const markRemoved = db.prepare('UPDATE purchase_items SET deleted = 1 WHERE id = ? AND purchaseOrderId = ? AND deleted = 0');
  existing.filter((item) => !reusedIds.has(item.id)).forEach((item) => markRemoved.run(item.id, order.id));

  const updateItem = db.prepare(`
    UPDATE purchase_items SET productType = ?, brand = ?, model = ?, year = ?, cpu = ?, ram = ?,
      gpu = ?, storage = ?, screen = ?, touchScreen = ?, sn = ?, purchasePrice = ?,
      remark = ?, skuRemark = ?, skuId = ?, deleted = 0
    WHERE id = ? AND purchaseOrderId = ?
  `);
  const insertItem = db.prepare(`
    INSERT INTO purchase_items (
      id, purchaseOrderId, productType, brand, model, year, cpu, ram, gpu, storage,
      screen, touchScreen, sn, purchasePrice, remark, skuRemark, skuId, recordedBy, deleted, createdAt
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
  `);
  const insertInventory = db.prepare(`
    INSERT INTO inventory (
      id, purchaseOrderId, purchaseItemId, sn, productType, brand, model, year,
      cpu, ram, gpu, storage, screen, touchScreen, purchasePrice,
      supplierId, supplierName, status, inboundDate, remark, skuRemark,
      deleted, createdAt, updatedAt, warehouseId
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'in_stock', ?, ?, ?, 0, ?, ?, ?)
  `);

  for (const item of items) {
    const itemId = item.id && existingById.has(item.id) ? item.id : generateId('pi');
    const sn = item.sn || `__draft_${itemId}`;
    const skuId = resolveMatchedSkuId(item);
    if (existingById.has(itemId)) {
      updateItem.run(
        item.productType, item.brand, item.model, item.year, item.cpu, item.ram, item.gpu,
        item.storage, item.screen, item.touchScreen, sn, item.purchasePrice,
        item.remark, item.skuRemark, skuId, itemId, order.id,
      );
    } else {
      insertItem.run(
        itemId, order.id, item.productType, item.brand, item.model, item.year, item.cpu, item.ram,
        item.gpu, item.storage, item.screen, item.touchScreen, sn, item.purchasePrice,
        item.remark, item.skuRemark, skuId, order.actorId, now,
      );
    }
    if (inbound) {
      const inventoryId = generateId('inv');
      insertInventory.run(
        inventoryId, order.id, itemId, sn, item.productType, item.brand, item.model, item.year,
        item.cpu, item.ram, item.gpu, item.storage, item.screen, item.touchScreen,
        item.purchasePrice, order.supplierId, order.supplierName, order.purchaseDate,
        item.remark, item.skuRemark, now, now, order.warehouseId,
      );
      recordInbound(inventoryId, order, now);
    }
  }
}

function resolveWarehouse(value: unknown): string {
  const requested = typeof value === 'string' ? value.trim() : '';
  const warehouse = requested
    ? db.prepare("SELECT id FROM warehouses WHERE id = ? AND status = 'active'").get(requested)
    : db.prepare("SELECT id FROM warehouses WHERE status = 'active' ORDER BY isDefault DESC, createdAt, id LIMIT 1").get();
  if (!warehouse) throw new Error('入库仓库不存在或已停用');
  return (warehouse as { id: string }).id;
}
function recordInbound(inventoryId: string, order: { id: string; warehouseId: string; actorId: string }, now: string) {
  db.prepare(`INSERT INTO inventory_movements (id, inventoryId, warehouseId, toWarehouseId, movementType, referenceType, referenceId, actorId, createdAt)
    VALUES (?, ?, ?, ?, 'purchase_in', 'purchase_order', ?, ?, ?)`)
    .run(generateId('movement'), inventoryId, order.warehouseId, order.warehouseId, order.id, order.actorId, now);
}
function duplicateError(message: string) {
  return NextResponse.json(errorResponse(ErrorCode.DUPLICATE_ENTRY, message), { status: 400 });
}

export async function POST(request: NextRequest) {
  try {
    const actor = await requireRole('admin');
    const body = await request.json() as OrderBody;
    const status = body?.status === 'completed' ? 'completed' : 'draft';
    const fieldError = validateOrderFields(body);
    if (fieldError) return NextResponse.json(errorResponse(ErrorCode.VALIDATION_ERROR, fieldError), { status: 400 });
    const purchasedBy = resolvePurchasedBy(body.purchasedBy, actor.id);
    if (!purchasedBy) return NextResponse.json(errorResponse(ErrorCode.VALIDATION_ERROR, '采购人不存在'), { status: 400 });
    const items = normalizeItems(body.items);
    const itemError = validateItems(items, status === 'completed');
    if (itemError) return NextResponse.json(errorResponse(ErrorCode.VALIDATION_ERROR, itemError), { status: 400 });
    const supplier = findSupplier(String(body.supplierId).trim());
    if (!supplier) return NextResponse.json(errorResponse(ErrorCode.SUPPLIER_NOT_FOUND, '供应商不存在'), { status: 400 });
    const conflict = checkSnConflicts(items);
    if (conflict) return duplicateError(conflict);

    const now = formatDateTime();
    const orderId = generateId('po');
    const purchaseNo = generatePurchaseNo();
    const order = {
      id: orderId,
      actorId: actor.id,
      warehouseId: resolveWarehouse(body.warehouseId),
      supplierId: supplier.id,
      supplierName: supplier.supplierName,
      purchaseDate: String(body.purchaseDate).trim(),
    };
    const totalAmount = items.reduce((sum, item) => sum + item.purchasePrice, 0);
    const userId = actor.id;

    db.transaction(() => {
      db.prepare(`
        INSERT INTO purchase_orders (
          id, purchaseNo, supplierOrderNo, supplierId, supplierName, purchaseDate,
          purchasedBy, totalAmount, totalQuantity, isInbounded, remark, deleted,
          createdBy, createdAt, updatedAt
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)
      `).run(
        orderId, purchaseNo, String(body.supplierOrderNo ?? '').trim(), supplier.id,
        supplier.supplierName, order.purchaseDate, purchasedBy, totalAmount, items.length,
        status === 'completed' ? 1 : 0, String(body.remark || '').trim() || null,
        userId, now, now
      );
      insertItemsAndInventory({ ...order, warehouseId: resolveWarehouse(body.warehouseId), actorId: actor.id }, items, status === 'completed', now);
    })();

    return NextResponse.json(successResponse({
      id: orderId,
      purchaseNo,
      status,
      totalAmount,
      itemCount: items.length,
      inventoryIds: status === 'completed' ? inventoryIdsForOrder(orderId) : [],
    }), { status: 201 });
  } catch (error: unknown) {
    if (error instanceof AuthError) return NextResponse.json(errorResponse(error.code, error.message), { status: error.status });
    console.error('POST /api/purchase-orders error:', error);
    return NextResponse.json(errorResponse(ErrorCode.DATABASE_ERROR, errorMessage(error) || '创建采购单失败'), { status: 500 });
  }
}

export async function GET(request: NextRequest) {
  try {
    await requireRole('admin');
    const { searchParams } = new URL(request.url);
    const id = searchParams.get('id')?.trim();
    if (id) {
      const detail = orderDetail(id);
      if (!detail) return NextResponse.json(errorResponse(ErrorCode.PURCHASE_ORDER_NOT_FOUND, '采购单不存在'), { status: 404 });
      return NextResponse.json(successResponse(detail));
    }

    const { page, pageSize } = parsePaginationParams(searchParams);
    const isInbounded = searchParams.get('isInbounded');
    const search = searchParams.get('search')?.trim() || '';
    const supplierId = searchParams.get('supplierId')?.trim() || '';
    const purchaseDateFrom = searchParams.get('purchaseDateFrom')?.trim() || '';
    const purchaseDateTo = searchParams.get('purchaseDateTo')?.trim() || '';
    const amountMinValue = searchParams.get('amountMin')?.trim() || '';
    const amountMaxValue = searchParams.get('amountMax')?.trim() || '';
    const offset = (page - 1) * pageSize;
    const conditions = ['po.deleted = 0'];
    const params: Array<string | number> = [];
    if (isInbounded !== null && isInbounded !== '') {
      if (isInbounded !== '0' && isInbounded !== '1') {
        return NextResponse.json(errorResponse(ErrorCode.VALIDATION_ERROR, '采购单状态筛选值无效'), { status: 400 });
      }
      conditions.push('po.isInbounded = ?');
      params.push(Number(isInbounded));
    }
    if (search) {
      conditions.push('(po.purchaseNo LIKE ? OR po.supplierOrderNo LIKE ? OR po.supplierName LIKE ?)');
      const pattern = `%${search}%`;
      params.push(pattern, pattern, pattern);
    }
    if (supplierId) {
      conditions.push('po.supplierId = ?');
      params.push(supplierId);
    }

    const validDate = (value: string) => {
      if (!value) return true;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
      const parsedDate = new Date(`${value}T00:00:00.000Z`);
      return Number.isFinite(parsedDate.getTime()) && parsedDate.toISOString().slice(0, 10) === value;
    };
    if (!validDate(purchaseDateFrom) || !validDate(purchaseDateTo)) {
      return NextResponse.json(errorResponse(ErrorCode.VALIDATION_ERROR, '采购日期筛选格式无效'), { status: 400 });
    }
    if (purchaseDateFrom && purchaseDateTo && purchaseDateFrom > purchaseDateTo) {
      return NextResponse.json(errorResponse(ErrorCode.VALIDATION_ERROR, '采购日期起始范围无效'), { status: 400 });
    }
    if (purchaseDateFrom) {
      conditions.push('po.purchaseDate >= ?');
      params.push(purchaseDateFrom);
    }
    if (purchaseDateTo) {
      conditions.push('po.purchaseDate <= ?');
      params.push(purchaseDateTo);
    }

    const amountMin = amountMinValue ? Number(amountMinValue) : null;
    const amountMax = amountMaxValue ? Number(amountMaxValue) : null;
    if (amountMinValue && (!Number.isFinite(amountMin) || amountMin! < 0)) {
      return NextResponse.json(errorResponse(ErrorCode.VALIDATION_ERROR, '最低金额筛选值无效'), { status: 400 });
    }
    if (amountMaxValue && (!Number.isFinite(amountMax) || amountMax! < 0)) {
      return NextResponse.json(errorResponse(ErrorCode.VALIDATION_ERROR, '最高金额筛选值无效'), { status: 400 });
    }
    if (amountMin !== null && amountMax !== null && amountMin > amountMax) {
      return NextResponse.json(errorResponse(ErrorCode.VALIDATION_ERROR, '金额区间无效'), { status: 400 });
    }
    if (amountMin !== null) {
      conditions.push('po.totalAmount >= ?');
      params.push(amountMin);
    }
    if (amountMax !== null) {
      conditions.push('po.totalAmount <= ?');
      params.push(amountMax);
    }
    const where = `WHERE ${conditions.join(' AND ')}`;
    const rows = db.prepare(`
      SELECT po.id, po.purchaseNo, po.supplierOrderNo, po.supplierId, po.supplierName,
        po.purchaseDate, po.purchasedBy, po.totalAmount, po.totalQuantity,
        po.isInbounded, po.remark, po.createdAt,
        (SELECT COUNT(*) FROM purchase_items pi WHERE pi.purchaseOrderId = po.id AND pi.deleted = 0) AS itemCount
      FROM purchase_orders po ${where}
      ORDER BY po.createdAt DESC LIMIT ? OFFSET ?
    `).all(...params, pageSize, offset);
    const count = db.prepare(`SELECT COUNT(*) AS total FROM purchase_orders po ${where}`).get(...params) as { total: number };
    return NextResponse.json(successResponse(createPaginatedResponse(rows, count.total, page, pageSize)));
  } catch (error: unknown) {
    if (error instanceof AuthError) return NextResponse.json(errorResponse(error.code, error.message), { status: error.status });
    console.error('GET /api/purchase-orders error:', error);
    return NextResponse.json(errorResponse(ErrorCode.DATABASE_ERROR, errorMessage(error) || '获取采购单失败'), { status: 500 });
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const actor = await requireRole('admin');
    const body = await request.json() as OrderBody;
    const id = String(body?.id || '').trim();
    if (!id) return NextResponse.json(errorResponse(ErrorCode.VALIDATION_ERROR, '采购单 ID 不能为空'), { status: 400 });
    const existing = orderRow(id);
    if (!existing) return NextResponse.json(errorResponse(ErrorCode.PURCHASE_ORDER_NOT_FOUND, '采购单不存在'), { status: 404 });
    if (existing.isInbounded) return NextResponse.json(errorResponse(ErrorCode.VALIDATION_ERROR, '已入库采购单不能再次编辑'), { status: 400 });

    const fieldError = validateOrderFields(body);
    if (fieldError) return NextResponse.json(errorResponse(ErrorCode.VALIDATION_ERROR, fieldError), { status: 400 });
    const purchasedBy = resolvePurchasedBy(body.purchasedBy, actor.id);
    if (!purchasedBy) return NextResponse.json(errorResponse(ErrorCode.VALIDATION_ERROR, '采购人不存在'), { status: 400 });
    const action = body?.action === 'inbound' ? 'inbound' : 'draft';
    const items = normalizeItems(body.items);
    const itemError = validateItems(items, action === 'inbound');
    if (itemError) return NextResponse.json(errorResponse(ErrorCode.VALIDATION_ERROR, itemError), { status: 400 });
    const existingItems = db.prepare('SELECT id FROM purchase_items WHERE purchaseOrderId = ? AND deleted = 0').all(id) as Array<{ id: string }>;
    const existingItemIds = new Set(existingItems.map((item) => item.id));
    const incomingIds = new Set<string>();
    for (const item of items) {
      if (!item.id) continue;
      if (!existingItemIds.has(item.id)) item.id = '';
      if (item.id && incomingIds.has(item.id)) {
        return NextResponse.json(errorResponse(ErrorCode.VALIDATION_ERROR, '机器明细不能重复引用'), { status: 400 });
      }
      if (item.id) incomingIds.add(item.id);
    }
    const conflict = checkSnConflicts(items, incomingIds);
    if (conflict) return duplicateError(conflict);
    const supplier = findSupplier(String(body.supplierId).trim());
    if (!supplier) return NextResponse.json(errorResponse(ErrorCode.SUPPLIER_NOT_FOUND, '供应商不存在'), { status: 400 });

    const now = formatDateTime();
    const totalAmount = items.reduce((sum, item) => sum + item.purchasePrice, 0);
    const updatedOrder = {
      ...existing,
      actorId: actor.id,
      warehouseId: resolveWarehouse(body.warehouseId),
      supplierId: supplier.id,
      supplierName: supplier.supplierName,
      purchaseDate: String(body.purchaseDate).trim(),
      purchasedBy,
    };

    db.transaction(() => {
      db.prepare(`
        UPDATE purchase_orders SET supplierOrderNo = ?, supplierId = ?, supplierName = ?,
          purchaseDate = ?, purchasedBy = ?, totalAmount = ?, totalQuantity = ?, isInbounded = ?,
          remark = ?, updatedAt = ? WHERE id = ? AND deleted = 0
      `).run(
        String(body.supplierOrderNo ?? '').trim(), supplier.id, supplier.supplierName,
        updatedOrder.purchaseDate, purchasedBy, totalAmount, items.length, action === 'inbound' ? 1 : 0,
        String(body.remark || '').trim() || null, now, id
      );
      replaceDraftItemsAndInventory({ ...updatedOrder, warehouseId: resolveWarehouse(body.warehouseId), actorId: actor.id }, items, action === 'inbound', now);
    })();

    return NextResponse.json(successResponse({
      ...orderDetail(id),
      status: action,
      inventoryIds: action === 'inbound' ? inventoryIdsForOrder(id) : [],
    }));
  } catch (error: unknown) {
    if (error instanceof AuthError) return NextResponse.json(errorResponse(error.code, error.message), { status: error.status });
    console.error('PATCH /api/purchase-orders error:', error);
    return NextResponse.json(errorResponse(ErrorCode.DATABASE_ERROR, errorMessage(error) || '更新采购单失败'), { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  try {
    await requireRole('admin');
    const id = new URL(request.url).searchParams.get('id')?.trim();
    if (!id) return NextResponse.json(errorResponse(ErrorCode.VALIDATION_ERROR, '采购单 ID 不能为空'), { status: 400 });
    const existing = orderRow(id);
    if (!existing) return NextResponse.json(errorResponse(ErrorCode.PURCHASE_ORDER_NOT_FOUND, '采购单不存在'), { status: 404 });
    if (existing.isInbounded) return NextResponse.json(errorResponse(ErrorCode.VALIDATION_ERROR, '已入库采购单不能删除'), { status: 400 });
    db.transaction(() => {
      // 保留草稿明细及 SN 唯一值，删除采购单只做逻辑删除。
      db.prepare('UPDATE purchase_items SET deleted = 1 WHERE purchaseOrderId = ? AND deleted = 0').run(id);
      db.prepare('UPDATE purchase_orders SET deleted = 1, updatedAt = ? WHERE id = ?').run(formatDateTime(), id);
    })();
    return NextResponse.json(successResponse({ id }));
  } catch (error: unknown) {
    if (error instanceof AuthError) return NextResponse.json(errorResponse(error.code, error.message), { status: error.status });
    console.error('DELETE /api/purchase-orders error:', error);
    return NextResponse.json(errorResponse(ErrorCode.DATABASE_ERROR, errorMessage(error) || '删除采购单失败'), { status: 500 });
  }
}
