const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const Database = require('better-sqlite3');
const { NextRequest } = require('next/server');
const { initDatabase, seedDatabase } = require('./database.cjs');

const root = path.resolve(__dirname, '..');

function load(relativePath, overrides = {}) {
  const filename = path.join(root, relativePath);
  const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    fileName: filename,
  }).outputText;
  const target = new Module(filename, module);
  target.filename = filename;
  target.paths = Module._nodeModulePaths(path.dirname(filename));
  const native = target.require.bind(target);
  target.require = name => Object.hasOwn(overrides, name) ? overrides[name] : native(name);
  target._compile(compiled, filename);
  return target.exports;
}

async function main() {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'sugrid-item-number-purchase-'));
  const previousPath = process.env.INVENTORY_DB_PATH;
  process.env.INVENTORY_DB_PATH = path.join(scratch, 'inventory.db');
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  try {
    initDatabase(db);
    seedDatabase(db);
    const database = { __esModule: true, default: db };
    const api = load('src/lib/api-helpers.ts');
    let token;
    const auth = load('src/lib/auth.ts', {
      '@/lib/db': database,
      '@/lib/api-helpers': api,
      'next/headers': { cookies: async () => ({ get: () => token ? { value: token } : undefined }) },
    });
    const deps = {
      '@/lib/db': database,
      '@/lib/api-helpers': api,
      '@/lib/auth': auth,
      '@/lib/inventory-purge': { createPurgeBackup: async () => ({ path: '', sha256: '' }), getPurgeCandidate: () => undefined },
      '@/lib/sku-brand': load('src/lib/sku-brand.ts'),
      '@/lib/sku-display': load('src/lib/sku-display.ts'),
      '@/lib/manual-sku-options': load('src/lib/manual-sku-options.ts'),
      '@/lib/machine-scan': load('src/lib/machine-scan.ts'),
    };
    const inventoryStatus = load('src/lib/inventory-status.ts', deps);
    const routeDeps = { ...deps, '@/lib/inventory-status': inventoryStatus };
    const routes = {
      purchaseOrders: load('src/app/api/purchase-orders/route.ts', routeDeps),
      inventory: load('src/app/api/inventory/route.ts', routeDeps),
      inventoryEdit: load('src/app/api/inventory/edit/route.ts', routeDeps),
      inventoryLookup: load('src/app/api/inventory/lookup/route.ts', routeDeps),
    };
    const adminId = db.prepare("SELECT id FROM users WHERE username='admin'").get().id;
    token = auth.createSession(adminId);
    db.prepare("INSERT INTO suppliers (id,supplierName,status,createdBy) VALUES ('number-supplier','编号测试供应商','active',?)").run(adminId);
    db.prepare("INSERT INTO warehouses (id,code,name,warehouseCode,warehouseName,status,isDefault) VALUES ('warehouse-secondary','SECONDARY','二号仓','SECONDARY','二号仓','active',0)").run();

    const request = (url, method = 'GET', body) => new NextRequest(`http://localhost${url}`, {
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    async function call(handler, url, method = 'GET', body, expected = 200) {
      const response = await handler(request(url, method, body));
      const payload = await response.json();
      assert.equal(response.status, expected, `${method} ${url}: ${JSON.stringify(payload)}`);
      return { payload, data: payload.data };
    }
    const item = (sn, itemNumber) => ({
      productType: '显卡', brand: '华硕', model: 'RTX 4060', gpu: 'RTX 4060',
      cpu: '', ram: '', storage: '', screen: '', sn, itemNumber, purchasePrice: 0,
    });
    const order = (status, items) => ({
      supplierId: 'number-supplier', purchaseDate: '2026-11-07', purchasedBy: adminId, status, items,
    });

    const warehouseDraft = (await call(routes.purchaseOrders.POST, '/api/purchase-orders', 'POST', {
      ...order('draft', [{ ...item('WAREHOUSE-NOTE-001', ''), remark: '外壳有轻微划痕', skuRemark: '配置补充说明' }]),
      warehouseId: 'warehouse-secondary',
    }, 201)).data;
    let warehouseDraftDetail = (await call(routes.purchaseOrders.GET, `/api/purchase-orders?id=${warehouseDraft.id}`)).data;
    assert.equal(warehouseDraftDetail.warehouseId, 'warehouse-secondary', 'a selected receiving warehouse must persist on a draft');
    assert.equal(warehouseDraftDetail.items[0].remark, '外壳有轻微划痕', 'a per-machine remark must persist on a draft');
    assert.equal(warehouseDraftDetail.items[0].skuRemark, '配置补充说明', 'SKU supplemental info must remain separate from the per-machine remark');
    const warehouseItemId = warehouseDraftDetail.items[0].id;
    await call(routes.purchaseOrders.PATCH, '/api/purchase-orders', 'PATCH', {
      ...order('draft', [{ ...item('WAREHOUSE-NOTE-001', ''), id: warehouseItemId, remark: '已检查外壳', skuRemark: '配置补充说明' }]),
      id: warehouseDraft.id,
      warehouseId: 'warehouse_main',
    });
    warehouseDraftDetail = (await call(routes.purchaseOrders.GET, `/api/purchase-orders?id=${warehouseDraft.id}`)).data;
    assert.equal(warehouseDraftDetail.warehouseId, 'warehouse_main', 'changing the receiving warehouse must update the saved draft');
    assert.equal(warehouseDraftDetail.items[0].remark, '已检查外壳', 'editing a draft must preserve its per-machine remark');
    assert.equal(warehouseDraftDetail.items[0].skuRemark, '配置补充说明', 'editing a draft must preserve its separate SKU supplemental info');
    const warehouseInbound = await call(routes.purchaseOrders.PATCH, '/api/purchase-orders', 'PATCH', {
      ...order('completed', [{ ...item('WAREHOUSE-NOTE-001', ''), id: warehouseItemId, remark: '入库前确认无异常', skuRemark: '配置补充说明' }]),
      id: warehouseDraft.id,
      warehouseId: 'warehouse-secondary',
      action: 'inbound',
    });
    assert.equal(warehouseInbound.data.warehouseId, 'warehouse-secondary', 'the inbound action must retain the selected warehouse');
    assert.equal(db.prepare('SELECT warehouseId,remark FROM inventory WHERE id=?').get(warehouseInbound.data.inventoryIds[0]).warehouseId, 'warehouse-secondary');
    assert.equal(db.prepare('SELECT remark FROM inventory WHERE id=?').get(warehouseInbound.data.inventoryIds[0]).remark, '入库前确认无异常');
    assert.equal(db.prepare('SELECT skuRemark FROM inventory WHERE id=?').get(warehouseInbound.data.inventoryIds[0]).skuRemark, '配置补充说明');
    assert.equal(db.prepare('SELECT remark FROM purchase_items WHERE id=?').get(warehouseItemId).remark, '入库前确认无异常');

    const draft = (await call(routes.purchaseOrders.POST, '/api/purchase-orders', 'POST', order('draft', [item('NUMBER-DRAFT-SN', 'GPU-DRAFT-A')]), 201)).data;
    const draftDetail = (await call(routes.purchaseOrders.GET, `/api/purchase-orders?id=${draft.id}`)).data;
    const draftItemId = draftDetail.items[0].id;
    const revisedDraft = order('draft', [{ ...item('NUMBER-DRAFT-SN', 'GPU-DRAFT-B'), id: draftItemId }]);
    revisedDraft.id = draft.id;
    const patchedDraft = await call(routes.purchaseOrders.PATCH, '/api/purchase-orders', 'PATCH', revisedDraft);
    assert.equal(patchedDraft.data.items[0].itemNumber, 'GPU-DRAFT-B', 'draft rewrite should save the updated optional number');
    assert.equal(db.prepare('SELECT itemNumber FROM purchase_items WHERE id=?').get(draftItemId).itemNumber, 'GPU-DRAFT-B');

    await call(routes.purchaseOrders.DELETE, `/api/purchase-orders?id=${draft.id}`, 'DELETE', undefined, 200);
    const deletedHistoryCollision = await call(routes.purchaseOrders.POST, '/api/purchase-orders', 'POST', order('draft', [item('NUMBER-DELETED-SN', ' gpu-draft-b ')]), 400);
    assert.match(JSON.stringify(deletedHistoryCollision.payload), /采购历史/,
      'deleted purchase details must keep their item numbers reserved, ignoring case and surrounding whitespace');

    const live = (await call(routes.purchaseOrders.POST, '/api/purchase-orders', 'POST', order('completed', [item('NUMBER-LIVE-SN', 'GPU-LIVE-001')]), 201)).data;
    const liveInventoryId = live.inventoryIds[0];
    assert.equal(db.prepare('SELECT warehouseId FROM purchase_orders WHERE id=?').get(live.id).warehouseId, 'warehouse_main', 'omitting a warehouse must default to the main warehouse');
    assert.equal(db.prepare('SELECT warehouseId FROM inventory WHERE id=?').get(liveInventoryId).warehouseId, 'warehouse_main');
    const conflictDraft = (await call(routes.purchaseOrders.POST, '/api/purchase-orders', 'POST', order('draft', [item('NUMBER-DRAFT-CONFLICT', 'GPU-DRAFT-CONFLICT')]), 201)).data;
    const countsBeforeSnConflict = {
      orders: db.prepare('SELECT COUNT(*) AS count FROM purchase_orders').get().count,
      inventory: db.prepare('SELECT COUNT(*) AS count FROM inventory WHERE deleted = 0').get().count,
    };
    const batchConflict = await call(routes.purchaseOrders.POST, '/api/purchase-orders', 'POST', order('completed', [
      item('BATCH-VALID-BEFORE', 'GPU-BATCH-VALID-1'),
      item('NUMBER-LIVE-SN', 'GPU-BATCH-LIVE-CONFLICT'),
      item('NUMBER-DRAFT-CONFLICT', 'GPU-BATCH-DRAFT-CONFLICT'),
      item('BATCH-DUPLICATE', 'GPU-BATCH-DUPLICATE-1'),
      item('batch-duplicate', 'GPU-BATCH-DUPLICATE-2'),
      item('BATCH-VALID-AFTER', 'GPU-BATCH-VALID-2'),
    ]), 409);
    const snConflictDetails = batchConflict.payload.error.details;
    assert.equal(snConflictDetails.kind, 'sn_conflicts');
    assert.deepEqual(snConflictDetails.conflicts.map(conflict => conflict.itemIndex), [1, 2, 3, 4],
      'all conflicting rows, including case-insensitive duplicates within the submitted batch, must be reported');
    assert(snConflictDetails.conflicts[0].reasons.some(reason => reason.source === 'inventory' && reason.recordId === liveInventoryId),
      'live inventory conflicts must identify the occupying inventory record');
    assert(snConflictDetails.conflicts[1].reasons.some(reason => reason.source === 'purchase_draft' && reason.purchaseNo === conflictDraft.purchaseNo),
      'draft conflicts must identify the occupying purchase draft');
    assert(snConflictDetails.conflicts[2].reasons.some(reason => reason.source === 'batch_duplicate'));
    assert(snConflictDetails.conflicts[3].reasons.some(reason => reason.source === 'batch_duplicate'));
    assert.match(batchConflict.payload.error.message, /本次采购单未入库/);
    assert.deepEqual({
      orders: db.prepare('SELECT COUNT(*) AS count FROM purchase_orders').get().count,
      inventory: db.prepare('SELECT COUNT(*) AS count FROM inventory WHERE deleted = 0').get().count,
    }, countsBeforeSnConflict, 'a conflict must leave the entire purchase order and all candidate machines unwritten');

    const patchDraft = (await call(routes.purchaseOrders.POST, '/api/purchase-orders', 'POST', order('draft', [
      item('PATCH-CONFLICT-KEEP-1', 'GPU-PATCH-KEEP-1'), item('PATCH-CONFLICT-KEEP-2', 'GPU-PATCH-KEEP-2'),
    ]), 201)).data;
    const patchDraftDetail = (await call(routes.purchaseOrders.GET, `/api/purchase-orders?id=${patchDraft.id}`)).data;
    const patchCountsBefore = {
      inventory: db.prepare('SELECT COUNT(*) AS count FROM inventory WHERE deleted = 0').get().count,
      itemSNs: patchDraftDetail.items.map(row => row.sn),
    };
    const blockedDraftInbound = await call(routes.purchaseOrders.PATCH, '/api/purchase-orders', 'PATCH', {
      ...order('completed', [
        { ...item('PATCH-CONFLICT-KEEP-1', 'GPU-PATCH-KEEP-1'), id: patchDraftDetail.items[0].id },
        { ...item('NUMBER-LIVE-SN', 'GPU-PATCH-LIVE-CONFLICT'), id: patchDraftDetail.items[1].id },
      ]), id: patchDraft.id, action: 'inbound',
    }, 409);
    assert.equal(blockedDraftInbound.payload.error.details.kind, 'sn_conflicts');
    const unchangedPatchDraft = (await call(routes.purchaseOrders.GET, `/api/purchase-orders?id=${patchDraft.id}`)).data;
    assert.equal(unchangedPatchDraft.isInbounded, 0, 'a conflicting draft inbound must remain a draft');
    assert.deepEqual(unchangedPatchDraft.items.map(row => row.sn), patchCountsBefore.itemSNs,
      'a conflicting draft inbound must preserve its original purchase details');
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM inventory WHERE deleted = 0').get().count, patchCountsBefore.inventory,
      'a conflicting draft inbound must not create inventory for non-conflicting rows');

    const inventoryEditFields = (itemNumber) => ({
      sn: 'NUMBER-LIVE-SN', itemNumber, productType: '显卡', brand: '华硕', model: 'RTX 4060', year: null,
      cpu: '', ram: '', gpu: 'RTX 4060', storage: '', screen: '', touchScreen: null, purchasePrice: 0,
    });
    const edited = (await call(routes.inventoryEdit.POST, '/api/inventory/edit', 'POST', {
      inventoryId: liveInventoryId, expectedSn: 'NUMBER-LIVE-SN', fields: inventoryEditFields('GPU-LIVE-EDITED'),
    })).data;
    const purchaseItemId = db.prepare('SELECT purchaseItemId FROM inventory WHERE id=?').get(liveInventoryId).purchaseItemId;
    assert.equal(edited.item.itemNumber, 'GPU-LIVE-EDITED');
    assert.equal(db.prepare('SELECT itemNumber FROM inventory WHERE id=?').get(liveInventoryId).itemNumber, 'GPU-LIVE-EDITED');
    assert.equal(db.prepare('SELECT itemNumber FROM purchase_items WHERE id=?').get(purchaseItemId).itemNumber, 'GPU-LIVE-EDITED',
      'inventory number edits should update the paired purchase history row');
    assert.equal(JSON.parse(db.prepare('SELECT afterData FROM inventory_edit_logs WHERE inventoryId=?').get(liveInventoryId).afterData).itemNumber, 'GPU-LIVE-EDITED',
      'machine edit history should record the number change');

    const historicalEdit = await call(routes.inventoryEdit.POST, '/api/inventory/edit', 'POST', {
      inventoryId: liveInventoryId, expectedSn: 'NUMBER-LIVE-SN', fields: inventoryEditFields('GPU-DRAFT-B'),
    }, 409);
    assert.match(JSON.stringify(historicalEdit.payload), /采购历史/);
    assert.equal(db.prepare('SELECT itemNumber FROM inventory WHERE id=?').get(liveInventoryId).itemNumber, 'GPU-LIVE-EDITED',
      'a rejected edit must leave the machine unchanged');

    const duplicateLive = (await call(routes.purchaseOrders.POST, '/api/purchase-orders', 'POST', order('completed', [item('NUMBER-LIVE-SN-2', 'GPU-LIVE-002')]), 201)).data;
    const inventoryCollision = await call(routes.inventoryEdit.POST, '/api/inventory/edit', 'POST', {
      inventoryId: liveInventoryId, expectedSn: 'NUMBER-LIVE-SN', fields: inventoryEditFields(' gpu-live-002 '),
    }, 409);
    assert.match(JSON.stringify(inventoryCollision.payload), /全库唯一|其他库存机器/);
    assert.equal(duplicateLive.inventoryIds.length, 1);

    const list = (await call(routes.inventory.GET, '/api/inventory?search=GPU-LIVE-EDITED&page=1&pageSize=20')).data;
    assert.equal(list.items.length, 1, 'inventory list search should match item numbers');
    const lookup = (await call(routes.inventoryLookup.GET, '/api/inventory/lookup?context=inventory&q=GPU-LIVE-EDITED&limit=8')).data;
    assert.equal(lookup.items.length, 1, 'machine suggestions should match item numbers');
    assert.equal(lookup.items[0].itemNumber, 'GPU-LIVE-EDITED', 'suggestions should return the number for display');

    db.exec('CREATE UNIQUE INDEX legacy_purchase_item_sn_unique ON purchase_items(sn)');
    db.prepare('DELETE FROM schema_migrations WHERE version=16').run();
    initDatabase(db);
    assert.equal(db.prepare('SELECT itemNumber FROM purchase_items WHERE id=?').get(purchaseItemId).itemNumber, 'GPU-LIVE-EDITED',
      'replaying the purchase table rebuild must preserve item numbers');
    assert(db.pragma('index_list(purchase_items)').some(index => index.name === 'idx_purchase_items_item_number' && index.unique),
      'replaying the purchase table rebuild must restore number uniqueness');

    db.exec('DROP INDEX idx_inventory_sn');
    db.prepare('DELETE FROM schema_migrations WHERE version=17').run();
    initDatabase(db);
    assert.equal(db.prepare('SELECT itemNumber FROM inventory WHERE id=?').get(liveInventoryId).itemNumber, 'GPU-LIVE-EDITED',
      'replaying the inventory table rebuild must preserve item numbers');
    assert(db.pragma('index_list(inventory)').some(index => index.name === 'idx_inventory_item_number_active' && index.unique),
      'replaying the inventory table rebuild must restore number uniqueness');

    db.exec('DROP INDEX idx_purchase_items_item_number');
    db.prepare('DELETE FROM schema_migrations WHERE version=24').run();
    initDatabase(db);
    assert(db.pragma('index_list(purchase_items)').some(index => index.name === 'idx_purchase_items_item_number' && index.unique),
      'migration 24 must restore purchase-history uniqueness for databases where migration 23 already ran');
    const secondPurchaseItemId = db.prepare('SELECT purchaseItemId FROM inventory WHERE id=?').get(duplicateLive.inventoryIds[0]).purchaseItemId;
    assert.throws(() => db.prepare('UPDATE purchase_items SET itemNumber=? WHERE id=?').run(' gpu-live-edited ', secondPurchaseItemId),
      /UNIQUE constraint failed/, 'purchase history must reject duplicate numbers case-insensitively and after trimming');
    assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
    assert.deepEqual(db.pragma('foreign_key_check'), []);

    db.exec('ALTER TABLE purchase_orders DROP COLUMN warehouseId');
    db.prepare('DELETE FROM schema_migrations WHERE version=27').run();
    initDatabase(db);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM purchase_orders WHERE warehouseId != 'warehouse_main'").get().count, 0,
      'legacy purchase orders without a warehouse column must migrate to the main warehouse');
    assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
    assert.deepEqual(db.pragma('foreign_key_check'), []);
    console.log('PASS isolated item-number lifecycle: draft rewrite, deleted-history reservation, inbound mirror, edit uniqueness, lookup and migration rebuilds');
  } finally {
    if (previousPath === undefined) delete process.env.INVENTORY_DB_PATH; else process.env.INVENTORY_DB_PATH = previousPath;
    db.close();
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
