const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const Database = require('better-sqlite3');
const { NextRequest } = require('next/server');
const { initDatabase, seedDatabase } = require('./database.cjs');

const root = path.resolve(__dirname, '..');
function load(relative, overrides = {}) {
  const file = path.join(root, relative);
  const loadedModule = new Module(file, module);
  loadedModule.filename = file;
  loadedModule.paths = Module._nodeModulePaths(path.dirname(file));
  const standardRequire = loadedModule.require.bind(loadedModule);
  loadedModule.require = name => Object.hasOwn(overrides, name) ? overrides[name] : standardRequire(name);
  loadedModule._compile(ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    fileName: file,
  }).outputText, file);
  return loadedModule.exports;
}

async function run() {
  const db = new Database(':memory:');
  try {
    db.pragma('foreign_keys=ON');
    initDatabase(db);
    seedDatabase(db);
    const adminId = db.prepare("SELECT id FROM users WHERE role = 'admin' LIMIT 1").get().id;
    const now = '2026-11-12T10:00:00.000Z';
    db.prepare("INSERT INTO warehouses (id,code,name,warehouseName,status,createdBy,createdAt,updatedAt) VALUES ('warehouse_east','EAST','测试东仓','测试东仓','active',?,?,?)").run(adminId, now, now);
    db.prepare("INSERT INTO suppliers (id,supplierName,createdBy) VALUES ('qa-supplier','测试供应商',?)").run(adminId);
    db.prepare("INSERT INTO purchase_orders (id,purchaseNo,supplierOrderNo,supplierId,supplierName,purchaseDate,purchasedBy,createdBy,isInbounded,totalQuantity,totalAmount) VALUES ('qa-purchase','CG-QA-EXPORT','EXT-QA-EXPORT','qa-supplier','测试供应商','2026-11-01',?,?,1,56,5600)").run(adminId, adminId);
    for (let index = 0; index < 56; index += 1) {
      const id = `qa-machine-${index}`;
      const sn = `QA-EXPORT-${String(index).padStart(4, '0')}`;
      const warehouseId = index % 2 ? 'warehouse_east' : 'warehouse_main';
      const remark = index === 0 ? '=HYPERLINK("https://example.invalid")' : `备注 ${index}`;
      db.prepare("INSERT INTO purchase_items (id,purchaseOrderId,productType,brand,model,year,cpu,ram,gpu,storage,screen,sn,purchasePrice,remark) VALUES (?,'qa-purchase','笔记本电脑','ThinkPad','X13',2024,'i5-1340P','16GB','集成显卡','512GB','13.3英寸',?,100,?)").run(`qa-item-${index}`, sn, remark);
      db.prepare("INSERT INTO inventory (id,purchaseOrderId,purchaseItemId,warehouseId,sn,itemNumber,productType,brand,model,year,cpu,ram,gpu,storage,screen,touchScreen,purchasePrice,supplierId,supplierName,status,inboundDate,remark,createdAt,updatedAt) VALUES (?,'qa-purchase',?,?,?,?,'笔记本电脑','ThinkPad','X13',2024,'i5-1340P','16GB','集成显卡','512GB','13.3英寸',?,100,'qa-supplier','测试供应商','in_stock','2026-11-01',?,?,?)").run(id, `qa-item-${index}`, warehouseId, sn, `ASSET-${String(index).padStart(4, '0')}`, index % 2, remark, now, now);
    }
    db.prepare("UPDATE inventory SET remark = '机器备注唯一资产识别词' WHERE id = 'qa-machine-3'").run();
    db.prepare("UPDATE inventory SET skuRemark = 'SKU备注唯一识别词' WHERE id = 'qa-machine-4'").run();
    db.prepare("INSERT INTO inventory_status_definitions(id,name,color,allowStockOperations,isActive,createdBy,updatedBy,createdAt,updatedAt) VALUES ('qa-status','QA 自定义状态','#2563eb',0,1,?,?,?,?)").run(adminId, adminId, now, now);
    for (const [index, warehouseId] of [[0, 'warehouse_main'], [1, 'warehouse_east']]) {
      const recordId = `qa-status-record-${index}`;
      db.prepare("INSERT INTO inventory_status_records(id,inventoryId,definitionId,definitionSnapshot,reason,location,responsiblePerson,warehouseId,createdBy,createdAt) VALUES (?,?,'qa-status',?,'测试','测试地点','测试负责人',?,?,?)")
        .run(recordId, `qa-machine-${index}`, JSON.stringify({ name: 'QA 自定义状态', color: '#2563eb' }), warehouseId, adminId, now);
      db.prepare("UPDATE inventory SET status='custom',currentStatusRecordId=? WHERE id=?").run(recordId, `qa-machine-${index}`);
    }
    const database = { __esModule: true, default: db };
    const helpers = load('src/lib/api-helpers.ts');
    const auth = load('src/lib/auth.ts', {
      '@/lib/db': database,
      '@/lib/api-helpers': helpers,
      'next/headers': { cookies: async () => ({ get: () => undefined }) },
    });
    const query = load('src/lib/inventory-query.ts', { '@/lib/machine-scan': load('src/lib/machine-scan.ts') });
    const statusPreferences = load('src/lib/inventory-status-preferences.ts');
    const tablePreferences = load('src/lib/inventory-table-preferences.ts');
    const productName = load('src/lib/product-name.ts', { '@/lib/sku-brand': load('src/lib/sku-brand.ts') });
    const exportHelpers = load('src/lib/inventory-export.ts', {
      '@/lib/inventory-table-preferences': tablePreferences,
      '@/lib/product-name': productName,
    });
    const inventoryStatus = load('src/lib/inventory-status.ts', { '@/lib/db': database, '@/lib/api-helpers': helpers });
    let user = { id: adminId, role: 'admin', isSystemAccount: true, canViewInventory: true, canEditInventory: true, warehouses: [] };
    const authWithUser = { ...auth, requireUser: async () => user };
    const route = load('src/app/api/inventory/export/route.ts', {
      '@/lib/db': database,
      '@/lib/auth': authWithUser,
      '@/lib/api-helpers': helpers,
      '@/lib/inventory-query': query,
      '@/lib/inventory-export': exportHelpers,
      '@/lib/inventory-status': inventoryStatus,
    });
    const inventoryRoute = load('src/app/api/inventory/route.ts', {
      '@/lib/db': database,
      '@/lib/auth': authWithUser,
      '@/lib/api-helpers': helpers,
      '@/lib/inventory-status': inventoryStatus,
      '@/lib/inventory-purge': { createPurgeBackup: () => '', getPurgeCandidate: () => null },
      '@/lib/sku-brand': load('src/lib/sku-brand.ts'),
      '@/lib/inventory-query': query,
    });
    async function post(body, expectedStatus = 200) {
      const response = await route.POST(new NextRequest('http://localhost/api/inventory/export', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }));
      assert.equal(response.status, expectedStatus, await response.clone().text());
      return response;
    }
    async function getInventory(queryString, expectedStatus = 200) {
      const response = await inventoryRoute.GET(new NextRequest(`http://localhost/api/inventory?${queryString}`));
      const body = await response.json();
      assert.equal(response.status, expectedStatus, JSON.stringify(body));
      return body.data;
    }

    const preview = await post({ action: 'preview', mode: 'filtered', query: 'status=all&page=1&pageSize=1', columns: ['sn'] });
    assert.equal((await preview.json()).data.total, 56, 'filtered export preview ignores pagination');
    assert.equal((await getInventory('status=all&pageSize=100')).total, 56, 'inventory list uses the shared filter module');
    const filtered = await post({ action: 'preview', mode: 'filtered', query: 'status=all&warehouseId=warehouse_east&brand=ThinkPad&model=X13&configSearch=i5-1340P', columns: ['sn'] });
    assert.equal((await filtered.json()).data.total, 28, 'export composes search, brand/model, status and warehouse scope');
    assert.equal((await getInventory('status=all&pageSize=100&warehouseId=warehouse_east&brand=ThinkPad&model=X13&configSearch=i5-1340P')).total, 28, 'list and export share the same warehouse and configuration filters');
    const statusMeta = await getInventory('meta=filters');
    assert.equal(Number(statusMeta.statusDefinitions.find(item => item.id === 'qa-status').machineCount), 2, 'status option counts include active machines');
    for (const filter of ['productType=%E7%AC%94%E8%AE%B0%E6%9C%AC%E7%94%B5%E8%84%91', 'cpu=i5-1340P', 'ram=16GB', 'gpu=%E9%9B%86%E6%88%90%E6%98%BE%E5%8D%A1', 'screen=13.3', 'touchScreen=1', 'snContains=0001', 'itemNumberContains=ASSET-0001', 'remarks=备注%201']) {
      const result = await getInventory(`status=all&pageSize=100&${filter}`);
      const expected = filter.includes('0001') ? 1 : filter.includes('remarks=') ? 11 : filter.includes('touchScreen=') ? 28 : 56;
      assert.equal(result.total, expected, `custom filter ${filter}`);
    }
    assert.equal((await getInventory('status=all&pageSize=100&cpu=i5-1340P&ram=16GB&gpu=%E9%9B%86%E6%88%90%E6%98%BE%E5%8D%A1&screen=13.3&snContains=0001&itemNumberContains=ASSET-0001&remarks=备注%201')).total, 1, 'configuration, serial, item number and remarks filters compose');
    assert.equal((await getInventory('status=all&pageSize=100&configSearch=唯一资产识别词')).total, 1, 'configuration search matches machine remarks');
    assert.equal((await getInventory('status=all&pageSize=100&configSearch=SKU备注唯一识别词')).total, 1, 'configuration search matches SKU remarks');
    const pinDefinitions = ['a', 'b', 'c', 'd', 'e', 'disabled'].map((id, index) => ({ id, isActive: index < 5 }));
    assert.deepEqual(statusPreferences.defaultPinnedInventoryStatusIds(pinDefinitions), ['a', 'b', 'c', 'd'], 'default status bar has at most four custom statuses');
    assert.deepEqual(statusPreferences.normalizePinnedInventoryStatusIds(['e', 'a', 'a', 'disabled', 'b', 'c', 'd'], pinDefinitions), ['e', 'a', 'b', 'c'], 'saved pins are unique, active, and capped at four');
    assert.deepEqual(statusPreferences.readPinnedInventoryStatusIds('{bad json', pinDefinitions), ['a', 'b', 'c', 'd'], 'invalid saved pins recover to defaults');
    await post({ action: 'preview', mode: 'filtered', query: 'status=all&inboundFrom=not-a-date', columns: ['sn'] }, 400);

    const selected = await post({ action: 'preview', mode: 'selected', ids: ['qa-machine-0', 'qa-machine-1', 'qa-machine-1'], columns: ['sn'] });
    assert.equal((await selected.json()).data.total, 2, 'selected ids are deduplicated and re-queried');
    const fullCsv = await post({ action: 'download', mode: 'filtered', query: 'status=all&page=1&pageSize=1', columns: ['sn', 'warehouse'] });
    const csvText = Buffer.from(await fullCsv.arrayBuffer()).toString('utf8');
    assert.equal(csvText.charCodeAt(0), 0xfeff, 'CSV has a UTF-8 BOM');
    assert.equal(csvText.trimEnd().split('\r\n').length, 57, 'all filtered rows export across pages');
    assert(csvText.includes('QA-EXPORT-0000'));

    const safeCsv = await post({ action: 'download', mode: 'selected', ids: ['qa-machine-0'], columns: ['machineRemark'] });
    assert((await safeCsv.text()).includes("'=HYPERLINK"), 'CSV formula-like text is escaped');
    await post({ action: 'preview', mode: 'filtered', query: 'status=all', columns: ['sn);DROP TABLE inventory;--'] }, 400);

    user = { id: 'qa-manager', role: 'warehouse_manager', isSystemAccount: false, canViewInventory: true, canEditInventory: true, warehouses: [{ id: 'warehouse_east', status: 'active' }] };
    const scopedStatusMeta = await getInventory('meta=filters');
    assert.equal(Number(scopedStatusMeta.statusDefinitions.find(item => item.id === 'qa-status').machineCount), 1, 'status option counts honor warehouse access');
    const scoped = await post({ action: 'preview', mode: 'selected', ids: ['qa-machine-0', 'qa-machine-1'], columns: ['sn'] });
    assert.equal((await scoped.json()).data.total, 1, 'selected export rechecks the warehouse assignment');
    await post({ action: 'preview', mode: 'filtered', query: 'status=all&warehouseId=warehouse_main', columns: ['sn'] }, 403);

    user = { ...user, role: 'viewer', canEditInventory: false };
    await post({ action: 'preview', mode: 'filtered', query: 'status=all', columns: ['sn'] }, 403);
    assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
    assert.equal(db.pragma('foreign_key_check').length, 0);
    console.log('PASS inventory filters/export: machine and SKU remark search, status pin preferences, unpaginated export, selected ID revalidation, warehouse scope, viewer denial, column whitelist, CSV formula protection');
  } finally {
    db.close();
  }
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
