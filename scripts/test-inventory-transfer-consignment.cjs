/** Run: node scripts/test-inventory-transfer-consignment.cjs */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const Database = require('better-sqlite3');
const { NextRequest, NextResponse } = require('next/server');
const { initDatabase } = require('./database.cjs');

const root = path.resolve(__dirname, '..');

function load(relative, deps = {}) {
  const filename = path.join(root, relative);
  const loaded = new Module(filename, module);
  loaded.filename = filename;
  loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  const ordinaryRequire = loaded.require.bind(loaded);
  loaded.require = name => Object.hasOwn(deps, name) ? deps[name] : ordinaryRequire(name);
  loaded._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    fileName: filename,
  }).outputText, filename);
  return loaded.exports;
}

async function main() {
  const db = new Database(':memory:');
  try {
    db.pragma('foreign_keys=ON');
    initDatabase(db);
    const helpers = load('src/lib/api-helpers.ts');
    const database = { __esModule: true, default: db };
    const inventoryStatus = load('src/lib/inventory-status.ts', { '@/lib/db': database, '@/lib/api-helpers': helpers });

    const columns = new Set(db.pragma('table_info(inventory_status_records)').map(column => column.name));
    for (const name of ['locationType', 'allowSales', 'allowRentals', 'allowTransfers', 'allowSupplierReturns']) {
      assert(columns.has(name), `migration 29 adds ${name}`);
    }
    assert.equal(db.prepare('SELECT name FROM schema_migrations WHERE version=32').get()?.name, 'track per-machine business availability and physical location');
    assert.equal(db.prepare('SELECT name FROM schema_migrations WHERE version=33').get()?.name, 'snapshot default business permissions on inventory status records');

    db.prepare("INSERT INTO users(id,username,password,realName,role,status,isSystemAccount) VALUES ('qa-admin','qa-admin','test','QA 管理员','admin','active',1),('qa-manager','qa-manager','test','QA 仓管','warehouse_manager','active',0),('qa-viewer','qa-viewer','test','QA 查看者','viewer','active',0)").run();
    db.prepare("INSERT INTO warehouses(id,code,name,warehouseName,status,isDefault,createdBy) VALUES ('warehouse_east','EAST','东仓','东仓','active',0,'qa-admin'),('warehouse_west','WEST','西仓','西仓','active',0,'qa-admin'),('warehouse_south','SOUTH','南仓','南仓','active',0,'qa-admin')").run();
    const mainWarehouseId = db.prepare("SELECT id FROM warehouses WHERE id='warehouse_main'").get().id;
    db.prepare("INSERT INTO user_warehouses(userId,warehouseId,createdBy) VALUES ('qa-manager',?,'qa-admin'),('qa-manager','warehouse_east','qa-admin')").run(mainWarehouseId);
    db.prepare("INSERT INTO suppliers(id,supplierName,createdBy) VALUES ('qa-supplier','QA 供应商','qa-admin')").run();
    db.prepare(`INSERT INTO purchase_orders(id,purchaseNo,supplierOrderNo,supplierId,supplierName,purchaseDate,purchasedBy,createdBy,warehouseId)
      VALUES ('qa-po','QA-PO','QA-EXT','qa-supplier','QA 供应商','2026-11-12','qa-admin','qa-admin',?)`).run(mainWarehouseId);
    const insertPurchaseItem = db.prepare(`INSERT INTO purchase_items(id,purchaseOrderId,productType,brand,model,cpu,ram,storage,screen,sn,purchasePrice)
      VALUES (?, 'qa-po','笔记本电脑','ThinkPad','X13','i5','16GB','512GB','13.3',?,1000)`);
    const insertInventory = db.prepare(`INSERT INTO inventory(id,purchaseOrderId,purchaseItemId,warehouseId,sn,productType,brand,model,cpu,ram,storage,screen,purchasePrice,supplierId,supplierName,status,inboundDate,createdAt,updatedAt)
      VALUES (?,'qa-po',?,?,?,'笔记本电脑','ThinkPad','X13','i5','16GB','512GB','13.3',1000,'qa-supplier','QA 供应商','in_stock','2026-11-12','2026-11-12T00:00:00.000Z','2026-11-12T00:00:00.000Z')`);
    function addMachine(id, sn, warehouseId = mainWarehouseId) {
      const purchaseItemId = `item-${id}`;
      insertPurchaseItem.run(purchaseItemId, sn);
      insertInventory.run(id, purchaseItemId, warehouseId, sn);
      return db.prepare('SELECT * FROM inventory WHERE id=?').get(id);
    }
    const externalMachine = addMachine('external-sale-only', 'QA-EXT-SALE-ONLY');
    const mainMachine = addMachine('transfer-main', 'QA-TRANSFER-MAIN');
    const eastMachine = addMachine('transfer-east', 'QA-TRANSFER-EAST', 'warehouse_east');
    const blockedMachine = addMachine('transfer-blocked', 'QA-TRANSFER-BLOCKED', 'warehouse_east');
    const legacyMachine = addMachine('legacy-custom', 'QA-LEGACY-CUSTOM');
    const singleRegisteredMachine = addMachine('single-status-register', 'QA-SINGLE-STATUS');
    const batchRegisteredMachine = addMachine('batch-status-register', 'QA-BATCH-STATUS');
    const migratedExternalMachine = addMachine('migration-external-defaults', 'QA-MIGRATED-EXTERNAL');
    db.prepare(`INSERT INTO inventory_status_definitions(id,name,color,allowStockOperations,isActive,createdBy,updatedBy,createdAt,updatedAt)
      VALUES ('qa-consignment','QA 外部寄卖','#2563eb',1,1,'qa-admin','qa-admin','2026-11-12','2026-11-12'),
      ('qa-paused','QA 暂停状态','#64748b',0,1,'qa-admin','qa-admin','2026-11-12','2026-11-12')`).run();

    const currentUser = { id: 'qa-admin', role: 'admin', canViewInventory: true, canEditInventory: true, warehouses: [] };
    class AuthError extends Error {
      constructor(code, message) { super(message); this.code = code; this.status = code === 'UNAUTHORIZED' ? 401 : 403; }
    }
    const auth = {
      AuthError,
      requireUser: async () => currentUser,
      requireRole: async (...roles) => {
        if (!roles.includes(currentUser.role)) throw new AuthError(currentUser.role ? 'FORBIDDEN' : 'UNAUTHORIZED', '账号无权执行此操作');
        return currentUser;
      },
      assertInventoryView: user => { if (!user.canViewInventory) throw new AuthError('FORBIDDEN', '无权查看库存'); },
      assertWarehouseAccess: (user, warehouseId) => {
        if (user.role !== 'admin' && !db.prepare('SELECT 1 FROM user_warehouses WHERE userId=? AND warehouseId=?').get(user.id, warehouseId)) throw new AuthError('FORBIDDEN', '无权操作此仓库');
      },
      authErrorResponse: error => error instanceof AuthError
        ? NextResponse.json(helpers.errorResponse(error.code, error.message), { status: error.status })
        : null,
      warehouseScope: (user, warehouseId, alias = 'i') => {
        const conditions = [];
        const params = [];
        if (user.role !== 'admin') { conditions.push(`${alias}.warehouseId IN (SELECT warehouseId FROM user_warehouses WHERE userId=?)`); params.push(user.id); }
        if (warehouseId) { conditions.push(`${alias}.warehouseId=?`); params.push(warehouseId); }
        return { sql: conditions.length ? conditions.join(' AND ') : '1=1', params };
      },
    };
    const deps = { '@/lib/db': database, '@/lib/auth': auth, '@/lib/api-helpers': helpers, '@/lib/inventory-status': inventoryStatus };
    const statusRoute = load('src/app/api/inventory/status-records/route.ts', deps);
    const batchStatusRoute = load('src/app/api/inventory/status-records/batch/route.ts', deps);
    const transferRoute = load('src/app/api/transfers/route.ts', deps);
    const lookupRoute = load('src/app/api/inventory/lookup/route.ts', deps);

    async function call(route, method, body, expectedStatus, url = 'http://localhost/api/test') {
      const request = new NextRequest(url, method === 'GET'
        ? { method }
        : { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const response = await route[method](request);
      const payload = await response.json();
      assert.equal(response.status, expectedStatus, `${method} ${url}: ${JSON.stringify(payload)}`);
      return payload.data;
    }

    function createCustomRecord(machine, definitionId, capabilities = null, locationType = 'warehouse') {
      const id = `status-${machine.id}`;
      db.prepare(`INSERT INTO inventory_status_records(id,inventoryId,definitionId,definitionSnapshot,reason,location,responsiblePerson,warehouseId,createdBy,createdAt,locationType,allowSales,allowRentals,allowTransfers,allowSupplierReturns)
        VALUES (?,? ,?, '{}','测试状态','QA 位置','QA 管理员',?,'qa-admin','2026-11-12',?,?,?,?,?)`)
        .run(id, machine.id, definitionId, machine.warehouseId, locationType,
          capabilities?.sales == null ? null : Number(capabilities.sales),
          capabilities?.rentals == null ? null : Number(capabilities.rentals),
          capabilities?.transfers == null ? null : Number(capabilities.transfers),
          capabilities?.supplierReturns == null ? null : Number(capabilities.supplierReturns));
      db.prepare("UPDATE inventory SET status='custom',currentStatusRecordId=? WHERE id=?").run(id, machine.id);
      return id;
    }

    const initialRecordId = createCustomRecord(externalMachine, 'qa-paused');

    await call(statusRoute, 'POST', {
      inventoryId: singleRegisteredMachine.id, definitionId: 'qa-paused', reason: '', location: '', responsiblePerson: 'QA 管理员',
    }, 201);
    const singleStatus = db.prepare('SELECT * FROM inventory_status_records WHERE inventoryId=? AND closedAt IS NULL').get(singleRegisteredMachine.id);
    assert.deepEqual([singleStatus.allowSales, singleStatus.allowRentals, singleStatus.allowTransfers, singleStatus.allowSupplierReturns], [0, 0, 0, 0]);
    db.prepare("UPDATE inventory_status_definitions SET allowStockOperations=1 WHERE id='qa-paused'").run();
    assert.equal(eligible(singleRegisteredMachine.id, 'sales'), false, 'changing a status default does not grant operations to an existing machine');
    db.prepare("UPDATE inventory_status_definitions SET allowStockOperations=0 WHERE id='qa-paused'").run();

    await call(batchStatusRoute, 'POST', {
      action: 'register', inventoryIds: [batchRegisteredMachine.id], definitionId: 'qa-paused',
      reason: '', location: '', responsiblePerson: 'QA 管理员', remark: '',
    }, 201);
    const batchStatus = db.prepare('SELECT * FROM inventory_status_records WHERE inventoryId=? AND closedAt IS NULL').get(batchRegisteredMachine.id);
    assert.deepEqual([batchStatus.allowSales, batchStatus.allowRentals, batchStatus.allowTransfers, batchStatus.allowSupplierReturns], [0, 0, 0, 0]);
    const transition = await call(statusRoute, 'PATCH', {
      inventoryId: externalMachine.id,
      id: initialRecordId,
      action: 'transition',
      targetType: 'custom',
      targetDefinitionId: 'qa-consignment',
      locationType: 'external',
      location: '外部寄卖平台 A',
      responsiblePerson: 'QA 管理员',
      businessCapabilities: { sales: true, rentals: false, transfers: false, supplierReturns: false },
      resultNote: '维修完成，寄售到平台 A',
      remark: '单机业务权限测试',
    }, 200);
    const currentExternal = db.prepare('SELECT * FROM inventory_status_records WHERE id=?').get(transition.statusRecord.id);
    assert.equal(currentExternal.locationType, 'external');
    assert.deepEqual([currentExternal.allowSales, currentExternal.allowRentals, currentExternal.allowTransfers, currentExternal.allowSupplierReturns], [1, 0, 0, 0]);
    assert.equal(db.prepare('SELECT closedAt FROM inventory_status_records WHERE id=?').get(initialRecordId).closedAt != null, true, 'transition closes the previous status');
    assert.equal(db.prepare('SELECT warehouseId FROM inventory WHERE id=?').get(externalMachine.id).warehouseId, mainWarehouseId, 'external placement does not change the management warehouse');
    assert.equal(db.prepare(`SELECT ${inventoryStatus.warehouseStockSql('i')} AS counted FROM inventory i WHERE i.id=?`).get(externalMachine.id).counted, 0, 'external consignment is excluded from in-stock count and cost');

    function eligible(id, operation) {
      try { inventoryStatus.assertInventoryOperationEligible(id, operation); return true; }
      catch { return false; }
    }
    assert.equal(eligible(externalMachine.id, 'sales'), true, 'consignment is available for sales');
    for (const operation of ['rentals', 'transfers', 'supplierReturns']) assert.equal(eligible(externalMachine.id, operation), false, `consignment is not available for ${operation}`);
    for (const [context, expected] of [['sale', true], ['rental', false], ['transfer', false], ['supplier-return', false]]) {
      const result = await call(lookupRoute, 'GET', undefined, 200, `http://localhost/api/inventory/lookup?context=${context}&sn=${encodeURIComponent(externalMachine.sn)}`);
      assert.equal(result.items.some(item => item.id === externalMachine.id), expected, `${context} machine lookup honors per-machine eligibility`);
    }

    createCustomRecord(legacyMachine, 'qa-consignment', null, 'warehouse');
    assert.equal(eligible(legacyMachine.id, 'sales'), true, 'legacy rows fall back to status-wide allowStockOperations');
    assert.equal(db.prepare(`SELECT ${inventoryStatus.warehouseStockSql('i')} AS counted FROM inventory i WHERE i.id=?`).get(legacyMachine.id).counted, 1, 'company-internal custom status remains in the owned stock count');
    createCustomRecord(blockedMachine, 'qa-consignment', { sales: true, rentals: false, transfers: false, supplierReturns: false }, 'external');
    createCustomRecord(migratedExternalMachine, 'qa-consignment', null, 'external');
    db.prepare('DELETE FROM schema_migrations WHERE version=33').run();
    initDatabase(db);
    const migratedExternal = db.prepare('SELECT allowSales,allowRentals,allowTransfers,allowSupplierReturns FROM inventory_status_records WHERE inventoryId=? AND closedAt IS NULL').get(migratedExternalMachine.id);
    assert.deepEqual([migratedExternal.allowSales, migratedExternal.allowRentals, migratedExternal.allowTransfers, migratedExternal.allowSupplierReturns], [1, 0, 0, 0], 'migration defaults existing external records to sale-only');

    const preview = await call(transferRoute, 'POST', {
      action: 'preview', batches: [{ sourceWarehouseId: 'warehouse_east', inventoryIds: [blockedMachine.id] }],
    }, 200);
    assert.equal(preview.items[0].eligible, false);
    assert.match(preview.items[0].reason, /未开放调拨/);
    const tooManyIds = Array.from({ length: 201 }, (_, index) => `QA-MISSING-${index}`);
    await call(transferRoute, 'POST', {
      action: 'preview', batches: [{ sourceWarehouseId: 'warehouse_east', inventoryIds: tooManyIds }],
    }, 400);

    currentUser.id = 'qa-manager'; currentUser.role = 'warehouse_manager'; currentUser.canViewInventory = true;
    const beforeSuccessfulTransferCount = Number(db.prepare('SELECT COUNT(*) count FROM transfers').get().count);
    const created = await call(transferRoute, 'POST', {
      targetWarehouseId: 'warehouse_west',
      batches: [
        { sourceWarehouseId: mainWarehouseId, inventoryIds: [mainMachine.id] },
        { sourceWarehouseId: 'warehouse_east', inventoryIds: [eastMachine.id] },
      ],
      remark: '多来源仓 QA 测试',
    }, 201);
    assert.equal(created.transfers.length, 2, 'one transfer order is created for each source warehouse');
    assert.equal(Number(db.prepare('SELECT COUNT(*) count FROM transfers').get().count), beforeSuccessfulTransferCount + 2);
    assert.equal(Number(db.prepare("SELECT COUNT(*) count FROM transfer_items WHERE status='pending'").get().count), 2);
    assert.equal(db.prepare('SELECT status FROM inventory WHERE id=?').get(mainMachine.id).status, 'in_stock', 'manager request reserves but does not move stock');

    const beforeFailedTransferCount = Number(db.prepare('SELECT COUNT(*) count FROM transfers').get().count);
    const beforeFailedItemCount = Number(db.prepare('SELECT COUNT(*) count FROM transfer_items').get().count);
    await call(transferRoute, 'POST', {
      targetWarehouseId: 'warehouse_west',
      batches: [
        { sourceWarehouseId: mainWarehouseId, inventoryIds: [mainMachine.id] },
        { sourceWarehouseId: 'warehouse_east', inventoryIds: [blockedMachine.id] },
      ],
    }, 400);
    assert.equal(Number(db.prepare('SELECT COUNT(*) count FROM transfers').get().count), beforeFailedTransferCount, 'a later invalid batch rolls back earlier batch inserts');
    assert.equal(Number(db.prepare('SELECT COUNT(*) count FROM transfer_items').get().count), beforeFailedItemCount, 'batch rollback leaves no orphan items');

    currentUser.id = 'qa-manager'; currentUser.role = 'warehouse_manager';
    await call(transferRoute, 'POST', {
      targetWarehouseId: 'warehouse_west',
      batches: [{ sourceWarehouseId: 'warehouse_south', inventoryIds: [eastMachine.id] }],
    }, 403);
    currentUser.id = 'qa-viewer'; currentUser.role = 'viewer'; currentUser.canViewInventory = true;
    await call(transferRoute, 'POST', {
      targetWarehouseId: 'warehouse_west',
      batches: [{ sourceWarehouseId: mainWarehouseId, inventoryIds: [mainMachine.id] }],
    }, 403);

    currentUser.id = 'qa-admin'; currentUser.role = 'admin'; currentUser.canViewInventory = true;
    const pending = await call(statusRoute, 'PATCH', {
      inventoryId: externalMachine.id,
      id: currentExternal.id,
      action: 'restore',
      resultNote: '寄售结束，机器已收回总仓',
    }, 200);
    assert.equal(pending.status, 'in_stock', 'restore returns machine to warehouse stock');
    assert.equal(pending.currentStatusRecordId, null);
    assert.equal(eligible(externalMachine.id, 'sales'), true);
    assert.equal(eligible(externalMachine.id, 'rentals'), true);
    assert.equal(eligible(externalMachine.id, 'transfers'), true);
    assert.equal(eligible(externalMachine.id, 'supplierReturns'), true);

    assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
    assert.equal(db.pragma('foreign_key_check').length, 0);
    console.log('PASS inventory transfer/consignment: migrations 32-33, single and batch status permission snapshots, external sale-only status transition, restore to warehouse, legacy eligibility fallback, transfer preflight reasons, business lookups, multi-source transfer success and rollback, warehouse scope, viewer denial, SQLite integrity');
  } finally {
    db.close();
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
