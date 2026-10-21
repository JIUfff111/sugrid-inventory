import { requireRole, authErrorResponse } from '@/lib/auth';
/**
 * 首页工作台数据
 * GET /api/dashboard
 */

import { NextResponse } from 'next/server';
import db from '@/lib/db';
import { errorResponse, successResponse } from '@/lib/api-helpers';
import { querySalesRecords } from '@/lib/sales-records';

type CountRow = {
  total: number | null;
  inStock?: number | null;
  sold?: number | null;
  returningCount?: number | null;
  inStockCost?: number | null;
};

type RecentOrderRow = {
  id: string;
  purchaseNo: string;
  supplierName: string;
  purchaseDate: string;
  totalQuantity: number;
  totalAmount: number;
  isInbounded: number;
  createdAt: string;
};

function numberValue(value: number | null | undefined) {
  return Number(value || 0);
}

export async function GET() {
  try {
    await requireRole('admin');
    const inventory = db.prepare(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN status IN ('in_stock','custom') THEN 1 ELSE 0 END) AS inStock,
        SUM(CASE WHEN status = 'sold' THEN 1 ELSE 0 END) AS sold,
        SUM(CASE WHEN status = 'returning' THEN 1 ELSE 0 END) AS returningCount,
        COALESCE(SUM(CASE WHEN status IN ('in_stock','custom') THEN purchasePrice ELSE 0 END), 0) AS inStockCost
      FROM inventory
      WHERE deleted = 0
    `).get() as CountRow;

    const orderStats = db.prepare(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN isInbounded = 0 THEN 1 ELSE 0 END) AS drafts,
        SUM(CASE WHEN isInbounded = 1 THEN 1 ELSE 0 END) AS inbounded
      FROM purchase_orders
      WHERE deleted = 0
    `).get() as { total: number | null; drafts: number | null; inbounded: number | null };

    const salesStats = querySalesRecords(db, { search:'',dateFrom:'',dateTo:'',channel:'',warehouseId:'',status:'' }).summary;

    const skuCount = (db.prepare('SELECT COUNT(*) AS total FROM skus WHERE deleted = 0').get() as { total: number | null }).total;
    const supplierCount = (db.prepare("SELECT COUNT(*) AS total FROM suppliers WHERE deleted = 0 AND status = 'active'").get() as { total: number | null }).total;
    const recentOrders = db.prepare(`
      SELECT id, purchaseNo, supplierName, purchaseDate, totalQuantity,
        totalAmount, isInbounded, createdAt
      FROM purchase_orders
      WHERE deleted = 0
      ORDER BY createdAt DESC
      LIMIT 6
    `).all() as RecentOrderRow[];

    const stats = {
      inventoryTotal: numberValue(inventory.total),
      inStock: numberValue(inventory.inStock),
      sold: numberValue(inventory.sold),
      returning: numberValue(inventory.returningCount),
      inStockCost: numberValue(inventory.inStockCost),
      orderTotal: numberValue(orderStats.total),
      draftOrders: numberValue(orderStats.drafts),
      inboundedOrders: numberValue(orderStats.inbounded),
      salesTotal: salesStats.orders,
      salesQuantity: salesStats.quantity,
      salesAmount: salesStats.amount,
      salesCost: salesStats.cost,
      salesProfit: salesStats.profit,
      skuCount: numberValue(skuCount),
      supplierCount: numberValue(supplierCount),
    };

    const messages = [
      ...(stats.draftOrders > 0
        ? [{ id: 'draft-orders', tone: 'warn' as const, title: '采购草稿待处理', detail: `${stats.draftOrders} 张采购单尚未确认入库`, href: '/orders' }]
        : []),
      ...(stats.returning > 0
        ? [{ id: 'returning-inventory', tone: 'danger' as const, title: '供应商退货待完成', detail: `${stats.returning} 台机器正在办理供应商退货`, href: '/sales/return' }]
        : []),
      ...(stats.inStock === 0
        ? [{ id: 'empty-inventory', tone: 'info' as const, title: '当前暂无在库机器', detail: '完成采购入库后，机器会出现在库存清单中', href: '/orders' }]
        : []),
      ...(stats.skuCount > 0
        ? [{ id: 'sku-library', tone: 'success' as const, title: '产品库已准备就绪', detail: `当前可选择 ${stats.skuCount} 个 SKU`, href: '/orders' }]
        : [{ id: 'sku-library-empty', tone: 'warn' as const, title: '产品库暂无 SKU', detail: '采购录入前请先补充产品型号', href: '/orders' }]),
    ];

    return NextResponse.json(successResponse({ stats, recentOrders, messages }));
  } catch (error: unknown) {
    const authFailure = authErrorResponse(error);
    if (authFailure) return authFailure;
    console.error('GET /api/dashboard error:', error);
    return NextResponse.json(
      errorResponse('DATABASE_ERROR', error instanceof Error ? error.message : '获取首页数据失败'),
      { status: 500 },
    );
  }
}
