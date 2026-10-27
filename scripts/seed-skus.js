const Database = require('better-sqlite3');
const fs = require('node:fs');
const path = require('node:path');
const { initDatabase, seedDatabase } = require('./database.cjs');
const { seedBuiltinSkus } = require('./builtin-sku-seed.cjs');

const databasePath = process.env.INVENTORY_DB_PATH || path.join(__dirname, '..', 'data', 'inventory.db');
fs.mkdirSync(path.dirname(databasePath), { recursive: true });
const db = new Database(databasePath);

try {
  initDatabase(db);
  const inserted = seedBuiltinSkus(db);
  seedDatabase(db);
  const count = db.prepare('SELECT COUNT(*) AS count FROM skus WHERE deleted = 0').get().count;
  console.log(inserted ? `已加载 ${inserted} 条内置 SKU。` : `数据库已有 SKU 目录，未覆盖；当前 ${count} 条。`);
} finally {
  db.close();
}
