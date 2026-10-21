import { assertStockEligible, endCustomStatus, stockEligibleSql, serializeInventoryStatus } from '@/lib/inventory-status';
/**
 * 采购售后退货 API
 *
 * GET  /api/returns?resource=inventory  查询可退货库存
 * GET  /api/returns                  查询退货单列表
 * GET  /api/returns?id=...           查询退货单详情
 * POST /api/returns                  创建退货申请并将库存置为 returning
 * PATCH /api/returns                 action=complete 时完成退货并保留库存审计记录
 */

import { NextRequest, NextResponse } from 'next/server';
import db from '@/lib/db';
import { AuthError, requireRole } from '@/lib/auth';
import {
  createPaginatedResponse,
  errorResponse,
  ErrorCode,
  formatDateTime,
  generateId,
  parsePaginationParams,
  successResponse,
} from '@/lib/api-helpers';

type InventoryRow = {
  id: string;
  warehouseId: string;
  purchaseOrderId: string;
  purchaseNo: string | null;
  purchaseItemId: string;
  sn: string;
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
  purchasePrice: number;
  supplierId: string;
  supplierName: string;
  status: string;
  inboundDate: string;
  remark: string | null;
  skuRemark: string | null;
};

type ReturnItem = {
  inventoryId: string;
  purchaseOrderId: string;
  purchaseOrderNo: string | null;
  sn: string;
  productType: string;
  brand: string;
  model: string;
  year: number | null;
  cpu: string;
  ram: string;
  gpu: string | null;
  storage: string;
  screen: string;
  touchScreen: boolean | null;
  purchasePrice: number;
  supplierName: string;
};

