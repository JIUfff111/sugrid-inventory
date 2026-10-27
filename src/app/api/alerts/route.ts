import { NextResponse } from 'next/server';
import db from '@/lib/db';
import { errorResponse, ErrorCode, successResponse } from '@/lib/api-helpers';
import { AuthError, requireRole } from '@/lib/auth';
import { formatProductName } from '@/lib/product-name';

export async function GET() {
  try {
    const user = await requireRole('admin', 'warehouse_manager');
    const items: Array<{ id: string; kind: string; level: 'info' | 'warning' | 'danger'; title: string; detail: string; href: string }> = [];
    if (user.role === 'admin') {
      const afterSales = db.prepare("SELECT a.id, a.afterSaleNo, a.sn, a.receivedAt, i.brand, i.model FROM after_sale_records a LEFT JOIN inventory i ON i.id = a.inventoryId WHERE a.deleted = 0 AND a.status IN ('received', 'processing') AND a.receivedAt IS NOT NULL AND datetime(a.receivedAt) <= datetime('now', '-1 day') ORDER BY a.receivedAt ASC").all() as Array<{ id: string; afterSaleNo: string; sn: string; receivedAt: string; brand?: string; model?: string }>;
      afterSales.forEach((row) => items.push({ id: `after-sale:${row.id}`, kind: 'after_sale', level: 'danger', title: `售后单 ${row.afterSaleNo} 已超过 1 天未处理`, detail: `${formatProductName(row)} · SN ${row.sn} · 收到于 ${row.receivedAt}`, href: '/after-sales?view=stock' }));
      const transfers = db.prepare("SELECT COUNT(*) AS total FROM transfers WHERE status = 'pending'").get() as { total: number };
      if (Number(transfers.total)) items.push({ id: 'transfers:pending', kind: 'transfer', level: 'warning', title: '有调拨申请待审批', detail: `当前有 ${transfers.total} 条调拨申请等待管理员处理`, href: '/inventory?view=transfers' });
      const pendingUsers = db.prepare("SELECT COUNT(*) AS total FROM users WHERE status = 'pending'").get() as { total: number };
      if (Number(pendingUsers.total)) items.push({ id: 'users:pending', kind: 'users', level: 'warning', title: '有新账号待审核', detail: `当前有 ${pendingUsers.total} 个注册账号等待管理员审核`, href: '/settings/users' });
    }
    if (user.role === 'admin') {
    const rentals = db.prepare("SELECT id, rentalNo, sn, brand, model, rentalEndDate, CAST(julianday(date(rentalEndDate)) - julianday(date('now', '+8 hours')) AS INTEGER) AS daysUntilDue FROM rental_records WHERE deleted = 0 AND status = 'renting' AND date(rentalEndDate) <= date('now', '+8 hours', '+3 day') ORDER BY rentalEndDate ASC").all() as Array<{ id: string; rentalNo: string; sn: string; brand: string; model: string; rentalEndDate: string; daysUntilDue: number }>;
    rentals.forEach((row) => { const overdue = row.daysUntilDue < 0; items.push({ id: `rental:${row.id}`, kind: 'rental', level: overdue || row.daysUntilDue === 0 ? 'danger' : 'warning', title: overdue ? `租赁单 ${row.rentalNo} 已逾期` : `租赁单 ${row.rentalNo} 将在 ${row.daysUntilDue} 天内到期`, detail: `${formatProductName(row)} · SN ${row.sn} · 到期日 ${row.rentalEndDate}`, href: '/rental' }); });
    }
    return NextResponse.json(successResponse({ items }));
  } catch (error) { if (error instanceof AuthError) return NextResponse.json(errorResponse(error.code, error.message), { status: error.status }); return NextResponse.json(errorResponse(ErrorCode.DATABASE_ERROR, error instanceof Error ? error.message : '获取提醒失败'), { status: 500 }); }
}
