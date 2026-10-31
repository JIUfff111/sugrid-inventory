import { assertStockEligible, endCustomStatus, stockEligibleSql, serializeInventoryStatus } from '@/lib/inventory-status';
import { NextRequest, NextResponse } from 'next/server';
import db from '@/lib/db';
import {
  createPaginatedResponse,
  errorResponse,
  ErrorCode,
  formatDateTime,
  generateId,
  parsePaginationParams,
  successResponse,
} from '@/lib/api-helpers';
import { AuthError, requireRole } from '@/lib/auth';

type InventoryRow = {
  id: string;
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
  supplierName: string;
  inboundDate: string;
  skuRemark: string | null;
};

type RentalRow = {
  id: string;
  rentalNo: string;
  inventoryId: string;
  sn: string;
  brand: string;
  model: string;
  year: number | null;
  config: string;
  purchasePrice: number;
  customerName: string;
  customerPhone: string;
  customerAddress: string;
  rentalStartDate: string;
  rentalEndDate: string;
  rentalType: string;
  rentalUnitPrice: number;
  rentalDuration: number;
  rentalTotalPrice: number;
  deposit: number;
  status: string;
  returnDate: string | null;
  returnType: string | null;
  remark: string | null;
  createdAt: string;
  updatedAt: string;
  isOverdue: number;
  isDueSoon: number;
};

function messageOf(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

function jsonError(code: string, message: string, status = 400) {
  return NextResponse.json(errorResponse(code, message), { status });
}

function authError(error: unknown) {
  return error instanceof AuthError ? NextResponse.json(errorResponse(error.code, error.message), { status: error.status }) : null;
}

function rentalNo() {
  const date = formatDateTime().slice(0, 10).replace(/-/g, '');
  const prefix = `租${date}`;
  const row = db.prepare('SELECT rentalNo FROM rental_orders WHERE rentalNo LIKE ? ORDER BY rentalNo DESC LIMIT 1').get(`${prefix}%`) as { rentalNo: string } | undefined;
  const last = row ? Number.parseInt(row.rentalNo.slice(prefix.length), 10) : 0;
  return `${prefix}${String(Number.isFinite(last) ? last + 1 : 1).padStart(3, '0')}`;
}

function rentalDuration(start: string, end: string, type: string) {
  const startDate = new Date(`${start}T00:00:00`);
  const endDate = new Date(`${end}T00:00:00`);
  if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime()) || endDate < startDate) return 0;
  if (type === 'month') {
    const months = (endDate.getFullYear() - startDate.getFullYear()) * 12 + endDate.getMonth() - startDate.getMonth();
    return Math.max(1, months + (endDate.getDate() >= startDate.getDate() ? 1 : 0));
  }
  return Math.max(1, Math.floor((endDate.getTime() - startDate.getTime()) / 86400000) + 1);
}

const inventorySelect = `
  SELECT i.id, i.sn, i.status, i.currentStatusRecordId, i.warehouseId, i.productType, i.brand, i.model, i.year, i.cpu, i.ram, i.gpu,
    i.storage, i.screen, i.touchScreen, i.purchasePrice, i.supplierName,
    i.inboundDate, i.skuRemark
  FROM inventory i
`;

function addRentalMovement(inventoryId: string, rentalId: string, movementType: string, actorId: string, note: string, createdAt: string) {
  const inventory = db.prepare('SELECT warehouseId FROM inventory WHERE id = ?').get(inventoryId) as { warehouseId?: string | null } | undefined;
  db.prepare(`INSERT INTO inventory_movements
    (id, inventoryId, warehouseId, movementType, quantity, referenceType, referenceId, actorId, note, createdAt)
    VALUES (?, ?, ?, ?, 1, 'rental', ?, ?, ?, ?)`).run(
    generateId('movement'), inventoryId, inventory?.warehouseId || 'warehouse_main', movementType,
    rentalId, actorId, note || null, createdAt,
  );
}

function dueFilter(searchParams: URLSearchParams) {
  const raw = searchParams.get('dueWithinDays') || searchParams.get('dueDays') || searchParams.get('due') || searchParams.get('expiresIn');
  if (raw === null && searchParams.get('dueSoon') !== '1' && searchParams.get('expiring') !== '1') return null;
  const days = raw === null ? 3 : Number(raw);
  return Number.isFinite(days) ? Math.max(0, Math.min(365, Math.floor(days))) : 3;
}

