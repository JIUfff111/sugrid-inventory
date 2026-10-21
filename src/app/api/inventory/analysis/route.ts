import { serializeInventoryStatus, stockEligibleSql } from '@/lib/inventory-status';
import { requireUser, warehouseScope, authErrorResponse } from '@/lib/auth';
/**
 * 库存分析工作台数据
 * GET /api/inventory/analysis
 */

import { NextRequest, NextResponse } from 'next/server';
import db from '@/lib/db';
import { errorResponse, successResponse } from '@/lib/api-helpers';

type SummaryRow = {
  total: number | null;
  inStock: number | null;
  sold: number | null;
  returningCount: number | null;
  renting: number | null;
  afterSale: number | null;
  reserved: number | null;
  totalCost: number | null;
  inStockCost: number | null;
  averageCost: number | null;
};

type GroupRow = {
  name: string | null;
  count: number | null;
  inStock: number | null;
  cost: number | null;
};

type DetailRow = {
  sn: string;
  brand: string;
  model: string;
  year: number | null;
  status: string;
  purchasePrice: number;
  supplierName: string;
  inboundDate: string;
  inboundDays: number;
};

function normalizeGroup(rows: GroupRow[]) {
  return rows.map((row) => ({
    name: row.name || '未填写',
    count: Number(row.count || 0),
    inStock: Number(row.inStock || 0),
    cost: Number(row.cost || 0),
  }));
}

