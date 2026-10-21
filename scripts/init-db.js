const Database = require('better-sqlite3');
const path = require('node:path');
const fs = require('node:fs');
const { initDatabase, seedDatabase } = require('./database.cjs');
const file = process.env.INVENTORY_DB_PATH || path.join(__dirname, '..', 'data', 'inventory.db');
fs.mkdirSync(path.dirname(file), { recursive: true });
const db = new Database(file);
db.pragma('foreign_keys = ON');
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000');
try { initDatabase(db); seedDatabase(db); console.log('数据库迁移完成'); } finally { db.close(); }
