import { assertInventoryOperationEligible, endCustomStatus, warehouseStockSql } from '@/lib/inventory-status';
import { NextRequest, NextResponse } from 'next/server';
import db from '@/lib/db';
import { createPaginatedResponse, errorResponse, ErrorCode, formatDateTime, generateId, parsePaginationParams, successResponse } from '@/lib/api-helpers';
import { AuthError, requireRole } from '@/lib/auth';
import { matchesMachineScanSerial } from '@/lib/machine-scan';

type Row = Record<string, any>;
const authError = (error: unknown) => error instanceof AuthError ? NextResponse.json(errorResponse(error.code, error.message), { status: error.status }) : null;
const msg = (error: unknown, fallback: string) => error instanceof Error ? error.message : fallback;
const bad = (message: string) => NextResponse.json(errorResponse(ErrorCode.VALIDATION_ERROR, message), { status: 400 });
const queueConditions = {
  active: "a.status IN ('created', 'received', 'processing')",
  other_active: "a.resolutionType <> 'exchange' AND a.status IN ('created', 'received', 'processing')",
  created: "a.status = 'created'",
  received: "a.status = 'received'",
  processing: "a.status = 'processing'",
  stored: "s.stockStatus = 'stored'",
  resolved: "a.status = 'resolved'",
  cancelled: "a.status = 'cancelled'",
  exchange_receive: "a.resolutionType = 'exchange' AND a.status = 'created'",
  exchange_reserve: "a.resolutionType = 'exchange' AND a.status IN ('received', 'processing') AND a.reservedReplacementId IS NULL",
  exchange_ship: "a.resolutionType = 'exchange' AND a.status = 'processing' AND a.reservedReplacementId IS NOT NULL",
  exchange_dispose: "a.resolutionType = 'exchange' AND a.status = 'resolved' AND s.stockStatus = 'stored'",
};
const queueFilters: Record<string, string> = {
  ...queueConditions,
  todo: `(${queueConditions.active} OR (${queueConditions.exchange_dispose}))`,
};

function tableColumns(table: string) {
  try { return new Set((db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((column) => column.name)); }
  catch { return new Set<string>(); }
}
function tableExists(table: string) { return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)); }
function insertDynamic(table: string, values: Record<string, unknown>) {
  if (!tableExists(table)) return;
  const available = tableColumns(table);
  const entries = Object.entries(values).filter(([name]) => available.has(name));
  if (!entries.length) return;
  const names = entries.map(([name]) => name);
  db.prepare(`INSERT INTO ${table} (${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')})`).run(...entries.map(([, value]) => value));
}
function inventory(id: string) { return db.prepare('SELECT i.*, po.purchaseNo FROM inventory i LEFT JOIN purchase_orders po ON po.id = i.purchaseOrderId WHERE i.id = ? AND i.deleted = 0').get(id) as Row | undefined; }
function nextAfterSaleNo(date: string) {
  const prefix = `AS${date.replace(/-/g, '')}`;
  const row = db.prepare('SELECT afterSaleNo FROM after_sale_records WHERE afterSaleNo LIKE ? ORDER BY afterSaleNo DESC LIMIT 1').get(`${prefix}%`) as { afterSaleNo: string } | undefined;
  return `${prefix}${String((row ? Number(row.afterSaleNo.slice(prefix.length)) : 0) + 1).padStart(3, '0')}`;
}
function nextReceiptNo(date: string) {
  const prefix = `SR${date.replace(/-/g, '')}`;
  const row = db.prepare('SELECT receiptNo FROM return_receipts WHERE receiptNo LIKE ? ORDER BY receiptNo DESC LIMIT 1').get(`${prefix}%`) as { receiptNo: string } | undefined;
  let sequence = row ? Number(row.receiptNo.slice(prefix.length)) + 1 : 1;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const receiptNo = `${prefix}${String(sequence).padStart(3, '0')}`;
    if (!db.prepare('SELECT 1 FROM return_receipts WHERE receiptNo = ?').get(receiptNo)) return receiptNo;
    sequence += 1;
  }
  throw new Error('退货入库单号生成失败');
}
function move(inventoryId: string, type: string, ref: string, actor: string, note: string | null, warehouseId?: string | null, fromWarehouseId?: string | null, toWarehouseId?: string | null) {
  insertDynamic('inventory_movements', {
    id: generateId('movement'), inventoryId, warehouseId: warehouseId || null,
    fromWarehouseId: fromWarehouseId || null, toWarehouseId: toWarehouseId || null,
    movementType: type, referenceType: 'after_sale', referenceId: ref, actorId: actor,
    note, createdAt: formatDateTime(),
  });
}
function normalizeTrackingNo(value: unknown) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new Error('寄回快递单号必须为文本');
  const trackingNo = value.trim();
  if (trackingNo.length > 100) throw new Error('寄回快递单号不能超过 100 个字符');
  return trackingNo || null;
}

function optionalText(value: unknown, label: string, maxLength: number) {
  if (value == null) return null;
  if (typeof value !== 'string') throw new Error(`${label}必须为文本`);
  const text = value.trim();
  if (text.length > maxLength) throw new Error(`${label}不能超过 ${maxLength} 个字符`);
  return text || null;
}

function getAfterSale(id: string) {
  return db.prepare('SELECT * FROM after_sale_records WHERE id = ? AND deleted = 0').get(id) as Row | undefined;
}

function getAfterSaleStock(id: string) {
  return db.prepare('SELECT * FROM after_sale_stock WHERE afterSaleId = ?').get(id) as Row | undefined;
}

function activeExchange(id: string, canStartFromReceived = false) {
  const record = getAfterSale(id);
  if (!record || record.resolutionType !== 'exchange'
    || (record.status !== 'processing' && !(canStartFromReceived && record.status === 'received'))) {
    throw new Error('当前售后单状态不能进行换货，请先确认收到原机');
  }
  const original = inventory(record.inventoryId);
  if (original?.status !== 'after_sale' || getAfterSaleStock(id)?.stockStatus !== 'stored') throw new Error('请先确认收到原机器且仍在售后暂存');
  return { record, original };
}

