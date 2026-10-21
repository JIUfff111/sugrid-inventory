import { NextRequest, NextResponse } from 'next/server';
import db from '@/lib/db';
import { errorResponse, ErrorCode, successResponse } from '@/lib/api-helpers';
import { AuthError, requireRole } from '@/lib/auth';

export async function GET(request: NextRequest) {
  try {
    await requireRole('admin'); const search = new URL(request.url).searchParams.get('search')?.trim() || ''; const pattern = `%${search}%`;
    const rows = db.prepare(`SELECT s.*, a.afterSaleNo, a.customerName, a.customerPhone, a.issueType, a.resolutionType, a.status AS afterSaleStatus, i.sn, i.brand, i.model, i.year FROM after_sale_stock s JOIN after_sale_records a ON a.id = s.afterSaleId JOIN inventory i ON i.id = s.inventoryId WHERE a.deleted = 0 AND (? = '' OR a.afterSaleNo LIKE ? OR i.sn LIKE ? OR i.brand LIKE ? OR i.model LIKE ?) ORDER BY s.receivedAt DESC`).all(search, pattern, pattern, pattern, pattern);
    return NextResponse.json(successResponse(rows));
  } catch (error) { if (error instanceof AuthError) return NextResponse.json(errorResponse(error.code, error.message), { status: error.status }); return NextResponse.json(errorResponse(ErrorCode.DATABASE_ERROR, error instanceof Error ? error.message : '获取售后暂存库失败'), { status: 500 }); }
}
