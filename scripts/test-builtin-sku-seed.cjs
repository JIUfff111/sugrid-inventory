const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const catalog = require('./sku-catalog/builtin-sku-catalog.json');
const { initDatabase } = require('./database.cjs');
const { seedBuiltinSkus } = require('./builtin-sku-seed.cjs');
const { formatCPUDisplay, formatGPUDisplay, formatScreenDisplay } = require('./sku-catalog/normalize-options.cjs');

function createDatabase() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  initDatabase(db);
  return db;
}

const fresh = createDatabase();
try {
  assert.equal(formatCPUDisplay('AMD 锐龙 5 5600H'), 'R5-5600H');
  assert.equal(formatGPUDisplay('RTX 3060 6GB 笔记本电脑 GPU'), 'RTX 3060');
  assert.equal(formatScreenDisplay('16英寸 2560x1600 165Hz 100%sRGB 500nits'), '2.5K');
  for (const screen of ['HD', 'FHD', 'FHD+', '2K', '2.5K', '2.8K', '3K', '3.2K', '4K']) {
    assert.equal(formatScreenDisplay(screen), screen, `already normalized screen ${screen} must be stable`);
  }
  assert.equal(catalog.skus.some((sku) => (sku.cpuOptions || []).some((value) => /^(?:Intel|英特尔|AMD|锐龙|Ryzen|Core|酷睿)\b/i.test(value))), false);
  assert.equal(catalog.skus.some((sku) => (sku.gpuOptions || []).some((value) => /笔记本电脑 GPU|\d+GB/i.test(value))), false);
  assert.equal(catalog.skus.some((sku) => (sku.screenOptions || []).some((value) => /英寸|Hz|nits|sRGB|x\d/i.test(value))), false);
  const inserted = seedBuiltinSkus(fresh);
  assert.equal(inserted, catalog.skus.length);
  assert.equal(fresh.prepare('SELECT COUNT(*) AS count FROM skus WHERE deleted = 0').get().count, catalog.skus.length);
  assert.equal(seedBuiltinSkus(fresh), 0, 'repeated seeding must be a no-op');
  assert.equal(fresh.prepare('SELECT COUNT(*) AS count FROM skus').get().count, catalog.skus.length);
  const first = fresh.prepare('SELECT id, createdBy, priceMin, priceMax FROM skus ORDER BY brand, model LIMIT 1').get();
  assert.match(first.id, /^builtin_sku_[a-f0-9]{24}$/);
  assert.equal(first.createdBy, null);
  assert.equal(first.priceMin, null);
  assert.equal(first.priceMax, null);
} finally {
  fresh.close();
}

const existing = createDatabase();
try {
  existing.prepare(`INSERT INTO skus(id,productType,brand,model) VALUES ('existing','笔记本电脑','测试品牌','已有型号')`).run();
  const original = existing.prepare('SELECT * FROM skus WHERE id = ?').get('existing');
  assert.equal(seedBuiltinSkus(existing), 0, 'existing catalogs must not be merged or overwritten');
  assert.equal(existing.prepare('SELECT COUNT(*) AS count FROM skus').get().count, 1);
  assert.deepEqual(existing.prepare('SELECT * FROM skus WHERE id = ?').get('existing'), original);
} finally {
  existing.close();
}

const migrationDb = createDatabase();
try {
  migrationDb.prepare(`
    INSERT INTO skus(id, productType, brand, model, cpuOptions, gpuOptions, screenOptions)
    VALUES ('legacy-options', '笔记本电脑', '测试品牌', '旧型号', ?, ?, ?)
  `).run(
    JSON.stringify(['Intel Core i7-12700H']),
    JSON.stringify(['独立显卡 NVIDIA GeForce RTX 3060 6GB 笔记本电脑 GPU', '集成显卡']),
    JSON.stringify(['16英寸 2560x1600 165Hz 100%sRGB 500nits'])
  );
  migrationDb.prepare(`
    INSERT INTO skus(id, productType, brand, model, cpuOptions, gpuOptions, screenOptions)
    VALUES ('mixed-options', '笔记本电脑', '测试品牌', '异常字段', ?, ?, ?)
  `).run('["I5-10210U",17]', '[broken', JSON.stringify(['FHD+', 'HD', '厂商特殊屏幕（未提供分辨率）']));
  migrationDb.prepare('DELETE FROM schema_migrations WHERE version = 10').run();
  initDatabase(migrationDb);
  const migrated = migrationDb.prepare('SELECT cpuOptions, gpuOptions, screenOptions FROM skus WHERE id = ?').get('legacy-options');
  assert.deepEqual(JSON.parse(migrated.cpuOptions), ['I7-12700H']);
  assert.deepEqual(JSON.parse(migrated.gpuOptions), ['RTX 3060', '集显']);
  assert.deepEqual(JSON.parse(migrated.screenOptions), ['2.5K']);
  const mixed = migrationDb.prepare('SELECT cpuOptions, gpuOptions, screenOptions FROM skus WHERE id = ?').get('mixed-options');
  assert.equal(mixed.cpuOptions, '["I5-10210U",17]', 'mixed JSON array must remain intact');
  assert.equal(mixed.gpuOptions, '[broken', 'malformed JSON must remain intact');
  assert.deepEqual(JSON.parse(mixed.screenOptions), ['FHD+', 'HD', '厂商特殊屏幕（未提供分辨率）']);
  migrationDb.prepare('DELETE FROM schema_migrations WHERE version = 10').run();
  initDatabase(migrationDb);
  const rerun = migrationDb.prepare('SELECT cpuOptions, gpuOptions, screenOptions FROM skus WHERE id = ?').get('legacy-options');
  assert.deepEqual(rerun, migrated, 'option migration must be idempotent');
  assert.deepEqual(migrationDb.prepare('SELECT cpuOptions, gpuOptions, screenOptions FROM skus WHERE id = ?').get('mixed-options'), mixed);
} finally {
  migrationDb.close();
}

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sugrid-sku-seed-'));
const dbPath = path.join(tempDir, 'clone-check.db');
try {
  const initEnv = { ...process.env, INVENTORY_DB_PATH: dbPath };
  const firstInit = execFileSync(process.execPath, [path.join(__dirname, 'init-db.js')], { env: initEnv, encoding: 'utf8' });
  assert.match(firstInit, new RegExp(`已加载 ${catalog.skus.length} 条内置 SKU`));
  const secondInit = execFileSync(process.execPath, [path.join(__dirname, 'init-db.js')], { env: initEnv, encoding: 'utf8' });
  assert.doesNotMatch(secondInit, /已加载 \d+ 条内置 SKU/);
  const db = new Database(dbPath, { readonly: true });
  try {
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM skus WHERE deleted = 0').get().count, catalog.skus.length);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM users').get().count, 1);
  } finally {
    db.close();
  }
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}

console.log(`Built-in SKU seed test passed (${catalog.skus.length} entries; fresh file DB; idempotent; existing catalogs preserved).`);
