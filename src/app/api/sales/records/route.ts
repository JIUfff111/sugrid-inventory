import { NextRequest, NextResponse } from 'next/server';
import db from '@/lib/db';
import { AuthError, requireRole } from '@/lib/auth';
import { errorResponse, successResponse } from '@/lib/api-helpers';
import { querySalesRecords, readSalesFilters, salesCsv, salesRecordDetail, salesSuggestions } from '@/lib/sales-records';

export async function GET(request: NextRequest) {
  try {
    await requireRole('admin');
    const params = request.nextUrl.searchParams;
    if (params.get('lookup') === '1') {
      const q=(params.get('q')||'').trim().slice(0,200);
      const page=Math.max(1,Math.floor(Number(params.get('page'))||1));
      const limit=Math.min(100,Math.max(1,Math.floor(Number(params.get('limit'))||8)));
      const matches=q.length>=4?salesSuggestions(db,q):[];
      const safePage=Math.min(page,Math.max(1,Math.ceil(matches.length/limit)));
      return NextResponse.json(successResponse({items:matches.slice((safePage-1)*limit,safePage*limit),total:matches.length,page:safePage,pageSize:limit}));
    }
    if (params.get('id')) {
      const detail = salesRecordDetail(db, params.get('id')!.trim());
      return detail ? NextResponse.json(successResponse(detail)) : NextResponse.json(errorResponse('NOT_FOUND','销售记录不存在'),{status:404});
    }
    const filters = readSalesFilters(params);
    const view = params.get('view') === 'orders' ? 'orders' : 'machines';
    const result = querySalesRecords(db,filters);
    if (params.get('format') === 'csv') return new NextResponse(salesCsv(result,view),{headers:{'Content-Type':'text/csv; charset=utf-8','Content-Disposition':`attachment; filename="sales-${view}.csv"`,'Cache-Control':'no-store'}});
    const page = Math.max(1,Math.floor(Number(params.get('page')) || 1));
    const pageSize = Math.min(100,Math.max(1,Math.floor(Number(params.get('pageSize')) || 20)));
    const rows = view === 'orders' ? result.orders : result.machines;
    return NextResponse.json(successResponse({items:rows.slice((page-1)*pageSize,page*pageSize),pagination:{page,pageSize,total:rows.length,totalPages:Math.ceil(rows.length/pageSize)},summary:result.summary,byDate:result.byDate,byChannel:result.byChannel,warehouses:result.warehouses,channels:result.channels}));
  } catch(error) {
    if (error instanceof AuthError) return NextResponse.json(errorResponse(error.code,error.message),{status:error.status});
    const message = error instanceof Error ? error.message : '读取销售记录失败';
    return NextResponse.json(errorResponse('DATABASE_ERROR',message),{status:/日期|销售状态/.test(message)?400:500});
  }
}
