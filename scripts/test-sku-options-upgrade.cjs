/** Real CLI upgrade regression. Creates and removes isolated file databases only. */
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const { initDatabase, seedDatabase } = require('./database.cjs');

const root = path.resolve(__dirname, '..');
const scratchParent = path.join(root, '.tmp');
fs.mkdirSync(scratchParent, { recursive: true });
const scratch = fs.mkdtempSync(path.join(scratchParent, 'sku-options-upgrade-'));
const stamp = '2026-10-01 09:00:00';

function quoteIdentifier(name) {
  return `"${name.replace(/"/g, '""')}"`;
}

function insert(db, table, values) {
  const keys = Object.keys(values);
  db.prepare(`INSERT INTO ${quoteIdentifier(table)} (${keys.map(quoteIdentifier).join(',')}) VALUES (${keys.map(() => '?').join(',')})`)
    .run(...keys.map((key) => values[key]));
}

function tableRows(db, table) {
  return db.prepare(`SELECT * FROM ${quoteIdentifier(table)}`).all()
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}

function businessSnapshot(db) {
  return Object.fromEntries(db.prepare(`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
      AND name NOT IN ('skus', 'schema_migrations')
    ORDER BY name
  `).all().map(({ name }) => [name, tableRows(db, name)]));
}

function protectedSkuColumns(db) {
  return tableRows(db, 'skus').map((row) => Object.fromEntries(
    Object.entries(row).filter(([key]) => !['cpuOptions', 'gpuOptions', 'screenOptions', 'updatedAt'].includes(key))
  ));
}

function runCli(databasePath, expectSuccess = true) {
  assert(databasePath.startsWith(`${scratch}${path.sep}`), 'CLI must use this test\'s isolated database');
  const result = spawnSync(process.execPath, [path.join(__dirname, 'init-db.js')], {
    cwd: root,
    env: { ...process.env, INVENTORY_DB_PATH: databasePath, INVENTORY_TEST_MODE: '1' },
    encoding: 'utf8',
    timeout: 20000,
    maxBuffer: 1024 * 1024,
  });
  assert.ifError(result.error);
  const output = `${result.stdout}\n${result.stderr}`;
  if (expectSuccess) assert.equal(result.status, 0, output);
  else {
    assert.notEqual(result.status, 0, 'injected update failure must fail CLI initialization');
    assert.match(output, /SKU_UPGRADE_TEST_FAILURE/);
  }
  return output;
}

