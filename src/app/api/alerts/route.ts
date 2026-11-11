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
      const afterSales = db.prepare("SELECT a.id, a.afterSaleNo, a.returnTrackingNo, a.status, a.sn, a.receivedAt, i.brand, i.model FROM after_sale_records a LEFT JOIN inventory i ON i.id = a.inventoryId WHERE a.deleted = 0 AND a.status IN ('received', 'processing') AND a.receivedAt IS NOT NULL AND datetime(a.receivedAt) <= datetime('now', '-1 day') ORDER BY a.receivedAt ASC").all() as Array<{ id: string; afterSaleNo: string; returnTrackingNo?: string | null; status: string; sn: string; receivedAt: string; brand?: string; model?: string }>;
      afterSales.forEach((row) => {
        const tracking = row.returnTrackingNo?.trim() || '未登记寄回快递号';
        const progress = row.status === 'processing' ? '处理中' : '待开始处理';
        items.push({ id: `after-sale:${row.id}`, kind: 'after_sale', level: 'danger', title: `售后快递 ${tracking} 的机器签收超过 1 天仍${progress}`, detail: `售后单 ${row.afterSaleNo} · ${formatProductName(row)} · SN ${row.sn} · 签收于 ${row.receivedAt}`, href: `/after-sales?recordId=${encodeURIComponent(row.id)}` });
      });
      const transfers = db.prepare("SELECT COUNT(*) AS total FROM transfers WHERE status = 'pending'").get() as { total: number };
      if (Number(transfers.total)) items.push({ id: 'transfers:pending', kind: 'transfer', level: 'warning', title: '有调拨申请待审批', detail: `当前有 ${transfers.total} 条调拨申请等待管理员处理`, href: '/inventory?view=transfers' });
      const pendingUsers = db.prepare("SELECT COUNT(*) AS total FROM users WHERE status = 'pending'").get() as { total: number };
      if (Number(pendingUsers.total)) items.push({ id: 'users:pending', kind: 'users', level: 'warning', title: '有新账号待审核', detail: `当前有 ${pendingUsers.total} 个注册账号等待管理员审核`, href: '/settings/users' });
    }
    if (user.role === 'admin') {
    const rentals = db.prepare(`SELECT r.id, r.rentalOrderId, COALESCE(ro.rentalNo, r.rentalNo) AS rentalNo,
      r.customerName, r.rentalEndDate,
      CAST(julianday(date(r.rentalEndDate)) - julianday(date('now', '+8 hours')) AS INTEGER) AS daysUntilDue
      FROM rental_records r LEFT JOIN rental_orders ro ON ro.id = r.rentalOrderId
      WHERE r.deleted = 0 AND r.status = 'renting'
        AND date(r.rentalEndDate) <= date('now', '+8 hours', '+3 day')
      ORDER BY r.rentalEndDate ASC`).all() as Array<{
        id: string; rentalOrderId: string | null; rentalNo: string; customerName: string | null;
        rentalEndDate: string; daysUntilDue: number;
      }>;
    const rentalOrders = new Map<string, typeof rentals>();
    rentals.forEach((row) => {
      const key = row.rentalOrderId || row.rentalNo || row.id;
      const order = rentalOrders.get(key);
      if (order) order.push(row); else rentalOrders.set(key, [row]);
    });
    rentalOrders.forEach((rows) => {
      const first = rows[0];
      const overdueCount = rows.filter(row => row.daysUntilDue < 0).length;
      const dueTodayCount = rows.filter(row => row.daysUntilDue === 0).length;
      const dueSoonCount = rows.length - overdueCount - dueTodayCount;
      const customer = first.customerName?.trim() || '未填写客户姓名';
      const orderNo = first.rentalNo || '租赁单号未记录';
      const title = `租赁单 ${orderNo} · ${customer} 有 ${rows.length} 台机器需跟进`;
      const summary = [
        overdueCount ? `逾期 ${overdueCount} 台` : '',
        dueTodayCount ? `今日到期 ${dueTodayCount} 台` : '',
        dueSoonCount ? `3 天内到期 ${dueSoonCount} 台` : '',
      ].filter(Boolean).join(' · ');
      const level = overdueCount || dueTodayCount ? 'danger' : 'warning';
      items.push({
        id: `rental:${first.rentalOrderId || orderNo}`,
        kind: 'rental', level, title,
        detail: `${summary} · 最早到期 ${first.rentalEndDate}`,
        href: '/rental',
      });
    });
    }
    return NextResponse.json(successResponse({ items }));
  } catch (error) { if (error instanceof AuthError) return NextResponse.json(errorResponse(error.code, error.message), { status: error.status }); return NextResponse.json(errorResponse(ErrorCode.DATABASE_ERROR, error instanceof Error ? error.message : '获取提醒失败'), { status: 500 }); }
}
