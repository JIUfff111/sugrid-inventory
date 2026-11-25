import { assertInventoryOperationEligible, endCustomStatus, inventoryOperationEligibleSql, serializeInventoryStatus } from '@/lib/inventory-status';
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
import {
  getRentalMachineDetail,
  getRentalOrderDetail,
  getRentalWorkspace,
  legacyRentalRowsSelect,
  parseRentalWorkspaceParams,
  serializeRentalDetails,
} from '@/lib/rental-workspace';
import { addRentalDays, calculateRentalDuration, isValidRentalDate, normalizeRentalPricingMode } from '@/lib/rental-duration';

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

function roundMoney(value: number) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function parseFixedRentalAmount(value: unknown) {
  if (typeof value !== 'number' && (typeof value !== 'string' || !value.trim())) return NaN;
  const amount = Number(value);
  return Number.isSafeInteger(Math.round(amount * 100)) && roundMoney(amount) === amount ? amount : NaN;
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
  const batchId = generateId('renewal_batch');
  const now = formatDateTime();
  return db.transaction(() => {
    const getRental = db.prepare(`SELECT r.id, r.rentalOrderId, r.sn, r.status,
      r.rentalEndDate, r.rentalType, r.rentalUnitPrice, r.rentalTotalPrice, r.deposit,
      i.status AS inventoryStatus, i.rentalRecordId
      FROM rental_records r JOIN inventory i ON i.id = r.inventoryId
      WHERE r.id = ? AND r.deleted = 0 AND i.deleted = 0`);
    const items = inputs.map(input => {
      const id = input.id.trim();
      const newEndDate = input.newEndDate.trim();
      const rental = getRental.get(id) as {
        id: string; rentalOrderId: string | null; sn: string; status: string;
        rentalEndDate: string; rentalType: string; rentalUnitPrice: number;
        rentalTotalPrice: number; deposit: number; inventoryStatus: string; rentalRecordId: string | null;
      } | undefined;
      if (!rental) throw new Error(`租赁机器 ${id} 不存在`);
      if (rental.status !== 'renting') throw new Error(`SN [${rental.sn}] 已结束租赁，不能续租`);
      if (rental.inventoryStatus !== 'renting' || rental.rentalRecordId !== id) throw new Error(`SN [${rental.sn}] 的库存租赁关联已变化，请刷新后重试`);
      const periodStartDate = addRentalDays(rental.rentalEndDate, 1);
      if (!periodStartDate || !isValidRentalDate(newEndDate) || newEndDate < periodStartDate) {
        throw new Error(`SN [${rental.sn}] 的新到期日必须晚于有效的当前到期日`);
      }
      const originalBillingUnit = normalizeRentalPricingMode(rental.rentalType) ?? 'day';
      const billingUnit = normalizeRentalPricingMode(input.billingUnit) ?? originalBillingUnit;
      const fixed = billingUnit === 'fixed';
      const duration = fixed ? 0 : calculateRentalDuration(rental.rentalEndDate, newEndDate, billingUnit);
      if (!fixed && !duration) throw new Error(`SN [${rental.sn}] 的续租日期无效`);
      const priceMode = input.priceMode === 'custom_unit' || input.priceMode === 'custom_total' ? input.priceMode : 'original_unit';
      if (originalBillingUnit === 'fixed' && priceMode === 'original_unit') throw new Error(`SN [${rental.sn}] 的原租金为固定总额，请填写本次续租金额`);
      if (fixed && priceMode !== 'custom_total') throw new Error(`SN [${rental.sn}] 的固定总额续租必须填写本次租金`);

      const rawUnitPrice = input.unitPrice === undefined || input.unitPrice === null || String(input.unitPrice).trim() === ''
        ? NaN : Number(input.unitPrice);
      const rawTotal = fixed ? parseFixedRentalAmount(input.totalAmount)
        : input.totalAmount === undefined || input.totalAmount === null || String(input.totalAmount).trim() === ''
          ? NaN : Number(input.totalAmount);
      if (priceMode === 'custom_unit' && (!Number.isFinite(rawUnitPrice) || rawUnitPrice < 0)) throw new Error(`SN [${rental.sn}] 的续租单价无效`);
      if (priceMode === 'custom_total' && (!Number.isFinite(rawTotal) || rawTotal < 0)) throw new Error(`SN [${rental.sn}] 的续租总额无效`);
      let unitPrice = 0;
      if (!fixed) {
        if (priceMode === 'custom_unit') unitPrice = roundMoney(rawUnitPrice);
        else if (priceMode === 'custom_total') unitPrice = roundMoney(rawTotal / duration);
        else unitPrice = roundMoney(rental.rentalUnitPrice);
      }
      const totalAmount = roundMoney(priceMode === 'custom_total' ? rawTotal : unitPrice * duration);
      const depositDelta = roundMoney(Number(input.depositDelta ?? 0));
      if (!Number.isFinite(depositDelta)) throw new Error(`SN [${rental.sn}] 的押金调整金额无效`);
      const depositBefore = roundMoney(Number(rental.deposit || 0));
      const depositAfter = roundMoney(depositBefore + depositDelta);
      if (depositAfter < 0) throw new Error(`SN [${rental.sn}] 的押金退还金额不能超过现有押金`);
      const depositChangeReason = String(input.depositChangeReason || '').trim();
      if (depositDelta !== 0 && !depositChangeReason) throw new Error(`请填写 SN [${rental.sn}] 的押金调整原因`);
      const note = typeof input.note === 'string' ? input.note.trim() : '';
      if (note.length > 1000 || depositChangeReason.length > 500) throw new Error('续租备注不能超过 1000 个字符，押金调整原因不能超过 500 个字符');
      if (totalAmount === 0 && !note) throw new Error(`SN [${rental.sn}] 的本次租金为 0，请填写原因`);
      return { rental, newEndDate, periodStartDate, billingUnit, duration, priceMode, unitPrice, totalAmount, depositDelta, depositBefore, depositAfter, depositChangeReason, note };
    });
    const insert = db.prepare(`INSERT INTO rental_renewals (
      id, batchId, rentalRecordId, rentalOrderId, periodStartDate, previousEndDate, newEndDate,
      billingUnit, duration, priceMode, unitPrice, totalAmount, depositBefore, depositDelta,
      depositAfter, depositChangeReason, note, actorId, createdAt
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const updateRental = db.prepare(`UPDATE rental_records SET rentalEndDate = ?, deposit = ?, updatedAt = ?
      WHERE id = ? AND status = 'renting' AND rentalEndDate = ? AND deleted = 0`);
    for (const item of items) {
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
    const orderIds = [...new Set(items.map(item => item.rental.rentalOrderId).filter((value): value is string => Boolean(value)))];
    for (const orderId of orderIds) {
      const latest = db.prepare("SELECT MAX(rentalEndDate) AS rentalEndDate FROM rental_records WHERE rentalOrderId = ? AND status = 'renting' AND deleted = 0").get(orderId) as { rentalEndDate: string | null };
      if (latest.rentalEndDate) db.prepare('UPDATE rental_orders SET rentalEndDate = ?, updatedAt = ? WHERE id = ?').run(latest.rentalEndDate, now, orderId);
    }
    const sumRenewals = db.prepare('SELECT COALESCE(SUM(totalAmount), 0) AS total FROM rental_renewals WHERE rentalRecordId = ?');
    return {
      batchId,
      items: items.map(item => {
        const { total } = sumRenewals.get(item.rental.id) as { total: number };
        return {
          id: item.rental.id, sn: item.rental.sn, status: 'renting', rentalEndDate: item.newEndDate,
          renewalAmount: item.totalAmount,
          cumulativeRentalAmount: roundMoney(item.rental.rentalTotalPrice + total),
          deposit: item.depositAfter,
        };
      }),
    };
  }).immediate();
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
    const resource = searchParams.get('resource') || '';
    if (resource === 'workspace') {
      const params = parseRentalWorkspaceParams(searchParams);
      if (!params) return jsonError(ErrorCode.VALIDATION_ERROR, '租赁工作台筛选条件无效');
      return NextResponse.json(successResponse(getRentalWorkspace(params)));
    }
    if (resource === 'order-detail') {
      const orderKey = searchParams.get('orderKey')?.trim() || '';
      if (!orderKey) return jsonError(ErrorCode.VALIDATION_ERROR, '缺少租赁订单标识');
      const detail = getRentalOrderDetail(orderKey);
      return detail
        ? NextResponse.json(successResponse(detail))
        : jsonError(ErrorCode.NOT_FOUND, '租赁订单不存在', 404);
    }
    if (resource === 'machine-detail') {
      const id = searchParams.get('id')?.trim() || '';
      if (!id) return jsonError(ErrorCode.VALIDATION_ERROR, '缺少租赁记录标识');
      const detail = getRentalMachineDetail(id);
      return detail
        ? NextResponse.json(successResponse(detail))
        : jsonError(ErrorCode.NOT_FOUND, '租赁记录不存在', 404);
    }
    const { page, pageSize } = parsePaginationParams(searchParams);
    const search = searchParams.get('search')?.trim() || '';
    const status = searchParams.get('status')?.trim() || '';
    const dueDays = dueFilter(searchParams);

    if (resource === 'inventory') {
      const conditions = [inventoryOperationEligibleSql('rentals', 'i')];
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
      conditions.push('(r.rentalNo LIKE ? OR r.sn LIKE ? OR r.brand LIKE ? OR r.model LIKE ? OR CAST(i.year AS TEXT) LIKE ? OR r.customerName LIKE ? OR r.customerPhone LIKE ? OR ro.handlerName LIKE ? OR ro.salespersonName LIKE ? OR ro.platformName LIKE ? OR ro.platformOrderNo LIKE ?)');
      params.push(pattern, pattern, pattern, pattern, pattern, pattern, pattern, pattern, pattern, pattern, pattern);
    }
    const where = `WHERE ${conditions.join(' AND ')}`;
    const count = db.prepare(`SELECT COUNT(*) AS total FROM rental_records r LEFT JOIN inventory i ON i.id = r.inventoryId LEFT JOIN rental_orders ro ON ro.id = r.rentalOrderId ${where}`).get(...params) as { total: number };
    const safePage = Math.min(page, Math.max(1, Math.ceil(Number(count.total) / pageSize)));
    const rows = db.prepare(`${legacyRentalRowsSelect} ${where}
      ORDER BY r.rentalEndDate ASC, r.createdAt DESC LIMIT ? OFFSET ?`).all(...params, pageSize, (safePage - 1) * pageSize) as Array<RentalRow & { daysUntilDue: number | null }>;
    const withMovements = serializeRentalDetails(rows, true);
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
    const appendToOrderId = String(body.rentalOrderId || '').trim();
    const appendOrder = appendToOrderId
      ? db.prepare(`SELECT id, rentalNo, customerName, customerPhone, customerAddress, handlerUserId, handlerName, salespersonName,
        sourceType, platformName, platformOrderNo, rentalStartDate, rentalEndDate, rentalType, remark
        FROM rental_orders WHERE id = ?`).get(appendToOrderId) as {
          id: string; rentalNo: string; customerName: string; customerPhone: string; customerAddress: string;
          handlerUserId: string | null; handlerName: string | null; salespersonName: string | null; sourceType: string | null;
          platformName: string | null; platformOrderNo: string | null;
          rentalStartDate: string; rentalEndDate: string; rentalType: string; remark: string | null;
        } | undefined
      : undefined;
    if (appendToOrderId && !appendOrder) return jsonError(ErrorCode.NOT_FOUND, '租赁单不存在，无法追加机器', 404);
    const rentalType = normalizeRentalPricingMode(appendOrder ? appendOrder.rentalType : body.rentalType);
    if (!rentalType && (appendOrder || body.rentalType)) return jsonError(ErrorCode.VALIDATION_ERROR, '租赁计费方式无效');
    const billingMode = rentalType ?? 'day';
    if (appendOrder) {
      const activeItems = db.prepare(`SELECT DISTINCT rentalType FROM rental_records
        WHERE rentalOrderId = ? AND status = 'renting' AND deleted = 0`).all(appendOrder.id) as Array<{ rentalType: string }>;
      if (!activeItems.length) return jsonError(ErrorCode.VALIDATION_ERROR, '该租赁单已全部结束，请新建租赁单');
      if (activeItems.some(item => normalizeRentalPricingMode(item.rentalType) !== billingMode)) {
        return jsonError(ErrorCode.VALIDATION_ERROR, '该订单的在租机器计费方式不一致，暂不能追加机器');
      }
    }
    const rawItems = Array.isArray(body.items) ? body.items : Array.isArray(body.inventoryIds) ? body.inventoryIds.map(inventoryId => ({ inventoryId })) : body.inventoryId ? [{ inventoryId: body.inventoryId }] : [];
    const itemInputs = rawItems.map((item) => typeof item === 'string' ? { inventoryId: item } : item && typeof item === 'object' ? item as Record<string, unknown> : {});
    const inventoryIds = itemInputs.map(item => String(item.inventoryId || '').trim());
    if (!inventoryIds.length) return jsonError(ErrorCode.VALIDATION_ERROR, '请至少选择一台租赁机器');
    if (inventoryIds.length > 100) return jsonError(ErrorCode.VALIDATION_ERROR, '单次最多选择 100 台机器');
    if (inventoryIds.some(id => !id) || new Set(inventoryIds).size !== inventoryIds.length) return jsonError(ErrorCode.VALIDATION_ERROR, '机器选择无效或包含重复机器');
    const customerName = appendOrder?.customerName || String(body.customerName || '').trim();
    const customerPhone = appendOrder?.customerPhone || String(body.customerPhone || '').trim();
    const customerAddress = appendOrder?.customerAddress || String(body.customerAddress || '').trim();
    const handlerUserId = appendOrder ? appendOrder.handlerUserId : String(body.handlerUserId || '').trim();
    const salespersonName = appendOrder ? appendOrder.salespersonName || '' : String(body.salespersonName || '').trim();
    const sourceType = appendOrder ? appendOrder.sourceType || '' : String(body.sourceType || '').trim();
    const platformName = appendOrder ? appendOrder.platformName || '' : String(body.platformName || '').trim();
    const platformOrderNo = appendOrder ? appendOrder.platformOrderNo || '' : String(body.platformOrderNo || '').trim();
    const rentalStartDate = String(body.rentalStartDate || '').trim();
    const rentalEndDate = String(body.rentalEndDate || '').trim();
    if (!customerName || !customerPhone || !customerAddress || !rentalStartDate || !rentalEndDate) return jsonError(ErrorCode.VALIDATION_ERROR, '请填写完整的租赁和客户信息');
    let handlerName = appendOrder?.handlerName || '';
    if (!appendOrder) {
      if (!handlerUserId || !salespersonName) return jsonError(ErrorCode.VALIDATION_ERROR, '请确认经手账号并填写业务员');
      const handler = db.prepare(`SELECT COALESCE(NULLIF(TRIM(realName), ''), username) AS name FROM users
        WHERE id = ? AND status = 'active'`).get(handlerUserId) as { name: string } | undefined;
      if (!handler) return jsonError(ErrorCode.VALIDATION_ERROR, '经手账号不存在或已停用');
      handlerName = handler.name;
      if (salespersonName.length > 80) return jsonError(ErrorCode.VALIDATION_ERROR, '业务员姓名最多 80 个字符');
      if (sourceType !== 'online' && sourceType !== 'offline') return jsonError(ErrorCode.VALIDATION_ERROR, '请选择线上或线下租赁来源');
      if (sourceType === 'online' && (!platformName || !platformOrderNo)) return jsonError(ErrorCode.VALIDATION_ERROR, '线上租赁请填写平台和平台订单号');
      if (platformName.length > 100 || platformOrderNo.length > 120) return jsonError(ErrorCode.VALIDATION_ERROR, '平台或订单号内容过长');
    }
    if (!isValidRentalDate(rentalStartDate) || !isValidRentalDate(rentalEndDate) || rentalEndDate <= rentalStartDate) {
      return jsonError(ErrorCode.VALIDATION_ERROR, '结束日期必须晚于开始日期');
    }
    const duration = billingMode === 'fixed' ? 0 : calculateRentalDuration(rentalStartDate, rentalEndDate, billingMode);
    if (billingMode !== 'fixed' && !duration) {
      return jsonError(ErrorCode.VALIDATION_ERROR, '结束日期必须晚于开始日期，并且至少达到一个完整计费单位');
    }
    const lineInputs = itemInputs.map((item, index) => {
      const rentalUnitPrice = billingMode === 'fixed' ? 0 : Number(item.rentalUnitPrice ?? body.rentalUnitPrice);
      const rentalTotalPrice = billingMode === 'fixed'
        ? parseFixedRentalAmount(item.rentalTotalPrice ?? (inventoryIds.length === 1 ? body.rentalTotalPrice : undefined))
        : rentalUnitPrice * duration;
      return { inventoryId: inventoryIds[index], rentalUnitPrice, rentalTotalPrice, deposit: Number(item.deposit ?? body.deposit ?? 0) };
    });
    if (lineInputs.some(item => !Number.isFinite(item.rentalTotalPrice) || item.rentalTotalPrice <= 0)) {
      return jsonError(ErrorCode.VALIDATION_ERROR, billingMode === 'fixed' ? '请为每台机器填写大于 0 且最多保留两位小数的租金总额' : '请为每台机器填写有效的租赁单价');
    }
    if (lineInputs.some(item => !Number.isFinite(item.deposit) || item.deposit < 0)) return jsonError(ErrorCode.VALIDATION_ERROR, '每台机器的押金格式不正确');

    const inventoryById = new Map<string, InventoryRow>();
    for (const inventoryId of inventoryIds) {
      const inventory = db.prepare(`${inventorySelect} WHERE i.id = ? AND i.deleted = 0`).get(inventoryId) as InventoryRow | undefined;
      if (!inventory) return jsonError(ErrorCode.INVENTORY_NOT_FOUND, `未找到机器 ${inventoryId}`, 404);
      inventoryById.set(inventoryId, inventory);
    }
    const orderId = appendOrder?.id || generateId('rental_order');
    const now = formatDateTime();
    let no = appendOrder?.rentalNo ?? '';
    const orderTotal = lineInputs.reduce((sum, item) => sum + item.rentalTotalPrice, 0);
    const createdItems: Array<(typeof lineInputs)[number] & { id: string; rentalNo: string }> = [];
    const usedNumbers = new Set<string>();
    db.transaction(() => {
      let orderRemark = String(body.remark || '').trim() || null;
      let nextLineNumber = 1;
      if (appendOrder) {
        const currentOrder = db.prepare(`SELECT id, rentalNo, rentalStartDate, rentalEndDate, rentalType
          FROM rental_orders WHERE id = ?`).get(orderId) as { id: string; rentalNo: string; rentalStartDate: string; rentalEndDate: string; rentalType: string } | undefined;
        if (!currentOrder || currentOrder.rentalNo !== appendOrder.rentalNo || normalizeRentalPricingMode(currentOrder.rentalType) !== billingMode) throw new Error('租赁单信息已变化，请刷新后重试');
        const activeItems = db.prepare(`SELECT DISTINCT r.rentalType FROM rental_records r
          JOIN inventory i ON i.id = r.inventoryId
          WHERE r.rentalOrderId = ? AND r.status = 'renting' AND r.deleted = 0 AND i.deleted = 0
            AND i.status = 'renting' AND i.rentalRecordId = r.id`).all(orderId) as Array<{ rentalType: string }>;
        if (!activeItems.length) throw new Error('租赁单已结束，不能追加机器，请新建租赁单');
        if (activeItems.some(item => normalizeRentalPricingMode(item.rentalType) !== billingMode)) throw new Error('订单计费方式已变化，不能追加机器，请刷新后重试');
        const existingRows = db.prepare('SELECT rentalNo, remark FROM rental_records WHERE rentalOrderId = ? ORDER BY rowid').all(orderId) as Array<{ rentalNo: string; remark: string | null }>;
        existingRows.forEach(row => usedNumbers.add(row.rentalNo));
        nextLineNumber = existingRows.length + 1;
        if (!orderRemark) orderRemark = appendOrder.remark || existingRows.find(row => row.remark)?.remark || null;
        const startEnvelope = rentalStartDate < currentOrder.rentalStartDate ? rentalStartDate : currentOrder.rentalStartDate;
        const endEnvelope = rentalEndDate > currentOrder.rentalEndDate ? rentalEndDate : currentOrder.rentalEndDate;
        if (db.prepare(`UPDATE rental_orders SET rentalStartDate = ?, rentalEndDate = ?, updatedAt = ?
          WHERE id = ? AND rentalNo = ? AND rentalStartDate = ? AND rentalEndDate = ?`).run(
          startEnvelope, endEnvelope, now, orderId, currentOrder.rentalNo, currentOrder.rentalStartDate, currentOrder.rentalEndDate,
        ).changes !== 1) throw new Error('租赁单日期已变化，请刷新后重试');
      } else {
        no = rentalNo();
        db.prepare(`INSERT INTO rental_orders
          (id,rentalNo,customerName,customerPhone,customerAddress,handlerUserId,handlerName,salespersonName,sourceType,platformName,platformOrderNo,rentalStartDate,rentalEndDate,rentalType,remark,createdBy,createdAt,updatedAt)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(orderId,no,customerName,customerPhone,customerAddress,
          handlerUserId,handlerName,salespersonName,sourceType,sourceType === 'online' ? platformName : null,sourceType === 'online' ? platformOrderNo : null,
          rentalStartDate,rentalEndDate,billingMode,orderRemark,user.id,now,now);
      }
      const update = db.prepare("UPDATE inventory SET status = 'renting', rentalRecordId = ?, updatedAt = ? WHERE id = ? AND status IN ('in_stock','custom') AND deleted = 0");
      const insertRental = db.prepare(`INSERT INTO rental_records (
        id, rentalOrderId, rentalNo, inventoryId, sn, brand, model, config, purchasePrice,
        customerName, customerPhone, customerAddress, rentalStartDate, rentalEndDate,
        rentalType, rentalUnitPrice, rentalDuration, rentalTotalPrice, deposit,
        status, remark, deleted, createdBy, createdAt, updatedAt
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'renting', ?, 0, ?, ?, ?)`);
      for (const line of lineInputs) {
        assertInventoryOperationEligible(line.inventoryId, 'rentals');
        const inventory = inventoryById.get(line.inventoryId)!;
        const id = generateId('rental');
        const config = [inventory.cpu, inventory.ram, inventory.gpu, inventory.storage, inventory.screen].filter(Boolean).join(' / ') || '配置待补充';
        while (usedNumbers.has(`${no}-${String(nextLineNumber).padStart(2, '0')}`)) nextLineNumber++;
        const itemNo = `${no}-${String(nextLineNumber++).padStart(2, '0')}`;
        usedNumbers.add(itemNo);
        endCustomStatus(line.inventoryId,user.id,'租赁出库','rental',id,'renting');
        if (update.run(id, now, line.inventoryId).changes !== 1) throw new Error('机器状态已发生变化，请刷新后重试');
        insertRental.run(
          id, orderId, itemNo, inventory.id, inventory.sn, inventory.brand, inventory.model, config, inventory.purchasePrice,
          customerName, customerPhone, customerAddress, rentalStartDate, rentalEndDate,
          billingMode, line.rentalUnitPrice, duration, line.rentalTotalPrice, line.deposit,
          orderRemark, user.id, now, now,
        );
        addRentalMovement(line.inventoryId, id, 'rental_out', user.id, (appendOrder ? '追加租赁出库 · ' : '租赁出库 · ') + no, now);
        if (appendOrder) addRentalEvent({
          rentalRecordId: id, rentalOrderId: orderId, eventType: 'item_added', note: `追加至租赁单 ${no}`,
          afterData: { rentalNo: no, rentalStartDate, rentalEndDate, rentalType: billingMode, rentalUnitPrice: line.rentalUnitPrice, rentalDuration: duration, rentalTotalPrice: roundMoney(line.rentalTotalPrice) },
          actorId: user.id, createdAt: now,
        });
        createdItems.push({ ...line, id, rentalNo: itemNo });
      }
    }).immediate();
    return NextResponse.json(successResponse({ id: appendOrder ? orderId : createdItems.length === 1 ? createdItems[0].id : orderId, rentalOrderId: orderId, rentalNo: no, appended: Boolean(appendOrder), count: lineInputs.length, duration, totalPrice: billingMode === 'fixed' ? roundMoney(orderTotal) : orderTotal, items: createdItems }), { status: 201 });
  } catch (error) {
    const response = authError(error); if (response) return response;
    const message = messageOf(error,'创建租赁记录失败');
    const conflict = /不可参与在库业务|不可参与该项业务|状态已发生变化|租赁条款已被其他操作修改|租赁订单日期已变化|租赁单已结束|租赁单信息已变化|订单计费方式已变化|租赁单日期已变化/.test(message);
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
      const originalTerms = orderItems[0];
      const rentalType = normalizeRentalPricingMode(originalTerms.rentalType);
      if (!rentalType) return jsonError(ErrorCode.VALIDATION_ERROR, '租赁计费方式无效');
      if (orderItems.some(item => item.rentalStartDate !== originalTerms.rentalStartDate ||
        item.rentalEndDate !== originalTerms.rentalEndDate || normalizeRentalPricingMode(item.rentalType) !== rentalType)) {
        return jsonError(ErrorCode.VALIDATION_ERROR, '订单中的机器租期不同，不能整单更正；请分别处理各机器的租期');
      }
      if (orderItems.some(item => item.status !== 'renting' || item.inventoryStatus !== 'renting' || item.rentalRecordId !== item.id)) {
        return jsonError(ErrorCode.VALIDATION_ERROR, '订单中有机器已结束租赁或库存关联变化，不能更正原租赁条款');
      }
      if (orderItems.some(item => Number(item.renewalCount) > 0)) {
        return jsonError(ErrorCode.VALIDATION_ERROR, '订单已有续租记录，不能覆盖原条款；请通过续租或账务更正记录处理');
      }
      const rentalStartDate = String(body.rentalStartDate || '').trim();
      const rentalEndDate = String(body.rentalEndDate || '').trim();
      const reason = (typeof body.reason === 'string' ? body.reason.trim() : '') ||
        (typeof body.note === 'string' ? body.note.trim() : '');
      if (body.items !== undefined && !Array.isArray(body.items)) return jsonError(ErrorCode.VALIDATION_ERROR, '机器清单无效');
      const inputs = Array.isArray(body.items) ? body.items : [];
      if (!isValidRentalDate(rentalStartDate) || !isValidRentalDate(rentalEndDate) || rentalEndDate <= rentalStartDate) {
        return jsonError(ErrorCode.VALIDATION_ERROR, '请选择有效的租赁起止日期，结束日期必须晚于开始日期');
      }
      if (!reason || reason.length > 500) return jsonError(ErrorCode.VALIDATION_ERROR, '请填写更正原因（最多 500 个字符）');
      if (inputs.length > 100) return jsonError(ErrorCode.VALIDATION_ERROR, '单次最多更正 100 台');
      const fixed = rentalType === 'fixed';
      const duration = fixed ? 0 : calculateRentalDuration(rentalStartDate, rentalEndDate, rentalType);
      if (!fixed && !duration) return jsonError(ErrorCode.VALIDATION_ERROR, '结束日期必须晚于开始日期，并且至少达到一个完整计费单位');
      const orderItemIds = new Set(orderItems.map(item => item.id));
      const inputById = new Map<string, number>();
      for (const value of inputs) {
        const item = value && typeof value === 'object' ? value as Record<string, unknown> : {};
        const itemId = String(item.id || '').trim();
        const price = fixed ? parseFixedRentalAmount(item.rentalTotalPrice) : roundMoney(Number(item.rentalUnitPrice));
        if (!orderItemIds.has(itemId) || inputById.has(itemId) || !Number.isFinite(price) || price <= 0) {
          return jsonError(ErrorCode.VALIDATION_ERROR, fixed ? '机器清单无效，或租金总额未填写为大于 0 且最多两位小数的金额' : '机器清单无效，或租金不是大于 0 的有效金额');
        }
        inputById.set(itemId, price);
      }
      const updates = orderItems.map(item => {
        const enteredPrice = inputById.get(item.id);
        const oldUnitPrice = roundMoney(item.rentalUnitPrice);
        const unitPrice = fixed ? 0 : enteredPrice ?? oldUnitPrice;
        const totalPrice = fixed ? enteredPrice ?? item.rentalTotalPrice : roundMoney(unitPrice * duration);
        const priceChanged = enteredPrice !== undefined && enteredPrice !== (fixed ? item.rentalTotalPrice : oldUnitPrice);
        return { item, unitPrice, totalPrice, priceChanged };
      });
      const datesChanged = rentalStartDate !== originalTerms.rentalStartDate || rentalEndDate !== originalTerms.rentalEndDate;
      if (!datesChanged && updates.every(({ item, unitPrice, totalPrice, priceChanged }) => !priceChanged &&
        roundMoney(item.rentalUnitPrice) === unitPrice && item.rentalDuration === duration &&
        (fixed ? item.rentalTotalPrice : roundMoney(item.rentalTotalPrice)) === totalPrice)) {
        return jsonError(ErrorCode.VALIDATION_ERROR, '租赁条款没有变化');
      }
      const priceCount = updates.filter(item => item.priceChanged).length;
      db.transaction(() => {
        if (rentalOrderId) {
          const { count } = db.prepare('SELECT COUNT(*) AS count FROM rental_records WHERE rentalOrderId = ? AND deleted = 0').get(rentalOrderId) as { count: number };
          if (count !== orderItems.length) throw new Error('租赁条款已被其他操作修改，请刷新后重试');
        }
        const updateRental = db.prepare(`UPDATE rental_records SET rentalStartDate = ?, rentalEndDate = ?, rentalDuration = ?,
            rentalUnitPrice = ?, rentalTotalPrice = ?, updatedAt = ?
          WHERE id = ? AND status = 'renting' AND rentalStartDate = ? AND rentalEndDate = ? AND rentalType = ?
            AND rentalUnitPrice = ? AND rentalTotalPrice = ? AND rentalDuration = ? AND deleted = 0
            AND EXISTS (SELECT 1 FROM inventory i WHERE i.id = rental_records.inventoryId AND i.deleted = 0
              AND i.status = 'renting' AND i.rentalRecordId = rental_records.id)
            AND NOT EXISTS (SELECT 1 FROM rental_renewals rr WHERE rr.rentalRecordId = rental_records.id)`);
        for (const { item, unitPrice, totalPrice } of updates) {
          if (updateRental.run(
            rentalStartDate, rentalEndDate, duration, unitPrice, totalPrice, now,
            item.id, item.rentalStartDate, item.rentalEndDate, item.rentalType, item.rentalUnitPrice, item.rentalTotalPrice, item.rentalDuration,
          ).changes !== 1) throw new Error('租赁条款已被其他操作修改，请刷新后重试');
          addRentalEvent({
            rentalRecordId: item.id, rentalOrderId: item.rentalOrderId, eventType: 'terms_corrected', note: reason,
            beforeData: { rentalStartDate: item.rentalStartDate, rentalEndDate: item.rentalEndDate, rentalType: item.rentalType, rentalDuration: item.rentalDuration, rentalUnitPrice: item.rentalUnitPrice, rentalTotalPrice: item.rentalTotalPrice },
            afterData: { rentalStartDate, rentalEndDate, rentalType: item.rentalType, rentalDuration: duration, rentalUnitPrice: unitPrice, rentalTotalPrice: totalPrice },
            actorId: user.id, createdAt: now,
          });
        }
        if (rentalOrderId && db.prepare(`UPDATE rental_orders SET rentalStartDate = ?, rentalEndDate = ?, updatedAt = ?
          WHERE id = ? AND rentalStartDate = ? AND rentalEndDate = ?`).run(
          rentalStartDate, rentalEndDate, now, rentalOrderId, orderItems[0].rentalStartDate, orderItems[0].rentalEndDate,
        ).changes !== 1) throw new Error('租赁订单日期已变化，请刷新后重试');
      }).immediate();
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
    const returnWarehouseId = String(body.returnWarehouseId || '').trim();
    if (!returnWarehouseId) return jsonError(ErrorCode.VALIDATION_ERROR, '请选择实际接收仓库');
    const returnWarehouse = db.prepare("SELECT id FROM warehouses WHERE id = ? AND status = 'active'").get(returnWarehouseId);
    if (!returnWarehouse) return jsonError(ErrorCode.VALIDATION_ERROR, '接收仓库不存在或已停用');
    db.transaction(() => {
      const updateInventory = db.prepare("UPDATE inventory SET status = 'in_stock', warehouseId = ?, rentalRecordId = NULL, updatedAt = ? WHERE id = ? AND status = 'renting' AND rentalRecordId = ? AND deleted = 0");
      if (updateInventory.run(returnWarehouseId, now, rental.inventoryId, id).changes !== 1) throw new Error('库存状态已发生变化，请刷新后重试');
      const updateRental = db.prepare("UPDATE rental_records SET status = 'returned', returnDate = ?, returnType = ?, updatedAt = ? WHERE id = ? AND status = 'renting' AND deleted = 0");
      if (updateRental.run(returnDate, returnType, now, id).changes !== 1) throw new Error('租赁记录状态已发生变化，请刷新后重试');
      db.prepare(`INSERT INTO inventory_movements
        (id, inventoryId, warehouseId, fromWarehouseId, toWarehouseId, movementType, quantity, referenceType, referenceId, actorId, note, statusFrom, statusTo, createdAt)
        VALUES (?, ?, ?, ?, ?, 'rental_return', 1, 'rental', ?, ?, ?, 'renting', 'in_stock', ?)`)
        .run(generateId('movement'), rental.inventoryId, returnWarehouseId, rental.warehouseId, returnWarehouseId, id, user.id, '租赁归还入库', now);
      addRentalEvent({ rentalRecordId: id, rentalOrderId: rental.rentalOrderId, eventType: 'returned', note: returnType, beforeData: { status: rental.status, warehouseId: rental.warehouseId }, afterData: { status: 'returned', returnDate, returnType, warehouseId: returnWarehouseId }, actorId: user.id, createdAt: now });
    })();
    return NextResponse.json(successResponse({ id, sn: rental.sn, status: 'returned', returnDate, warehouseId: returnWarehouseId }));
  } catch (error) {
    const response = authError(error); if (response) return response;
    const message = messageOf(error, '处理租赁操作失败');
    const validation = /已经结束|已结束|不能续租|已变化|已发生变化|已被其他操作修改|不能继续办理|无效|必须|不能为空|不能超过|不存在|请选择|请填写|早于|晚于/.test(message);
    return NextResponse.json(errorResponse(validation ? ErrorCode.VALIDATION_ERROR : ErrorCode.DATABASE_ERROR, message), { status: validation ? 400 : 500 });
  }
}
