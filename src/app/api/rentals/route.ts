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
import { calculateRentalDuration, isValidRentalDate } from '@/lib/rental-duration';

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

function addRentalEvent(input: {
  rentalRecordId: string;
  rentalOrderId: string | null;
  eventType: string;
  note?: string | null;
  beforeData?: unknown;
  afterData?: unknown;
  actorId: string;
  createdAt: string;
}) {
  db.prepare(`INSERT INTO rental_events
    (id, rentalRecordId, rentalOrderId, eventType, note, beforeData, afterData, actorId, createdAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    generateId('rental_event'), input.rentalRecordId, input.rentalOrderId, input.eventType,
    input.note?.trim() || null,
    input.beforeData === undefined ? null : JSON.stringify(input.beforeData),
    input.afterData === undefined ? null : JSON.stringify(input.afterData),
    input.actorId, input.createdAt,
  );
}

function validDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return !Number.isNaN(date.getTime()) && date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function addDateDays(value: string, days: number) {
  const [year, month, day] = value.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

function roundMoney(value: number) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

type RenewalInput = {
  id: string;
  newEndDate: string;
  billingUnit?: unknown;
  priceMode?: unknown;
  unitPrice?: unknown;
  totalAmount?: unknown;
  depositDelta?: unknown;
  depositChangeReason?: unknown;
  note?: unknown;
};

function performRenewals(userId: string, inputs: RenewalInput[]) {
  if (!inputs.length || inputs.length > 50) throw new Error('一次续租请选择 1 至 50 台机器');
  const ids = inputs.map(item => item.id.trim());
  if (ids.some(id => !id) || new Set(ids).size !== ids.length) throw new Error('续租机器无效或重复');
  const normalized = inputs.map((input) => {
    const id = input.id.trim();
    const newEndDate = input.newEndDate.trim();
    const rental = db.prepare(`SELECT r.id, r.rentalOrderId, r.rentalNo, r.inventoryId, r.sn, r.status,
      r.rentalStartDate, r.rentalEndDate, r.rentalType, r.rentalUnitPrice, r.rentalTotalPrice, r.deposit,
      i.status AS inventoryStatus, i.rentalRecordId
      FROM rental_records r JOIN inventory i ON i.id = r.inventoryId
      WHERE r.id = ? AND r.deleted = 0`).get(id) as {
        id: string; rentalOrderId: string | null; rentalNo: string; inventoryId: string; sn: string; status: string;
        rentalStartDate: string; rentalEndDate: string; rentalType: string; rentalUnitPrice: number;
        rentalTotalPrice: number; deposit: number; inventoryStatus: string; rentalRecordId: string | null;
      } | undefined;
    if (!rental) throw new Error(`找不到租赁机器 ${id}`);
    if (rental.status !== 'renting') throw new Error(`SN [${rental.sn}] 已结束租赁，不能续租`);
    if (rental.inventoryStatus !== 'renting' || rental.rentalRecordId !== id) throw new Error(`SN [${rental.sn}] 的库存租赁关联已变化，请刷新后重试`);
    if (!validDate(newEndDate) || newEndDate <= rental.rentalEndDate) throw new Error(`SN [${rental.sn}] 的新到期日必须晚于当前到期日`);
    const billingUnit = input.billingUnit === 'month' ? 'month' : input.billingUnit === 'day' ? 'day' : rental.rentalType === 'month' ? 'month' : 'day';
    const duration = calculateRentalDuration(rental.rentalEndDate, newEndDate, billingUnit);
    if (!duration) throw new Error(`SN [${rental.sn}] 的续租日期无效`);
    const priceMode = ['original_unit', 'custom_unit', 'custom_total'].includes(String(input.priceMode)) ? String(input.priceMode) : 'original_unit';
    const hasUnitPrice = input.unitPrice !== undefined && input.unitPrice !== null && String(input.unitPrice).trim() !== '';
    const rawUnitPrice = hasUnitPrice ? Number(input.unitPrice) : Number(rental.rentalUnitPrice);
    const rawTotal = input.totalAmount === undefined || input.totalAmount === null || input.totalAmount === '' ? NaN : Number(input.totalAmount);
    if (priceMode === 'custom_unit' && (!hasUnitPrice || !Number.isFinite(rawUnitPrice) || rawUnitPrice < 0)) throw new Error(`SN [${rental.sn}] 的续租单价无效`);
    if (priceMode === 'custom_total' && (!Number.isFinite(rawTotal) || rawTotal < 0)) throw new Error(`SN [${rental.sn}] 的续租总额无效`);
    const unitPrice = roundMoney(priceMode === 'custom_unit' ? rawUnitPrice : priceMode === 'custom_total' ? rawTotal / duration : Number(rental.rentalUnitPrice));
    const totalAmount = roundMoney(priceMode === 'custom_total' ? rawTotal : unitPrice * duration);
    const depositDelta = roundMoney(input.depositDelta === undefined || input.depositDelta === null || input.depositDelta === '' ? 0 : Number(input.depositDelta));
    if (!Number.isFinite(depositDelta)) throw new Error(`SN [${rental.sn}] 的押金调整金额无效`);
    const depositBefore = roundMoney(Number(rental.deposit || 0));
    const depositAfter = roundMoney(depositBefore + depositDelta);
    if (depositAfter < 0) throw new Error(`SN [${rental.sn}] 的押金退还金额不能超过现有押金`);
    const depositChangeReason = String(input.depositChangeReason || '').trim();
    if (depositDelta !== 0 && !depositChangeReason) throw new Error(`请填写 SN [${rental.sn}] 的押金调整原因`);
    const note = String(input.note || '').trim();
    if (note.length > 1000 || depositChangeReason.length > 500) throw new Error('续租备注最多 1000 个字符，押金调整原因最多 500 个字符');
    if (totalAmount === 0 && !note) throw new Error(`SN [${rental.sn}] 的本次租金为 0，请填写原因`);
    return { input, rental, newEndDate, periodStartDate: addDateDays(rental.rentalEndDate, 1), billingUnit, duration, priceMode, unitPrice, totalAmount, depositDelta, depositBefore, depositAfter, depositChangeReason, note };
  });
  const batchId = generateId('renewal_batch');
  const now = formatDateTime();
  db.transaction(() => {
    const insert = db.prepare(`INSERT INTO rental_renewals (
      id, batchId, rentalRecordId, rentalOrderId, periodStartDate, previousEndDate, newEndDate,
      billingUnit, duration, priceMode, unitPrice, totalAmount, depositBefore, depositDelta,
      depositAfter, depositChangeReason, note, actorId, createdAt
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const updateRental = db.prepare(`UPDATE rental_records SET rentalEndDate = ?, deposit = ?, updatedAt = ?
      WHERE id = ? AND status = 'renting' AND rentalEndDate = ? AND deleted = 0`);
    for (const item of normalized) {
      const { rental } = item;
      if (updateRental.run(item.newEndDate, item.depositAfter, now, rental.id, rental.rentalEndDate).changes !== 1) throw new Error(`SN [${rental.sn}] 的租赁记录已变化，请刷新后重试`);
      const renewalId = generateId('renewal');
      insert.run(renewalId, batchId, rental.id, rental.rentalOrderId, item.periodStartDate, rental.rentalEndDate,
        item.newEndDate, item.billingUnit, item.duration, item.priceMode, item.unitPrice, item.totalAmount,
        item.depositBefore, item.depositDelta, item.depositAfter, item.depositChangeReason || null,
        item.note || null, userId, now);
      addRentalEvent({
        rentalRecordId: rental.id, rentalOrderId: rental.rentalOrderId, eventType: 'renewed',
        note: `续租至 ${item.newEndDate} · ${item.totalAmount.toFixed(2)} 元`,
        beforeData: { rentalEndDate: rental.rentalEndDate, rentalTotalPrice: rental.rentalTotalPrice, deposit: item.depositBefore },
        afterData: { rentalEndDate: item.newEndDate, renewalId, renewalAmount: item.totalAmount, deposit: item.depositAfter },
        actorId: userId, createdAt: now,
      });
    }
    const orderIds = [...new Set(normalized.map(item => item.rental.rentalOrderId).filter((value): value is string => Boolean(value)))];
    for (const orderId of orderIds) {
      const latest = db.prepare("SELECT MAX(rentalEndDate) AS rentalEndDate FROM rental_records WHERE rentalOrderId = ? AND status = 'renting' AND deleted = 0").get(orderId) as { rentalEndDate: string | null };
      if (latest.rentalEndDate) db.prepare('UPDATE rental_orders SET rentalEndDate = ?, updatedAt = ? WHERE id = ?').run(latest.rentalEndDate, now, orderId);
    }
  })();
  return {
    batchId,
    items: normalized.map(item => ({
      id: item.rental.id, sn: item.rental.sn, status: 'renting', rentalEndDate: item.newEndDate,
      renewalAmount: item.totalAmount,
      cumulativeRentalAmount: roundMoney(Number(item.rental.rentalTotalPrice || 0) + Number((db.prepare('SELECT SUM(totalAmount) AS total FROM rental_renewals WHERE rentalRecordId = ?').get(item.rental.id) as { total: number | null }).total || 0)),
      deposit: item.depositAfter,
    })),
  };
}

