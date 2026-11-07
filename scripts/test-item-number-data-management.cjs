/** Isolated export, search and import checks for the optional inventory item number. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
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
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'sugrid-item-number-'));
  const previousPath = process.env.INVENTORY_DB_PATH;
  process.env.INVENTORY_DB_PATH = path.join(scratch, 'inventory.db');
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  try {
    initDatabase(db);
    seedDatabase(db);
    const database = { __esModule: true, default: db };
    const apiHelpers = load('src/lib/api-helpers.ts');
    let token;
    const auth = load('src/lib/auth.ts', {
      '@/lib/db': database,
      '@/lib/api-helpers': apiHelpers,
      'next/headers': { cookies: async () => ({ get: () => token ? { value: token } : undefined }) },
    });
    const dataManagement = load('src/lib/data-management.ts', {
      '@/lib/db': database,
      '@/lib/api-helpers': apiHelpers,
      '@/lib/auth': auth,
    });
    const preview = load('src/app/api/data-management/import/preview/route.ts', {
      '@/lib/db': database,
      '@/lib/auth': auth,
      '@/lib/api-helpers': apiHelpers,
      '@/lib/data-management': dataManagement,
    });
    const exportRoute = load('src/app/api/data-management/export/route.ts', {
      '@/lib/db': database,
      '@/lib/auth': auth,
      '@/lib/api-helpers': apiHelpers,
      '@/lib/data-management': dataManagement,
    });
    const importRoute = load('src/app/api/data-management/import/route.ts', {
      '@/lib/db': database,
      '@/lib/auth': auth,
      '@/lib/api-helpers': apiHelpers,
      '@/lib/data-management': dataManagement,
      './preview/route': preview,
    });

    const adminId = db.prepare("SELECT id FROM users WHERE username = 'admin'").get().id;
    token = auth.createSession(adminId);
    db.prepare(`INSERT INTO suppliers (id,supplierName,status,createdBy) VALUES ('number-supplier','编号测试供应商','active',?)`).run(adminId);
    db.prepare(`INSERT INTO purchase_orders
      (id,purchaseNo,supplierOrderNo,supplierId,supplierName,purchaseDate,purchasedBy,createdBy)
      VALUES ('number-order','NUMBER-ORDER','', 'number-supplier','编号测试供应商','2026-11-07',?,?)`).run(adminId, adminId);
    db.prepare(`INSERT INTO purchase_items
      (id,purchaseOrderId,productType,brand,model,cpu,ram,storage,screen,sn,itemNumber,purchasePrice)
      VALUES ('number-item','number-order','显卡','华硕','RTX 4060','','','','','NUMBER-SN-001','GPU-0001',0)`).run();
    db.prepare(`INSERT INTO inventory
      (id,purchaseOrderId,purchaseItemId,sn,itemNumber,productType,brand,model,cpu,ram,storage,screen,purchasePrice,supplierId,supplierName,status,inboundDate,warehouseId)
      VALUES ('number-inventory','number-order','number-item','NUMBER-SN-001','GPU-0001','显卡','华硕','RTX 4060','','','','',0,'number-supplier','编号测试供应商','in_stock','2026-11-07','warehouse_main')`).run();

    for (const key of ['purchase_items', 'inventory']) {
      const resource = dataManagement.DATA_RESOURCES[key];
      assert(resource.fields.includes('itemNumber'), `${key} must include itemNumber in exports`);
      assert(resource.searchFields.includes('itemNumber'), `${key} must search by itemNumber`);
      assert(!resource.writable.includes('itemNumber'), `${key} itemNumber must not be editable through generic data management`);
      const rows = dataManagement.listResource(resource, new URLSearchParams('search=GPU-0001'));
      assert.equal(rows.total, 1, `${key} search should find an item number`);
      assert.equal(rows.items[0].itemNumber, 'GPU-0001');
    }

    const exportRequest = url => new NextRequest(`http://localhost${url}`);
    const jsonResponse = await exportRoute.GET(exportRequest('/api/data-management/export?resource=inventory'));
    assert.equal(jsonResponse.status, 200);
    const inventoryExport = JSON.parse(await jsonResponse.text());
    assert.equal(inventoryExport.resources.inventory[0].itemNumber, 'GPU-0001');
    const csvResponse = await exportRoute.GET(exportRequest('/api/data-management/export?resource=purchase_items&format=csv'));
    assert.equal(csvResponse.status, 200);
    assert.match(await csvResponse.text(), /itemNumber/);

    const makePurchaseItem = (id, itemNumber) => ({
      id, purchaseOrderId: 'number-order', productType: '显卡', brand: '微星', model: 'RTX 4060',
      cpu: '', ram: '', storage: '', screen: '', sn: `${id}-SN`, itemNumber, purchasePrice: 0,
    });
    const makeInventory = (id, purchaseItemId, itemNumber) => ({
      id, purchaseOrderId: 'number-order', purchaseItemId, sn: `${id}-SN`, itemNumber,
      productType: '显卡', brand: '微星', model: 'RTX 4060', cpu: '', ram: '', storage: '', screen: '',
      purchasePrice: 0, supplierId: 'number-supplier', supplierName: '编号测试供应商', status: 'in_stock',
      inboundDate: '2026-11-07', warehouseId: 'warehouse_main',
    });
    const build = content => preview.buildImportReport(null, { resources: content });

    const matchingMirror = await build({
      purchase_items: [makePurchaseItem('new-item', 'GPU-NEW-1')],
      inventory: [makeInventory('new-inventory', 'new-item', 'GPU-NEW-1')],
    });
    assert.deepEqual(matchingMirror.flatMap(report => report.errors), [], 'paired purchase/inventory numbers should be accepted');
    assert.equal(matchingMirror.reduce((count, report) => count + report.valid, 0), 2);

    const importedPair = {
      purchase_items: [makePurchaseItem('imported-number-item', 'GPU-IMPORTED-1')],
      inventory: [makeInventory('imported-number-inventory', 'imported-number-item', 'GPU-IMPORTED-1')],
    };
    const importResponse = await importRoute.POST(new NextRequest('http://localhost/api/data-management/import', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'insert', fileName: 'item-number.json', content: { resources: importedPair } }),
    }));
    assert.equal(importResponse.status, 200, JSON.stringify(await importResponse.clone().json()));
    const importResult = (await importResponse.json()).data;
    assert.equal(importResult.inserted, 2);
    assert.equal(db.prepare("SELECT itemNumber FROM purchase_items WHERE id='imported-number-item'").get().itemNumber, 'GPU-IMPORTED-1');
    assert.equal(db.prepare("SELECT itemNumber FROM inventory WHERE id='imported-number-inventory'").get().itemNumber, 'GPU-IMPORTED-1');
    assert(fs.existsSync(path.join(scratch, 'backups')), 'actual import must create a backup under the isolated test directory');

    const databaseCollision = await build({
      purchase_items: [makePurchaseItem('collision-item', 'gpu-0001')],
      inventory: [makeInventory('collision-inventory', 'collision-item', 'gpu-0001')],
    });
    assert(databaseCollision.some(report => report.conflictDetails.some(detail => detail.message.includes('全库唯一'))),
      'database collisions must be reported case-insensitively');

    const incomingCollision = await build({
      purchase_items: [makePurchaseItem('duplicate-a', 'GPU-DUP-1'), makePurchaseItem('duplicate-b', 'gpu-dup-1')],
    });
    assert(incomingCollision.some(report => report.conflictDetails.some(detail => detail.message.includes('导入文件中重复'))),
      'duplicate numbers in the same import must be conflicts');

    const unrelatedCrossResourceCollision = await build({
      purchase_items: [makePurchaseItem('unrelated-item', 'GPU-CROSS-1')],
      inventory: [makeInventory('unrelated-inventory', 'number-item', 'gpu-cross-1')],
    });
    assert(unrelatedCrossResourceCollision.some(report =>
      report.conflictDetails.some(detail => detail.message.includes('导入文件中重复')) ||
      report.errors.some(error => error.message.includes('导入文件中重复'))),
      'cross-resource duplicates with unrelated purchase item ids must be rejected');

    const mismatch = await build({
      purchase_items: [makePurchaseItem('mismatch-item', 'GPU-MISMATCH-A')],
      inventory: [makeInventory('mismatch-inventory', 'mismatch-item', 'GPU-MISMATCH-B')],
    });
    assert(mismatch.some(report => report.errors.some(error => error.message.includes('不一致'))),
      'paired records with different item numbers must fail preview');

    const malformed = await build({
      purchase_items: [makePurchaseItem('long-item', 'X'.repeat(121)), makePurchaseItem('control-item', 'BAD\u0001VALUE')],
    });
    assert(malformed.some(report => report.errors.some(error => error.message.includes('最多 120'))));
    assert(malformed.some(report => report.errors.some(error => error.message.includes('控制字符'))));

    const optionalNumber = await build({ purchase_items: [makePurchaseItem('empty-number-item', '   ')] });
    assert.deepEqual(optionalNumber.flatMap(report => report.errors), [], 'blank item numbers must remain optional');
    const readonlyChange = await preview.buildImportReport('purchase_items', [
      makePurchaseItem('number-item', 'GPU-CHANGED'),
    ], 'upsert');
    assert(readonlyChange.some(report => report.errors.some(error => error.message.includes('不允许通过数据管理导入修改'))),
      'item numbers on existing procurement records must not be changed by data-management upsert');
    assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
    assert.deepEqual(db.pragma('foreign_key_check'), []);
    console.log('PASS isolated item-number management: JSON/CSV export, search, mirror pairing, cross-resource uniqueness, format checks and optional blanks');
  } finally {
    if (previousPath === undefined) delete process.env.INVENTORY_DB_PATH; else process.env.INVENTORY_DB_PATH = previousPath;
    db.close();
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
