import { NextRequest, NextResponse } from 'next/server';
import db from '@/lib/db';
import { authErrorResponse, AuthError, requireRole } from '@/lib/auth';
import { errorResponse, ErrorCode, successResponse } from '@/lib/api-helpers';

export async function GET(request: NextRequest) {
  try {
    await requireRole('admin');
    const sn = request.nextUrl.searchParams.get('sn')?.trim() || '';
    if (!sn) return NextResponse.json(errorResponse(ErrorCode.VALIDATION_ERROR, '请输入完整 SN'), { status: 400 });
    if (sn.length > 120 || /[\r\n\u0000-\u001f\u007f]/.test(sn)) {
      return NextResponse.json(errorResponse(ErrorCode.VALIDATION_ERROR, 'SN 格式不正确'), { status: 400 });
    }

    const inventory = db.prepare(`
      SELECT i.id, i.sn, i.deleted, i.status, i.warehouseId,
        COALESCE(w.name, w.warehouseName) AS warehouseName, po.purchaseNo
      FROM inventory i
      LEFT JOIN warehouses w ON w.id = i.warehouseId
      LEFT JOIN purchase_orders po ON po.id = i.purchaseOrderId
      WHERE lower(trim(i.sn)) = lower(trim(?))
      ORDER BY i.deleted, i.id
    `).all(sn) as Array<{ id: string; sn: string; deleted: number; status: string; warehouseId: string; warehouseName: string | null; purchaseNo: string | null }>;
    const drafts = db.prepare(`
      SELECT pi.id AS itemId, po.id AS orderId, po.purchaseNo, po.purchaseDate, pi.sn
      FROM purchase_items pi JOIN purchase_orders po ON po.id = pi.purchaseOrderId
      WHERE lower(trim(pi.sn)) = lower(trim(?)) AND pi.deleted = 0 AND po.deleted = 0 AND po.isInbounded = 0
      ORDER BY po.createdAt DESC, pi.createdAt DESC
    `).all(sn) as Array<{ itemId: string; orderId: string; purchaseNo: string; purchaseDate: string; sn: string }>;
    const history = db.prepare(`
      SELECT pi.id AS itemId, po.id AS orderId, po.purchaseNo, po.purchaseDate,
        po.isInbounded, po.deleted AS orderDeleted, pi.deleted AS itemDeleted
      FROM purchase_items pi JOIN purchase_orders po ON po.id = pi.purchaseOrderId
      WHERE lower(trim(pi.sn)) = lower(trim(?))
      ORDER BY po.createdAt DESC, pi.createdAt DESC
    `).all(sn) as Array<{ itemId: string; orderId: string; purchaseNo: string; purchaseDate: string; isInbounded: number; orderDeleted: number; itemDeleted: number }>;
    const index = db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_inventory_sn'").get() as { sql: string | null } | undefined;
    const partialIndexReady = /WHERE\s+deleted\s*=\s*0/i.test(index?.sql || '');
    const activeInventory = inventory.filter(item => Number(item.deleted) === 0);
    const softDeletedInventory = inventory.filter(item => Number(item.deleted) !== 0);
    const blockedBy = [
      ...activeInventory.map(item => ({ type: 'active_inventory', id: item.id, status: item.status, detail: `有效库存档案，状态：${item.status}，仓库：${item.warehouseName || item.warehouseId || '未分仓'}` })),
      ...drafts.map(item => ({ type: 'purchase_draft', id: item.orderId, itemId: item.itemId, purchaseNo: item.purchaseNo, status: 'draft', detail: `未入库采购草稿 ${item.purchaseNo || item.orderId}，日期：${item.purchaseDate || '未记录'}` })),
    ];
    const requiresMigration = softDeletedInventory.length > 0 && !partialIndexReady;
    return NextResponse.json(successResponse({
      sn,
      canUse: blockedBy.length === 0 && !requiresMigration,
      requiresMigration,
      partialIndexReady,
      blockedBy,
      softDeletedInventory,
      purchaseHistory: history.filter(item => Number(item.isInbounded) === 1 || Number(item.orderDeleted) === 1 || Number(item.itemDeleted) === 1),
      message: blockedBy.length
        ? '该 SN 当前被有效库存或未入库采购草稿占用。'
        : requiresMigration
          ? '该 SN 留有软删除库存记录；当前数据库索引尚未升级，需在此数据库执行 npm run db:init 并重启服务。'
          : softDeletedInventory.length
            ? '未发现有效占用。软删除档案已保留，当前数据库允许重新使用该 SN。'
            : '未发现有效库存或未完成采购草稿占用。',
    }));
  } catch (error) {
    if (error instanceof AuthError) return NextResponse.json(errorResponse(error.code, error.message), { status: error.status });
    return authErrorResponse(error) || NextResponse.json(errorResponse(ErrorCode.DATABASE_ERROR, error instanceof Error ? error.message : '检查 SN 失败'), { status: 500 });
  }
}
