/** 销售退货入库：按 SN 查询已售机器，并将其恢复到指定仓库。 */
import { NextRequest, NextResponse } from 'next/server';
import db from '@/lib/db';
import { ErrorCode, errorResponse, formatDateTime, generateId, successResponse } from '@/lib/api-helpers';
import { AuthError, requireRole } from '@/lib/auth';

function messageOf(error: unknown, fallback: string) { return error instanceof Error ? error.message : fallback; }
function columns(table: 'inventory' | 'return_receipts' | 'inventory_movements' | 'sales_record_items' | 'warehouses') {
  try { return new Set((db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((item) => item.name)); } catch { return new Set<string>(); }
}
function exists(table: string) { return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)); }
function dynamicInsert(table: 'return_receipts' | 'inventory_movements', values: Record<string, unknown>) {
  const available = columns(table); const entries = Object.entries(values).filter(([name]) => available.has(name)); if (!entries.length) return;
  const names = entries.map(([name]) => name); db.prepare(`INSERT INTO ${table} (${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')})`).run(...entries.map(([, value]) => value));
}
function defaultWarehouse(inventoryWarehouse?: string | null) { return inventoryWarehouse?.trim() || 'warehouse_main'; }
function validateWarehouse(id: string) {
  if (!exists('warehouses')) return;
  const row = db.prepare("SELECT id FROM warehouses WHERE id = ? AND status = 'active'").get(id);
  if (!row) throw new Error('入库仓库不存在或已停用');
}
function nextReceiptNo(date: string) {
  const prefix = `SR${date.replace(/-/g, '')}`; const row = db.prepare('SELECT receiptNo FROM return_receipts WHERE receiptNo LIKE ? ORDER BY receiptNo DESC LIMIT 1').get(`${prefix}%`) as { receiptNo: string } | undefined; let seq = row ? Number(row.receiptNo.slice(prefix.length)) + 1 : 1;
  for (let i = 0; i < 20; i += 1) { const value = `${prefix}${String(seq).padStart(3, '0')}`; if (!db.prepare('SELECT 1 FROM return_receipts WHERE receiptNo = ?').get(value)) return value; seq += 1; }
  throw new Error('退货入库单号生成失败，请稍后重试');
}

function candidateBySn(sn: string) {
  const inventoryColumns = columns('inventory'); const warehouseField = inventoryColumns.has('warehouseId') ? 'i.warehouseId' : "'warehouse_main' AS warehouseId";
  return db.prepare(`SELECT i.id, i.sn, i.productType, i.brand, i.model, i.year, i.cpu, i.ram, i.gpu, i.storage, i.screen, i.touchScreen, i.purchasePrice, i.sellingPrice, i.saleChannel, i.saleOrderNo, i.status, ${warehouseField}, i.inboundDate, i.supplierName FROM inventory i WHERE i.deleted = 0 AND i.status = 'sold' AND i.sn = ?`).get(sn) as Record<string, any> | undefined;
}

