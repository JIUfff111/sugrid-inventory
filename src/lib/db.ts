import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
// The CLI and server share transactional schema migrations.
const schema = require('../../scripts/database.cjs') as { initDatabase: (db: Database.Database) => void; seedDatabase: (db: Database.Database) => void };
const dbPath = process.env.INVENTORY_DB_PATH || path.join(process.cwd(), 'data', 'inventory.db');
fs.mkdirSync(path.dirname(dbPath), { recursive: true });
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');
export function initDatabase() { schema.initDatabase(db); }
export function seedDatabase() { schema.seedDatabase(db); }
export function getDatabase() { return db; }
export function closeDatabase() { db.close(); }
initDatabase();
seedDatabase();
export default db;
