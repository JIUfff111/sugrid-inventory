/** Real route handlers + migrated isolated in-memory SQLite; never opens data/inventory.db. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const Database = require('better-sqlite3');
const { NextRequest } = require('next/server');
const { initDatabase, seedDatabase } = require('./database.cjs');

const root = path.resolve(__dirname, '..');
function load(relativePath, overrides = {}) {
  const filename = path.join(root, relativePath);
  const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }, fileName: filename,
  }).outputText;
  const target = new Module(filename, module);
  target.filename = filename;
  target.paths = Module._nodeModulePaths(path.dirname(filename));
  const native = target.require.bind(target);
  target.require = name => Object.hasOwn(overrides, name) ? overrides[name] : native(name);
  target._compile(compiled, filename);
  return target.exports;
}
async function run() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  const originalSecure = process.env.SESSION_COOKIE_SECURE;
  try {
    initDatabase(db); seedDatabase(db); initDatabase(db);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM schema_migrations WHERE version=5').get().n, 1);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM schema_migrations WHERE version=6').get().n, 1);
    let token;
    let lastCookie;
    const headers = { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0' };
    const helpers = load('src/lib/api-helpers.ts');
    const database = { __esModule: true, default: db };
    const auth = load('src/lib/auth.ts', {
      '@/lib/db': database, '@/lib/api-helpers': helpers,
      'next/headers': { cookies: async () => ({ get: () => token ? { value: token } : undefined, set: (name, value, options) => { lastCookie = {name,value,options}; token = value || undefined; } }) },
    });
    const overrides = { '@/lib/db': database, '@/lib/auth': auth, '@/lib/api-helpers': helpers };
    const login = load('src/app/api/auth/login/route.ts', overrides);
    const authMe = load('src/app/api/auth/me/route.ts', overrides);
    const register = load('src/app/api/auth/register/route.ts', overrides);
    const users = load('src/app/api/users/route.ts', overrides);
    const account = load('src/app/api/account/route.ts', overrides);
    const sessions = load('src/app/api/account/sessions/route.ts', overrides);
    const history = load('src/app/api/account/login-history/route.ts', overrides);
    const req = (route, body, method = 'POST', host = 'http://192.168.10.2:3000') => new NextRequest(host + route, { method, headers: { ...headers, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    async function call(fn, request, status) {
      const result = await fn(request);
      const payload = await result.json();
      assert.equal(result.status, status, JSON.stringify(payload));
      return payload.data;
    }
    delete process.env.SESSION_COOKIE_SECURE;
    assert.equal(auth.sessionCookieSecure(req('/login')), false);
    assert.equal(auth.sessionCookieSecure(req('/login', undefined, 'GET', 'https://inventory.example')), true);
    assert.equal(auth.sessionCookieSecure(new NextRequest('http://192.168.10.2', {headers:{'x-forwarded-proto':'https'}})), false);
    process.env.SESSION_COOKIE_SECURE = 'true'; assert.equal(auth.sessionCookieSecure(req('/login')), true);
    process.env.SESSION_COOKIE_SECURE = 'false'; assert.equal(auth.sessionCookieSecure(req('/login', undefined, 'GET', 'https://inventory.example')), false);
    process.env.SESSION_COOKIE_SECURE = 'invalid'; assert.throws(() => auth.sessionCookieSecure(req('/login')));
    delete process.env.SESSION_COOKIE_SECURE;
    await call(users.GET, req('/api/users', undefined, 'GET'), 401);
    await call(authMe.GET, undefined, 401);
    const brokenMe = load('src/app/api/auth/me/route.ts', { ...overrides, '@/lib/auth': { ...auth, getCurrentUser: async () => { throw new Error('temporary database outage'); } } });
    const originalConsole = console.error;
    try {
      console.error = () => {};
      await call(brokenMe.GET, undefined, 500);
    } finally { console.error = originalConsole; }
    await call(login.POST, req('/api/auth/login', {username:'admin',password:'incorrect'}), 401);
    await call(login.POST, req('/api/auth/login', {username:'admin',password:'admin123'}), 200);
    const adminToken = token;
    await call(authMe.GET, undefined, 200);
    const adminId = db.prepare("SELECT id FROM users WHERE username='admin'").get().id;
    assert.equal(db.prepare('SELECT isSystemAccount FROM users WHERE id=?').get(adminId).isSystemAccount, 1);
    assert.equal(lastCookie.options.secure, false);
    assert.equal(lastCookie.options.httpOnly, true);
    assert.equal(lastCookie.options.sameSite, 'lax');
    const event = db.prepare("SELECT * FROM login_events WHERE result='success'").get();
    assert.equal(event.browser, 'Microsoft Edge'); assert.equal(event.os, 'Windows');
    assert(!JSON.stringify(event).includes(adminToken)); assert(!JSON.stringify(event).includes('admin123'));
    assert.notEqual(db.prepare('SELECT tokenHash FROM sessions').get().tokenHash, adminToken);
    const pending = await call(register.POST, req('/api/auth/register', {username:'pending-test',password:'AccountTest2026!',realName:'待审核'}), 201);
    await call(login.POST, req('/api/auth/login', {username:'pending-test',password:'AccountTest2026!'}), 403);
    token = adminToken;
    await call(users.PATCH, req('/api/users', {id:pending.user.id,status:'active'}, 'PATCH'), 400);
    await call(users.POST, req('/api/users', {username:'no-warehouse',password:'AccountTest2026!',role:'warehouse_manager'}), 400);
    const approved = await call(users.PATCH, req('/api/users', {id:pending.user.id,status:'active',warehouseIds:['warehouse_main']}, 'PATCH'), 200);
    assert.equal(approved.sessionsRevoked, true);
    await call(login.POST, req('/api/auth/login', {username:'pending-test',password:'AccountTest2026!'}), 200);
    const managerToken = token;
    await call(users.GET, req('/api/users', undefined, 'GET'), 403);
    token = adminToken;
    const changedName = await call(users.PATCH, req('/api/users', {id:pending.user.id,realName:'分仓用户',warehouseIds:['warehouse_main']}, 'PATCH'), 200);
    assert.equal(changedName.sessionsRevoked, false);
    const same = await call(users.PATCH, req('/api/users', {id:pending.user.id,realName:'分仓用户',warehouseIds:['warehouse_main'],newPassword:'AccountTest2026!'}, 'PATCH'), 200);
    assert.equal(same.sessionsRevoked, false);
    token = managerToken; assert.equal((await auth.getCurrentUser()).realName, '分仓用户');
    token = adminToken;
    const filtered = await call(users.GET, req('/api/users?search=分仓&role=warehouse_manager&status=active&warehouseId=warehouse_main&page=1&pageSize=1', undefined, 'GET'), 200);
    assert.equal(filtered.users.length, 1); assert.equal(filtered.pagination.total, 1);
    assert.equal((await call(users.GET, req('/api/users', undefined, 'GET'), 200)).users.length, 2);
    await call(users.PATCH, req('/api/users', {id:adminId,status:'disabled'}, 'PATCH'), 400);
    await call(users.PATCH, req('/api/users', {id:pending.user.id,status:'disabled'}, 'PATCH'), 200);
    token = managerToken; assert.equal(await auth.getCurrentUser(), null);
    token = adminToken;
    await call(users.PATCH, req('/api/users', {id:pending.user.id,status:'active'}, 'PATCH'), 200);
    await call(login.POST, req('/api/auth/login', {username:'pending-test',password:'AccountTest2026!'}), 200);
    const currentToken = token;
    const legacyToken = auth.createSession(pending.user.id);
    const anotherToken = auth.createSession(pending.user.id, req('/login'));
    assert(legacyToken && anotherToken);
    const sessionList = (await call(sessions.GET, undefined, 200)).sessions;
    assert.equal(sessionList.filter(item => item.current).length, 1);
    assert(sessionList.some(item => item.browser === '未记录' && item.os === '未记录'));
    assert(sessionList.every(item => !Object.hasOwn(item, 'tokenHash')));
    const adminSessionId = db.prepare('SELECT id FROM sessions WHERE userId=? AND revokedAt IS NULL').get(adminId).id;
    await call(sessions.DELETE, req('/api/account/sessions', {id:adminSessionId}, 'DELETE'), 404);
    const revokeOthers = await call(sessions.DELETE, req('/api/account/sessions', {allOthers:true}, 'DELETE'), 200);
    assert.equal(revokeOthers.requiresLogin, false); assert.equal(revokeOthers.count, 2);
    token = legacyToken; assert.equal(await auth.getCurrentUser(), null);
    token = currentToken;
    await call(account.PATCH, req('/api/account', {realName:'个人姓名'}, 'PATCH'), 200);
    assert(await auth.getCurrentUser());
    await call(account.PATCH, req('/api/account', {oldPassword:'wrong',newPassword:'UpdatedTest2026!'}, 'PATCH'), 400);
    assert(await auth.getCurrentUser());
    const personalHistory = await call(history.GET, req('/api/account/login-history?page=1&pageSize=1', undefined, 'GET'), 200);
    assert.equal(personalHistory.records.length, 1); assert.equal(personalHistory.pagination.total, 3);
    assert.equal(personalHistory.records[0].browser, 'Microsoft Edge');
    db.exec(`CREATE TRIGGER reject_session_revoke BEFORE UPDATE OF revokedAt ON sessions
      WHEN OLD.userId = '${pending.user.id}' BEGIN SELECT RAISE(ABORT, 'forced session failure'); END`);
    await call(account.PATCH, req('/api/account', {oldPassword:'AccountTest2026!',newPassword:'UpdatedTest2026!'}, 'PATCH'), 400);
    assert(auth.verifyPassword('AccountTest2026!', db.prepare('SELECT password FROM users WHERE id=?').get(pending.user.id).password));
    assert(await auth.getCurrentUser());
    db.exec('DROP TRIGGER reject_session_revoke');
    const newPassword = await call(account.PATCH, req('/api/account', {oldPassword:'AccountTest2026!',newPassword:'UpdatedTest2026!'}, 'PATCH'), 200);
    assert.equal(newPassword.requiresLogin, true); assert.equal(lastCookie.options.maxAge, 0);
    token = currentToken; assert.equal(await auth.getCurrentUser(), null);
    await call(login.POST, req('/api/auth/login', {username:'pending-test',password:'AccountTest2026!'}), 401);
    await call(login.POST, req('/api/auth/login', {username:'pending-test',password:'UpdatedTest2026!'}), 200);
    const me = (await call(sessions.GET, undefined, 200)).sessions.find(item => item.current);
    assert.equal((await call(sessions.DELETE, req('/api/account/sessions', {id:me.id}, 'DELETE'), 200)).requiresLogin, true);
    assert.equal(await auth.getCurrentUser(), null);
    token = adminToken;
    await call(users.PATCH, req('/api/users', {id:pending.user.id,newPassword:'ResetByAdmin2026!'}, 'PATCH'), 200);
    const otherAdmin = await call(users.POST, req('/api/users', {username:'second-admin',password:'AccountTest2026!',role:'admin'}), 201);
    assert.equal(otherAdmin.user.isSystemAccount, false);
    const otherAdminToken = auth.createSession(otherAdmin.user.id);
    token = otherAdminToken;
    await call(users.DELETE, req(`/api/users?id=${pending.user.id}`, undefined, 'DELETE'), 403);
    await call(users.PATCH, req('/api/users', {id:adminId,status:'disabled'}, 'PATCH'), 400);
    token = adminToken;
    await call(users.DELETE, req(`/api/users?id=${adminId}`, undefined, 'DELETE'), 400);

    const targetToken = auth.createSession(pending.user.id);
    db.exec(`CREATE TRIGGER reject_delete_session BEFORE UPDATE OF revokedAt ON sessions
      WHEN OLD.userId = '${pending.user.id}' BEGIN SELECT RAISE(ABORT, 'forced session failure'); END`);
    await call(users.DELETE, req(`/api/users?id=${pending.user.id}`, undefined, 'DELETE'), 400);
    assert.equal(db.prepare('SELECT status,deletedAt FROM users WHERE id=?').get(pending.user.id).status, 'active');
    token = targetToken; assert(await auth.getCurrentUser());
    db.exec('DROP TRIGGER reject_delete_session');
    token = adminToken;
    const deleted = await call(users.DELETE, req(`/api/users?id=${pending.user.id}`, undefined, 'DELETE'), 200);
    assert.deepEqual(deleted, {id:pending.user.id,message:'账号已删除'});
    const deletedRow = db.prepare('SELECT status,deletedAt,deletedBy FROM users WHERE id=?').get(pending.user.id);
    assert.equal(deletedRow.status, 'deleted'); assert(deletedRow.deletedAt); assert.equal(deletedRow.deletedBy, adminId);
    assert.equal((await call(users.GET, req('/api/users', undefined, 'GET'), 200)).users.some(item => item.id === pending.user.id), false);
    await call(users.DELETE, req(`/api/users?id=${pending.user.id}`, undefined, 'DELETE'), 404);
    await call(users.PATCH, req('/api/users', {id:pending.user.id,status:'active'}, 'PATCH'), 404);
    token = targetToken; assert.equal(await auth.getCurrentUser(), null);
    await call(login.POST, req('/api/auth/login', {username:'pending-test',password:'ResetByAdmin2026!'}), 403);
    token = adminToken;
    await call(users.DELETE, req(`/api/users?id=${otherAdmin.user.id}`, undefined, 'DELETE'), 200);
    token = otherAdminToken; assert.equal(await auth.getCurrentUser(), null);
    assert.equal(db.pragma('integrity_check', {simple:true}), 'ok');
    assert.equal(db.pragma('foreign_key_check').length, 0);
    console.log('PASS isolated account API: migrations, HTTP/HTTPS cookies, login audit, user filters/approval, protected admin deletion, rollback, session revocation, login history');
  } finally {
    if (originalSecure === undefined) delete process.env.SESSION_COOKIE_SECURE; else process.env.SESSION_COOKIE_SECURE = originalSecure;
    db.close();
  }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
