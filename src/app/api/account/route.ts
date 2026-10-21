import { NextRequest, NextResponse } from 'next/server';
import db from '@/lib/db';
import { errorResponse, ErrorCode, successResponse } from '@/lib/api-helpers';
import { authErrorResponse, clearSessionCookie, getUserById, hashPassword, publicUser, requireUser, sessionCookieSecure, verifyPassword } from '@/lib/auth';

function failure(error: unknown) {
  return authErrorResponse(error) ?? NextResponse.json(errorResponse(ErrorCode.VALIDATION_ERROR, error instanceof Error ? error.message : '账号操作失败'), { status: 400 });
}

export async function GET() {
  try {
    const user = await requireUser();
    return NextResponse.json(successResponse({ user: publicUser(user) }));
  } catch (error) { return failure(error); }
}

export async function PATCH(request: NextRequest) {
  try {
    const user = await requireUser();
    const body = await request.json() as Record<string, unknown>;
    const changingPassword = body.newPassword !== undefined;
    const now = new Date().toISOString();
    if (changingPassword) {
      sessionCookieSecure(request);
      const oldPassword = body.oldPassword ?? body.currentPassword;
      const newPassword = body.newPassword;
      if (typeof oldPassword !== 'string' || !oldPassword) throw new Error('请输入当前密码');
      if (typeof newPassword !== 'string' || newPassword.length < 8 || newPassword.length > 200) throw new Error('新密码长度应为 8-200 个字符');
      const row = db.prepare('SELECT password FROM users WHERE id = ?').get(user.id) as {password:string};
      if (!verifyPassword(oldPassword, row.password)) throw new Error('当前密码不正确');
      if (verifyPassword(newPassword, row.password)) throw new Error('新密码不能与当前密码相同');
      const encoded = hashPassword(newPassword);
      db.transaction(() => {
        // A concurrent password update invalidates the old-password proof.
        const result = db.prepare('UPDATE users SET password = ?, updatedAt = ? WHERE id = ? AND password = ?').run(encoded, now, user.id, row.password);
        if (result.changes !== 1) throw new Error('密码已发生变化，请重新登录后操作');
        db.prepare('UPDATE sessions SET revokedAt = ? WHERE userId = ? AND revokedAt IS NULL').run(now, user.id);
      })();
      await clearSessionCookie(request);
      return NextResponse.json(successResponse({ requiresLogin: true, message: '密码已修改，请重新登录' }));
    }
    if (typeof body.realName !== 'string') throw new Error('请填写姓名');
    const realName = body.realName.trim();
    if (!realName || realName.length > 80) throw new Error('姓名需为 1-80 个字符');
    if (realName !== user.realName) db.prepare('UPDATE users SET realName = ?, updatedAt = ? WHERE id = ?').run(realName, now, user.id);
    return NextResponse.json(successResponse({ user: publicUser(getUserById(user.id)!), requiresLogin: false, message: '个人资料已保存' }));
  } catch (error) { return failure(error); }
}