type ReturnOrderRow = {
  id: string;
  returnNo: string;
  items: string;
  purchaseOrderId: string;
  purchaseOrderNo: string;
  supplierId: string;
  supplierName: string;
  returnReason: string;
  returnDescription: string | null;
  refundAmount: number;
  status: 'returning' | 'completed' | string;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

function messageOf(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

function jsonError(code: string, message: string, status = 400) {
  return NextResponse.json(errorResponse(code, message), { status });
}


function generateReturnNo() {
  const today = new Date();
  const date = `${today.getFullYear()}${String(today.getMonth() + 1).padStart(2, '0')}${String(today.getDate()).padStart(2, '0')}`;
  const prefix = `RT${date}`;
  const row = db.prepare(`
    SELECT returnNo FROM return_orders
    WHERE returnNo LIKE ? ORDER BY returnNo DESC LIMIT 1
  `).get(`${prefix}%`) as { returnNo: string } | undefined;
  const lastSequence = row ? Number.parseInt(row.returnNo.slice(prefix.length), 10) : 0;
  const sequence = Number.isFinite(lastSequence) ? lastSequence + 1 : 1;
  return `${prefix}${String(sequence).padStart(3, '0')}`;
}

function parseItems(value: string): ReturnItem[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed as ReturnItem[] : [];
  } catch {
    return [];
  }
}

function serializeOrder(row: ReturnOrderRow) {
  const items = parseItems(row.items);
  return {
    ...row,
    items,
    itemCount: items.length,
  };
}

function getOrder(id: string) {
  return db.prepare(`
    SELECT id, returnNo, items, purchaseOrderId, purchaseOrderNo, supplierId,
      supplierName, returnReason, returnDescription, refundAmount, status,
      completedAt, createdAt, updatedAt
    FROM return_orders
    WHERE id = ? AND deleted = 0
  `).get(id) as ReturnOrderRow | undefined;
}

const inventorySelect = `
  SELECT
    i.id, i.warehouseId, i.purchaseOrderId, po.purchaseNo, i.purchaseItemId, i.sn,
    i.productType, i.brand, i.model, i.year, i.cpu, i.ram, i.gpu, i.storage,
    i.screen, i.touchScreen, i.purchasePrice, i.supplierId, i.supplierName,
    i.status, i.currentStatusRecordId, i.inboundDate, i.remark, i.skuRemark
  FROM inventory i
  LEFT JOIN purchase_orders po ON po.id = i.purchaseOrderId
`;

function normalizeIds(body: unknown): string[] {
  const source = body && typeof body === 'object' && 'inventoryIds' in body
    ? (body as { inventoryIds?: unknown }).inventoryIds
    : body && typeof body === 'object' && 'ids' in body
      ? (body as { ids?: unknown }).ids
      : body && typeof body === 'object' && 'items' in body
        ? (body as { items?: unknown }).items
        : [];
  if (!Array.isArray(source)) return [];
  return [...new Set(source.map((item) => {
    if (typeof item === 'string') return item.trim();
    if (item && typeof item === 'object') {
      const value = (item as { id?: unknown; inventoryId?: unknown; sn?: unknown }).inventoryId
        ?? (item as { id?: unknown }).id
        ?? (item as { sn?: unknown }).sn;
      return typeof value === 'string' ? value.trim() : '';
    }
    return '';
  }).filter(Boolean))];
}

function findInventory(ids: string[]): InventoryRow[] {
  const rows: InventoryRow[] = [];
  const byId = db.prepare(`${inventorySelect} WHERE i.id = ? AND i.deleted = 0`);
  const bySn = db.prepare(`${inventorySelect} WHERE i.sn = ? AND i.deleted = 0`);
  for (const id of ids) {
    const row = (byId.get(id) || bySn.get(id)) as InventoryRow | undefined;
    if (row) rows.push(row);
  }
  return rows;
}

function returnItem(row: InventoryRow): ReturnItem {
  return {
    inventoryId: row.id,
    purchaseOrderId: row.purchaseOrderId,
    purchaseOrderNo: row.purchaseNo,
    sn: row.sn,
    productType: row.productType,
    brand: row.brand,
    model: row.model,
    year: row.year,
    cpu: row.cpu,
    ram: row.ram,
    gpu: row.gpu,
    storage: row.storage,
    screen: row.screen,
    touchScreen: row.touchScreen === null || row.touchScreen === undefined ? null : Boolean(row.touchScreen),
    purchasePrice: Number(row.purchasePrice),
    supplierName: row.supplierName,
  };
}

export async function GET(request: NextRequest) {
  try {
    await requireRole('admin');
    const { searchParams } = new URL(request.url);
    const id = searchParams.get('id')?.trim();
    if (id) {
      const order = getOrder(id);
      if (!order) return jsonError(ErrorCode.NOT_FOUND, '退货单不存在', 404);
      return NextResponse.json(successResponse(serializeOrder(order)));
    }

    const resource = searchParams.get('resource') || searchParams.get('mode');
    const isInventory = resource === 'inventory' || searchParams.get('inventory') === '1';
    const { page, pageSize } = parsePaginationParams(searchParams);
    const search = searchParams.get('search')?.trim() || '';
    const offset = (page - 1) * pageSize;
    const pattern = `%${search}%`;

    if (isInventory) {
      const conditions = [stockEligibleSql('i')];
      const params: string[] = [];
      if (search) {
        conditions.push(`(
          i.sn LIKE ? OR i.brand LIKE ? OR i.model LIKE ? OR CAST(i.year AS TEXT) LIKE ? OR i.cpu LIKE ? OR
          i.ram LIKE ? OR i.storage LIKE ? OR i.supplierName LIKE ? OR po.purchaseNo LIKE ?
        )`);
        params.push(pattern, pattern, pattern, pattern, pattern, pattern, pattern, pattern, pattern);
      }
      const where = `WHERE ${conditions.join(' AND ')}`;
      const items = db.prepare(`
        ${inventorySelect} ${where}
        ORDER BY i.createdAt DESC LIMIT ? OFFSET ?
      `).all(...params, pageSize, offset) as InventoryRow[];
      const count = db.prepare(`
        SELECT COUNT(*) AS total FROM inventory i
        LEFT JOIN purchase_orders po ON po.id = i.purchaseOrderId ${where}
      `).get(...params) as { total: number };
      return NextResponse.json(successResponse(createPaginatedResponse(items.map(serializeInventoryStatus), Number(count.total), page, pageSize)));
    }

    const conditions = ['ro.deleted = 0'];
    const params: string[] = [];
    const status = searchParams.get('status')?.trim();
    if (status === 'returning' || status === 'completed') {
      conditions.push('ro.status = ?');
      params.push(status);
    }
    if (search) {
      conditions.push('(ro.returnNo LIKE ? OR ro.purchaseOrderNo LIKE ? OR ro.supplierName LIKE ? OR ro.returnReason LIKE ?)');
      params.push(pattern, pattern, pattern, pattern);
    }
    const where = `WHERE ${conditions.join(' AND ')}`;
    const rows = db.prepare(`
      SELECT ro.id, ro.returnNo, ro.items, ro.purchaseOrderId, ro.purchaseOrderNo,
        ro.supplierId, ro.supplierName, ro.returnReason, ro.returnDescription,
        ro.refundAmount, ro.status, ro.completedAt, ro.createdAt, ro.updatedAt
      FROM return_orders ro ${where}
      ORDER BY ro.createdAt DESC LIMIT ? OFFSET ?
    `).all(...params, pageSize, offset) as ReturnOrderRow[];
    const count = db.prepare(`SELECT COUNT(*) AS total FROM return_orders ro ${where}`).get(...params) as { total: number };
    return NextResponse.json(successResponse(createPaginatedResponse(rows.map(serializeOrder), Number(count.total), page, pageSize)));
  } catch (error: unknown) {
    if (error instanceof AuthError) return NextResponse.json(errorResponse(error.code, error.message), { status: error.status });
    console.error('GET /api/returns error:', error);
    return NextResponse.json(errorResponse(ErrorCode.DATABASE_ERROR, messageOf(error, '获取退货数据失败')), { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const actor = await requireRole('admin');
    const body = await request.json() as {
      inventoryIds?: unknown;
      ids?: unknown;
      items?: unknown;
      returnReason?: unknown;
      returnDescription?: unknown;
      refundAmount?: unknown;
    };
    const ids = normalizeIds(body);
    if (ids.length === 0) return jsonError(ErrorCode.VALIDATION_ERROR, '至少选择一台在库机器');
    const returnReason = String(body.returnReason || '').trim();
    if (!returnReason) return jsonError(ErrorCode.VALIDATION_ERROR, '请选择退货原因');
    const refundAmount = Number(body.refundAmount);
    if (!Number.isFinite(refundAmount) || refundAmount < 0) {
      return jsonError(ErrorCode.VALIDATION_ERROR, '请输入有效的退款金额');
    }

    const rows = findInventory(ids);
    if (rows.length !== ids.length) return jsonError(ErrorCode.INVENTORY_NOT_FOUND, '部分机器不存在或已从库存移除');
    for (const row of rows) assertStockEligible(row.id);

    // return_orders 的采购信息是单值，因此一张退货单必须属于同一采购单。
    const first = rows[0];
    if (rows.some((row) => row.purchaseOrderId !== first.purchaseOrderId || row.supplierId !== first.supplierId)) {
      return jsonError(ErrorCode.VALIDATION_ERROR, '一次退货申请只能选择同一采购单的机器');
    }

    const now = formatDateTime();
    const orderId = generateId('return');
    const returnNo = generateReturnNo();
    const orderItems = rows.map(returnItem);
    const purchaseOrderNo = first.purchaseNo || first.purchaseOrderId;
    const description = body.returnDescription === undefined || body.returnDescription === null
      ? null
      : String(body.returnDescription).trim() || null;

    db.transaction(() => {
      const updated = db.prepare(`
        UPDATE inventory SET status = 'returning', updatedAt = ?
        WHERE id = ? AND status IN ('in_stock','custom') AND deleted = 0
      `);
      for (const row of rows) {
        assertStockEligible(row.id);
        const result = updated.run(now, row.id);
        if (result.changes !== 1) throw new Error(`机器 ${row.sn} 状态已发生变化，请刷新后重试`);
      }
      db.prepare(`
        INSERT INTO return_orders (
          id, returnNo, items, purchaseOrderId, purchaseOrderNo, supplierId,
          supplierName, returnReason, returnDescription, refundAmount, status,
          deleted, createdBy, createdAt, updatedAt
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'returning', 0, ?, ?, ?)
      `).run(
        orderId, returnNo, JSON.stringify(orderItems), first.purchaseOrderId, purchaseOrderNo,
        first.supplierId, first.supplierName, returnReason, description, refundAmount,
        actor.id, now, now
      );
    })();

    const order = getOrder(orderId);
    return NextResponse.json(successResponse(order ? serializeOrder(order) : { id: orderId, returnNo }), { status: 201 });
  } catch (error: unknown) {
    if (error instanceof AuthError) return NextResponse.json(errorResponse(error.code, error.message), { status: error.status });
    console.error('POST /api/returns error:', error);
    const message = messageOf(error,'创建退货申请失败');
    const conflict = /不可参与在库业务|状态已发生变化/.test(message);
    return NextResponse.json(errorResponse(conflict ? ErrorCode.VALIDATION_ERROR : ErrorCode.DATABASE_ERROR, message), { status: conflict ? 400 : 500 });
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const actor = await requireRole('admin');
    const body = await request.json() as { id?: unknown; returnId?: unknown; action?: unknown };
    const id = String(body.id || body.returnId || '').trim();
    if (!id) return jsonError(ErrorCode.VALIDATION_ERROR, '退货单 ID 不能为空');
    if (body.action !== 'complete' && body.action !== 'completed') {
      return jsonError(ErrorCode.VALIDATION_ERROR, '不支持的退货操作');
    }
    const order = getOrder(id);
    if (!order) return jsonError(ErrorCode.NOT_FOUND, '退货单不存在', 404);
    if (order.status === 'completed') return jsonError(ErrorCode.VALIDATION_ERROR, '退货单已经完成');

    const items = parseItems(order.items);
    if (items.length === 0) return jsonError(ErrorCode.VALIDATION_ERROR, '退货单没有机器明细');
    const now = formatDateTime();
    db.transaction(() => {
      const completeInventory = db.prepare(`UPDATE inventory SET status = 'returned', updatedAt = ? WHERE id = ? AND status = 'returning' AND deleted = 0`);
      for (const item of items) {
        const inventoryId = String(item.inventoryId || '').trim();
        if (!inventoryId) throw new Error(`退货单 ${order.returnNo} 缺少库存记录 ID`);
        const exists = db.prepare('SELECT id, warehouseId FROM inventory WHERE id = ? AND deleted = 0').get(inventoryId) as { id: string; warehouseId: string } | undefined;
        if (!exists) throw new Error(`机器 ${item.sn || inventoryId} 已不存在，无法完成退货`);
        endCustomStatus(inventoryId,actor.id,'供应商退货完成','return_order',id,'returned');
        const result = completeInventory.run(now, inventoryId);
        if (result.changes !== 1) throw new Error(`机器 ${item.sn || inventoryId} 状态不是退货中`);
        db.prepare(`INSERT INTO inventory_movements (id, inventoryId, warehouseId, fromWarehouseId, movementType, referenceType, referenceId, actorId, note, createdAt)
          VALUES (?, ?, ?, ?, 'supplier_return', 'return_order', ?, ?, ?, ?)`)
          .run(generateId('movement'), inventoryId, exists.warehouseId, exists.warehouseId, id, actor.id, order.returnReason, now);
      }
      db.prepare(`
        UPDATE return_orders SET status = 'completed', completedAt = ?, updatedAt = ?
        WHERE id = ? AND deleted = 0 AND status = 'returning'
      `).run(now, now, id);
    })();

    const updated = getOrder(id);
    return NextResponse.json(successResponse(updated ? serializeOrder(updated) : { id, status: 'completed' }));
  } catch (error: unknown) {
    if (error instanceof AuthError) return NextResponse.json(errorResponse(error.code, error.message), { status: error.status });
    console.error('PATCH /api/returns error:', error);
    const message = messageOf(error, '完成退货失败');
    if (message.includes('FOREIGN KEY')) {
      return jsonError(ErrorCode.CANNOT_DELETE_IN_USE, '该机器存在关联记录，暂时无法完成退货', 400);
    }
    return NextResponse.json(errorResponse(ErrorCode.DATABASE_ERROR, message), { status: 500 });
  }
}
