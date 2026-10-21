import { serializeInventoryStatus, stockEligibleSql } from '@/lib/inventory-status';
import { requireUser, warehouseScope, authErrorResponse, assertWarehouseAccess } from '@/lib/auth';
/**
 * 在库清单 API
 * GET   /api/inventory                 获取库存列表（支持分页、搜索、状态筛选）
 * PATCH /api/inventory                 更新库存备注
 */

import { NextRequest, NextResponse } from 'next/server';
import db from '@/lib/db';
import {
  successResponse,
  errorResponse,
  ErrorCode,
  parsePaginationParams,
  createPaginatedResponse,
  formatDateTime,
} from '@/lib/api-helpers';

function getErrorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

interface InventoryRow {
  id: string;
  purchaseOrderId: string;
  purchaseItemId: string;
  purchaseNo: string | null;
  sn: string;
  productType: string;
  brand: string;
  model: string;
  year: string | null;
  cpu: string;
  ram: string;
  gpu: string | null;
  storage: string;
  screen: string;
  touchScreen: number | null;
  purchasePrice: number;
  supplierId: string;
  supplierName: string;
  status: string;
  inboundDate: string;
  inboundDays: number;
  soldDate: string | null;
  sellingPrice: number | null;
  saleChannel: string | null;
  saleOrderNo: string | null;
  profit: number | null;
  remark: string | null;
  skuRemark: string | null;
  createdAt: string;
  updatedAt: string;
}

const inventorySelect = `
  SELECT
    i.id,
    i.warehouseId,
    w.name AS warehouseName,
    w.code AS warehouseCode,
    i.purchaseOrderId,
    i.purchaseItemId,
    po.purchaseNo,
    i.sn,
    i.productType,
    i.brand,
    i.model,
    i.year,
    i.cpu,
    i.ram,
    i.gpu,
    i.storage,
    i.screen,
    i.touchScreen,
    i.purchasePrice,
    i.supplierId,
    i.supplierName,
    i.status,
    i.currentStatusRecordId,
    a.id AS afterSaleId,
    a.afterSaleNo,
    a.status AS afterSaleStatus,
    ast.stockStatus AS afterSaleStockStatus,
    i.inboundDate,
    MAX(0, CAST(
      julianday(date('now', 'localtime')) - julianday(date(i.inboundDate))
      AS INTEGER
    )) AS inboundDays,
    i.soldDate,
    i.sellingPrice,
    i.saleChannel,
    i.saleOrderNo,
    i.profit,
    i.remark,
    i.skuRemark,
    i.createdAt,
    i.updatedAt
  FROM inventory i
  LEFT JOIN purchase_orders po ON po.id = i.purchaseOrderId
  LEFT JOIN warehouses w ON w.id = i.warehouseId
  LEFT JOIN after_sale_records a ON a.id = (
    SELECT ar.id FROM after_sale_records ar WHERE ar.inventoryId = i.id AND ar.deleted = 0
    ORDER BY CASE WHEN ar.status IN ('created','received','processing') THEN 0 ELSE 1 END, ar.createdAt DESC, ar.id DESC LIMIT 1
  )
  LEFT JOIN after_sale_stock ast ON ast.afterSaleId = a.id
`;

interface InventoryFilters {
  brand?: string;
  model?: string;
  supplierId?: string;
  inboundFrom?: string;
  inboundTo?: string;
  priceMin?: string;
  priceMax?: string;
  ageMin?: string;
  ageMax?: string;
}

function getWhere(search: string, status: string, filters: InventoryFilters = {}): { clause: string; params: (string | number)[] } {
  const conditions = ['i.deleted = 0'];
  const params: (string | number)[] = [];

  if (search) {
    const pattern = `%${search}%`;
    conditions.push(`(
      i.sn LIKE ? OR i.brand LIKE ? OR i.model LIKE ? OR i.year LIKE ? OR
      i.cpu LIKE ? OR i.ram LIKE ? OR i.gpu LIKE ? OR
      i.storage LIKE ? OR i.screen LIKE ? OR i.supplierName LIKE ? OR
      po.purchaseNo LIKE ? OR i.saleOrderNo LIKE ? OR i.remark LIKE ? OR
      i.skuRemark LIKE ?
    )`);
    params.push(
      pattern, pattern, pattern, pattern, pattern, pattern, pattern, pattern,
      pattern, pattern, pattern, pattern, pattern, pattern,
    );
  }

  if (status && status !== 'all') {
    conditions.push('i.status = ?');
    params.push(status);
  }

  if (filters.brand) {
    conditions.push('i.brand = ?');
    params.push(filters.brand);
  }
  if (filters.model) {
    conditions.push('i.model = ?');
    params.push(filters.model);
  }
  if (filters.supplierId) {
    conditions.push('i.supplierId = ?');
    params.push(filters.supplierId);
  }
  if (filters.inboundFrom) {
    conditions.push("date(i.inboundDate) >= date(?)");
    params.push(filters.inboundFrom);
  }
  if (filters.inboundTo) {
    conditions.push("date(i.inboundDate) <= date(?)");
    params.push(filters.inboundTo);
  }

  const numericFilters: Array<[keyof InventoryFilters, string, string]> = [
    ['priceMin', 'i.purchasePrice >= ?', 'priceMin'],
    ['priceMax', 'i.purchasePrice <= ?', 'priceMax'],
    ['ageMin', "julianday(date('now', 'localtime')) - julianday(date(i.inboundDate)) >= ?", 'ageMin'],
    ['ageMax', "julianday(date('now', 'localtime')) - julianday(date(i.inboundDate)) <= ?", 'ageMax'],
  ];
  for (const [key, condition] of numericFilters) {
    const value = filters[key];
    if (value && Number.isFinite(Number(value))) {
      conditions.push(condition);
      params.push(Number(value));
    }
  }

  return { clause: `WHERE ${conditions.join(' AND ')}`, params };
}