function fixture(databasePath) {
  const db = new Database(databasePath);
  try {
    db.pragma('foreign_keys = ON');
    initDatabase(db);
    seedDatabase(db);
    const actor = db.prepare("SELECT id FROM users WHERE username = 'admin'").get().id;
    const skuBase = {
      productType: '笔记本电脑', brand: 'ThinkPad', model: 'X13', year: 2020,
      cpuOptions: JSON.stringify(['I5-10210U']), ramOptions: JSON.stringify(['16GB', '32GB']),
      gpuOptions: JSON.stringify(['集显']), storageOptions: JSON.stringify(['512GB', '1TB']),
      screenOptions: JSON.stringify(['2.5K']), priceMin: 1234.5, priceMax: 4321.5,
      createdBy: actor, createdAt: stamp, updatedAt: stamp,
    };
    insert(db, 'skus', {
      ...skuBase, id: 'legacy-options', model: 'X13 Legacy',
      cpuOptions: JSON.stringify(['Intel Core i7-12700H', 'i7-12700H']),
      gpuOptions: JSON.stringify(['独立显卡 NVIDIA GeForce RTX 3060 6GB 笔记本电脑 GPU', 'Intel UHD Graphics 620']),
      screenOptions: JSON.stringify(['16英寸 2560x1600 165Hz 100%sRGB 500nits', '1920x1200', '1366x768']),
    });
    insert(db, 'skus', { ...skuBase, id: 'already-short', model: 'X13 Short', screenOptions: JSON.stringify(['FHD+', 'HD']) });
    insert(db, 'skus', { ...skuBase, id: 'null-options', model: 'X13 Null', cpuOptions: null, gpuOptions: null, screenOptions: null });
    insert(db, 'skus', { ...skuBase, id: 'mixed-options', model: 'X13 Mixed',
      cpuOptions: JSON.stringify(['Intel Core i5-10210U', 17, null]),
      gpuOptions: JSON.stringify(['RTX 4060 8GB 笔记本电脑 GPU']), screenOptions: '{malformed-json',
    });
    insert(db, 'skus', { ...skuBase, id: 'invalid-options', model: 'X13 Invalid',
      cpuOptions: 'not-json', gpuOptions: JSON.stringify({ vendor: 'keep original' }), screenOptions: 'not-json',
    });
    insert(db, 'skus', { ...skuBase, id: 'unknown-screen', model: 'X13 Unknown', screenOptions: JSON.stringify(['屏幕规格待人工核验']) });
    insert(db, 'skus', { ...skuBase, id: 'empty-options', model: 'X13 Empty', cpuOptions: '', gpuOptions: '', screenOptions: '' });
    insert(db, 'suppliers', { id: 'supplier-upgrade', supplierName: '升级测试供应商', createdBy: actor, createdAt: stamp, updatedAt: stamp });
    insert(db, 'purchase_orders', {
      id: 'purchase-upgrade', purchaseNo: 'CG-UPGRADE', supplierOrderNo: 'PLATFORM-PURCHASE-001',
      supplierId: 'supplier-upgrade', supplierName: '升级测试供应商', purchaseDate: '2026-10-01',
      purchasedBy: actor, createdBy: actor, totalAmount: 2000, totalQuantity: 1, isInbounded: 1,
      createdAt: stamp, updatedAt: stamp,
    });
    const machine = { productType: '笔记本电脑', brand: 'ThinkPad', model: 'X13', year: 2020,
      cpu: 'Intel Core i5-10210U', ram: '16GB', gpu: 'Intel UHD Graphics 620', storage: '512GB',
      screen: '13.3英寸 1920x1080 60Hz', sn: 'UPGRADE-SN-0001', purchasePrice: 2000 };
    insert(db, 'purchase_items', { ...machine, id: 'purchase-item-upgrade', purchaseOrderId: 'purchase-upgrade', createdAt: stamp });
    insert(db, 'inventory', {
      ...machine, id: 'inventory-upgrade', purchaseOrderId: 'purchase-upgrade', purchaseItemId: 'purchase-item-upgrade',
      warehouseId: 'warehouse_main', supplierId: 'supplier-upgrade', supplierName: '升级测试供应商',
      status: 'sold', inboundDate: '2026-10-01', soldDate: '2026-10-02', sellingPrice: 2600,
      saleChannel: '升级测试平台', saleOrderNo: 'PLATFORM-SALE-001', profit: 600, createdAt: stamp, updatedAt: stamp,
    });
    const saleSnapshot = JSON.stringify({ ...machine, inventoryId: 'inventory-upgrade', warehouseId: 'warehouse_main', sellingPrice: 2600, profit: 600 });
    insert(db, 'sales_records', {
      id: 'sale-upgrade', recordNo: 'XS-UPGRADE', saleChannel: '升级测试平台', saleOrderNo: 'PLATFORM-SALE-001',
      saleDate: '2026-10-02', items: `[${saleSnapshot}]`, totalQuantity: 1, totalCost: 2000,
      totalAmount: 2600, totalProfit: 600, createdBy: actor, createdAt: stamp,
    });
    insert(db, 'sales_record_items', {
      id: 'sale-item-upgrade', salesRecordId: 'sale-upgrade', saleRecordId: 'sale-upgrade',
      inventoryId: 'inventory-upgrade', sn: machine.sn, purchasePrice: 2000, sellingPrice: 2600, profit: 600,
      warehouseId: 'warehouse_main', snapshot: saleSnapshot, createdAt: stamp,
    });
    insert(db, 'inventory_movements', {
      id: 'movement-upgrade', inventoryId: 'inventory-upgrade', warehouseId: 'warehouse_main',
      movementType: 'sale', referenceType: 'sales_record', referenceId: 'sale-upgrade', actorId: actor,
      note: '旧销售生命周期快照不得被格式迁移改写', snapshot: saleSnapshot, createdAt: stamp,
    });
    db.prepare('DELETE FROM schema_migrations WHERE version = 10').run();
  } finally {
    db.close();
  }
}

function readDatabase(databasePath, operation) {
  const db = new Database(databasePath, { readonly: true, fileMustExist: true });
  try { return operation(db); }
  finally { db.close(); }
}

