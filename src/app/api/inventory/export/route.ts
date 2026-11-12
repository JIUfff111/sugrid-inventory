import { NextRequest, NextResponse } from 'next/server';
import db from '@/lib/db';
import { assertInventoryView, authErrorResponse, requireUser, warehouseScope } from '@/lib/auth';
import { errorResponse, successResponse } from '@/lib/api-helpers';
import { getInventoryWhere, validateInventoryQuery } from '@/lib/inventory-query';
import { INVENTORY_EXPORT_COLUMNS, inventoryRowsToCsv, type InventoryExportRow } from '@/lib/inventory-export';
import { stockEligibleSql } from '@/lib/inventory-status';
import type { InventoryTableColumnKey } from '@/lib/inventory-table-preferences';

const MAX_SELECTED_IDS = 5000;
const MAX_QUERY_LENGTH = 50000;

const inventoryExportSelect = `
  SELECT
    i.id, i.productType, i.brand, i.model, i.year, i.cpu, i.ram, i.storage, i.gpu, i.screen,
    i.touchScreen, i.sn, i.itemNumber, i.remark, i.skuRemark, i.supplierName, po.purchaseNo,
    w.name AS warehouseName, i.purchasePrice, i.status, isd.name AS customStatusName,
    isr.location AS customStatusLocation, ast.stockStatus AS afterSaleStockStatus,
    i.saleChannel, i.inboundDate,
    MAX(0, CAST(julianday(date('now', 'localtime')) - julianday(date(i.inboundDate)) AS INTEGER)) AS inboundDays
  FROM inventory i
  LEFT JOIN purchase_orders po ON po.id = i.purchaseOrderId
  LEFT JOIN warehouses w ON w.id = i.warehouseId
  LEFT JOIN inventory_status_records isr ON isr.id = i.currentStatusRecordId AND isr.closedAt IS NULL
  LEFT JOIN inventory_status_definitions isd ON isd.id = isr.definitionId
  LEFT JOIN after_sale_records a ON a.id = (
    SELECT ar.id FROM after_sale_records ar WHERE ar.inventoryId = i.id AND ar.deleted = 0
    ORDER BY CASE WHEN ar.status IN ('created','received','processing') THEN 0 ELSE 1 END, ar.createdAt DESC, ar.id DESC LIMIT 1
  )
  LEFT JOIN after_sale_stock ast ON ast.afterSaleId = a.id
`;

function bad(message: string, status = 400) {
  return NextResponse.json(errorResponse('VALIDATION_ERROR', message), { status });
}

function parseColumns(value: unknown): InventoryTableColumnKey[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > INVENTORY_EXPORT_COLUMNS.length) return null;
  const allowed = new Set(INVENTORY_EXPORT_COLUMNS.map(column => column.key));
  const columns: InventoryTableColumnKey[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== 'string' || !allowed.has(item as InventoryTableColumnKey) || seen.has(item)) return null;
    seen.add(item);
    columns.push(item as InventoryTableColumnKey);
  }
  return columns;
}

function queryWhere(user: Awaited<ReturnType<typeof requireUser>>, params: URLSearchParams, ids?: string[]) {
  const scope = warehouseScope(user, params.get('warehouseId'), 'i');
  if (ids) {
    const placeholders = ids.map(() => '?').join(',');
    return {
      clause: `WHERE i.deleted = 0 AND i.id IN (${placeholders}) AND ${scope.sql}`,
      values: [...ids, ...scope.params],
    };
  }
  const where = getInventoryWhere(params);
  if (params.get('availableFor')) where.clause += ` AND ${stockEligibleSql('i')}`;
  return { clause: `${where.clause} AND ${scope.sql}`, values: [...where.params, ...scope.params] };
}

export async function POST(request: NextRequest) {
  try {
    const user = await requireUser();
    assertInventoryView(user);
    if (user.role === 'viewer') return NextResponse.json(errorResponse('FORBIDDEN', '普通用户无权导出库存'), { status: 403 });

    let body: { action?: unknown; mode?: unknown; query?: unknown; ids?: unknown; columns?: unknown };
    try {
      const parsed = await request.json();
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return bad('导出请求内容无效');
      body = parsed as typeof body;
    } catch {
      return bad('导出请求内容不是有效的 JSON');
    }
    const action = body.action;
    const mode = body.mode;
    if (action !== 'preview' && action !== 'download') return bad('导出操作类型无效');
    if (mode !== 'filtered' && mode !== 'selected') return bad('导出范围无效');
    const columns = parseColumns(body.columns);
    if (!columns) return bad('请选择有效的导出字段');

    let params = new URLSearchParams();
    if (mode === 'filtered') {
      if (typeof body.query !== 'string' || body.query.length > MAX_QUERY_LENGTH) return bad('库存筛选条件无效');
      params = new URLSearchParams(body.query);
      const invalid = validateInventoryQuery(params);
      if (invalid) return bad(invalid);
    }

    let ids: string[] | undefined;
    if (mode === 'selected') {
      if (!Array.isArray(body.ids) || body.ids.length === 0 || body.ids.length > MAX_SELECTED_IDS
        || body.ids.some(id => typeof id !== 'string' || id.length > 120 || !id.trim())) {
        return bad(`所选机器数量需为 1 至 ${MAX_SELECTED_IDS} 台`);
      }
      ids = [...new Set((body.ids as string[]).map(id => id.trim()))];
    }

    const { clause, values } = queryWhere(user, params, ids);
    const count = db.prepare(`SELECT COUNT(*) AS total FROM inventory i LEFT JOIN purchase_orders po ON po.id = i.purchaseOrderId ${clause}`)
      .get(...values) as { total: number };
    if (action === 'preview') return NextResponse.json(successResponse({ total: Number(count.total || 0) }));

    const rows = db.prepare(`${inventoryExportSelect} ${clause} ORDER BY CASE i.status WHEN 'in_stock' THEN 0 WHEN 'returning' THEN 1 ELSE 2 END, i.createdAt DESC`)
      .all(...values) as InventoryExportRow[];
    const csv = inventoryRowsToCsv(rows, columns);
    const date = new Date().toISOString().slice(0, 10);
    const filename = `库存导出-${date}.csv`;
    return new NextResponse(csv, {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
        'Cache-Control': 'no-store',
        'X-Export-Count': String(rows.length),
      },
    });
  } catch (error: unknown) {
    const authFailure = authErrorResponse(error);
    if (authFailure) return authFailure;
    console.error('POST /api/inventory/export error:', error);
    return NextResponse.json(errorResponse('DATABASE_ERROR', error instanceof Error ? error.message : '导出库存失败'), { status: 500 });
  }
}
