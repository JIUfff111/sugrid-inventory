import { createPaginatedResponse, parsePaginationParams } from '@/lib/api-helpers';
import db from '@/lib/db';

type RentalRow = {
  id: string;
  rentalTotalPrice: number;
  daysUntilDue: number | null;
  isOverdue: number;
  isDueSoon: number;
  renewalTotal?: number;
};

type DueStatus = 'overdue' | 'today' | 'soon' | 'normal';
type DueFilter = Exclude<DueStatus, 'normal'> | 'all';
type StatusFilter = 'all' | 'renting' | 'returned' | 'purchased' | 'closed';

export type RentalWorkspaceOrder = {
  key: string;
  rentalNo: string;
  customerName: string;
  totalCount: number;
  matchedCount: number;
  activeCount: number;
  returnedCount: number;
  boughtOutCount: number;
  nearestDueDate: string | null;
  latestReturnDate: string | null;
  totalPrice: number;
};

type WorkspaceParams = {
  view: 'orders' | 'machines';
  status: StatusFilter;
  due: DueFilter;
  search: string;
  page: number;
  pageSize: number;
};

export function parseRentalWorkspaceParams(params: URLSearchParams): WorkspaceParams | null {
  const view = params.get('view')?.trim() || 'orders';
  const status = params.get('status')?.trim() || 'all';
  const due = params.get('due')?.trim() || 'all';
  if (view !== 'orders' && view !== 'machines') return null;
  if (status !== 'all' && status !== 'renting' && status !== 'returned' && status !== 'purchased' && status !== 'closed') return null;
  if (due !== 'all' && due !== 'overdue' && due !== 'today' && due !== 'soon') return null;
  return { view, status, due, search: params.get('search')?.trim() || '', ...parsePaginationParams(params) };
}

const inventoryJoin = 'LEFT JOIN inventory i ON i.id = r.inventoryId';
const orderJoin = 'LEFT JOIN rental_orders ro ON ro.id = r.rentalOrderId';
const rentalOrderKey = `CASE WHEN NULLIF(r.rentalOrderId, '') IS NULL THEN 'legacy:' || r.id ELSE 'order:' || r.rentalOrderId END`;
const rentalEndDay = 'date(r.rentalEndDate)';
const orderMachineCount = '(SELECT COUNT(*) FROM rental_records siblings WHERE siblings.rentalOrderId = r.rentalOrderId AND siblings.deleted = 0)';
const renewalTotal = '(SELECT COALESCE(SUM(totalAmount), 0) FROM rental_renewals WHERE rentalRecordId = r.id)';

function rentalRowsSelect(today: string, soon: string, includeWorkspaceFields = false) {
  return `SELECT r.*, COALESCE(ro.rentalNo, r.rentalNo) AS displayRentalNo,
    ro.handlerUserId, ro.handlerName, ro.salespersonName, ro.sourceType, ro.platformName, ro.platformOrderNo,
    ${includeWorkspaceFields ? `CASE WHEN NULLIF(r.rentalOrderId, '') IS NULL THEN 1 ELSE ${orderMachineCount} END` : orderMachineCount} AS orderMachineCount,
    sr.transactionType AS saleTransactionType, sr.buyoutBuyerName, sr.buyoutSource,
    sr.depositRefundAmount, sr.depositAppliedAmount, sr.depositRetainedAmount, sr.settlementAdjustment, sr.settlementNote,
    i.year AS year, i.warehouseId AS warehouseId,
    CASE WHEN i.deleted = 0 THEN i.sn END AS currentInventorySn,
    CAST(julianday(${rentalEndDay}) - julianday(${today}) AS INTEGER) AS daysUntilDue,
    CASE WHEN r.status = 'renting' AND ${rentalEndDay} < ${today} THEN 1 ELSE 0 END AS isOverdue,
    CASE WHEN r.status = 'renting' AND ${rentalEndDay} >= ${today} AND ${rentalEndDay} <= ${soon} THEN 1 ELSE 0 END AS isDueSoon
    ${includeWorkspaceFields ? `, ${rentalOrderKey} AS orderKey, ${renewalTotal} AS renewalTotal` : ''}
    FROM rental_records r ${inventoryJoin} ${orderJoin}
    LEFT JOIN sales_records sr ON sr.id = r.salesRecordId`;
}