try {
  const upgradePath = path.join(scratch, 'existing.db');
  fixture(upgradePath);
  const baseline = readDatabase(upgradePath, (db) => ({ business: businessSnapshot(db), protected: protectedSkuColumns(db), skus: tableRows(db, 'skus') }));
  assert.equal(baseline.business.inventory.length, 1);
  assert.equal(baseline.business.sales_records.length, 1);
  assert.equal(baseline.business.sales_record_items.length, 1);
  runCli(upgradePath);
  const firstUpgrade = readDatabase(upgradePath, (db) => {
    assert.deepEqual(businessSnapshot(db), baseline.business, 'every non-SKU business table must retain all rows and values');
    assert.deepEqual(protectedSkuColumns(db), baseline.protected, 'SKU identity, prices, RAM, disk, actor and timestamps must be preserved');
    const rows = tableRows(db, 'skus');
    const byId = Object.fromEntries(rows.map((row) => [row.id, row]));
    const oldById = Object.fromEntries(baseline.skus.map((row) => [row.id, row]));
    assert.deepEqual(JSON.parse(byId['legacy-options'].cpuOptions), ['I7-12700H']);
    assert.deepEqual(JSON.parse(byId['legacy-options'].gpuOptions), ['RTX 3060', '集显']);
    assert.deepEqual(JSON.parse(byId['legacy-options'].screenOptions), ['2.5K', 'FHD+', 'HD']);
    assert.deepEqual(byId['already-short'], oldById['already-short'], 'short screen labels must not degrade or change timestamps');
    assert.deepEqual(byId['null-options'], oldById['null-options']);
    assert.deepEqual(byId['invalid-options'], oldById['invalid-options']);
    assert.deepEqual(byId['unknown-screen'], oldById['unknown-screen']);
    assert.deepEqual(byId['empty-options'], oldById['empty-options']);
    assert.equal(byId['mixed-options'].cpuOptions, oldById['mixed-options'].cpuOptions, 'mixed JSON must be preserved verbatim');
    assert.equal(byId['mixed-options'].screenOptions, oldById['mixed-options'].screenOptions, 'malformed JSON must be preserved verbatim');
    assert.deepEqual(JSON.parse(byId['mixed-options'].gpuOptions), ['RTX 4060'], 'valid fields must upgrade even if another field is malformed');
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 10').get().count, 1);
    assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
    assert.equal(db.pragma('foreign_key_check').length, 0);
    return rows;
  });
  runCli(upgradePath);
  readDatabase(upgradePath, (db) => {
    assert.deepEqual(tableRows(db, 'skus'), firstUpgrade, 'second CLI run must retain all SKU fields and timestamps');
    assert.deepEqual(businessSnapshot(db), baseline.business);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 10').get().count, 1);
  });

  const rollbackPath = path.join(scratch, 'rollback.db');
  fixture(rollbackPath);
  const faultDb = new Database(rollbackPath);
  faultDb.exec(`
    CREATE TABLE sku_upgrade_test_probe(id TEXT);
    CREATE TRIGGER sku_upgrade_test_abort BEFORE UPDATE ON skus
      WHEN EXISTS (SELECT 1 FROM sku_upgrade_test_probe)
      BEGIN SELECT RAISE(ABORT, 'SKU_UPGRADE_TEST_FAILURE'); END;
    CREATE TRIGGER sku_upgrade_test_probe_update AFTER UPDATE ON skus
      BEGIN INSERT INTO sku_upgrade_test_probe(id) VALUES (NEW.id); END;
  `);
  const beforeFailure = { business: businessSnapshot(faultDb), skus: tableRows(faultDb, 'skus'), migrations: tableRows(faultDb, 'schema_migrations') };
  faultDb.close();
  runCli(rollbackPath, false);
  readDatabase(rollbackPath, (db) => {
    assert.deepEqual(tableRows(db, 'skus'), beforeFailure.skus, 'failure after the first SKU write must roll back every SKU update');
    assert.deepEqual(tableRows(db, 'schema_migrations'), beforeFailure.migrations, 'failed migration must not be marked as applied');
    assert.deepEqual(businessSnapshot(db), beforeFailure.business, 'failed transaction must also roll back trigger writes');
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 10').get().count, 0);
    assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
  });
  console.log('SKU options upgrade: real CLI twice, complete business snapshots retained, malformed fields retained, FHD+/HD preserved, transactional rollback verified.');
} finally {
  const resolvedScratch = path.resolve(scratch);
  assert(resolvedScratch.startsWith(`${path.resolve(scratchParent)}${path.sep}sku-options-upgrade-`));
  fs.rmSync(resolvedScratch, { recursive: true, force: true });
}
