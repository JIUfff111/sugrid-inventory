import { NextRequest, NextResponse } from 'next/server';
import db from '@/lib/db';
import { errorResponse, ErrorCode, parsePaginationParams, successResponse } from '@/lib/api-helpers';
import { authErrorResponse, requireUser } from '@/lib/auth';

const messages: Record<string, string> = {
  success: '登录成功', invalid_credentials: '用户名或密码错误', pending: '等待管理员审核', disabled: '账号不可用',
};

export async function GET(request: NextRequest) {
  try {
    const user = await requireUser();
    const { page, pageSize } = parsePaginationParams(request.nextUrl.searchParams);
    const total = (db.prepare('SELECT COUNT(*) AS total FROM login_events WHERE userId = ?').get(user.id) as {total:number}).total;
    const rows = db.prepare(`SELECT id, result, browser, os, createdAt FROM login_events WHERE userId = ?
      ORDER BY createdAt DESC, id DESC LIMIT ? OFFSET ?`).all(user.id, pageSize, (page - 1) * pageSize) as Array<Record<string, unknown>>;
    const records = rows.map(row => ({ ...row, success: row.result === 'success', browser: row.browser || '未记录', os: row.os || '未记录', message: messages[String(row.result)] || '登录未成功' }));
    return NextResponse.json(successResponse({ records, pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) } }));
  } catch (error) {
    return authErrorResponse(error) ?? NextResponse.json(errorResponse(ErrorCode.DATABASE_ERROR, '读取登录记录失败，请稍后重试'), { status: 500 });
  }
}
