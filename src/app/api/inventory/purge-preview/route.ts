import { NextRequest, NextResponse } from 'next/server';
import { authErrorResponse, assertWarehouseAccess, requireSystemAccount } from '@/lib/auth';
import { errorResponse, ErrorCode, successResponse } from '@/lib/api-helpers';
import { getPurgeCandidate } from '@/lib/inventory-purge';

export async function GET(request: NextRequest) {
  try {
    const user = await requireSystemAccount();
    const id = request.nextUrl.searchParams.get('id')?.trim() || '';
    if (!id) return NextResponse.json(errorResponse(ErrorCode.VALIDATION_ERROR, '库存 ID 不能为空'), { status: 400 });
    const candidate = getPurgeCandidate(id);
    if (!candidate) return NextResponse.json(errorResponse(ErrorCode.INVENTORY_NOT_FOUND, '库存记录不存在'), { status: 404 });
    assertWarehouseAccess(user, candidate.warehouseId);
    return NextResponse.json(successResponse({
      candidate: {
        id: candidate.id,
        sn: candidate.sn,
        status: candidate.status,
        warehouseId: candidate.warehouseId,
        purchaseNo: candidate.purchaseNo,
        supplierName: candidate.supplierName,
      },
      references: candidate.references,
      reasons: candidate.reasons,
      canDelete: candidate.reasons.length === 0,
    }));
  } catch (error: unknown) {
    const authFailure = authErrorResponse(error);
    if (authFailure) return authFailure;
    console.error('GET /api/inventory/purge-preview error:', error);
    return NextResponse.json(errorResponse(ErrorCode.DATABASE_ERROR, '获取删除预览失败'), { status: 500 });
  }
}
