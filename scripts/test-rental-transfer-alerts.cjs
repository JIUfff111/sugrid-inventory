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
    const deps = {
      '@/lib/db': database,
      '@/lib/auth': auth,
      '@/lib/api-helpers': helpers,
      '@/lib/sku-brand': load('src/lib/sku-brand.ts'),
      '@/lib/sku-display': load('src/lib/sku-display.ts'),
      '@/lib/manual-sku-options': load('src/lib/manual-sku-options.ts'),
      '@/lib/rental-order-groups': load('src/lib/rental-order-groups.ts'),
      '@/lib/rental-duration': load('src/lib/rental-duration.ts'),
    };
    deps['@/lib/product-name'] = load('src/lib/product-name.ts', deps);
    deps['@/lib/inventory-status'] = load('src/lib/inventory-status.ts', deps);
    const { groupRentalsByOrder } = deps['@/lib/rental-order-groups'];
    const threeMachines = [1, 2, 3].map((number) => ({
      id: `rental-${number}`,
      rentalOrderId: 'order-three-machines',
      displayRentalNo: '租20261110001',
      rentalNo: `machine-rental-${number}`,
    }));
    const groupedThreeMachines = groupRentalsByOrder(threeMachines);
    assert.equal(groupedThreeMachines.length, 1, 'three machines from one order should render as one order row');
    assert.equal(groupedThreeMachines[0].items.length, 3);
    const legacyGroup = groupRentalsByOrder(threeMachines.map((rental) => ({ ...rental, rentalOrderId: null })));
    assert.equal(legacyGroup.length, 1, 'legacy rows with the same displayed order number should stay grouped');
    const routes = Object.fromEntries(['purchase-orders', 'sales', 'sales-returns', 'after-sales', 'rentals', 'transfers', 'alerts', 'warehouses']
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

    db.prepare("INSERT INTO users(id, username, password, realName, role, status) VALUES ('flow-admin', 'flow-admin', 'test', '流程管理员', 'admin', 'active'), ('flow-manager', 'flow-manager', 'test', '分仓用户', 'warehouse_manager', 'active')").run();
    token = auth.createSession('flow-admin');
    db.prepare("INSERT INTO suppliers(id, supplierName) VALUES ('flow-supplier', '流程测试供应商')").run();
    db.prepare("INSERT INTO sales_channels(id, channelName) VALUES ('flow-channel', '流程测试渠道')").run();
    const mainWarehouse = db.prepare("SELECT id FROM warehouses WHERE status='active' AND isDefault=1").get().id;
    const targetWarehouse = await call('warehouses', 'POST', { name: '流程回归目标仓', code: 'FLOW-TARGET' }, 201);
    db.prepare('INSERT INTO user_warehouses(userId, warehouseId, createdBy, createdAt) VALUES (?, ?, ?, ?)').run('flow-manager', mainWarehouse, 'flow-admin', new Date().toISOString());
    const chinaToday = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const shiftDate = (days) => new Date(Date.parse(`${chinaToday}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);

    const sns = ['RTN-RETURN', 'RTN-D3', 'RTN-TODAY', 'RTN-OVERDUE', 'RTN-OUTSIDE', 'RTN-AFTERSALE', 'TRF-MACHINE', 'RTN-BATCH-1', 'RTN-BATCH-2', 'RTN-BUYOUT-REVERSAL', 'RTN-APPEND-BASE', 'RTN-APPEND-ADDED', 'RTN-APPEND-ROLLBACK', 'RTN-APPEND-ENDED'];
    const purchase = await call('purchase-orders', 'POST', {
      supplierId: 'flow-supplier', supplierOrderNo: 'FLOW-PO', purchaseDate: chinaToday, purchasedBy: 'flow-admin',
      status: 'completed', warehouseId: mainWarehouse,
      items: sns.map((sn) => ({ productType: 'laptop', brand: 'ThinkPad', model: 'X13', year: 2020, cpu: 'i5', ram: '16GB', storage: '512GB', screen: '13.3', sn, purchasePrice: 1000 })),
    }, 201);
    assert.equal(purchase.inventoryIds.length, sns.length);
    const inventory = (sn) => db.prepare('SELECT * FROM inventory WHERE sn=?').get(sn);
    db.prepare(`INSERT INTO rental_records
      (id,rentalNo,inventoryId,sn,brand,model,config,purchasePrice,customerName,customerPhone,customerAddress,rentalStartDate,rentalEndDate,rentalType,rentalUnitPrice,rentalDuration,rentalTotalPrice,deposit,status,deleted,createdBy,createdAt,updatedAt)
      VALUES ('legacy-rental','租LEGACY0001',?,'RTN-OUTSIDE','ThinkPad','X13','16GB / 512GB',1000,'历史客户','10000000000','测试地址',?,?, 'day',10,1,10,100,'returned',0,'flow-admin',?,?)`)
      .run(inventory('RTN-OUTSIDE').id, chinaToday, chinaToday, chinaToday + ' 00:00:00', chinaToday + ' 00:00:00');
    db.prepare('DELETE FROM schema_migrations WHERE version = 13').run();
    db.exec('DROP TABLE rental_orders');
    database.initDatabase();
    const migratedLegacy = db.prepare('SELECT rentalOrderId FROM rental_records WHERE id = ?').get('legacy-rental');
    assert(migratedLegacy.rentalOrderId, 'legacy rental should receive a compatible one-machine rental order');
    assert.equal(db.prepare('SELECT rentalNo FROM rental_orders WHERE id = ?').get(migratedLegacy.rentalOrderId).rentalNo, '租LEGACY0001');
    const addRental = async (sn, endDate, customerName = '测试客户') => call('rentals', 'POST', {
      inventoryId: inventory(sn).id, customerName, customerPhone: '10000000000', customerAddress: '测试地址',
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
    await call('rentals', 'PATCH', {
      id: returnedRental.id, action: 'edit_terms', rentalStartDate: shiftDate(-30), rentalEndDate: shiftDate(4),
      reason: '已结束租赁不能更正', items: [{ id: returnedRental.id, rentalUnitPrice: 10 }],
    }, 400);
    const monthlyRental = await call('rentals', 'POST', {
      inventoryId: inventory('RTN-RETURN').id, customerName: '按月测试客户', customerPhone: '10000000000', customerAddress: '测试地址',
      rentalStartDate: '2026-01-31', rentalEndDate: '2026-02-28', rentalType: 'month', rentalUnitPrice: 100, deposit: 0,
    }, 201);
    assert.equal(monthlyRental.duration, 1, 'month-end anniversary should be one completed month');
    assert.equal(monthlyRental.totalPrice, 100);
    await call('rentals', 'PATCH', { id: monthlyRental.id, action: 'return', returnDate: chinaToday, returnType: '测试归还' });
    await call('rentals', 'POST', {
      inventoryId: inventory('RTN-RETURN').id, customerName: '零租期测试客户', customerPhone: '10000000000', customerAddress: '测试地址',
      rentalStartDate: chinaToday, rentalEndDate: chinaToday, rentalType: 'day', rentalUnitPrice: 10, deposit: 0,
    }, 400);

    const appendBase = await call('rentals', 'POST', {
      inventoryId: inventory('RTN-APPEND-BASE').id, customerName: '原租赁客户', customerPhone: '10000000001', customerAddress: '原租赁地址',
      rentalStartDate: shiftDate(-2), rentalEndDate: shiftDate(8), rentalType: 'day', rentalUnitPrice: 35, deposit: 80,
    }, 201);
    const appendBaseRow = db.prepare('SELECT * FROM rental_records WHERE id=?').get(appendBase.id);
    const appended = await call('rentals', 'POST', {
      rentalOrderId: appendBase.rentalOrderId,
      items: [{ inventoryId: inventory('RTN-APPEND-ADDED').id, rentalUnitPrice: 45, deposit: 120 }],
      customerName: '不应覆盖原客户', customerPhone: '10000000002', customerAddress: '不应覆盖原地址',
      rentalStartDate: chinaToday, rentalEndDate: shiftDate(10), rentalType: 'day',
    }, 201);
    assert.equal(appended.appended, true);
    assert.equal(appended.rentalOrderId, appendBase.rentalOrderId);
    assert.equal(appended.rentalNo, appendBase.rentalNo);
    assert.equal(appended.count, 1);
    const appendedRow = db.prepare('SELECT * FROM rental_records WHERE inventoryId=? AND status=?').get(inventory('RTN-APPEND-ADDED').id, 'renting');
    assert.equal(appendedRow.rentalNo, `${appendBase.rentalNo}-02`);
    assert.deepEqual([appendedRow.customerName, appendedRow.customerPhone, appendedRow.customerAddress], ['原租赁客户', '10000000001', '原租赁地址']);
    assert.deepEqual([appendedRow.rentalStartDate, appendedRow.rentalEndDate, appendedRow.rentalUnitPrice, appendedRow.rentalDuration, appendedRow.rentalTotalPrice, appendedRow.deposit], [chinaToday, shiftDate(10), 45, 10, 450, 120]);
    assert.equal(inventory('RTN-APPEND-ADDED').status, 'renting');
    assert.equal(db.prepare("SELECT COUNT(*) n FROM inventory_movements WHERE inventoryId=? AND movementType='rental_out' AND note LIKE '追加租赁出库%' ").get(inventory('RTN-APPEND-ADDED').id).n, 1);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM rental_events WHERE rentalRecordId=? AND eventType='item_added'").get(appendedRow.id).n, 1);
    assert.deepEqual(db.prepare('SELECT rentalStartDate,rentalEndDate FROM rental_orders WHERE id=?').get(appendBase.rentalOrderId), { rentalStartDate: shiftDate(-2), rentalEndDate: shiftDate(10) });
    await call('rentals', 'PATCH', {
      id: appendBase.id, action: 'edit_terms', rentalStartDate: chinaToday, rentalEndDate: shiftDate(10),
      reason: '异期机器不能整单更正', items: [{ id: appendBase.id, rentalUnitPrice: 35 }],
    }, 400);
    const orderBeforeAppendRollback = db.prepare('SELECT rentalStartDate,rentalEndDate FROM rental_orders WHERE id=?').get(appendBase.rentalOrderId);
    db.exec("CREATE TRIGGER flow_fail_append_event BEFORE INSERT ON rental_events WHEN NEW.eventType='item_added' BEGIN SELECT RAISE(ABORT, 'forced append audit failure'); END");
    await call('rentals', 'POST', {
      rentalOrderId: appendBase.rentalOrderId, items: [{ inventoryId: inventory('RTN-APPEND-ROLLBACK').id, rentalUnitPrice: 10, deposit: 0 }],
      rentalStartDate: chinaToday, rentalEndDate: shiftDate(12), rentalType: 'day',
    }, 500);
    db.exec('DROP TRIGGER flow_fail_append_event');
    assert.equal(inventory('RTN-APPEND-ROLLBACK').status, 'in_stock');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM rental_records WHERE inventoryId=?').get(inventory('RTN-APPEND-ROLLBACK').id).n, 0);
    assert.deepEqual(db.prepare('SELECT rentalStartDate,rentalEndDate FROM rental_orders WHERE id=?').get(appendBase.rentalOrderId), orderBeforeAppendRollback);
    await call('rentals', 'POST', {
      rentalOrderId: returnedRental.rentalOrderId, inventoryId: inventory('RTN-APPEND-ENDED').id,
      customerName: '结束订单不可追加', rentalStartDate: chinaToday, rentalEndDate: shiftDate(2), rentalType: 'day', rentalUnitPrice: 10,
    }, 400);
    assert.equal(inventory('RTN-APPEND-ENDED').status, 'in_stock');
    assert.equal(db.prepare('SELECT rentalStartDate,rentalEndDate FROM rental_records WHERE id=?').get(appendBase.id).rentalStartDate, appendBaseRow.rentalStartDate);

    const batchRental = await call('rentals', 'POST', {
      items: [
        { inventoryId: inventory('RTN-BATCH-1').id, rentalUnitPrice: 25, deposit: 100 },
        { inventoryId: inventory('RTN-BATCH-2').id, rentalUnitPrice: 40, deposit: 200 },
      ],
      customerName: '批量测试客户', customerPhone: '10000000000', customerAddress: '测试地址',
      rentalStartDate: chinaToday, rentalEndDate: shiftDate(2), rentalType: 'day',
    }, 201);
    assert.equal(batchRental.count, 2);
    assert.equal(batchRental.duration, 2, 'a 2-day range should not charge the start date twice');
    assert.equal(batchRental.totalPrice, 130);
    const batchItems = db.prepare('SELECT * FROM rental_records WHERE rentalOrderId = ? ORDER BY sn').all(batchRental.id);
    assert.equal(batchItems.length, 2);
    assert(batchItems.every(item => item.rentalNo !== batchRental.rentalNo));
    assert.deepEqual(batchItems.map(item => item.sn), ['RTN-BATCH-1', 'RTN-BATCH-2']);
    assert.equal(inventory('RTN-BATCH-1').status, 'renting');
    assert.equal(inventory('RTN-BATCH-2').status, 'renting');
    const batchList = await call('rentals', 'GET', undefined, 200, `?search=${encodeURIComponent(batchRental.rentalNo)}`);
    assert.equal(batchList.items.length, 2);
    assert(batchList.items.every(item => item.displayRentalNo === batchRental.rentalNo && item.orderMachineCount === 2));
    assert(batchList.items.every(item => item.rentalOrderId === batchRental.id));
    db.prepare('UPDATE rental_records SET rentalDuration=3,rentalTotalPrice=75 WHERE id=?').run(batchItems[0].id);
    const repairedLegacyTerms = await call('rentals', 'PATCH', {
      id: batchItems[0].id, action: 'edit_terms', rentalStartDate: chinaToday, rentalEndDate: shiftDate(2),
      reason: '回归测试：重算旧算法保存的租期总额', items: [{ id: batchItems[0].id, rentalUnitPrice: 25 }],
    });
    assert.equal(repairedLegacyTerms.rentalDuration, 2);
    assert.equal(db.prepare('SELECT rentalDuration,rentalTotalPrice FROM rental_records WHERE id=?').get(batchItems[0].id).rentalDuration, 2);
    assert.equal(db.prepare('SELECT rentalTotalPrice FROM rental_records WHERE id=?').get(batchItems[0].id).rentalTotalPrice, 50);
    const corrected = await call('rentals', 'PATCH', {
      id: batchItems[0].id, action: 'edit_terms', rentalStartDate: shiftDate(-1), rentalEndDate: shiftDate(2),
      reason: '回归测试：更正录入日期和租金',
      items: [{ id: batchItems[0].id, rentalUnitPrice: 30 }],
    });
    assert.equal(corrected.count, 2, 'a term correction applies to the entire order');
    assert.equal(corrected.rentalDuration, 3);
    const correctedRows = db.prepare('SELECT rentalStartDate,rentalEndDate,rentalDuration,rentalUnitPrice,rentalTotalPrice FROM rental_records WHERE rentalOrderId=? ORDER BY sn').all(batchRental.id);
    assert.deepEqual(correctedRows.map(item => [item.rentalStartDate, item.rentalEndDate, item.rentalDuration, item.rentalUnitPrice, item.rentalTotalPrice]), [
      [shiftDate(-1), shiftDate(2), 3, 30, 90], [shiftDate(-1), shiftDate(2), 3, 40, 120],
    ]);
    assert.equal(db.prepare('SELECT rentalStartDate,rentalEndDate FROM rental_orders WHERE id=?').get(batchRental.id).rentalStartDate, shiftDate(-1));
    assert.equal(db.prepare("SELECT COUNT(*) n FROM rental_events WHERE rentalOrderId=? AND eventType='terms_corrected'").get(batchRental.id).n, 4);
    db.exec("CREATE TRIGGER flow_fail_terms_event BEFORE INSERT ON rental_events WHEN NEW.eventType='terms_corrected' BEGIN SELECT RAISE(ABORT, 'forced terms audit failure'); END");
    await call('rentals', 'PATCH', {
      id: batchItems[0].id, action: 'edit_terms', rentalStartDate: shiftDate(-2), rentalEndDate: shiftDate(2),
      reason: '事务回滚测试', items: [{ id: batchItems[0].id, rentalUnitPrice: 31 }],
    }, 500);
    db.exec('DROP TRIGGER flow_fail_terms_event');
    const afterFailedCorrection = db.prepare('SELECT rentalStartDate,rentalEndDate,rentalDuration,rentalUnitPrice,rentalTotalPrice FROM rental_records WHERE rentalOrderId=? ORDER BY sn').all(batchRental.id);
    assert.deepEqual(afterFailedCorrection, correctedRows, 'failed audit insertion rolls back every machine term');
    assert.equal(db.prepare('SELECT rentalStartDate,rentalEndDate FROM rental_orders WHERE id=?').get(batchRental.id).rentalStartDate, shiftDate(-1));
    const renewedEndDate = shiftDate(4);
    const renewals = await call('rentals', 'PATCH', { action: 'renew_batch', items: batchItems.map((item, index) => ({
      id: item.id, newEndDate: renewedEndDate, billingUnit: 'day', priceMode: 'custom_total',
      totalAmount: index === 0 ? 80 : 100, depositDelta: index === 0 ? 25 : -20,
      depositChangeReason: '按续租约定调整押金', note: `批量续租 ${item.sn}`,
    })) });
    assert.equal(renewals.items.length, 2);
    assert(renewals.items.every(item => item.rentalEndDate === renewedEndDate));
    const renewalRows = db.prepare('SELECT * FROM rental_renewals WHERE batchId=? ORDER BY rentalRecordId').all(renewals.batchId);
    assert.equal(renewalRows.length, 2);
    assert.deepEqual(renewalRows.map(row => row.totalAmount).sort((a, b) => a - b), [80, 100]);
    assert(renewalRows.every(row => row.duration === 2));
    assert.equal(db.prepare('SELECT rentalDuration,rentalTotalPrice,deposit FROM rental_records WHERE id=?').get(batchItems[0].id).rentalDuration, 3);
    assert.equal(db.prepare('SELECT rentalTotalPrice,deposit FROM rental_records WHERE id=?').get(batchItems[0].id).rentalTotalPrice, 90);
    assert.equal(db.prepare('SELECT rentalTotalPrice,deposit FROM rental_records WHERE id=?').get(batchItems[0].id).deposit, 125);
    assert.equal(db.prepare('SELECT rentalTotalPrice,deposit FROM rental_records WHERE id=?').get(batchItems[1].id).rentalTotalPrice, 120);
    assert.equal(db.prepare('SELECT rentalTotalPrice,deposit FROM rental_records WHERE id=?').get(batchItems[1].id).deposit, 180);
    assert.equal(db.prepare('SELECT rentalEndDate FROM rental_orders WHERE id=?').get(batchRental.id).rentalEndDate, renewedEndDate);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM rental_events WHERE rentalRecordId=? AND eventType='renewed'").get(batchItems[1].id).n, 1);
    await call('rentals', 'PATCH', { action: 'renew', id: batchItems[0].id, newEndDate: shiftDate(5), priceMode: 'custom_total', totalAmount: '', note: '不应将空值作为零元续租' }, 400);
    await call('rentals', 'PATCH', { action: 'renew', id: batchItems[1].id, newEndDate: shiftDate(5), priceMode: 'custom_unit', unitPrice: '' }, 400);
    db.exec("CREATE TRIGGER flow_fail_renewal_event BEFORE INSERT ON rental_events WHEN NEW.eventType='renewed' BEGIN SELECT RAISE(ABORT, 'forced renewal audit failure'); END");
    await call('rentals', 'PATCH', { action: 'renew_batch', items: batchItems.map((item) => ({ id: item.id, newEndDate: shiftDate(5), priceMode: 'custom_total', totalAmount: 120, note: '事务回滚测试' })) }, 500);
    db.exec('DROP TRIGGER flow_fail_renewal_event');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM rental_renewals WHERE rentalRecordId IN (?,?)').get(...batchItems.map(item => item.id)).n, 2);
    assert.equal(db.prepare('SELECT rentalEndDate FROM rental_records WHERE id=?').get(batchItems[0].id).rentalEndDate, renewedEndDate);
    const singleRenewal = await call('rentals', 'PATCH', { id: batchItems[0].id, action: 'renew', newEndDate: shiftDate(5), priceMode: 'original_unit' });
    assert.equal(singleRenewal.renewalAmount, 30);
    assert.equal(singleRenewal.cumulativeRentalAmount, 200);
    assert.equal(db.prepare('SELECT rentalDuration,rentalTotalPrice FROM rental_records WHERE id=?').get(batchItems[0].id).rentalDuration, 3);
    assert.equal(db.prepare('SELECT rentalTotalPrice FROM rental_records WHERE id=?').get(batchItems[0].id).rentalTotalPrice, 90);
    await call('rentals', 'PATCH', {
      id: batchItems[0].id, action: 'edit_terms', rentalStartDate: shiftDate(-1), rentalEndDate: shiftDate(5),
      reason: '续租后不覆盖原条款', items: batchItems.map(item => ({ id: item.id, rentalUnitPrice: 30 })),
    }, 400);
    const followUp = '客户暂时无法归还，已约定明日联系';
    const exception = await call('rentals', 'PATCH', { id: batchItems[1].id, action: 'exception', note: followUp });
    assert.equal(exception.followUp, followUp);
    assert.equal(db.prepare("SELECT note FROM rental_events WHERE rentalRecordId=? AND eventType='exception_followup'").get(batchItems[1].id).note, followUp);
    token = auth.createSession('flow-manager');
    await call('rentals', 'PATCH', { id: batchItems[1].id, action: 'edit_terms' }, 403);
    await call('rentals', 'PATCH', { id: batchItems[1].id, action: 'exception', note: '分仓管不可写租赁历史' }, 403);
    token = auth.createSession('flow-admin');
    const salesBeforeFailedBuyout = Number(db.prepare('SELECT COUNT(*) n FROM sales_records').get().n);
    const movementsBeforeFailedBuyout = Number(db.prepare("SELECT COUNT(*) n FROM inventory_movements WHERE inventoryId=?").get(batchItems[1].inventoryId).n);
    const channelsBeforeBuyout = Number(db.prepare('SELECT COUNT(*) n FROM sales_channels').get().n);
    const channelUsageBeforeBuyout = Number(db.prepare("SELECT usageCount FROM sales_channels WHERE id='flow-channel'").get().usageCount);
    const buyoutInput = (id, saleOrderNo) => ({
      id, action: 'buyout', saleDate: chinaToday, sellingPrice: 1200, buyerName: '买断测试客户',
      buyoutSource: '个人·转介绍', saleOrderNo, depositRefundAmount: 50, depositAppliedAmount: 100,
      depositRetainedAmount: 30, settlementAdjustment: -20, settlementNote: '抵扣其他欠款并留存部分押金',
    });
    db.exec("CREATE TRIGGER flow_fail_buyout BEFORE INSERT ON sales_record_items BEGIN SELECT RAISE(ABORT, 'forced buyout item failure'); END");
    await call('rentals', 'PATCH', buyoutInput(batchItems[1].id, 'FLOW-RENTAL-BUYOUT-ROLLBACK'), 500);
    db.exec('DROP TRIGGER flow_fail_buyout');
    assert.equal(Number(db.prepare('SELECT COUNT(*) n FROM sales_records').get().n), salesBeforeFailedBuyout);
    assert.equal(Number(db.prepare("SELECT COUNT(*) n FROM inventory_movements WHERE inventoryId=?").get(batchItems[1].inventoryId).n), movementsBeforeFailedBuyout);
    assert.equal(db.prepare('SELECT status FROM rental_records WHERE id=?').get(batchItems[1].id).status, 'renting');
    assert.equal(inventory(batchItems[1].sn).status, 'renting');
    const boughtOut = await call('rentals', 'PATCH', buyoutInput(batchItems[1].id, 'FLOW-RENTAL-BUYOUT'));
    assert.equal(boughtOut.status, 'purchased');
    assert.equal(boughtOut.netDue, 1080);
    assert.equal(db.prepare('SELECT status, salesRecordId FROM rental_records WHERE id=?').get(batchItems[1].id).status, 'purchased');
    assert.equal(db.prepare('SELECT status, rentalRecordId, sellingPrice FROM inventory WHERE id=?').get(batchItems[1].inventoryId).status, 'sold');
    const storedBuyout = db.prepare('SELECT saleChannel,transactionType,buyoutBuyerName,buyoutSource,depositRefundAmount,depositAppliedAmount,depositRetainedAmount,settlementAdjustment,settlementNote FROM sales_records WHERE id=?').get(boughtOut.salesRecordId);
    assert.deepEqual(storedBuyout, { saleChannel: '租赁买断', transactionType: 'rental_buyout', buyoutBuyerName: '买断测试客户', buyoutSource: '个人·转介绍', depositRefundAmount: 50, depositAppliedAmount: 100, depositRetainedAmount: 30, settlementAdjustment: -20, settlementNote: '抵扣其他欠款并留存部分押金' });
    assert.equal(db.prepare("SELECT COUNT(*) n FROM sales_record_items WHERE salesRecordId=? AND inventoryId=?").get(boughtOut.salesRecordId, batchItems[1].inventoryId).n, 1);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM inventory_movements WHERE movementType='sale' AND referenceId=? AND inventoryId=?").get(boughtOut.salesRecordId, batchItems[1].inventoryId).n, 1);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM rental_events WHERE rentalRecordId=? AND eventType='buyout'").get(batchItems[1].id).n, 1);
    assert.equal(Number(db.prepare('SELECT COUNT(*) n FROM sales_channels').get().n), channelsBeforeBuyout, 'buyout must not create an ordinary channel');
    assert.equal(Number(db.prepare("SELECT usageCount FROM sales_channels WHERE id='flow-channel'").get().usageCount), channelUsageBeforeBuyout, 'buyout must not increment ordinary channel usage');
    await call('sales', 'PATCH', { id: boughtOut.salesRecordId, action: 'cancel' }, 400);
    await call('sales-returns', 'POST', { sn: batchItems[1].sn, reason: '普通销售退货不应处理租赁买断' }, 400);
    assert.equal(inventory(batchItems[1].sn).status, 'sold');
    const reversalRental = await addRental('RTN-BUYOUT-REVERSAL', shiftDate(5));
    const reversalBuyout = await call('rentals', 'PATCH', {
      id: reversalRental.id, action: 'buyout', saleDate: chinaToday, sellingPrice: 800, buyerName: '撤销测试客户',
      buyoutSource: '原租赁客户', depositRefundAmount: 100, depositAppliedAmount: 0, depositRetainedAmount: 0,
      saleOrderNo: 'FLOW-RENTAL-BUYOUT-REVERSAL',
    });
    await call('rentals', 'PATCH', { id: reversalRental.id, action: 'cancel_buyout', reason: '双方撤销买断约定' });
    assert.equal(db.prepare('SELECT status,salesRecordId FROM rental_records WHERE id=?').get(reversalRental.id).status, 'renting');
    assert.equal(inventory('RTN-BUYOUT-REVERSAL').status, 'renting');
    assert.equal(db.prepare('SELECT status FROM sales_records WHERE id=?').get(reversalBuyout.salesRecordId).status, 'cancelled');
    assert.equal(Number(db.prepare('SELECT COUNT(*) n FROM sales_channels').get().n), channelsBeforeBuyout, 'buyout reversals must not change ordinary channels');
    const firstReturn = await call('rentals', 'PATCH', { id: batchItems[0].id, action: 'return', returnDate: chinaToday, returnType: '正常归还' });
    assert.equal(firstReturn.status, 'returned');
    assert.equal(db.prepare('SELECT status FROM rental_records WHERE id=?').get(batchItems[0].id).status, 'returned');
    assert.equal(db.prepare('SELECT status FROM rental_records WHERE id=?').get(batchItems[1].id).status, 'purchased');
    assert.equal(inventory(batchItems[0].sn).status, 'in_stock');
    assert.equal(inventory(batchItems[1].sn).status, 'sold');
    const ordersBeforeRejectedBatch = Number(db.prepare('SELECT COUNT(*) n FROM rental_orders').get().n);
    await call('rentals', 'POST', {
      items: [
        { inventoryId: batchItems[0].inventoryId, rentalUnitPrice: 10, deposit: 0 },
        { inventoryId: batchItems[1].inventoryId, rentalUnitPrice: 10, deposit: 0 },
      ],
      customerName: '部分冲突回滚', customerPhone: '10000000000', customerAddress: '测试地址',
      rentalStartDate: chinaToday, rentalEndDate: shiftDate(1), rentalType: 'day',
    }, 400);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM rental_orders').get().n, ordersBeforeRejectedBatch);
    assert.equal(inventory(batchItems[0].sn).status, 'in_stock');
    await call('rentals', 'POST', {
      items: [{ inventoryId: inventory('RTN-BATCH-2').id, rentalUnitPrice: 10, deposit: 0 }, { inventoryId: inventory('RTN-BATCH-2').id, rentalUnitPrice: 10, deposit: 0 }],
      customerName: '重复机器', customerPhone: '10000000000', customerAddress: '测试地址', rentalStartDate: chinaToday, rentalEndDate: shiftDate(1), rentalType: 'day',
    }, 400);

    const dueThree = await addRental('RTN-D3', shiftDate(3), '王先生');
    const dueToday = await addRental('RTN-TODAY', chinaToday, '李女士');
    const overdue = await addRental('RTN-OVERDUE', shiftDate(-1), '赵先生');
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
    const afterSale = await call('after-sales', 'POST', { inventoryId: inventory('RTN-AFTERSALE').id, issueType: '系统测试：散热异常', returnTrackingNo: 'SF-FLOW-AFTERSALE-001', resolutionType: 'repair' }, 201);
    await call('after-sales', 'PATCH', { id: afterSale.id, action: 'receive', condition: '外观正常' });
    const groupedAlertSns = Array.from({ length: 33 }, (_, index) => `RTN-GROUP-${String(index + 1).padStart(2, '0')}`);
    await call('purchase-orders', 'POST', {
      supplierId: 'flow-supplier', supplierOrderNo: 'FLOW-PO-GROUPED-ALERT', purchaseDate: chinaToday,
      purchasedBy: 'flow-admin', status: 'completed', warehouseId: mainWarehouse,
      items: groupedAlertSns.map(sn => ({ productType: 'laptop', brand: 'ThinkPad', model: 'X13', year: 2020, cpu: 'i5', ram: '16GB', storage: '512GB', screen: '13.3', sn, purchasePrice: 1000 })),
    }, 201);
    const groupedAlertOrder = await call('rentals', 'POST', {
      items: groupedAlertSns.map(sn => ({ inventoryId: inventory(sn).id, rentalUnitPrice: 10, deposit: 0 })),
      customerName: '三十三台测试客户', customerPhone: '10000000000', customerAddress: '测试地址',
      rentalStartDate: shiftDate(-30), rentalEndDate: chinaToday, rentalType: 'day',
    }, 201);
    assert.equal(groupedAlertOrder.count, 33);
    const oldReceivedAt = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString().slice(0, 19).replace('T', ' ');
    db.prepare("UPDATE after_sale_records SET receivedAt=?, status='received' WHERE id=?").run(oldReceivedAt, afterSale.id);
    db.prepare("UPDATE after_sale_stock SET receivedAt=? WHERE afterSaleId=?").run(oldReceivedAt, afterSale.id);
    db.prepare("UPDATE rental_records SET customerName='' WHERE id=?").run(overdue.id);
    assert.equal(db.prepare('SELECT status FROM sales_records WHERE id=?').get(sale.id).status, 'completed');

    token = auth.createSession('flow-admin');
    const alerts = await call('alerts', 'GET', undefined);
    const alertIds = new Set(alerts.items.map((item) => item.id));
    assert(alertIds.has(`rental:${dueThree.rentalOrderId}`), 'rental order due in three days must alert');
    assert(alertIds.has(`rental:${dueToday.rentalOrderId}`), 'rental order due today must alert');
    assert(alertIds.has(`rental:${overdue.rentalOrderId}`), 'overdue rental order must alert');
    assert.match(alerts.items.find(item => item.id === `rental:${dueThree.rentalOrderId}`).title, /王先生/);
    assert.match(alerts.items.find(item => item.id === `rental:${dueToday.rentalOrderId}`).title, /李女士/);
    assert.match(alerts.items.find(item => item.id === `rental:${overdue.rentalOrderId}`).title, /未填写客户姓名/);
    assert(!alertIds.has(`rental:${returnedRental.rentalOrderId}`), 'returned rental must not alert');
    const outsideRentalOrderId = db.prepare("SELECT rentalOrderId FROM rental_records WHERE sn='RTN-OUTSIDE'").get().rentalOrderId;
    assert(!alertIds.has(`rental:${outsideRentalOrderId}`), 'rental due in four days must not alert');
    const groupedAlertItems = alerts.items.filter(item => item.kind === 'rental' && item.id === `rental:${groupedAlertOrder.rentalOrderId}`);
    assert.equal(groupedAlertItems.length, 1, '33 machines in one rental order should create one alert');
    assert.match(groupedAlertItems[0].title, /三十三台测试客户.*33 台/);
    const afterSaleAlert = alerts.items.find((item) => item.id === `after-sale:${afterSale.id}`);
    assert(afterSaleAlert, 'received after-sale machine past 24 hours must alert');
    assert.equal(afterSaleAlert.level, 'danger');
    assert.match(afterSaleAlert.title, /SF-FLOW-AFTERSALE-001/);
    assert(!afterSaleAlert.title.includes(afterSale.afterSaleNo), 'alert title should use the customer return tracking number, not the generated after-sale number');
    assert.match(afterSaleAlert.detail, new RegExp(afterSale.afterSaleNo));
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
    console.log('PASS real SQLite rental/transfer/alert regression: order grouping, legacy rental migration, multi-machine pricing, renewal, exception follow-up, buyout accounting and rollback, single-machine return, role checks, due alerts, transfer lifecycle, FK/integrity');
  } finally {
    if (db?.open) db.close();
    if (oldPath === undefined) delete process.env.INVENTORY_DB_PATH;
    else process.env.INVENTORY_DB_PATH = oldPath;
    assert(path.resolve(scratch).startsWith(path.resolve(scratchParent) + path.sep));
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
