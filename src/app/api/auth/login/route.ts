import { NextRequest, NextResponse } from 'next/server';
import db from '@/lib/db';
import { errorResponse, ErrorCode, successResponse } from '@/lib/api-helpers';
import { getUserById, hashPassword, publicUser, recordLoginEvent, startSession, USER_ROLES, verifyPassword } from '@/lib/auth';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json() as Record<string, unknown>;
    const username = typeof body.username === 'string' ? body.username.trim() : '';
    const password = typeof body.password === 'string' ? body.password : '';
    if (!username || !password || username.length > 64 || password.length > 200) return NextResponse.json(errorResponse(ErrorCode.VALIDATION_ERROR, '请输入有效的用户名和密码'), { status: 400 });
    const row = db.prepare('SELECT id, username, password, realName, role, status, createdAt, updatedAt FROM users WHERE username = ? COLLATE NOCASE').get(username) as Record<string, unknown> | undefined;
    if (!row || !verifyPassword(password, String(row.password))) {
      recordLoginEvent(row ? String(row.id) : null, username, 'invalid_credentials', request);
      return NextResponse.json(errorResponse(ErrorCode.UNAUTHORIZED, '用户名或密码错误'), { status: 401 });
    }
    if (String(row.status) !== 'active' || !(USER_ROLES as readonly string[]).includes(String(row.role))) {
      const message = String(row.status) === 'pending' ? '账号正在等待管理员审核' : '账号已被停用';
      recordLoginEvent(String(row.id), username, String(row.status) === 'pending' ? 'pending' : 'disabled', request);
      return NextResponse.json(errorResponse(ErrorCode.FORBIDDEN, message), { status: 403 });
    }
    // Upgrade the original development seed (admin123) after its first login.
    if (!String(row.password).startsWith('scrypt$')) {
      db.prepare('UPDATE users SET password = ?, updatedAt = ? WHERE id = ?').run(hashPassword(password), new Date().toISOString(), row.id);
    }
    await startSession(String(row.id), request);
    recordLoginEvent(String(row.id), username, 'success', request);
    return NextResponse.json(successResponse({ user: publicUser(getUserById(String(row.id))!) }));
  } catch (error) {
    // Parsing errors can include fragments of request bodies. Never log a
    // credential-bearing error message or echo internal database diagnostics.
    console.error('POST /api/auth/login failed:', error instanceof Error ? error.name : 'UnknownError');
    return NextResponse.json(errorResponse(ErrorCode.DATABASE_ERROR, '登录服务暂时不可用，请稍后重试'), { status: 500 });
  }
}

