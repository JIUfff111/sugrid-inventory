import { listInventoryStatusDefinitions, serializeInventoryStatus, stockEligibleSql, warehouseStockSql } from '@/lib/inventory-status';
import { requireUser, requireSystemAccount, warehouseScope, authErrorResponse, assertWarehouseAccess, assertInventoryEdit, assertInventoryView } from '@/lib/auth';
/**
 * 在库清单 API
 * GET   /api/inventory                 获取库存列表（支持分页、搜索、状态筛选）
 * PATCH /api/inventory                 更新库存备注
 */

import { NextRequest, NextResponse } from 'next/server';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import db from '@/lib/db';
import {
  successResponse,
  errorResponse,
  ErrorCode,
  parsePaginationParams,
  createPaginatedResponse,
  formatDateTime,
} from '@/lib/api-helpers';
import { verifyPassword } from '@/lib/auth';
import { createPurgeBackup, getPurgeCandidate } from '@/lib/inventory-purge';
import { canonicalSKUBrand } from '@/lib/sku-brand';
import { getInventoryWhere, validateInventoryQuery } from '@/lib/inventory-query';

function getErrorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

interface InventoryRow {
  id: string;
  purchaseOrderId: string;
  purchaseItemId: string;
  purchaseNo: string | null;
  sn: string;
  itemNumber: string | null;
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
    i.itemNumber,
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

/** 获取库存列表。已删除记录永远不会出现在结果中。 */
export async function GET(request: NextRequest) {
  try {
    const user = await requireUser();
    assertInventoryView(user);
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
    const validationError = validateInventoryQuery(searchParams);
    if (validationError) return NextResponse.json(errorResponse('VALIDATION_ERROR', validationError), { status: 400 });
    if (searchParams.get('meta') === 'filters') {
      const filterBrand = searchParams.get('brand')?.trim() || '';
      const brands = db.prepare(`
        SELECT DISTINCT brand AS value FROM inventory
        WHERE deleted = 0 AND ${scope.sql} AND TRIM(COALESCE(brand, '')) <> ''
        ORDER BY brand COLLATE NOCASE
      `).all(...scope.params) as Array<{ value: string }>;
      const editBrands = db.prepare(`
        SELECT value FROM (
          SELECT brand AS value FROM inventory
          WHERE deleted = 0 AND ${scope.sql} AND TRIM(COALESCE(brand, '')) <> ''
          UNION
          SELECT brand AS value FROM skus
          WHERE deleted = 0 AND TRIM(COALESCE(brand, '')) <> ''
          UNION
          SELECT brand AS value FROM manual_skus
          WHERE deleted = 0 AND isActive = 1 AND TRIM(COALESCE(brand, '')) <> ''
        ) ORDER BY value COLLATE NOCASE
      `).all(...scope.params) as Array<{ value: string }>;
      const models = db.prepare(`
        SELECT DISTINCT model AS value FROM inventory
        WHERE deleted = 0 AND ${scope.sql} AND TRIM(COALESCE(model, '')) <> ''
          AND (? = '' OR brand = ? COLLATE NOCASE)
        ORDER BY model COLLATE NOCASE
      `).all(...scope.params, filterBrand, filterBrand) as Array<{ value: string }>;
      const suppliers = db.prepare(`
        SELECT DISTINCT supplierId AS id, supplierName AS name FROM inventory
        WHERE deleted = 0 AND ${scope.sql} AND TRIM(COALESCE(supplierName, '')) <> ''
        ORDER BY supplierName COLLATE NOCASE
      `).all(...scope.params) as Array<{ id: string; name: string }>;
      const statusDefinitions = listInventoryStatusDefinitions(warehouseScope(user, searchParams.get('warehouseId'), 'i'));
      return NextResponse.json(successResponse({
        statusDefinitions,
        brands: brands.map((item) => item.value),
        editBrands: user.role === 'viewer' ? [] : [...new Set(editBrands.map((item) => canonicalSKUBrand(item.value)))].sort((a, b) => a.localeCompare(b, 'zh-CN')),
        models: models.map((item) => item.value),
        suppliers,
      }));
    }

    const scoped = warehouseScope(user, searchParams.get('warehouseId'), 'i');
    const where = getInventoryWhere(searchParams);
    if (searchParams.get('availableFor')) where.clause += ` AND ${stockEligibleSql('i')}`;
    let clause = where.clause + ' AND ' + scoped.sql;
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
        SUM(CASE WHEN ${warehouseStockSql('i')} THEN 1 ELSE 0 END) AS inStock,
        SUM(CASE WHEN status = 'sold' THEN 1 ELSE 0 END) AS sold,
        SUM(CASE WHEN status = 'returning' THEN 1 ELSE 0 END) AS returningCount,
        SUM(CASE WHEN status = 'custom' AND COALESCE((SELECT location_record.locationType FROM inventory_status_records location_record WHERE location_record.id = i.currentStatusRecordId AND location_record.closedAt IS NULL),'warehouse') = 'external' THEN 1 ELSE 0 END) AS externalCount,
        COALESCE(SUM(CASE WHEN ${warehouseStockSql('i')} THEN purchasePrice ELSE 0 END), 0) AS inStockCost
      FROM inventory i
      WHERE i.deleted = 0 AND ${scope.sql}
    `).get(...scope.params) as {
      total: number;
      inStock: number;
      sold: number;
      returningCount: number;
      externalCount: number;
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
        external: Number(stats.externalCount || 0),
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
    assertInventoryEdit(user);
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

/** Permanently remove one ordinary in-stock machine and its machine-only history. */
export async function DELETE(request: NextRequest) {
  try {
    const user = await requireSystemAccount();
    const id = new URL(request.url).searchParams.get('id')?.trim() || '';
    if (!id) return NextResponse.json(errorResponse(ErrorCode.VALIDATION_ERROR, '库存 ID 不能为空'), { status: 400 });

    const candidate = getPurgeCandidate(id);
    if (!candidate) return NextResponse.json(errorResponse(ErrorCode.INVENTORY_NOT_FOUND, '库存记录不存在'), { status: 404 });
    assertWarehouseAccess(user, candidate.warehouseId);
    if (candidate.reasons.length) {
      return NextResponse.json(errorResponse(ErrorCode.CANNOT_DELETE_IN_USE, '该机器存在业务关联，无法永久删除', {
        reasons: candidate.reasons,
        references: candidate.references,
      }), { status: 409 });
    }

    let body: Record<string, unknown> = {};
    try { body = await request.json() as Record<string, unknown>; } catch { /* body is validated below */ }
    const confirmation = typeof body.confirmText === 'string' ? body.confirmText.trim() : '';
    const password = typeof body.password === 'string' ? body.password : '';
    const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
    if (confirmation !== '永久删除') {
      return NextResponse.json(errorResponse(ErrorCode.VALIDATION_ERROR, '请输入“永久删除”确认操作'), { status: 400 });
    }
    if (!password) return NextResponse.json(errorResponse(ErrorCode.VALIDATION_ERROR, '请输入当前密码'), { status: 400 });
    if (reason.length > 200) return NextResponse.json(errorResponse(ErrorCode.VALIDATION_ERROR, '删除原因不能超过 200 个字符'), { status: 400 });
    const stored = db.prepare('SELECT password FROM users WHERE id = ? AND status = \'active\'').get(user.id) as { password: string } | undefined;
    if (!stored || !verifyPassword(password, stored.password)) {
      return NextResponse.json(errorResponse(ErrorCode.FORBIDDEN, '当前密码不正确'), { status: 403 });
    }

    const backup = await createPurgeBackup();
    const now = formatDateTime();
    const summary = { sn: candidate.sn, wasSoftDeleted: candidate.deleted === 1, purchaseOrderId: candidate.purchaseOrderId, purchaseItemId: candidate.purchaseItemId, reason: reason || null, backupFile: path.basename(backup.path), backupSha256: backup.sha256 };
    db.transaction(() => {
      const fresh = getPurgeCandidate(id);
      if (!fresh) throw new Error('库存记录不存在');
      if (fresh.reasons.length) throw new Error(fresh.reasons.join('；'));
      db.prepare('DELETE FROM inventory_status_records WHERE inventoryId = ?').run(id);
      db.prepare('DELETE FROM inventory_movements WHERE inventoryId = ?').run(id);
      const deleted = db.prepare("DELETE FROM inventory WHERE id = ? AND deleted = ? AND status = 'in_stock'").run(id, fresh.deleted);
      if (deleted.changes !== 1) throw new Error('机器状态已变化，请刷新后重试');
      db.prepare(`
        INSERT INTO data_management_audit (id, actorId, action, resource, recordId, recordCount, summary, createdAt)
        VALUES (?, ?, 'inventory_purge', 'inventory', ?, 1, ?, ?)
      `).run(randomUUID(), user.id, id, JSON.stringify(summary), now);
    })();

    return NextResponse.json(successResponse({ id, sn: candidate.sn, backupFile: path.basename(backup.path), backupSha256: backup.sha256, message: '机器及其生命周期记录已永久删除，采购历史已保留' }));
  } catch (error: unknown) {
    const authFailure = authErrorResponse(error);
    if (authFailure) return authFailure;
    if (error instanceof Error && /机器存在|当前状态|关联记录|不存在/.test(error.message)) {
      return NextResponse.json(errorResponse(ErrorCode.CANNOT_DELETE_IN_USE, error.message), { status: 409 });
    }
    console.error('DELETE /api/inventory error:', error);
    return NextResponse.json(errorResponse(ErrorCode.DATABASE_ERROR, getErrorMessage(error, '永久删除机器失败')), { status: 500 });
  }
}
