/** Real rental/transfer/alert routes against a disposable SQLite database and real sessions. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const { NextRequest } = require('next/server');
const root = path.resolve(__dirname, '..');

function load(relative, deps = {}) {
  const filename = path.join(root, relative);
  const code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    fileName: filename,
  }).outputText;
  const loaded = new Module(filename, module);
  loaded.filename = filename;
  loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  const ordinaryRequire = loaded.require.bind(loaded);
  loaded.require = (name) => Object.hasOwn(deps, name) ? deps[name] : ordinaryRequire(name);
  loaded._compile(code, filename);
  return loaded.exports;
}

async function main() {
  const scratchParent = path.join(root, '.tmp');
  fs.mkdirSync(scratchParent, { recursive: true });
  const scratch = fs.mkdtempSync(path.join(scratchParent, 'rental-transfer-alerts-'));
  const oldPath = process.env.INVENTORY_DB_PATH;
  process.env.INVENTORY_DB_PATH = path.join(scratch, 'inventory.db');
  let db;
  try {
    const database = load('src/lib/db.ts');
    db = database.default;
    let token = null;
    const helpers = load('src/lib/api-helpers.ts');
    const auth = load('src/lib/auth.ts', {
      '@/lib/db': database,
      '@/lib/api-helpers': helpers,
      'next/headers': { cookies: async () => ({ get: () => token ? { value: token } : undefined }) },
    });
    const deps = { '@/lib/db': database, '@/lib/auth': auth, '@/lib/api-helpers': helpers, '@/lib/sku-brand': load('src/lib/sku-brand.ts'), '@/lib/sku-display': load('src/lib/sku-display.ts') };
    deps['@/lib/product-name'] = load('src/lib/product-name.ts', deps);
    deps['@/lib/inventory-status'] = load('src/lib/inventory-status.ts', deps);
    const routes = Object.fromEntries(['purchase-orders', 'sales', 'after-sales', 'rentals', 'transfers', 'alerts', 'warehouses']
      .map((name) => [name, load(`src/app/api/${name}/route.ts`, deps)]));

    async function call(name, method, body, expected = 200, query = '') {
      const request = new NextRequest(`http://localhost/api/${name}${query}`, {
        method,
        ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
      });
      const oldError = console.error;
      if (expected >= 400) console.error = () => {};
      let response;
      try { response = await routes[name][method](request); }
      finally { console.error = oldError; }
      const payload = await response.json();
      assert.equal(response.status, expected, `${name} ${method}: ${JSON.stringify(payload)}`);
      return payload.data;
    }

    for (const [name, route] of Object.entries(routes)) {
      for (const method of ['GET', 'POST', 'PATCH'].filter((candidate) => route[candidate])) {
        await call(name, method, method === 'GET' ? undefined : {}, 401);
      }
    }

    db.prepare("INSERT INTO users(id, username, password, role, status) VALUES ('flow-admin', 'flow-admin', 'test', 'admin', 'active'), ('flow-manager', 'flow-manager', 'test', 'warehouse_manager', 'active')").run();
    token = auth.createSession('flow-admin');
    db.prepare("INSERT INTO suppliers(id, supplierName) VALUES ('flow-supplier', '流程测试供应商')").run();
    db.prepare("INSERT INTO sales_channels(id, channelName) VALUES ('flow-channel', '流程测试渠道')").run();
    const mainWarehouse = db.prepare("SELECT id FROM warehouses WHERE status='active' AND isDefault=1").get().id;
    const targetWarehouse = await call('warehouses', 'POST', { name: '流程回归目标仓', code: 'FLOW-TARGET' }, 201);
    db.prepare('INSERT INTO user_warehouses(userId, warehouseId, createdBy, createdAt) VALUES (?, ?, ?, ?)').run('flow-manager', mainWarehouse, 'flow-admin', new Date().toISOString());
    const chinaToday = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const shiftDate = (days) => new Date(Date.parse(`${chinaToday}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);

    const sns = ['RTN-RETURN', 'RTN-D3', 'RTN-TODAY', 'RTN-OVERDUE', 'RTN-OUTSIDE', 'RTN-AFTERSALE', 'TRF-MACHINE'];
    const purchase = await call('purchase-orders', 'POST', {
      supplierId: 'flow-supplier', supplierOrderNo: 'FLOW-PO', purchaseDate: chinaToday, purchasedBy: 'flow-admin',
      status: 'completed', warehouseId: mainWarehouse,
      items: sns.map((sn) => ({ productType: 'laptop', brand: 'ThinkPad', model: 'X13', year: 2020, cpu: 'i5', ram: '16GB', storage: '512GB', screen: '13.3', sn, purchasePrice: 1000 })),
    }, 201);
    assert.equal(purchase.inventoryIds.length, sns.length);
    const inventory = (sn) => db.prepare('SELECT * FROM inventory WHERE sn=?').get(sn);
    const addRental = async (sn, endDate) => call('rentals', 'POST', {
      inventoryId: inventory(sn).id, customerName: '测试客户', customerPhone: '10000000000', customerAddress: '测试地址',
      rentalStartDate: shiftDate(-30), rentalEndDate: endDate, rentalType: 'day', rentalUnitPrice: 10, deposit: 100,
    }, 201);

    const returnedRental = await addRental('RTN-RETURN', shiftDate(4));
    assert.equal(inventory('RTN-RETURN').status, 'renting');
    assert.equal(db.prepare("SELECT COUNT(*) n FROM inventory_movements WHERE movementType='rental_out' AND referenceId=? AND actorId='flow-admin'").get(returnedRental.id).n, 1);
    const returnResult = await call('rentals', 'PATCH', { id: returnedRental.id, action: 'return', returnDate: chinaToday, returnType: '正常归还' });
    assert.equal(returnResult.status, 'returned');
    assert.equal(inventory('RTN-RETURN').status, 'in_stock');
    assert.equal(inventory('RTN-RETURN').rentalRecordId, null);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM inventory_movements WHERE movementType='rental_return' AND referenceId=? AND actorId='flow-admin'").get(returnedRental.id).n, 1);
    await call('rentals', 'PATCH', { id: returnedRental.id, action: 'return' }, 400);

    const dueThree = await addRental('RTN-D3', shiftDate(3));
    const dueToday = await addRental('RTN-TODAY', chinaToday);
    const overdue = await addRental('RTN-OVERDUE', shiftDate(-1));
    await addRental('RTN-OUTSIDE', shiftDate(4));
    await call('rentals', 'POST', {
      inventoryId: inventory('RTN-D3').id, customerName: '重复租赁', customerPhone: '10000000000', customerAddress: '测试地址',
      rentalStartDate: chinaToday, rentalEndDate: shiftDate(5), rentalType: 'day', rentalUnitPrice: 10, deposit: 0,
    }, 400);
    db.exec("CREATE TRIGGER flow_fail_rental_return BEFORE INSERT ON inventory_movements WHEN NEW.movementType='rental_return' BEGIN SELECT RAISE(ABORT, 'forced rental return movement failure'); END");
    await call('rentals', 'PATCH', { id: dueThree.id, action: 'return', returnDate: chinaToday, returnType: '测试回滚' }, 500);
    assert.equal(inventory('RTN-D3').status, 'renting');
    assert.equal(db.prepare('SELECT status, returnDate FROM rental_records WHERE id=?').get(dueThree.id).status, 'renting');
    assert.equal(db.prepare("SELECT COUNT(*) n FROM inventory_movements WHERE movementType='rental_return' AND referenceId=?").get(dueThree.id).n, 0);
    db.exec('DROP TRIGGER flow_fail_rental_return');

    const sale = await call('sales', 'POST', {
      saleChannelId: 'flow-channel', saleOrderNo: 'FLOW-SALE-AFTERSALE', saleDate: chinaToday,
      items: [{ inventoryId: inventory('RTN-AFTERSALE').id, sellingPrice: 1600 }],
    }, 201);
    const afterSale = await call('after-sales', 'POST', { inventoryId: inventory('RTN-AFTERSALE').id, issueType: '维修', resolutionType: 'repair' }, 201);
    await call('after-sales', 'PATCH', { id: afterSale.id, action: 'receive' });
    const oldReceivedAt = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString().slice(0, 19).replace('T', ' ');
    db.prepare("UPDATE after_sale_records SET receivedAt=?, status='received' WHERE id=?").run(oldReceivedAt, afterSale.id);
    db.prepare("UPDATE after_sale_stock SET receivedAt=? WHERE afterSaleId=?").run(oldReceivedAt, afterSale.id);
    assert.equal(db.prepare('SELECT status FROM sales_records WHERE id=?').get(sale.id).status, 'completed');

    token = auth.createSession('flow-admin');
    const alerts = await call('alerts', 'GET', undefined);
    const alertIds = new Set(alerts.items.map((item) => item.id));
    assert(alertIds.has(`rental:${dueThree.id}`), 'rental due in three days must alert');
    assert(alertIds.has(`rental:${dueToday.id}`), 'rental due today must alert');
    assert(alertIds.has(`rental:${overdue.id}`), 'overdue rental must alert');
    assert(!alertIds.has(`rental:${returnedRental.id}`), 'returned rental must not alert');
    assert(!alertIds.has(`rental:${db.prepare("SELECT id FROM rental_records WHERE sn='RTN-OUTSIDE'").get().id}`), 'rental due in four days must not alert');
    const afterSaleAlert = alerts.items.find((item) => item.id === `after-sale:${afterSale.id}`);
    assert(afterSaleAlert, 'received after-sale machine past 24 hours must alert');
    assert.equal(afterSaleAlert.level, 'danger');
    db.prepare('UPDATE after_sale_records SET receivedAt=? WHERE id=?').run(new Date(Date.now() - 23 * 60 * 60 * 1000).toISOString().slice(0, 19).replace('T', ' '), afterSale.id);
    const notYetOverdue = await call('alerts', 'GET', undefined);
    assert(!notYetOverdue.items.some((item) => item.id === `after-sale:${afterSale.id}`), 'received after-sale machine under 24 hours must not alert');
    db.prepare('UPDATE after_sale_records SET receivedAt=? WHERE id=?').run(oldReceivedAt, afterSale.id);
    await call('after-sales', 'PATCH', { id: afterSale.id, action: 'start_processing' });
    await call('after-sales', 'PATCH', { id: afterSale.id, action: 'repair_complete', resolutionNote: '回归测试完成' });
    const resolvedAlerts = await call('alerts', 'GET', undefined);
    assert(!resolvedAlerts.items.some((item) => item.id === `after-sale:${afterSale.id}`), 'resolved after-sale must no longer alert');

    token = auth.createSession('flow-manager');
    const ownTransfer = await call('transfers', 'POST', {
      sourceWarehouseId: mainWarehouse, targetWarehouseId: targetWarehouse.id, inventoryIds: [inventory('TRF-MACHINE').id],
    }, 201);
    assert.equal(ownTransfer.status, 'pending');
    const rejectedTransfer = await call('transfers', 'POST', {
      sourceWarehouseId: mainWarehouse, targetWarehouseId: targetWarehouse.id, inventoryIds: [inventory('RTN-RETURN').id],
    }, 201);
    await call('transfers', 'PATCH', { id: ownTransfer.id, action: 'approve' }, 403);
    await call('transfers', 'PATCH', { id: ownTransfer.id, action: 'complete' }, 403);
    await call('transfers', 'POST', {
      sourceWarehouseId: targetWarehouse.id, targetWarehouseId: mainWarehouse, inventoryIds: [inventory('TRF-MACHINE').id],
    }, 403);
    const managerTransfers = await call('transfers', 'GET', undefined);
    assert(managerTransfers.some((item) => item.id === ownTransfer.id), 'manager must be able to view the application they submitted');
    assert.equal(inventory('TRF-MACHINE').warehouseId, mainWarehouse);

    token = auth.createSession('flow-admin');
    await call('transfers', 'PATCH', { id: rejectedTransfer.id, action: 'reject' });
    assert.equal(db.prepare('SELECT status FROM transfers WHERE id=?').get(rejectedTransfer.id).status, 'rejected');
    assert.equal(inventory('RTN-RETURN').warehouseId, mainWarehouse);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM inventory_movements WHERE referenceType='transfer' AND referenceId=?").get(rejectedTransfer.id).n, 0);
    await call('transfers', 'PATCH', { id: ownTransfer.id, action: 'approve' });
    assert.equal(db.prepare('SELECT status FROM transfers WHERE id=?').get(ownTransfer.id).status, 'approved');
    await call('transfers', 'PATCH', { id: ownTransfer.id, action: 'start_transit' });
    const completed = await call('transfers', 'PATCH', { id: ownTransfer.id, action: 'complete' });
    assert.equal(completed.action, 'complete');
    assert.equal(db.prepare('SELECT status FROM transfers WHERE id=?').get(ownTransfer.id).status, 'completed');
    assert.equal(inventory('TRF-MACHINE').warehouseId, targetWarehouse.id);
    const transferMoves = db.prepare("SELECT movementType, warehouseId, fromWarehouseId, toWarehouseId, actorId FROM inventory_movements WHERE referenceType='transfer' AND referenceId=? ORDER BY rowid").all(ownTransfer.id);
    assert.deepEqual(transferMoves.map((item) => item.movementType), ['transfer_out', 'transfer_in']);
    assert.deepEqual(transferMoves.map((item) => item.warehouseId), [mainWarehouse, targetWarehouse.id]);
    assert(transferMoves.every((item) => item.fromWarehouseId === mainWarehouse && item.toWarehouseId === targetWarehouse.id && item.actorId === 'flow-admin'));

    // A movement write failure must roll back rental record creation and inventory status together.
    db.exec("CREATE TRIGGER flow_fail_rental BEFORE INSERT ON inventory_movements WHEN NEW.movementType='rental_out' BEGIN SELECT RAISE(ABORT, 'forced rental movement failure'); END");
    await call('rentals', 'POST', {
      inventoryId: inventory('TRF-MACHINE').id, customerName: '测试客户', customerPhone: '10000000000', customerAddress: '测试地址',
      rentalStartDate: chinaToday, rentalEndDate: shiftDate(5), rentalType: 'day', rentalUnitPrice: 10, deposit: 0,
    }, 500);
    assert.equal(inventory('TRF-MACHINE').status, 'in_stock');
    assert.equal(db.prepare("SELECT COUNT(*) n FROM rental_records WHERE inventoryId=?").get(inventory('TRF-MACHINE').id).n, 0);
    db.exec('DROP TRIGGER flow_fail_rental');

    assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
    assert.deepEqual(db.pragma('foreign_key_check'), []);
    console.log('PASS real SQLite rental/transfer/alert regression: rental return and movement, 3-day/today/overdue alerts, 24-hour after-sale alert, warehouse-manager transfer scope/approval denial, admin completion and paired movements, transaction rollback, FK/integrity');
  } finally {
    if (db?.open) db.close();
    if (oldPath === undefined) delete process.env.INVENTORY_DB_PATH;
    else process.env.INVENTORY_DB_PATH = oldPath;
    assert(path.resolve(scratch).startsWith(path.resolve(scratchParent) + path.sep));
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
