const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const Database = require('better-sqlite3');

const root = path.resolve(__dirname, '..');

function load(relative, overrides = {}) {
  const file = path.join(root, relative);
  const loaded = new Module(file, module);
  loaded.filename = file;
  loaded.paths = Module._nodeModulePaths(path.dirname(file));
  const standardRequire = loaded.require.bind(loaded);
  loaded.require = (name) => Object.hasOwn(overrides, name) ? overrides[name] : standardRequire(name);
  loaded._compile(ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: file,
  }).outputText, file);
  return loaded.exports;
}

function run() {
  const db = new Database(':memory:');
  try {
    db.exec(`
      CREATE TABLE inventory (
        id TEXT PRIMARY KEY,
        deleted INTEGER NOT NULL DEFAULT 0,
        sn TEXT NOT NULL,
        itemNumber TEXT,
        productType TEXT,
        brand TEXT,
        model TEXT,
        year TEXT,
        cpu TEXT,
        ram TEXT,
        storage TEXT,
        gpu TEXT,
        screen TEXT,
        supplierName TEXT,
        saleOrderNo TEXT,
        remark TEXT,
        skuRemark TEXT,
        status TEXT NOT NULL DEFAULT 'in_stock',
        touchScreen INTEGER
      );
      CREATE TABLE purchase_orders (id TEXT PRIMARY KEY, purchaseNo TEXT);
    `);
    db.prepare(`
      INSERT INTO inventory
        (id, sn, itemNumber, productType, brand, model, year, cpu, ram, storage, gpu, screen, supplierName, saleOrderNo, remark, skuRemark)
      VALUES
        ('machine-1', 'SN-001', 'ASSET-001', '笔记本电脑', 'ThinkPad', 'X13', '2026', 'i7', '32GB', '1TB', 'RTX 4060', '2.5K', '供应商甲', 'XS-001', '办公室备用', 'SKU 备注'),
        ('machine-2', 'SN-002', 'ASSET-002', '显卡', 'NVIDIA', 'RTX 4060', '2025', '自定义 CPU', '24GB', '2TB', 'RTX 4060', '无', '供应商乙', 'XS-002', '待检测', '显卡 SKU');
    `).run();
    db.prepare("INSERT INTO purchase_orders (id, purchaseNo) VALUES ('purchase-1', 'CG-001'), ('purchase-2', 'CG-002')").run();
    db.prepare("UPDATE inventory SET id = id").run();
    db.prepare("UPDATE inventory SET saleOrderNo = 'XS-001' WHERE id = 'machine-1'").run();

    const { getInventoryWhere } = load('src/lib/inventory-query.ts', {
      '@/lib/machine-scan': load('src/lib/machine-scan.ts'),
    });
    const find = (query) => {
      const { clause, params } = getInventoryWhere(new URLSearchParams(query));
      return db.prepare(`SELECT i.id FROM inventory i LEFT JOIN purchase_orders po ON po.id = CASE i.id WHEN 'machine-1' THEN 'purchase-1' ELSE 'purchase-2' END ${clause} ORDER BY i.id`).all(...params).map(row => row.id);
    };

    assert.deepEqual(find('search=ThinkPad&searchMode=machine'), [], 'identity search excludes brand');
    assert.deepEqual(find('search=X13&searchMode=machine'), [], 'identity search excludes model');
    assert.deepEqual(find('search=SN-001&searchMode=machine'), ['machine-1'], 'identity search matches SN');
    assert.deepEqual(find('search=ASSET-002&searchMode=machine'), ['machine-2'], 'identity search matches item number');
    assert.deepEqual(find('configSearch=ThinkPad'), ['machine-1'], 'description search matches brand');
    assert.deepEqual(find('configSearch=X13'), ['machine-1'], 'description search matches model');
    assert.deepEqual(find('configSearch=RTX%204060'), ['machine-1', 'machine-2'], 'description search matches GPU/model text');
    assert.deepEqual(find('configSearch=待检测'), ['machine-2'], 'description search matches machine remark');
    assert.deepEqual(find('configSearch=CG-001'), ['machine-1'], 'description search matches purchase number');
    assert.deepEqual(find('search=SN-001&searchMode=machine&configSearch=ThinkPad'), ['machine-1'], 'identity and description searches compose');
    assert.deepEqual(find('search=SN-001&searchMode=machine&configSearch=NVIDIA'), [], 'identity and description searches narrow results');
    assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
    assert.equal(db.pragma('foreign_key_check').length, 0);
    console.log('PASS inventory search split: identity search is SN/item number only; description search covers brand, model, configuration, remarks and order references');
  } finally {
    db.close();
  }
}

run();
