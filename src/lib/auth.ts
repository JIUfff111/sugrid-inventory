import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { errorResponse } from '@/lib/api-helpers';
import {
  randomBytes,
  randomUUID,
  scryptSync,
  timingSafeEqual,
  createHash,
} from 'node:crypto';
import db from '@/lib/db';

export const SESSION_COOKIE = 'inventory_session';
export const SESSION_MAX_AGE = 60 * 60 * 24 * 7;

export const USER_ROLES = ['admin', 'warehouse_manager'] as const;
export type UserRole = (typeof USER_ROLES)[number];
export type UserStatus = 'pending' | 'active' | 'rejected' | 'disabled';

export interface AuthUser {
  id: string;
  username: string;
  realName: string | null;
  role: string;
  status: UserStatus | string;
  createdAt: string;
  updatedAt?: string;
  warehouses: Array<{
    id: string;
    code: string;
    name: string;
    status: string;
    isDefault: number;
  }>;
}

export class AuthError extends Error {
  readonly code: 'UNAUTHORIZED' | 'FORBIDDEN';
  readonly status: 401 | 403;

  constructor(code: 'UNAUTHORIZED' | 'FORBIDDEN', message: string) {
    super(message);
    this.name = 'AuthError';
    this.code = code;
    this.status = code === 'UNAUTHORIZED' ? 401 : 403;
  }
}

function assertPassword(password: string) {
  if (typeof password !== 'string' || password.length < 8 || password.length > 200) {
    throw new Error('密码长度应为 8-200 个字符');
  }
}

/** Hash passwords with Node's built-in memory-hard scrypt implementation. */
export function hashPassword(password: string): string {
  assertPassword(password);
  const salt = randomBytes(16);
  const derived = scryptSync(password, salt, 64, { N: 16_384, r: 8, p: 1 });
  return `scrypt$16384$8$1$${salt.toString('base64url')}$${derived.toString('base64url')}`;
}