function checkExpectedReservation(body: Row, record: Row) {
  if (body.expectedReplacementInventoryId !== undefined && body.expectedReplacementInventoryId !== (record.reservedReplacementId ?? null)) {
    throw new Error('替换机器的预留状态已变化，请刷新后重试');
  }
}

function assertWarehouseReplacement(inventoryId: string) {
  const replacement = assertInventoryOperationEligible(inventoryId, 'sales');
  if (!db.prepare(`SELECT 1 FROM inventory i WHERE i.id = ? AND ${warehouseStockSql('i')}`).get(inventoryId)) {
    throw new Error('替换机器必须在仓内且可销售，外部寄卖或售后暂存不能作为替换机');
  }
  return replacement;
}

type SaleSource = {
  salesRecordId: string | null;
  recordNo: string | null;
  saleOrderNo: string | null;
  saleChannel: string | null;
  saleDate: string | null;
  sellingPrice: number;
  purchasePrice: number;
  profit: number;
  snapshot: Row | null;
};
function saleSource(inventoryId: string, item: Row): SaleSource {
  const sale = db.prepare(`SELECT sr.id, sr.recordNo, sr.saleOrderNo, sr.saleChannel, sr.saleDate, sr.items,
      sri.purchasePrice AS itemPurchasePrice, sri.sellingPrice AS itemSellingPrice, sri.profit AS itemProfit, sri.snapshot AS itemSnapshot
    FROM sales_record_items sri
    JOIN sales_records sr ON sr.id = sri.salesRecordId
    WHERE sri.inventoryId = ? AND sr.deleted = 0 AND COALESCE(sr.status, 'completed') = 'completed'
    ORDER BY sri.createdAt DESC, sr.createdAt DESC LIMIT 1`).get(inventoryId) as Row | undefined;
  let snapshot: Row | null = null;
  if (sale?.itemSnapshot) { try { snapshot = JSON.parse(sale.itemSnapshot) as Row; } catch { snapshot = null; } }
  if (!snapshot && sale?.items) {
    try {
      const items = JSON.parse(sale.items) as Row[];
      snapshot = items.find((entry) => entry.inventoryId === inventoryId) || null;
    } catch { snapshot = null; }
  }
  const sellingPrice = Number(sale?.itemSellingPrice ?? snapshot?.sellingPrice ?? item.sellingPrice ?? 0);
  const purchasePrice = Number(sale?.itemPurchasePrice ?? snapshot?.purchasePrice ?? item.purchasePrice ?? 0);
  return {
    salesRecordId: sale?.id || null,
    recordNo: sale?.recordNo || null,
    saleOrderNo: sale?.saleOrderNo || item.saleOrderNo || null,
    saleChannel: sale?.saleChannel || item.saleChannel || null,
    saleDate: sale?.saleDate || item.soldDate || null,
    sellingPrice,
    purchasePrice,
    profit: Number(sale?.itemProfit ?? snapshot?.profit ?? (sellingPrice - purchasePrice)),
    snapshot,
  };
}
function saleDataSelect() {
  return `SELECT a.*, i.brand, i.model, i.year, i.cpu, i.ram, i.gpu, i.storage, i.screen,
      i.warehouseId, i.purchasePrice AS currentPurchasePrice, i.saleChannel AS currentSaleChannel,
      i.sellingPrice AS currentSellingPrice, i.saleOrderNo AS currentSaleOrderNo,
      sr.recordNo AS saleRecordNo, sr.saleChannel AS originalSaleChannel,
      sr.saleOrderNo AS originalSaleOrderNo, sr.saleDate AS originalSaleDate,
      COALESCE(sri.sellingPrice, i.sellingPrice, 0) AS originalSellingPrice,
      COALESCE(sri.purchasePrice, i.purchasePrice, 0) AS originalPurchasePrice,
      COALESCE(sri.profit, 0) AS originalProfit,
      s.stockStatus, s.receivedAt AS stockReceivedAt, s.receivedBy AS stockReceivedBy, replacement.sn AS replacementSn,
      s.condition AS stockCondition, s.note AS stockNote,
      COALESCE(originalWarehouse.name, originalWarehouse.warehouseName, originalWarehouse.code) AS originalWarehouseName,
      COALESCE(shipmentWarehouse.name, shipmentWarehouse.warehouseName, shipmentWarehouse.code,
        replacementWarehouse.name, replacementWarehouse.warehouseName, replacementWarehouse.code) AS replacementWarehouseName,
      activity.movementType AS latestActivityType, activity.createdAt AS latestActivityAt,
      COALESCE(NULLIF(activityUser.realName, ''), activityUser.username) AS latestActivityByName,
      COALESCE(NULLIF(createdUser.realName, ''), createdUser.username) AS createdByName,
      COALESCE(NULLIF(receivedUser.realName, ''), receivedUser.username) AS receivedByName,
      COALESCE(NULLIF(processingUser.realName, ''), processingUser.username) AS processingByName
    FROM after_sale_records a
    LEFT JOIN inventory i ON i.id = a.inventoryId
    LEFT JOIN sales_record_items sri ON sri.id = (
      SELECT sourceItem.id FROM sales_record_items sourceItem
      WHERE sourceItem.inventoryId = a.inventoryId AND sourceItem.salesRecordId = a.salesRecordId
      ORDER BY sourceItem.createdAt DESC, sourceItem.rowid DESC LIMIT 1
    )
    LEFT JOIN sales_records sr ON sr.id = a.salesRecordId
    LEFT JOIN after_sale_stock s ON s.afterSaleId = a.id
    LEFT JOIN inventory replacement ON replacement.id = a.replacementInventoryId
    LEFT JOIN inventory reservedReplacement ON reservedReplacement.id = a.reservedReplacementId
    LEFT JOIN warehouses originalWarehouse ON originalWarehouse.id = i.warehouseId
    LEFT JOIN warehouses replacementWarehouse ON replacementWarehouse.id = COALESCE(reservedReplacement.warehouseId, replacement.warehouseId)
    LEFT JOIN inventory_movements shipment ON shipment.rowid = CASE WHEN a.replacementInventoryId IS NOT NULL THEN (
      SELECT priorShipment.rowid FROM inventory_movements priorShipment WHERE priorShipment.referenceType = 'after_sale'
        AND priorShipment.referenceId = a.id AND priorShipment.movementType = 'exchange_out'
      ORDER BY priorShipment.createdAt DESC, priorShipment.rowid DESC LIMIT 1
    ) END
    LEFT JOIN warehouses shipmentWarehouse ON shipmentWarehouse.id = shipment.fromWarehouseId
    LEFT JOIN inventory_movements activity ON activity.rowid = (
      SELECT latest.rowid FROM inventory_movements latest WHERE latest.referenceType = 'after_sale' AND latest.referenceId = a.id
      ORDER BY latest.createdAt DESC, latest.rowid DESC LIMIT 1
    )
    LEFT JOIN users activityUser ON activityUser.id = activity.actorId
    LEFT JOIN users createdUser ON createdUser.id = a.createdBy
    LEFT JOIN users receivedUser ON receivedUser.id = a.receivedBy
    LEFT JOIN users processingUser ON processingUser.id = a.processingBy`;
}

