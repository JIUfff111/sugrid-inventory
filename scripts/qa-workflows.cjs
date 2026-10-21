// Temporary, clearly marked records for verifying the browser workflows on the running service.
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const manifestPath = path.join(__dirname, '..', 'data', 'qa-workflows.json');
const dbPath = path.join(__dirname, '..', 'data', 'inventory.db');
const tables = ['suppliers', 'sales_channels', 'purchase_orders', 'purchase_items', 'inventory', 'sales_records'];
const snapshot = (db) => Object.fromEntries(tables.map((table) => [table, db.prepare(`SELECT * FROM ${table} ORDER BY id`).all()]));
async function request(route, body) {
  const response = await fetch('http://localhost:3000/api/' + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const result = await response.json();
  if (!response.ok || !result.success) throw new Error(JSON.stringify(result));
  return result.data;
}
(async () => {
  const db = new Database(dbPath);
  db.pragma('foreign_keys = ON');
  if (process.argv[2] === 'setup') {
    if (fs.existsSync(manifestPath)) throw new Error('Existing QA manifest must be cleaned first');
    const tag = 'QA-' + Date.now();
    const manifest = { tag, baseline: snapshot(db) };
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    const remember = (update) => { Object.assign(manifest, update); fs.writeFileSync(manifestPath, JSON.stringify(manifest)); };
    const supplier = await request('suppliers', { supplierName: '交互验证供应商-' + tag, remark: tag });
    remember({ supplierId: supplier.id });
    const channel = await request('sales-channels', { channelName: '交互验证渠道-' + tag, remark: tag });
    remember({ channelId: channel.id, channelName: channel.channelName });
    const date = new Date().toLocaleDateString('sv-SE');
    const order = await request('purchase-orders', { supplierId: supplier.id, supplierOrderNo: tag, purchaseDate: date, purchasedBy: '当前用户', remark: tag, status: 'draft', items: [1, 2].map((n) => ({ productType: '笔记本电脑', brand: 'ThinkPad', model: 'X13 Gen 2 (Intel)', year: 2021, cpu: 'Core i5-1135G7', ram: '16GB', gpu: '集显', storage: '512GB', screen: '1920×1080', sn: tag + '-' + n, purchasePrice: 1800, remark: tag })) });
    remember({ orderId: order.id, purchaseNo: order.purchaseNo, saleOrderNo: tag + '-SALE', sn: tag + '-1' });
    console.log(JSON.stringify({ tag, purchaseNo: order.purchaseNo, channelName: channel.channelName, sn: manifest.sn, saleOrderNo: manifest.saleOrderNo }));
  } else if (process.argv[2] === 'status') {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    console.log(JSON.stringify({ order: db.prepare('SELECT purchaseNo,isInbounded FROM purchase_orders WHERE id=?').get(manifest.orderId), inventory: db.prepare('SELECT sn,status,sellingPrice FROM inventory WHERE purchaseOrderId=?').all(manifest.orderId), sales: db.prepare('SELECT saleOrderNo,trackingNo,totalQuantity,totalAmount FROM sales_records WHERE saleOrderNo=?').all(manifest.saleOrderNo) }));
  } else if (process.argv[2] === 'cleanup') {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const supplier = db.prepare('SELECT remark FROM suppliers WHERE id=?').get(manifest.supplierId);
    if (supplier && supplier.remark !== manifest.tag) throw new Error('QA supplier identity mismatch');
    db.transaction(() => {
      db.prepare('DELETE FROM sales_records WHERE saleOrderNo=?').run(manifest.saleOrderNo);
      db.prepare('DELETE FROM inventory WHERE purchaseOrderId=? AND remark=?').run(manifest.orderId, manifest.tag);
      db.prepare('DELETE FROM purchase_items WHERE purchaseOrderId=? AND remark=?').run(manifest.orderId, manifest.tag);
      db.prepare('DELETE FROM purchase_orders WHERE id=? AND remark=?').run(manifest.orderId, manifest.tag);
      db.prepare('DELETE FROM suppliers WHERE id=? AND remark=?').run(manifest.supplierId, manifest.tag);
      db.prepare('DELETE FROM sales_channels WHERE id=? AND remark=?').run(manifest.channelId, manifest.tag);
    })();
    const final = snapshot(db);
    const changed = tables.filter((table) => JSON.stringify(final[table]) !== JSON.stringify(manifest.baseline[table]));
    console.log(JSON.stringify({ cleanup: 'complete', originalDataChanged: changed, integrity: db.pragma('integrity_check') }));
    fs.unlinkSync(manifestPath);
    if (changed.length) process.exitCode = 1;
  } else throw new Error('Use setup or cleanup');
  db.close();
})().catch((error) => { console.error(error); process.exitCode = 1; });
