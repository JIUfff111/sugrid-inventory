/** Route-level viewer authorization checks against isolated in-memory SQLite. */
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
  let token;
  try {
    initDatabase(db); seedDatabase(db);
    const adminId = db.prepare("SELECT id FROM users WHERE username = 'admin'").get().id;
    db.prepare("INSERT INTO warehouses(id,code,name,status) VALUES ('warehouse_viewer_second','QA-VIEW','第二仓','active')").run();
    db.prepare("INSERT INTO suppliers(id,supplierName) VALUES ('viewer_supplier','只读测试供应商')").run();
    db.prepare(`INSERT INTO purchase_orders(id,purchaseNo,supplierOrderNo,supplierId,supplierName,purchaseDate,purchasedBy,createdBy)
      VALUES ('viewer_order','QA-VIEW-ORDER','', 'viewer_supplier','只读测试供应商','2026-11-07',?,?)`).run(adminId, adminId);
    db.prepare(`INSERT INTO purchase_items(id,purchaseOrderId,productType,brand,model,cpu,ram,storage,screen,sn,purchasePrice)
      VALUES ('viewer_item','viewer_order','笔记本电脑','测试品牌','跨仓型号','I5-10210U','16G','512G','2.5K','QA-VIEWER-SN',1200)`).run();
    db.prepare(`INSERT INTO inventory(id,purchaseOrderId,purchaseItemId,warehouseId,sn,productType,brand,model,cpu,ram,storage,screen,purchasePrice,supplierId,supplierName,inboundDate)
      VALUES ('viewer_inventory','viewer_order','viewer_item','warehouse_viewer_second','QA-VIEWER-SN','笔记本电脑','测试品牌','跨仓型号','I5-10210U','16G','512G','2.5K',1200,'viewer_supplier','只读测试供应商','2026-11-07')`).run();
    db.prepare(`INSERT INTO inventory_movements(id,inventoryId,warehouseId,movementType,actorId,createdAt)
      VALUES ('viewer_movement','viewer_inventory','warehouse_viewer_second','purchase_in',?,'2026-11-07T12:00:00.000Z')`).run(adminId);

    const helpers = load('src/lib/api-helpers.ts');
    const database = { __esModule: true, default: db };
    const auth = load('src/lib/auth.ts', {
      '@/lib/db': database, '@/lib/api-helpers': helpers,
      'next/headers': { cookies: async () => ({ get: () => token ? { value: token } : undefined, set: (_name, value) => { token = value || undefined; } }) },
    });
    const status = load('src/lib/inventory-status.ts', { '@/lib/db': database, '@/lib/api-helpers': helpers });
    const skuBrand = load('src/lib/sku-brand.ts');
    const skuDisplay = load('src/lib/sku-display.ts');
    const movementLabels = load('src/lib/inventory-movement-labels.ts');
    const base = { '@/lib/db': database, '@/lib/auth': auth, '@/lib/api-helpers': helpers };
    const routes = {
      users: load('src/app/api/users/route.ts', base),
      login: load('src/app/api/auth/login/route.ts', base),
      account: load('src/app/api/account/route.ts', base),
      inventory: load('src/app/api/inventory/route.ts', { ...base, '@/lib/inventory-status': status, '@/lib/inventory-purge': { createPurgeBackup: () => {}, getPurgeCandidate: () => {} }, '@/lib/sku-brand': skuBrand }),
      inventoryEdit: load('src/app/api/inventory/edit/route.ts', { ...base, '@/lib/inventory-status': status, '@/lib/sku-brand': skuBrand, '@/lib/sku-display': skuDisplay }),
      analysis: load('src/app/api/inventory/analysis/route.ts', { ...base, '@/lib/inventory-status': status }),
      lookup: load('src/app/api/inventory/lookup/route.ts', { ...base, '@/lib/inventory-status': status }),
      movements: load('src/app/api/inventory/movements/route.ts', { ...base, '@/lib/inventory-movement-labels': movementLabels }),
      statusDefinitions: load('src/app/api/inventory/status-definitions/route.ts', base),
      statusRecords: load('src/app/api/inventory/status-records/route.ts', { ...base, '@/lib/inventory-status': status }),
      warehouses: load('src/app/api/warehouses/route.ts', base),
      labels: load('src/app/api/label-templates/route.ts', base),
      purchase: load('src/app/api/purchase-orders/route.ts', { ...base, '@/lib/sku-brand': skuBrand, '@/lib/sku-display': skuDisplay, '@/lib/manual-sku-options': { mergeManualSKUOptions: () => {}, normalizeManualSKUOptions: () => ({ value: {} }) } }),
      sales: load('src/app/api/sales/route.ts', { ...base, '@/lib/inventory-status': status }),
      transfers: load('src/app/api/transfers/route.ts', { ...base, '@/lib/inventory-status': status }),
    };
    const dataManagement = load('src/lib/data-management.ts', base);
    const request = (url, body, method = 'GET') => new NextRequest(`http://localhost:3003${url}`, {
      method, headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const call = async (handler, url, statusCode, body, method = 'GET') => {
      const response = await handler(request(url, body, method));
      const payload = await response.json();
      assert.equal(response.status, statusCode, `${url}: ${JSON.stringify(payload)}`);
      return payload.data;
    };

    token = auth.createSession(adminId);
    const viewerCreated = await call(routes.users.POST, '/api/users', 201, {
      username: 'qa-viewer', password: 'ViewerTest2026!', role: 'viewer', status: 'active',
      canViewInventory: false, canEditInventory: true, warehouseIds: ['warehouse_main'],
    }, 'POST');
    const viewerId = viewerCreated.user.id;
    assert.equal(viewerCreated.user.role, 'viewer');
    assert.equal(viewerCreated.user.canViewInventory, true);
    assert.equal(viewerCreated.user.canEditInventory, false);
    assert.equal(viewerCreated.user.warehouses.length, 0);
    assert.deepEqual(db.prepare('SELECT canViewInventory, canEditInventory FROM users WHERE id = ?').get(viewerId), { canViewInventory: 1, canEditInventory: 0 });

    await call(routes.login.POST, '/api/auth/login', 200, { username: 'qa-viewer', password: 'ViewerTest2026!' }, 'POST');
    assert.equal((await auth.getCurrentUser()).role, 'viewer');
    const inventory = await call(routes.inventory.GET, '/api/inventory?page=1&pageSize=10', 200);
    assert.equal(inventory.items.some(item => item.id === 'viewer_inventory'), true, 'viewer must see an unassigned warehouse');
    const filtered = await call(routes.inventory.GET, '/api/inventory?warehouseId=warehouse_viewer_second', 200);
    assert.equal(filtered.items.some(item => item.id === 'viewer_inventory'), true);
    const details = await call(routes.inventoryEdit.GET, '/api/inventory/edit?inventoryId=viewer_inventory', 200);
    assert(details, 'viewer can read the inventory detail');
    await call(routes.analysis.GET, '/api/inventory/analysis?warehouseId=warehouse_viewer_second', 403);
    const lookup = await call(routes.lookup.GET, '/api/inventory/lookup?context=inventory&q=QA-VIEWER-SN', 200);
    assert(lookup.items?.some(item => item.id === 'viewer_inventory'));
    await call(routes.lookup.GET, '/api/inventory/lookup?context=transfer', 403);
    await call(routes.lookup.GET, '/api/inventory/lookup?context=movements', 403);
    const warehouses = await call(routes.warehouses.GET, '/api/warehouses', 200);
    assert(warehouses.some(item => item.id === 'warehouse_viewer_second'));
    assert(warehouses.every(item => !Object.hasOwn(item, 'address') && !Object.hasOwn(item, 'remark')));
    await call(routes.warehouses.GET, '/api/warehouses?resource=transfer-targets', 403);
    const movement = await call(routes.movements.GET, '/api/inventory/movements?inventoryId=viewer_inventory', 200);
    assert(movement.items.some(item => item.id === 'viewer_movement'));
    await call(routes.movements.GET, '/api/inventory/movements', 403);
    await call(routes.movements.GET, '/api/inventory/movements?inventoryId=viewer_inventory&format=csv', 403);
    await call(routes.statusDefinitions.GET, '/api/inventory/status-definitions', 200);
    await call(routes.statusRecords.GET, '/api/inventory/status-records?inventoryId=viewer_inventory', 200);
    await call(routes.statusRecords.GET, '/api/inventory/status-records', 403);
    await call(routes.account.GET, '/api/account', 200);
    await call(routes.inventory.PATCH, '/api/inventory', 403, { id: 'viewer_inventory', remark: 'forbidden' }, 'PATCH');
    await call(routes.inventoryEdit.POST, '/api/inventory/edit', 403, { inventoryId: 'viewer_inventory', sn: 'CHANGED' }, 'POST');
    await call(routes.purchase.GET, '/api/purchase-orders', 403);
    await call(routes.purchase.POST, '/api/purchase-orders', 403, {}, 'POST');
    await call(routes.sales.GET, '/api/sales', 403);
    await call(routes.transfers.GET, '/api/transfers', 403);
    await call(routes.transfers.POST, '/api/transfers', 403, {}, 'POST');
    await call(routes.users.GET, '/api/users', 403);
    await call(routes.labels.GET, '/api/label-templates', 403);

    db.prepare('UPDATE users SET canViewInventory = 0, canEditInventory = 1 WHERE id = ?').run(viewerId);
    assert.equal((await auth.getCurrentUser()).canEditInventory, false, 'role overrides stale database flags');
    await call(routes.inventory.PATCH, '/api/inventory', 403, { id: 'viewer_inventory', remark: 'still forbidden' }, 'PATCH');
    token = auth.createSession(adminId);
    const updated = await call(routes.users.PATCH, '/api/users', 200, {
      id: viewerId, canViewInventory: false, canEditInventory: true,
    }, 'PATCH');
    assert.equal(updated.user.canViewInventory, true);
    assert.equal(updated.user.canEditInventory, false);
    assert.deepEqual(db.prepare('SELECT canViewInventory, canEditInventory FROM users WHERE id = ?').get(viewerId), { canViewInventory: 1, canEditInventory: 0 });
    const manager = await call(routes.users.POST, '/api/users', 201, {
      username: 'qa-manager-to-viewer', password: 'ViewerTest2026!', role: 'warehouse_manager',
      warehouseIds: ['warehouse_main'], canEditInventory: true,
    }, 'POST');
    assert.equal(manager.user.warehouses.length, 1);
    const demoted = await call(routes.users.PATCH, '/api/users', 200, {
      id: manager.user.id, role: 'viewer', canEditInventory: true,
      warehouseIds: ['warehouse-no-longer-active'],
    }, 'PATCH');
    assert.equal(demoted.user.role, 'viewer');
    assert.equal(demoted.user.canViewInventory, true);
    assert.equal(demoted.user.canEditInventory, false);
    assert.equal(demoted.user.warehouses.length, 0, 'role change clears warehouse-manager assignments');
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM user_warehouses WHERE userId = ?').get(manager.user.id).count, 0);
    const normalizedImport = dataManagement.normalizeImportRecord(dataManagement.getResource('users'), {
      id: viewerId, role: 'viewer', canViewInventory: 0, canEditInventory: 1,
    }, adminId);
    assert.equal(normalizedImport.record.canViewInventory, 1);
    assert.equal(normalizedImport.record.canEditInventory, 0);
    assert(normalizedImport.warnings.length > 0);

    db.prepare(`INSERT INTO inventory_status_definitions(id,name,createdAt,updatedAt)
      VALUES ('viewer_status_definition','测试状态','2026-11-07','2026-11-07')`).run();
    db.prepare(`INSERT INTO inventory_status_records(id,inventoryId,definitionId,definitionSnapshot,reason,location,responsiblePerson,warehouseId,createdBy,createdAt)
      VALUES ('viewer_status_record','viewer_inventory','viewer_status_definition','{}','','','测试人员','warehouse_viewer_second',?,'2026-11-07')`).run(adminId);
    token = auth.createSession(viewerId);
    assert.equal((await call(routes.statusRecords.GET, '/api/inventory/status-records?inventoryId=viewer_inventory', 200)).items.length, 1);
    db.prepare("UPDATE inventory SET deleted = 1 WHERE id = 'viewer_inventory'").run();
    assert.equal((await call(routes.statusRecords.GET, '/api/inventory/status-records?inventoryId=viewer_inventory', 200)).items.length, 0);
    assert.equal((await call(routes.movements.GET, '/api/inventory/movements?inventoryId=viewer_inventory', 200)).items.length, 0);
    db.prepare("UPDATE inventory SET deleted = 0 WHERE id = 'viewer_inventory'").run();

    initDatabase(db);
    assert.equal(db.prepare('SELECT role FROM users WHERE id = ?').get(viewerId).role, 'viewer', 'repeat database initialization preserves viewer');
    db.prepare('DELETE FROM schema_migrations WHERE version = 3').run();
    initDatabase(db);
    assert.equal(db.prepare('SELECT role FROM users WHERE id = ?').get(viewerId).role, 'viewer', 'legacy role migration preserves viewer');
    assert.deepEqual(db.pragma('foreign_key_check'), []);
    assert.equal(db.pragma('integrity_check')[0].integrity_check, 'ok');
    console.log('Viewer inventory-only role checks passed');
  } finally {
    db.close();
  }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