export async function GET(request: NextRequest) {
  try {
    await requireRole('admin');
    const { searchParams } = new URL(request.url);
    const resource = searchParams.get('resource') || '';
    const search = searchParams.get('search')?.trim() || '';
    const pattern = `%${search}%`;
    const { page, pageSize } = parsePaginationParams(searchParams);

    if (resource === 'sold-inventory') {
      const where = ["i.deleted = 0", "i.status = 'sold'"];
      const params: string[] = [];
      if (search) {
        where.push('(i.sn LIKE ? OR i.brand LIKE ? OR i.model LIKE ? OR CAST(i.year AS TEXT) LIKE ? OR i.saleOrderNo LIKE ? OR i.saleChannel LIKE ? OR i.supplierName LIKE ?)');
        params.push(pattern, pattern, pattern, pattern, pattern, pattern, pattern);
      }
      const clause = `WHERE ${where.join(' AND ')}`;
      const total = Number((db.prepare(`SELECT COUNT(*) AS total FROM inventory i ${clause}`).get(...params) as { total: number }).total || 0);
      const rows = db.prepare(`SELECT i.id, i.sn, i.brand, i.model, i.year, i.cpu, i.ram, i.gpu, i.storage, i.screen,
          i.purchasePrice, i.sellingPrice, i.saleChannel, i.saleOrderNo, i.soldDate, i.warehouseId, i.supplierName,
          sr.id AS salesRecordId, sr.recordNo AS saleRecordNo, sr.saleDate,
          COALESCE(sri.sellingPrice, i.sellingPrice, 0) AS originalSellingPrice,
          COALESCE(sri.purchasePrice, i.purchasePrice, 0) AS originalPurchasePrice,
          COALESCE(sri.profit, 0) AS originalProfit
        FROM inventory i
        LEFT JOIN sales_record_items sri ON sri.id = (
          SELECT sri2.id FROM sales_record_items sri2
          JOIN sales_records sr2 ON sr2.id = sri2.salesRecordId
          WHERE sri2.inventoryId = i.id AND sr2.status = 'completed' AND sr2.deleted = 0
          ORDER BY sri2.createdAt DESC, sr2.createdAt DESC LIMIT 1
        )
        LEFT JOIN sales_records sr ON sr.id = sri.salesRecordId AND sr.status = 'completed' AND sr.deleted = 0
        ${clause}
        GROUP BY i.id
        ORDER BY i.soldDate DESC, i.updatedAt DESC LIMIT ? OFFSET ?`).all(...params, pageSize, (page - 1) * pageSize);
      return NextResponse.json(successResponse(createPaginatedResponse(rows, total, page, pageSize)));
    }

    const where = ['a.deleted = 0'];
    const params: Array<string | number> = [];
    const status = searchParams.get('status')?.trim() || '';
    if (Object.hasOwn(queueFilters, status)) where.push(queueFilters[status]);
    else if (status && status !== 'all') { where.push('a.status = ?'); params.push(status); }
    if (search) {
      where.push('(a.afterSaleNo LIKE ? OR a.returnTrackingNo LIKE ? OR a.shippedReplacementTrackingNo LIKE ? OR a.reservedReplacementSn LIKE ? OR replacement.sn LIKE ? OR a.sn LIKE ? OR i.brand LIKE ? OR i.model LIKE ? OR CAST(i.year AS TEXT) LIKE ? OR a.customerName LIKE ? OR a.customerPhone LIKE ? OR a.issueType LIKE ? OR a.saleOrderNo LIKE ? OR sr.saleOrderNo LIKE ? OR sr.saleChannel LIKE ?)');
      params.push(...Array<string>(15).fill(pattern));
    }
    if (searchParams.get('id')) { where.push('a.id = ?'); params.push(searchParams.get('id')!); }
    const from = `FROM after_sale_records a
      LEFT JOIN inventory i ON i.id = a.inventoryId
      LEFT JOIN sales_records sr ON sr.id = a.salesRecordId
      LEFT JOIN after_sale_stock s ON s.afterSaleId = a.id
      LEFT JOIN inventory replacement ON replacement.id = a.replacementInventoryId`;
    const clause = `WHERE ${where.join(' AND ')}`;
    const total = Number((db.prepare(`SELECT COUNT(*) AS total ${from} ${clause}`).get(...params) as { total: number }).total || 0);
    const rows = db.prepare(`${saleDataSelect()} ${clause} ORDER BY a.createdAt DESC, a.id DESC LIMIT ? OFFSET ?`).all(...params, pageSize, (page - 1) * pageSize) as Row[];
    const items = rows.map((row) => ({
      ...row,
      saleChannel: row.originalSaleChannel || row.currentSaleChannel || null,
      saleOrderNo: row.originalSaleOrderNo || row.saleOrderNo || row.currentSaleOrderNo || null,
      saleDate: row.originalSaleDate || null,
      sellingPrice: Number(row.originalSellingPrice || 0),
      purchasePrice: Number(row.originalPurchasePrice || 0),
      profit: Number(row.originalProfit || 0),
    }));
    const list = createPaginatedResponse(items, total, page, pageSize);
    if (searchParams.get('includeCounts') !== '1') return NextResponse.json(successResponse(list));

    const countsSql = Object.entries(queueFilters).map(([name, condition]) => `COUNT(CASE WHEN ${condition} THEN 1 END) AS "${name}"`).join(',\n');
    const queueCounts = db.prepare(`SELECT COUNT(*) AS "all", ${countsSql}
      FROM after_sale_records a
      LEFT JOIN after_sale_stock s ON s.afterSaleId = a.id
      WHERE a.deleted = 0`).get();
    return NextResponse.json(successResponse({ ...list, queueCounts }));
  } catch (error) {
    const response = authError(error);
    if (response) return response;
    return NextResponse.json(errorResponse(ErrorCode.DATABASE_ERROR, msg(error, '获取售后数据失败')), { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const user = await requireRole('admin');
    const body = await request.json() as Row;
    const inventoryId = String(body.inventoryId || '').trim();
    const issueType = String(body.issueType || '').trim();
    const resolutionType = String(body.resolutionType || '').trim();
    const returnTrackingNo = normalizeTrackingNo(body.returnTrackingNo);
    const issueDescription = String(body.issueDescription || '').trim() || null;
    const remark = String(body.remark || '').trim() || null;
    if (!inventoryId || !resolutionType) return bad('请选择已售机器和处理方式');
    if (issueType.length > 160) return bad('售后原因不能超过 160 个字符');
    if (!['repair', 'exchange', 'customer_return'].includes(resolutionType)) return bad('售后处理方式不正确');
    const initial = inventory(inventoryId);
    if (!initial || initial.status !== 'sold') return NextResponse.json(errorResponse(ErrorCode.INVENTORY_NOT_FOUND, '已售机器不存在或状态已变化'), { status: 404 });
    if (initial.sellingPrice === null || initial.sellingPrice === undefined) return bad('已售机器缺少原销售价格，无法关联售后');
    if (db.prepare("SELECT id FROM after_sale_records WHERE inventoryId = ? AND status IN ('created','received','processing') AND deleted = 0").get(inventoryId)) return bad('该机器已有进行中的售后单');

    const id = generateId('after_sale');
    const now = formatDateTime();
    const date = now.slice(0, 10);
    const result = db.transaction(() => {
      const afterSaleNo = nextAfterSaleNo(date);
      const item = inventory(inventoryId);
      if (!item || item.status !== 'sold') throw new Error('机器状态已发生变化，请刷新后重试');
      if (db.prepare("SELECT id FROM after_sale_records WHERE inventoryId = ? AND status IN ('created','received','processing') AND deleted = 0").get(inventoryId)) throw new Error('该机器已有进行中的售后单');
      const source = saleSource(inventoryId, item);
      if (source.sellingPrice < 0 || !Number.isFinite(source.sellingPrice)) throw new Error('原销售价格无效，无法关联售后');
      if (resolutionType === 'customer_return') {
        if (db.prepare("UPDATE inventory SET status = 'in_stock', soldDate = NULL, sellingPrice = NULL, saleChannel = NULL, saleOrderNo = NULL, profit = NULL, updatedAt = ? WHERE id = ? AND status = 'sold' AND deleted = 0").run(now, inventoryId).changes !== 1) throw new Error('机器状态已发生变化，请刷新后重试');
        db.prepare(`INSERT INTO after_sale_records (id, afterSaleNo, inventoryId, sn, salesRecordId, saleOrderNo, customerName, customerPhone, issueType, issueDescription, resolutionType, status, refundAmount, resolutionNote, resolvedAt, returnTrackingNo, deleted, createdBy, createdAt, updatedAt)
          VALUES (?, ?, ?, ?, ?, ?, '', '', ?, ?, 'customer_return', 'resolved', ?, ?, ?, ?, 0, ?, ?, ?)`).run(
          id, afterSaleNo, inventoryId, item.sn, source.salesRecordId, source.saleOrderNo,
          issueType, issueDescription, source.sellingPrice, remark || '退货退款并恢复正式库存', now, returnTrackingNo, user.id, now, now,
        );
        const receiptId = generateId('return_receipt');
        const receiptNo = nextReceiptNo(date);
        const snapshot = { ...item, salesRecordId: source.salesRecordId, saleRecordNo: source.recordNo, saleChannel: source.saleChannel, saleOrderNo: source.saleOrderNo, sellingPrice: source.sellingPrice, purchasePrice: source.purchasePrice };
        insertDynamic('return_receipts', {
          id: receiptId, receiptNo, returnOrderId: null, returnId: null,
          inventoryId, sn: item.sn, salesRecordId: source.salesRecordId,
          warehouseId: item.warehouseId || null, purchasePrice: source.purchasePrice,
          reason: issueType, snapshot: JSON.stringify(snapshot), status: 'received',
          receivedAt: now, receivedBy: user.id, condition: issueType, note: remark,
          createdAt: now,
        });
        move(inventoryId, 'sales_return', id, user.id, remark || '客户退货退款并入库', item.warehouseId, null, item.warehouseId);
        return { id, afterSaleNo, status: 'resolved', resolutionType, inventoryId, receiptId, receiptNo, returnTrackingNo, salesRecordId: source.salesRecordId, saleRecordNo: source.recordNo, warehouseId: item.warehouseId, purchasePrice: source.purchasePrice, sellingPrice: source.sellingPrice, saleChannel: source.saleChannel, saleOrderNo: source.saleOrderNo };
      }

      if (db.prepare("UPDATE inventory SET status = 'after_sale', updatedAt = ? WHERE id = ? AND status = 'sold' AND deleted = 0").run(now, inventoryId).changes !== 1) throw new Error('机器状态已发生变化，请刷新后重试');
      db.prepare(`INSERT INTO after_sale_records (id, afterSaleNo, inventoryId, sn, salesRecordId, saleOrderNo, customerName, customerPhone, issueType, issueDescription, resolutionType, status, refundAmount, resolutionNote, returnTrackingNo, deleted, createdBy, createdAt, updatedAt)
        VALUES (?, ?, ?, ?, ?, ?, '', '', ?, ?, ?, 'created', ?, ?, ?, 0, ?, ?, ?)`).run(
        id, afterSaleNo, inventoryId, item.sn, source.salesRecordId, source.saleOrderNo,
        issueType, issueDescription, resolutionType, source.sellingPrice, remark, returnTrackingNo, user.id, now, now,
      );
      move(inventoryId, 'after_sale_created', id, user.id, `${resolutionType === 'repair' ? '维修' : '换货'}售后登记`, item.warehouseId);
      return { id, afterSaleNo, status: 'created', resolutionType, inventoryId, returnTrackingNo, salesRecordId: source.salesRecordId, recordNo: source.recordNo, saleOrderNo: source.saleOrderNo, saleChannel: source.saleChannel, saleDate: source.saleDate, sellingPrice: source.sellingPrice, purchasePrice: source.purchasePrice };
    })();
    return NextResponse.json(successResponse(result), { status: 201 });
  } catch (error) {
    const response = authError(error);
    if (response) return response;
    const message = msg(error, '创建售后单失败');
    const validation = /不能为空|请选择|不正确|无效|不存在|状态已变化|已有进行中|缺少原销售|快递单号|售后原因/.test(message);
    return NextResponse.json(errorResponse(validation ? ErrorCode.VALIDATION_ERROR : ErrorCode.DATABASE_ERROR, message), { status: validation ? 400 : 500 });
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const user = await requireRole('admin');
    const body = await request.json() as Row;
    const id = String(body.id || body.afterSaleId || '').trim();
    let action = String(body.action || '').trim();
    if (!id) return bad('售后单 ID 不能为空');
    const record = getAfterSale(id);
    if (!record) return NextResponse.json(errorResponse(ErrorCode.NOT_FOUND, '售后单不存在'), { status: 404 });
    const item = inventory(record.inventoryId);
    if (!item) return NextResponse.json(errorResponse(ErrorCode.INVENTORY_NOT_FOUND, '关联机器不存在'), { status: 404 });
    const now = formatDateTime();
    const resolutionNote = String(body.resolutionNote || body.note || '').trim() || null;
    if (action === 'resolve') {
      const type = String(body.resolutionType || record.resolutionType);
      action = type === 'repair' ? 'repair_complete' : type === 'exchange' ? 'exchange' : 'customer_return';
    }

    if (action === 'receive') {
      if (record.status !== 'created') return bad('当前售后单不能确认收到');
      const condition = optionalText(body.condition, '机器状况', 160);
      const note = optionalText(body.note, '拆包核验备注', 1000);
      const result = db.transaction(() => {
        const changed = db.prepare("UPDATE after_sale_records SET status = 'received', receivedAt = COALESCE(receivedAt, ?), receivedBy = COALESCE(receivedBy, ?), receivedCondition = ?, receivedNote = ?, updatedAt = ? WHERE id = ? AND status = 'created'").run(now, user.id, condition, note, now, id).changes;
        if (changed !== 1) throw new Error('售后单状态已变化，请刷新后重试');
        const existing = db.prepare('SELECT id FROM after_sale_stock WHERE afterSaleId = ?').get(id) as Row | undefined;
        if (existing) db.prepare("UPDATE after_sale_stock SET stockStatus = 'stored', receivedAt = ?, receivedBy = ?, condition = ?, note = ?, updatedAt = ? WHERE id = ?").run(now, user.id, condition, note, now, existing.id);
        else db.prepare("INSERT INTO after_sale_stock (id, afterSaleId, afterSaleRecordId, inventoryId, stockStatus, receivedAt, receivedBy, condition, note, createdAt, updatedAt) VALUES (?, ?, ?, ?, 'stored', ?, ?, ?, ?, ?, ?)").run(
          generateId('after_stock'), id, id, record.inventoryId, now, user.id, condition, note, now, now,
        );
        move(record.inventoryId, 'after_sale_receive', id, user.id, '售后机器收到并进入暂存', item.warehouseId);
        return { id, status: 'received' };
      })();
      return NextResponse.json(successResponse(result));
    }

    if (action === 'update_condition') {
      if (body.condition === undefined && body.note === undefined) return bad('请提供机器状况或拆包核验备注');
      const condition = optionalText(body.condition, '机器状况', 160);
      const note = optionalText(body.note, '拆包核验备注', 1000);
      const result = db.transaction(() => {
        const current = getAfterSale(id);
        const stock = getAfterSaleStock(id);
        if (!current || stock?.stockStatus !== 'stored' || inventory(current.inventoryId)?.status !== 'after_sale'
          || !(['received', 'processing'].includes(current.status) || (current.status === 'resolved' && current.resolutionType === 'exchange'))) {
          throw new Error('当前机器状态不能补填核验信息');
        }
        const nextCondition = body.condition === undefined ? (current.receivedCondition ?? stock.condition ?? null) : condition;
        const nextNote = body.note === undefined ? (current.receivedNote ?? stock.note ?? null) : note;
        db.prepare('UPDATE after_sale_records SET receivedCondition = ?, receivedNote = ?, updatedAt = ? WHERE id = ?').run(nextCondition, nextNote, now, id);
        db.prepare("UPDATE after_sale_stock SET condition = ?, note = ?, updatedAt = ? WHERE id = ? AND stockStatus = 'stored'").run(nextCondition, nextNote, now, stock.id);
        move(current.inventoryId, 'after_sale_condition', id, user.id, [nextCondition, nextNote].filter(Boolean).join(' · ') || '清空机器状况和核验备注', item.warehouseId);
        return { id, status: current.status, receivedCondition: nextCondition, receivedNote: nextNote };
      }).immediate();
      return NextResponse.json(successResponse(result));
    }

    if (action === 'start_processing') {
      const processingNote = String(body.processingNote || '').trim() || null;
      if (typeof body.processingNote === 'string' && body.processingNote.length > 1000) return bad('处理进展不能超过 1000 个字符');
      const started = db.transaction(() => {
        const changed = db.prepare("UPDATE after_sale_records SET status = 'processing', processingAt = ?, processingBy = ?, processingNote = COALESCE(?, processingNote), updatedAt = ? WHERE id = ? AND status = 'received'").run(now, user.id, processingNote, now, id).changes;
        if (changed !== 1) return false;
        move(record.inventoryId, 'after_sale_start_processing', id, user.id, processingNote || '开始售后处理', item.warehouseId);
        return true;
      });
      if (!started()) return bad('当前售后单不能开始处理');
      return NextResponse.json(successResponse({ id, status: 'processing' }));
    }

    if (action === 'update_progress') {
      const processingNote = String(body.processingNote || '').trim();
      if (record.status !== 'processing') return bad('仅处理中售后单可以更新进展');
      if (!processingNote) return bad('请填写当前处理进展');
      if (processingNote.length > 1000) return bad('处理进展不能超过 1000 个字符');
      db.transaction(() => {
        if (db.prepare("UPDATE after_sale_records SET processingNote = ?, updatedAt = ? WHERE id = ? AND status = 'processing'").run(processingNote, now, id).changes !== 1) throw new Error('售后单状态已变化，请刷新后重试');
        move(record.inventoryId, 'after_sale_progress', id, user.id, processingNote, item.warehouseId);
      })();
      return NextResponse.json(successResponse({ id, status: 'processing', processingNote }));
    }

    if (action === 'exchange') return bad('请先预留替换机器，实际寄出后登记寄出快递单号');

    if (action === 'reserve_exchange' || action === 'release_exchange') {
      const replacementId = action === 'reserve_exchange' ? optionalText(body.replacementInventoryId, '替换机器', 160) : null;
      const processingNote = action === 'reserve_exchange' ? optionalText(body.processingNote, '交接备注', 1000) : null;
      if (action === 'reserve_exchange' && !replacementId) return bad('换货必须选择替换机器');
      const result = db.transaction(() => {
        const { record: current, original } = activeExchange(id, action === 'reserve_exchange');
        checkExpectedReservation(body, current);
        const previousId = (current.reservedReplacementId ?? null) as string | null;
        if (replacementId === previousId) {
          return { id, status: current.status, reservedReplacementId: previousId, reservedReplacementSn: current.reservedReplacementSn };
        }
        if (replacementId === current.inventoryId) throw new Error('不能选择原机器作为替换机器');
        let replacement: ReturnType<typeof assertInventoryOperationEligible> | null = null;
        if (replacementId) {
          const conflictingReservation = db.prepare('SELECT afterSaleNo FROM after_sale_records WHERE reservedReplacementId = ? AND deleted = 0').get(replacementId) as { afterSaleNo: string } | undefined;
          if (conflictingReservation) throw new Error(`替换机器已被售后单 ${conflictingReservation.afterSaleNo} 预留，不能重复预留`);
          replacement = assertWarehouseReplacement(replacementId);
        }
        const startsProcessing = current.status === 'received';
        if (startsProcessing) {
          db.prepare(`UPDATE after_sale_records SET status = 'processing', processingAt = COALESCE(processingAt, ?),
            processingBy = COALESCE(processingBy, ?), processingNote = COALESCE(?, processingNote),
            reservedReplacementId = ?, reservedReplacementSn = ?, updatedAt = ? WHERE id = ?`)
            .run(now, user.id, processingNote, replacementId, replacement?.sn || null, now, id);
          move(original.id, 'after_sale_start_processing', id, user.id, processingNote || '预留替换机并开始换货处理', original.warehouseId);
        } else {
          db.prepare('UPDATE after_sale_records SET reservedReplacementId = ?, reservedReplacementSn = ?, updatedAt = ? WHERE id = ?')
            .run(replacementId, replacement?.sn || null, now, id);
        }
        if (previousId) {
          const previous = inventory(previousId);
          move(previousId, 'after_sale_reservation_release', id, user.id, replacementId ? '更换替换机器并解除预留' : '解除换货预留', previous?.warehouseId);
        }
        if (replacement) move(replacement.id, 'after_sale_reserve', id, user.id, '替换机器已预留，等待寄出', replacement.warehouseId);
        return { id, status: 'processing', reservedReplacementId: replacementId, reservedReplacementSn: replacement?.sn || null };
      }).immediate();
      return NextResponse.json(successResponse(result));
    }

    if (action === 'restock') {
      const condition = optionalText(body.condition, '原机检查结果', 160);
      if (!condition) return bad('原机检查结果不能为空，请确认机器可转入正式库存');
      const note = optionalText(body.note, '原机处置备注', 1000);
      const result = db.transaction(() => {
        const current = getAfterSale(id);
        const stock = getAfterSaleStock(id);
        if (!current || current.status !== 'resolved' || current.resolutionType !== 'exchange' || stock?.stockStatus !== 'stored') {
          throw new Error('当前售后单状态不能办理原机入库，必须完成换货且原机仍在暂存');
        }
        if (db.prepare("UPDATE inventory SET status = 'in_stock', soldDate = NULL, sellingPrice = NULL, saleChannel = NULL, saleOrderNo = NULL, profit = NULL, updatedAt = ? WHERE id = ? AND status = 'after_sale' AND deleted = 0").run(now, current.inventoryId).changes !== 1) throw new Error('原机器状态已变化');
        if (db.prepare("UPDATE after_sale_stock SET stockStatus = 'restocked', updatedAt = ? WHERE id = ? AND stockStatus = 'stored'").run(now, stock.id).changes !== 1) throw new Error('售后暂存状态已变化');
        db.prepare('UPDATE after_sale_records SET updatedAt = ? WHERE id = ?').run(now, id);
        move(current.inventoryId, 'after_sale_restock', id, user.id, `换货原机检查合格并转入正式库存：${[condition, note].filter(Boolean).join(' · ')}`, item.warehouseId, null, item.warehouseId);
        return { id, status: 'resolved', resolutionType: 'exchange', stockStatus: 'restocked', inventoryId: current.inventoryId };
      }).immediate();
      return NextResponse.json(successResponse(result));
    }

    if (action !== 'ship_exchange') {
      if (!['created', 'received', 'processing'].includes(record.status) || item.status !== 'after_sale') return bad('售后单已结束或机器状态已变化');
    }
    const stock = getAfterSaleStock(id);
    if (['repair_complete', 'customer_return'].includes(action)) {
      if (record.status !== 'processing') return bad('请先开始售后处理并登记处理人');
      if (!stock || stock.stockStatus !== 'stored') return bad('请先确认收到机器');
      if (record.resolutionType === 'exchange') return bad('换货售后不能直接办理维修归还或退货入库');
    }

    if (action === 'cancel') {
      const result = db.transaction(() => {
        const current = getAfterSale(id);
        const currentStock = getAfterSaleStock(id);
        if (current?.resolutionType === 'exchange' && currentStock?.stockStatus === 'stored' && body.originalReturnedToCustomer !== true) {
          throw new Error('原机仍在售后暂存，必须确认原机已归还客户才能取消换货；只需释放替换机时，请解除锁定');
        }
        if (db.prepare("UPDATE inventory SET status = 'sold', updatedAt = ? WHERE id = ? AND status = 'after_sale'").run(now, record.inventoryId).changes !== 1) throw new Error('机器状态已变化');
        if (currentStock) db.prepare("UPDATE after_sale_stock SET stockStatus = 'released', updatedAt = ? WHERE id = ? AND stockStatus = 'stored'").run(now, currentStock.id);
        if (db.prepare("UPDATE after_sale_records SET status = 'cancelled', reservedReplacementId = NULL, reservedReplacementSn = NULL, resolvedAt = ?, resolutionNote = ?, updatedAt = ? WHERE id = ? AND status IN ('created','received','processing') AND deleted = 0").run(now, resolutionNote, now, id).changes !== 1) throw new Error('售后单状态已变化');
        if (current?.reservedReplacementId) {
          const replacement = inventory(current.reservedReplacementId);
          move(current.reservedReplacementId, 'after_sale_reservation_release', id, user.id, '取消售后并解除换货预留', replacement?.warehouseId);
        }
        move(record.inventoryId, 'after_sale_cancel', id, user.id, current?.resolutionType === 'exchange' && currentStock?.stockStatus === 'stored' ? '确认原机已归还客户，取消换货' : '取消售后并恢复已售', item.warehouseId);
        return { id, status: 'cancelled' };
      }).immediate();
      return NextResponse.json(successResponse(result));
    }

    if (action === 'repair_complete') {
      const result = db.transaction(() => {
        if (db.prepare("UPDATE inventory SET status = 'sold', updatedAt = ? WHERE id = ? AND status = 'after_sale'").run(now, record.inventoryId).changes !== 1) throw new Error('原机器状态已变化');
        if (db.prepare("UPDATE after_sale_stock SET stockStatus = 'released', updatedAt = ? WHERE id = ? AND stockStatus = 'stored'").run(now, stock!.id).changes !== 1) throw new Error('售后暂存状态已变化');
        if (db.prepare("UPDATE after_sale_records SET status = 'resolved', resolutionType = 'repair', resolvedAt = ?, resolutionNote = ?, updatedAt = ? WHERE id = ? AND status IN ('received','processing')").run(now, resolutionNote || '维修完成并归还客户', now, id).changes !== 1) throw new Error('售后单状态已变化');
        move(record.inventoryId, 'after_sale_release', id, user.id, resolutionNote || '维修完成并归还客户', item.warehouseId);
        return { id, status: 'resolved', resolutionType: 'repair' };
      })();
      return NextResponse.json(successResponse(result));
    }

    if (action === 'customer_return') {
      const source = saleSource(record.inventoryId, item);
      const result = db.transaction(() => {
        if (db.prepare("UPDATE inventory SET status = 'in_stock', soldDate = NULL, sellingPrice = NULL, saleChannel = NULL, saleOrderNo = NULL, profit = NULL, updatedAt = ? WHERE id = ? AND status = 'after_sale'").run(now, record.inventoryId).changes !== 1) throw new Error('原机器状态已变化');
        if (db.prepare("UPDATE after_sale_stock SET stockStatus = 'restocked', updatedAt = ? WHERE id = ? AND stockStatus = 'stored'").run(now, stock!.id).changes !== 1) throw new Error('售后暂存状态已变化');
        if (db.prepare("UPDATE after_sale_records SET status = 'resolved', resolutionType = 'customer_return', resolvedAt = ?, resolutionNote = ?, refundAmount = ?, updatedAt = ? WHERE id = ? AND status IN ('received','processing')").run(now, resolutionNote || '退货退款并恢复正式库存', source.sellingPrice, now, id).changes !== 1) throw new Error('售后单状态已变化');
        const receiptId = generateId('return_receipt');
        const receiptNo = nextReceiptNo(now.slice(0, 10));
        insertDynamic('return_receipts', { id: receiptId, receiptNo, returnOrderId: null, returnId: null, inventoryId: record.inventoryId, sn: item.sn, salesRecordId: record.salesRecordId || source.salesRecordId, warehouseId: item.warehouseId || null, purchasePrice: source.purchasePrice, reason: record.issueType, snapshot: JSON.stringify({ ...item, salesRecordId: record.salesRecordId || source.salesRecordId, saleRecordNo: source.recordNo, saleChannel: source.saleChannel, saleOrderNo: source.saleOrderNo, sellingPrice: source.sellingPrice, purchasePrice: source.purchasePrice }), status: 'received', receivedAt: now, receivedBy: user.id, condition: record.issueType, note: resolutionNote, createdAt: now });
        move(record.inventoryId, 'sales_return', id, user.id, resolutionNote || '售后退货退款入库', item.warehouseId, null, item.warehouseId);
        return { id, status: 'resolved', resolutionType: 'customer_return', inventoryId: record.inventoryId, receiptId, receiptNo, warehouseId: item.warehouseId, purchasePrice: source.purchasePrice, sellingPrice: source.sellingPrice, saleChannel: source.saleChannel };
      })();
      return NextResponse.json(successResponse(result));
    }

    if (action === 'ship_exchange') {
      const shippedReplacementTrackingNo = optionalText(body.shippingTrackingNo, '寄出快递单号', 100);
      if (!shippedReplacementTrackingNo) return bad('寄出快递单号不能为空');
      const confirmation = optionalText(body.confirmedReplacementSn, '实际发货的替换机 SN', 206);
      if (!confirmation) return bad('请扫描或输入实际发货的替换机 SN');
      if (typeof body.expectedReplacementInventoryId !== 'string' || !body.expectedReplacementInventoryId.trim()) {
        return bad('缺少已预留替换机信息，请刷新工单后重试');
      }
      const result = db.transaction(() => {
        const { record: current, original } = activeExchange(id);
        checkExpectedReservation(body, current);
        const replacementInventoryId = current.reservedReplacementId as string | null;
        if (!replacementInventoryId || replacementInventoryId === current.inventoryId) throw new Error('必须先预留替换机器');
        const replacement = inventory(replacementInventoryId);
        if (!replacement) throw new Error('替换机器不存在，请解除预留后重新选择');
        if (current.reservedReplacementSn && replacement.sn !== current.reservedReplacementSn) throw new Error('替换机器的 SN 已变化，请解除预留后重新选择');
        if (!matchesMachineScanSerial(confirmation, String(replacement.sn))) {
          throw new Error(`实际发货的替换机 SN「${confirmation}」与已预留 SN「${replacement.sn}」不一致，不能出库，请核对实物或更换预留`);
        }
        if (shippedReplacementTrackingNo.toLocaleLowerCase() === current.returnTrackingNo?.trim().toLocaleLowerCase()) {
          throw new Error('寄给客户的运单号不能与客户寄回的运单号相同，请核对寄出面单');
        }
        const source = saleSource(current.inventoryId, original);
        // Consume the reservation in the transaction before checking stock eligibility.
        // Any subsequent error restores it, and no other writer can take the machine mid-shipment.
        if (db.prepare(`UPDATE after_sale_records SET status = 'resolved', replacementInventoryId = ?,
            reservedReplacementId = NULL, reservedReplacementSn = NULL, shippedReplacementTrackingNo = ?,
            resolvedAt = ?, resolutionNote = ?, updatedAt = ?
            WHERE id = ? AND status = 'processing' AND resolutionType = 'exchange' AND deleted = 0 AND reservedReplacementId = ?`)
          .run(replacementInventoryId, shippedReplacementTrackingNo, now, resolutionNote || '换货机已寄出，原机待处置', now, id, replacementInventoryId).changes !== 1) {
          throw new Error('售后单状态已变化');
        }
        assertWarehouseReplacement(replacementInventoryId);
        endCustomStatus(replacementInventoryId,user.id,'售后换机出库','after_sale',id,'sold');
        if (db.prepare("UPDATE inventory SET status = 'sold', soldDate = ?, sellingPrice = ?, saleChannel = ?, saleOrderNo = ?, profit = ?, updatedAt = ? WHERE id = ? AND status IN ('in_stock','custom') AND deleted = 0").run(now.slice(0, 10), source.sellingPrice, source.saleChannel, source.saleOrderNo, source.sellingPrice - Number(replacement.purchasePrice || 0), now, replacementInventoryId).changes !== 1) throw new Error('替换机器状态已变化');
        const linkedSalesRecordId = current.salesRecordId || source.salesRecordId;
        if (linkedSalesRecordId) {
          const salesItem = {
            inventoryId: replacementInventoryId, sn: replacement.sn, brand: replacement.brand,
            model: replacement.model, year: replacement.year, cpu: replacement.cpu, ram: replacement.ram,
            gpu: replacement.gpu, storage: replacement.storage, screen: replacement.screen,
            purchasePrice: Number(replacement.purchasePrice || 0), sellingPrice: source.sellingPrice,
            profit: source.sellingPrice - Number(replacement.purchasePrice || 0),
            warehouseId: replacement.warehouseId || null, afterSaleId: id, itemType: 'exchange',
            originalInventoryId: current.inventoryId, shippedReplacementTrackingNo,
          };
          insertDynamic('sales_record_items', {
            ...salesItem, id: generateId('sale_item'), salesRecordId: linkedSalesRecordId, saleRecordId: linkedSalesRecordId,
            snapshot: JSON.stringify({ ...replacement, ...salesItem, salesRecordId: linkedSalesRecordId, saleChannel: source.saleChannel, saleOrderNo: source.saleOrderNo, outboundAt: now }),
            createdAt: now,
          });
          const sales = db.prepare('SELECT items FROM sales_records WHERE id = ?').get(linkedSalesRecordId) as { items: string } | undefined;
          if (sales) {
            // Canonical item rows remain the source for actual exchange delivery.
            // Keep the old embedded list in sync when it can be parsed, without wiping malformed historical data.
            let saleItems: unknown;
            try { saleItems = JSON.parse(sales.items); } catch { saleItems = null; }
            if (Array.isArray(saleItems)) {
              saleItems.push(salesItem);
              db.prepare('UPDATE sales_records SET items = ? WHERE id = ?').run(JSON.stringify(saleItems), linkedSalesRecordId);
            }
          }
        }
        move(replacementInventoryId, 'exchange_out', id, user.id, `替换机器已寄出 · 运单 ${shippedReplacementTrackingNo}`, replacement.warehouseId, replacement.warehouseId, null);
        return { id, status: 'resolved', resolutionType: 'exchange', stockStatus: 'stored', replacementInventoryId, replacementSn: replacement.sn, shippedReplacementTrackingNo, saleChannel: source.saleChannel, saleOrderNo: source.saleOrderNo, sellingPrice: source.sellingPrice };
      }).immediate();
      return NextResponse.json(successResponse(result));
    }

    return bad('不支持的售后操作');
  } catch (error) {
    const response = authError(error);
    if (response) return response;
    const message = msg(error, '处理售后单失败');
    const validation = /不能为空|不支持|不能|必须|无效|不存在|状态|已变化|已结束|请先确认|请提供|预留/.test(message);
    return NextResponse.json(errorResponse(validation ? ErrorCode.VALIDATION_ERROR : ErrorCode.DATABASE_ERROR, message), { status: validation ? 400 : 500 });
  }
}
