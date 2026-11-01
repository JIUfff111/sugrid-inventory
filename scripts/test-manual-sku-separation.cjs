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
const systemActor = { ...actor, role: 'admin', isSystemAccount: true, canViewInventory: true, canEditInventory: true, warehouses: [{ id: 'warehouse_main', status: 'active' }] };
let sessionUser = systemActor;
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
  requireRole: async () => sessionUser,
  requireUser: async () => sessionUser,
  assertInventoryView: user => { if (!user.isSystemAccount && !user.canViewInventory) throw new authHelpers.AuthError('FORBIDDEN', '没有库存查看权限'); },
  assertInventoryEdit: user => { if (!user.isSystemAccount && (!user.canViewInventory || !user.canEditInventory)) throw new authHelpers.AuthError('FORBIDDEN', '没有库存编辑权限'); },
  assertWarehouseAccess: () => {},
  warehouseScope: () => ({ sql: '1 = 1', params: [] }),
  authErrorResponse: error => error instanceof authHelpers.AuthError ? responseMock.json({ success: false, error: { message: error.message } }, { status: 403 }) : null,
  AuthError: class AuthError extends Error { constructor(code, message) { super(message); this.code = code; this.status = code === 'FORBIDDEN' ? 403 : 401; } },
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
  if (request === '@/lib/sales-records') return {
    querySalesRecords: () => ({ summary: { orders: 0, quantity: 0, amount: 0, cost: 0, profit: 0 } }),
  };
  if (request === '@/lib/sku-display') return {
    getSKUProductType,
    SKU_PRODUCT_TYPES: ['笔记本电脑', '平板电脑', '显卡'],
    requiresComputerSpecs: productType => getSKUProductType(productType) !== '显卡',
  };
  if (request === '@/lib/inventory-status') return {
    serializeInventoryStatus: row => row,
    stockEligibleSql: () => '1 = 1',
    assertStockEligible: () => ({}),
    endCustomStatus: () => {},
  };
  if (request === '@/lib/inventory-purge') return { createPurgeBackup: () => '', getPurgeCandidate: () => null };
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
const inventoryEdit = loadRoute('../src/app/api/inventory/edit/route.ts');
const inventoryRoute = loadRoute('../src/app/api/inventory/route.ts');
const inventoryStatusRecords = loadRoute('../src/app/api/inventory/status-records/route.ts');
const inventoryLookup = loadRoute('../src/app/api/inventory/lookup/route.ts');
const inventoryAssetChange = loadRoute('../src/app/api/inventory/asset-change/route.ts');
const dashboard = loadRoute('../src/app/api/dashboard/route.ts');
const transfers = loadRoute('../src/app/api/transfers/route.ts');
const skuDisplay = loadRoute('../src/lib/sku-display.ts');
const access = loadRoute('../src/lib/access.ts');
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

    const missingManualRamResponse = await purchaseOrders.POST(request('/api/purchase-orders', {
      supplierId: 'supplier_manual_sku_test', purchaseDate: '2026-10-27', purchasedBy: '当前用户', status: 'completed',
      items: [{ manualSkuId, productType: '笔记本电脑', brand: 'ThinkPad', model: 'X13', year: 2020, cpu: 'I5-10210U', ram: '', storage: '512GB', sn: 'MANUAL-SKU-NO-RAM', purchasePrice: 3000 }],
    }));
    assert.equal(missingManualRamResponse.status, 400, 'manual SKU entry should continue to require RAM');

    const missingManualStorageResponse = await purchaseOrders.POST(request('/api/purchase-orders', {
      supplierId: 'supplier_manual_sku_test', purchaseDate: '2026-10-27', purchasedBy: '当前用户', status: 'completed',
      items: [{ manualSkuId, productType: '笔记本电脑', brand: 'ThinkPad', model: 'X13', year: 2020, cpu: 'I5-10210U', ram: '16GB', sn: 'MANUAL-SKU-NO-STORAGE', purchasePrice: 3000 }],
    }));
    assert.equal(missingManualStorageResponse.status, 201, JSON.stringify(missingManualStorageResponse.body));
    const manualStorage = db.prepare(`SELECT pi.storage AS purchaseStorage, inv.storage AS inventoryStorage
      FROM purchase_items pi JOIN inventory inv ON inv.purchaseItemId = pi.id WHERE pi.sn = ?`).get('MANUAL-SKU-NO-STORAGE');
    assert.deepEqual(manualStorage, { purchaseStorage: '', inventoryStorage: '' }, 'manual SKU storage should be optional and persist as empty');

    const builtInPurchaseResponse = await purchaseOrders.POST(request('/api/purchase-orders', {
      supplierId: 'supplier_manual_sku_test', purchaseDate: '2026-10-27', purchasedBy: '当前用户', status: 'completed',
      items: [{ skuId: builtInResponse.body.data.id, productType: '笔记本电脑', brand: 'ThinkPad', model: 'X13', year: 2020, cpu: 'I5-10210U', ram: '16GB', gpu: '集显', sn: 'BUILTIN-SKU-NO-STORAGE', purchasePrice: 3000 }],
    }));
    assert.equal(builtInPurchaseResponse.status, 201, JSON.stringify(builtInPurchaseResponse.body));
    const builtInStorage = db.prepare(`SELECT pi.storage AS purchaseStorage, inv.storage AS inventoryStorage
      FROM purchase_items pi JOIN inventory inv ON inv.purchaseItemId = pi.id WHERE pi.sn = ?`).get('BUILTIN-SKU-NO-STORAGE');
    assert.deepEqual(builtInStorage, { purchaseStorage: '', inventoryStorage: '' }, 'empty built-in SKU storage should persist through purchase and inventory');

    const builtinMachine = db.prepare('SELECT id FROM inventory WHERE sn=?').get('BUILTIN-SKU-NO-STORAGE');
    const editResponse = await inventoryEdit.POST(request('/api/inventory/edit', {
      inventoryId: builtinMachine.id, expectedSn: 'BUILTIN-SKU-NO-STORAGE',
      fields: { sn: 'BUILTIN-SKU-EDITED', productType: '笔记本电脑', brand: 'ThinkPad', model: 'X13', year: 2020, cpu: 'I5-10210U', ram: '16GB', gpu: '集显', storage: '', screen: '1k', touchScreen: null, purchasePrice: 3000 },
    }));
    assert.equal(editResponse.status, 200, JSON.stringify(editResponse.body));
    assert.equal(editResponse.body.data.item.sn, 'BUILTIN-SKU-EDITED');
    assert.equal(editResponse.body.data.item.screen, '1k', 'custom screen text remains unchanged');
    assert.equal(editResponse.body.data.history.length, 1);
    assert.equal(skuDisplay.formatScreenDisplay('1k'), '1k', 'custom screen text should remain unchanged');
    assert.equal(db.prepare('SELECT sn FROM purchase_items WHERE sn=?').get('BUILTIN-SKU-NO-STORAGE').sn, 'BUILTIN-SKU-NO-STORAGE', 'machine edits must not rewrite purchase snapshots');

    db.prepare('UPDATE skus SET brand=? WHERE id=?').run('红米', builtInResponse.body.data.id);
    const canonicalBrandResponse = await inventoryEdit.POST(request('/api/inventory/edit', {
      inventoryId: builtinMachine.id, expectedSn: 'BUILTIN-SKU-EDITED',
      fields: { sn: 'BUILTIN-SKU-EDITED', productType: '笔记本电脑', brand: '小米', model: 'X13', year: 2020, cpu: 'I5-10210U', ram: '16GB', gpu: '集显', storage: '', screen: '1k', touchScreen: null, purchasePrice: 3000 },
    }));
    assert.equal(canonicalBrandResponse.status, 200, 'canonical Xiaomi brand should match a legacy Redmi SKU option');
    assert.equal(canonicalBrandResponse.body.data.item.brand, '小米');

    db.prepare('UPDATE inventory SET brand=? WHERE id=?').run('红米', builtinMachine.id);
    const legacyBrandResponse = await inventoryEdit.POST(request('/api/inventory/edit', {
      inventoryId: builtinMachine.id, expectedSn: 'BUILTIN-SKU-EDITED',
      fields: { sn: 'BUILTIN-SKU-EDITED', productType: '笔记本电脑', brand: '红米', model: 'X13', year: 2020, cpu: 'I5-10210U', ram: '16GB', gpu: '集显', storage: '', screen: '1k custom', touchScreen: null, purchasePrice: 3000 },
    }));
    assert.equal(legacyBrandResponse.status, 200, 'editing other fields should keep a legacy machine brand');
    assert.equal(legacyBrandResponse.body.data.item.brand, '红米', 'legacy brand should not be silently canonicalized');

    const filterOptionsResponse = await inventoryRoute.GET({ url: 'http://localhost/api/inventory?meta=filters' });
    assert.equal(filterOptionsResponse.status, 200);
    assert.equal(filterOptionsResponse.body.data.editBrands.includes('小米'), true, 'brand options should merge legacy Redmi catalog entries into Xiaomi');
    assert.equal(filterOptionsResponse.body.data.editBrands.includes('红米'), false, 'brand options should not expose a separate Redmi choice');

    const customProductTypeResponse = await inventoryEdit.POST(request('/api/inventory/edit', {
      inventoryId: builtinMachine.id, expectedSn: 'BUILTIN-SKU-EDITED',
      fields: { sn: 'BUILTIN-SKU-EDITED', productType: '自定义分类', brand: 'ThinkPad', model: 'X13', year: 2020, cpu: 'I5-10210U', ram: '16GB', gpu: '集显', storage: '', screen: '1k', touchScreen: null, purchasePrice: 3000 },
    }));
    assert.equal(customProductTypeResponse.status, 400, 'inventory product type must use a system option');

    const customBrandResponse = await inventoryEdit.POST(request('/api/inventory/edit', {
      inventoryId: builtinMachine.id, expectedSn: 'BUILTIN-SKU-EDITED',
      fields: { sn: 'BUILTIN-SKU-EDITED', productType: '笔记本电脑', brand: '自定义品牌', model: 'X13', year: 2020, cpu: 'I5-10210U', ram: '16GB', gpu: '集显', storage: '', screen: '1k', touchScreen: null, purchasePrice: 3000 },
    }));
    assert.equal(customBrandResponse.status, 400, 'inventory brand must use an SKU brand option');

    sessionUser = { ...systemActor, isSystemAccount: false, canViewInventory: true, canEditInventory: false };
    const readOnlyResponse = await inventoryEdit.POST(request('/api/inventory/edit', {
      inventoryId: builtinMachine.id, expectedSn: 'BUILTIN-SKU-EDITED',
      fields: { sn: 'READONLY-EDIT', productType: '笔记本电脑', brand: 'ThinkPad', model: 'X13', year: 2020, cpu: 'I5-10210U', ram: '16GB', gpu: '集显', storage: '', screen: '1k', touchScreen: null },
    }));
    assert.equal(readOnlyResponse.status, 403, 'inventory view-only accounts cannot edit machine data');
    sessionUser = { ...systemActor, isSystemAccount: false, canViewInventory: false, canEditInventory: false };
    const hiddenStatusHistory = await inventoryStatusRecords.GET({ nextUrl: new URL('http://localhost/api/inventory/status-records') });
    assert.equal(hiddenStatusHistory.status, 403, 'accounts without inventory view access cannot read status history');
    const hiddenTransferLookup = await inventoryLookup.GET({ url: 'http://localhost/api/inventory/lookup?context=transfer', nextUrl: new URL('http://localhost/api/inventory/lookup?context=transfer') });
    assert.equal(hiddenTransferLookup.status, 403, 'accounts without inventory view access cannot search transfer machines');
    const hiddenTransfers = await transfers.GET({ url: 'http://localhost/api/transfers' });
    assert.equal(hiddenTransfers.status, 403, 'accounts without inventory view access cannot read transfer details');
    sessionUser = { ...systemActor, isSystemAccount: false, role: 'admin', canViewInventory: true, canEditInventory: false };
    const deniedAssetChange = await inventoryAssetChange.POST(request('/api/inventory/asset-change', { inventoryId: builtinMachine.id, expectedRam: '16GB', expectedStorage: '', ram: '32GB' }));
    assert.equal(deniedAssetChange.status, 403, 'accounts without inventory edit access cannot change machine assets');
    sessionUser = { ...systemActor, isSystemAccount: false, role: 'admin', canViewInventory: false, canEditInventory: false };
    const hiddenInventoryDashboard = await dashboard.GET();
    assert.equal(hiddenInventoryDashboard.status, 200);
    assert.equal(hiddenInventoryDashboard.body.data.canViewInventory, false);
    assert.equal(hiddenInventoryDashboard.body.data.stats.inventoryTotal, 0, 'dashboard should not expose inventory totals without view access');
    assert.equal(hiddenInventoryDashboard.body.data.stats.inStockCost, 0, 'dashboard should not expose inventory cost without view access');
    assert.equal(hiddenInventoryDashboard.body.data.messages.some(message => message.id.includes('inventory')), false, 'dashboard should not expose inventory alerts without view access');
    sessionUser = systemActor;
    assert.equal(access.canVisit('admin', '/inventory', false), false, 'inventory routes should be hidden without view access');
    assert.equal(access.canVisit('admin', '/', false), true, 'non-inventory routes should remain available without inventory view access');

    const purchaseResponse = await purchaseOrders.POST(request('/api/purchase-orders', {
      supplierId: 'supplier_manual_sku_test', purchaseDate: '2026-10-27', purchasedBy: '当前用户', status: 'completed',
      items: [{ manualSkuId, productType: '笔记本电脑', brand: 'ThinkPad', model: 'X13', year: 2020, cpu: 'I5-10210U', ram: '16GB', gpu: 'RTX 4060', storage: '512GB SSD', screen: '2.5K', sn: 'MANUAL-SKU-TEST-0001', purchasePrice: 3000 }],
    }));
    assert.equal(purchaseResponse.status, 201, JSON.stringify(purchaseResponse.body));

    const duplicateSnResponse = await inventoryEdit.POST(request('/api/inventory/edit', {
      inventoryId: builtinMachine.id, expectedSn: 'BUILTIN-SKU-EDITED',
      fields: { sn: 'MANUAL-SKU-TEST-0001', productType: '笔记本电脑', brand: 'ThinkPad', model: 'X13', year: 2020, cpu: 'I5-10210U', ram: '16GB', gpu: '集显', storage: '', screen: '1k', touchScreen: null, purchasePrice: 3000 },
    }));
    assert.equal(duplicateSnResponse.status, 409, 'duplicate machine SN changes should be rejected');

    const stored = db.prepare(`SELECT pi.manualSkuId, pi.skuId, inv.manualSkuId AS inventoryManualSkuId
      FROM purchase_items pi JOIN inventory inv ON inv.purchaseItemId = pi.id WHERE pi.sn = ?`).get('MANUAL-SKU-TEST-0001');
    assert.equal(stored.manualSkuId, manualSkuId);
    assert.equal(stored.inventoryManualSkuId, manualSkuId);
    assert.equal(stored.skuId, null, 'manual entry must not link to a same-name built-in SKU');
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM inventory WHERE sn = ?').get('MANUAL-SKU-MISMATCH').count, 0);

    const listResponse = await manualSkus.GET(request('/api/manual-skus?productType=%E7%AC%94%E8%AE%B0%E6%9C%AC%E7%94%B5%E8%84%91'));
    assert.equal(listResponse.body.data.items.length, 1);

    const gpuSkuResponse = await manualSkus.POST(request('/api/manual-skus', {
      productType: '显卡', brand: '华硕', model: 'RTX 4060',
    }));
    assert.equal(gpuSkuResponse.status, 201, JSON.stringify(gpuSkuResponse.body));
    const gpuSkuId = gpuSkuResponse.body.data.item.id;

    const gpuPurchaseResponse = await purchaseOrders.POST(request('/api/purchase-orders', {
      supplierId: 'supplier_manual_sku_test', purchaseDate: '2026-10-27', purchasedBy: '当前用户', status: 'completed',
      items: [{ manualSkuId: gpuSkuId, productType: '显卡', brand: '华硕', model: 'RTX 4060', gpu: 'RTX 4060', sn: 'GPU-SKU-TEST-0001', purchasePrice: 2400 }],
    }));
    assert.equal(gpuPurchaseResponse.status, 201, JSON.stringify(gpuPurchaseResponse.body));
    const gpuInventory = db.prepare('SELECT productType, cpu, ram, storage, gpu FROM inventory WHERE sn = ?').get('GPU-SKU-TEST-0001');
    assert.deepEqual(gpuInventory, { productType: '显卡', cpu: '', ram: '', storage: '', gpu: 'RTX 4060' });

    const unsupportedTypeResponse = await manualSkus.POST(request('/api/manual-skus', {
      productType: '台式机', brand: 'Test', model: 'Unsupported',
    }));
    assert.equal(unsupportedTypeResponse.status, 400, 'only explicitly supported product types should be accepted');
    console.log('Manual SKU isolation and optional built-in SKU storage checks passed');
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
