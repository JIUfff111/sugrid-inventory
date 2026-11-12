import { NextRequest, NextResponse } from 'next/server';
import db from '@/lib/db';
import { assertInventoryView, assertWarehouseAccess, authErrorResponse, AuthError, requireRole } from '@/lib/auth';
import { serializeInventoryStatus } from '@/lib/inventory-status';
import { errorResponse, formatDateTime, generateId, successResponse } from '@/lib/api-helpers';

type InventoryRow = {
  id: string;
  sn: string;
  brand: string;
  model: string;
  year: number | null;
  warehouseId: string;
  warehouseName: string;
  status: string;
  currentStatusRecordId: string | null;
  deleted: number;
};

type BlockedMachine = { id: string; sn?: string; reason: string };
class BatchConflict extends Error {
  constructor(readonly blocked: BlockedMachine[]) {
    super('所选机器状态已变化，请检查不能登记的机器后重试');
  }
}

function normalizeIds(value: unknown) {
  if (!Array.isArray(value) || value.length === 0) throw new Error('请至少选择一台机器');
  if (value.length > 100) throw new Error('一次最多批量登记 100 台机器');
  const ids = value.map(item => typeof item === 'string' ? item.trim() : '');
  if (ids.some(id => !id)) throw new Error('机器列表包含无效记录');
  if (new Set(ids).size !== ids.length) throw new Error('机器列表包含重复记录');
  return ids;
}

function normalizeForm(body: Record<string, unknown>) {
  const definitionId = typeof body.definitionId === 'string' ? body.definitionId.trim() : '';
  if (!definitionId) throw new Error('请选择机器状态');
  const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
  const location = typeof body.location === 'string' ? body.location.trim() : '';
  const responsiblePerson = typeof body.responsiblePerson === 'string' ? body.responsiblePerson.trim() : '';
  const expectedReturnDate = typeof body.expectedReturnDate === 'string' ? body.expectedReturnDate.trim() || null : null;
  const remark = typeof body.remark === 'string' ? body.remark.trim() : '';
  if ([reason, location, responsiblePerson, remark].some(value => value.length > 500)) throw new Error('登记信息不能超过 500 个字符');
  if (expectedReturnDate && (!/^\d{4}-\d{2}-\d{2}$/.test(expectedReturnDate) || Number.isNaN(Date.parse(expectedReturnDate)))) {
    throw new Error('预计归还日期格式不正确');
  }
  return { definitionId, reason, location, responsiblePerson, expectedReturnDate, remark: remark || null };
}

function inspectMachine(id: string, user: Awaited<ReturnType<typeof requireRole>>) {
  const item = db.prepare(`SELECT i.*,
      COALESCE(w.name,w.warehouseName,w.code) AS warehouseName
    FROM inventory i LEFT JOIN warehouses w ON w.id=i.warehouseId WHERE i.id=?`).get(id) as InventoryRow | undefined;
  if (!item) return { blocked: { id, reason: '机器不存在或已删除' } as BlockedMachine };
  try {
    assertWarehouseAccess(user, item.warehouseId);
  } catch {
    return { blocked: { id, reason: '无权管理该仓库中的机器' } as BlockedMachine };
  }
  if (item.deleted) return { blocked: { id, sn: item.sn, reason: '机器已删除' } as BlockedMachine };
  if (item.status !== 'in_stock' || item.currentStatusRecordId) {
    return { blocked: { id, sn: item.sn, reason: '仅普通在库机器可以登记状态' } as BlockedMachine };
  }
  if (db.prepare("SELECT 1 FROM transfer_items ti JOIN transfers t ON t.id=ti.transferId WHERE ti.inventoryId=? AND t.status IN ('pending','approved','in_transit') LIMIT 1").get(id)) {
    return { blocked: { id, sn: item.sn, reason: '机器有进行中的调拨申请' } as BlockedMachine };
  }
  return { item };
}

function inspectSelection(ids: string[], user: Awaited<ReturnType<typeof requireRole>>) {
  const eligible: InventoryRow[] = [];
  const blocked: BlockedMachine[] = [];
  for (const id of ids) {
    const result = inspectMachine(id, user);
    if (result.blocked) blocked.push(result.blocked);
    else eligible.push(result.item);
  }
  return { eligible, blocked };
}

function resolveSerials(value: unknown, user: Awaited<ReturnType<typeof requireRole>>) {
  if (!Array.isArray(value) || value.length === 0) throw new Error('请先提供机器 SN');
  if (value.length > 100) throw new Error('一次最多识别 100 个 SN');
  const resolved: Array<{ input: string; item?: InventoryRow; blocked?: BlockedMachine }> = [];
  const findBySerial = db.prepare(`SELECT id FROM inventory
    WHERE lower(sn)=lower(?) OR lower(COALESCE(itemNumber,''))=lower(?)
    ORDER BY CASE WHEN lower(sn)=lower(?) THEN 0 ELSE 1 END LIMIT 1`);
  for (const raw of value) {
    const serial = typeof raw === 'string' ? raw.replace(/^\uFEFF/, '').trim() : '';
    if (!serial || serial.length > 200) {
      resolved.push({ input: serial, blocked: { id: serial || '无效 SN', sn: serial || undefined, reason: 'SN 为空或长度无效' } });
      continue;
    }
    const found = findBySerial.get(serial, serial, serial) as { id: string } | undefined;
    if (!found) {
      resolved.push({ input: serial, blocked: { id: serial, sn: serial, reason: '系统中未找到此 SN' } });
      continue;
    }
    const result = inspectMachine(found.id, user);
    if (result.blocked) resolved.push({ input: serial, blocked: { ...result.blocked, sn: result.blocked.sn || serial } });
    else resolved.push({ input: serial, item: result.item });
  }
  return resolved;
}

