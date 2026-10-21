import { NextRequest, NextResponse } from 'next/server';
import db from '@/lib/db';
import { errorResponse, ErrorCode, generateId, successResponse } from '@/lib/api-helpers';
import { hashPassword, publicUser } from '@/lib/auth';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json() as Record<string, unknown>;
    const username = typeof body.username === 'string' ? body.username.trim() : '';
    const password = typeof body.password === 'string' ? body.password : '';
    const realName = typeof body.realName === 'string' ? body.realName.trim() : '';
    if (!/^[\p{L}\p{N}_.-]{3,64}$/u.test(username)) {
      return NextResponse.json(errorResponse(ErrorCode.VALIDATION_ERROR, '用户名需为 3-64 位字母、数字或 ._-'), { status: 400 });
    }
    if (password.length < 8 || password.length > 200) {
      return NextResponse.json(errorResponse(ErrorCode.VALIDATION_ERROR, '密码长度应为 8-200 个字符'), { status: 400 });
    }
    if (realName.length > 80) {
      return NextResponse.json(errorResponse(ErrorCode.VALIDATION_ERROR, '姓名不能超过 80 个字符'), { status: 400 });
    }
    const existing = db.prepare('SELECT id FROM users WHERE username = ? COLLATE NOCASE').get(username);
    if (existing) return NextResponse.json(errorResponse(ErrorCode.DUPLICATE_ENTRY, '用户名已存在'), { status: 409 });

    const now = new Date().toISOString();
    const id = generateId('user');
    db.prepare(`
      INSERT INTO users (id, username, password, realName, role, status, createdAt, updatedAt)
      VALUES (?, ?, ?, ?, 'warehouse_manager', 'pending', ?, ?)
    `).run(id, username, hashPassword(password), realName || null, now, now);
    const row = db.prepare('SELECT id, username, realName, role, status, createdAt, updatedAt FROM users WHERE id = ?').get(id) as Record<string, unknown>;
    return NextResponse.json(successResponse({
      user: { ...publicUser({ ...row, warehouses: [] } as never), status: 'pending' },
      message: '注册成功，请等待管理员审核',
    }), { status: 201 });
  } catch (error) {
    console.error('POST /api/auth/register failed:', error instanceof Error ? error.name : 'UnknownError');
    return NextResponse.json(errorResponse(ErrorCode.DATABASE_ERROR, '注册服务暂时不可用，请稍后重试'), { status: 500 });
  }
}

