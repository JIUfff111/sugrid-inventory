import { assertInventoryOperationEligible, endCustomStatus } from '@/lib/inventory-status';
import { NextRequest, NextResponse } from 'next/server';
import db from '@/lib/db';
import { errorResponse, ErrorCode, generateId, successResponse } from '@/lib/api-helpers';
import { assertInventoryView, AuthError, requireRole } from '@/lib/auth';

function authError(error: unknown) { return error instanceof AuthError ? NextResponse.json(errorResponse(error.code, error.message), { status: error.status }) : null; }
function idsOf(value: unknown) { return Array.isArray(value) ? [...new Set(value.map((item) => typeof item === 'string' ? item.trim() : String((item as { id?: unknown })?.id || '').trim()).filter(Boolean))] : []; }
function userWarehouseIds(userId: string) { return new Set((db.prepare('SELECT warehouseId FROM user_warehouses WHERE userId = ?').all(userId) as Array<{ warehouseId: string }>).map((row) => row.warehouseId)); }

type TransferBatch = { sourceWarehouseId: string; inventoryIds: string[] };
type TransferPreviewItem = { id: string; sn: string; sourceWarehouseId: string; eligible: boolean; reason: string | null };

function transferBlockReason(inventoryId: string, sourceWarehouseId: string, user: { id: string; role: string }, accessibleWarehouseIds: Set<string> | null) {
  if (accessibleWarehouseIds && !accessibleWarehouseIds.has(sourceWarehouseId)) {
    return { sn: inventoryId, reason: '当前账号没有该来源仓的操作权限' };
  }
  const item = db.prepare(`SELECT i.id,i.sn,i.status,i.deleted,i.warehouseId,w.status AS warehouseStatus
    FROM inventory i LEFT JOIN warehouses w ON w.id=i.warehouseId WHERE i.id=?`).get(inventoryId) as {
      id: string; sn: string; status: string; deleted: number; warehouseId: string; warehouseStatus: string | null;
    } | undefined;
  if (!item || item.deleted) return { sn: item?.sn || inventoryId, reason: '机器不存在或已删除' };
  if (item.warehouseId !== sourceWarehouseId) return { sn: item.sn, reason: '机器所属仓库已变化' };
  if (item.warehouseStatus !== 'active') return { sn: item.sn, reason: '机器管理仓已停用' };
  if (user.role !== 'admin' && !userWarehouseIds(user.id).has(item.warehouseId)) return { sn: item.sn, reason: '当前账号没有该来源仓的操作权限' };
  const reservation = db.prepare(`SELECT t.transferNo FROM transfer_items ti JOIN transfers t ON t.id=ti.transferId
    WHERE ti.inventoryId=? AND t.status IN ('pending','approved','in_transit') LIMIT 1`).get(inventoryId) as { transferNo: string } | undefined;
  if (reservation) return { sn: item.sn, reason: `已被调拨单 ${reservation.transferNo} 占用` };
  if (item.status === 'in_stock') return { sn: item.sn, reason: null };
  if (item.status === 'custom') {
    const status = db.prepare(`SELECT d.name,csr.allowTransfers,d.allowStockOperations FROM inventory_status_records csr
      JOIN inventory_status_definitions d ON d.id=csr.definitionId
      WHERE csr.id=(SELECT currentStatusRecordId FROM inventory WHERE id=?) AND csr.inventoryId=? AND csr.closedAt IS NULL`)
      .get(inventoryId, inventoryId) as { name: string; allowTransfers: number | null; allowStockOperations: number } | undefined;
    if (!status) return { sn: item.sn, reason: '当前机器状态记录不完整，请先核对状态登记' };
    if (Number(status.allowTransfers ?? status.allowStockOperations) !== 1) return { sn: item.sn, reason: `“${status.name}”状态未开放调拨` };
    return { sn: item.sn, reason: null };
  }
  const labels: Record<string, string> = { sold: '已售', rented: '租赁中', returned: '已退货', returning: '退供应商处理中', after_sale: '售后处理中' };
  return { sn: item.sn, reason: `机器当前为“${labels[item.status] || item.status}”，不可调拨` };
}

