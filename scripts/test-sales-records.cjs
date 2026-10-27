/* Snapshot accounting and history regression checks. Uses a fresh in-memory SQLite database only. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const Database = require('better-sqlite3');
const { NextRequest } = require('next/server');
const { initDatabase, seedDatabase } = require('./database.cjs');
const root = path.resolve(__dirname,'..');
function load(relative, dependencies={}) {
  const file=path.join(root,relative);const instance=new Module(file,module);instance.filename=file;instance.paths=Module._nodeModulePaths(path.dirname(file));const standard=instance.require.bind(instance);
  instance.require=name=>Object.hasOwn(dependencies,name)?dependencies[name]:standard(name);
  instance._compile(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true},fileName:file}).outputText,file);return instance.exports;
}
async function main() {
  const db=new Database(':memory:');db.pragma('foreign_keys=ON');initDatabase(db);seedDatabase(db);
  const user=db.prepare("SELECT id FROM users WHERE role='admin' LIMIT 1").get().id;
  db.prepare("INSERT INTO suppliers (id,supplierName) VALUES ('sup-test','测试供应商')").run();
  db.prepare("INSERT INTO purchase_orders (id,purchaseNo,supplierOrderNo,supplierId,supplierName,purchaseDate,purchasedBy,createdBy) VALUES ('po','P-QA','P-EXT','sup-test','测试供应商','2026-10-01',?,?)").run(user,user);
  db.prepare("INSERT INTO warehouses (id,code,name,warehouseName,status) VALUES ('west','WEST','西仓','西仓','active')").run();
  const machines=[];
  for(let i=0;i<53;i++) {
    const id=`machine-${i}`,sn=`QA-SN-${String(i%2).repeat(4)}-${String(i).padStart(4,'0')}`;machines.push({id,sn});
    db.prepare("INSERT INTO purchase_items (id,purchaseOrderId,productType,brand,model,year,cpu,ram,storage,screen,sn,purchasePrice) VALUES (?,'po','笔记本','ThinkPad','X13',2020,'i5','16GB','512GB','13',?,100)").run(`pi-${i}`,sn);
    db.prepare("INSERT INTO inventory (id,purchaseOrderId,purchaseItemId,sn,productType,brand,model,year,cpu,ram,storage,screen,purchasePrice,supplierId,supplierName,inboundDate,warehouseId) VALUES (?,'po',?,?,'笔记本','错误现名','改写型号',2030,'改写CPU','64GB','2TB','13',9999,'sup-test','测试供应商','2026-10-01',?)").run(id,`pi-${i}`,sn,i%2?'west':'warehouse_main');
  }
  const snapshot=(machine,index)=>({inventoryId:machine.id,sn:machine.sn,brand:'ThinkPad',model:'X13',year:2020,cpu:'i5',ram:'16GB',storage:'512GB',warehouseId:index%2?'west':'warehouse_main',purchasePrice:100,sellingPrice:200,profit:100});
  function sale(id,indices,{cancelled=false,legacy=false,date='2026-10-20',channel='测试平台'}={}) {
    const lines=indices.map(i=>snapshot(machines[i],i));
    db.prepare('INSERT INTO sales_records (id,recordNo,saleChannel,saleOrderNo,saleDate,trackingNo,items,totalQuantity,totalCost,totalAmount,totalProfit,status,createdBy,createdAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id,`XS-${id}`,channel,`EXT-${id}`,date,`TRACK-${id}`,JSON.stringify(lines),lines.length,lines.length*100,lines.length*200,lines.length*100,cancelled?'cancelled':'completed',user,`${date} 10:00:00`);
    if(!legacy)for(const [i,line] of lines.entries())db.prepare('INSERT INTO sales_record_items (id,salesRecordId,saleRecordId,inventoryId,sn,purchasePrice,sellingPrice,profit,warehouseId,snapshot,createdAt) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(`${id}-${i}`,id,id,line.inventoryId,line.sn,line.purchasePrice,line.sellingPrice,line.profit,line.warehouseId,JSON.stringify(line),`${date} 10:00:00`);
  }
  for(let i=0;i<25;i++)sale(`order-${i}`,[i*2,i*2+1],{cancelled:i===0,legacy:i===1,date:i%2?'2026-09-20':'2026-10-20',channel:i%2?'平台B':'平台A'});
  sale('resold',[2],{date:'2026-10-21'});
  // Two consecutive exchanges are deliveries under the original sale, never fresh revenue.
  for(const [index,original] of [[50,4],[51,50]]) {
    const id=`after-${index}`,line={...snapshot(machines[index],index),itemType:'exchange',afterSaleId:id,originalInventoryId:machines[original].id};
    db.prepare("INSERT INTO after_sale_records (id,afterSaleNo,inventoryId,sn,salesRecordId,saleOrderNo,customerName,customerPhone,issueType,issueDescription,resolutionType,status,replacementInventoryId,refundAmount,createdBy,createdAt,updatedAt) VALUES (?,?,?,?,'order-2','EXT-order-2','','','质量问题','测试','exchange','resolved',?,200,?,'2026-10-22','2026-10-22')").run(id,`AS-${index}`,machines[original].id,machines[original].sn,machines[index].id,user);
    db.prepare('INSERT INTO sales_record_items (id,salesRecordId,saleRecordId,inventoryId,sn,purchasePrice,sellingPrice,profit,warehouseId,snapshot,afterSaleId,itemType,originalInventoryId,createdAt) VALUES (?,\'order-2\',\'order-2\',?,?,?,?,?,?,?,?,?,?,\'2026-10-22\')').run(`exchange-${index}`,line.inventoryId,line.sn,100,200,100,line.warehouseId,JSON.stringify(line),id,'exchange',line.originalInventoryId);
    const record=db.prepare("SELECT items FROM sales_records WHERE id='order-2'").get();db.prepare("UPDATE sales_records SET items=? WHERE id='order-2'").run(JSON.stringify([...JSON.parse(record.items),line]));
  }
  // Several after-sales records for the same order must not amplify sales lines.
  db.prepare("INSERT INTO after_sale_records (id,afterSaleNo,inventoryId,sn,salesRecordId,saleOrderNo,customerName,customerPhone,issueType,issueDescription,resolutionType,status,refundAmount,createdBy) VALUES ('repair','AS-repair',?,?,'order-2','EXT-order-2','','','质量','维修','repair','resolved',200,?)").run(machines[5].id,machines[5].sn,user);
  const brand=load('src/lib/sku-brand.ts');
  const productName=load('src/lib/product-name.ts',{'@/lib/sku-brand':brand});
  const service=load('src/lib/sales-records.ts',{'@/lib/product-name':productName,'@/lib/sku-display':load('src/lib/sku-display.ts')});
  const blank={search:'',dateFrom:'',dateTo:'',channel:'',warehouseId:'',status:''};
  // Optional normalized metadata must not blank a complete historical JSON snapshot.
  db.prepare("UPDATE sales_record_items SET snapshot=? WHERE id='order-2-0'").run(JSON.stringify({brand:null,model:null,warehouseId:null}));
  // Retained JSON/normalized duplicates describe one delivery, never a second sale.
  db.prepare("INSERT INTO sales_record_items (id,salesRecordId,saleRecordId,inventoryId,sn,purchasePrice,sellingPrice,profit,warehouseId,createdAt) SELECT 'duplicate-history',salesRecordId,saleRecordId,inventoryId,sn,purchasePrice,sellingPrice,profit,warehouseId,createdAt FROM sales_record_items WHERE id='order-2-0'").run();
  // The first schema migration omitted normalized exchange markers; JSON still preserves them.
  db.prepare("UPDATE sales_record_items SET afterSaleId=NULL,itemType='sale',originalInventoryId=NULL,snapshot=NULL WHERE id='exchange-50'").run();
  const all=service.querySalesRecords(db,blank);
  assert.equal(all.orders.length,26);assert.equal(all.machines.length,53);assert.deepEqual(all.summary,{quantity:49,amount:9800,cost:4900,profit:4900,orders:25,exchangeQuantity:2});
  assert(all.machines.every(line=>line.product==='ThinkPad X13 2020'&&line.purchasePrice===100));
  assert.equal(service.querySalesRecords(db,{...blank,search:'0002'}).machines.length,2,'resale events remain separate');
  assert.equal(service.querySalesRecords(db,{...blank,search:'TRACK-order-21'}).orders.length,1);
  assert.equal(service.querySalesRecords(db,{...blank,search:'ThinkPad X13 2020'}).machines.length,53);
  db.prepare("UPDATE inventory SET deleted=1,status='returned' WHERE id='machine-2'").run();
  const historicalSuggestions=service.salesSuggestions(db,'0002');assert.equal(historicalSuggestions.length,1);assert.equal(historicalSuggestions[0].status,'returned');assert.equal(historicalSuggestions[0].model,'ThinkPad X13 2020');
  assert.equal(service.querySalesRecords(db,{...blank,warehouseId:'west'}).summary.quantity,24);
  assert.equal(service.querySalesRecords(db,{...blank,status:'cancelled'}).summary.quantity,0);
  const october=service.querySalesRecords(db,{...blank,dateFrom:'2026-10-01',dateTo:'2026-10-31',channel:'平台A'});assert.equal(october.summary.quantity,24);
  assert.equal(all.byDate.reduce((sum,row)=>sum+row.amount,0),all.summary.amount);assert.equal(all.byChannel.reduce((sum,row)=>sum+row.amount,0),all.summary.amount);
  const detail=service.salesRecordDetail(db,'order-2');assert.equal(detail.order.items.length,4);assert.equal(detail.afterSales.length,3);assert.equal(detail.order.amount,400);
  assert.equal(service.salesCsv(all,'machines').split('\r\n').length,54);assert.equal(service.salesCsv(all,'orders').split('\r\n').length,27);
  const escaped=service.salesCsv({...all,orders:[{...all.orders[0],saleOrderNo:'=HYPERLINK("x")'}]},'orders');assert(escaped.includes("'=HYPERLINK"));
  assert.throws(()=>service.readSalesFilters(new URLSearchParams('dateFrom=2026-10-20&dateTo=2026-10-01')),/不能晚于/);
  class AuthError extends Error {constructor(){super('权限不足');this.status=403;this.code='FORBIDDEN';}}
  let denied=false;
  const route=load('src/app/api/sales/records/route.ts',{'@/lib/db':{default:db,__esModule:true},'@/lib/auth':{AuthError,requireRole:async()=>{if(denied)throw new AuthError();return {id:user};}},'@/lib/api-helpers':load('src/lib/api-helpers.ts'),'@/lib/sales-records':service});
  let response=await route.GET(new NextRequest('http://localhost/api/sales/records?page=2&pageSize=20'));let payload=await response.json();assert.equal(payload.data.items.length,20);assert.equal(payload.data.pagination.total,53);assert.equal(payload.data.summary.amount,9800);
  response=await route.GET(new NextRequest('http://localhost/api/sales/records?view=orders&page=2&pageSize=20'));payload=await response.json();assert.equal(payload.data.items.length,6);assert.equal(payload.data.summary.quantity,49);
  response=await route.GET(new NextRequest('http://localhost/api/sales/records?format=csv'));assert.equal((await response.text()).split('\r\n').length,54);
  response=await route.GET(new NextRequest('http://localhost/api/sales/records?lookup=1&q=0002'));payload=await response.json();assert.equal(payload.data.items.length,1);assert.equal(payload.data.items[0].sn,machines[2].sn);
  denied=true;assert.equal((await route.GET(new NextRequest('http://localhost/api/sales/records'))).status,403);
  assert.equal(db.pragma('integrity_check',{simple:true}),'ok');assert.equal(db.pragma('foreign_key_check').length,0);db.close();
  console.log('Sales records: snapshot, 26 orders, multi-machine, legacy JSON, repeated sale, continuous exchanges, filters, summaries, CSV, pagination and permission checks passed.');
}
main().catch(error=>{console.error(error);process.exitCode=1;});
