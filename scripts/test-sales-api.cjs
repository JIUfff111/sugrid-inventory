/**
 * Exercises the real TypeScript route and SQLite schema against disposable data.
 * Run: node scripts/test-sales-api.cjs
 * Add --live=http://localhost:3000 for GET + rejected POST checks on the running app.
 * Live checks never submit a valid sale and verify that business rows stay unchanged.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const Database = require('better-sqlite3');
const { NextRequest } = require('next/server');

const projectRoot = path.resolve(__dirname, '..');

function loadTypeScript(relativePath, dependencies = {}) {
  const filename = path.join(projectRoot, relativePath);
  const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    fileName: filename,
  }).outputText;
  const sourceModule = new Module(filename, module);
  sourceModule.filename = filename;
  sourceModule.paths = Module._nodeModulePaths(path.dirname(filename));
  const standardRequire = sourceModule.require.bind(sourceModule);
  sourceModule.require = (name) => Object.hasOwn(dependencies, name) ? dependencies[name] : standardRequire(name);
  sourceModule._compile(compiled, filename);
  return sourceModule.exports;
}

async function isolatedChecks() {
  const scratchParent = path.join(projectRoot, '.tmp');
  fs.mkdirSync(scratchParent, { recursive: true });
  const scratchRoot = fs.mkdtempSync(path.join(scratchParent, 'sales-api-'));
  const originalCwd = process.cwd();
  let db;
  try {
    process.chdir(scratchRoot);
    const databaseModule = loadTypeScript('src/lib/db.ts');
    process.chdir(originalCwd);
    db = databaseModule.default;
    assert(db.prepare('PRAGMA table_info(sales_records)').all().some((column) => column.name === 'trackingNo'));
    databaseModule.initDatabase();
    let sessionToken;
    const authModule = loadTypeScript('src/lib/auth.ts', { '@/lib/db': databaseModule, '@/lib/api-helpers': loadTypeScript('src/lib/api-helpers.ts'), 'next/headers': { cookies: async () => ({ get: () => sessionToken ? { value: sessionToken } : undefined }) } });
    const route = loadTypeScript('src/app/api/sales/route.ts', {
      '@/lib/inventory-status': loadTypeScript('src/lib/inventory-status.ts', { '@/lib/db': databaseModule, '@/lib/api-helpers': loadTypeScript('src/lib/api-helpers.ts') }),
      '@/lib/auth': authModule,
      '@/lib/db': databaseModule,
      '@/lib/api-helpers': loadTypeScript('src/lib/api-helpers.ts'),
    });
    const user = db.prepare("SELECT id FROM users WHERE role='admin' AND status='active' LIMIT 1").get().id;
    sessionToken = authModule.createSession(user);
    db.prepare("INSERT INTO suppliers (id, supplierName) VALUES ('supplier-test', '回归供应商')").run();
    db.prepare("INSERT INTO sales_channels (id, channelName) VALUES ('channel-test', '回归渠道')").run();
    db.prepare(`INSERT INTO purchase_orders (id, purchaseNo, supplierOrderNo, supplierId, supplierName,
      purchaseDate, purchasedBy, createdBy) VALUES ('purchase-test', 'CG-TEST', 'CG-EXT', 'supplier-test',
      '回归供应商', '2026-10-20', ?, ?)`).run(user, user);
    function addMachine(id) {
      db.prepare(`INSERT INTO purchase_items (id, purchaseOrderId, productType, brand, model, year, cpu,
        ram, storage, screen, sn, purchasePrice) VALUES (?, 'purchase-test', '笔记本电脑', 'ThinkPad',
        'X13', 2020, 'i5', '16GB', '512GB', '', ?, 1000)`).run(`item-${id}`, `SN-${id}`);
      db.prepare(`INSERT INTO inventory (id, purchaseOrderId, purchaseItemId, sn, productType, brand,
        model, year, cpu, ram, storage, screen, purchasePrice, supplierId, supplierName, inboundDate)
        VALUES (?, 'purchase-test', ?, ?, '笔记本电脑', 'ThinkPad', 'X13', 2020, 'i5', '16GB', '512GB',
        '', 1000, 'supplier-test', '回归供应商', '2026-10-20')`).run(id, `item-${id}`, `SN-${id}`);
    }
    ['trimmed', 'omitted', 'blank', 'null', 'boundary', 'invalid', 'rollback', 'race'].forEach(addMachine);
    const baseBody = (inventoryId) => ({ saleOrderNo: `SALE-${inventoryId}`, saleChannelId: 'channel-test',
      saleDate: '2026-10-20', items: [{ inventoryId, sellingPrice: 1500 }] });
    async function post(body, expectedStatus) {
      const oldError = console.error;
      if (expectedStatus >= 400) console.error = () => {};
      try {
        const response = await route.POST(new NextRequest('http://localhost/api/sales', {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
        }));
        const payload = await response.json();
        assert.equal(response.status, expectedStatus, JSON.stringify(payload));
        return payload;
      } finally {
        console.error = oldError;
      }
    }
    const trimmed = await post({ ...baseBody('trimmed'), trackingNo: '  SF123456789  ' }, 201);
    assert.equal(trimmed.data.trackingNo, 'SF123456789');
    assert.equal(trimmed.data.items[0].year, 2020);
    assert.equal(db.prepare('SELECT trackingNo FROM sales_records WHERE id = ?').get(trimmed.data.id).trackingNo,
      'SF123456789');
    assert.equal(db.prepare("SELECT status FROM inventory WHERE id = 'trimmed'").get().status, 'sold');
    assert.equal((await post(baseBody('omitted'), 201)).data.trackingNo, null);
    assert.equal((await post({ ...baseBody('blank'), trackingNo: '  ' }, 201)).data.trackingNo, null);
    assert.equal((await post({ ...baseBody('null'), trackingNo: null }, 201)).data.trackingNo, null);
    assert.equal((await post({ ...baseBody('boundary'), trackingNo: 'A'.repeat(100) }, 201)).data.trackingNo.length, 100);
    for (const trackingNo of [12345, {}, ['SF123'], 'A'.repeat(101)]) {
      const rejected = await post({ ...baseBody('invalid'), trackingNo }, 400);
      assert.match(rejected.error.message, /快递单号/);
      assert.equal(db.prepare("SELECT status FROM inventory WHERE id = 'invalid'").get().status, 'in_stock');
    }
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sales_records').get().count, 5);

    // Force failure after inventory updates: the transaction must roll everything back.
    db.exec(`CREATE TRIGGER reject_test_sale BEFORE INSERT ON sales_records
      WHEN NEW.saleOrderNo = 'SALE-rollback'
      BEGIN SELECT RAISE(ABORT, 'forced transaction failure'); END`);
    await post(baseBody('rollback'), 500);
    assert.equal(db.prepare("SELECT status FROM inventory WHERE id = 'rollback'").get().status, 'in_stock');
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sales_records').get().count, 5);
    assert.equal(db.prepare("SELECT usageCount FROM sales_channels WHERE id = 'channel-test'").get().usageCount, 5);

    const originalError = console.error;
    let concurrent;
    try {
      console.error = () => {};
      concurrent = await Promise.all([
        route.POST(new NextRequest('http://localhost/api/sales', { method: 'POST', body: JSON.stringify(baseBody('race')) })),
        route.POST(new NextRequest('http://localhost/api/sales', { method: 'POST', body: JSON.stringify(baseBody('race')) })),
      ]);
    } finally {
      console.error = originalError;
    }
    assert.deepEqual(concurrent.map((response) => response.status).sort(), [201, 400]);
    const result = await route.GET(new NextRequest('http://localhost/api/sales'));
    const data = (await result.json()).data;
    assert(Array.isArray(data.items) && Array.isArray(data.channels) && Array.isArray(data.records));
    assert.equal(data.records.length, 6);
    assert(data.records.every((record) => Array.isArray(record.items)));
    assert.equal(data.records.find((record) => record.id === trimmed.data.id).trackingNo, 'SF123456789');
    assert.equal(data.records.find((record) => record.id === trimmed.data.id).items[0].year, 2020);
    for (const [search, expectedIds] of [
      ['ThinkPad X13 2020', ['invalid', 'rollback']],
      ['ThinkPad X13 2021', []],
      ['SN-inval', ['invalid']],
    ]) {
      const filtered = await route.GET(new NextRequest(`http://localhost/api/sales?search=${encodeURIComponent(search)}`));
      assert.deepEqual((await filtered.json()).data.items.map((item) => item.id).sort(), expectedIds);
    }
    assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
    console.log('PASS isolated sales API: tracking validation/persistence, year snapshot, no duplicate sale, rollback, composite search, GET compatibility');
  } finally {
    process.chdir(originalCwd);
    if (db?.open) db.close();
    const resolvedScratch = path.resolve(scratchRoot);
    assert(resolvedScratch.startsWith(`${path.resolve(scratchParent)}${path.sep}sales-api-`));
    fs.rmSync(resolvedScratch, { recursive: true, force: true });
  }
}

async function liveChecks(baseUrl) {
  const endpoint = new URL('/api/sales', baseUrl);
  const initialResponse = await fetch(endpoint);
  assert.equal(initialResponse.status, 401);
  const liveDb = new Database(path.join(projectRoot, 'data', 'inventory.db'), { readonly: true });
  try {
    const snapshot = () => JSON.stringify({
      inventory: liveDb.prepare('SELECT id, status, soldDate, sellingPrice, saleOrderNo, updatedAt FROM inventory ORDER BY id').all(),
      sales: liveDb.prepare('SELECT * FROM sales_records ORDER BY id').all(),
      channels: liveDb.prepare('SELECT id, usageCount, updatedAt FROM sales_channels ORDER BY id').all(),
    });
    assert(liveDb.prepare('PRAGMA table_info(sales_records)').all().some((column) => column.name === 'trackingNo'));
    const before = snapshot();
    for (const trackingNo of [123, 'A'.repeat(101)]) {
      const response = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ trackingNo }) });
      const payload = await response.json();
      assert.equal(response.status, 401);
      assert.equal(payload.error.code, "UNAUTHORIZED");
    }
    assert.equal(snapshot(), before, 'Rejected live requests must not change inventory, sales, or channel rows');
    assert.equal(liveDb.pragma('integrity_check', { simple: true }), 'ok');
    console.log('PASS live sales API: unauthenticated GET/POST denied; real business rows unchanged');
  } finally {
    liveDb.close();
  }
}

(async () => {
  await isolatedChecks();
  const liveArg = process.argv.find((argument) => argument.startsWith('--live='));
  if (liveArg) await liveChecks(liveArg.slice('--live='.length));
})().catch((error) => { console.error(error); process.exitCode = 1; });