function nextTransferNo(now: string) {
  const prefix = `TR${now.slice(0, 10).replace(/-/g, '')}`;
  let sequence = Date.now() % 10000;
  let transferNo = '';
  do {
    transferNo = `${prefix}${String(sequence).padStart(4, '0')}`;
    sequence = (sequence + 1) % 10000;
  } while (db.prepare('SELECT 1 FROM transfers WHERE transferNo = ?').get(transferNo));
  return transferNo;
}

function completeTransfer(id: string, actorId: string) {
  db.transaction(() => {
    const transfer = db.prepare('SELECT * FROM transfers WHERE id = ?').get(id) as {id:string;sourceWarehouseId:string;targetWarehouseId:string;status:string}|undefined;
    if (!transfer || !['pending','approved','in_transit'].includes(transfer.status)) throw new Error('当前调拨单不能完成');
    if (Number((db.prepare("SELECT COUNT(*) n FROM warehouses WHERE id IN (?,?) AND status='active'").get(transfer.sourceWarehouseId,transfer.targetWarehouseId) as {n:number}).n)!==2) throw new Error('来源仓或目标仓已停用');
    const items = db.prepare('SELECT * FROM transfer_items WHERE transferId=?').all(id) as Array<{id:string;inventoryId:string;sn:string}>;
    if (!items.length) throw new Error('调拨单没有机器明细');
    for (const item of items) { const machine=assertInventoryOperationEligible(item.inventoryId,'transfers',id); if(machine.warehouseId!==transfer.sourceWarehouseId) throw new Error('机器来源仓已变化'); }
    const now = new Date().toISOString();
    // Release this order's reservation inside the same transaction before changing lifecycle status.
    db.prepare("UPDATE transfers SET status='completed',completedAt=?,approvedBy=COALESCE(approvedBy,?),approvedAt=COALESCE(approvedAt,?),updatedAt=? WHERE id=?").run(now,actorId,now,now,id);
    for (const item of items) {
      endCustomStatus(item.inventoryId,actorId,'调拨完成并恢复普通在库','transfer',id,'in_stock');
      if(db.prepare("UPDATE inventory SET warehouseId=?,status='in_stock',updatedAt=? WHERE id=? AND warehouseId=? AND status IN ('in_stock','custom') AND deleted=0").run(transfer.targetWarehouseId,now,item.inventoryId,transfer.sourceWarehouseId).changes!==1) throw new Error('机器状态或仓库已变化');
      const move=db.prepare('INSERT INTO inventory_movements(id,inventoryId,warehouseId,fromWarehouseId,toWarehouseId,movementType,referenceType,referenceId,actorId,note,createdAt) VALUES (?,?,?,?,?,?,?, ?,?,?,?)');
      move.run(generateId('movement'),item.inventoryId,transfer.sourceWarehouseId,transfer.sourceWarehouseId,transfer.targetWarehouseId,'transfer_out','transfer',id,actorId,'仓库调拨出库',now);
      move.run(generateId('movement'),item.inventoryId,transfer.targetWarehouseId,transfer.sourceWarehouseId,transfer.targetWarehouseId,'transfer_in','transfer',id,actorId,'仓库调拨入库',now);
      db.prepare("UPDATE transfer_items SET status='completed',updatedAt=? WHERE id=?").run(now,item.id);
    }
  })();
}

export async function GET(request: NextRequest) {
  try {
    const user = await requireRole('admin', 'warehouse_manager');
    assertInventoryView(user);
    const query = new URL(request.url).searchParams;
    const status = query.get('status')?.trim() || '';
    const id = query.get('id')?.trim() || '';
    const conditions = ['1 = 1']; const params: string[] = [];
    if (id) { conditions.push('t.id = ?'); params.push(id); }
    if (status && status !== 'all') { conditions.push('t.status = ?'); params.push(status); }
    if (user.role !== 'admin') { conditions.push('(t.createdBy = ? OR t.sourceWarehouseId IN (SELECT warehouseId FROM user_warehouses WHERE userId = ?))'); params.push(user.id, user.id); }
    const rows = db.prepare(`SELECT t.*, sw.name AS sourceWarehouseName, tw.name AS targetWarehouseName, (SELECT COUNT(*) FROM transfer_items ti WHERE ti.transferId = t.id) AS itemCount FROM transfers t LEFT JOIN warehouses sw ON sw.id = t.sourceWarehouseId LEFT JOIN warehouses tw ON tw.id = t.targetWarehouseId WHERE ${conditions.join(' AND ')} ORDER BY t.createdAt DESC`).all(...params);
    const details = (rows as Array<Record<string, unknown>>).map(row => ({...row, items: db.prepare('SELECT ti.*, i.brand, i.model, i.year FROM transfer_items ti JOIN inventory i ON i.id = ti.inventoryId WHERE ti.transferId = ?').all(row.id)}));
    return NextResponse.json(successResponse(id ? details[0] || null : details));
  } catch (error) { const response = authError(error); if (response) return response; return NextResponse.json(errorResponse(ErrorCode.DATABASE_ERROR, error instanceof Error ? error.message : '获取调拨记录失败'), { status: 500 }); }
}