function snapshotMachine(item: InventoryRow, statusRecord: Record<string, unknown>) {
  return JSON.stringify({ ...item, status: 'custom', statusRecord });
}

export async function POST(request: NextRequest) {
  try {
    const user = await requireRole('admin');
    assertInventoryView(user);
    const body = await request.json() as Record<string, unknown>;
    if (body.action === 'resolve') {
      const resolved = resolveSerials(body.serials, user);
      return NextResponse.json(successResponse({
        eligible: resolved.flatMap(row => row.item ? [{
          id: row.item.id, sn: row.item.sn, brand: row.item.brand, model: row.item.model, year: row.item.year,
          warehouseId: row.item.warehouseId, warehouseName: row.item.warehouseName, status: row.item.status,
        }] : []),
        blocked: resolved.flatMap(row => row.blocked ? [row.blocked] : []),
      }));
    }
    const ids = normalizeIds(body.inventoryIds);
    const inspected = inspectSelection(ids, user);

    if (body.action === 'preview') {
      return NextResponse.json(successResponse({
        eligible: inspected.eligible.map(item => ({
          id: item.id, sn: item.sn, brand: item.brand, model: item.model, year: item.year,
          warehouseId: item.warehouseId, warehouseName: item.warehouseName,
        })),
        blocked: inspected.blocked,
      }));
    }
    if (body.action !== 'register') throw new Error('不支持的批量状态操作');
    if (inspected.blocked.length) return NextResponse.json(errorResponse('CONFLICT', '所选机器状态已变化，请检查后重试', { blocked: inspected.blocked }), { status: 409 });

    const form = normalizeForm(body);
    const now = formatDateTime();
    const batchResult = db.transaction(() => {
      const fresh = inspectSelection(ids, user);
      if (fresh.blocked.length) throw new BatchConflict(fresh.blocked);
      const definition = db.prepare('SELECT * FROM inventory_status_definitions WHERE id=? AND isActive=1').get(form.definitionId) as Record<string, unknown> | undefined;
      if (!definition) throw new Error('状态不存在或已停用，请刷新后重新选择');
      const inserted: Array<{ id: string; inventoryId: string; item: InventoryRow }> = [];
      const insertStatus = db.prepare(`INSERT INTO inventory_status_records(
        id,inventoryId,definitionId,definitionSnapshot,reason,location,responsiblePerson,expectedReturnDate,remark,warehouseId,createdBy,createdAt,
        allowSales,allowRentals,allowTransfers,allowSupplierReturns
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
      const updateInventory = db.prepare("UPDATE inventory SET status='custom',currentStatusRecordId=?,updatedAt=? WHERE id=? AND deleted=0 AND status='in_stock' AND currentStatusRecordId IS NULL");
      const insertMovement = db.prepare(`INSERT INTO inventory_movements(
        id,inventoryId,warehouseId,movementType,referenceType,referenceId,actorId,note,statusFrom,statusTo,snapshot,createdAt
      ) VALUES (?,?,?,'custom_status_start','inventory_status',?,?,?,'in_stock','custom',?,?)`);
      const note = [String(definition.name), form.reason, form.location ? `地点：${form.location}` : ''].filter(Boolean).join('；');

      for (const item of fresh.eligible) {
        const id = generateId('status_record');
        const statusRecord = { id, definitionId: form.definitionId, definition, reason: form.reason, location: form.location,
          responsiblePerson: form.responsiblePerson, expectedReturnDate: form.expectedReturnDate, remark: form.remark, createdBy: user.id, createdAt: now };
        const allowed = Number(definition.allowStockOperations) === 1 ? 1 : 0;
        insertStatus.run(id,item.id,form.definitionId,JSON.stringify(definition),form.reason,form.location,form.responsiblePerson,form.expectedReturnDate,form.remark,item.warehouseId,user.id,now,allowed,allowed,allowed,allowed);
        if (updateInventory.run(id,now,item.id).changes !== 1) throw new BatchConflict([{ id: item.id, sn: item.sn, reason: '机器状态已变化' }]);
        insertMovement.run(generateId('movement'),item.id,item.warehouseId,id,user.id,note,snapshotMachine(item,statusRecord),now);
        inserted.push({ id, inventoryId: item.id, item });
      }
      return inserted;
    })();

    const items = batchResult.map(row => serializeInventoryStatus(db.prepare('SELECT * FROM inventory WHERE id=?').get(row.inventoryId) as { id: string }));
    return NextResponse.json(successResponse({ items, inventoryIds: batchResult.map(row => row.inventoryId), count: batchResult.length }), { status: 201 });
  } catch (error) {
    if (error instanceof BatchConflict) return NextResponse.json(errorResponse('CONFLICT', error.message, { blocked: error.blocked }), { status: 409 });
    if (error instanceof AuthError) return NextResponse.json(errorResponse(error.code, error.message), { status: error.status });
    const auth = authErrorResponse(error);
    if (auth) return auth;
    return NextResponse.json(errorResponse('VALIDATION_ERROR', error instanceof Error ? error.message : '批量登记状态失败'), { status: 400 });
  }
}