export const legacyRentalRowsSelect = rentalRowsSelect("date('now', '+8 hours')", "date('now', '+8 hours', '+3 day')");
const workspaceRentalRowsSelect = rentalRowsSelect('@today', '@soon', true);

function rentalDueRange() {
  // Apply the same Beijing date to the entire request, including requests at midnight.
  const beijingNow = Date.now() + 8 * 60 * 60 * 1000;
  return {
    today: new Date(beijingNow).toISOString().slice(0, 10),
    soon: new Date(beijingNow + 3 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
  };
}

function rentalDueStatus(row: RentalRow): DueStatus {
  if (row.isOverdue) return 'overdue';
  if (!row.isDueSoon) return 'normal';
  return row.daysUntilDue === 0 ? 'today' : 'soon';
}

function cumulativeRentalAmount(row: RentalRow, total: number) {
  return Math.round((Number(row.rentalTotalPrice || 0) + total + Number.EPSILON) * 100) / 100;
}

export function serializeRentalDetails<T extends RentalRow>(rows: T[], legacy = false) {
  if (!rows.length) return [];
  const movements = db.prepare(`SELECT id, inventoryId, warehouseId, fromWarehouseId, toWarehouseId, movementType, quantity,
    referenceType, referenceId, actorId, note, createdAt FROM inventory_movements
    WHERE referenceType = 'rental' AND referenceId = ? ORDER BY createdAt ASC`);
  const events = db.prepare(`SELECT e.id, e.eventType, e.note, e.beforeData, e.afterData, e.actorId, e.createdAt,
    COALESCE(NULLIF(u.realName, ''), u.username) AS actorName
    FROM rental_events e LEFT JOIN users u ON u.id = e.actorId
    WHERE e.rentalRecordId = ? ORDER BY e.createdAt DESC, e.rowid DESC`);
  const renewals = db.prepare(`SELECT rr.*, COALESCE(u.realName, u.username, '未记录') AS actorName
    FROM rental_renewals rr LEFT JOIN users u ON u.id = rr.actorId
    WHERE rr.rentalRecordId = ? ORDER BY rr.createdAt DESC, rr.rowid DESC`);
  const sumRenewals = db.prepare('SELECT COALESCE(SUM(totalAmount), 0) AS total FROM rental_renewals WHERE rentalRecordId = ?');
  return rows.map(row => {
    const renewalTotal = row.renewalTotal ?? (sumRenewals.get(row.id) as { total: number }).total;
    const dueStatus = legacy
      ? row.isOverdue ? 'overdue' : row.isDueSoon ? 'due_soon' : 'normal'
      : rentalDueStatus(row);
    return {
      ...row,
      dueStatus,
      movements: movements.all(row.id),
      events: events.all(row.id),
      renewals: renewals.all(row.id),
      renewalTotal,
      cumulativeRentalAmount: cumulativeRentalAmount(row, renewalTotal),
    };
  });
}

const searchColumns = [
  'r.rentalNo', 'ro.rentalNo', 'r.sn', 'CASE WHEN i.deleted = 0 THEN i.sn END',
  'r.brand', 'r.model', 'CAST(i.year AS TEXT)',
  'r.customerName', 'r.customerPhone', 'ro.customerName', 'ro.customerPhone',
  'ro.handlerName', 'ro.salespersonName', 'ro.platformName', 'ro.platformOrderNo',
];

function matchingRowsSql(search: string, due: DueFilter) {
  const conditions = [];
  if (search) {
    conditions.push(`(${searchColumns.map(column => `${column} LIKE @pattern ESCAPE '!'`).join(' OR ')})`);
  }
  if (due !== 'all') {
    conditions.push("r.status = 'renting'");
    if (due === 'overdue') conditions.push(`${rentalEndDay} < @today`);
    if (due === 'today') conditions.push(`${rentalEndDay} = @today`);
    if (due === 'soon') conditions.push(`${rentalEndDay} > @today AND ${rentalEndDay} <= @soon`);
  }
  return conditions.join(' AND ') || '1';
}

function orderStatusSql(status: StatusFilter) {
  switch (status) {
    case 'renting': return 'activeCount > 0';
    case 'returned': return 'returnedCount = totalCount';
    case 'purchased': return 'boughtOutCount = totalCount';
    case 'closed': return 'activeCount = 0';
    default: return '1';
  }
}

function rentalOrderGroupsSql(matchingRows: string, status: StatusFilter, extraWhere = '', search = '') {
  return `SELECT ${rentalOrderKey} AS key,
    NULLIF(r.rentalOrderId, '') AS orderId,
    CASE WHEN NULLIF(r.rentalOrderId, '') IS NULL THEN r.id END AS legacyId,
    COALESCE(MAX(ro.rentalNo), MAX(r.rentalNo)) AS rentalNo,
    COALESCE(MAX(ro.customerName), MAX(r.customerName)) AS customerName,
    COUNT(*) AS totalCount,
    SUM(CASE WHEN ${matchingRows} THEN 1 ELSE 0 END) AS matchedCount,
    COUNT(CASE WHEN r.status = 'renting' THEN 1 END) AS activeCount,
    COUNT(CASE WHEN r.status = 'returned' THEN 1 END) AS returnedCount,
    COUNT(CASE WHEN r.status = 'purchased' THEN 1 END) AS boughtOutCount,
    MIN(CASE WHEN r.status = 'renting' THEN ${rentalEndDay} END) AS nearestDueDate,
    MAX(date(r.returnDate)) AS latestReturnDate,
    MAX(r.updatedAt) AS newestUpdate
    FROM rental_records r ${orderJoin} ${search ? inventoryJoin : ''}
    WHERE r.deleted = 0 ${extraWhere}
    GROUP BY orderId, legacyId
    HAVING matchedCount > 0 AND ${orderStatusSql(status)}`;
}

const orderSummaryColumns = `o.key, o.rentalNo, o.customerName, o.totalCount, o.matchedCount, o.activeCount,
  o.returnedCount, o.boughtOutCount, o.nearestDueDate, o.latestReturnDate,
  (SELECT ROUND(SUM(ROUND(COALESCE(r.rentalTotalPrice, 0) + ${renewalTotal}, 2)), 2)
    FROM rental_records r
    WHERE r.deleted = 0 AND (r.rentalOrderId = o.orderId OR r.id = o.legacyId)) AS totalPrice`;

const orderSort = `activeCount = 0, nearestDueDate IS NULL, nearestDueDate,
  CASE WHEN activeCount = 0 THEN COALESCE(latestReturnDate, date(newestUpdate)) END DESC, newestUpdate DESC, key`;

function machineStatusSql(status: StatusFilter) {
  if (status === 'all') return '1';
  if (status === 'closed') return "r.status <> 'renting'";
  return 'r.status = @status';
}

export function getRentalWorkspace(params: WorkspaceParams) {
  const { view, status, due, search, pageSize } = params;
  const dates = rentalDueRange();
  const pattern = `%${search.replaceAll('!', '!!').replaceAll('%', '!%').replaceAll('_', '!_')}%`;
  const binding = { ...dates, pattern, status, pageSize };
  const matchingRows = matchingRowsSql(search, due);
  return db.transaction(() => {
    const summary = db.prepare(`SELECT
        COUNT(CASE WHEN ${rentalEndDay} < @today THEN 1 END) AS overdue,
        COUNT(CASE WHEN ${rentalEndDay} = @today THEN 1 END) AS today,
        COUNT(CASE WHEN ${rentalEndDay} > @today AND ${rentalEndDay} <= @soon THEN 1 END) AS soon
      FROM rental_records r
      WHERE r.deleted = 0 AND r.status = 'renting'`).get(dates) as Record<Exclude<DueFilter, 'all'>, number>;

    if (view === 'orders') {
      const groups = rentalOrderGroupsSql(matchingRows, status, '', search);
      const { total } = db.prepare(`SELECT COUNT(*) AS total FROM (${groups})`).get(binding) as { total: number };
      const page = Math.min(params.page, Math.max(1, Math.ceil(total / pageSize)));
      const items = db.prepare(`WITH orderPage AS MATERIALIZED (
          SELECT * FROM (${groups}) ORDER BY ${orderSort} LIMIT @pageSize OFFSET @offset
        )
        SELECT ${orderSummaryColumns} FROM orderPage o ORDER BY ${orderSort}`).all({
        ...binding, offset: (page - 1) * pageSize,
      }) as RentalWorkspaceOrder[];
      return { ...createPaginatedResponse(items, total, page, pageSize), summary };
    }

    const where = `WHERE r.deleted = 0 AND ${machineStatusSql(status)} AND ${matchingRows}`;
    const joins = search ? `${inventoryJoin} ${orderJoin}` : '';
    const { total } = db.prepare(`SELECT COUNT(*) AS total FROM rental_records r ${joins} ${where}`).get(binding) as { total: number };
    const page = Math.min(params.page, Math.max(1, Math.ceil(total / pageSize)));
    const rows = db.prepare(`${workspaceRentalRowsSelect} ${where}
      ORDER BY r.status <> 'renting',
        CASE WHEN r.status = 'renting' THEN ${rentalEndDay} END ASC NULLS LAST,
        CASE WHEN r.status <> 'renting' THEN COALESCE(date(r.returnDate), date(r.updatedAt)) END DESC,
        r.updatedAt DESC, r.id
      LIMIT @pageSize OFFSET @offset`).all({
      ...binding, offset: (page - 1) * pageSize,
    }) as (RentalRow & { renewalTotal: number })[];
    const items = rows.map(row => ({
      ...row,
      dueStatus: rentalDueStatus(row),
      cumulativeRentalAmount: cumulativeRentalAmount(row, row.renewalTotal),
    }));
    return { ...createPaginatedResponse(items, total, page, pageSize), summary };
  })();
}

export function getRentalOrderDetail(key: string) {
  const separator = key.indexOf(':');
  if (separator < 1) return null;
  const kind = key.slice(0, separator);
  const id = key.slice(separator + 1);
  if (!id || (kind !== 'order' && kind !== 'legacy')) return null;
  const orderMatch = kind === 'order'
    ? 'r.rentalOrderId = @id'
    : "r.id = @id AND NULLIF(r.rentalOrderId, '') IS NULL";
  const binding = { id, ...rentalDueRange() };
  return db.transaction(() => {
    const groups = rentalOrderGroupsSql('1', 'all', `AND ${orderMatch}`);
    const order = db.prepare(`SELECT ${orderSummaryColumns} FROM (${groups}) o`).get(binding) as RentalWorkspaceOrder | undefined;
    if (!order) return null;
    const rows = db.prepare(`${workspaceRentalRowsSelect} WHERE r.deleted = 0 AND ${orderMatch}
      ORDER BY r.sn COLLATE NOCASE, r.id`).all(binding) as RentalRow[];
    return { order, items: serializeRentalDetails(rows) };
  })();
}

export function getRentalMachineDetail(id: string) {
  const binding = { id, ...rentalDueRange() };
  return db.transaction(() => {
    const row = db.prepare(`${workspaceRentalRowsSelect} WHERE r.deleted = 0 AND r.id = @id`).get(binding) as RentalRow | undefined;
    return row ? serializeRentalDetails([row])[0] : null;
  })();
}
