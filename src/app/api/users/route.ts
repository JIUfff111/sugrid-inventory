import { NextRequest, NextResponse } from 'next/server';
import db from '@/lib/db';
import { errorResponse, ErrorCode, generateId, parsePaginationParams, successResponse } from '@/lib/api-helpers';
import { authErrorResponse, getUserById, hashPassword, publicUser, requireRole, USER_ROLES, verifyPassword } from '@/lib/auth';

function warehouseIds(body: Record<string, unknown>) {
  const raw = body.warehouseIds ?? body.warehouses ?? (body.warehouseId ? [body.warehouseId] : undefined);
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw) || raw.some(v => typeof v !== 'string' || !v.trim())) throw new Error('仓库列表格式不正确');
  const ids = [...new Set((raw as string[]).map(v => v.trim()))];
  if (ids.length > 100) throw new Error('最多分配 100 个仓库');
  for (const id of ids) if (!db.prepare("SELECT id FROM warehouses WHERE id = ? AND status = 'active'").get(id)) throw new Error('包含不存在或停用的仓库');
  return ids;
}
function assign(id: string, ids: string[] | undefined, actor: string, now: string) {
  if (!ids) return;
  db.prepare('DELETE FROM user_warehouses WHERE userId = ?').run(id);
  const stmt = db.prepare('INSERT INTO user_warehouses (userId, warehouseId, createdBy, createdAt) VALUES (?, ?, ?, ?)');
  for (const warehouseId of ids) stmt.run(id, warehouseId, actor, now);
}
function assertAssigned(role: string, status: string, ids: string[]) {
  if (role === 'warehouse_manager' && status === 'active' && !ids.some(id => db.prepare("SELECT id FROM warehouses WHERE id = ? AND status = 'active'").get(id))) {
    throw new Error('启用分仓管前必须分配至少一个启用仓库');
  }
}
function sameIds(left: string[], right: string[]) {
  return [...left].sort().join('\0') === [...right].sort().join('\0');
}
function failure(error: unknown) {
  return authErrorResponse(error) ?? NextResponse.json(errorResponse(ErrorCode.VALIDATION_ERROR, error instanceof Error ? error.message : '用户操作失败'), { status: 400 });
}
export async function GET(request: NextRequest) {
  try {
    await requireRole('admin');
    const query = request.nextUrl.searchParams;
    const clauses = ['1 = 1'];
    const args: string[] = [];
    const search = query.get('search')?.trim();
    if (search) {
      clauses.push("(instr(lower(u.username), lower(?)) > 0 OR instr(lower(COALESCE(u.realName,'')), lower(?)) > 0)");
      args.push(search, search);
    }
    for (const key of ['status', 'role'] as const) {
      const value = query.get(key);
      if (value && value !== 'all') { clauses.push(`u.${key} = ?`); args.push(value); }
    }
    const warehouseId = query.get('warehouseId');
    if (warehouseId && warehouseId !== 'all') {
      clauses.push('EXISTS (SELECT 1 FROM user_warehouses uw WHERE uw.userId = u.id AND uw.warehouseId = ?)');
      args.push(warehouseId);
    }
    const where = clauses.join(' AND ');
    const total = (db.prepare(`SELECT COUNT(*) AS total FROM users u WHERE ${where}`).get(...args) as {total:number}).total;
    // Existing callers expect the full list. New workbench callers explicitly
    // send page/pageSize and receive server-side pagination.
    const paginated = query.has('page') || query.has('pageSize');
    const { page, pageSize } = parsePaginationParams(query);
    const rows = paginated
      ? db.prepare(`SELECT u.id FROM users u WHERE ${where} ORDER BY u.createdAt DESC, u.id LIMIT ? OFFSET ?`).all(...args, pageSize, (page - 1) * pageSize)
      : db.prepare(`SELECT u.id FROM users u WHERE ${where} ORDER BY u.createdAt DESC, u.id`).all(...args);
    const users = (rows as {id:string}[]).map(row => publicUser(getUserById(row.id)!));
    const warehouses = db.prepare('SELECT id, code, COALESCE(name, warehouseName, code) AS name, status, isDefault FROM warehouses ORDER BY isDefault DESC, name COLLATE NOCASE').all();
    return NextResponse.json(successResponse({ users, warehouses, pagination: { page: paginated ? page : 1, pageSize: paginated ? pageSize : total, total, totalPages: paginated ? Math.ceil(total / pageSize) : Math.min(1, total) } }));
  } catch (error) { return failure(error); }
}
export async function POST(request: NextRequest) {
  try {
    const actor = await requireRole('admin');
    const body = await request.json() as Record<string, unknown>;
    const username = typeof body.username === 'string' ? body.username.trim() : '';
    const password = typeof body.password === 'string' ? body.password : '';
    const role = typeof body.role === 'string' ? body.role : 'warehouse_manager';
    const status = typeof body.status === 'string' ? body.status : 'active';
    const realName = typeof body.realName === 'string' ? body.realName.trim() : '';
    if (!/^[\p{L}\p{N}_.-]{3,64}$/u.test(username) || password.length < 8 || password.length > 200 || realName.length > 80) throw new Error('用户名、姓名或密码格式不正确');
    if (!(USER_ROLES as readonly string[]).includes(role)) throw new Error('角色不正确');
    if (!['pending', 'active', 'rejected', 'disabled'].includes(status)) throw new Error('用户状态不正确');
    if (db.prepare('SELECT id FROM users WHERE username = ? COLLATE NOCASE').get(username)) return NextResponse.json(errorResponse(ErrorCode.DUPLICATE_ENTRY, '用户名已存在'), { status: 409 });
    const ids = warehouseIds(body), now = new Date().toISOString(), id = generateId('user');
    assertAssigned(role, status, ids ?? []);
    db.transaction(() => {
      db.prepare('INSERT INTO users (id, username, password, realName, role, status, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(id, username, hashPassword(password), realName || null, role, status, now, now);
      assign(id, ids, actor.id, now);
    })();
    return NextResponse.json(successResponse({ user: publicUser(getUserById(id)!) }), { status: 201 });
  } catch (error) { return failure(error); }
}
export async function PATCH(request: NextRequest) {
  try {
    const actor = await requireRole('admin');
    const body = await request.json() as Record<string, unknown>;
    const id = typeof body.id === 'string' ? body.id.trim() : typeof body.userId === 'string' ? body.userId.trim() : '';
    const existing = getUserById(id);
    if (!existing) return NextResponse.json(errorResponse(ErrorCode.NOT_FOUND, '用户不存在'), { status: 404 });
    const role = body.role === undefined ? existing.role : String(body.role);
    const status = body.status === undefined ? existing.status : String(body.status);
    if (!(USER_ROLES as readonly string[]).includes(role)) throw new Error('角色不正确');
    if (!['pending', 'active', 'rejected', 'disabled'].includes(status)) throw new Error('用户状态不正确');
    const ids = warehouseIds(body), now = new Date().toISOString();
    const password = body.newPassword ?? body.password;
    const realName = body.realName === undefined ? existing.realName : typeof body.realName === 'string' ? body.realName.trim() || null : null;
    if (body.realName !== undefined && typeof body.realName !== 'string') throw new Error('姓名格式不正确');
    if ((realName?.length ?? 0) > 80) throw new Error('姓名不能超过 80 个字符');
    if (password !== undefined && (typeof password !== 'string' || password.length < 8 || password.length > 200)) throw new Error('密码长度应为 8-200 个字符');
    const previousIds = existing.warehouses.map(w => w.id);
    const assignmentsChanged = ids !== undefined && !sameIds(previousIds, ids);
    assertAssigned(role, status, ids ?? previousIds);
    const previousPassword = (db.prepare('SELECT password FROM users WHERE id = ?').get(id) as {password:string}).password;
    const passwordChanged = typeof password === 'string' && !verifyPassword(password, previousPassword);
    const permissionsChanged = role !== existing.role || status !== existing.status || assignmentsChanged;
    const changed = permissionsChanged || passwordChanged || realName !== existing.realName;
    db.transaction(() => {
      if (existing.role === 'admin' && existing.status === 'active' && (role !== 'admin' || status !== 'active')) {
        const count = db.prepare("SELECT COUNT(*) AS total FROM users WHERE role = 'admin' AND status = 'active'").get() as {total:number};
        if (count.total <= 1) throw new Error('必须保留至少一个有效管理员');
      }
      if (changed) db.prepare('UPDATE users SET realName = ?, role = ?, status = ?, updatedAt = ? WHERE id = ?').run(realName, role, status, now, id);
      if (passwordChanged) db.prepare('UPDATE users SET password = ? WHERE id = ?').run(hashPassword(password as string), id);
      if (assignmentsChanged) assign(id, ids, actor.id, now);
      if (permissionsChanged || passwordChanged) db.prepare('UPDATE sessions SET revokedAt = ? WHERE userId = ? AND revokedAt IS NULL').run(now, id);
    })();
    return NextResponse.json(successResponse({ user: publicUser(getUserById(id)!), sessionsRevoked: permissionsChanged || passwordChanged, message: passwordChanged ? '密码已重置，原登录会话已退出' : changed ? '用户已更新' : '没有需要更新的内容' }));
  } catch (error) { return failure(error); }
}