export async function GET(request: NextRequest) {
  try {
    await requireRole('admin');
    const sn = new URL(request.url).searchParams.get('sn')?.trim() || new URL(request.url).searchParams.get('search')?.trim() || '';
    if (!sn) {
      const rows = db.prepare(`SELECT rr.*, COALESCE(w.name, w.warehouseName) AS warehouseName,
        COALESCE(u.realName, u.username) AS receivedByName FROM return_receipts rr
        LEFT JOIN warehouses w ON w.id = rr.warehouseId LEFT JOIN users u ON u.id = rr.receivedBy
        WHERE rr.returnOrderId IS NULL ORDER BY rr.createdAt DESC, rr.rowid DESC LIMIT 100`).all() as Array<Record<string, any>>;
      return NextResponse.json(successResponse({ items: rows.map((row) => {
        let snapshot = null;
        try { snapshot = JSON.parse(row.snapshot || 'null'); } catch { /* Preserve older receipts. */ }
        return { ...row, snapshot, remark: row.note };
      }) }));
    }
    const item = candidateBySn(sn);
    if (!item) return NextResponse.json(errorResponse(ErrorCode.NOT_FOUND, '未找到可退货的已售机器'), { status: 404 });
    return NextResponse.json(successResponse({ item, ...item }));
  } catch (error: unknown) {
    if (error instanceof AuthError) return NextResponse.json(errorResponse(error.code, error.message), { status: error.status });
    console.error('GET /api/sales-returns error:', error); return NextResponse.json(errorResponse(ErrorCode.DATABASE_ERROR, messageOf(error, '查询销售退货机器失败')), { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const user = await requireRole('admin');
    const body = await request.json() as { sn?: unknown; inventoryId?: unknown; warehouseId?: unknown; purchasePrice?: unknown; reason?: unknown; remark?: unknown; condition?: unknown };
    const sn = typeof body.sn === 'string' ? body.sn.trim() : ''; const inventoryId = typeof body.inventoryId === 'string' ? body.inventoryId.trim() : '';
    if (!sn && !inventoryId) throw new Error('SN 不能为空');
    const inventoryColumns = columns('inventory'); const warehouseField = inventoryColumns.has('warehouseId') ? ', warehouseId' : ''; const row = (sn ? db.prepare(`SELECT id, sn, status, purchasePrice, sellingPrice, saleChannel, saleOrderNo${warehouseField} FROM inventory WHERE sn = ? AND deleted = 0`).get(sn) : db.prepare(`SELECT id, sn, status, purchasePrice, sellingPrice, saleChannel, saleOrderNo${warehouseField} FROM inventory WHERE id = ? AND deleted = 0`).get(inventoryId)) as { id: string; sn: string; status: string; purchasePrice: number; sellingPrice: number | null; saleChannel: string | null; saleOrderNo: string | null; warehouseId?: string | null } | undefined;
    if (!row) throw new Error('库存机器不存在'); if (row.status !== 'sold') throw new Error(`SN [${row.sn}] 当前不是已售状态，不能办理销售退货`);
    const targetWarehouse = typeof body.warehouseId === 'string' && body.warehouseId.trim() ? body.warehouseId.trim() : defaultWarehouse(row.warehouseId); validateWarehouse(targetWarehouse);
    const purchasePrice = body.purchasePrice === undefined || body.purchasePrice === null || body.purchasePrice === '' ? Number(row.purchasePrice) : Number(body.purchasePrice); if (!Number.isFinite(purchasePrice) || purchasePrice < 0) throw new Error('入库成本无效');
    const reason = typeof body.reason === 'string' ? body.reason.trim() || '客户退货' : '客户退货'; const remark = body.remark === null || body.remark === undefined ? null : String(body.remark).trim() || null; const userId = user.id;
    const result = db.transaction(() => {
      const now = formatDateTime(); const date = now.slice(0, 10); const receiptId = generateId('return_receipt'); const receiptNo = exists('return_receipts') ? nextReceiptNo(date) : `SR${date.replace(/-/g, '')}${Date.now().toString().slice(-3)}`;
      const sale = db.prepare(`SELECT sr.id, sr.items, sr.saleOrderNo, sr.saleChannel FROM sales_records sr
        JOIN sales_record_items si ON si.salesRecordId = sr.id
        WHERE si.inventoryId = ? AND sr.status = 'completed' AND sr.deleted = 0
        ORDER BY sr.createdAt DESC, sr.rowid DESC LIMIT 1`).get(row.id) as { id: string; items: string; saleOrderNo: string; saleChannel: string } | undefined;
      const snapshot = candidateBySn(row.sn);
      const updates = ['status = \'in_stock\'', 'purchasePrice = ?', 'soldDate = NULL', 'sellingPrice = NULL', 'saleChannel = NULL', 'saleOrderNo = NULL', 'profit = NULL', 'updatedAt = ?']; const values: unknown[] = [purchasePrice, now]; if (inventoryColumns.has('warehouseId')) { updates.splice(1, 0, 'warehouseId = ?'); values.splice(0, 0, targetWarehouse); } values.push(row.id);
      if (db.prepare(`UPDATE inventory SET ${updates.join(', ')} WHERE id = ? AND status = 'sold' AND deleted = 0`).run(...values).changes !== 1) throw new Error(`SN [${row.sn}] 状态已变化，请刷新后重试`);
      if (exists('return_receipts')) dynamicInsert('return_receipts', { id: receiptId, receiptNo, returnOrderId: null, returnId: null, inventoryId: row.id, sn: row.sn, salesRecordId: sale?.id || null, warehouseId: targetWarehouse, purchasePrice, reason, snapshot: JSON.stringify(snapshot), status: 'received', receivedAt: now, receivedBy: userId, condition: typeof body.condition === 'string' ? body.condition.trim() || reason : reason, note: remark, createdAt: now });
      if (exists('inventory_movements')) dynamicInsert('inventory_movements', { id: generateId('movement'), inventoryId: row.id, warehouseId: targetWarehouse, fromWarehouseId: row.warehouseId || 'warehouse_main', toWarehouseId: targetWarehouse, movementType: 'sales_return', referenceType: 'return_receipt', referenceId: receiptId, actorId: userId, note: remark || reason, createdAt: now });
      return { id: receiptId, receiptNo, inventoryId: row.id, sn: row.sn, warehouseId: targetWarehouse, purchasePrice, reason, remark, status: 'received', receivedAt: now };
    })();
    return NextResponse.json(successResponse(result), { status: 201 });
  } catch (error: unknown) {
    if (error instanceof AuthError) return NextResponse.json(errorResponse(error.code, error.message), { status: error.status });
    console.error('POST /api/sales-returns error:', error); const message = messageOf(error, '销售退货入库失败'); const validation = /不能为空|不存在|不是已售|不能办理|无效|状态已变化|停用|生成失败/.test(message); return NextResponse.json(errorResponse(validation ? ErrorCode.VALIDATION_ERROR : ErrorCode.DATABASE_ERROR, message), { status: validation ? 400 : 500 });
  }
}
