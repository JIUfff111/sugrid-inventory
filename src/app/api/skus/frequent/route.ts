import { NextResponse } from 'next/server';
import db from '@/lib/db';
import { AuthError, requireRole } from '@/lib/auth';
import { ErrorCode, errorResponse, successResponse } from '@/lib/api-helpers';

type FrequentSKU = { skuId: string; count: number };

export async function GET() {
  try {
    const actor = await requireRole('admin');
    const items = db.prepare(`
      SELECT sku.id AS skuId, COUNT(*) AS count
      FROM purchase_items item
      JOIN purchase_orders purchase ON purchase.id = item.purchaseOrderId
      JOIN skus sku ON sku.id = COALESCE(item.skuId, (
        SELECT legacy.id FROM skus legacy
        WHERE legacy.deleted = 0
          AND (legacy.brand = item.brand OR (legacy.brand = '小米' AND lower(item.brand) IN ('redmi', '红米')))
          AND legacy.model = item.model AND legacy.year IS item.year
          AND (legacy.productType = item.productType
            OR (legacy.productType = '游戏本' AND item.productType = '笔记本电脑')
            OR (legacy.productType = '笔记本电脑' AND item.productType = '游戏本'))
        ORDER BY legacy.id LIMIT 1
      ))
      WHERE COALESCE(item.recordedBy, purchase.createdBy) = ?
        AND purchase.deleted = 0 AND item.deleted = 0 AND sku.deleted = 0
        AND item.createdAt >= datetime('now', '-3 days')
      GROUP BY sku.id
      ORDER BY count DESC, MAX(item.createdAt) DESC, sku.id
      LIMIT 30
    `).all(actor.id) as FrequentSKU[];
    return NextResponse.json(successResponse({ items }));
  } catch (error: unknown) {
    if (error instanceof AuthError) return NextResponse.json(errorResponse(error.code, error.message), { status: error.status });
    console.error('GET /api/skus/frequent error:', error);
    return NextResponse.json(errorResponse(ErrorCode.DATABASE_ERROR, '获取常用型号失败'), { status: 500 });
  }
}
