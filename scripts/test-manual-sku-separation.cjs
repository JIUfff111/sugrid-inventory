/** Run: node scripts/test-manual-sku-separation.cjs */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const crypto = require('node:crypto');
const ts = require('typescript');
const Database = require('better-sqlite3');
const schema = require('./database.cjs');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sugrid-manual-sku-'));
const db = new Database(path.join(tempDir, 'inventory.db'));
db.pragma('foreign_keys = ON');
schema.initDatabase(db);
schema.seedDatabase(db);

const actor = db.prepare("SELECT id FROM users WHERE username = 'admin'").get();
db.prepare('INSERT INTO suppliers (id, supplierName) VALUES (?, ?)').run('supplier_manual_sku_test', 'Manual SKU Test Supplier');

const responseHelpers = {
  ErrorCode: {
    VALIDATION_ERROR: 'VALIDATION_ERROR', DUPLICATE_ENTRY: 'DUPLICATE_ENTRY',
    SUPPLIER_NOT_FOUND: 'SUPPLIER_NOT_FOUND', PURCHASE_ORDER_NOT_FOUND: 'PURCHASE_ORDER_NOT_FOUND',
    DATABASE_ERROR: 'DATABASE_ERROR', NOT_FOUND: 'NOT_FOUND',
  },
  successResponse: data => ({ success: true, data }),
  errorResponse: (code, message) => ({ success: false, error: { code, message } }),
  generateId: prefix => `${prefix}_${crypto.randomUUID()}`,
  parsePaginationParams: params => ({ page: Math.max(1, Number(params.get('page') || 1)), pageSize: Math.max(1, Number(params.get('pageSize') || 20)) }),
  createPaginatedResponse: (items, total, page, pageSize) => ({ items, total, page, pageSize, totalPages: Math.ceil(total / pageSize) }),
  notDeletedCondition: 'deleted = 0',
  formatDateTime: () => '2026-10-27 00:00:00',
};
const authHelpers = {
  requireRole: async () => actor,
  authErrorResponse: () => null,
  AuthError: class AuthError extends Error {},
};
const responseMock = { json: (body, init = {}) => ({ body, status: init.status || 200, json: async () => body }) };
const canonicalSKUBrand = value => /^(?:redmi|红米)$/i.test(String(value || '').trim()) ? '小米' : String(value || '').trim();
const getSKUProductType = value => value === '游戏本' ? '笔记本电脑' : value;

const oldLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === '@/lib/db') return { __esModule: true, default: db };
  if (request === '@/lib/auth') return authHelpers;
  if (request === '@/lib/api-helpers') return responseHelpers;
  if (request === '@/lib/sku-brand') return { canonicalSKUBrand };
  if (request === '@/lib/sku-display') return { getSKUProductType };
  if (request === 'next/server') return { NextResponse: responseMock };
  return oldLoad.call(this, request, parent, isMain);
};

function loadRoute(relativePath) {
  const filename = path.resolve(__dirname, relativePath);
  const source = fs.readFileSync(filename, 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    fileName: filename,
  }).outputText;
  const loaded = new Module(filename, module);
  loaded.filename = filename;
  loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  loaded._compile(compiled, filename);
  return loaded.exports;
}

const manualSkus = loadRoute('../src/app/api/manual-skus/route.ts');
const builtInSkus = loadRoute('../src/app/api/skus/route.ts');
const purchaseOrders = loadRoute('../src/app/api/purchase-orders/route.ts');
Module._load = oldLoad;

const request = (url, body) => ({ url: `http://localhost${url}`, json: async () => body });

(async () => {
  try {
    const manualResponse = await manualSkus.POST(request('/api/manual-skus', {
      productType: '笔记本电脑', brand: 'ThinkPad', model: 'X13 2020',
    }));
    assert.equal(manualResponse.status, 201);
    const manualSkuId = manualResponse.body.data.item.id;
    assert.equal(manualResponse.body.data.item.model, 'X13');
    assert.equal(manualResponse.body.data.item.year, 2020);

    const builtInResponse = await builtInSkus.POST(request('/api/skus', {
      productType: '笔记本电脑', brand: 'ThinkPad', model: 'X13', year: 2020,
      cpuOptions: [], ramOptions: [], gpuOptions: [], storageOptions: [], screenOptions: [],
    }));
    assert.equal(builtInResponse.status, 201);

    const duplicateResponse = await manualSkus.POST(request('/api/manual-skus', {
      productType: '笔记本电脑', brand: 'thinkpad', model: 'x13', year: 2020,
    }));
    assert.equal(duplicateResponse.status, 409, 'duplicate manual identity should be rejected');

    const mismatchResponse = await purchaseOrders.POST(request('/api/purchase-orders', {
      supplierId: 'supplier_manual_sku_test', purchaseDate: '2026-10-27', purchasedBy: '当前用户', status: 'completed',
      items: [{ manualSkuId, productType: '笔记本电脑', brand: 'OtherBrand', model: 'X13', year: 2020, cpu: 'I5-10210U', ram: '16GB', storage: '512GB SSD', sn: 'MANUAL-SKU-MISMATCH', purchasePrice: 3000 }],
    }));
    assert.equal(mismatchResponse.status, 400, 'mismatched manual identity should be rejected');

    const purchaseResponse = await purchaseOrders.POST(request('/api/purchase-orders', {
      supplierId: 'supplier_manual_sku_test', purchaseDate: '2026-10-27', purchasedBy: '当前用户', status: 'completed',
      items: [{ manualSkuId, productType: '笔记本电脑', brand: 'ThinkPad', model: 'X13', year: 2020, cpu: 'I5-10210U', ram: '16GB', gpu: 'RTX 4060', storage: '512GB SSD', screen: '2.5K', sn: 'MANUAL-SKU-TEST-0001', purchasePrice: 3000 }],
    }));
    assert.equal(purchaseResponse.status, 201, JSON.stringify(purchaseResponse.body));

    const stored = db.prepare(`SELECT pi.manualSkuId, pi.skuId, inv.manualSkuId AS inventoryManualSkuId
      FROM purchase_items pi JOIN inventory inv ON inv.purchaseItemId = pi.id WHERE pi.sn = ?`).get('MANUAL-SKU-TEST-0001');
    assert.equal(stored.manualSkuId, manualSkuId);
    assert.equal(stored.inventoryManualSkuId, manualSkuId);
    assert.equal(stored.skuId, null, 'manual entry must not link to a same-name built-in SKU');
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM inventory WHERE sn = ?').get('MANUAL-SKU-MISMATCH').count, 0);

    const listResponse = await manualSkus.GET(request('/api/manual-skus?productType=%E7%AC%94%E8%AE%B0%E6%9C%AC%E7%94%B5%E8%84%91'));
    assert.equal(listResponse.body.data.items.length, 1);
    console.log('Manual SKU isolation API and purchase-link checks passed');
  } finally {
    db.close();
    Module._load = oldLoad;
    const resolvedTemp = path.resolve(tempDir);
    const resolvedRoot = path.resolve(os.tmpdir());
    if (resolvedTemp.startsWith(resolvedRoot + path.sep) && path.basename(resolvedTemp).startsWith('sugrid-manual-sku-')) {
      fs.rmSync(resolvedTemp, { recursive: true, force: true });
    }
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
