const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const catalog = require('./sku-catalog/builtin-sku-catalog.json');
const { initDatabase } = require('./database.cjs');
const { seedBuiltinSkus } = require('./builtin-sku-seed.cjs');

function createDatabase() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  initDatabase(db);
  return db;
}

const fresh = createDatabase();
try {
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
