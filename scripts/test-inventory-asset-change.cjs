const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const { NextRequest } = require('next/server');

const root = path.resolve(__dirname, '..');
function load(relativePath, dependencies = {}) {
  const filename = path.join(root, relativePath);
  const source = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    fileName: filename,
  }).outputText;
  const loaded = new Module(filename, module);
  loaded.filename = filename;
  loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  const originalRequire = loaded.require.bind(loaded);
  loaded.require = (name) => Object.hasOwn(dependencies, name) ? dependencies[name] : originalRequire(name);
  loaded._compile(source, filename);
  return loaded.exports;
}

async function main() {
  const scratchParent = path.join(root, '.tmp');
  fs.mkdirSync(scratchParent, { recursive: true });
  const scratch = fs.mkdtempSync(path.join(scratchParent, 'inventory-asset-change-'));
  const previousPath = process.env.INVENTORY_DB_PATH;
  process.env.INVENTORY_DB_PATH = path.join(scratch, 'test.db');
  let db;
  try {
    const helpers = load('src/lib/api-helpers.ts');
    const database = load('src/lib/db.ts');
    db = database.default;
    let sessionToken;
    const auth = load('src/lib/auth.ts', {
      '@/lib/db': database,
      '@/lib/api-helpers': helpers,
      'next/headers': { cookies: async () => ({ get: () => sessionToken ? { value: sessionToken } : undefined }) },
    });
    const route = load('src/app/api/inventory/asset-change/route.ts', {
      '@/lib/db': database, '@/lib/auth': auth, '@/lib/api-helpers': helpers,
    });
    const adminId = db.prepare("SELECT id FROM users WHERE role = 'admin' AND status = 'active' LIMIT 1").get().id;
    sessionToken = auth.createSession(adminId);
    db.prepare("INSERT INTO suppliers(id,supplierName) VALUES ('supplier-asset','Test supplier')").run();
    db.prepare(`INSERT INTO purchase_orders(id,purchaseNo,supplierOrderNo,supplierId,supplierName,purchaseDate,purchasedBy,createdBy)
      VALUES ('order-asset','CG-ASSET','EXT-ASSET','supplier-asset','Test supplier','2026-10-20',?,?)`).run(adminId, adminId);
    db.prepare(`INSERT INTO skus(id,productType,brand,model,ramOptions,storageOptions,createdBy)
      VALUES ('sku-asset','Laptop','ThinkPad','X13','["16GB"]','["512GB"]',?)`).run(adminId);
    function addMachine(id, status = 'in_stock') {
      db.prepare(`INSERT INTO purchase_items(id,purchaseOrderId,productType,brand,model,cpu,ram,storage,screen,sn,purchasePrice)
        VALUES (?, 'order-asset','Laptop','ThinkPad','X13','i5','16GB','512GB','13 inch',?,1000)`).run(`item-${id}`, `SN-${id}`);
      db.prepare(`INSERT INTO inventory(id,purchaseOrderId,purchaseItemId,sn,productType,brand,model,cpu,ram,storage,screen,purchasePrice,supplierId,supplierName,status,inboundDate)
        VALUES (?,'order-asset',?,?,'Laptop','ThinkPad','X13','i5','16GB','512GB','13 inch',1000,'supplier-asset','Test supplier',?,'2026-10-20')`)
        .run(id, `item-${id}`, `SN-${id}`, status);
    }
    addMachine('success');
    addMachine('rollback');
    addMachine('sold', 'sold');
    addMachine('reserved');
    db.prepare(`INSERT INTO warehouses(id,code,name) VALUES ('warehouse-secondary','SECONDARY','Secondary')`).run();
    db.prepare(`INSERT INTO transfers(id,transferNo,sourceWarehouseId,targetWarehouseId,status,createdBy)
      VALUES ('transfer-asset','TR-ASSET','warehouse_main','warehouse-secondary','pending',?)`).run(adminId);
    db.prepare(`INSERT INTO transfer_items(id,transferId,inventoryId,sn)
      VALUES ('transfer-item-asset','transfer-asset','reserved','SN-reserved')`).run();
    async function post(body, expectedStatus) {
      const response = await route.POST(new NextRequest('http://localhost/api/inventory/asset-change', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      }));
      const payload = await response.json();
      assert.equal(response.status, expectedStatus, JSON.stringify(payload));
      return payload;
    }
    const base = { expectedRam: '16GB', expectedStorage: '512GB', ram: '32GB', storage: '1TB' };
    sessionToken = undefined;
    assert.equal((await post({ inventoryId: 'success', ...base }, 401)).error.code, 'UNAUTHORIZED');
    db.prepare("INSERT INTO users(id,username,password,role,status) VALUES ('manager-asset','manager-asset','unused','warehouse_manager','active')").run();
    db.prepare("INSERT INTO user_warehouses(userId,warehouseId) VALUES ('manager-asset','warehouse_main')").run();
    sessionToken = auth.createSession('manager-asset');
    assert.equal((await post({ inventoryId: 'success', ...base }, 403)).error.code, 'FORBIDDEN');
    sessionToken = auth.createSession(adminId);
    for (const body of [
      { inventoryId: 'success', ...base, expectedRam: '8GB' },
      { inventoryId: 'success', ...base, ram: '16GB', storage: '512GB' },
      { inventoryId: 'sold', ...base },
      { inventoryId: 'reserved', ...base },
      { inventoryId: 'success', ...base, ram: '' },
    ]) await post(body, 400);
    assert.deepEqual(db.prepare("SELECT ram,storage,purchasePrice FROM inventory WHERE id = 'success'").get(),
      { ram: '16GB', storage: '512GB', purchasePrice: 1000 });

    db.exec(`CREATE TRIGGER reject_asset_movement BEFORE INSERT ON inventory_movements
      WHEN NEW.inventoryId = 'rollback' AND NEW.movementType = 'asset_change'
      BEGIN SELECT RAISE(ABORT, 'forced movement failure'); END`);
    await post({ inventoryId: 'rollback', ...base }, 400);
    assert.deepEqual(db.prepare("SELECT ram,storage FROM inventory WHERE id = 'rollback'").get(),
      { ram: '16GB', storage: '512GB' });
    assert.equal(db.prepare("SELECT COUNT(*) AS total FROM inventory_movements WHERE inventoryId = 'rollback'").get().total, 0);

    const skuBefore = db.prepare("SELECT ramOptions,storageOptions FROM skus WHERE id = 'sku-asset'").get();
    const changed = await post({ inventoryId: 'success', ...base }, 200);
    assert.equal(changed.data.ram, '32GB');
    assert.equal(changed.data.storage, '1TB');
    assert.deepEqual(db.prepare("SELECT ram,storage,purchasePrice,status FROM inventory WHERE id = 'success'").get(),
      { ram: '32GB', storage: '1TB', purchasePrice: 1000, status: 'in_stock' });
    assert.deepEqual(db.prepare("SELECT ramOptions,storageOptions FROM skus WHERE id = 'sku-asset'").get(), skuBefore);
    assert.deepEqual(db.prepare("SELECT ram,storage FROM purchase_items WHERE id = 'item-success'").get(),
      { ram: '16GB', storage: '512GB' });
    const movement = db.prepare("SELECT movementType,referenceType,referenceId,actorId,snapshot FROM inventory_movements WHERE inventoryId = 'success'").get();
    assert.deepEqual({ movementType: movement.movementType, referenceType: movement.referenceType, referenceId: movement.referenceId, actorId: movement.actorId },
      { movementType: 'asset_change', referenceType: 'inventory', referenceId: 'success', actorId: adminId });
    assert.deepEqual(JSON.parse(movement.snapshot), {
      before: { ram: '16GB', storage: '512GB' }, after: { ram: '32GB', storage: '1TB' },
    });
    assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
    console.log('PASS inventory asset change: authorization, eligibility, stale edit, rollback, single-machine audit');
  } finally {
    if (db?.open) db.close();
    if (previousPath === undefined) delete process.env.INVENTORY_DB_PATH;
    else process.env.INVENTORY_DB_PATH = previousPath;
    assert(scratch.startsWith(`${scratchParent}${path.sep}inventory-asset-change-`));
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
