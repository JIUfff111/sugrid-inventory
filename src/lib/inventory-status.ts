import db from '@/lib/db';
import { formatDateTime, generateId } from '@/lib/api-helpers';

/** SQL fragments only accept application-owned aliases, never request values. */
export function stockEligibleSql(alias = 'i', excludeTransferId?: string) {
  const transferExclusion = excludeTransferId ? ` AND t.id <> '${excludeTransferId.replaceAll("'", "''")}'` : '';
  return `(${alias}.deleted = 0 AND EXISTS (SELECT 1 FROM warehouses eligible_warehouse WHERE eligible_warehouse.id=${alias}.warehouseId AND eligible_warehouse.status='active') AND (${alias}.status = 'in_stock' OR (${alias}.status = 'custom' AND EXISTS (
    SELECT 1 FROM inventory_status_records csr JOIN inventory_status_definitions csd ON csd.id = csr.definitionId
    WHERE csr.id = ${alias}.currentStatusRecordId AND csr.inventoryId = ${alias}.id AND csr.closedAt IS NULL AND csd.allowStockOperations = 1
  ))) AND NOT EXISTS (SELECT 1 FROM transfer_items ti JOIN transfers t ON t.id = ti.transferId
    WHERE ti.inventoryId = ${alias}.id AND t.status IN ('pending','approved','in_transit')${transferExclusion}))`;
}

export function assertStockEligible(inventoryId: string, excludeTransferId?: string) {
  const row = db.prepare(`SELECT i.* FROM inventory i WHERE i.id = ? AND ${stockEligibleSql('i', excludeTransferId)}`).get(inventoryId) as { id: string; sn: string; status: string; warehouseId: string; currentStatusRecordId: string | null } | undefined;
  if (!row) throw new Error('机器当前不可参与在库业务，状态或调拨占用已变化，请刷新后重试');
  return row;
}

export function statusDetails(inventoryId: string) {
  return db.prepare(`SELECT r.*, d.name, d.color, d.allowStockOperations, d.isActive FROM inventory_status_records r
    JOIN inventory_status_definitions d ON d.id = r.definitionId JOIN inventory i ON i.currentStatusRecordId = r.id
    WHERE i.id = ? AND r.closedAt IS NULL`).get(inventoryId) || null;
}

/** Caller owns the transaction. Ends metadata without changing the lifecycle status itself. */
export function endCustomStatus(inventoryId: string, actorId: string, resultNote: string, referenceType: string, referenceId: string, statusTo: string) {
  if (!db.inTransaction) throw new Error('状态结束必须处于业务事务中');
  const current = db.prepare('SELECT id, sn, status, warehouseId, currentStatusRecordId FROM inventory WHERE id = ?').get(inventoryId) as { id: string; sn: string; status: string; warehouseId: string; currentStatusRecordId: string | null } | undefined;
  if (!current?.currentStatusRecordId) return;
  const record = db.prepare('SELECT * FROM inventory_status_records WHERE id = ? AND inventoryId = ? AND closedAt IS NULL').get(current.currentStatusRecordId, inventoryId) as Record<string, unknown> | undefined;
  if (!record) throw new Error('当前状态记录已变化');
  const now = formatDateTime();
  const changed = db.prepare(`UPDATE inventory_status_records SET closedAt = ?, closedBy = ?, resultNote = ?, closingReferenceType = ?, closingReferenceId = ? WHERE id = ? AND closedAt IS NULL`).run(now, actorId, resultNote, referenceType, referenceId, current.currentStatusRecordId);
  if (changed.changes !== 1) throw new Error('当前状态记录已结束');
  db.prepare('UPDATE inventory SET currentStatusRecordId = NULL WHERE id = ? AND currentStatusRecordId = ?').run(inventoryId, current.currentStatusRecordId);
  db.prepare(`INSERT INTO inventory_movements (id,inventoryId,warehouseId,movementType,referenceType,referenceId,actorId,note,statusFrom,statusTo,snapshot,createdAt)
    VALUES (?,?,?,'custom_status_end',?,?,?,?,?,?,?,?)`).run(generateId('movement'), inventoryId, current.warehouseId, referenceType, referenceId, actorId, resultNote, current.status, statusTo, JSON.stringify({ sn: current.sn, statusRecord: record, status: statusTo, warehouseId: current.warehouseId }), now);
}

export function serializeInventoryStatus<T extends { id: string }>(row: T) {
  const record = statusDetails(row.id) as Record<string, unknown> | null;
  return { ...row, customStatusId: record?.definitionId || null, customStatusName: record?.name || null,
    customStatusColor: record?.color || null, allowStockOperations: Boolean(record?.allowStockOperations), statusRecord: record };
}