export async function GET(request: NextRequest) {
  try {
    await requireRole('admin');
    const { searchParams } = new URL(request.url);
    const { page, pageSize } = parsePaginationParams(searchParams);
    const search = searchParams.get('search')?.trim() || '';
    const status = searchParams.get('status')?.trim() || '';
    const resource = searchParams.get('resource') || '';
    const dueDays = dueFilter(searchParams);

    if (resource === 'inventory') {
      const conditions = [stockEligibleSql('i')];
      const params: string[] = [];
      if (search) {
        const pattern = `%${search}%`;
        conditions.push('(i.sn LIKE ? OR i.brand LIKE ? OR i.model LIKE ? OR CAST(i.year AS TEXT) LIKE ? OR i.supplierName LIKE ?)');
        params.push(pattern, pattern, pattern, pattern, pattern);
      }
      const where = `WHERE ${conditions.join(' AND ')}`;
      const count = db.prepare(`SELECT COUNT(*) AS total FROM inventory i ${where}`).get(...params) as { total: number };
      const safePage = Math.min(page, Math.max(1, Math.ceil(Number(count.total) / pageSize)));
      const items = db.prepare(`${inventorySelect} ${where} ORDER BY i.createdAt DESC LIMIT ? OFFSET ?`).all(...params, pageSize, (safePage - 1) * pageSize) as InventoryRow[];
      return NextResponse.json(successResponse(createPaginatedResponse(items.map(serializeInventoryStatus), Number(count.total), safePage, pageSize)));
    }

    const conditions = ['r.deleted = 0'];
    const params: string[] = [];
    if (status && status !== 'all') {
      conditions.push('r.status = ?');
      params.push(status);
    }
    if (dueDays !== null) {
      conditions.push("r.status = 'renting' AND date(r.rentalEndDate) <= date('now', '+8 hours', ?)");
      params.push(`+${dueDays} day`);
    }
    if (search) {
      const pattern = `%${search}%`;
      conditions.push('(r.rentalNo LIKE ? OR r.sn LIKE ? OR r.brand LIKE ? OR r.model LIKE ? OR CAST(i.year AS TEXT) LIKE ? OR r.customerName LIKE ? OR r.customerPhone LIKE ?)');
      params.push(pattern, pattern, pattern, pattern, pattern, pattern, pattern);
    }
    const where = `WHERE ${conditions.join(' AND ')}`;
    const count = db.prepare(`SELECT COUNT(*) AS total FROM rental_records r LEFT JOIN inventory i ON i.id = r.inventoryId LEFT JOIN rental_orders ro ON ro.id = r.rentalOrderId ${where}`).get(...params) as { total: number };
    const safePage = Math.min(page, Math.max(1, Math.ceil(Number(count.total) / pageSize)));
    const rows = db.prepare(`SELECT r.*, COALESCE(ro.rentalNo, r.rentalNo) AS displayRentalNo,
      (SELECT COUNT(*) FROM rental_records siblings WHERE siblings.rentalOrderId = r.rentalOrderId AND siblings.deleted = 0) AS orderMachineCount,
      i.year AS year,
      CAST(julianday(date(r.rentalEndDate)) - julianday(date('now', 'localtime')) AS INTEGER) AS daysUntilDue,
      CASE WHEN r.status = 'renting' AND date(r.rentalEndDate) < date('now', 'localtime') THEN 1 ELSE 0 END AS isOverdue,
      CASE WHEN r.status = 'renting' AND date(r.rentalEndDate) >= date('now', 'localtime') AND date(r.rentalEndDate) <= date('now', 'localtime', '+3 day') THEN 1 ELSE 0 END AS isDueSoon
      FROM rental_records r LEFT JOIN inventory i ON i.id = r.inventoryId LEFT JOIN rental_orders ro ON ro.id = r.rentalOrderId ${where} ORDER BY r.rentalEndDate ASC, r.createdAt DESC LIMIT ? OFFSET ?`).all(...params, pageSize, (safePage - 1) * pageSize) as Array<RentalRow & { id: string }>;
    const withMovements = rows.map((row) => ({
      ...row,
      dueStatus: Number(row.isOverdue) ? 'overdue' : Number(row.isDueSoon) ? 'due_soon' : 'normal',
      movements: db.prepare("SELECT id, inventoryId, warehouseId, fromWarehouseId, toWarehouseId, movementType, quantity, referenceType, referenceId, actorId, note, createdAt FROM inventory_movements WHERE referenceType = 'rental' AND referenceId = ? ORDER BY createdAt ASC").all(row.id),
    }));
    return NextResponse.json(successResponse(createPaginatedResponse(withMovements, Number(count.total), safePage, pageSize)));
  } catch (error) {
    const response = authError(error); if (response) return response;
    return NextResponse.json(errorResponse(ErrorCode.DATABASE_ERROR, messageOf(error, '获取租赁数据失败')), { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const user = await requireRole('admin');
    const body = await request.json() as Record<string, unknown>;
    const rawItems = Array.isArray(body.items) ? body.items : Array.isArray(body.inventoryIds) ? body.inventoryIds.map(inventoryId => ({ inventoryId })) : body.inventoryId ? [{ inventoryId: body.inventoryId }] : [];
    const itemInputs = rawItems.map((item) => typeof item === 'string' ? { inventoryId: item } : item && typeof item === 'object' ? item as Record<string, unknown> : {});
    const inventoryIds = itemInputs.map(item => String(item.inventoryId || '').trim());
    if (!inventoryIds.length) return jsonError(ErrorCode.VALIDATION_ERROR, '请至少选择一台租赁机器');
    if (inventoryIds.length > 100) return jsonError(ErrorCode.VALIDATION_ERROR, '单次最多选择 100 台机器');
    if (inventoryIds.some(id => !id) || new Set(inventoryIds).size !== inventoryIds.length) return jsonError(ErrorCode.VALIDATION_ERROR, '机器选择无效或包含重复机器');
    const customerName = String(body.customerName || '').trim();
    const customerPhone = String(body.customerPhone || '').trim();
    const customerAddress = String(body.customerAddress || '').trim();
    const rentalStartDate = String(body.rentalStartDate || '').trim();
    const rentalEndDate = String(body.rentalEndDate || '').trim();
    const rentalType = body.rentalType === 'month' ? 'month' : 'day';
    if (!customerName || !customerPhone || !customerAddress || !rentalStartDate || !rentalEndDate) return jsonError(ErrorCode.VALIDATION_ERROR, '请填写完整的租赁和客户信息');
    const lineInputs = itemInputs.map(item => ({
      inventoryId: String(item.inventoryId || '').trim(),
      rentalUnitPrice: Number(item.rentalUnitPrice ?? body.rentalUnitPrice),
      deposit: Number(item.deposit ?? body.deposit ?? 0),
    }));
    if (lineInputs.some(item => !Number.isFinite(item.rentalUnitPrice) || item.rentalUnitPrice <= 0)) return jsonError(ErrorCode.VALIDATION_ERROR, '请为每台机器填写有效的租赁单价');
    if (lineInputs.some(item => !Number.isFinite(item.deposit) || item.deposit < 0)) return jsonError(ErrorCode.VALIDATION_ERROR, '每台机器的押金格式不正确');
    const duration = rentalDuration(rentalStartDate, rentalEndDate, rentalType);
    if (!duration) return jsonError(ErrorCode.VALIDATION_ERROR, '租赁结束日期不能早于开始日期');

    const inventoryById = new Map<string, InventoryRow>();
    for (const inventoryId of inventoryIds) {
      const inventory = db.prepare(`${inventorySelect} WHERE i.id = ? AND i.deleted = 0`).get(inventoryId) as InventoryRow | undefined;
      if (!inventory) return jsonError(ErrorCode.INVENTORY_NOT_FOUND, `未找到机器 ${inventoryId}`, 404);
      inventoryById.set(inventoryId, inventory);
    }
    const orderId = generateId('rental_order');
    const now = formatDateTime();
    const no = rentalNo();
    const orderTotal = lineInputs.reduce((sum, item) => sum + item.rentalUnitPrice * duration, 0);
    const createdItems: Array<{ id: string; inventoryId: string; rentalNo: string; rentalUnitPrice: number; deposit: number }> = [];
    db.transaction(() => {
      db.prepare(`INSERT INTO rental_orders
        (id,rentalNo,customerName,customerPhone,customerAddress,rentalStartDate,rentalEndDate,rentalType,remark,createdBy,createdAt,updatedAt)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(orderId,no,customerName,customerPhone,customerAddress,rentalStartDate,rentalEndDate,rentalType,String(body.remark || '').trim() || null,user.id,now,now);
      const update = db.prepare("UPDATE inventory SET status = 'renting', rentalRecordId = ?, updatedAt = ? WHERE id = ? AND status IN ('in_stock','custom') AND deleted = 0");
      const insertRental = db.prepare(`INSERT INTO rental_records (
        id, rentalOrderId, rentalNo, inventoryId, sn, brand, model, config, purchasePrice,
        customerName, customerPhone, customerAddress, rentalStartDate, rentalEndDate,
        rentalType, rentalUnitPrice, rentalDuration, rentalTotalPrice, deposit,
        status, remark, deleted, createdBy, createdAt, updatedAt
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'renting', ?, 0, ?, ?, ?)`);
      for (const [index, line] of lineInputs.entries()) {
        assertStockEligible(line.inventoryId);
        const inventory = inventoryById.get(line.inventoryId)!;
        const id = generateId('rental');
        const config = [inventory.cpu, inventory.ram, inventory.gpu, inventory.storage, inventory.screen].filter(Boolean).join(' / ') || '配置待补充';
        const itemNo = `${no}-${String(index + 1).padStart(2, '0')}`;
        endCustomStatus(line.inventoryId,user.id,'租赁出库','rental',id,'renting');
        if (update.run(id, now, line.inventoryId).changes !== 1) throw new Error('机器状态已发生变化，请刷新后重试');
        insertRental.run(
          id, orderId, itemNo, inventory.id, inventory.sn, inventory.brand, inventory.model, config, inventory.purchasePrice,
          customerName, customerPhone, customerAddress, rentalStartDate, rentalEndDate,
          rentalType, line.rentalUnitPrice, duration, line.rentalUnitPrice * duration, line.deposit,
          String(body.remark || '').trim() || null, user.id, now, now,
        );
        addRentalMovement(line.inventoryId, id, 'rental_out', user.id, '租赁出库 · ' + no, now);
        createdItems.push({ id, inventoryId: inventory.id, rentalNo: itemNo, rentalUnitPrice: line.rentalUnitPrice, deposit: line.deposit });
      }
    })();
    return NextResponse.json(successResponse({ id: createdItems.length === 1 ? createdItems[0].id : orderId, rentalOrderId: orderId, rentalNo: no, count: lineInputs.length, duration, totalPrice: orderTotal, items: createdItems }), { status: 201 });
  } catch (error) {
    const response = authError(error); if (response) return response;
    const message = messageOf(error,'创建租赁记录失败');
    const conflict = /不可参与在库业务|状态已发生变化/.test(message);
    return NextResponse.json(errorResponse(conflict ? ErrorCode.VALIDATION_ERROR : ErrorCode.DATABASE_ERROR, message), { status: conflict ? 400 : 500 });
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const user = await requireRole('admin');
    const body = await request.json() as Record<string, unknown>;
    const id = String(body.id || body.rentalId || '').trim();
    if (!id) return jsonError(ErrorCode.VALIDATION_ERROR, '租赁记录 ID 不能为空');
    if (body.action !== 'return') return jsonError(ErrorCode.VALIDATION_ERROR, '不支持的租赁操作');
    const rental = db.prepare('SELECT id, inventoryId, status, rentalStartDate FROM rental_records WHERE id = ? AND deleted = 0').get(id) as { id: string; inventoryId: string; status: string; rentalStartDate: string } | undefined;
    if (!rental) return jsonError(ErrorCode.NOT_FOUND, '租赁记录不存在', 404);
    if (rental.status !== 'renting') return jsonError(ErrorCode.VALIDATION_ERROR, '租赁记录已经归还');
    const now = formatDateTime();
    const returnDate = String(body.returnDate || now.slice(0, 10)).trim();
    const returnType = String(body.returnType || '正常归还').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(returnDate) || Number.isNaN(Date.parse(returnDate)) || returnDate < rental.rentalStartDate) return jsonError(ErrorCode.VALIDATION_ERROR, '归还日期不能早于租赁开始日期');
    db.transaction(() => {
      const updateInventory = db.prepare("UPDATE inventory SET status = 'in_stock', rentalRecordId = NULL, updatedAt = ? WHERE id = ? AND status = 'renting' AND rentalRecordId = ? AND deleted = 0");
      if (updateInventory.run(now, rental.inventoryId, id).changes !== 1) throw new Error('库存状态已发生变化，请刷新后重试');
      db.prepare("UPDATE rental_records SET status = 'returned', returnDate = ?, returnType = ?, updatedAt = ? WHERE id = ? AND status = 'renting' AND deleted = 0").run(returnDate, returnType, now, id);
      addRentalMovement(rental.inventoryId, id, 'rental_return', user.id, '租赁归还入库', now);
    })();
    return NextResponse.json(successResponse({ id, status: 'returned', returnDate }));
  } catch (error) {
    const response = authError(error); if (response) return response;
    return NextResponse.json(errorResponse(ErrorCode.DATABASE_ERROR, messageOf(error, '完成租赁归还失败')), { status: 500 });
  }
}