/** Supports the current scrypt format and the original development seed. */
export function verifyPassword(password: string, encoded: string): boolean {
  if (typeof password !== 'string' || typeof encoded !== 'string') return false;
  if (!encoded.startsWith('scrypt$')) {
    const left = Buffer.from(password);
    const right = Buffer.from(encoded);
    return left.length === right.length && timingSafeEqual(left, right);
  }
  const parts = encoded.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (![n, r, p].every(Number.isSafeInteger) || n < 1024 || r < 1 || p < 1) return false;
  try {
    const salt = Buffer.from(parts[4], 'base64url');
    const expected = Buffer.from(parts[5], 'base64url');
    const actual = scryptSync(password, salt, expected.length, { N: n, r, p });
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

function hashSessionToken(token: string) {
  return createHash('sha256').update(token).digest('hex');
}

export function userFromRow(row: Record<string, unknown> | undefined): AuthUser | null {
  if (!row) return null;
  const user = {
    id: String(row.id),
    username: String(row.username),
    realName: row.realName == null ? null : String(row.realName),
    role: String(row.role || 'warehouse_manager'),
    status: String(row.status || 'pending'),
    createdAt: String(row.createdAt || ''),
    updatedAt: row.updatedAt == null ? undefined : String(row.updatedAt),
    warehouses: [],
  } as AuthUser;
  user.warehouses = db.prepare(`
    SELECT w.id, w.code, COALESCE(w.name, w.warehouseName, w.code) AS name,
      w.status, w.isDefault
    FROM user_warehouses uw
    JOIN warehouses w ON w.id = uw.warehouseId
    WHERE uw.userId = ?
    ORDER BY w.isDefault DESC, w.name COLLATE NOCASE
  `).all(user.id) as AuthUser['warehouses'];
  return user;
}

/** The explicit setting is required behind TLS-terminating proxies. Forwarded
 * headers are intentionally not trusted: a client can supply them directly. */
export function sessionCookieSecure(request?: Pick<Request, 'url'>): boolean {
  const configured = process.env.SESSION_COOKIE_SECURE?.trim().toLowerCase();
  if (configured === 'true' || configured === '1') return true;
  if (configured === 'false' || configured === '0') return false;
  if (configured) throw new Error('SESSION_COOKIE_SECURE 必须为 true 或 false');
  return request ? new URL(request.url).protocol === 'https:' : false;
}

function cookieOptions(request?: Pick<Request, 'url'>) {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: sessionCookieSecure(request),
    path: '/',
    maxAge: SESSION_MAX_AGE,
  };
}

/** Store only coarse device descriptions, never the user agent or token. */
export function requestDevice(request?: Pick<Request, 'headers'>) {
  const agent = request?.headers.get('user-agent')?.slice(0, 1000) || '';
  if (!agent) return { browser: null, os: null };
  const browser = /EdgA?\//.test(agent) ? 'Microsoft Edge'
    : /OPR\//.test(agent) ? 'Opera'
    : /Firefox\//.test(agent) ? 'Firefox'
    : /Chrome\//.test(agent) || /CriOS\//.test(agent) ? 'Chrome'
    : /Safari\//.test(agent) ? 'Safari' : '其他浏览器';
  const os = /Windows NT/.test(agent) ? 'Windows'
    : /Android/.test(agent) ? 'Android'
    : /iPhone|iPad|iPod/.test(agent) ? 'iOS'
    : /Macintosh|Mac OS X/.test(agent) ? 'macOS'
    : /Linux/.test(agent) ? 'Linux' : '其他系统';
  return { browser, os };
}

export function recordLoginEvent(userId: string | null, username: string, result: string, request?: Pick<Request, 'headers'>) {
  const device = requestDevice(request);
  db.prepare('INSERT INTO login_events (id,userId,username,result,browser,os,createdAt) VALUES (?,?,?,?,?,?,?)')
    .run(randomUUID(), userId, username.slice(0, 64), result, device.browser, device.os, new Date().toISOString());
}

/** Create a database-backed opaque session and return the raw cookie token. */
export function createSession(userId: string, request?: Pick<Request, 'headers'>): string {
  const token = randomBytes(32).toString('base64url');
  const now = new Date();
  const expires = new Date(now.getTime() + SESSION_MAX_AGE * 1000);
  db.prepare('DELETE FROM sessions WHERE expiresAt <= ? OR revokedAt IS NOT NULL').run(now.toISOString());
  const device = requestDevice(request);
  db.prepare(`
    INSERT INTO sessions (id, userId, tokenHash, expiresAt, createdAt, lastSeenAt, browser, os)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(randomUUID(), userId, hashSessionToken(token), expires.toISOString(), now.toISOString(), now.toISOString(), device.browser, device.os);
  return token;
}

export async function setSessionCookie(token: string, request?: Pick<Request, 'url'>) {
  const store = await cookies();
  store.set(SESSION_COOKIE, token, cookieOptions(request));
}

export async function startSession(userId: string, request?: Request) {
  // Resolve configuration before inserting a session, so a bad deployment
  // setting cannot leave a session that the browser never received.
  sessionCookieSecure(request);
  const token = createSession(userId, request);
  await setSessionCookie(token, request);
  return token;
}

export async function clearSessionCookie(request?: Pick<Request, 'url'>) {
  const store = await cookies();
  store.set(SESSION_COOKIE, '', { ...cookieOptions(request), maxAge: 0 });
}

export async function destroySession(token?: string | null, request?: Pick<Request, 'url'>) {
  const value = token ?? (await cookies()).get(SESSION_COOKIE)?.value;
  if (value) db.prepare('UPDATE sessions SET revokedAt = ? WHERE tokenHash = ? AND revokedAt IS NULL').run(new Date().toISOString(), hashSessionToken(value));
  await clearSessionCookie(request);
}

export async function currentSessionId(): Promise<string | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const row = db.prepare('SELECT id FROM sessions WHERE tokenHash = ? AND revokedAt IS NULL AND expiresAt > ?')
    .get(hashSessionToken(token), new Date().toISOString()) as { id: string } | undefined;
  return row?.id ?? null;
}

export async function getCurrentUser(): Promise<AuthUser | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const now = new Date().toISOString();
  const row = db.prepare(`
    SELECT u.id, u.username, u.realName, u.role, u.status, u.createdAt, u.updatedAt
    FROM sessions s JOIN users u ON u.id = s.userId
    WHERE s.tokenHash = ? AND s.revokedAt IS NULL AND s.expiresAt > ?
  `).get(hashSessionToken(token), now) as Record<string, unknown> | undefined;
  if (!row || String(row.status) !== 'active' || !USER_ROLES.includes(String(row.role) as UserRole)) return null;
  db.prepare('UPDATE sessions SET lastSeenAt = ? WHERE tokenHash = ? AND revokedAt IS NULL').run(now, hashSessionToken(token));
  return userFromRow(row);
}

export async function requireUser(): Promise<AuthUser> {
  const user = await getCurrentUser();
  if (!user) throw new AuthError('UNAUTHORIZED', '请先登录');
  return user;
}

export function hasRole(user: AuthUser, roles: UserRole | readonly UserRole[]): boolean {
  const allowed = Array.isArray(roles) ? roles : [roles];
  return allowed.includes(user.role as UserRole);
}

export async function requireRole(...roles: UserRole[]): Promise<AuthUser> {
  const user = await requireUser();
  if (roles.length > 0 && !hasRole(user, roles)) throw new AuthError('FORBIDDEN', '没有执行此操作的权限');
  return user;
}

export function publicUser(user: AuthUser) {
  return {
    id: user.id,
    username: user.username,
    realName: user.realName,
    role: user.role,
    status: user.status,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
    warehouses: user.warehouses,
  };
}


/** Read fresh account and assignment metadata without exposing password fields. */
export function getUserById(id: string): AuthUser | null {
  return userFromRow(db.prepare('SELECT id, username, realName, role, status, createdAt, updatedAt FROM users WHERE id = ?').get(id) as Record<string, unknown> | undefined);
}

export function authErrorResponse(error: unknown) {
  if (error instanceof AuthError) return NextResponse.json(errorResponse(error.code, error.message), { status: error.status });
  return null;
}

export function assertWarehouseAccess(user: AuthUser, warehouseId: string) {
  const warehouse = db.prepare("SELECT id FROM warehouses WHERE id = ? AND status = 'active'").get(warehouseId);
  if (!warehouse || (user.role !== 'admin' && !user.warehouses.some(w => w.id === warehouseId && w.status === 'active'))) {
    throw new AuthError('FORBIDDEN', '无权访问该仓库');
  }
}

/** Alias must be a trusted SQL identifier supplied by application code. */
export function warehouseScope(user: AuthUser, requestedId?: string | null, alias = ''): { sql: string; params: string[] } {
  const column = alias ? alias + '.warehouseId' : 'warehouseId';
  if (requestedId) {
    assertWarehouseAccess(user, requestedId);
    return { sql: column + ' = ?', params: [requestedId] };
  }
  if (user.role === 'admin') return { sql: '1 = 1', params: [] };
  const ids = user.warehouses.filter(w => w.status === 'active').map(w => w.id);
  return ids.length ? { sql: column + ' IN (' + ids.map(() => '?').join(',') + ')', params: ids } : { sql: '0 = 1', params: [] };
}
