import { assertStockEligible, endCustomStatus, stockEligibleSql, serializeInventoryStatus } from '@/lib/inventory-status';
/**
 * 销售出库与销售记录 API。
 *
 * 保留旧版 sales_records.items JSON 快照，同时写入规范化明细和库存流水，
 * 这样历史页面与库存审计都能读取同一笔销售。
 */
import { NextRequest, NextResponse } from 'next/server';
import db from '@/lib/db';
import { AuthError, requireRole } from '@/lib/auth';
import { ErrorCode, errorResponse, formatDateTime, generateId, successResponse } from '@/lib/api-helpers';

interface InventoryForSale {
  id: string; sn: string; productType: string; brand: string; model: string; year: number | null;
  cpu: string; ram: string; gpu: string | null; storage: string; screen: string; touchScreen: number | null;
  purchasePrice: number; supplierName: string; inboundDate: string; skuRemark: string | null;
  warehouseId?: string | null; status: string;
}
interface SaleItemInput { inventoryId?: unknown; id?: unknown; sellingPrice?: unknown; remark?: unknown; }
interface SaleRequestBody {
  id?: unknown; recordId?: unknown; recordNo?: unknown; action?: unknown; reason?: unknown; cancelReason?: unknown;
  items?: unknown; inventoryIds?: unknown; saleChannelId?: unknown; saleChannel?: unknown; saleOrderNo?: unknown;
  saleDate?: unknown; trackingNo?: unknown; remark?: unknown; actorId?: unknown;
}
type SaleItemSnapshot = {
  inventoryId: string; sn: string; productType?: string; brand?: string; model?: string; year?: number | null;
  cpu?: string; ram?: string; gpu?: string | null; storage?: string; screen?: string; warehouseId?: string | null; touchScreen?: number | null;
  purchasePrice: number; sellingPrice: number; profit: number; remark: string | null;
};

function messageFromError(error: unknown, fallback: string) { return error instanceof Error ? error.message : fallback; }

