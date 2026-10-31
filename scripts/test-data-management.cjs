/** Isolated route-level coverage for system data management and inventory purge. */
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
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    fileName: filename,
  }).outputText;
  const target = new Module(filename, module);
  target.filename = filename;
  target.paths = Module._nodeModulePaths(path.dirname(filename));
  const native = target.require.bind(target);
  target.require = name => Object.hasOwn(overrides, name) ? overrides[name] : native(name);
  target._compile(compiled, filename);
  return target.exports;
}

async function main() {
  const scratch = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'sugrid-data-management-'));
  const backupDbPath = path.join(scratch, 'inventory.db');
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  const previousPath = process.env.INVENTORY_DB_PATH;
  process.env.INVENTORY_DB_PATH = backupDbPath;
  try {
    initDatabase(db); seedDatabase(db); initDatabase(db);
    const database = { __esModule: true, default: db };
    const api = load('src/lib/api-helpers.ts');
    let token;
    const auth = load('src/lib/auth.ts', {
      '@/lib/db': database,
      '@/lib/api-helpers': api,
      'next/headers': { cookies: async () => ({ get: () => token ? { value: token } : undefined }) },
    });
    const deps = { '@/lib/db': database, '@/lib/api-helpers': api, '@/lib/auth': auth };
    const dataManagement = load('src/lib/data-management.ts', deps);
    const purge = load('src/lib/inventory-purge.ts', { '@/lib/db': database });
    const inventoryStatus = load('src/lib/inventory-status.ts', { ...deps, '@/lib/inventory-status': undefined });
    const routeDeps = { ...deps, '@/lib/data-management': dataManagement, '@/lib/inventory-purge': purge, '@/lib/inventory-status': inventoryStatus };
    const previewImport = load('src/app/api/data-management/import/preview/route.ts', routeDeps);
    const routes = {
      resources: load('src/app/api/data-management/resources/route.ts', routeDeps),
      resource: load('src/app/api/data-management/[resource]/route.ts', routeDeps),
      export: load('src/app/api/data-management/export/route.ts', routeDeps),
      importPreview: previewImport,
      import: load('src/app/api/data-management/import/route.ts', { ...routeDeps, './preview/route': previewImport }),
      inventory: load('src/app/api/inventory/route.ts', routeDeps),
      purgePreview: load('src/app/api/inventory/purge-preview/route.ts', routeDeps),
    };
    const request = (url, method = 'GET', body) => new NextRequest(`http://localhost${url}`, {
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    async function call(handler, url, method = 'GET', body, expected = 200, params) {
      const response = await handler(request(url, method, body), params);
      const payload = await response.json();
      assert.equal(response.status, expected, `${method} ${url}: ${JSON.stringify(payload)}`);
      return payload.data;
    }

    const adminId = db.prepare("SELECT id FROM users WHERE username = 'admin'").get().id;
    token = auth.createSession(adminId);
    assert(!dataManagement.DATA_RESOURCES.users.fields.includes('password'));
    const nestedSanitized = JSON.parse(dataManagement.sanitizeRow({ payload: JSON.stringify([{ password: 'secret', token_hash: 'secret', visible: 'ok' }]) }).payload);
    assert.deepEqual(nestedSanitized, [{ visible: 'ok' }]);
    assert(db.pragma('table_info(user_warehouses)').some(column => column.name === 'id'));
    assert(db.prepare('SELECT id FROM user_warehouses WHERE userId = ?').get(adminId).id);
    db.prepare("INSERT INTO suppliers (id,supplierName,status,createdBy) VALUES ('dm-supplier','数据管理供应商','active',?)").run(adminId);
    db.prepare(`INSERT INTO purchase_orders
      (id,purchaseNo,supplierOrderNo,supplierId,supplierName,purchaseDate,purchasedBy,createdBy)
      VALUES ('dm-order','DM-ORDER','', 'dm-supplier','数据管理供应商','2026-10-30',?,?)`).run(adminId, adminId);
    db.prepare(`INSERT INTO purchase_items
      (id,purchaseOrderId,productType,brand,model,cpu,ram,storage,screen,sn,purchasePrice)
      VALUES ('dm-item','dm-order','笔记本电脑','ThinkPad','X13','I5-10210U','16GB','512GB','2.5K','PURGE-SN-001',1000)`).run();
    db.prepare(`INSERT INTO inventory
      (id,purchaseOrderId,purchaseItemId,sn,productType,brand,model,cpu,ram,storage,screen,purchasePrice,supplierId,supplierName,status,inboundDate,warehouseId)
      VALUES ('dm-machine','dm-order','dm-item','PURGE-SN-001','笔记本电脑','ThinkPad','X13','I5-10210U','16GB','512GB','2.5K',1000,'dm-supplier','数据管理供应商','in_stock','2026-10-30','warehouse_main')`).run();
    db.prepare(`INSERT INTO inventory_movements (id,inventoryId,warehouseId,movementType,referenceType,referenceId,actorId,note)
      VALUES ('dm-movement','dm-machine','warehouse_main','asset_change','inventory','dm-machine',?,'test')`).run(adminId);

    const resources = await call(routes.resources.GET, '/api/data-management/resources');
    assert(resources.some(item => item.key === 'login_events'));
    for (const resource of dataManagement.DATA_RESOURCE_KEYS) {
      const listed = await call(routes.resource.GET, `/api/data-management/${resource}?pageSize=1`, 'GET', undefined, 200, { params: Promise.resolve({ resource }) });
      assert(Array.isArray(listed.items), `${resource} should return a row list`);
    }
    const inventoryRows = await call(routes.resource.GET, '/api/data-management/inventory?search=PURGE-SN-001', 'GET', undefined, 200, { params: Promise.resolve({ resource: 'inventory' }) });
    assert.equal(inventoryRows.items.length, 1);

    const exportResponse = await routes.export.GET(request('/api/data-management/export?resource=inventory&format=json&search=PURGE-SN-001'));
    assert.equal(exportResponse.status, 200);
    const exportBody = JSON.parse(await exportResponse.text());
    assert.equal(exportBody.resources.inventory.length, 1);
    assert(!JSON.stringify(exportBody).includes('password'));
    assert(!JSON.stringify(exportBody).includes('tokenHash'));

    const duplicatePreview = await call(routes.importPreview.POST, '/api/data-management/import/preview', 'POST', {
      resource: 'suppliers', mode: 'insert', content: { id: 'dm-supplier', supplierName: '冲突', status: 'active' },
    });
    assert.equal(duplicatePreview.reports[0].conflicts, 1);
    assert.equal(duplicatePreview.canApply, false);

    const typoPreview = await call(routes.importPreview.POST, '/api/data-management/import/preview', 'POST', {
      resource: 'suppliers', mode: 'insert', content: { id: 'dm-typo', supplierName: '字段检查', status: 'active', supplierNmae: '错误拼写' },
    });
    assert(typoPreview.reports[0].errors.some(error => error.message.includes('supplierNmae')));
    const authFieldPreview = await call(routes.importPreview.POST, '/api/data-management/import/preview', 'POST', {
      resource: 'suppliers', mode: 'insert', content: { id: 'dm-secret', supplierName: '认证字段检查', status: 'active', password: 'must-not-import' },
    });
    assert(authFieldPreview.reports[0].errors.some(error => error.message.includes('password')));
    const nestedSecretPreview = await call(routes.importPreview.POST, '/api/data-management/import/preview', 'POST', {
      resource: 'sales_records', mode: 'insert', content: { id: 'dm-nested-secret', recordNo: 'DM-NESTED', saleChannel: 'test', saleOrderNo: 'DM-NESTED', saleDate: '2026-10-30', items: [{ tokenHash: 'must-not-import' }] },
    });
    assert(nestedSecretPreview.reports[0].errors.some(error => error.message.includes('tokenHash')));
    const foreignKeyPreview = await call(routes.importPreview.POST, '/api/data-management/import/preview', 'POST', {
      resource: 'inventory', mode: 'insert', content: {
        id: 'dm-invalid-fk', purchaseOrderId: 'missing-order', purchaseItemId: 'missing-item', sn: 'DM-FK-SN',
        productType: '笔记本电脑', brand: 'ThinkPad', model: 'X13', cpu: 'I5-10210U', ram: '16GB', storage: '512GB', screen: '2.5K',
        purchasePrice: 1, supplierId: 'missing-supplier', supplierName: 'missing', status: 'in_stock', inboundDate: '2026-10-30', warehouseId: 'missing-warehouse',
      },
    });
    assert(foreignKeyPreview.reports[0].errors.some(error => error.message.includes('purchaseOrderId')));
    assert.deepEqual(dataManagement.parseCsv('\uFEFFid,supplierName,status\r\nrow-1,CSV供应商,active')[0], { id: 'row-1', supplierName: 'CSV供应商', status: 'active' });
    const duplicateIdPreview = await call(routes.importPreview.POST, '/api/data-management/import/preview', 'POST', {
      resource: 'suppliers', mode: 'insert', content: { resources: { suppliers: [
        { id: 'same-id', supplierName: 'A', status: 'active' }, { id: 'same-id', supplierName: 'B', status: 'active' },
      ] } },
    });
    assert(duplicateIdPreview.reports[0].errors.some(error => error.message.includes('ID same-id 重复')));

    const stringJsonPreview = await call(routes.importPreview.POST, '/api/data-management/import/preview', 'POST', {
      resource: 'users', mode: 'insert', content: JSON.stringify({
        schemaVersion: 12,
        resources: { users: [{ id: 'json-user', username: 'json-user', realName: 'JSON 导入', role: 'admin', status: 'active' }] },
      }),
    });
    assert.equal(stringJsonPreview.reports[0].resource, 'users');
    assert.equal(stringJsonPreview.reports[0].valid, 1);
    assert.equal(stringJsonPreview.reports[0].errors.length, 0);

    const stringFullJsonPreview = await call(routes.importPreview.POST, '/api/data-management/import/preview', 'POST', {
      mode: 'insert', content: JSON.stringify({
        schemaVersion: 12,
        resources: { suppliers: [{ id: 'json-supplier', supplierName: 'JSON 全量导入', status: 'active' }] },
      }),
    });
    assert.equal(stringFullJsonPreview.reports[0].resource, 'suppliers');
    assert.equal(stringFullJsonPreview.reports[0].valid, 1);
    assert.equal(stringFullJsonPreview.reports[0].errors.length, 0);

    const partialUserContent = JSON.stringify({ resources: { users: [
      { id: 'partial-conflict', username: 'admin', realName: '冲突账号', role: 'admin', status: 'active' },
      { id: 'partial-new-user', username: 'partial-new-user', realName: '新增账号', role: 'admin', status: 'active' },
    ] } });
    const partialUserPreview = await call(routes.importPreview.POST, '/api/data-management/import/preview', 'POST', {
      resource: 'users', mode: 'insert', content: partialUserContent,
    });
    assert.equal(partialUserPreview.reports[0].valid, 1);
    assert.equal(partialUserPreview.reports[0].conflicts, 1);
    assert.equal(partialUserPreview.reports[0].errors.length, 0);
    assert.equal(partialUserPreview.canApply, true);
    assert(partialUserPreview.reports[0].conflictDetails.some(detail => detail.message.includes('账号已存在')));
    const partialUserImport = await call(routes.import.POST, '/api/data-management/import', 'POST', {
      resource: 'users', mode: 'insert', fileName: 'partial-users.json', content: partialUserContent,
    });
    assert.equal(partialUserImport.inserted, 1);
    assert(db.prepare("SELECT 1 FROM users WHERE id='partial-new-user'").get());
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM users WHERE username='admin'").get().n, 1);

    const systemUserUpsert = await call(routes.importPreview.POST, '/api/data-management/import/preview', 'POST', {
      resource: 'users', mode: 'upsert', content: { id: adminId, username: 'admin', role: 'warehouse_manager', status: 'active' },
    });
    assert(systemUserUpsert.reports[0].errors.some(error => error.message.includes('内置系统管理员')));

    const imported = await call(routes.import.POST, '/api/data-management/import', 'POST', {
      resource: 'suppliers', mode: 'insert', fileName: 'supplier.json', content: { id: 'dm-imported', supplierName: '导入供应商', status: 'active' },
    });
    assert.equal(imported.inserted, 1);
    assert(db.prepare("SELECT 1 FROM suppliers WHERE id='dm-imported'").get());
    assert(fs.existsSync(path.join(scratch, 'backups')));

    const purgePreview = await call(routes.purgePreview.GET, '/api/inventory/purge-preview?id=dm-machine');
    assert.equal(purgePreview.canDelete, true);
    const purged = await call(routes.inventory.DELETE, '/api/inventory?id=dm-machine', 'DELETE', { password: 'admin123', confirmText: '永久删除', reason: '隔离测试' });
    assert.equal(purged.sn, 'PURGE-SN-001');
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM inventory WHERE id='dm-machine'").get().n, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM inventory_movements WHERE inventoryId='dm-machine'").get().n, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM purchase_orders WHERE id='dm-order'").get().n, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM purchase_items WHERE id='dm-item'").get().n, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM data_management_audit WHERE action='inventory_purge'").get().n, 1);
    const purgeAudit = JSON.parse(db.prepare("SELECT summary FROM data_management_audit WHERE action='inventory_purge'").get().summary);
    assert.match(purgeAudit.backupSha256, /^[a-f0-9]{64}$/);

    db.prepare(`INSERT INTO inventory
      (id,purchaseOrderId,purchaseItemId,sn,productType,brand,model,cpu,ram,storage,screen,purchasePrice,supplierId,supplierName,status,inboundDate,warehouseId)
      VALUES ('dm-blocked','dm-order','dm-item','PURGE-SN-002','笔记本电脑','ThinkPad','X13','I5-10210U','16GB','512GB','2.5K',1000,'dm-supplier','数据管理供应商','sold','2026-10-30','warehouse_main')`).run();
    const blocked = await call(routes.purgePreview.GET, '/api/inventory/purge-preview?id=dm-blocked');
    assert.equal(blocked.canDelete, false);
    assert(blocked.reasons.some(reason => reason.includes('普通在库')));
    const managerId = 'dm-manager';
    db.prepare("INSERT INTO users (id,username,password,role,status) VALUES (?,?,?,?,?)").run(managerId, managerId, 'test', 'admin', 'active');
    token = auth.createSession(managerId);
    await call(routes.resources.GET, '/api/data-management/resources', 'GET', undefined, 403);
    await call(routes.purgePreview.GET, '/api/inventory/purge-preview?id=dm-blocked', 'GET', undefined, 403);
    await call(routes.inventory.DELETE, '/api/inventory?id=dm-blocked', 'DELETE', { password: 'admin123', confirmText: '永久删除' }, 403);
    db.prepare("INSERT INTO users (id,username,password,role,status,isSystemAccount) VALUES ('fake-system','fake-system','test','warehouse_manager','active',1)").run();
    token = auth.createSession('fake-system');
    await call(routes.purgePreview.GET, '/api/inventory/purge-preview?id=dm-blocked', 'GET', undefined, 403);
    await call(routes.inventory.DELETE, '/api/inventory?id=dm-blocked', 'DELETE', { password: 'admin123', confirmText: '永久删除' }, 403);
    token = auth.createSession(adminId);
    assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
    assert.deepEqual(db.pragma('foreign_key_check'), []);
    console.log('PASS isolated data management: system-account permission, filtered export, sensitive-field exclusion, import preview/backup, purge preflight, machine-history cleanup, purchase-history retention and integrity checks');
  } finally {
    if (previousPath === undefined) delete process.env.INVENTORY_DB_PATH; else process.env.INVENTORY_DB_PATH = previousPath;
    db.close();
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });

