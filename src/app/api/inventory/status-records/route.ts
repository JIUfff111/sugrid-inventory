import { NextRequest, NextResponse } from 'next/server';
import db from '@/lib/db';
import { assertWarehouseAccess, authErrorResponse, requireRole, requireUser, warehouseScope } from '@/lib/auth';
import { endCustomStatus, serializeInventoryStatus } from '@/lib/inventory-status';
import { errorResponse, formatDateTime, generateId, successResponse } from '@/lib/api-helpers';

function failure(error: unknown) {
  return authErrorResponse(error) || NextResponse.json(errorResponse('VALIDATION_ERROR', error instanceof Error ? error.message : '状态操作失败'), { status: 400 });
}
export async function GET(request: NextRequest) {
  try {
    const user = await requireUser(); const inventoryId = request.nextUrl.searchParams.get('inventoryId');
    const scope = warehouseScope(user,null,'i');
    const items = db.prepare(`SELECT r.*,d.name,d.color,d.allowStockOperations,i.sn,i.brand,i.model,i.year,i.warehouseId AS currentWarehouseId FROM inventory_status_records r
      JOIN inventory i ON i.id = r.inventoryId JOIN inventory_status_definitions d ON d.id = r.definitionId
      WHERE ${scope.sql} ${inventoryId ? 'AND r.inventoryId = ?' : ''} ORDER BY r.createdAt DESC LIMIT 1000`).all(...scope.params,...(inventoryId ? [inventoryId] : []));
    return NextResponse.json(successResponse({ items }));
  } catch (error) { return failure(error); }
}
export async function POST(request: NextRequest) {
  try {
    const user = await requireRole('admin'); const body = await request.json();
    const inventoryId = String(body.inventoryId || '').trim(); const definitionId = String(body.definitionId || '').trim();
    const reason = String(body.reason || '').trim(); const location = String(body.location || '').trim();
    const responsiblePerson = String(body.responsiblePerson || user.realName || user.username).trim();
    const expectedReturnDate = String(body.expectedReturnDate || '').trim() || null;
    if (!inventoryId || !definitionId || !reason || !location) throw new Error('请选择机器和状态，并填写原因、地点');
    if ([reason,location,responsiblePerson].some(value => value.length > 500)) throw new Error('登记信息过长');
    if (expectedReturnDate && (!/^\d{4}-\d{2}-\d{2}$/.test(expectedReturnDate) || Number.isNaN(Date.parse(expectedReturnDate)))) throw new Error('预计归还日期格式不正确');
    const id = generateId('status_record'); const now = formatDateTime();
    db.transaction(() => {
      const item = db.prepare('SELECT * FROM inventory WHERE id = ? AND deleted = 0').get(inventoryId) as { id: string; sn: string; warehouseId: string; status: string; currentStatusRecordId: string | null } | undefined;
      if (!item || item.status !== 'in_stock' || item.currentStatusRecordId) throw new Error('只有普通在库机器可以登记状态');
      assertWarehouseAccess(user,item.warehouseId);
      if (db.prepare("SELECT 1 FROM transfer_items ti JOIN transfers t ON t.id = ti.transferId WHERE ti.inventoryId = ? AND t.status IN ('pending','approved','in_transit')").get(inventoryId)) throw new Error('机器有进行中的调拨申请');
      const definition = db.prepare('SELECT * FROM inventory_status_definitions WHERE id = ? AND isActive = 1').get(definitionId) as Record<string, unknown> | undefined;
      if (!definition) throw new Error('状态不存在或已停用');
      db.prepare(`INSERT INTO inventory_status_records(id,inventoryId,definitionId,definitionSnapshot,reason,location,responsiblePerson,expectedReturnDate,remark,warehouseId,createdBy,createdAt)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(id,inventoryId,definitionId,JSON.stringify(definition),reason,location,responsiblePerson,expectedReturnDate,String(body.remark || '').trim() || null,item.warehouseId,user.id,now);
      if (db.prepare("UPDATE inventory SET status = 'custom',currentStatusRecordId = ?,updatedAt = ? WHERE id = ? AND status = 'in_stock' AND currentStatusRecordId IS NULL").run(id,now,inventoryId).changes !== 1) throw new Error('机器状态已变化');
      db.prepare(`INSERT INTO inventory_movements(id,inventoryId,warehouseId,movementType,referenceType,referenceId,actorId,note,statusFrom,statusTo,snapshot,createdAt)
        VALUES (?,?,?,'custom_status_start','inventory_status',?,?,?,'in_stock','custom',?,?)`).run(generateId('movement'),inventoryId,item.warehouseId,id,user.id,`${definition.name}：${reason}；地点：${location}`,JSON.stringify({ ...item,status:'custom',statusRecord:{id,definition,reason,location,responsiblePerson,expectedReturnDate,remark:body.remark || null} }),now);
    })();
    return NextResponse.json(successResponse(serializeInventoryStatus(db.prepare('SELECT * FROM inventory WHERE id = ?').get(inventoryId) as { id: string })), { status: 201 });
  } catch (error) { return failure(error); }
}
export async function PATCH(request: NextRequest) {
  try {
    const user = await requireRole('admin'); const body = await request.json();
    if (body.action !== 'restore') throw new Error('不支持的状态操作');
    const resultNote = String(body.resultNote || '').trim(); if (!resultNote) throw new Error('请填写处理结果备注');
    let inventoryId = String(body.inventoryId || '').trim();
    if (!inventoryId && body.id) inventoryId = String((db.prepare('SELECT inventoryId FROM inventory_status_records WHERE id = ?').get(String(body.id)) as {inventoryId:string} | undefined)?.inventoryId || '');
    db.transaction(() => {
      const item = db.prepare('SELECT * FROM inventory WHERE id = ? AND deleted = 0').get(inventoryId) as {id:string;status:string;warehouseId:string;currentStatusRecordId:string|null} | undefined;
      if (!item || item.status !== 'custom' || !item.currentStatusRecordId || (body.id && body.id !== item.currentStatusRecordId)) throw new Error('机器状态已变化或已恢复在库');
      assertWarehouseAccess(user,item.warehouseId);
      if (db.prepare("SELECT 1 FROM transfer_items ti JOIN transfers t ON t.id = ti.transferId WHERE ti.inventoryId = ? AND t.status IN ('pending','approved','in_transit')").get(inventoryId)) throw new Error('请先处理或取消机器的调拨申请');
      endCustomStatus(inventoryId,user.id,resultNote,'inventory_status',item.currentStatusRecordId,'in_stock');
      if (db.prepare("UPDATE inventory SET status = 'in_stock', updatedAt = ? WHERE id = ? AND status = 'custom'").run(formatDateTime(),inventoryId).changes !== 1) throw new Error('机器状态已变化');
    })();
    return NextResponse.json(successResponse(serializeInventoryStatus(db.prepare('SELECT * FROM inventory WHERE id = ?').get(inventoryId) as {id:string})));
  } catch (error) { return failure(error); }
}
