import { assertStockEligible, endCustomStatus } from '@/lib/inventory-status';
import { NextRequest, NextResponse } from 'next/server';
import db from '@/lib/db';
import { errorResponse, ErrorCode, generateId, successResponse } from '@/lib/api-helpers';
import { AuthError, requireRole } from '@/lib/auth';

function authError(error: unknown) { return error instanceof AuthError ? NextResponse.json(errorResponse(error.code, error.message), { status: error.status }) : null; }
function idsOf(value: unknown) { return Array.isArray(value) ? [...new Set(value.map((item) => typeof item === 'string' ? item.trim() : String((item as { id?: unknown })?.id || '').trim()).filter(Boolean))] : []; }
function userWarehouseIds(userId: string) { return new Set((db.prepare('SELECT warehouseId FROM user_warehouses WHERE userId = ?').all(userId) as Array<{ warehouseId: string }>).map((row) => row.warehouseId)); }

function completeTransfer(id: string, actorId: string) {
  db.transaction(() => {
    const transfer = db.prepare('SELECT * FROM transfers WHERE id = ?').get(id) as {id:string;sourceWarehouseId:string;targetWarehouseId:string;status:string}|undefined;
    if (!transfer || !['pending','approved','in_transit'].includes(transfer.status)) throw new Error('当前调拨单不能完成');
    if (Number((db.prepare("SELECT COUNT(*) n FROM warehouses WHERE id IN (?,?) AND status='active'").get(transfer.sourceWarehouseId,transfer.targetWarehouseId) as {n:number}).n)!==2) throw new Error('来源仓或目标仓已停用');
    const items = db.prepare('SELECT * FROM transfer_items WHERE transferId=?').all(id) as Array<{id:string;inventoryId:string;sn:string}>;
    if (!items.length) throw new Error('调拨单没有机器明细');
    for (const item of items) { const machine=assertStockEligible(item.inventoryId,id); if(machine.warehouseId!==transfer.sourceWarehouseId) throw new Error('机器来源仓已变化'); }
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
    const body = await request.json() as Record<string, unknown>;
    const sourceWarehouseId = String(body.sourceWarehouseId || '').trim();
    const targetWarehouseId = String(body.targetWarehouseId || '').trim();
    const inventoryIds = idsOf(body.inventoryIds ?? body.items);
    if (!sourceWarehouseId || !targetWarehouseId || sourceWarehouseId === targetWarehouseId || !inventoryIds.length) return NextResponse.json(errorResponse(ErrorCode.VALIDATION_ERROR, '请选择来源仓、目标仓和机器'), { status: 400 });
    const source = db.prepare("SELECT id FROM warehouses WHERE id = ? AND status = 'active'").get(sourceWarehouseId);
    const target = db.prepare("SELECT id FROM warehouses WHERE id = ? AND status = 'active'").get(targetWarehouseId);
    if (!source || !target) return NextResponse.json(errorResponse(ErrorCode.NOT_FOUND, '仓库不存在或已停用'), { status: 404 });
    if (user.role !== 'admin' && !userWarehouseIds(user.id).has(sourceWarehouseId)) return NextResponse.json(errorResponse(ErrorCode.FORBIDDEN, '只能从授权仓库提交调拨申请'), { status: 403 });
    const placeholders = inventoryIds.map(() => '?').join(',');
    const inventory = db.prepare(`SELECT id, sn, warehouseId, status, deleted FROM inventory WHERE id IN (${placeholders})`).all(...inventoryIds) as Array<{ id: string; sn: string; warehouseId: string; status: string; deleted: number }>;
    if (inventory.length !== inventoryIds.length || inventory.some((item) => item.deleted || !['in_stock','custom'].includes(item.status) || item.warehouseId !== sourceWarehouseId)) return NextResponse.json(errorResponse(ErrorCode.VALIDATION_ERROR, '选择的机器必须全部处于来源仓在库状态'), { status: 400 });
    const now = new Date().toISOString(); const id = generateId('transfer'); const transferNo = `TR${now.slice(0, 10).replace(/-/g, '')}${String(Date.now()).slice(-4)}`; const status = user.role === 'admin' && body.action === 'complete' ? 'approved' : 'pending';
    db.transaction(() => {
      for (const item of inventory) {
        const current = assertStockEligible(item.id);
        if (current.warehouseId !== sourceWarehouseId) throw new Error('机器来源仓已变化');
        if (db.prepare("SELECT ti.id FROM transfer_items ti JOIN transfers t ON t.id = ti.transferId WHERE ti.inventoryId = ? AND t.status IN ('pending','approved','in_transit')").get(item.id)) throw new Error('机器 ' + item.sn + ' 已有进行中的调拨申请');
      }
      db.prepare('INSERT INTO transfers (id, transferNo, sourceWarehouseId, targetWarehouseId, status, remark, createdBy, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(id, transferNo, sourceWarehouseId, targetWarehouseId, status, String(body.remark || '').trim() || null, user.id, now, now);
      const insert = db.prepare('INSERT INTO transfer_items (id, transferId, inventoryId, sn, status, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?)');
      for (const item of inventory) insert.run(generateId('transfer_item'), id, item.id, item.sn, status === 'approved' ? 'approved' : 'pending', now, now);
      if (status === 'approved') completeTransfer(id, user.id);
    })();
    return NextResponse.json(successResponse({ id, transferNo, status: status === 'approved' ? 'completed' : status }), { status: 201 });
  } catch (error) { const response = authError(error); if (response) return response; return NextResponse.json(errorResponse(ErrorCode.VALIDATION_ERROR, error instanceof Error ? error.message : '创建调拨失败'), { status: 400 }); }
}

export async function PATCH(request: NextRequest) {
  try {
    const user = await requireRole('admin');
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
        for (const item of transferItems) { const machine=assertStockEligible(item.inventoryId,id); if(machine.warehouseId!==record.sourceWarehouseId) throw new Error('调拨机器仓库已变化'); }
      }
      db.prepare('UPDATE transfers SET status = ?, approvedBy = CASE WHEN ? = ? THEN ? ELSE approvedBy END, approvedAt = CASE WHEN ? = ? THEN ? ELSE approvedAt END, updatedAt = ? WHERE id = ?').run(next[action],action,'approve',user.id,action,'approve',now,now,id);
      db.prepare('UPDATE transfer_items SET status = ?, updatedAt = ? WHERE transferId = ?').run(next[action],now,id);
    })();
    return NextResponse.json(successResponse({ id, action }));
  } catch (error) { const response = authError(error); if (response) return response; return NextResponse.json(errorResponse(ErrorCode.VALIDATION_ERROR, error instanceof Error ? error.message : '调拨操作失败'), { status: 400 }); }
}