function tableColumns(table: 'inventory' | 'sales_records' | 'sales_record_items' | 'inventory_movements' | 'sales_channels') {
  try { return new Set((db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((column) => column.name)); }
  catch { return new Set<string>(); }
}
function tableExists(table: string) { return Boolean(db.prepare("SELECT 1 AS value FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)); }
function insertDynamic(table: string, values: Record<string, unknown>) {
  const columns = tableColumns(table as 'inventory' | 'sales_records' | 'sales_record_items' | 'inventory_movements' | 'sales_channels');
  const entries = Object.entries(values).filter(([column]) => columns.has(column));
  if (!entries.length) return;
  const names = entries.map(([column]) => column);
  db.prepare(`INSERT INTO ${table} (${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')})`).run(...entries.map(([, value]) => value));
}
function insertInventoryMovement(values: {
  inventoryId: string; warehouseId?: string | null; fromWarehouseId?: string | null; toWarehouseId?: string | null;
  movementType: string; referenceType: string; referenceId: string; actorId?: string | null; note?: string | null; createdAt: string;
}) {
  if (tableExists('inventory_movements')) insertDynamic('inventory_movements', { id: generateId('movement'), ...values });
}

function normalizeTrackingNo(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new Error('快递单号必须为字符串');
  const trackingNo = value.trim();
  if (trackingNo.length > 100) throw new Error('快递单号不能超过 100 个字符');
  return trackingNo || null;
}
function normalizeDate(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) return formatDateTime().slice(0, 10);
  const dateText = value.trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateText)) throw new Error('销售日期格式不正确');
  const [year, month, day] = dateText.split('-').map(Number); const date = new Date(Date.UTC(year, month - 1, day));
  if (Number.isNaN(date.getTime()) || date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) throw new Error('销售日期无效');
  return dateText;
}
function normalizeItems(body: SaleRequestBody) {
  const rawItems = Array.isArray(body.items) ? body.items : Array.isArray(body.inventoryIds) ? body.inventoryIds.map((inventoryId) => ({ inventoryId })) : [];
  if (!rawItems.length) throw new Error('请至少选择一台在库机器');
  const seen = new Set<string>();
  return rawItems.map((rawItem: unknown) => {
    const item: SaleItemInput = typeof rawItem === 'string' ? { inventoryId: rawItem } : rawItem && typeof rawItem === 'object' ? rawItem as SaleItemInput : {};
    const inventoryId = typeof item.inventoryId === 'string' ? item.inventoryId.trim() : typeof item.id === 'string' ? item.id.trim() : '';
    if (!inventoryId) throw new Error('出库机器信息不完整');
    if (seen.has(inventoryId)) throw new Error('出库机器不能重复选择'); seen.add(inventoryId);
    const sellingPrice = typeof item.sellingPrice === 'number' ? item.sellingPrice : typeof item.sellingPrice === 'string' && item.sellingPrice.trim() ? Number(item.sellingPrice) : NaN;
    if (!Number.isFinite(sellingPrice) || sellingPrice < 0) throw new Error(`机器 ${inventoryId} 的销售价格无效`);
    const remark = item.remark === null || item.remark === undefined ? null : String(item.remark).trim() || null;
    return { inventoryId, sellingPrice, remark };
  });
}
function getActiveChannel(channelId: string, channelName: string) {
  if (channelId) {
    const channel = db.prepare("SELECT id, channelName FROM sales_channels WHERE id = ? AND status = 'active' AND deleted = 0").get(channelId) as { id: string; channelName: string } | undefined;
    if (channel) return channel;
  }
  if (channelName) {
    const channel = db.prepare("SELECT id, channelName FROM sales_channels WHERE channelName = ? AND status = 'active' AND deleted = 0").get(channelName) as { id: string; channelName: string } | undefined;
    if (channel) return channel;
  }
  return undefined;
}
function parseSnapshot(value: unknown): SaleItemSnapshot[] {
  if (typeof value !== 'string') return [];
  try { const parsed = JSON.parse(value); return Array.isArray(parsed) ? parsed as SaleItemSnapshot[] : []; } catch { return []; }
}
function saleRecordSelect(detail = false) {
  const columns = tableColumns('sales_records');
  const fields = ['sr.id', 'sr.recordNo', 'sr.saleChannel', 'sr.saleOrderNo', 'sr.saleDate'];
  fields.push(columns.has('trackingNo') ? 'sr.trackingNo' : 'NULL AS trackingNo');
  fields.push('sr.items', 'sr.totalQuantity', 'sr.totalCost', 'sr.totalAmount', 'sr.totalProfit', 'sr.remark', 'sr.deleted', 'sr.createdBy', 'sr.createdAt');
  fields.push(columns.has('status') ? 'sr.status' : "'completed' AS status");
  if (columns.has('cancelledAt')) fields.push('sr.cancelledAt');
  if (columns.has('cancelledBy')) fields.push('sr.cancelledBy');
  if (columns.has('cancelReason')) fields.push('sr.cancelReason');
  return `SELECT ${fields.join(', ')} FROM sales_records sr WHERE sr.deleted = 0${detail ? '' : ' ORDER BY sr.createdAt DESC, sr.recordNo DESC'}`;
}
function serializeRecord(row: Record<string, any>) {
  let items = parseSnapshot(row.items);
  if (!items.length && tableExists('sales_record_items')) {
    const columns = tableColumns('sales_record_items'); const recordColumn = columns.has('salesRecordId') ? 'salesRecordId' : 'saleRecordId';
    const rows = db.prepare(`SELECT inventoryId, sn, purchasePrice, sellingPrice, profit, remark FROM sales_record_items WHERE ${recordColumn} = ? ORDER BY createdAt`).all(row.id) as SaleItemSnapshot[];
    items = rows.map((item) => ({ ...item, purchasePrice: Number(item.purchasePrice), sellingPrice: Number(item.sellingPrice), profit: Number(item.profit) }));
  }
  return { ...row, items, status: row.status || 'completed' };
}

export async function GET(request: NextRequest) {
  try {
    await requireRole('admin');
    const { searchParams } = new URL(request.url);
    const detailId = searchParams.get('id')?.trim() || searchParams.get('recordId')?.trim() || searchParams.get('recordNo')?.trim();
    if (detailId) {
      const record = db.prepare(`${saleRecordSelect(true)} AND (sr.id = ? OR sr.recordNo = ?)`).get(detailId, detailId) as Record<string, any> | undefined;
      if (!record) return NextResponse.json(errorResponse(ErrorCode.NOT_FOUND, '销售记录不存在'), { status: 404 });
      return NextResponse.json(successResponse(serializeRecord(record)));
    }
    const search = searchParams.get('search')?.trim() || ''; const requestedLimit = Number(searchParams.get('limit') || 100); const limit = Math.min(100, Math.max(1, Number.isFinite(requestedLimit) ? Math.floor(requestedLimit) : 100));
    const params: string[] = []; let where = stockEligibleSql('i');
    for (const term of search.split(/\s+/).filter(Boolean)) { const pattern = `%${term}%`; where += ' AND (i.sn LIKE ? OR i.brand LIKE ? OR i.model LIKE ? OR CAST(i.year AS TEXT) LIKE ? OR i.cpu LIKE ? OR i.ram LIKE ? OR i.storage LIKE ? OR i.supplierName LIKE ?)'; params.push(pattern, pattern, pattern, pattern, pattern, pattern, pattern, pattern); }
    const inventoryColumns = tableColumns('inventory'); const warehouseField = inventoryColumns.has('warehouseId') ? 'i.warehouseId' : "'warehouse_main' AS warehouseId";
    const items = db.prepare(`SELECT i.id, i.sn, i.status, i.currentStatusRecordId, i.productType, i.brand, i.model, i.year, i.cpu, i.ram, i.gpu, i.storage, i.screen, i.touchScreen, i.purchasePrice, i.supplierName, i.inboundDate, i.skuRemark, ${warehouseField} FROM inventory i WHERE ${where} ORDER BY i.createdAt DESC LIMIT ?`).all(...params, limit) as InventoryForSale[];
    const channels = db.prepare("SELECT id, channelName, channelType, usageCount FROM sales_channels WHERE status = 'active' AND deleted = 0 ORDER BY usageCount DESC, createdAt DESC").all();
    const statusFilter = searchParams.get('status')?.trim(); const hasStatus = tableColumns('sales_records').has('status');
    const statusClause = hasStatus && statusFilter && statusFilter !== 'all' ? ' AND sr.status = ?' : '';
    const recordsSql = `${saleRecordSelect(false).replace(' ORDER BY sr.createdAt DESC, sr.recordNo DESC', `${statusClause} ORDER BY sr.createdAt DESC, sr.recordNo DESC LIMIT 20`)}`;
    const recordRows = db.prepare(recordsSql).all(...(statusClause ? [statusFilter] : [])) as Array<Record<string, any>>;
    return NextResponse.json(successResponse({ items: items.map(serializeInventoryStatus), channels, records: recordRows.map(serializeRecord) }));
  } catch (error: unknown) {
    if (error instanceof AuthError) return NextResponse.json(errorResponse(error.code, error.message), { status: error.status });
    console.error('GET /api/sales error:', error); return NextResponse.json(errorResponse(ErrorCode.DATABASE_ERROR, messageFromError(error, '获取销售出库数据失败')), { status: 500 });
  }
}

function nextRecordNo(saleDate: string) {
  const prefix = `XS${saleDate.replace(/-/g, '')}`; const latest = db.prepare('SELECT recordNo FROM sales_records WHERE recordNo LIKE ? ORDER BY recordNo DESC LIMIT 1').get(`${prefix}%`) as { recordNo: string } | undefined; let sequence = latest ? Number(latest.recordNo.slice(prefix.length)) + 1 : 1;
  for (let attempt = 0; attempt < 20; attempt += 1) { const candidate = `${prefix}${String(sequence).padStart(3, '0')}`; if (!db.prepare('SELECT 1 FROM sales_records WHERE recordNo = ?').get(candidate)) return candidate; sequence += 1; }
  throw new Error('销售单号生成失败，请稍后重试');
}

export async function POST(request: NextRequest) {
  try {
    const actor = await requireRole('admin');
    const body = await request.json() as SaleRequestBody;
    if (typeof body.action === 'string' && ['cancel', 'cancelled', 'revoke', 'void'].includes(body.action.trim().toLowerCase())) {
      return PATCH(new NextRequest(request.url, { method: 'PATCH', headers: request.headers, body: JSON.stringify(body) }));
    }
    const trackingNo = normalizeTrackingNo(body.trackingNo); const saleOrderNo = typeof body.saleOrderNo === 'string' ? body.saleOrderNo.trim() : ''; const channelId = typeof body.saleChannelId === 'string' ? body.saleChannelId.trim() : ''; const channelName = typeof body.saleChannel === 'string' ? body.saleChannel.trim() : ''; const remark = body.remark === null || body.remark === undefined ? null : String(body.remark).trim() || null;
    if (!saleOrderNo) throw new Error('销售订单号不能为空'); const channel = getActiveChannel(channelId, channelName); if (!channel) throw new Error('请选择有效的销售渠道'); const saleDate = normalizeDate(body.saleDate); const items = normalizeItems(body); const userId = actor.id;
    const result = db.transaction(() => {
      const inventoryColumns = tableColumns('inventory'); const warehouseField = inventoryColumns.has('warehouseId') ? ', warehouseId' : ''; const inventoryRows: InventoryForSale[] = [];
      for (const item of items) { const inventory = db.prepare(`SELECT id, sn, productType, brand, model, year, cpu, ram, gpu, storage, screen, touchScreen, purchasePrice, supplierName, inboundDate, skuRemark, status${warehouseField} FROM inventory WHERE id = ? AND deleted = 0`).get(item.inventoryId) as InventoryForSale | undefined; if (!inventory) throw new Error(`库存机器不存在：${item.inventoryId}`); assertStockEligible(inventory.id); inventoryRows.push(inventory); }
      const now = formatDateTime(); const recordId = generateId('sale'); const updateInventory = db.prepare("UPDATE inventory SET status = 'sold', soldDate = ?, sellingPrice = ?, saleChannel = ?, saleOrderNo = ?, profit = ?, updatedAt = ? WHERE id = ? AND status IN ('in_stock','custom') AND deleted = 0");
      const saleItems: SaleItemSnapshot[] = inventoryRows.map((inventory, index) => { const input = items[index]; const profit = input.sellingPrice - Number(inventory.purchasePrice); endCustomStatus(inventory.id,userId,'销售出库','sales_record',recordId,'sold'); if (updateInventory.run(saleDate, input.sellingPrice, channel.channelName, saleOrderNo, profit, now, inventory.id).changes !== 1) throw new Error(`SN [${inventory.sn}] 状态已变化，请刷新后重试`); return { inventoryId: inventory.id, sn: inventory.sn, productType: inventory.productType, brand: inventory.brand, model: inventory.model, year: inventory.year, cpu: inventory.cpu, ram: inventory.ram, gpu: inventory.gpu, storage: inventory.storage, screen: inventory.screen, touchScreen: inventory.touchScreen, warehouseId: inventory.warehouseId, purchasePrice: Number(inventory.purchasePrice), sellingPrice: input.sellingPrice, profit, remark: input.remark }; });
      const totalCost = saleItems.reduce((sum, item) => sum + item.purchasePrice, 0); const totalAmount = saleItems.reduce((sum, item) => sum + item.sellingPrice, 0); const totalProfit = saleItems.reduce((sum, item) => sum + item.profit, 0); const recordNo = nextRecordNo(saleDate);
      insertDynamic('sales_records', { id: recordId, recordNo, saleChannel: channel.channelName, saleOrderNo, saleDate, trackingNo, items: JSON.stringify(saleItems), totalQuantity: saleItems.length, totalCost, totalAmount, totalProfit, status: 'completed', remark, deleted: 0, createdBy: userId, createdAt: now });
      if (tableExists('sales_record_items')) for (const item of saleItems) insertDynamic('sales_record_items', { id: generateId('sale_item'), salesRecordId: recordId, saleRecordId: recordId, inventoryId: item.inventoryId, sn: item.sn, warehouseId: item.warehouseId, snapshot: JSON.stringify(item), purchasePrice: item.purchasePrice, sellingPrice: item.sellingPrice, profit: item.profit, remark: item.remark, createdAt: now });
      for (const inventory of inventoryRows) insertInventoryMovement({ inventoryId: inventory.id, warehouseId: inventory.warehouseId || 'warehouse_main', fromWarehouseId: inventory.warehouseId || 'warehouse_main', movementType: 'sale', referenceType: 'sales_record', referenceId: recordId, actorId: userId, note: saleOrderNo, createdAt: now });
      db.prepare('UPDATE sales_channels SET usageCount = usageCount + ?, updatedAt = ? WHERE id = ?').run(saleItems.length, now, channel.id);
      return { id: recordId, recordNo, saleChannel: channel.channelName, saleOrderNo, saleDate, trackingNo, status: 'completed', items: saleItems, totalQuantity: saleItems.length, totalCost, totalAmount, totalProfit, remark };
    })();
    return NextResponse.json(successResponse(result), { status: 201 });
  } catch (error: unknown) {
    if (error instanceof AuthError) return NextResponse.json(errorResponse(error.code, error.message), { status: error.status });
    console.error('POST /api/sales error:', error); const message = messageFromError(error, '销售出库失败'); const isValidation = /不能为空|无效|不存在|请选择|不可销售|不能重复|状态已变化|至少选择|快递单号|生成失败|不可参与|调拨/.test(message); return NextResponse.json(errorResponse(isValidation ? ErrorCode.VALIDATION_ERROR : ErrorCode.DATABASE_ERROR, message), { status: isValidation ? 400 : 500 });
  }
}

function snapshotItemsForRecord(recordId: string, snapshot: string): SaleItemSnapshot[] { const parsed = parseSnapshot(snapshot); if (parsed.length) return parsed; if (!tableExists('sales_record_items')) return []; const columns = tableColumns('sales_record_items'); const recordColumn = columns.has('salesRecordId') ? 'salesRecordId' : 'saleRecordId'; return db.prepare(`SELECT inventoryId, sn, purchasePrice, sellingPrice, profit, remark FROM sales_record_items WHERE ${recordColumn} = ? ORDER BY createdAt`).all(recordId) as SaleItemSnapshot[]; }
function resolveRecord(body: SaleRequestBody) { const value = [body.id, body.recordId, body.recordNo].find((item) => typeof item === 'string' && item.trim()) as string | undefined; if (!value) throw new Error('销售记录 ID 不能为空'); return db.prepare(`${saleRecordSelect(true)} AND (sr.id = ? OR sr.recordNo = ?)`).get(value.trim(), value.trim()) as Record<string, any> | undefined; }

function assertCancellationAllowed(recordId: string, inventoryId: string) {
  const lastMovement = db.prepare(`SELECT movementType, referenceId FROM inventory_movements
    WHERE inventoryId = ? ORDER BY rowid DESC LIMIT 1`).get(inventoryId) as { movementType: string; referenceId: string } | undefined;
  if (lastMovement && (lastMovement.movementType !== 'sale' || lastMovement.referenceId !== recordId)) {
    throw new Error('机器已有后续业务，无法撤销原销售');
  }
  for (const table of ['after_sale_records', 'rental_records']) {
    if (tableExists(table) && db.prepare(`SELECT 1 FROM ${table} WHERE inventoryId = ? AND salesRecordId = ? AND status <> 'cancelled' LIMIT 1`).get(inventoryId, recordId)) {
      throw new Error('销售存在售后或租赁记录，无法撤销');
    }
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const actor = await requireRole('admin');
    const body = await request.json() as SaleRequestBody; const action = typeof body.action === 'string' ? body.action.trim().toLowerCase() : 'cancel'; if (!['cancel', 'cancelled', 'revoke', 'void'].includes(action)) throw new Error('不支持的销售操作'); const record = resolveRecord(body); if (!record) return NextResponse.json(errorResponse(ErrorCode.NOT_FOUND, '销售记录不存在'), { status: 404 }); if (record.status === 'cancelled') return NextResponse.json(successResponse(serializeRecord(record))); if (record.status && record.status !== 'completed') throw new Error('当前销售记录不可撤销'); const userId = actor.id; const reason = typeof body.cancelReason === 'string' ? body.cancelReason.trim() : typeof body.reason === 'string' ? body.reason.trim() : null;
    const result = db.transaction(() => {
      const now = formatDateTime(); const items = snapshotItemsForRecord(record.id, record.items); if (!items.length) throw new Error('销售记录没有机器明细');
      for (const item of items) assertCancellationAllowed(record.id, item.inventoryId);
      const cancellationWarehouseField = tableColumns('inventory').has('warehouseId') ? ', warehouseId' : '';
      for (const item of items) { const inventory = db.prepare(`SELECT id, sn, status${cancellationWarehouseField} FROM inventory WHERE id = ? AND deleted = 0`).get(item.inventoryId) as { id: string; sn: string; status: string; warehouseId?: string | null } | undefined; if (!inventory) throw new Error(`机器 ${item.sn || item.inventoryId} 不存在，无法撤销销售`); if (inventory.status !== 'sold') throw new Error(`SN [${inventory.sn}] 当前状态不是已售，无法撤销`); if (db.prepare("UPDATE inventory SET status = 'in_stock', soldDate = NULL, sellingPrice = NULL, saleChannel = NULL, saleOrderNo = NULL, profit = NULL, updatedAt = ? WHERE id = ? AND status = 'sold' AND deleted = 0").run(now, inventory.id).changes !== 1) throw new Error(`SN [${inventory.sn}] 状态已变化，请刷新后重试`); insertInventoryMovement({ inventoryId: inventory.id, warehouseId: inventory.warehouseId || 'warehouse_main', toWarehouseId: inventory.warehouseId || 'warehouse_main', movementType: 'sale_cancel', referenceType: 'sales_record', referenceId: record.id, actorId: userId, note: reason, createdAt: now }); }
      const columns = tableColumns('sales_records'); const updates: string[] = []; const values: unknown[] = []; if (columns.has('status')) { updates.push('status = ?'); values.push('cancelled'); } if (columns.has('cancelledAt')) { updates.push('cancelledAt = ?'); values.push(now); } if (columns.has('cancelledBy')) { updates.push('cancelledBy = ?'); values.push(userId); } if (columns.has('cancelReason')) { updates.push('cancelReason = ?'); values.push(reason); } if (updates.length) { values.push(record.id); db.prepare(`UPDATE sales_records SET ${updates.join(', ')} WHERE id = ?`).run(...values); } db.prepare('UPDATE sales_channels SET usageCount = MAX(0, usageCount - ?), updatedAt = ? WHERE channelName = ?').run(items.length, now, record.saleChannel); return serializeRecord(db.prepare(`${saleRecordSelect(true)} AND sr.id = ?`).get(record.id) as Record<string, any>);
    })();
    return NextResponse.json(successResponse(result));
  } catch (error: unknown) {
    if (error instanceof AuthError) return NextResponse.json(errorResponse(error.code, error.message), { status: error.status });
    console.error('PATCH /api/sales error:', error); const message = messageFromError(error, '撤销销售失败'); const validation = /不能为空|不支持|不可撤销|没有机器|不存在|状态不是|状态已变化|无法撤销/.test(message); return NextResponse.json(errorResponse(validation ? ErrorCode.VALIDATION_ERROR : ErrorCode.DATABASE_ERROR, message), { status: validation ? 400 : 500 });
  }
}
export async function DELETE(request: NextRequest) { const { searchParams } = new URL(request.url); const id = searchParams.get('id') || searchParams.get('recordId') || searchParams.get('recordNo'); return PATCH(new NextRequest(request.url, { method: 'PATCH', headers: request.headers, body: JSON.stringify({ id, action: 'cancel', reason: searchParams.get('reason') || undefined }) })); }