export async function GET(request: NextRequest) {
  try {
    const user = await requireUser();
    const scope = warehouseScope(user, request.nextUrl.searchParams.get('warehouseId'));
    const scoped = warehouseScope(user, request.nextUrl.searchParams.get('warehouseId'),'i');
    const summary = db.prepare(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN status = 'in_stock' THEN 1 ELSE 0 END) AS inStock,
        SUM(CASE WHEN status = 'sold' THEN 1 ELSE 0 END) AS sold,
        SUM(CASE WHEN status = 'returning' THEN 1 ELSE 0 END) AS returningCount,
        SUM(CASE WHEN status = 'renting' THEN 1 ELSE 0 END) AS renting,
        SUM(CASE WHEN status = 'after_sale' THEN 1 ELSE 0 END) AS afterSale,
        SUM(CASE WHEN status = 'reserved' THEN 1 ELSE 0 END) AS reserved,
        COALESCE(SUM(purchasePrice), 0) AS totalCost,
        COALESCE(SUM(CASE WHEN status = 'in_stock' THEN purchasePrice ELSE 0 END), 0) AS inStockCost,
        COALESCE(AVG(purchasePrice), 0) AS averageCost
      FROM inventory
      WHERE deleted = 0 AND ${scope.sql}
    `).get(...scope.params) as SummaryRow;

    const byBrand = db.prepare(`
      SELECT NULLIF(TRIM(brand), '') AS name,
        COUNT(*) AS count,
        SUM(CASE WHEN status = 'in_stock' THEN 1 ELSE 0 END) AS inStock,
        COALESCE(SUM(purchasePrice), 0) AS cost
      FROM inventory WHERE deleted = 0 AND ${scope.sql}
      GROUP BY NULLIF(TRIM(brand), '')
      ORDER BY count DESC, cost DESC
      LIMIT 30
    `).all(...scope.params) as GroupRow[];

    const byModel = db.prepare(`
      SELECT NULLIF(TRIM(model), '') AS name,
        COUNT(*) AS count,
        SUM(CASE WHEN status = 'in_stock' THEN 1 ELSE 0 END) AS inStock,
        COALESCE(SUM(purchasePrice), 0) AS cost
      FROM inventory WHERE deleted = 0 AND ${scope.sql}
      GROUP BY NULLIF(TRIM(model), '')
      ORDER BY count DESC, cost DESC
      LIMIT 30
    `).all(...scope.params) as GroupRow[];

    const bySupplier = db.prepare(`
      SELECT NULLIF(TRIM(supplierName), '') AS name,
        COUNT(*) AS count,
        SUM(CASE WHEN status = 'in_stock' THEN 1 ELSE 0 END) AS inStock,
        COALESCE(SUM(purchasePrice), 0) AS cost
      FROM inventory WHERE deleted = 0 AND ${scope.sql}
      GROUP BY NULLIF(TRIM(supplierName), '')
      ORDER BY count DESC, cost DESC
      LIMIT 30
    `).all(...scope.params) as GroupRow[];

    const byAge = db.prepare(`
      SELECT CASE
        WHEN julianday(date('now', 'localtime')) - julianday(date(inboundDate)) <= 7 THEN '0-7 天'
        WHEN julianday(date('now', 'localtime')) - julianday(date(inboundDate)) <= 30 THEN '8-30 天'
        WHEN julianday(date('now', 'localtime')) - julianday(date(inboundDate)) <= 90 THEN '31-90 天'
        ELSE '90 天以上'
      END AS name,
      COUNT(*) AS count,
      SUM(CASE WHEN status = 'in_stock' THEN 1 ELSE 0 END) AS inStock,
      COALESCE(SUM(purchasePrice), 0) AS cost
      FROM inventory
      WHERE deleted = 0 AND ${scope.sql}
      GROUP BY CASE
        WHEN julianday(date('now', 'localtime')) - julianday(date(inboundDate)) <= 7 THEN '0-7 天'
        WHEN julianday(date('now', 'localtime')) - julianday(date(inboundDate)) <= 30 THEN '8-30 天'
        WHEN julianday(date('now', 'localtime')) - julianday(date(inboundDate)) <= 90 THEN '31-90 天'
        ELSE '90 天以上'
      END
      ORDER BY MIN(julianday(date('now', 'localtime')) - julianday(date(inboundDate)))
    `).all(...scope.params) as GroupRow[];

    const details = db.prepare(`
      SELECT id, sn, brand, model, year, status, currentStatusRecordId, purchasePrice, supplierName,
        inboundDate,
        MAX(0, CAST(julianday(date('now', 'localtime')) - julianday(date(inboundDate)) AS INTEGER)) AS inboundDays
      FROM inventory
      WHERE deleted = 0 AND ${scope.sql}
      ORDER BY createdAt DESC
    `).all(...scope.params) as DetailRow[];

    const customSummary = db.prepare(`SELECT SUM(CASE WHEN i.status='custom' THEN 1 ELSE 0 END) AS custom,
      COALESCE(SUM(CASE WHEN i.status='custom' THEN i.purchasePrice ELSE 0 END),0) AS customCost,
      SUM(CASE WHEN ${stockEligibleSql('i')} THEN 1 ELSE 0 END) AS available,
      COALESCE(SUM(CASE WHEN ${stockEligibleSql('i')} THEN i.purchasePrice ELSE 0 END),0) AS availableCost
      FROM inventory i WHERE i.deleted=0 AND ${scoped.sql}`).get(...scoped.params) as {custom:number;customCost:number;available:number;availableCost:number};
    const byCustomStatus = db.prepare(`SELECT d.id,d.name,d.color,COUNT(*) AS count,COALESCE(SUM(i.purchasePrice),0) AS cost
      FROM inventory i JOIN inventory_status_records r ON r.id=i.currentStatusRecordId JOIN inventory_status_definitions d ON d.id=r.definitionId
      WHERE i.deleted=0 AND i.status='custom' AND r.closedAt IS NULL AND ${scoped.sql} GROUP BY d.id ORDER BY count DESC,d.name`).all(...scoped.params);
    return NextResponse.json(successResponse({
      summary: {
        custom: Number(customSummary.custom || 0),
        customCost: Number(customSummary.customCost || 0),
        available: Number(customSummary.available || 0),
        availableCost: Number(customSummary.availableCost || 0),
        total: Number(summary.total || 0),
        inStock: Number(summary.inStock || 0),
        sold: Number(summary.sold || 0),
        returning: Number(summary.returningCount || 0),
        renting: Number(summary.renting || 0),
        afterSale: Number(summary.afterSale || 0),
        reserved: Number(summary.reserved || 0),
        totalCost: Number(summary.totalCost || 0),
        inStockCost: Number(summary.inStockCost || 0),
        averageCost: Number(summary.averageCost || 0),
      },
      byBrand: normalizeGroup(byBrand),
      byModel: normalizeGroup(byModel),
      bySupplier: normalizeGroup(bySupplier),
      byAge: normalizeGroup(byAge),
      byCustomStatus,
      details: details.map(row => serializeInventoryStatus(row as DetailRow & {id:string})),
    }));
  } catch (error: unknown) {
    const authFailure = authErrorResponse(error);
    if (authFailure) return authFailure;
    console.error('GET /api/inventory/analysis error:', error);
    return NextResponse.json(
      errorResponse('DATABASE_ERROR', error instanceof Error ? error.message : '获取库存分析失败'),
      { status: 500 },
    );
  }
}
