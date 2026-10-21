import { NextRequest, NextResponse } from 'next/server';
import db from '@/lib/db';
import { errorResponse, ErrorCode, successResponse } from '@/lib/api-helpers';
import { authErrorResponse, clearSessionCookie, currentSessionId, requireUser } from '@/lib/auth';

function failure(error: unknown) {
  return authErrorResponse(error) ?? NextResponse.json(errorResponse(ErrorCode.VALIDATION_ERROR, error instanceof Error ? error.message : '会话操作失败'), { status: 400 });
}

export async function GET() {
  try {
    const user = await requireUser();
    const currentId = await currentSessionId();
    const rows = db.prepare(`SELECT id, browser, os, createdAt, lastSeenAt, expiresAt FROM sessions
      WHERE userId = ? AND revokedAt IS NULL AND expiresAt > ? ORDER BY lastSeenAt DESC, createdAt DESC`)
      .all(user.id, new Date().toISOString()) as Array<Record<string, unknown>>;
    const sessions = rows.map(row => ({ ...row, browser: row.browser || '未记录', os: row.os || '未记录',
      lastActiveAt: row.lastSeenAt, current: row.id === currentId, isCurrent: row.id === currentId }));
    return NextResponse.json(successResponse({ sessions }));
  } catch (error) { return failure(error); }
}

export async function DELETE(request: NextRequest) {
  try {
    const user = await requireUser();
    const body = await request.json() as Record<string, unknown>;
    const currentId = await currentSessionId();
    const now = new Date().toISOString();
    let requiresLogin = false;
    let count = 0;
    if (body.allOthers === true) {
      count = db.prepare('UPDATE sessions SET revokedAt = ? WHERE userId = ? AND id != ? AND revokedAt IS NULL').run(now, user.id, currentId || '').changes;
    } else if (body.all === true) {
      count = db.prepare('UPDATE sessions SET revokedAt = ? WHERE userId = ? AND revokedAt IS NULL').run(now, user.id).changes;
      requiresLogin = true;
    } else {
      if (typeof body.id !== 'string' || !body.id) throw new Error('请选择要退出的会话');
      const result = db.prepare('UPDATE sessions SET revokedAt = ? WHERE id = ? AND userId = ? AND revokedAt IS NULL').run(now, body.id, user.id);
      if (!result.changes) return NextResponse.json(errorResponse(ErrorCode.NOT_FOUND, '会话不存在或已退出'), { status: 404 });
      count = result.changes;
      requiresLogin = body.id === currentId;
    }
    if (requiresLogin) await clearSessionCookie(request);
    return NextResponse.json(successResponse({ requiresLogin, count, message: '登录会话已退出' }));
  } catch (error) { return failure(error); }
}