function nextSaleRecordNo(saleDate: string) {
  const prefix = `XS${saleDate.replace(/-/g, '')}`;
  const latest = db.prepare('SELECT recordNo FROM sales_records WHERE recordNo LIKE ? ORDER BY recordNo DESC LIMIT 1').get(`${prefix}%`) as { recordNo: string } | undefined;
  let sequence = latest ? Number(latest.recordNo.slice(prefix.length)) + 1 : 1;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const candidate = `${prefix}${String(sequence).padStart(3, '0')}`;
    if (!db.prepare('SELECT 1 FROM sales_records WHERE recordNo = ?').get(candidate)) return candidate;
    sequence += 1;
  }
  throw new Error('销售单号生成失败，请稍后重试');
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
      sr.transactionType AS saleTransactionType, sr.buyoutBuyerName, sr.buyoutSource,
      sr.depositRefundAmount, sr.depositAppliedAmount, sr.depositRetainedAmount, sr.settlementAdjustment, sr.settlementNote,
      i.year AS year,
      CAST(julianday(date(r.rentalEndDate)) - julianday(date('now', '+8 hours')) AS INTEGER) AS daysUntilDue,
      CASE WHEN r.status = 'renting' AND date(r.rentalEndDate) < date('now', '+8 hours') THEN 1 ELSE 0 END AS isOverdue,
      CASE WHEN r.status = 'renting' AND date(r.rentalEndDate) >= date('now', '+8 hours') AND date(r.rentalEndDate) <= date('now', '+8 hours', '+3 day') THEN 1 ELSE 0 END AS isDueSoon
      FROM rental_records r LEFT JOIN inventory i ON i.id = r.inventoryId LEFT JOIN rental_orders ro ON ro.id = r.rentalOrderId
      LEFT JOIN sales_records sr ON sr.id = r.salesRecordId ${where} ORDER BY r.rentalEndDate ASC, r.createdAt DESC LIMIT ? OFFSET ?`).all(...params, pageSize, (safePage - 1) * pageSize) as Array<RentalRow & { id: string }>;
    const withMovements = rows.map((row) => {
      const renewalTotal = Number((db.prepare('SELECT COALESCE(SUM(totalAmount), 0) AS total FROM rental_renewals WHERE rentalRecordId = ?').get(row.id) as { total: number }).total || 0);
      return {
        ...row,
        dueStatus: Number(row.isOverdue) ? 'overdue' : Number(row.isDueSoon) ? 'due_soon' : 'normal',
        movements: db.prepare("SELECT id, inventoryId, warehouseId, fromWarehouseId, toWarehouseId, movementType, quantity, referenceType, referenceId, actorId, note, createdAt FROM inventory_movements WHERE referenceType = 'rental' AND referenceId = ? ORDER BY createdAt ASC").all(row.id),
        events: db.prepare(`SELECT id, eventType, note, beforeData, afterData, actorId, createdAt
          FROM rental_events WHERE rentalRecordId = ? ORDER BY createdAt DESC, rowid DESC`).all(row.id),
        renewals: db.prepare(`SELECT rr.*, COALESCE(u.realName, u.username, '未记录') AS actorName
          FROM rental_renewals rr LEFT JOIN users u ON u.id = rr.actorId
          WHERE rr.rentalRecordId = ? ORDER BY rr.createdAt DESC, rr.rowid DESC`).all(row.id),
        renewalTotal,
        cumulativeRentalAmount: roundMoney(Number(row.rentalTotalPrice || 0) + renewalTotal),
      };
    });
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
    const duration = calculateRentalDuration(rentalStartDate, rentalEndDate, rentalType);
    if (!isValidRentalDate(rentalStartDate) || !isValidRentalDate(rentalEndDate) || !duration) {
      return jsonError(ErrorCode.VALIDATION_ERROR, '结束日期必须晚于开始日期，并且至少达到一个完整计费单位');
    }

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
    const conflict = /不可参与在库业务|状态已发生变化|租赁条款已被其他操作修改|租赁订单日期已变化/.test(message);
    return NextResponse.json(errorResponse(conflict ? ErrorCode.VALIDATION_ERROR : ErrorCode.DATABASE_ERROR, message), { status: conflict ? 400 : 500 });
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const user = await requireRole('admin');
    const body = await request.json() as Record<string, unknown>;
    const action = String(body.action || '').trim();
    const now = formatDateTime();
    if (action === 'renew' || action === 'renew_batch') {
      const rawItems = action === 'renew'
        ? [{ ...body, id: String(body.id || body.rentalId || '') }]
        : Array.isArray(body.items) ? body.items : [];
      const inputs = rawItems.map((value) => {
        const item = value && typeof value === 'object' ? value as Record<string, unknown> : {};
        return {
          id: String(item.id || item.rentalId || ''),
          newEndDate: String(item.newEndDate || ''),
          billingUnit: item.billingUnit,
          priceMode: item.priceMode,
          unitPrice: item.unitPrice,
          totalAmount: item.totalAmount,
          depositDelta: item.depositDelta,
          depositChangeReason: item.depositChangeReason,
          note: item.note,
        } satisfies RenewalInput;
      });
      const result = performRenewals(user.id, inputs);
      return NextResponse.json(successResponse(action === 'renew' ? result.items[0] : result));
    }
    const id = String(body.id || body.rentalId || '').trim();
    if (!id) return jsonError(ErrorCode.VALIDATION_ERROR, '租赁记录 ID 不能为空');
    const rental = db.prepare(`SELECT r.id, r.rentalOrderId, r.rentalNo, r.inventoryId, r.sn, r.status,
      r.rentalStartDate, r.rentalEndDate, r.rentalType, r.rentalUnitPrice, r.rentalDuration,
      r.rentalTotalPrice, r.deposit, r.purchasePrice, r.salesRecordId, r.customerName, r.customerPhone, r.customerAddress,
      r.config, r.remark, i.productType, i.year, i.cpu, i.ram, i.gpu, i.storage, i.screen,
      i.touchScreen, i.warehouseId, i.status AS inventoryStatus, i.rentalRecordId,
      COALESCE(ro.rentalNo, r.rentalNo) AS displayRentalNo
      FROM rental_records r JOIN inventory i ON i.id = r.inventoryId
      LEFT JOIN rental_orders ro ON ro.id = r.rentalOrderId
      WHERE r.id = ? AND r.deleted = 0`).get(id) as (RentalRow & {
        rentalOrderId: string | null; productType: string; year: number | null; cpu: string; ram: string;
        gpu: string | null; storage: string; screen: string; touchScreen: number | null;
        warehouseId: string; inventoryStatus: string;
        rentalRecordId: string | null; salesRecordId: string | null; displayRentalNo: string;
      }) | undefined;
    if (!rental) return jsonError(ErrorCode.NOT_FOUND, '租赁记录不存在', 404);
    if (action === 'edit_terms') {
      const rentalOrderId = rental.rentalOrderId;
      const orderItems = (rentalOrderId
        ? db.prepare(`SELECT r.id, r.rentalOrderId, r.rentalNo, r.sn, r.status, r.rentalStartDate, r.rentalEndDate,
            r.rentalType, r.rentalUnitPrice, r.rentalDuration, r.rentalTotalPrice, i.status AS inventoryStatus,
            i.rentalRecordId, (SELECT COUNT(*) FROM rental_renewals rr WHERE rr.rentalRecordId = r.id) AS renewalCount
          FROM rental_records r JOIN inventory i ON i.id = r.inventoryId
          WHERE r.rentalOrderId = ? AND r.deleted = 0 ORDER BY r.sn`).all(rentalOrderId)
        : db.prepare(`SELECT r.id, r.rentalOrderId, r.rentalNo, r.sn, r.status, r.rentalStartDate, r.rentalEndDate,
            r.rentalType, r.rentalUnitPrice, r.rentalDuration, r.rentalTotalPrice, i.status AS inventoryStatus,
            i.rentalRecordId, (SELECT COUNT(*) FROM rental_renewals rr WHERE rr.rentalRecordId = r.id) AS renewalCount
          FROM rental_records r JOIN inventory i ON i.id = r.inventoryId
          WHERE r.id = ? AND r.deleted = 0`).all(id)) as Array<{
            id: string; rentalOrderId: string | null; rentalNo: string; sn: string; status: string;
            rentalStartDate: string; rentalEndDate: string; rentalType: string; rentalUnitPrice: number;
            rentalDuration: number; rentalTotalPrice: number; inventoryStatus: string; rentalRecordId: string | null;
            renewalCount: number;
          }>;
      if (!orderItems.length) return jsonError(ErrorCode.NOT_FOUND, '租赁订单不存在', 404);
      if (orderItems.some(item => item.status !== 'renting' || item.inventoryStatus !== 'renting' || item.rentalRecordId !== item.id)) {
        return jsonError(ErrorCode.VALIDATION_ERROR, '订单中有机器已结束租赁或库存关联变化，不能更正原租赁条款');
      }
      if (orderItems.some(item => Number(item.renewalCount) > 0)) {
        return jsonError(ErrorCode.VALIDATION_ERROR, '订单已有续租记录，不能覆盖原条款；请通过续租或账务更正记录处理');
      }
      const rentalStartDate = String(body.rentalStartDate || '').trim();
      const rentalEndDate = String(body.rentalEndDate || '').trim();
      const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
      const inputs = Array.isArray(body.items) ? body.items : [];
      if (!isValidRentalDate(rentalStartDate) || !isValidRentalDate(rentalEndDate)) return jsonError(ErrorCode.VALIDATION_ERROR, '请选择有效的租赁起止日期');
      if (!reason || reason.length > 500) return jsonError(ErrorCode.VALIDATION_ERROR, '请填写更正原因（最多 500 个字符）');
      if (!inputs.length || inputs.length > 100) return jsonError(ErrorCode.VALIDATION_ERROR, '请至少提交一台机器的租金，单次最多更正 100 台');
      const inputById = new Map<string, number>();
      for (const value of inputs) {
        const item = value && typeof value === 'object' ? value as Record<string, unknown> : {};
        const itemId = String(item.id || '').trim();
        const price = item.rentalUnitPrice === '' || item.rentalUnitPrice === null || item.rentalUnitPrice === undefined ? NaN : Number(item.rentalUnitPrice);
        if (!itemId || inputById.has(itemId) || !orderItems.some(row => row.id === itemId) || !Number.isFinite(price) || price <= 0) return jsonError(ErrorCode.VALIDATION_ERROR, '机器清单无效，或租金不是大于 0 的有效金额');
        inputById.set(itemId, roundMoney(price));
      }
      const rentalType = orderItems[0].rentalType === 'month' ? 'month' : 'day';
      if (orderItems.some(item => item.rentalType !== rentalType)) return jsonError(ErrorCode.VALIDATION_ERROR, '订单计费单位不一致，无法统一更正');
      const duration = calculateRentalDuration(rentalStartDate, rentalEndDate, rentalType);
      if (!duration) return jsonError(ErrorCode.VALIDATION_ERROR, '结束日期必须晚于开始日期，并且至少达到一个完整计费单位');
      const unchanged = orderItems.every(item => item.rentalStartDate === rentalStartDate && item.rentalEndDate === rentalEndDate &&
        roundMoney(Number(item.rentalUnitPrice)) === (inputById.get(item.id) ?? roundMoney(Number(item.rentalUnitPrice))) &&
        Number(item.rentalDuration) === duration &&
        roundMoney(Number(item.rentalTotalPrice)) === roundMoney((inputById.get(item.id) ?? Number(item.rentalUnitPrice)) * duration));
      if (unchanged) return jsonError(ErrorCode.VALIDATION_ERROR, '租赁条款没有变化');
      const priceCount = orderItems.filter(item => inputById.has(item.id) && roundMoney(Number(item.rentalUnitPrice)) !== inputById.get(item.id)).length;
      db.transaction(() => {
        for (const item of orderItems) {
          const unitPrice = inputById.get(item.id) ?? roundMoney(Number(item.rentalUnitPrice));
          const totalPrice = roundMoney(unitPrice * duration);
          if (db.prepare(`UPDATE rental_records SET rentalStartDate = ?, rentalEndDate = ?, rentalDuration = ?,
              rentalUnitPrice = ?, rentalTotalPrice = ?, updatedAt = ?
            WHERE id = ? AND status = 'renting' AND rentalStartDate = ? AND rentalEndDate = ?
              AND rentalUnitPrice = ? AND deleted = 0`).run(
            rentalStartDate, rentalEndDate, duration, unitPrice, totalPrice, now,
            item.id, item.rentalStartDate, item.rentalEndDate, item.rentalUnitPrice,
          ).changes !== 1) throw new Error('租赁条款已被其他操作修改，请刷新后重试');
          addRentalEvent({
            rentalRecordId: item.id, rentalOrderId: item.rentalOrderId, eventType: 'terms_corrected', note: reason,
            beforeData: { rentalStartDate: item.rentalStartDate, rentalEndDate: item.rentalEndDate, rentalType, rentalDuration: item.rentalDuration, rentalUnitPrice: item.rentalUnitPrice, rentalTotalPrice: item.rentalTotalPrice },
            afterData: { rentalStartDate, rentalEndDate, rentalType, rentalDuration: duration, rentalUnitPrice: unitPrice, rentalTotalPrice: totalPrice },
            actorId: user.id, createdAt: now,
          });
        }
        if (rentalOrderId && db.prepare(`UPDATE rental_orders SET rentalStartDate = ?, rentalEndDate = ?, updatedAt = ?
          WHERE id = ? AND rentalStartDate = ? AND rentalEndDate = ?`).run(
          rentalStartDate, rentalEndDate, now, rentalOrderId, orderItems[0].rentalStartDate, orderItems[0].rentalEndDate,
        ).changes !== 1) throw new Error('租赁订单日期已变化，请刷新后重试');
      })();
      return NextResponse.json(successResponse({ rentalOrderId, rentalStartDate, rentalEndDate, rentalDuration: duration, count: orderItems.length, priceCount }));
    }
    if (action === 'cancel_buyout') {
      if (rental.status !== 'purchased' || !rental.salesRecordId) return jsonError(ErrorCode.VALIDATION_ERROR, '这台机器没有可撤销的租赁买断记录');
      const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
      if (!reason || reason.length > 500) return jsonError(ErrorCode.VALIDATION_ERROR, '请填写买断撤销原因（最多 500 个字符）');
      const sale = db.prepare("SELECT id, status, transactionType FROM sales_records WHERE id = ?").get(rental.salesRecordId) as { id: string; status: string; transactionType: string } | undefined;
      if (!sale || sale.status !== 'completed' || sale.transactionType !== 'rental_buyout') return jsonError(ErrorCode.VALIDATION_ERROR, '买断销售记录状态已变化，无法撤销');
      const inventory = db.prepare('SELECT id, status, warehouseId FROM inventory WHERE id = ? AND deleted = 0').get(rental.inventoryId) as { id: string; status: string; warehouseId: string | null } | undefined;
      const lastMovement = db.prepare('SELECT movementType, referenceType, referenceId FROM inventory_movements WHERE inventoryId = ? ORDER BY rowid DESC LIMIT 1').get(rental.inventoryId) as { movementType: string; referenceType: string; referenceId: string } | undefined;
      if (!inventory || inventory.status !== 'sold' || !lastMovement || lastMovement.movementType !== 'sale' || lastMovement.referenceType !== 'sales_record' || lastMovement.referenceId !== sale.id) {
        return jsonError(ErrorCode.VALIDATION_ERROR, '机器买断后已有后续业务，不能撤销；请从当前库存状态继续处理');
      }
      if (db.prepare("SELECT 1 FROM after_sale_records WHERE salesRecordId = ? AND status <> 'cancelled' LIMIT 1").get(sale.id) ||
          db.prepare('SELECT 1 FROM return_receipts WHERE salesRecordId = ? LIMIT 1').get(sale.id)) {
        return jsonError(ErrorCode.VALIDATION_ERROR, '买断记录已有售后或退货凭证，不能直接撤销');
      }
      db.transaction(() => {
        if (db.prepare(`UPDATE inventory SET status = 'renting', rentalRecordId = ?, soldDate = NULL, sellingPrice = NULL,
          saleChannel = NULL, saleOrderNo = NULL, profit = NULL, updatedAt = ? WHERE id = ? AND status = 'sold' AND deleted = 0`).run(id, now, rental.inventoryId).changes !== 1) {
          throw new Error('库存机器状态已变化，请刷新后重试');
        }
        if (db.prepare(`UPDATE rental_records SET status = 'renting', returnDate = NULL, returnType = NULL,
          sellingPrice = NULL, priceDifference = NULL, saleChannel = NULL, saleOrderNo = NULL, salesRecordId = NULL, updatedAt = ?
          WHERE id = ? AND status = 'purchased' AND salesRecordId = ? AND deleted = 0`).run(now, id, sale.id).changes !== 1) {
          throw new Error('租赁记录状态已变化，请刷新后重试');
        }
        db.prepare(`UPDATE sales_records SET status = 'cancelled', cancelledAt = ?, cancelledBy = ?, cancelReason = ?
          WHERE id = ? AND status = 'completed'`).run(now, user.id, reason, sale.id);
        db.prepare(`INSERT INTO inventory_movements
          (id, inventoryId, warehouseId, fromWarehouseId, toWarehouseId, movementType, quantity, referenceType, referenceId, actorId, note, statusFrom, statusTo, createdAt)
          VALUES (?, ?, ?, ?, ?, 'sale_cancel', 1, 'sales_record', ?, ?, ?, 'sold', 'renting', ?)`)
          .run(generateId('movement'), rental.inventoryId, inventory?.warehouseId || 'warehouse_main', inventory?.warehouseId || 'warehouse_main', inventory?.warehouseId || 'warehouse_main', sale.id, user.id, reason, now);
        if (rental.rentalOrderId) {
          const latest = db.prepare("SELECT MAX(rentalEndDate) AS rentalEndDate FROM rental_records WHERE rentalOrderId = ? AND status = 'renting' AND deleted = 0").get(rental.rentalOrderId) as { rentalEndDate: string | null };
          if (latest.rentalEndDate) db.prepare('UPDATE rental_orders SET rentalEndDate = ?, updatedAt = ? WHERE id = ?').run(latest.rentalEndDate, now, rental.rentalOrderId);
        }
        addRentalEvent({ rentalRecordId: id, rentalOrderId: rental.rentalOrderId, eventType: 'buyout_reversed', note: reason,
          beforeData: { status: 'purchased', salesRecordId: sale.id }, afterData: { status: 'renting' }, actorId: user.id, createdAt: now });
      })();
      return NextResponse.json(successResponse({ id, status: 'renting', reversedSalesRecordId: sale.id }));
    }
    if (rental.status !== 'renting' && ['return', 'buyout', 'exception'].includes(action)) {
      return jsonError(ErrorCode.VALIDATION_ERROR, '这台机器已结束租赁，不能继续办理当前操作');
    }
    if (rental.status === 'renting' && (rental.inventoryStatus !== 'renting' || rental.rentalRecordId !== id)) {
      return jsonError(ErrorCode.VALIDATION_ERROR, '库存机器的租赁关联已变化，请刷新后重试');
    }

    if (action === 'exception') {
      const note = typeof body.note === 'string' ? body.note.trim() : '';
      if (!note || note.length > 1000) return jsonError(ErrorCode.VALIDATION_ERROR, '请填写异常跟进说明（最多 1000 个字符）');
      db.transaction(() => {
        addRentalEvent({ rentalRecordId: id, rentalOrderId: rental.rentalOrderId, eventType: 'exception_followup', note, beforeData: { status: rental.status, rentalEndDate: rental.rentalEndDate }, afterData: { status: rental.status, followUp: note }, actorId: user.id, createdAt: now });
      })();
      return NextResponse.json(successResponse({ id, status: 'renting', followUp: note, createdAt: now }));
    }

    if (action === 'buyout') {
      const saleDate = typeof body.saleDate === 'string' && body.saleDate.trim() ? body.saleDate.trim() : now.slice(0, 10);
      const sellingPrice = typeof body.sellingPrice === 'number' ? body.sellingPrice : typeof body.sellingPrice === 'string' && body.sellingPrice.trim() ? Number(body.sellingPrice) : NaN;
      const buyerName = typeof body.buyerName === 'string' ? body.buyerName.trim() : rental.customerName;
      const buyoutSource = typeof body.buyoutSource === 'string' ? body.buyoutSource.trim() : '';
      const requestedSaleOrderNo = typeof body.saleOrderNo === 'string' ? body.saleOrderNo.trim() : '';
      if (!validDate(saleDate) || saleDate < rental.rentalStartDate) return jsonError(ErrorCode.VALIDATION_ERROR, '买断日期不能早于租赁开始日期');
      if (!Number.isFinite(sellingPrice) || sellingPrice < 0) return jsonError(ErrorCode.VALIDATION_ERROR, '买断价格必须是大于或等于 0 的金额');
      if (!buyerName || buyerName.length > 120) return jsonError(ErrorCode.VALIDATION_ERROR, '请填写买断方（最多 120 个字符）');
      if (!buyoutSource || buyoutSource.length > 100) return jsonError(ErrorCode.VALIDATION_ERROR, '请填写买断来源/渠道（最多 100 个字符）');
      if (requestedSaleOrderNo.length > 100) return jsonError(ErrorCode.VALIDATION_ERROR, '销售订单号不能超过 100 个字符');
      const depositRefundAmount = roundMoney(Number(body.depositRefundAmount ?? rental.deposit));
      const depositAppliedAmount = roundMoney(Number(body.depositAppliedAmount ?? 0));
      const depositRetainedAmount = roundMoney(Number(body.depositRetainedAmount ?? 0));
      const settlementAdjustment = roundMoney(Number(body.settlementAdjustment ?? 0));
      const settlementNote = typeof body.settlementNote === 'string' ? body.settlementNote.trim() : '';
      const currentDeposit = roundMoney(Number(rental.deposit || 0));
      if (![depositRefundAmount, depositAppliedAmount, depositRetainedAmount, settlementAdjustment].every(Number.isFinite) ||
          [depositRefundAmount, depositAppliedAmount, depositRetainedAmount].some(value => value < 0)) {
        return jsonError(ErrorCode.VALIDATION_ERROR, '押金结算金额无效');
      }
      if (roundMoney(depositRefundAmount + depositAppliedAmount + depositRetainedAmount) !== currentDeposit) {
        return jsonError(ErrorCode.VALIDATION_ERROR, `押金结算必须分配完整，当前押金为 ${currentDeposit.toFixed(2)} 元`);
      }
      if (settlementNote.length > 500) return jsonError(ErrorCode.VALIDATION_ERROR, '结算说明最多 500 个字符');
      if ((depositRetainedAmount > 0 || settlementAdjustment !== 0 || sellingPrice === 0) && !settlementNote) {
        return jsonError(ErrorCode.VALIDATION_ERROR, '留存押金、调整应收或零元买断时，请填写结算说明');
      }
      const netDue = roundMoney(sellingPrice + settlementAdjustment - depositAppliedAmount);
      const saleOrderNo = requestedSaleOrderNo || `ZLMB-${rental.displayRentalNo}-${id.slice(-8)}`;
      const salesRecordId = generateId('sale');
      const recordNo = nextSaleRecordNo(saleDate);
      const sellingProfit = sellingPrice - Number(rental.purchasePrice);
      const itemSnapshot = {
        inventoryId: rental.inventoryId, sn: rental.sn, productType: rental.productType,
        brand: rental.brand, model: rental.model, year: rental.year, cpu: rental.cpu, ram: rental.ram,
        gpu: rental.gpu, storage: rental.storage, screen: rental.screen, touchScreen: rental.touchScreen,
        warehouseId: rental.warehouseId, purchasePrice: Number(rental.purchasePrice), sellingPrice,
        profit: sellingProfit, remark: `租赁买断 · ${rental.displayRentalNo}`, rentalRecordId: id,
        transactionType: 'rental_buyout', buyoutBuyerName: buyerName, buyoutSource,
        depositRefundAmount, depositAppliedAmount, depositRetainedAmount, settlementAdjustment, settlementNote: settlementNote || null,
      };
      db.transaction(() => {
        const current = db.prepare("SELECT status, rentalEndDate, rentalTotalPrice, deposit FROM rental_records WHERE id = ? AND status = 'renting' AND deleted = 0").get(id) as { status: string; rentalEndDate: string; rentalTotalPrice: number; deposit: number } | undefined;
        const inventory = db.prepare("SELECT status, rentalRecordId FROM inventory WHERE id = ? AND deleted = 0").get(rental.inventoryId) as { status: string; rentalRecordId: string | null } | undefined;
        if (!current || roundMoney(Number(current.deposit || 0)) !== currentDeposit || !inventory || inventory.status !== 'renting' || inventory.rentalRecordId !== id) throw new Error('租赁或库存状态已变化，请刷新后重试');
        db.prepare(`INSERT INTO sales_records
          (id, recordNo, saleChannel, saleOrderNo, saleDate, items, totalQuantity, totalCost, totalAmount, totalProfit, status, remark, deleted, createdBy, createdAt,
           transactionType, buyoutBuyerName, buyoutSource, depositRefundAmount, depositAppliedAmount, depositRetainedAmount, settlementAdjustment, settlementNote)
          VALUES (?, ?, '租赁买断', ?, ?, ?, 1, ?, ?, ?, 'completed', ?, 0, ?, ?, 'rental_buyout', ?, ?, ?, ?, ?, ?, ?)`)
          .run(salesRecordId, recordNo, saleOrderNo, saleDate, JSON.stringify([itemSnapshot]), Number(rental.purchasePrice), sellingPrice, sellingProfit, `租赁买断 · ${rental.displayRentalNo}`, user.id, now,
            buyerName, buyoutSource, depositRefundAmount, depositAppliedAmount, depositRetainedAmount, settlementAdjustment, settlementNote || null);
        db.prepare(`INSERT INTO sales_record_items
          (id, salesRecordId, saleRecordId, inventoryId, sn, purchasePrice, sellingPrice, profit, warehouseId, snapshot, remark, createdAt)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(generateId('sale_item'), salesRecordId, salesRecordId, rental.inventoryId, rental.sn, Number(rental.purchasePrice), sellingPrice, sellingProfit, rental.warehouseId, JSON.stringify(itemSnapshot), `租赁买断 · ${rental.displayRentalNo}`, now);
        const updateInventory = db.prepare(`UPDATE inventory SET status = 'sold', rentalRecordId = NULL, soldDate = ?, sellingPrice = ?,
          saleChannel = ?, saleOrderNo = ?, profit = ?, updatedAt = ?
          WHERE id = ? AND status = 'renting' AND rentalRecordId = ? AND deleted = 0`);
        if (updateInventory.run(saleDate, sellingPrice, '租赁买断', saleOrderNo, sellingProfit, now, rental.inventoryId, id).changes !== 1) throw new Error('库存机器状态已变化，请刷新后重试');
        const updateRental = db.prepare(`UPDATE rental_records SET status = 'purchased', returnDate = ?, returnType = '客户买断',
          sellingPrice = ?, priceDifference = ?, saleChannel = ?, saleOrderNo = ?, salesRecordId = ?, updatedAt = ?
          WHERE id = ? AND status = 'renting' AND deleted = 0`);
        if (updateRental.run(saleDate, sellingPrice, sellingProfit, '租赁买断', saleOrderNo, salesRecordId, now, id).changes !== 1) throw new Error('租赁记录状态已变化，请刷新后重试');
        db.prepare(`INSERT INTO inventory_movements
          (id, inventoryId, warehouseId, fromWarehouseId, movementType, quantity, referenceType, referenceId, actorId, note, statusFrom, statusTo, snapshot, createdAt)
          VALUES (?, ?, ?, ?, 'sale', 1, 'sales_record', ?, ?, ?, 'renting', 'sold', ?, ?)`)
          .run(generateId('movement'), rental.inventoryId, rental.warehouseId, rental.warehouseId, salesRecordId, user.id, `租赁买断 · ${saleOrderNo}`, JSON.stringify(itemSnapshot), now);
        addRentalEvent({ rentalRecordId: id, rentalOrderId: rental.rentalOrderId, eventType: 'buyout', note: `客户买断 · ${saleOrderNo} · ${sellingPrice}`, beforeData: { status: rental.status, rentalEndDate: current.rentalEndDate, rentalTotalPrice: current.rentalTotalPrice, deposit: current.deposit }, afterData: { status: 'purchased', saleDate, sellingPrice, buyoutBuyerName: buyerName, buyoutSource, saleOrderNo, salesRecordId, depositRefundAmount, depositAppliedAmount, depositRetainedAmount, settlementAdjustment, netDue }, actorId: user.id, createdAt: now });
      })();
      return NextResponse.json(successResponse({ id, status: 'purchased', salesRecordId, recordNo, saleDate, sellingPrice, saleChannel: '租赁买断', buyoutBuyerName: buyerName, buyoutSource, saleOrderNo, netDue, depositRefundAmount }));
    }

    if (action !== 'return') return jsonError(ErrorCode.VALIDATION_ERROR, '不支持的租赁操作');
    const returnDate = typeof body.returnDate === 'string' && body.returnDate.trim() ? body.returnDate.trim() : now.slice(0, 10);
    const returnType = String(body.returnType || '正常归还').trim();
    if (!validDate(returnDate) || returnDate < rental.rentalStartDate) return jsonError(ErrorCode.VALIDATION_ERROR, '归还日期不能早于租赁开始日期');
    db.transaction(() => {
      const updateInventory = db.prepare("UPDATE inventory SET status = 'in_stock', rentalRecordId = NULL, updatedAt = ? WHERE id = ? AND status = 'renting' AND rentalRecordId = ? AND deleted = 0");
      if (updateInventory.run(now, rental.inventoryId, id).changes !== 1) throw new Error('库存状态已发生变化，请刷新后重试');
      const updateRental = db.prepare("UPDATE rental_records SET status = 'returned', returnDate = ?, returnType = ?, updatedAt = ? WHERE id = ? AND status = 'renting' AND deleted = 0");
      if (updateRental.run(returnDate, returnType, now, id).changes !== 1) throw new Error('租赁记录状态已发生变化，请刷新后重试');
      addRentalMovement(rental.inventoryId, id, 'rental_return', user.id, '租赁归还入库', now);
      addRentalEvent({ rentalRecordId: id, rentalOrderId: rental.rentalOrderId, eventType: 'returned', note: returnType, beforeData: { status: rental.status }, afterData: { status: 'returned', returnDate, returnType }, actorId: user.id, createdAt: now });
    })();
    return NextResponse.json(successResponse({ id, status: 'returned', returnDate }));
  } catch (error) {
    const response = authError(error); if (response) return response;
    const message = messageOf(error, '处理租赁操作失败');
    const validation = /已经结束|已结束|不能续租|状态已变化|状态已发生变化|已发生变化|不能继续办理|无效|必须|不能为空|不能超过|不存在|请选择|请填写|早于|晚于|租赁记录已发生变化|库存机器状态已变化/.test(message);
    return NextResponse.json(errorResponse(validation ? ErrorCode.VALIDATION_ERROR : ErrorCode.DATABASE_ERROR, message), { status: validation ? 400 : 500 });
  }
}
