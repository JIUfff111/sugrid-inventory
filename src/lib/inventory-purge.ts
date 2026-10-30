import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import db from '@/lib/db';

export type PurgeReferenceCounts = {
  sales: number;
  rentals: number;
  afterSales: number;
  returns: number;
  transfers: number;
  statusRecords: number;
  activeTransfers: number;
  movementRecords: number;
};

export type PurgeCandidate = {
  id: string;
  sn: string;
  status: string;
  warehouseId: string;
  currentStatusRecordId: string | null;
  purchaseOrderId: string;
  purchaseItemId: string;
  purchaseNo: string | null;
  supplierName: string;
  references: PurgeReferenceCounts;
  reasons: string[];
};

function parseJsonItems(value: unknown): unknown[] {
  if (typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
function itemReferencesMachine(value: unknown, id: string, sn: string): boolean {
  if (!value || typeof value !== 'object') return false;
  const row = value as Record<string, unknown>;
  return [row.inventoryId, row.id, row.originalInventoryId, row.replacementInventoryId, row.sn]
    .some(candidate => String(candidate ?? '') === id || String(candidate ?? '') === sn);
}

export function getPurgeCandidate(id: string): PurgeCandidate | null {
  const machine = db.prepare(`
    SELECT i.id, i.sn, i.status, i.warehouseId, i.currentStatusRecordId,
      i.purchaseOrderId, i.purchaseItemId, po.purchaseNo, i.supplierName
    FROM inventory i
    LEFT JOIN purchase_orders po ON po.id = i.purchaseOrderId
    WHERE i.id = ? AND i.deleted = 0
  `).get(id) as Omit<PurgeCandidate, 'references' | 'reasons'> | undefined;
  if (!machine) return null;

  const references: PurgeReferenceCounts = {
    sales: Number((db.prepare('SELECT COUNT(*) AS count FROM sales_record_items WHERE inventoryId = ?').get(id) as { count: number }).count || 0),
    rentals: Number((db.prepare('SELECT COUNT(*) AS count FROM rental_records WHERE inventoryId = ?').get(id) as { count: number }).count || 0),
    afterSales: Number((db.prepare(`SELECT COUNT(*) AS count FROM after_sale_records WHERE inventoryId = ? OR replacementInventoryId = ?`).get(id, id) as { count: number }).count || 0)
      + Number((db.prepare('SELECT COUNT(*) AS count FROM after_sale_stock WHERE inventoryId = ?').get(id) as { count: number }).count || 0),
    returns: Number((db.prepare('SELECT COUNT(*) AS count FROM return_receipts WHERE inventoryId = ?').get(id) as { count: number }).count || 0),
    transfers: Number((db.prepare('SELECT COUNT(*) AS count FROM transfer_items WHERE inventoryId = ?').get(id) as { count: number }).count || 0),
    statusRecords: Number((db.prepare('SELECT COUNT(*) AS count FROM inventory_status_records WHERE inventoryId = ?').get(id) as { count: number }).count || 0),
    activeTransfers: Number((db.prepare(`
      SELECT COUNT(*) AS count FROM transfer_items ti
      JOIN transfers t ON t.id = ti.transferId
      WHERE ti.inventoryId = ? AND t.status IN ('pending','approved','in_transit')
    `).get(id) as { count: number }).count || 0),
    movementRecords: Number((db.prepare('SELECT COUNT(*) AS count FROM inventory_movements WHERE inventoryId = ?').get(id) as { count: number }).count || 0),
  };

  for (const row of db.prepare('SELECT items FROM sales_records WHERE deleted = 0').all() as Array<{ items: string }>) {
    if (parseJsonItems(row.items).some(item => itemReferencesMachine(item, machine.id, machine.sn))) references.sales += 1;
  }
  for (const row of db.prepare('SELECT items FROM return_orders WHERE deleted = 0').all() as Array<{ items: string }>) {
    if (parseJsonItems(row.items).some(item => itemReferencesMachine(item, machine.id, machine.sn))) references.returns += 1;
  }

  const reasons: string[] = [];
  if (machine.status !== 'in_stock') reasons.push(`当前状态为“${machine.status}”，只能删除普通在库机器`);
  if (machine.currentStatusRecordId) reasons.push('机器存在未结束的自定义状态登记');
  if (references.sales) reasons.push(`存在 ${references.sales} 条销售关联记录`);
  if (references.rentals) reasons.push(`存在 ${references.rentals} 条租赁关联记录`);
  if (references.afterSales) reasons.push(`存在 ${references.afterSales} 条售后关联记录`);
  if (references.returns) reasons.push(`存在 ${references.returns} 条退货关联记录`);
  if (references.transfers) reasons.push(`存在 ${references.transfers} 条调拨关联记录`);
  if (references.activeTransfers) reasons.push('机器存在进行中的调拨，无法删除');

  return { ...machine, references, reasons };
}

export async function createPurgeBackup() {
  const dbPath = process.env.INVENTORY_DB_PATH || path.join(process.cwd(), 'data', 'inventory.db');
  const backupDir = path.join(path.dirname(dbPath), 'backups');
  fs.mkdirSync(backupDir, { recursive: true });
  const backupPath = path.join(backupDir, `before-machine-purge-${new Date().toISOString().replace(/[.:]/g, '-')}-${randomUUID().slice(0, 8)}.db`);
  await db.backup(backupPath);
  const sha256 = createHash('sha256').update(fs.readFileSync(backupPath)).digest('hex');
  return { path: backupPath, sha256 };
}

