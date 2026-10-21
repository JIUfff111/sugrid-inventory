import { assertStockEligible, endCustomStatus } from '@/lib/inventory-status';
import { NextRequest, NextResponse } from 'next/server';
import db from '@/lib/db';
import { createPaginatedResponse, errorResponse, ErrorCode, formatDateTime, generateId, parsePaginationParams, successResponse } from '@/lib/api-helpers';
import { AuthError, requireRole } from '@/lib/auth';

type Row = Record<string, any>;
const authError = (error: unknown) => error instanceof AuthError ? NextResponse.json(errorResponse(error.code, error.message), { status: error.status }) : null;
const msg = (error: unknown, fallback: string) => error instanceof Error ? error.message : fallback;
const bad = (message: string) => NextResponse.json(errorResponse(ErrorCode.VALIDATION_ERROR, message), { status: 400 });

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
      s.stockStatus, s.receivedAt AS stockReceivedAt, s.condition AS stockCondition
    FROM after_sale_records a
    LEFT JOIN inventory i ON i.id = a.inventoryId
    LEFT JOIN sales_record_items sri ON sri.inventoryId = a.inventoryId AND sri.salesRecordId = a.salesRecordId
    LEFT JOIN sales_records sr ON sr.id = a.salesRecordId
    LEFT JOIN after_sale_stock s ON s.afterSaleId = a.id`;
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
    if (status === 'stored') where.push("s.stockStatus = 'stored'");
    else if (status && status !== 'all') { where.push('a.status = ?'); params.push(status); }
    if (search) {
      where.push('(a.afterSaleNo LIKE ? OR a.sn LIKE ? OR i.brand LIKE ? OR i.model LIKE ? OR CAST(i.year AS TEXT) LIKE ? OR a.customerName LIKE ? OR a.customerPhone LIKE ? OR a.issueType LIKE ? OR a.saleOrderNo LIKE ? OR sr.saleOrderNo LIKE ? OR sr.saleChannel LIKE ?)');
      params.push(pattern, pattern, pattern, pattern, pattern, pattern, pattern, pattern, pattern, pattern, pattern);
    }
    if (searchParams.get('id')) { where.push('a.id = ?'); params.push(searchParams.get('id')!); }
    const from = `FROM after_sale_records a
      LEFT JOIN inventory i ON i.id = a.inventoryId
      LEFT JOIN sales_records sr ON sr.id = a.salesRecordId
      LEFT JOIN after_sale_stock s ON s.afterSaleId = a.id`;
    const clause = `WHERE ${where.join(' AND ')}`;
    const total = Number((db.prepare(`SELECT COUNT(*) AS total ${from} ${clause}`).get(...params) as { total: number }).total || 0);
    const rows = db.prepare(`${saleDataSelect()} ${clause} ORDER BY a.createdAt DESC LIMIT ? OFFSET ?`).all(...params, pageSize, (page - 1) * pageSize) as Row[];
    const items = rows.map((row) => ({
      ...row,
      saleChannel: row.originalSaleChannel || row.currentSaleChannel || null,
      saleOrderNo: row.originalSaleOrderNo || row.saleOrderNo || row.currentSaleOrderNo || null,
      saleDate: row.originalSaleDate || null,
      sellingPrice: Number(row.originalSellingPrice || 0),
      purchasePrice: Number(row.originalPurchasePrice || 0),
      profit: Number(row.originalProfit || 0),
    }));
    return NextResponse.json(successResponse(createPaginatedResponse(items, total, page, pageSize)));
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
    const issueDescription = String(body.issueDescription || '').trim() || null;
    const remark = String(body.remark || '').trim() || null;
    if (!inventoryId || !issueType || !resolutionType) return bad('请选择已售机器、售后原因和处理方式');
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
        db.prepare(`INSERT INTO after_sale_records (id, afterSaleNo, inventoryId, sn, salesRecordId, saleOrderNo, customerName, customerPhone, issueType, issueDescription, resolutionType, status, refundAmount, resolutionNote, resolvedAt, deleted, createdBy, createdAt, updatedAt)
          VALUES (?, ?, ?, ?, ?, ?, '', '', ?, ?, 'customer_return', 'resolved', ?, ?, ?, 0, ?, ?, ?)`).run(
          id, afterSaleNo, inventoryId, item.sn, source.salesRecordId, source.saleOrderNo,
          issueType, issueDescription, source.sellingPrice, remark || '退货退款并恢复正式库存', now, user.id, now, now,
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
        return { id, afterSaleNo, status: 'resolved', resolutionType, inventoryId, receiptId, receiptNo, salesRecordId: source.salesRecordId, saleRecordNo: source.recordNo, warehouseId: item.warehouseId, purchasePrice: source.purchasePrice, sellingPrice: source.sellingPrice, saleChannel: source.saleChannel, saleOrderNo: source.saleOrderNo };
      }

      if (db.prepare("UPDATE inventory SET status = 'after_sale', updatedAt = ? WHERE id = ? AND status = 'sold' AND deleted = 0").run(now, inventoryId).changes !== 1) throw new Error('机器状态已发生变化，请刷新后重试');
      db.prepare(`INSERT INTO after_sale_records (id, afterSaleNo, inventoryId, sn, salesRecordId, saleOrderNo, customerName, customerPhone, issueType, issueDescription, resolutionType, status, refundAmount, resolutionNote, deleted, createdBy, createdAt, updatedAt)
        VALUES (?, ?, ?, ?, ?, ?, '', '', ?, ?, ?, 'created', ?, ?, 0, ?, ?, ?)`).run(
        id, afterSaleNo, inventoryId, item.sn, source.salesRecordId, source.saleOrderNo,
        issueType, issueDescription, resolutionType, source.sellingPrice, remark, user.id, now, now,
      );
      move(inventoryId, 'after_sale_created', id, user.id, `${resolutionType === 'repair' ? '维修' : '换货'}售后登记`, item.warehouseId);
      return { id, afterSaleNo, status: 'created', resolutionType, inventoryId, salesRecordId: source.salesRecordId, recordNo: source.recordNo, saleOrderNo: source.saleOrderNo, saleChannel: source.saleChannel, saleDate: source.saleDate, sellingPrice: source.sellingPrice, purchasePrice: source.purchasePrice };
    })();
    return NextResponse.json(successResponse(result), { status: 201 });
  } catch (error) {
    const response = authError(error);
    if (response) return response;
    const message = msg(error, '创建售后单失败');
    const validation = /不能为空|请选择|不正确|无效|不存在|状态已变化|已有进行中|缺少原销售/.test(message);
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
    const record = db.prepare('SELECT * FROM after_sale_records WHERE id = ? AND deleted = 0').get(id) as Row | undefined;
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
      const result = db.transaction(() => {
        const changed = db.prepare("UPDATE after_sale_records SET status = 'received', receivedAt = COALESCE(receivedAt, ?), receivedBy = COALESCE(receivedBy, ?), updatedAt = ? WHERE id = ? AND status = 'created'").run(now, user.id, now, id).changes;
        if (changed !== 1) throw new Error('售后单状态已变化，请刷新后重试');
        const existing = db.prepare('SELECT id FROM after_sale_stock WHERE afterSaleId = ?').get(id) as Row | undefined;
        if (!existing) db.prepare("INSERT INTO after_sale_stock (id, afterSaleId, afterSaleRecordId, inventoryId, stockStatus, receivedAt, receivedBy, condition, note, createdAt, updatedAt) VALUES (?, ?, ?, ?, 'stored', ?, ?, ?, ?, ?, ?)").run(
          generateId('after_stock'), id, id, record.inventoryId, now, user.id,
          String(body.condition || '').trim() || null, String(body.note || '').trim() || null, now, now,
        );
        move(record.inventoryId, 'after_sale_receive', id, user.id, '售后机器收到并进入暂存', item.warehouseId);
        return { id, status: 'received' };
      })();
      return NextResponse.json(successResponse(result));
    }

    if (action === 'start_processing') {
      const changed = db.prepare("UPDATE after_sale_records SET status = 'processing', updatedAt = ? WHERE id = ? AND status = 'received'").run(now, id).changes;
      if (changed !== 1) return bad('当前售后单不能开始处理');
      return NextResponse.json(successResponse({ id, status: 'processing' }));
    }

    if (!['created', 'received', 'processing'].includes(record.status) || item.status !== 'after_sale') return bad('售后单已结束或机器状态已变化');
    const stock = db.prepare('SELECT * FROM after_sale_stock WHERE afterSaleId = ?').get(id) as Row | undefined;
    if ((!stock || stock.stockStatus !== 'stored') && ['repair_complete', 'customer_return', 'exchange', 'restock'].includes(action)) return bad('请先确认收到机器');

    if (action === 'cancel') {
      const result = db.transaction(() => {
        if (db.prepare("UPDATE inventory SET status = 'sold', updatedAt = ? WHERE id = ? AND status = 'after_sale'").run(now, record.inventoryId).changes !== 1) throw new Error('机器状态已变化');
        if (stock) db.prepare("UPDATE after_sale_stock SET stockStatus = 'released', updatedAt = ? WHERE id = ? AND stockStatus = 'stored'").run(now, stock.id);
        if (db.prepare("UPDATE after_sale_records SET status = 'cancelled', resolvedAt = ?, resolutionNote = ?, updatedAt = ? WHERE id = ? AND status IN ('created','received','processing')").run(now, resolutionNote, now, id).changes !== 1) throw new Error('售后单状态已变化');
        move(record.inventoryId, 'after_sale_cancel', id, user.id, '取消售后并恢复已售', item.warehouseId);
        return { id, status: 'cancelled' };
      })();
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

    if (action === 'customer_return' || action === 'restock') {
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

    if (action === 'exchange') {
      const replacementInventoryId = String(body.replacementInventoryId || '').trim();
      if (!replacementInventoryId || replacementInventoryId === record.inventoryId) return bad('换机必须选择替换机器');
      const replacement = inventory(replacementInventoryId);
      if (!replacement) return bad('替换机器不存在');
      assertStockEligible(replacementInventoryId);
      const source = saleSource(record.inventoryId, item);
      const result = db.transaction(() => {
        if (db.prepare("UPDATE inventory SET status = 'in_stock', soldDate = NULL, sellingPrice = NULL, saleChannel = NULL, saleOrderNo = NULL, profit = NULL, updatedAt = ? WHERE id = ? AND status = 'after_sale'").run(now, record.inventoryId).changes !== 1) throw new Error('原机器状态已变化');
        assertStockEligible(replacementInventoryId);
        endCustomStatus(replacementInventoryId,user.id,'售后换机出库','after_sale',id,'sold');
        if (db.prepare("UPDATE inventory SET status = 'sold', soldDate = ?, sellingPrice = ?, saleChannel = ?, saleOrderNo = ?, profit = ?, updatedAt = ? WHERE id = ? AND status IN ('in_stock','custom') AND deleted = 0").run(now.slice(0, 10), source.sellingPrice, source.saleChannel, source.saleOrderNo, source.sellingPrice - Number(replacement.purchasePrice || 0), now, replacementInventoryId).changes !== 1) throw new Error('替换机器状态已变化');
        if (db.prepare("UPDATE after_sale_stock SET stockStatus = 'exchanged_out', updatedAt = ? WHERE id = ? AND stockStatus = 'stored'").run(now, stock!.id).changes !== 1) throw new Error('售后暂存状态已变化');
        if (db.prepare("UPDATE after_sale_records SET status = 'resolved', resolutionType = 'exchange', replacementInventoryId = ?, resolvedAt = ?, resolutionNote = ?, updatedAt = ? WHERE id = ? AND status IN ('received','processing')").run(replacementInventoryId, now, resolutionNote || '换货完成', now, id).changes !== 1) throw new Error('售后单状态已变化');
        if (record.salesRecordId || source.salesRecordId) {
          const columns = tableColumns('sales_record_items');
          const recordColumn = columns.has('salesRecordId') ? 'salesRecordId' : 'saleRecordId';
          insertDynamic('sales_record_items', {
            id: generateId('sale_item'), salesRecordId: source.salesRecordId, saleRecordId: source.salesRecordId,
            inventoryId: replacementInventoryId, sn: replacement.sn, purchasePrice: Number(replacement.purchasePrice || 0),
            sellingPrice: source.sellingPrice, profit: source.sellingPrice - Number(replacement.purchasePrice || 0),
            warehouseId: replacement.warehouseId || null,
            snapshot: JSON.stringify({ ...replacement, salesRecordId: source.salesRecordId, saleChannel: source.saleChannel, saleOrderNo: source.saleOrderNo, sellingPrice: source.sellingPrice, purchasePrice: replacement.purchasePrice }),
            afterSaleId: id, itemType: 'exchange', originalInventoryId: record.inventoryId, createdAt: now,
          });
          if (source.salesRecordId && columns.has(recordColumn)) {
            const sales = db.prepare('SELECT items FROM sales_records WHERE id = ?').get(source.salesRecordId) as { items: string } | undefined;
            if (sales) {
              let saleItems: Row[] = [];
              try { saleItems = JSON.parse(sales.items) as Row[]; } catch { saleItems = []; }
              if (Array.isArray(saleItems)) {
                saleItems.push({ inventoryId: replacementInventoryId, sn: replacement.sn, brand: replacement.brand, model: replacement.model, year: replacement.year, cpu: replacement.cpu, ram: replacement.ram, gpu: replacement.gpu, storage: replacement.storage, screen: replacement.screen, purchasePrice: Number(replacement.purchasePrice || 0), sellingPrice: source.sellingPrice, profit: source.sellingPrice - Number(replacement.purchasePrice || 0), warehouseId: replacement.warehouseId || null, afterSaleId: id, itemType: 'exchange', originalInventoryId: record.inventoryId });
                db.prepare('UPDATE sales_records SET items = ? WHERE id = ?').run(JSON.stringify(saleItems), source.salesRecordId);
              }
            }
          }
        }
        move(record.inventoryId, 'exchange_in', id, user.id, '换货原机转正式库存', item.warehouseId, null, item.warehouseId);
        move(replacementInventoryId, 'exchange_out', id, user.id, '替换机器按原销售渠道和价格交付', replacement.warehouseId, replacement.warehouseId, null);
        return { id, status: 'resolved', resolutionType: 'exchange', replacementInventoryId, saleChannel: source.saleChannel, saleOrderNo: source.saleOrderNo, sellingPrice: source.sellingPrice };
      })();
      return NextResponse.json(successResponse(result));
    }

    return bad('不支持的售后操作');
  } catch (error) {
    const response = authError(error);
    if (response) return response;
    const message = msg(error, '处理售后单失败');
    const validation = /不能为空|不支持|不能|必须|无效|不存在|状态|已变化|已结束|请先确认|不能开始/.test(message);
    return NextResponse.json(errorResponse(validation ? ErrorCode.VALIDATION_ERROR : ErrorCode.DATABASE_ERROR, message), { status: validation ? 400 : 500 });
  }
}