export async function POST(request: NextRequest) {
  try {
    const user = await requireRole('admin', 'warehouse_manager');
    assertInventoryView(user);
    const body = await request.json() as Record<string, unknown>;
    const action = String(body.action || '').trim();
    const targetWarehouseId = String(body.targetWarehouseId || '').trim();
    const batches = Array.isArray(body.batches)
      ? body.batches.map((value) => {
        const batch = value && typeof value === 'object' ? value as Record<string, unknown> : {};
        return { sourceWarehouseId: String(batch.sourceWarehouseId || '').trim(), inventoryIds: idsOf(batch.inventoryIds) };
      })
      : [{ sourceWarehouseId: String(body.sourceWarehouseId || '').trim(), inventoryIds: idsOf(body.inventoryIds ?? body.items) }];
    const uniqueIds = new Set<string>();
    const invalidBatch = batches.some((batch: TransferBatch) => {
      if (!batch.sourceWarehouseId || !batch.inventoryIds.length) return true;
      for (const id of batch.inventoryIds) {
        if (uniqueIds.has(id)) return true;
        uniqueIds.add(id);
      }
      return false;
    });
    if (!batches.length || batches.length > 50 || invalidBatch || uniqueIds.size > 200) {
      return NextResponse.json(errorResponse(ErrorCode.VALIDATION_ERROR, '请检查调拨目标仓、来源仓和机器清单；每次最多调拨 200 台机器'), { status: 400 });
    }
    if (action === 'preview') {
      const items: TransferPreviewItem[] = [];
      const accessibleWarehouseIds = user.role === 'admin' ? null : userWarehouseIds(user.id);
      for (const batch of batches as TransferBatch[]) {
        for (const inventoryId of batch.inventoryIds) {
          const result = transferBlockReason(inventoryId, batch.sourceWarehouseId, user, accessibleWarehouseIds);
          items.push({ id: inventoryId, sn: result.sn, sourceWarehouseId: batch.sourceWarehouseId, eligible: !result.reason, reason: result.reason });
        }
      }
      return NextResponse.json(successResponse({ items, count: items.length }));
    }
    const target = db.prepare("SELECT id FROM warehouses WHERE id = ? AND status = 'active'").get(targetWarehouseId);
    if (!targetWarehouseId || !target || (batches as TransferBatch[]).some(batch => batch.sourceWarehouseId === targetWarehouseId)) {
      return NextResponse.json(errorResponse(ErrorCode.VALIDATION_ERROR, '请选择有效的目标仓，且目标仓不能与任一来源仓相同'), { status: 400 });
    }
    if (batches.some((batch: TransferBatch) => !db.prepare("SELECT id FROM warehouses WHERE id = ? AND status = 'active'").get(batch.sourceWarehouseId))) {
      return NextResponse.json(errorResponse(ErrorCode.NOT_FOUND, '来源仓不存在或已停用'), { status: 404 });
    }
    if (user.role !== 'admin') {
      const accessible = userWarehouseIds(user.id);
      if (batches.some((batch: TransferBatch) => !accessible.has(batch.sourceWarehouseId))) return NextResponse.json(errorResponse(ErrorCode.FORBIDDEN, '只能从授权仓库提交调拨申请'), { status: 403 });
    }

    const now = new Date().toISOString();
    const status = user.role === 'admin' && body.action === 'complete' ? 'approved' : 'pending';
    const remark = String(body.remark || '').trim() || null;
    const transfers: Array<{ id: string; transferNo: string; status: string; sourceWarehouseId: string; itemCount: number }> = [];
    db.transaction(() => {
      const insertTransfer = db.prepare('INSERT INTO transfers (id, transferNo, sourceWarehouseId, targetWarehouseId, status, remark, createdBy, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
      const insertItem = db.prepare('INSERT INTO transfer_items (id, transferId, inventoryId, sn, status, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?)');
      for (const batch of batches as TransferBatch[]) {
        const id = generateId('transfer');
        const transferNo = nextTransferNo(now);
        const items = db.prepare(`SELECT id, sn, warehouseId, status, deleted FROM inventory WHERE id IN (${batch.inventoryIds.map(() => '?').join(',')})`).all(...batch.inventoryIds) as Array<{ id: string; sn: string; warehouseId: string; status: string; deleted: number }>;
        if (items.length !== batch.inventoryIds.length) throw new Error('部分所选机器不存在或已从库存移除');
        for (const item of items) {
          if (item.deleted || item.warehouseId !== batch.sourceWarehouseId) throw new Error(`机器 ${item.sn} 的来源仓已变化`);
          assertInventoryOperationEligible(item.id, 'transfers');
        }
        insertTransfer.run(id, transferNo, batch.sourceWarehouseId, targetWarehouseId, status, remark, user.id, now, now);
        for (const item of items) insertItem.run(generateId('transfer_item'), id, item.id, item.sn, status, now, now);
        if (status === 'approved') completeTransfer(id, user.id);
        transfers.push({ id, transferNo, status: status === 'approved' ? 'completed' : status, sourceWarehouseId: batch.sourceWarehouseId, itemCount: items.length });
      }
    }).immediate();
    return NextResponse.json(successResponse({ ...transfers[0], transfers }), { status: 201 });
  } catch (error) { const response = authError(error); if (response) return response; return NextResponse.json(errorResponse(ErrorCode.VALIDATION_ERROR, error instanceof Error ? error.message : '创建调拨失败'), { status: 400 }); }
}

export async function PATCH(request: NextRequest) {
  try {
    const user = await requireRole('admin');
    assertInventoryView(user);
    const body = await request.json() as Record<string, unknown>; const id = String(body.id || body.transferId || '').trim(); const action = String(body.action || '').trim();
    if (!id || !['approve', 'reject', 'complete', 'cancel', 'start_transit'].includes(action)) return NextResponse.json(errorResponse(ErrorCode.VALIDATION_ERROR, '调拨操作参数无效'), { status: 400 });
    const now = new Date().toISOString();
    if (action === 'complete') {
      completeTransfer(id, user.id);
    } else db.transaction(() => {
      const record = db.prepare('SELECT status,sourceWarehouseId,targetWarehouseId FROM transfers WHERE id = ?').get(id) as { status: string; sourceWarehouseId: string; targetWarehouseId: string } | undefined;
      if (!record) throw new Error('调拨单不存在');
      const allowed: Record<string,string[]> = { approve:['pending'], reject:['pending'], cancel:['pending','approved','in_transit'], start_transit:['approved'] };
      if (!allowed[action].includes(record.status)) throw new Error('调拨单状态已变化或不能执行该操作');
      const next: Record<string,string> = {approve:'approved',reject:'rejected',cancel:'cancelled',start_transit:'in_transit'};
      if (action === 'approve' || action === 'start_transit') {
        const transferItems = db.prepare('SELECT inventoryId FROM transfer_items WHERE transferId=?').all(id) as Array<{inventoryId:string}>;
        for (const item of transferItems) { const machine=assertInventoryOperationEligible(item.inventoryId,'transfers',id); if(machine.warehouseId!==record.sourceWarehouseId) throw new Error('调拨机器仓库已变化'); }
      }
      db.prepare('UPDATE transfers SET status = ?, approvedBy = CASE WHEN ? = ? THEN ? ELSE approvedBy END, approvedAt = CASE WHEN ? = ? THEN ? ELSE approvedAt END, updatedAt = ? WHERE id = ?').run(next[action],action,'approve',user.id,action,'approve',now,now,id);
      db.prepare('UPDATE transfer_items SET status = ?, updatedAt = ? WHERE transferId = ?').run(next[action],now,id);
    })();
    return NextResponse.json(successResponse({ id, action }));
  } catch (error) { const response = authError(error); if (response) return response; return NextResponse.json(errorResponse(ErrorCode.VALIDATION_ERROR, error instanceof Error ? error.message : '调拨操作失败'), { status: 400 }); }
}
