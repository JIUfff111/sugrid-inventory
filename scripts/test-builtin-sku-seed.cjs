const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { execFileSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const catalog = require('./sku-catalog/builtin-sku-catalog.json');
const supplement = require('../docs/sku-catalog/03-supplements/config-variants-2026-11-01/research/sku-variants.json');
const { initDatabase } = require('./database.cjs');
const { seedBuiltinSkus, syncBuiltinSkuCatalog } = require('./builtin-sku-seed.cjs');
const { formatCPUDisplay, formatGPUDisplay, formatScreenDisplay } = require('./sku-catalog/normalize-options.cjs');
const { canonicalBrand, canonicalModel, findMatch } = require('./sku-catalog/merge-config-variants.cjs');
const { canonicalModelName } = require('./sku-catalog/config-variant-aliases.cjs');

function createDatabase() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  initDatabase(db);
  return db;
}

const expectedRamOptions = ['8GB', '16GB', '24GB', '32GB'];
const fresh = createDatabase();
try {
  assert.equal(formatCPUDisplay('AMD 锐龙 5 5600H'), 'R5-5600H');
  assert.equal(formatCPUDisplay('Intel Core 5 220H'), 'Core 5 220H');
  assert.equal(formatCPUDisplay('5 220H'), 'Core 5 220H');
  assert.equal(formatGPUDisplay('RTX 3060 6GB 笔记本电脑 GPU'), 'RTX 3060');
  assert.equal(formatScreenDisplay('16英寸 2560x1600 165Hz 100%sRGB 500nits'), '2.5K');
  assert.equal(formatScreenDisplay('1k'), '1k');
  for (const screen of ['HD', 'FHD', 'FHD+', '2K', '2.5K', '2.8K', '3K', '3.2K', '4K']) {
    assert.equal(formatScreenDisplay(screen), screen, `already normalized screen ${screen} must be stable`);
  }
  assert.equal(catalog.skus.some((sku) => (sku.cpuOptions || []).some((value) => /^(?:Intel|英特尔|AMD|锐龙|Ryzen|酷睿)\b/i.test(value))), false);
  assert.equal(catalog.skus.some((sku) => (sku.gpuOptions || []).some((value) => /笔记本电脑 GPU|\d+GB/i.test(value))), false);
  assert.equal(catalog.skus.some((sku) => (sku.screenOptions || []).some((value) => /英寸|Hz|nits|sRGB|x\d/i.test(value))), false);
  assert.equal(catalog.skus.length, 977);
  assert.equal(catalog.skus.some((sku) => sku.brand === '红米'), false);
  assert.equal(catalog.skus.some((sku) => sku.year && String(sku.model).includes(String(sku.year))), false,
    'the model field must not repeat the separate model year');
  assert.equal(new Set(catalog.skus.map((sku) => JSON.stringify([sku.productType, sku.brand, sku.model, sku.year]))).size,
    catalog.skus.length, 'built-in model identities must be unique');
  for (const [model, year] of [
    ['Redmi Book Pro 14 酷睿版', 2022],
    ['Xiaomi Book Pro 14', 2022],
    ['Xiaomi Book Pro 16', 2022],
    ['Xiaomi Book S 12.4', 2022],
  ]) {
    assert.equal(catalog.skus.filter((sku) => sku.brand === '小米' && sku.model === model && sku.year === year).length, 1);
  }
  assert.equal(catalog.skus.some((sku) => sku.model.includes('Ult..')), false, 'truncated model names must be repaired');
  assert.equal(catalog.skus.find((sku) => sku.model === 'Redmi Book 14' && sku.year === 2025).cpuOptions.includes('Core 5 220H'), true);
  const newRedmi14 = catalog.skus.find((sku) => sku.brand === '小米' && sku.model === 'RedmiBook 14 锐龙版' && sku.year === 2025);
  const newRedmi16 = catalog.skus.find((sku) => sku.brand === '小米' && sku.model === 'RedmiBook 16 锐龙版' && sku.year === 2025);
  assert.deepEqual(newRedmi14.cpuOptions, ['R5-7535H', 'R7-7735H']);
  assert.deepEqual(newRedmi14.gpuOptions, ['集显']);
  assert.deepEqual(newRedmi14.screenOptions, ['FHD+']);
  assert.deepEqual(newRedmi16.screenOptions, ['规格待核实'], 'estimated Redmi Book 16 screen must remain unconfirmed');
  assert.equal(newRedmi14.storageOptions.includes('512GB SSD'), true);
  assert.deepEqual(catalog.skus.find((sku) => sku.brand === 'ThinkPad' && sku.model === 'T14 Gen 1 (AMD)' && sku.year === 2020).screenOptions,
    ['FHD', 'HD']);
  const r14Intel = catalog.skus.find((sku) => sku.brand === 'ThinkPad' && sku.model === 'R14 Gen 2 (Intel)' && sku.year === 2021);
  assert.deepEqual(r14Intel.cpuOptions, ['I5-1135G7']);
  assert.deepEqual(r14Intel.gpuOptions, ['集显', 'MX350']);
  assert.equal(catalog.skus.some((sku) => sku.brand === 'ThinkPad' && sku.model === 'R14 Gen 2 (AMD)'), false,
    'AMD model must await a sourced model year and retail configuration');
  assert.equal(catalog.skus.some((sku) => sku.brand === 'ThinkPad' && sku.model === 'R14 Gen 4'), false,
    'Gen 4 model must await an independent second source');
  assert.equal(catalog.skus.find((sku) => sku.brand === 'ThinkPad' && sku.model === 'X1 Carbon Gen9' && sku.year === 2021).screenOptions.includes('FHD+'), true);
  assert.equal(catalog.skus.find((sku) => sku.brand === '小米' && sku.model === 'Xiaomi Book Pro 14 锐龙版' && sku.year === 2022).screenOptions.includes('2.8K'), true);
  assert.equal(catalog.skus.find((sku) => sku.brand === '小米' && sku.model === 'Redmi Book Pro 14 酷睿版' && sku.year === 2022).cpuOptions.includes('I5-12500H'), true);
  assert.equal(supplement.models.length, 89);
  assert.equal(supplement.combos.length, 412);
  assert.equal(new Set(supplement.combos.map((combo) => combo.modelKey)).size, 87);
  assert.deepEqual(supplement.combos.reduce((counts, combo) => {
    counts[combo.confidence] = (counts[combo.confidence] || 0) + 1;
    return counts;
  }, {}), { high: 211, medium: 166, low: 35 }, 'low-confidence source-backed combinations must remain available');
  assert.equal(supplement.combos.every((combo) => /^https?:\/\//i.test(combo.sourceUrl)), true);
  for (const model of supplement.models) {
    const normalized = {
      ...model,
      brand: canonicalBrand(model.brand),
      model: canonicalModelName(canonicalModel(model.model), model.modelYear),
      year: model.modelYear,
    };
    assert.ok(findMatch(normalized, catalog), `supplement model must resolve without duplication: ${model.model} ${model.modelYear}`);
  }
  assert.equal(catalog.skus.every((sku) => JSON.stringify(sku.ramOptions) === JSON.stringify(expectedRamOptions)), true,
    'all built-in products must offer the standardized RAM choices');
  const inserted = seedBuiltinSkus(fresh);
  assert.equal(inserted, catalog.skus.length);
  assert.equal(fresh.prepare('SELECT COUNT(*) AS count FROM skus WHERE deleted = 0').get().count, catalog.skus.length);
  assert.equal(seedBuiltinSkus(fresh), 0, 'repeated seeding must be a no-op');
  assert.equal(fresh.prepare('SELECT COUNT(*) AS count FROM skus').get().count, catalog.skus.length);
  assert.equal(fresh.prepare('SELECT COUNT(*) AS count FROM skus WHERE ramOptions = ?')
    .get(JSON.stringify(expectedRamOptions)).count, catalog.skus.length);
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

const r14Upgrade = createDatabase();
try {
  r14Upgrade.prepare(`INSERT INTO users(id,username,password,role,status)
    VALUES ('local-user', 'local-r14-editor', 'test-only', 'admin', 'active')`).run();
  r14Upgrade.prepare(`INSERT INTO skus(id,productType,brand,model,year,cpuOptions,createdBy)
    VALUES ('local-r14', '笔记本电脑', 'ThinkPad', 'R14 Gen 4', 2022, '["LOCAL-CPU"]', 'local-user')`).run();
  r14Upgrade.prepare('DELETE FROM schema_migrations WHERE version = 21').run();
  initDatabase(r14Upgrade);
  assert.equal(r14Upgrade.prepare('SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 21').get().count, 1);
  const localR14 = r14Upgrade.prepare('SELECT cpuOptions FROM skus WHERE id = ?').get('local-r14');
  assert.deepEqual(JSON.parse(localR14.cpuOptions), ['LOCAL-CPU'], 'migration must preserve a locally managed R14');
  assert.equal(r14Upgrade.prepare(`SELECT COUNT(*) AS count FROM skus WHERE brand = 'ThinkPad' AND model = 'R14 Gen 4' AND year = 2022`).get().count, 1);
  assert.equal(r14Upgrade.prepare(`SELECT COUNT(*) AS count FROM skus WHERE brand = 'ThinkPad' AND model = 'R14 Gen 2 (Intel)' AND year = 2021`).get().count, 1);
  assert.equal(r14Upgrade.prepare(`SELECT COUNT(*) AS count FROM skus WHERE brand = 'ThinkPad' AND model = 'R14 Gen 2 (AMD)'`).get().count, 0);
  const beforeRerun = r14Upgrade.prepare('SELECT COUNT(*) AS count FROM skus').get().count;
  initDatabase(r14Upgrade);
  assert.equal(r14Upgrade.prepare('SELECT COUNT(*) AS count FROM skus').get().count, beforeRerun,
    'migration 21 must be idempotent');
  assert.deepEqual(r14Upgrade.pragma('foreign_key_check'), []);
  assert.equal(r14Upgrade.pragma('integrity_check', { simple: true }), 'ok');
} finally {
  r14Upgrade.close();
}

const incrementalCatalogUpgrade = createDatabase();
try {
  const thinkpad = catalog.skus.find((sku) => sku.brand === 'ThinkPad' && sku.model === 'T14 Gen 1 (AMD)' && sku.year === 2020);
  incrementalCatalogUpgrade.prepare(`
    INSERT INTO skus(id, productType, brand, model, year, cpuOptions, ramOptions, gpuOptions, storageOptions, screenOptions)
    VALUES ('pre-v19-thinkpad', ?, ?, ?, ?, ?, ?, ?, ?, '[]')
  `).run(thinkpad.productType, thinkpad.brand, thinkpad.model, thinkpad.year,
    JSON.stringify(thinkpad.cpuOptions), JSON.stringify(thinkpad.ramOptions), JSON.stringify(thinkpad.gpuOptions),
    JSON.stringify(thinkpad.storageOptions));
  incrementalCatalogUpgrade.prepare('DELETE FROM schema_migrations WHERE version = 19').run();
  initDatabase(incrementalCatalogUpgrade);
  const upgradedThinkpad = incrementalCatalogUpgrade.prepare('SELECT screenOptions FROM skus WHERE id = ?').get('pre-v19-thinkpad');
  assert.deepEqual(JSON.parse(upgradedThinkpad.screenOptions), thinkpad.screenOptions,
    'migration 19 must merge the new screen options into databases already past migration 18');
  assert.equal(incrementalCatalogUpgrade.prepare(`
    SELECT COUNT(*) AS count FROM skus
    WHERE brand = '小米' AND model IN ('RedmiBook 14 锐龙版', 'RedmiBook 16 锐龙版') AND year = 2025
  `).get().count, 2);
  assert.deepEqual(incrementalCatalogUpgrade.pragma('foreign_key_check'), []);
  assert.equal(incrementalCatalogUpgrade.pragma('integrity_check', { simple: true }), 'ok');
  assert.deepEqual(syncBuiltinSkuCatalog(incrementalCatalogUpgrade), { inserted: 0, updated: 0, skipped: 0 },
    'migration 19 catalog updates must be idempotent');
} finally {
  incrementalCatalogUpgrade.close();
}

const catalogUpgrade = createDatabase();
try {
  const adminId = 'sku-catalog-test-admin';
  catalogUpgrade.prepare(`INSERT INTO users(id, username, password, role, status) VALUES (?, ?, 'test-only', 'admin', 'active')`)
    .run(adminId, 'sku-catalog-test-admin');
  const pro14 = catalog.skus.find((sku) => sku.brand === '小米' && sku.model === '小米笔记本 Pro 14' && sku.year === 2021);
  catalogUpgrade.prepare(`
    INSERT INTO skus(id, productType, brand, model, year, cpuOptions, ramOptions, gpuOptions, storageOptions, screenOptions)
    VALUES ('legacy-pro14', ?, ?, '小米笔记本 Pro 14 2021款', 2021, ?, ?, ?, ?, ?)
  `).run(pro14.productType, pro14.brand, JSON.stringify(['Intel Core i5-11300H']), JSON.stringify(['8GB']),
    JSON.stringify(['MX450 2GB']), JSON.stringify(['512GB SSD']), JSON.stringify(['1k']));
  const redmi14 = catalog.skus.find((sku) => sku.brand === '小米' && sku.model === 'Redmi Book 14' && sku.year === 2025);
  catalogUpgrade.prepare(`
    INSERT INTO skus(id, productType, brand, model, year, cpuOptions)
    VALUES ('legacy-redmi14', ?, ?, 'Redmi Book 14 2025', 2025, '["5 220H"]')
  `).run(redmi14.productType, redmi14.brand);
  const redmi16 = catalog.skus.find((sku) => sku.brand === '小米' && sku.model === 'Redmi Book Pro 16' && sku.year === 2025);
  catalogUpgrade.prepare(`
    INSERT INTO skus(id, productType, brand, model, year)
    VALUES ('legacy-redmi16', ?, ?, 'Redmi Book Pro 16 2025(Ult..', 2025)
  `).run(redmi16.productType, redmi16.brand);
  const userSku = catalog.skus.find((sku) => sku.brand === '小米' && sku.model === 'Xiaomi Book Pro 14' && sku.year === 2022);
  catalogUpgrade.prepare(`
    INSERT INTO skus(id, productType, brand, model, year, cpuOptions, createdBy)
    VALUES ('user-managed-sku', ?, ?, ?, ?, '["CUSTOM-CPU"]', ?)
  `).run(userSku.productType, userSku.brand, userSku.model, userSku.year, adminId);
  const deletedSku = catalog.skus.find((sku) => sku.brand === '小米' && sku.model === 'Xiaomi Book S 12.4' && sku.year === 2022);
  catalogUpgrade.prepare(`
    INSERT INTO skus(id, productType, brand, model, year, deleted)
    VALUES ('deleted-sku', ?, ?, ?, ?, 1)
  `).run(deletedSku.productType, deletedSku.brand, deletedSku.model, deletedSku.year);
  catalogUpgrade.prepare(`INSERT INTO skus(id, productType, brand, model) VALUES ('unrelated-manual-row', '笔记本电脑', '手工品牌', '本地型号')`).run();

  catalogUpgrade.prepare('DELETE FROM schema_migrations WHERE version = 18').run();
  initDatabase(catalogUpgrade);
  const renamed = catalogUpgrade.prepare('SELECT id, model, cpuOptions, gpuOptions, storageOptions, screenOptions FROM skus WHERE id = ?').get('legacy-pro14');
  assert.equal(renamed.id, 'legacy-pro14', 'identity repairs must keep existing foreign-key IDs stable');
  assert.equal(renamed.model, '小米笔记本 Pro 14');
  assert.deepEqual(JSON.parse(renamed.cpuOptions), pro14.cpuOptions);
  assert.equal(JSON.parse(renamed.gpuOptions).includes('MX450'), true);
  assert.equal(JSON.parse(renamed.storageOptions).includes('512GB SSD'), true);
  assert.equal(JSON.parse(renamed.screenOptions).includes('1k'), true, 'user-entered screen options must be preserved');
  const renamedRedmi14 = catalogUpgrade.prepare('SELECT id, model, cpuOptions FROM skus WHERE id = ?').get('legacy-redmi14');
  assert.equal(renamedRedmi14.model, 'Redmi Book 14');
  assert.deepEqual(JSON.parse(renamedRedmi14.cpuOptions), redmi14.cpuOptions);
  const renamedRedmi16 = catalogUpgrade.prepare('SELECT id, model, screenOptions FROM skus WHERE id = ?').get('legacy-redmi16');
  assert.equal(renamedRedmi16.model, 'Redmi Book Pro 16');
  assert.equal(JSON.parse(renamedRedmi16.screenOptions).includes('2.5K'), true);
  assert.equal(catalogUpgrade.prepare(`SELECT COUNT(*) AS count FROM skus WHERE productType=? AND brand=? AND model=? AND year=?`)
    .get(userSku.productType, userSku.brand, userSku.model, userSku.year).count, 1,
  'a user-managed identity must not be duplicated or overwritten');
  assert.equal(catalogUpgrade.prepare(`SELECT COUNT(*) AS count FROM skus WHERE productType=? AND brand=? AND model=? AND year=?`)
    .get(deletedSku.productType, deletedSku.brand, deletedSku.model, deletedSku.year).count, 1,
  'soft-deleted built-in SKU identities must not be re-created');
  assert.equal(catalogUpgrade.prepare('SELECT model FROM skus WHERE id = ?').get('unrelated-manual-row').model, '本地型号');
  assert.equal(catalogUpgrade.prepare('SELECT COUNT(*) AS count FROM skus WHERE deleted = 0').get().count, catalog.skus.length);
  assert.deepEqual(catalogUpgrade.pragma('foreign_key_check'), []);
  assert.equal(catalogUpgrade.pragma('integrity_check', { simple: true }), 'ok');
  assert.deepEqual(syncBuiltinSkuCatalog(catalogUpgrade), { inserted: 0, updated: 0, skipped: 2 },
    'the additive catalog migration must be idempotent');
} finally {
  catalogUpgrade.close();
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
  migrationDb.prepare(`
    INSERT INTO skus(id, productType, brand, model, ramOptions)
    VALUES ('builtin_sku_ram_migration', '笔记本电脑', '测试品牌', '内置旧型号', '["4GB"]')
  `).run();
  migrationDb.prepare(`
    INSERT INTO skus(id, productType, brand, model, ramOptions)
    VALUES ('builtin_sku_tablet_migration', '平板电脑', '测试品牌', '内置旧平板', '["6GB"]')
  `).run();
  migrationDb.prepare(`
    INSERT INTO skus(id, productType, brand, model, ramOptions)
    VALUES ('manual_sku_ram_migration', '笔记本电脑', '测试品牌', '手工型号', '["64GB"]')
  `).run();
  migrationDb.prepare('DELETE FROM schema_migrations WHERE version = 10').run();
  migrationDb.prepare('DELETE FROM schema_migrations WHERE version = 15').run();
  initDatabase(migrationDb);
  const migrated = migrationDb.prepare('SELECT cpuOptions, gpuOptions, screenOptions FROM skus WHERE id = ?').get('legacy-options');
  assert.deepEqual(JSON.parse(migrated.cpuOptions), ['I7-12700H']);
  assert.deepEqual(JSON.parse(migrated.gpuOptions), ['RTX 3060', '集显']);
  assert.deepEqual(JSON.parse(migrated.screenOptions), ['2.5K']);
  const mixed = migrationDb.prepare('SELECT cpuOptions, gpuOptions, screenOptions FROM skus WHERE id = ?').get('mixed-options');
  assert.equal(mixed.cpuOptions, '["I5-10210U",17]', 'mixed JSON array must remain intact');
  assert.equal(mixed.gpuOptions, '[broken', 'malformed JSON must remain intact');
  assert.deepEqual(JSON.parse(mixed.screenOptions), ['FHD+', 'HD', '厂商特殊屏幕（未提供分辨率）']);
  assert.equal(migrationDb.prepare('SELECT ramOptions FROM skus WHERE id = ?').get('builtin_sku_ram_migration').ramOptions,
    JSON.stringify(expectedRamOptions));
  assert.equal(migrationDb.prepare('SELECT ramOptions FROM skus WHERE id = ?').get('builtin_sku_tablet_migration').ramOptions,
    JSON.stringify(expectedRamOptions), 'built-in non-laptop SKU options must also be updated');
  assert.equal(migrationDb.prepare('SELECT ramOptions FROM skus WHERE id = ?').get('manual_sku_ram_migration').ramOptions,
    '["64GB"]', 'migration must preserve non-built-in SKU options');
  migrationDb.prepare('DELETE FROM schema_migrations WHERE version = 10').run();
  migrationDb.prepare('DELETE FROM schema_migrations WHERE version = 15').run();
  initDatabase(migrationDb);
  const rerun = migrationDb.prepare('SELECT cpuOptions, gpuOptions, screenOptions FROM skus WHERE id = ?').get('legacy-options');
  assert.deepEqual(rerun, migrated, 'option migration must be idempotent');
  assert.equal(migrationDb.prepare('SELECT ramOptions FROM skus WHERE id = ?').get('builtin_sku_ram_migration').ramOptions,
    JSON.stringify(expectedRamOptions), 'RAM migration must remain idempotent');
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

function runConcurrentMigration(dbPath) {
  const databaseModule = JSON.stringify(path.join(__dirname, 'database.cjs'));
  const source = `
    const Database = require('better-sqlite3');
    const { initDatabase, seedDatabase } = require(${databaseModule});
    const db = new Database(process.argv[1]);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.pragma('busy_timeout = 5000');
    initDatabase(db);
    seedDatabase(db);
    db.close();
  `;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', source, dbPath], { cwd: path.resolve(__dirname, '..') });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    child.once('error', reject);
    child.once('close', (code) => code === 0 ? resolve(output) : reject(new Error(output)));
  });
}

async function testConcurrentCatalogMigration() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sugrid-sku-migration-concurrency-'));
  const dbPath = path.join(tempDir, 'migration-check.db');
  const db = new Database(dbPath);
  try {
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.pragma('busy_timeout = 5000');
    initDatabase(db);
    seedBuiltinSkus(db);
    db.prepare(`
      UPDATE skus SET screenOptions = '[]'
      WHERE brand = 'ThinkPad' AND model = 'T14 Gen 1 (AMD)' AND year = 2020
    `).run();
    db.prepare('DELETE FROM schema_migrations WHERE version IN (18, 19)').run();
  } finally {
    db.close();
  }

  try {
    await Promise.all([runConcurrentMigration(dbPath), runConcurrentMigration(dbPath)]);
    const migratedDb = new Database(dbPath, { readonly: true });
    try {
      const screen = migratedDb.prepare(`
        SELECT screenOptions FROM skus
        WHERE brand = 'ThinkPad' AND model = 'T14 Gen 1 (AMD)' AND year = 2020
      `).get();
      assert.deepEqual(JSON.parse(screen.screenOptions), ['FHD', 'HD']);
      assert.equal(migratedDb.prepare('SELECT COUNT(*) AS count FROM schema_migrations WHERE version IN (18, 19)').get().count, 2);
      assert.equal(migratedDb.prepare('SELECT COUNT(*) AS count FROM users').get().count, 1);
      assert.deepEqual(migratedDb.pragma('foreign_key_check'), []);
      assert.equal(migratedDb.pragma('integrity_check', { simple: true }), 'ok');
    } finally {
      migratedDb.close();
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

testConcurrentCatalogMigration().then(() => {
  console.log(`Built-in SKU seed test passed (${catalog.skus.length} entries; fresh file DB; idempotent; existing catalogs preserved; concurrent migrations and initial seeding serialized).`);
}).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