/** 获取库存列表。已删除记录永远不会出现在结果中。 */
export async function GET(request: NextRequest) {
  try {
    const user = await requireUser();
    const { searchParams } = new URL(request.url);
    const scope = warehouseScope(user, searchParams.get('warehouseId'));
    const parsedPagination = parsePaginationParams(searchParams);
    // parseInt('abc') is NaN, and SQLite rejects NaN as a LIMIT/OFFSET binding.
    // Normalize malformed query parameters at this endpoint so a bad URL cannot
    // turn a read-only inventory request into a 500 response.
    const page = Number.isFinite(parsedPagination.page) && parsedPagination.page >= 1
      ? parsedPagination.page
      : 1;
    const pageSize = Number.isFinite(parsedPagination.pageSize) && parsedPagination.pageSize >= 1
      ? parsedPagination.pageSize
      : 20;
    const search = searchParams.get('search')?.trim() || '';
    const status = searchParams.get('status')?.trim() || '';
    if (searchParams.get('meta') === 'filters') {
      const brands = db.prepare(`
        SELECT DISTINCT brand AS value FROM inventory
        WHERE deleted = 0 AND ${scope.sql} AND TRIM(COALESCE(brand, '')) <> ''
        ORDER BY brand COLLATE NOCASE
      `).all(...scope.params) as Array<{ value: string }>;
      const models = db.prepare(`
        SELECT DISTINCT model AS value FROM inventory
        WHERE deleted = 0 AND ${scope.sql} AND TRIM(COALESCE(model, '')) <> ''
        ORDER BY model COLLATE NOCASE
      `).all(...scope.params) as Array<{ value: string }>;
      const suppliers = db.prepare(`
        SELECT DISTINCT supplierId AS id, supplierName AS name FROM inventory
        WHERE deleted = 0 AND ${scope.sql} AND TRIM(COALESCE(supplierName, '')) <> ''
        ORDER BY supplierName COLLATE NOCASE
      `).all(...scope.params) as Array<{ id: string; name: string }>;
      const statusDefinitions = db.prepare('SELECT * FROM inventory_status_definitions ORDER BY createdAt,id').all();
      return NextResponse.json(successResponse({
        statusDefinitions,
        brands: brands.map((item) => item.value),
        models: models.map((item) => item.value),
        suppliers,
      }));
    }

    const filters: InventoryFilters = {
      brand: searchParams.get('brand')?.trim() || undefined,
      model: searchParams.get('model')?.trim() || undefined,
      supplierId: searchParams.get('supplierId')?.trim() || undefined,
      inboundFrom: searchParams.get('inboundFrom')?.trim() || undefined,
      inboundTo: searchParams.get('inboundTo')?.trim() || undefined,
      priceMin: searchParams.get('priceMin')?.trim() || undefined,
      priceMax: searchParams.get('priceMax')?.trim() || undefined,
      ageMin: searchParams.get('ageMin')?.trim() || undefined,
      ageMax: searchParams.get('ageMax')?.trim() || undefined,
    };
    const scoped = warehouseScope(user, searchParams.get('warehouseId'), 'i');
    const where = getWhere(search, status, filters);
    const customStatusId = searchParams.get('customStatusId')?.trim();
    if (customStatusId) { where.clause += ' AND EXISTS (SELECT 1 FROM inventory_status_records cr WHERE cr.id=i.currentStatusRecordId AND cr.definitionId=? AND cr.closedAt IS NULL)'; where.params.push(customStatusId); }
    let clause = where.clause + ' AND ' + scoped.sql;
    if (searchParams.get('availableFor')) clause += ' AND ' + stockEligibleSql('i');
    const params = [...where.params, ...scoped.params];

    const count = db.prepare(`
      SELECT COUNT(*) AS total
      FROM inventory i
      LEFT JOIN purchase_orders po ON po.id = i.purchaseOrderId
      ${clause}
    `).get(...params) as { total: number };

    const totalPages = Math.ceil(count.total / pageSize);
    const safePage = Math.min(page, Math.max(1, totalPages));
    const offset = (safePage - 1) * pageSize;
    const items = db.prepare(`
      ${inventorySelect}
      ${clause}
      ORDER BY
        CASE i.status WHEN 'in_stock' THEN 0 WHEN 'returning' THEN 1 ELSE 2 END,
        i.createdAt DESC
      LIMIT ? OFFSET ?
    `).all(...params, pageSize, offset) as InventoryRow[];

    // 页面顶部统计只统计未删除记录，便于在切换状态和搜索时保持稳定的总览。
    const stats = db.prepare(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN status IN ('in_stock','custom') THEN 1 ELSE 0 END) AS inStock,
        SUM(CASE WHEN status = 'sold' THEN 1 ELSE 0 END) AS sold,
        SUM(CASE WHEN status = 'returning' THEN 1 ELSE 0 END) AS returningCount,
        COALESCE(SUM(CASE WHEN status IN ('in_stock','custom') THEN purchasePrice ELSE 0 END), 0) AS inStockCost
      FROM inventory
      WHERE deleted = 0 AND ${scope.sql}
    `).get(...scope.params) as {
      total: number;
      inStock: number;
      sold: number;
      returningCount: number;
      inStockCost: number;
    };

    const extra = db.prepare(`SELECT SUM(CASE WHEN i.status='custom' THEN 1 ELSE 0 END) AS custom, COALESCE(SUM(CASE WHEN i.status='custom' THEN i.purchasePrice ELSE 0 END),0) AS customCost, SUM(CASE WHEN ${stockEligibleSql('i')} THEN 1 ELSE 0 END) AS available FROM inventory i WHERE i.deleted=0 AND ${warehouseScope(user, searchParams.get('warehouseId'),'i').sql}`).get(...scope.params) as {custom:number;customCost:number;available:number};
    return NextResponse.json(successResponse({
      ...createPaginatedResponse(items.map(serializeInventoryStatus), count.total, safePage, pageSize),
      stats: {
        custom: Number(extra.custom || 0),
        customCost: Number(extra.customCost || 0),
        available: Number(extra.available || 0),
        total: Number(stats.total || 0),
        inStock: Number(stats.inStock || 0),
        sold: Number(stats.sold || 0),
        returning: Number(stats.returningCount || 0),
        inStockCost: Number(stats.inStockCost || 0),
      },
    }));
  } catch (error: unknown) {
    const authFailure = authErrorResponse(error);
    if (authFailure) return authFailure;
    console.error('GET /api/inventory error:', error);
    return NextResponse.json(
      errorResponse(ErrorCode.DATABASE_ERROR, getErrorMessage(error, '获取库存列表失败')),
      { status: 500 }
    );
  }
}

/** 更新库存备注；空备注会清除现有备注。 */
export async function PATCH(request: NextRequest) {
  try {
    const user = await requireUser();
    const body = await request.json();
    const idValue = typeof body?.id === 'string' ? body.id : body?.inventoryId;
    const id = typeof idValue === 'string' ? idValue.trim() : '';
    if (!id) {
      return NextResponse.json(
        errorResponse(ErrorCode.VALIDATION_ERROR, '库存 ID 不能为空'),
        { status: 400 }
      );
    }

    const remarkValue = body && typeof body === 'object' && 'remark' in body
      ? (body as { remark?: unknown }).remark
      : undefined;
    if (remarkValue === undefined) {
      return NextResponse.json(
        errorResponse(ErrorCode.VALIDATION_ERROR, '备注字段不能为空缺省'),
        { status: 400 }
      );
    }
    if (remarkValue !== undefined && remarkValue !== null && typeof remarkValue !== 'string') {
      return NextResponse.json(
        errorResponse(ErrorCode.VALIDATION_ERROR, '备注格式不正确'),
        { status: 400 }
      );
    }

    const existing = db.prepare(
      'SELECT id, warehouseId FROM inventory WHERE id = ? AND deleted = 0'
    ).get(id) as { id: string; warehouseId: string } | undefined;
    if (!existing) {
      return NextResponse.json(
        errorResponse(ErrorCode.INVENTORY_NOT_FOUND, '库存记录不存在'),
        { status: 404 }
      );
    }

    assertWarehouseAccess(user, existing.warehouseId);
    const remark = remarkValue === null ? null : String(remarkValue ?? '').trim() || null;
    db.prepare(
      'UPDATE inventory SET remark = ?, updatedAt = ? WHERE id = ? AND deleted = 0'
    ).run(remark, formatDateTime(), id);

    const updated = db.prepare(`${inventorySelect} WHERE i.id = ? AND i.deleted = 0`).get(id) as InventoryRow;
    return NextResponse.json(successResponse(serializeInventoryStatus(updated)));
  } catch (error: unknown) {
    const authFailure = authErrorResponse(error);
    if (authFailure) return authFailure;
    console.error('PATCH /api/inventory error:', error);
    return NextResponse.json(
      errorResponse(ErrorCode.DATABASE_ERROR, getErrorMessage(error, '更新库存备注失败')),
      { status: 500 }
    );
  }
}
