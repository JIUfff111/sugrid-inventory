/** Run: node scripts/test-sku-frequency.cjs */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const { NextRequest } = require('next/server');

const root = path.resolve(__dirname, '..');
function load(relative, deps = {}) {
  const filename = path.join(root, relative);
  const code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    fileName: filename,
  }).outputText;
  const loaded = new Module(filename, module);
  loaded.filename = filename;
  loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  const ordinary = loaded.require.bind(loaded);
  loaded.require = (name) => Object.hasOwn(deps, name) ? deps[name] : ordinary(name);
  loaded._compile(code, filename);
  return loaded.exports;
}

async function main() {
  const scratchParent = path.join(root, '.tmp');
  fs.mkdirSync(scratchParent, { recursive: true });
  const scratch = fs.mkdtempSync(path.join(scratchParent, 'sku-frequency-'));
  const previousPath = process.env.INVENTORY_DB_PATH;
  process.env.INVENTORY_DB_PATH = path.join(scratch, 'inventory.db');
  let db;
  try {
    const database = load('src/lib/db.ts');
    db = database.default;
    let token = null;
    const helpers = load('src/lib/api-helpers.ts');
    const auth = load('src/lib/auth.ts', {
      '@/lib/db': database,
      '@/lib/api-helpers': helpers,
      'next/headers': { cookies: async () => ({ get: () => token ? { value: token } : undefined }) },
    });
    const deps = {
      '@/lib/db': database,
      '@/lib/auth': auth,
      '@/lib/api-helpers': helpers,
      '@/lib/sku-brand': load('src/lib/sku-brand.ts'),
      '@/lib/sku-display': load('src/lib/sku-display.ts'),
    };
    const purchase = load('src/app/api/purchase-orders/route.ts', deps);
    const frequent = load('src/app/api/skus/frequent/route.ts', deps);
    async function call(route, method, body, expected = 200, query = '') {
      const request = new NextRequest(`http://localhost/api/${route}${query}`, {
        method,
        ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
      });
      const response = await (route === 'purchase-orders' ? purchase : frequent)[method](request);
      const payload = await response.json();
      assert.equal(response.status, expected, `${route} ${method}: ${JSON.stringify(payload)}`);
      return payload.data;
    }

    await call('skus/frequent', 'GET', undefined, 401);
    db.prepare("INSERT INTO users(id,username,password,role,status) VALUES ('entry-a','entry-a','test','admin','active'),('entry-b','entry-b','test','admin','active')").run();
    db.prepare("INSERT INTO suppliers(id,supplierName) VALUES ('supplier-frequency','测试供应商')").run();
    db.prepare("INSERT INTO skus(id,productType,brand,model,year) VALUES ('sku-x','笔记本电脑','ThinkPad','X13',2020),('sku-y','笔记本电脑','ThinkPad','X1 Carbon',2021)").run();
    const warehouseId = db.prepare("SELECT id FROM warehouses WHERE status='active' ORDER BY isDefault DESC LIMIT 1").get().id;
    const machine = (skuId, model, year, sn) => ({ skuId, productType: '笔记本电脑', brand: 'ThinkPad', model, year, cpu: 'i5', ram: '16GB', storage: '512GB', sn, purchasePrice: 1000 });
    const x = (sn) => machine('sku-x', 'X13', 2020, sn);
    const y = (sn) => machine('sku-y', 'X1 Carbon', 2021, sn);
    const orderBody = (items, suffix) => ({ supplierId: 'supplier-frequency', warehouseId, supplierOrderNo: `EXT-${suffix}`, purchaseDate: '2026-10-26', purchasedBy: '当前用户', items });
    const rankings = async () => (await call('skus/frequent', 'GET')).items;

    token = auth.createSession('entry-a');
    const draft = await call('purchase-orders', 'POST', { ...orderBody([x('FREQ-X1'), x('FREQ-X2'), y('FREQ-Y1')], 'A'), status: 'draft' }, 201);
    assert.deepEqual(await rankings(), [{ skuId: 'sku-x', count: 2 }, { skuId: 'sku-y', count: 1 }]);
    const original = await call('purchase-orders', 'GET', undefined, 200, `?id=${draft.id}`);
    assert(original.items.every((item) => item.skuId));
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM purchase_items WHERE purchaseOrderId=? AND recordedBy=?').get(draft.id, 'entry-a').n, 3);

    token = auth.createSession('entry-b');
    await call('purchase-orders', 'PATCH', { ...orderBody([...original.items, x('FREQ-X3')], 'A'), id: draft.id, action: 'draft' });
    assert.deepEqual(await rankings(), [{ skuId: 'sku-x', count: 1 }]);
    token = auth.createSession('entry-a');
    assert.deepEqual(await rankings(), [{ skuId: 'sku-x', count: 2 }, { skuId: 'sku-y', count: 1 }]);

    token = auth.createSession('entry-b');
    const edited = await call('purchase-orders', 'GET', undefined, 200, `?id=${draft.id}`);
    await call('purchase-orders', 'PATCH', { ...orderBody(edited.items, 'A'), id: draft.id, action: 'inbound' });
    assert.deepEqual(await rankings(), [{ skuId: 'sku-x', count: 1 }]);
    token = auth.createSession('entry-a');
    assert.deepEqual(await rankings(), [{ skuId: 'sku-x', count: 2 }, { skuId: 'sku-y', count: 1 }]);

    const abandoned = await call('purchase-orders', 'POST', { ...orderBody([x('FREQ-ABANDON')], 'ABANDON'), status: 'draft' }, 201);
    assert.equal((await rankings())[0].count, 3);
    await call('purchase-orders', 'DELETE', undefined, 200, `?id=${abandoned.id}`);
    assert.equal((await rankings())[0].count, 2);

    const changed = await call('purchase-orders', 'POST', {
      ...orderBody([machine('sku-x', 'X1 Carbon', 2021, 'FREQ-CHANGED')], 'CHANGED'), status: 'draft',
    }, 201);
    assert.equal(db.prepare('SELECT skuId FROM purchase_items WHERE purchaseOrderId=?').get(changed.id).skuId, 'sku-y');
    assert.deepEqual(await rankings(), [{ skuId: 'sku-x', count: 2 }, { skuId: 'sku-y', count: 2 }]);
    const recent = new Date(Date.now() - (3 * 24 * 60 * 60 * 1000 - 60 * 1000)).toISOString().replace('T', ' ').slice(0, 19);
    const stale = new Date(Date.now() - (3 * 24 * 60 * 60 * 1000 + 60 * 1000)).toISOString().replace('T', ' ').slice(0, 19);
    db.prepare("UPDATE purchase_items SET createdAt=? WHERE sn='FREQ-X1'").run(stale);
    db.prepare("UPDATE purchase_items SET createdAt=? WHERE sn='FREQ-X2'").run(recent);
    assert.deepEqual(await rankings(), [{ skuId: 'sku-y', count: 2 }, { skuId: 'sku-x', count: 1 }]);
    db.prepare("UPDATE purchase_items SET createdAt=? WHERE recordedBy='entry-a'").run(stale);
    assert.deepEqual(await rankings(), []);
    assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
    console.log('Per-user SKU frequency counts saved machines within the last 72 hours');
  } finally {
    db?.close();
    if (previousPath === undefined) delete process.env.INVENTORY_DB_PATH;
    else process.env.INVENTORY_DB_PATH = previousPath;
    if (path.resolve(scratch).startsWith(path.resolve(scratchParent) + path.sep)) fs.rmSync(scratch, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
