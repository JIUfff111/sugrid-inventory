/** Run: node scripts/test-sku-brand-migration.cjs */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const Database = require('better-sqlite3');
const { NextRequest } = require('next/server');
const schema = require('./database.cjs');

const root = path.resolve(__dirname, '..');
function load(relativePath, dependencies = {}) {
  const filename = path.join(root, relativePath);
  const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    fileName: filename,
  }).outputText;
  const loaded = new Module(filename, module);
  loaded.filename = filename;
  loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  const originalRequire = loaded.require.bind(loaded);
  loaded.require = name => Object.hasOwn(dependencies, name) ? dependencies[name] : originalRequire(name);
  loaded._compile(compiled, filename);
  return loaded.exports;
}

async function main() {
  const scratchParent = path.join(root, '.tmp');
  fs.mkdirSync(scratchParent, { recursive: true });
  const scratch = fs.mkdtempSync(path.join(scratchParent, 'sku-brand-'));
  const db = new Database(path.join(scratch, 'test.db'));
  try {
    db.pragma('foreign_keys = ON');
    schema.initDatabase(db);
    schema.seedDatabase(db);
    const actor = db.prepare("SELECT id FROM users WHERE role = 'admin' LIMIT 1").get().id;
    const insertSKU = db.prepare(`INSERT INTO skus(id,productType,brand,model,year,cpuOptions,ramOptions,createdBy)
      VALUES (?,'笔记本电脑',?,?,2020,'["Intel Core i5-10210U"]','["16GB"]',?)`);
    insertSKU.run('legacy-redmi', 'Redmi', 'Redmi G 游戏本', actor);
    insertSKU.run('legacy-hongmi', '红米', 'RedmiBook 14', actor);
    insertSKU.run('xiaomi', '小米', '小米笔记本 Pro 15', actor);
    db.prepare("INSERT INTO suppliers(id,supplierName) VALUES ('sku-supplier','测试供应商')").run();
    db.prepare(`INSERT INTO purchase_orders(id,purchaseNo,supplierOrderNo,supplierId,supplierName,purchaseDate,purchasedBy,createdBy)
      VALUES ('sku-order','SKU-ORDER','EXTERNAL','sku-supplier','测试供应商','2026-10-26',?,?)`).run(actor, actor);
    db.prepare(`INSERT INTO purchase_items(id,purchaseOrderId,productType,brand,model,year,cpu,ram,storage,screen,sn,purchasePrice)
      VALUES ('sku-item','sku-order','笔记本电脑','Redmi','Redmi G 游戏本',2020,'i5','16GB','512GB','13','SKU-SN-1',1000)`).run();
    db.prepare(`INSERT INTO inventory(id,purchaseOrderId,purchaseItemId,sn,productType,brand,model,year,cpu,ram,storage,screen,purchasePrice,supplierId,supplierName,inboundDate)
      VALUES ('sku-machine','sku-order','sku-item','SKU-SN-1','笔记本电脑','Redmi','Redmi G 游戏本',2020,'i5','16GB','512GB','13',1000,'sku-supplier','测试供应商','2026-10-26')`).run();
    const originalMachine = db.prepare("SELECT brand,model,ram,storage,purchasePrice FROM inventory WHERE id='sku-machine'").get();
    const originalPurchase = db.prepare("SELECT brand,model,ram,storage,purchasePrice FROM purchase_items WHERE id='sku-item'").get();
    db.prepare('DELETE FROM schema_migrations WHERE version = 7').run();
    schema.initDatabase(db);
    assert.deepEqual(db.prepare('SELECT id,brand,model FROM skus ORDER BY id').all(), [
      { id: 'legacy-hongmi', brand: '小米', model: 'RedmiBook 14' },
      { id: 'legacy-redmi', brand: '小米', model: 'Redmi G 游戏本' },
      { id: 'xiaomi', brand: '小米', model: '小米笔记本 Pro 15' },
    ]);
    assert.deepEqual(db.prepare("SELECT brand,model,ram,storage,purchasePrice FROM inventory WHERE id='sku-machine'").get(), originalMachine);
    assert.deepEqual(db.prepare("SELECT brand,model,ram,storage,purchasePrice FROM purchase_items WHERE id='sku-item'").get(), originalPurchase);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 7').get().count, 1);
    schema.initDatabase(db);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM skus').get().count, 3);

    const brand = load('src/lib/sku-brand.ts');
    assert.equal(brand.canonicalSKUBrand(' Redmi '), '小米');
    assert.equal(brand.canonicalSKUBrand('红米'), '小米');
    assert.equal(brand.canonicalSKUBrand('ThinkPad'), 'ThinkPad');
    const route = load('src/app/api/skus/route.ts', {
      '@/lib/db': db,
      '@/lib/sku-brand': brand,
      '@/lib/auth': { requireRole: async () => ({ id: actor }), authErrorResponse: () => null },
      '@/lib/api-helpers': load('src/lib/api-helpers.ts'),
    });
    const body = (model, brandName, year = 2021) => ({ productType: '笔记本电脑', brand: brandName, model, year,
      cpuOptions: ['AMD Ryzen 5 5500U'], ramOptions: ['16GB'], gpuOptions: [], storageOptions: ['512GB'], screenOptions: [] });
    const response = await route.POST(new NextRequest('http://localhost/api/skus', {
      method: 'POST', body: JSON.stringify(body('Redmi G Pro', '红米')),
    }));
    assert.equal(response.status, 201);
    const created = (await response.json()).data;
    assert.equal(created.brand, '小米');
    assert.equal(created.model, 'Redmi G Pro');
    const duplicate = await route.POST(new NextRequest('http://localhost/api/skus', {
      method: 'POST', body: JSON.stringify(body('Redmi G 游戏本', 'Redmi', 2020)),
    }));
    assert.equal(duplicate.status, 400);
    const putDuplicate = await route.PUT(new NextRequest('http://localhost/api/skus', {
      method: 'PUT', body: JSON.stringify({ id: created.id, ...body('Redmi G 游戏本', 'Redmi', 2020) }),
    }));
    assert.equal(putDuplicate.status, 400);
    const updated = await route.PUT(new NextRequest('http://localhost/api/skus', {
      method: 'PUT', body: JSON.stringify({ id: created.id, ...body('Redmi G Pro 2022', 'Redmi') }),
    }));
    assert.equal(updated.status, 200);
    assert.equal((await updated.json()).data.brand, '小米');
    const listed = await route.GET(new NextRequest('http://localhost/api/skus?brand=Redmi&pageSize=20'));
    assert.equal(listed.status, 200);
    const rows = (await listed.json()).data.items;
    assert.equal(rows.length, 4);
    assert(rows.every(row => row.brand === '小米'));
    const hongmi = await route.GET(new NextRequest('http://localhost/api/skus?brand=%E7%BA%A2%E7%B1%B3&pageSize=20'));
    assert.equal((await hongmi.json()).data.items.length, 4);
    assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
    console.log('PASS SKU brand migration: Xiaomi grouping, model preservation, API writes, duplicate protection, machine history');
  } finally {
    db.close();
    assert(scratch.startsWith(`${scratchParent}${path.sep}sku-brand-`));
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
