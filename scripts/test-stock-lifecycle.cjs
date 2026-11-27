/** Real routes + real session authorization + disposable SQLite; only Next cookie context is supplied. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const { NextRequest } = require('next/server');
const root = path.resolve(__dirname, '..');
function load(relative, deps = {}) {
  const filename = path.join(root, relative);
  const code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }, fileName: filename }).outputText;
  const m = new Module(filename, module); m.filename = filename; m.paths = Module._nodeModulePaths(path.dirname(filename));
  const ordinary = m.require.bind(m); m.require = (name) => Object.hasOwn(deps, name) ? deps[name] : ordinary(name);
  m._compile(code, filename); return m.exports;
}
async function main() {
  const scratchParent = path.join(root, '.tmp'); fs.mkdirSync(scratchParent, { recursive: true });
  const scratch = fs.mkdtempSync(path.join(scratchParent, 'stock-lifecycle-'));
  const oldPath = process.env.INVENTORY_DB_PATH; process.env.INVENTORY_DB_PATH = path.join(scratch, 'inventory.db');
  let db;
  try {
    const database = load('src/lib/db.ts'); db = database.default;
    let token = null;
    const auth = load('src/lib/auth.ts', { '@/lib/db': database, '@/lib/api-helpers': load('src/lib/api-helpers.ts'), 'next/headers': { cookies: async () => ({ get: () => token ? { value: token } : undefined }) } });
    const deps = { '@/lib/db': database, '@/lib/auth': auth, '@/lib/api-helpers': load('src/lib/api-helpers.ts'), '@/lib/sku-brand': load('src/lib/sku-brand.ts'), '@/lib/sku-display': load('src/lib/sku-display.ts') };
    deps['@/lib/manual-sku-options'] = load('src/lib/manual-sku-options.ts');
    deps['@/lib/machine-scan'] = load('src/lib/machine-scan.ts');
    deps['@/lib/inventory-status'] = load('src/lib/inventory-status.ts', deps);
    deps['@/lib/rental-duration'] = load('src/lib/rental-duration.ts');
    deps['@/lib/rental-workspace'] = load('src/lib/rental-workspace.ts', deps);
    const routes = Object.fromEntries(['sales', 'purchase-orders', 'returns', 'sales-returns', 'after-sales'].map((name) => [name, load(`src/app/api/${name}/route.ts`, deps)]));
    for (const name of ['rentals', 'transfers', 'inventory/lookup']) routes[name] = load(`src/app/api/${name}/route.ts`, deps);
    async function call(name, method, body, expected = 200, query = '') {
      const request = new NextRequest(`http://localhost/api/${name}${query}`, { method, ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) });
      const oldError = console.error; if (expected >= 400) console.error = () => {};
      let response; try { response = await routes[name][method](request); } finally { console.error = oldError; }
      const payload = await response.json(); assert.equal(response.status, expected, `${name} ${method}: ${JSON.stringify(payload)}`); return payload.data;
    }
    for (const [name, route] of Object.entries(routes)) for (const method of ['GET', 'POST', 'PATCH', 'DELETE'].filter((m) => route[m])) await call(name, method, method === 'GET' || method === 'DELETE' ? undefined : {}, 401);
    db.prepare("INSERT INTO users(id, username, password, realName, role, status) VALUES ('lifecycle-admin', 'lifecycle-admin', 'test', '售后登记人', 'admin', 'active'), ('lifecycle-receiver', 'lifecycle-receiver', 'test', '签收核验人', 'admin', 'active'), ('lifecycle-handler', 'lifecycle-handler', 'test', '售后处理人', 'admin', 'active'), ('lifecycle-viewer', 'lifecycle-viewer', 'test', '只读用户', 'warehouse_manager', 'active')").run();
    token = auth.createSession('lifecycle-viewer');
    for (const name of ['sales', 'purchase-orders', 'returns', 'sales-returns', 'after-sales', 'rentals']) for (const method of ['GET', 'POST', 'PATCH', 'DELETE'].filter((m) => routes[name][m])) await call(name, method, method === 'GET' || method === 'DELETE' ? undefined : {}, 403);
    token = auth.createSession('lifecycle-admin');
    db.prepare("INSERT INTO suppliers(id,supplierName) VALUES ('supplier-life','链路供应商')").run();
    db.prepare("INSERT INTO sales_channels(id,channelName) VALUES ('channel-life','链路渠道')").run();
    const warehouse = db.prepare("SELECT id FROM warehouses WHERE status = 'active' ORDER BY isDefault DESC LIMIT 1").get().id;
    db.prepare("INSERT INTO warehouses(id,code,name,status) VALUES ('warehouse-lifecycle-qc', 'LIFE-QC', '链路测试分仓', 'active')").run();
    const item = (sn) => ({ brand: 'ThinkPad', model: 'X13', year: 2020, cpu: 'i5', ram: '16GB', storage: '512GB', sn, purchasePrice: 1000 });
    const purchase = (items, status = 'completed') => ({ supplierId: 'supplier-life', supplierOrderNo: 'EXT', purchaseDate: '2026-10-20', purchasedBy: '当前用户', status, warehouseId: warehouse, items });
    const order = await call('purchase-orders', 'POST', purchase(['LIFE-A', 'LIFE-B', 'LIFE-C', 'LIFE-E', 'LIFE-F', 'LIFE-G'].map(item)), 201);
    assert.equal(order.inventoryIds.length, 6);
    for (const id of order.inventoryIds) assert.equal(db.prepare('SELECT warehouseId FROM inventory WHERE id=?').get(id).warehouseId, warehouse);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM inventory_movements WHERE movementType='purchase_in' AND actorId='lifecycle-admin'").get().n, 6);
    assert.equal(db.prepare('SELECT createdBy,purchasedBy FROM purchase_orders WHERE id=?').get(order.id).createdBy, 'lifecycle-admin');
    const bySn = (sn) => db.prepare('SELECT * FROM inventory WHERE sn=?').get(sn);
    const saleBody = (sn, price = 1500) => ({ saleChannelId: 'channel-life', saleOrderNo: `SALE-${sn}`, saleDate: '2026-10-20', trackingNo: 'SF-LIFE', items: [{ inventoryId: bySn(sn).id, sellingPrice: price }], actorId: 'user_admin' });
    const sale = await call('sales', 'POST', saleBody('LIFE-A'), 201);
    assert.equal(db.prepare('SELECT createdBy FROM sales_records WHERE id=?').get(sale.id).createdBy, 'lifecycle-admin');
    const originalSnapshot = db.prepare('SELECT items FROM sales_records WHERE id=?').get(sale.id).items;
    assert.equal(JSON.parse(db.prepare('SELECT snapshot FROM sales_record_items WHERE salesRecordId=?').get(sale.id).snapshot).year, 2020);
    await call('sales', 'POST', saleBody('LIFE-A'), 400);
    await call('sales', 'PATCH', { id: sale.id, action: 'cancel', actorId: 'user_admin', cancelReason: '测试取消' });
    assert.equal(bySn('LIFE-A').status, 'in_stock');
    assert.equal(db.prepare('SELECT cancelledBy FROM sales_records WHERE id=?').get(sale.id).cancelledBy, 'lifecycle-admin');
    await call('sales', 'PATCH', { id: sale.id, action: 'cancel' });
    assert.equal(db.prepare("SELECT COUNT(*) n FROM inventory_movements WHERE movementType='sale_cancel' AND referenceId=?").get(sale.id).n, 1);
    const sale2 = await call('sales', 'POST', saleBody('LIFE-A', 1600), 201);
    const receipt = await call('sales-returns', 'POST', { sn: 'LIFE-A', warehouseId: warehouse, purchasePrice: 1100, reason: '不适用', remark: '原箱退回' }, 201);
    assert.equal(bySn('LIFE-A').status, 'in_stock');
    assert.equal(bySn('LIFE-A').purchasePrice, 1100);
    const receiptRow = db.prepare('SELECT * FROM return_receipts WHERE id=?').get(receipt.id);
    assert.equal(receiptRow.salesRecordId, sale2.id); assert.equal(receiptRow.receivedBy, 'lifecycle-admin');
    assert.equal(JSON.parse(receiptRow.snapshot).purchasePrice, 1000);
    assert.equal((await call('sales-returns', 'GET')).items[0].reason, '不适用');
    await call('sales-returns', 'POST', { sn: 'LIFE-A', warehouseId: warehouse }, 400);
    const sale3 = await call('sales', 'POST', saleBody('LIFE-A', 1700), 201);
    await call('sales', 'PATCH', { id: sale2.id, action: 'cancel' }, 400);
    assert.equal(bySn('LIFE-A').status, 'sold'); assert.equal(bySn('LIFE-A').sellingPrice, 1700);
    assert.equal(db.prepare('SELECT items FROM sales_records WHERE id=?').get(sale.id).items, originalSnapshot);
    await call('sales', 'PATCH', { id: sale3.id, action: 'cancel' });
    const returnSale = await call('sales', 'POST', saleBody('LIFE-B', 1900), 201);
    const soldItems = await call('after-sales', 'GET', undefined, 200, '?resource=sold-inventory&search=SALE-LIFE-B');
    assert.equal(soldItems.items[0].salesRecordId, returnSale.id);
    assert.equal(soldItems.items[0].originalSellingPrice, 1900);
    assert.equal(soldItems.items[0].originalPurchasePrice, 1000);
    const refund = await call('after-sales', 'POST', { inventoryId: bySn('LIFE-B').id, returnTrackingNo: 'SF-LIFE-REFUND-001', resolutionType: 'customer_return', customerName: 'must not be required', refundAmount: 1 }, 201);
    assert.equal(refund.status, 'resolved'); assert.equal(refund.inventoryId, bySn('LIFE-B').id);
    assert.equal(refund.salesRecordId, returnSale.id); assert.equal(refund.saleChannel, '链路渠道'); assert.equal(refund.sellingPrice, 1900);
    assert.equal(bySn('LIFE-B').status, 'in_stock'); assert.equal(bySn('LIFE-B').purchasePrice, 1000);
    assert.equal(bySn('LIFE-B').saleChannel, null); assert.equal(bySn('LIFE-B').saleOrderNo, null);
    const refundRecord = db.prepare('SELECT * FROM after_sale_records WHERE id=?').get(refund.id);
    assert.equal(refundRecord.customerName, ''); assert.equal(refundRecord.customerPhone, ''); assert.equal(refundRecord.refundAmount, 1900);
    assert.equal(refundRecord.issueType, ''); assert.equal(refundRecord.returnTrackingNo, 'SF-LIFE-REFUND-001');
    const refundReceipt = db.prepare('SELECT * FROM return_receipts WHERE id=?').get(refund.receiptId);
    assert.equal(refundReceipt.salesRecordId, returnSale.id); assert.equal(refundReceipt.purchasePrice, 1000);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM inventory_movements WHERE movementType='sales_return' AND referenceType='after_sale' AND referenceId=?").get(refund.id).n, 1);
    const refundDetails = await call('after-sales', 'GET', undefined, 200, '?search=链路渠道');
    assert(refundDetails.items.some((record) => record.id === refund.id && record.saleChannel === '链路渠道' && record.sellingPrice === 1900));
    assert.equal((await call('after-sales', 'GET', undefined, 200, '?search=SF-LIFE-REFUND-001')).items[0].id, refund.id);
    await call('after-sales', 'POST', { inventoryId: bySn('LIFE-B').id, issueType: '重复退货', resolutionType: 'customer_return' }, 404);
    const repairSale = await call('sales', 'POST', saleBody('LIFE-C', 1800), 201);
    const repair = await call('after-sales', 'POST', { inventoryId: bySn('LIFE-C').id, issueType: '通电后偶发黑屏，客户要求检修', returnTrackingNo: 'SF-LIFE-RETURN-001', resolutionType: 'repair' }, 201);
    assert.equal(repair.salesRecordId, repairSale.id); assert.equal(repair.saleChannel, '链路渠道'); assert.equal(repair.sellingPrice, 1800);
    assert.equal(bySn('LIFE-C').status, 'after_sale');
    const createdRepair = await call('after-sales', 'GET', undefined, 200, `?id=${repair.id}`);
    assert.equal(createdRepair.items[0].issueType, '通电后偶发黑屏，客户要求检修');
    assert.equal(createdRepair.items[0].returnTrackingNo, 'SF-LIFE-RETURN-001');
    assert.equal(createdRepair.items[0].createdByName, '售后登记人');
    assert.equal((await call('after-sales', 'GET', undefined, 200, '?search=SF-LIFE-RETURN-001')).items[0].id, repair.id);
    token = auth.createSession('lifecycle-receiver');
    await call('after-sales', 'PATCH', { id: repair.id, action: 'receive', condition: 123 }, 400);
    await call('after-sales', 'PATCH', { id: repair.id, action: 'receive', condition: '外观完好，电源口有轻微松动', note: '配件齐全；已连接电源复现黑屏' });
    const receivedRepair = await call('after-sales', 'GET', undefined, 200, `?id=${repair.id}`);
    assert.equal(receivedRepair.items[0].receivedByName, '签收核验人');
    assert.equal(receivedRepair.items[0].receivedCondition, '外观完好，电源口有轻微松动');
    assert.equal(receivedRepair.items[0].receivedNote, '配件齐全；已连接电源复现黑屏');
    assert.equal(db.prepare('SELECT stockStatus FROM after_sale_stock WHERE afterSaleId=?').get(repair.id).stockStatus, 'stored');
    await call('after-sales', 'PATCH', { id: repair.id, action: 'repair_complete', resolutionNote: '不应跳过处理人登记' }, 400);
    token = auth.createSession('lifecycle-handler');
    await call('after-sales', 'PATCH', { id: repair.id, action: 'start_processing', processingNote: '正在检查电源模块与主板' });
    const processingRepair = await call('after-sales', 'GET', undefined, 200, `?id=${repair.id}`);
    assert.equal(processingRepair.items[0].processingByName, '售后处理人');
    assert.equal(processingRepair.items[0].processingNote, '正在检查电源模块与主板');
    assert(processingRepair.items[0].processingAt);
    await call('after-sales', 'PATCH', { id: repair.id, action: 'update_progress', processingNote: '已定位为供电模块故障，等待替换件' });
    assert.equal((await call('after-sales', 'GET', undefined, 200, `?id=${repair.id}`)).items[0].processingNote, '已定位为供电模块故障，等待替换件');
    await call('after-sales', 'PATCH', { id: repair.id, action: 'repair_complete', resolutionNote: '维修完成' });
    assert.equal((await call('after-sales', 'GET', undefined, 200, `?id=${repair.id}`)).items[0].resolutionNote, '维修完成');
    assert.equal(bySn('LIFE-C').status, 'sold');
    const returnOrder = await call('returns', 'POST', { inventoryIds: [bySn('LIFE-B').id], returnReason: '质量问题', refundAmount: 1000 }, 201);
    assert.equal(bySn('LIFE-B').status, 'returning');
    await call('returns', 'PATCH', { id: returnOrder.id, action: 'complete' });
    assert.equal(bySn('LIFE-B').status, 'returned');
    assert.equal(db.prepare("SELECT COUNT(*) n FROM inventory_movements WHERE movementType='supplier_return' AND referenceId=? AND actorId='lifecycle-handler'").get(returnOrder.id).n, 1);
    // A movement failure must roll back inventory and its sale record together.
    db.exec("CREATE TRIGGER lifecycle_fail BEFORE INSERT ON inventory_movements WHEN NEW.movementType='sale' BEGIN SELECT RAISE(ABORT, 'forced lifecycle movement failure'); END");
    const before = db.prepare('SELECT COUNT(*) n FROM sales_records').get().n;
    await call('sales', 'POST', saleBody('LIFE-E'), 500);
    assert.equal(bySn('LIFE-E').status, 'in_stock'); assert.equal(db.prepare('SELECT COUNT(*) n FROM sales_records').get().n, before);
    db.exec('DROP TRIGGER lifecycle_fail');
    const draft = await call('purchase-orders', 'POST', purchase([item('LIFE-D')], 'draft'), 201);
    const draftDetail = await call('purchase-orders', 'GET', undefined, 200, `?id=${draft.id}`);
    await call('purchase-orders', 'PATCH', { ...purchase(draftDetail.items), id: draft.id, action: 'inbound' });
    assert.equal(bySn('LIFE-D').status, 'in_stock');
    assert.equal(db.prepare("SELECT COUNT(*) n FROM inventory_movements WHERE referenceId=? AND movementType='purchase_in'").get(draft.id).n, 1);
    const exchangeSale = await call('sales', 'POST', saleBody('LIFE-E', 2100), 201);
    const exchange = await call('after-sales', 'POST', {
      inventoryId: bySn('LIFE-E').id, issueType: '换货', resolutionType: 'exchange', returnTrackingNo: 'SF-LIFE-EX-IN-001',
    }, 201);
    const oldId = bySn('LIFE-E').id;
    const nextId = bySn('LIFE-D').id;
    const alternateId = bySn('LIFE-G').id;
    const detail = async (id) => (await call('after-sales', 'GET', undefined, 200, `?id=${id}`)).items[0];
    const exchangeAction = (action, fields = {}, expected = 200) => call('after-sales', 'PATCH', { id: exchange.id, action, ...fields }, expected);
    const eligibleFor = async (context, sn) => (await call('inventory/lookup', 'GET', undefined, 200, `?${new URLSearchParams({ context, sn })}`)).items;
    const shipmentMovements = (type) => db.prepare('SELECT COUNT(*) n FROM inventory_movements WHERE referenceId=? AND movementType=?').get(exchange.id, type).n;
    const exchangeQueues = ['exchange_receive', 'exchange_reserve', 'exchange_ship', 'exchange_dispose'];
    const assertExchangeQueue = async (stage) => {
      const work = await call('after-sales', 'GET', undefined, 200, '?status=todo&includeCounts=1');
      assert.equal(work.items.filter(row => row.id === exchange.id).length, stage ? 1 : 0, 'one work item until both delivery and original-machine disposition are done');
      for (const key of [...exchangeQueues, 'other_active']) {
        const queue = await call('after-sales', 'GET', undefined, 200, `?status=${key}`);
        assert.equal(queue.items.some(row => row.id === exchange.id), key === stage, `exchange must appear only in ${stage || 'history'}, checking ${key}`);
        assert.equal(work.queueCounts[key], queue.total, `count agrees with the actual ${key} queue`);
      }
    };

    await assertExchangeQueue('exchange_receive');
    await exchangeAction('reserve_exchange', { replacementInventoryId: nextId, expectedReplacementInventoryId: null }, 400);
    token = auth.createSession('lifecycle-receiver');
    await exchangeAction('receive');
    const receivedExchange = await detail(exchange.id);
    assert.equal(receivedExchange.status, 'received');
    assert.equal(receivedExchange.stockStatus, 'stored');
    assert.equal(receivedExchange.receivedCondition, null, 'no a priori quality assumed when receiving without condition');
    assert(receivedExchange.receivedAt);
    assert.equal(receivedExchange.receivedByName, '签收核验人');
    assert.equal(receivedExchange.latestActivityType, 'after_sale_receive');
    assert.equal(receivedExchange.latestActivityByName, '签收核验人');
    assert.equal(receivedExchange.processingAt, null);
    await assertExchangeQueue('exchange_reserve');
    await exchangeAction('receive', { condition: '重复签收' }, 400);
    await exchangeAction('update_condition', { condition: '外壳有擦痕' });
    await exchangeAction('update_condition', { note: '原装配件已核对' });
    const supplementedExchange = await detail(exchange.id);
    assert.deepEqual([supplementedExchange.receivedCondition, supplementedExchange.stockCondition, supplementedExchange.receivedNote, supplementedExchange.stockNote], ['外壳有擦痕', '外壳有擦痕', '原装配件已核对', '原装配件已核对']);
    assert.equal(supplementedExchange.receivedAt, receivedExchange.receivedAt);
    token = auth.createSession('lifecycle-handler');
    await exchangeAction('reserve_exchange', { replacementInventoryId: oldId, expectedReplacementInventoryId: null }, 400);
    await exchangeAction('ship_exchange', { shippingTrackingNo: 'SF-PRE-RESERVATION', confirmedReplacementSn: 'LIFE-D', expectedReplacementInventoryId: nextId }, 400);
    await exchangeAction('restock', { condition: '不应提前转库存' }, 400);
    await exchangeAction('exchange', { replacementInventoryId: nextId }, 400);
    db.exec("CREATE TRIGGER lifecycle_reserve_fail BEFORE INSERT ON inventory_movements WHEN NEW.movementType='after_sale_reserve' BEGIN SELECT RAISE(ABORT, 'forced reserve movement failure'); END");
    await exchangeAction('reserve_exchange', { replacementInventoryId: nextId, expectedReplacementInventoryId: null }, 500);
    const failedReservation = await detail(exchange.id);
    assert.deepEqual([failedReservation.status, failedReservation.processingAt, failedReservation.processingBy, failedReservation.reservedReplacementId], ['received', null, null, null]);
    assert.equal(shipmentMovements('after_sale_start_processing'), 0, 'a failing first reservation rolls back its processing audit too');
    db.exec('DROP TRIGGER lifecycle_reserve_fail');
    await exchangeAction('reserve_exchange', { replacementInventoryId: nextId, expectedReplacementInventoryId: null });
    const reservedExchange = await detail(exchange.id);
    assert.equal(reservedExchange.status, 'processing');
    assert(reservedExchange.processingAt);
    assert.equal(reservedExchange.processingByName, '售后处理人');
    assert.equal(shipmentMovements('after_sale_start_processing'), 1, 'first reservation records the handler without an explicit start step');
    assert.equal(reservedExchange.reservedReplacementId, nextId);
    assert.equal(reservedExchange.reservedReplacementSn, 'LIFE-D');
    const warehouseName = db.prepare('SELECT name FROM warehouses WHERE id = ?').get(warehouse).name;
    assert.equal(reservedExchange.originalWarehouseName, warehouseName);
    assert.equal(reservedExchange.replacementWarehouseName, warehouseName);
    assert.equal(reservedExchange.latestActivityType, 'after_sale_reserve');
    assert.equal(reservedExchange.latestActivityByName, '售后处理人');
    assert(reservedExchange.latestActivityAt);
    assert.equal(reservedExchange.replacementInventoryId, null, 'selecting B does not record an actual shipment');
    assert.equal(bySn('LIFE-D').status, 'in_stock', 'B physically remains in stock while reserved');
    assert.equal(bySn('LIFE-E').status, 'after_sale');
    assert.equal(shipmentMovements('exchange_out'), 0);
    await assertExchangeQueue('exchange_ship');
    const changeReservedSn = db.prepare('UPDATE inventory SET sn = ? WHERE id = ?');
    assert.throws(() => changeReservedSn.run('LIFE-D-INVALID-EDIT', nextId), /售后换货预留/);
    assert.equal(bySn('LIFE-D').id, nextId, 'the lock guards bypass attempts outside standard business endpoints');
    const [reservedInventory] = await eligibleFor('inventory', 'LIFE-D');
    assert.equal(reservedInventory.exchangeReservationId, exchange.id, 'B is still visible with its reservation');
    assert.equal(reservedInventory.allowStockOperations, false);
    for (const context of ['sale', 'rental', 'exchange', 'supplier-return', 'transfer']) {
      assert.equal((await eligibleFor(context, 'LIFE-D')).length, 0, `reserved B is ineligible for ${context}`);
    }
    await call('sales', 'POST', saleBody('LIFE-D'), 400);
    await call('returns', 'POST', { inventoryIds: [nextId], returnReason: '不应影响售后锁定', refundAmount: 1000 }, 400);
    await call('transfers', 'POST', { sourceWarehouseId: warehouse, targetWarehouseId: 'warehouse-lifecycle-qc', inventoryIds: [nextId] }, 400);
    await call('rentals', 'POST', { inventoryIds: [nextId], customerName: '租赁回归', customerPhone: '15500000000', customerAddress: '测试地址',
      handlerUserId: 'lifecycle-handler', salespersonName: '售后处理人', sourceType: 'offline', rentalStartDate: '2026-10-20', rentalEndDate: '2026-10-22', rentalUnitPrice: 100 }, 400);
    await exchangeAction('ship_exchange', { shippingTrackingNo: ' \t ', confirmedReplacementSn: 'LIFE-D', expectedReplacementInventoryId: nextId }, 400);
    await exchangeAction('ship_exchange', { shippingTrackingNo: 'SF-LIFE-EX-SHIP-001', expectedReplacementInventoryId: nextId }, 400);
    await exchangeAction('ship_exchange', { shippingTrackingNo: 'SF-LIFE-EX-SHIP-001', confirmedReplacementSn: 'LIFE-D' }, 400);
    await exchangeAction('ship_exchange', { shippingTrackingNo: 'SF-LIFE-EX-SHIP-001', confirmedReplacementSn: 'LIFE-E', expectedReplacementInventoryId: nextId }, 400);
    await exchangeAction('ship_exchange', { shippingTrackingNo: 'SF-LIFE-EX-SHIP-001', confirmedReplacementSn: 'LIFE', expectedReplacementInventoryId: nextId }, 400);
    await exchangeAction('ship_exchange', { shippingTrackingNo: ' sf-life-ex-in-001 ', confirmedReplacementSn: 'LIFE-D', expectedReplacementInventoryId: nextId }, 400);
    assert.equal((await detail(exchange.id)).reservedReplacementId, nextId, 'bad scan or tracking retains the reservation');
    assert.equal(bySn('LIFE-D').status, 'in_stock');
    assert.equal(shipmentMovements('exchange_out'), 0);

    // A second work order cannot reserve B; a failed switch must keep the current B.
    await call('sales', 'POST', saleBody('LIFE-F'), 201);
    const anotherExchange = await call('after-sales', 'POST', { inventoryId: bySn('LIFE-F').id, resolutionType: 'exchange' }, 201);
    const otherAction = (action, fields = {}, expected = 200) => call('after-sales', 'PATCH', { id: anotherExchange.id, action, ...fields }, expected);
    await otherAction('receive', { condition: ' ' });
    await otherAction('reserve_exchange', { replacementInventoryId: nextId, expectedReplacementInventoryId: null }, 400);
    assert.equal((await detail(anotherExchange.id)).status, 'received', 'a conflicting reservation does not start processing');
    await otherAction('reserve_exchange', { replacementInventoryId: alternateId, expectedReplacementInventoryId: null });
    await exchangeAction('reserve_exchange', { replacementInventoryId: alternateId, expectedReplacementInventoryId: nextId }, 400);
    assert.equal((await detail(exchange.id)).reservedReplacementId, nextId);
    await otherAction('cancel', {}, 400);
    assert.equal(bySn('LIFE-F').status, 'after_sale', 'unconfirmed cancellation keeps received A in after-sales');
    const stillReserved = await detail(anotherExchange.id);
    assert.equal(stillReserved.stockStatus, 'stored');
    assert.equal(stillReserved.reservedReplacementId, alternateId);
    assert.equal((await eligibleFor('exchange', 'LIFE-G')).length, 0, 'unconfirmed cancellation keeps B locked');
    await otherAction('cancel', { originalReturnedToCustomer: true });
    assert.equal(bySn('LIFE-F').status, 'sold');
    const cancelledExchange = await detail(anotherExchange.id);
    assert.equal(cancelledExchange.status, 'cancelled');
    assert.equal(cancelledExchange.stockStatus, 'released');
    assert.equal(cancelledExchange.reservedReplacementId, null);
    assert.equal((await eligibleFor('exchange', 'LIFE-G')).length, 1, 'cancellation unlocks B');

    token = auth.createSession('lifecycle-admin');
    await exchangeAction('reserve_exchange', { replacementInventoryId: alternateId, expectedReplacementInventoryId: nextId });
    const switchedReservation = await detail(exchange.id);
    assert.equal(switchedReservation.reservedReplacementId, alternateId);
    assert.equal(switchedReservation.processingAt, reservedExchange.processingAt);
    assert.equal(switchedReservation.processingByName, '售后处理人', 'a replacement change preserves the original start audit');
    assert.equal(shipmentMovements('after_sale_start_processing'), 1);
    assert.equal((await eligibleFor('exchange', 'LIFE-D')).length, 1, 'switching releases the old B');
    await exchangeAction('ship_exchange', { shippingTrackingNo: 'SF-STALE', confirmedReplacementSn: 'LIFE-G', expectedReplacementInventoryId: nextId }, 400);
    await exchangeAction('release_exchange', { expectedReplacementInventoryId: nextId }, 400);
    await exchangeAction('reserve_exchange', { replacementInventoryId: nextId, expectedReplacementInventoryId: null }, 400);
    assert.equal((await detail(exchange.id)).reservedReplacementId, alternateId, 'a stale tab cannot silently change or dispatch a new replacement');
    await exchangeAction('release_exchange', { expectedReplacementInventoryId: alternateId });
    assert.equal((await detail(exchange.id)).reservedReplacementId, null);
    assert.equal((await eligibleFor('exchange', 'LIFE-G')).length, 1, 'manual release returns B to selection');
    await assertExchangeQueue('exchange_reserve');
    await exchangeAction('reserve_exchange', { replacementInventoryId: nextId, expectedReplacementInventoryId: null });

    const shipment = { shippingTrackingNo: 'SF-LIFE-EX-SHIP-001', confirmedReplacementSn: ' life-d, ', expectedReplacementInventoryId: nextId, resolutionNote: '按原单换货' };
    const saleQuantityBefore = db.prepare('SELECT totalQuantity,totalAmount,totalCost,totalProfit FROM sales_records WHERE id=?').get(exchangeSale.id);
    db.exec("CREATE TRIGGER lifecycle_ship_fail BEFORE INSERT ON inventory_movements WHEN NEW.movementType='exchange_out' BEGIN SELECT RAISE(ABORT, 'forced shipment movement failure'); END");
    await exchangeAction('ship_exchange', shipment, 500);
    assert.equal(bySn('LIFE-D').status, 'in_stock');
    assert.equal((await detail(exchange.id)).reservedReplacementId, nextId, 'shipment failure rolls back the claimed lock');
    assert.equal(db.prepare("SELECT COUNT(*) n FROM sales_record_items WHERE salesRecordId=? AND itemType='exchange'").get(exchangeSale.id).n, 0);
    db.exec('DROP TRIGGER lifecycle_ship_fail');
    const exchangeResult = await exchangeAction('ship_exchange', shipment);
    assert.equal(exchangeResult.status, 'resolved');
    assert.equal(bySn('LIFE-E').status, 'after_sale', 'shipping B leaves A in after-sales custody');
    assert.equal(bySn('LIFE-E').purchasePrice, 1000);
    assert.equal(bySn('LIFE-D').status, 'sold'); assert.equal(bySn('LIFE-D').sellingPrice, 2100); assert.equal(bySn('LIFE-D').saleChannel, '链路渠道');
    const shippedExchange = await detail(exchange.id);
    assert.equal(shippedExchange.stockStatus, 'stored');
    assert.equal(shippedExchange.reservedReplacementId, null);
    assert.equal(shippedExchange.replacementInventoryId, nextId);
    assert.equal(shippedExchange.shippedReplacementTrackingNo, shipment.shippingTrackingNo);
    assert.equal(shippedExchange.replacementWarehouseName, warehouseName);
    assert.equal(shippedExchange.latestActivityType, 'exchange_out');
    assert.equal(shippedExchange.latestActivityByName, '售后登记人');
    assert(shippedExchange.resolvedAt);
    assert.equal((await call('after-sales', 'GET', undefined, 200, `?${new URLSearchParams({ search: shipment.shippingTrackingNo })}`)).items[0].id, exchange.id);
    assert.equal((await eligibleFor('inventory', 'LIFE-D'))[0].exchangeReservationId, null);
    assert((await call('after-sales', 'GET', undefined, 200, '?status=stored')).items.some(record => record.id === exchange.id));
    assert(!(await call('after-sales', 'GET', undefined, 200, '?status=active')).items.some(record => record.id === exchange.id));
    await assertExchangeQueue('exchange_dispose');
    const workspaceList = (filters = {}) => call('after-sales', 'GET', undefined, 200, `?${new URLSearchParams(filters)}`);
    const pendingDisposition = await workspaceList({
      scope: 'todo', resolutionType: 'exchange', progress: 'awaiting_original_disposition', location: 'stored', includeCounts: '1',
    });
    assert.deepEqual(pendingDisposition.items.map(record => record.id), [exchange.id]);
    assert.equal(pendingDisposition.workspaceCounts.resolutionType.exchange, 1);
    assert(!(await workspaceList({ scope: 'history', resolutionType: 'exchange' })).items.some(record => record.id === exchange.id), 'shipping B does not close the original-machine task');
    const exchangeItem = db.prepare("SELECT * FROM sales_record_items WHERE salesRecordId=? AND itemType='exchange'").get(exchangeSale.id);
    assert.equal(exchangeItem.inventoryId, nextId); assert.equal(exchangeItem.sellingPrice, 2100); assert.equal(exchangeItem.afterSaleId, exchange.id);
    assert.equal(exchangeItem.originalInventoryId, oldId);
    assert.deepEqual(db.prepare('SELECT totalQuantity,totalAmount,totalCost,totalProfit FROM sales_records WHERE id=?').get(exchangeSale.id), saleQuantityBefore, 'replacement does not add a business sale');
    await exchangeAction('ship_exchange', shipment, 400);
    await exchangeAction('cancel', {}, 400);
    assert.equal(shipmentMovements('exchange_out'), 1);
    assert.equal(shipmentMovements('exchange_in'), 0);
    await exchangeAction('restock', {}, 400);
    await exchangeAction('restock', { condition: '复检合格，可销售', note: '重新上架' });
    assert.equal(bySn('LIFE-E').status, 'in_stock');
    assert.equal(bySn('LIFE-E').purchasePrice, 1000);
    assert.equal(bySn('LIFE-E').sellingPrice, null);
    assert.equal(bySn('LIFE-D').status, 'sold');
    const restockedExchange = await detail(exchange.id);
    assert.equal(restockedExchange.stockStatus, 'restocked');
    assert.equal(restockedExchange.resolutionType, 'exchange');
    assert.equal(restockedExchange.resolvedAt, shippedExchange.resolvedAt);
    assert.equal(restockedExchange.shippedReplacementTrackingNo, shipment.shippingTrackingNo);
    await exchangeAction('restock', { condition: '重复操作' }, 400);
    assert.equal(shipmentMovements('exchange_out'), 1);
    assert(!(await call('after-sales', 'GET', undefined, 200, '?status=stored')).items.some(record => record.id === exchange.id));
    await assertExchangeQueue(null);
    assert.deepEqual((await workspaceList({ scope: 'history', resolutionType: 'exchange', progress: 'resolved' })).items.map(record => record.id), [exchange.id]);
    assert.deepEqual((await workspaceList({ scope: 'history', resolutionType: 'customer_return', progress: 'resolved' })).items.map(record => record.id), [refund.id], 'immediate refund belongs only in history');

    // The work queue must paginate its filtered results without filtering the queue counters.
    await call('sales', 'POST', saleBody('LIFE-A'), 201);
    await call('sales', 'POST', saleBody('LIFE-E'), 201);
    const queueRecord = async (sn) => call('after-sales', 'POST', {
      inventoryId: bySn(sn).id, resolutionType: 'repair', returnTrackingNo: `QA-QUEUE-${sn}`,
    }, 201);
    const awaiting = await queueRecord('LIFE-C');
    const received = await queueRecord('LIFE-E');
    const processing = await queueRecord('LIFE-A');
    const cancelled = await queueRecord('LIFE-D');
    for (const id of [received.id, processing.id]) {
      await call('after-sales', 'PATCH', { id, action: 'receive', condition: '外观完好' });
    }
    await call('after-sales', 'PATCH', { id: processing.id, action: 'start_processing' });
    await call('after-sales', 'PATCH', { id: cancelled.id, action: 'cancel' });
    const activeIds = [awaiting.id, received.id, processing.id];
    db.prepare('UPDATE after_sale_records SET createdAt = ? WHERE id IN (?, ?, ?)').run('2026-11-25 09:30:00', ...activeIds);
    const page1 = await call('after-sales', 'GET', undefined, 200, '?status=active&pageSize=2&includeCounts=1');
    const page2 = await call('after-sales', 'GET', undefined, 200, '?status=active&pageSize=2&page=2');
    assert.equal(page1.total, 3);
    assert.equal(page1.totalPages, 2);
    assert.deepEqual([...page1.items, ...page2.items].map(record => record.id), [...activeIds].sort().reverse());
    assert.equal(Object.hasOwn(page2, 'queueCounts'), false);
    const queueCounts = { all: 8, active: 3, created: 1, received: 1, processing: 1, stored: 2, resolved: 3, cancelled: 2,
      todo: 3, other_active: 3, exchange_receive: 0, exchange_reserve: 0, exchange_ship: 0, exchange_dispose: 0 };
    assert.deepEqual(page1.queueCounts, queueCounts);
    const otherActive = await call('after-sales', 'GET', undefined, 200, '?status=other_active');
    assert.deepEqual(otherActive.items.map(record => record.id).sort(), [...activeIds].sort());
    const stored = await call('after-sales', 'GET', undefined, 200, '?status=stored&includeCounts=1');
    assert.deepEqual(stored.items.map(record => record.id).sort(), [received.id, processing.id].sort());
    const filtered = await call('after-sales', 'GET', undefined, 200, '?status=stored&search=QA-QUEUE-LIFE-E&includeCounts=1');
    assert.deepEqual(filtered.items.map(record => record.id), [received.id]);
    assert.equal(filtered.total, 1);
    assert.deepEqual(filtered.queueCounts, queueCounts);
    const history = await call('after-sales', 'GET', undefined, 200, '?status=cancelled');
    assert.deepEqual(history.items.map(record => record.id).sort(), [cancelled.id, anotherExchange.id].sort());
    const todoWorkspace = await workspaceList({ scope: 'todo', includeCounts: '1' });
    const historyWorkspace = await workspaceList({ scope: 'history', includeCounts: '1' });
    assert.equal(todoWorkspace.total + historyWorkspace.total, queueCounts.all);
    assert(!todoWorkspace.items.some(record => historyWorkspace.items.some(other => other.id === record.id)));
    assert.deepEqual(todoWorkspace.workspaceCounts, {
      scope: { todo: 3, history: 5, all: 8 },
      resolutionType: { repair: 3, exchange: 0, customer_return: 0 },
    });
    assert.deepEqual(historyWorkspace.workspaceCounts, {
      scope: { todo: 3, history: 5, all: 8 },
      resolutionType: { repair: 2, exchange: 2, customer_return: 1 },
    });
    const matchingRepair = await workspaceList({
      scope: 'todo', resolutionType: 'repair', progress: 'awaiting_repair', location: 'stored',
      search: 'QA-QUEUE-LIFE-E', includeCounts: '1',
    });
    assert.deepEqual(matchingRepair.items.map(record => record.id), [received.id]);
    assert.deepEqual(matchingRepair.workspaceCounts, todoWorkspace.workspaceCounts, 'filters do not alter the scope or type totals');
    assert.deepEqual((await workspaceList({ scope: 'todo', resolutionType: 'repair', progress: 'repairing' })).items.map(record => record.id), [processing.id]);
    assert.equal((await workspaceList({ scope: 'todo', progress: 'awaiting_receipt', location: 'stored' })).total, 0, 'waiting for receipt and physical storage are separate filters');
    for (const param of ['scope', 'resolutionType', 'progress', 'location']) {
      await call('after-sales', 'GET', undefined, 400, `?${param}=constructor`);
    }

    // Older databases can contain refund work registered before the current direct-completion entry.
    db.prepare("UPDATE after_sale_records SET resolutionType = 'customer_return' WHERE id IN (?, ?)").run(received.id, processing.id);
    assert.deepEqual((await workspaceList({ scope: 'todo', resolutionType: 'customer_return', progress: 'awaiting_refund_review', location: 'stored' })).items.map(record => record.id), [received.id]);
    assert.deepEqual((await workspaceList({ scope: 'todo', resolutionType: 'customer_return', progress: 'awaiting_refund_completion', location: 'stored' })).items.map(record => record.id), [processing.id]);
    assert.equal((await workspaceList({ scope: 'todo', resolutionType: 'repair', progress: 'awaiting_repair' })).total, 0);
    db.prepare("UPDATE after_sale_records SET resolutionType = 'repair' WHERE id IN (?, ?)").run(received.id, processing.id);

    db.prepare('UPDATE after_sale_records SET deleted = 1 WHERE id = ?').run(cancelled.id);
    const afterRemoval = await call('after-sales', 'GET', undefined, 200, '?status=cancelled&includeCounts=1');
    assert.deepEqual(afterRemoval.items.map(record => record.id), [anotherExchange.id]);
    assert.deepEqual(afterRemoval.queueCounts, { ...queueCounts, all: 7, cancelled: 1 });
    assert.equal(db.pragma('integrity_check', { simple: true }), 'ok'); assert.deepEqual(db.pragma('foreign_key_check'), []);
    console.log('PASS real SQLite lifecycle: authorization, purchase/inbound, sale and refund, optional receiving condition, exclusive exchange queues, direct reservation with audit and rollback, physical SN and tracking verification, separate return to stock, pagination, FK/integrity');
  } finally {
    if (db?.open) db.close(); if (oldPath === undefined) delete process.env.INVENTORY_DB_PATH; else process.env.INVENTORY_DB_PATH = oldPath;
    assert(path.resolve(scratch).startsWith(path.resolve(scratchParent) + path.sep)); fs.rmSync(scratch, { recursive: true, force: true });
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
