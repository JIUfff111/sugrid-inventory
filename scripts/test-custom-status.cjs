/** Real route handlers, sessions and SQLite against an isolated temporary database. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const { NextRequest } = require('next/server');
const root = path.resolve(__dirname,'..');
function load(relative,deps={}) {
  const filename=path.join(root,relative);
  const code=ts.transpileModule(fs.readFileSync(filename,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true},fileName:filename}).outputText;
  const m=new Module(filename,module);m.filename=filename;m.paths=Module._nodeModulePaths(path.dirname(filename));
  const standard=m.require.bind(m);m.require=name=>Object.hasOwn(deps,name)?deps[name]:standard(name);m._compile(code,filename);return m.exports;
}
async function main() {
  const scratchParent=path.join(root,'.tmp');fs.mkdirSync(scratchParent,{recursive:true});const scratch=fs.mkdtempSync(path.join(scratchParent,'custom-status-'));
  const oldPath=process.env.INVENTORY_DB_PATH;process.env.INVENTORY_DB_PATH=path.join(scratch,'inventory.db');let db;
  try {
    const database=load('src/lib/db.ts');db=database.default;let token;
    const api=load('src/lib/api-helpers.ts');
    const auth=load('src/lib/auth.ts',{'@/lib/db':database,'@/lib/api-helpers':api,'next/headers':{cookies:async()=>({get:()=>token?{value:token}:undefined})}});
    const deps={'@/lib/db':database,'@/lib/api-helpers':api,'@/lib/auth':auth,'@/lib/sku-brand':load('src/lib/sku-brand.ts'),'@/lib/sku-display':load('src/lib/sku-display.ts')};deps['@/lib/inventory-status']=load('src/lib/inventory-status.ts',deps);
    const names=['purchase-orders','sales','rentals','returns','transfers','after-sales','inventory','inventory/lookup','inventory/status-definitions','inventory/status-records','inventory/analysis','inventory/movements'];
    const routes=Object.fromEntries(names.map(name=>[name,load(`src/app/api/${name}/route.ts`,deps)]));
    async function call(name,method,body,expected=200,query='') {
      const req=new NextRequest(`http://localhost/api/${name}${query}`,{method,...(body===undefined?{}:{headers:{'content-type':'application/json'},body:JSON.stringify(body)})});
      const oldError=console.error;if(expected>=400)console.error=()=>{};let response;
      try {response=await routes[name][method](req);} finally {console.error=oldError;}
      const payload=await response.json();assert.equal(response.status,expected,`${name} ${method}: ${JSON.stringify(payload)}`);return payload.data;
    }
    const admin=db.prepare("SELECT id FROM users WHERE role='admin' AND status='active' LIMIT 1").get().id;
    token=auth.createSession(admin);
    db.prepare("INSERT INTO suppliers(id,supplierName) VALUES ('cs-supplier','状态测试供应商')").run();
    db.prepare("INSERT INTO sales_channels(id,channelName) VALUES ('cs-channel','状态测试渠道')").run();
    const warehouse='warehouse_main';
    const machines=Array.from({length:111},(_,i)=>({brand:'ThinkPad',model:'X13',year:2020,cpu:'i5',ram:'16GB',storage:'512GB',screen:'',purchasePrice:1000,sn:`CS-${String(i).padStart(3,'0')}-${i===110?'LATE':'0000'}`}));
    const purchase=await call('purchase-orders','POST',{supplierId:'cs-supplier',purchaseDate:'2026-10-21',purchasedBy:admin,warehouseId:warehouse,status:'completed',items:machines},201);
    assert.equal(db.prepare('SELECT supplierOrderNo FROM purchase_orders WHERE id=?').get(purchase.id).supplierOrderNo,'');
    const machine=index=>db.prepare('SELECT * FROM inventory WHERE sn=?').get(machines[index].sn);
    const definition=await call('inventory/status-definitions','POST',{name:'外部保管',color:'#2563eb'},201);
    const register=index=>call('inventory/status-records','POST',{inventoryId:machine(index).id,definitionId:definition.id,reason:'测试原因',location:'维修点',expectedReturnDate:'2026-10-25'},201);
    await call('inventory/status-records','POST',{inventoryId:machine(0).id,definitionId:definition.id},201);
    const blankStatus=db.prepare('SELECT reason,location FROM inventory_status_records WHERE id=?').get(machine(0).currentStatusRecordId);
    assert.equal(blankStatus.reason,'');assert.equal(blankStatus.location,'');
    assert.equal(db.prepare("SELECT note FROM inventory_movements WHERE inventoryId=? AND movementType='custom_status_start'").get(machine(0).id).note,'外部保管');
    assert.equal(machine(0).status,'custom');assert(machine(0).currentStatusRecordId);
    await call('inventory/status-records','POST',{inventoryId:machine(0).id,definitionId:definition.id,reason:'重复',location:'重复'},400);
    let result=await call('inventory/lookup','GET',undefined,200,'?context=sale&q='+encodeURIComponent(machine(0).sn));assert.equal(result.total,0);
    result=await call('inventory','GET',undefined,200,`?status=custom&customStatusId=${definition.id}`);assert.equal(result.total,1);assert.equal(result.items[0].customStatusName,'外部保管');
    result=await call('inventory/analysis','GET');assert.equal(result.summary.custom,1);assert.equal(result.summary.customCost,1000);assert.equal(result.byCustomStatus[0].name,'外部保管');
    await call('inventory/status-records','PATCH',{inventoryId:machine(0).id,action:'restore'},400);
    await call('inventory/status-records','PATCH',{inventoryId:machine(0).id,action:'restore',resultNote:'已取回'});assert.equal(machine(0).status,'in_stock');assert.equal(machine(0).currentStatusRecordId,null);
    await call('inventory/status-definitions','PATCH',{id:definition.id,allowStockOperations:true});
    await register(0);await register(1);await register(2);await register(3);await register(4);await register(5);
    result=await call('inventory/lookup','GET',undefined,200,'?context=sale&q=0000');assert.equal(result.total,110);assert.equal(result.items.length,8);
    result=await call('inventory/lookup','GET',undefined,200,'?context=exchange&q=LATE');assert.equal(result.total,1);assert.equal(result.items[0].sn,machine(110).sn);
    result=await call('inventory/lookup','GET',undefined,200,'?context=inventory&q=%25');assert.equal(result.total,0);
    result=await call('inventory/lookup','GET',undefined,200,'?context=inventory&q=%5F');assert.equal(result.total,0);
    result=await call('inventory/lookup','GET',undefined,200,'?context=inventory&q=CS-000');assert.equal(result.total,0,'SN middle fragments are not suffix matches');
    const saleBody=index=>({saleChannelId:'cs-channel',saleOrderNo:'CS-SALE-'+index,saleDate:'2026-10-21',items:[{inventoryId:machine(index).id,sellingPrice:1800}]});
    await call('inventory/status-definitions','PATCH',{id:definition.id,allowStockOperations:false});
    await call('sales','POST',saleBody(0),400);assert.equal(machine(0).status,'custom');
    await call('inventory/status-definitions','PATCH',{id:definition.id,allowStockOperations:true});
    const sale=await call('sales','POST',saleBody(0),201);assert.equal(machine(0).status,'sold');assert.equal(machine(0).currentStatusRecordId,null);
    await call('sales','PATCH',{id:sale.id,action:'cancel',cancelReason:'测试撤销'});assert.equal(machine(0).status,'in_stock');assert.equal(machine(0).currentStatusRecordId,null);
    const rental=await call('rentals','POST',{inventoryId:machine(1).id,customerName:'测试',customerPhone:'10000',customerAddress:'测试地址',rentalStartDate:'2026-10-21',rentalEndDate:'2026-10-25',rentalType:'day',rentalUnitPrice:100,deposit:500},201);
    assert.equal(machine(1).status,'renting');assert.equal(machine(1).currentStatusRecordId,null);
    await call('rentals','PATCH',{id:rental.id,action:'return',returnDate:'2026-10-25',returnType:'正常归还'});assert.equal(machine(1).status,'in_stock');
    const supplierReturn=await call('returns','POST',{inventoryIds:[machine(2).id],returnReason:'测试退货',refundAmount:1000},201);
    assert.equal(machine(2).status,'returning');assert(machine(2).currentStatusRecordId,'supplier return application must retain status registration');
    await call('returns','PATCH',{id:supplierReturn.id,action:'complete'});assert.equal(machine(2).status,'returned');assert.equal(machine(2).currentStatusRecordId,null);
    const returnStatusEnd=db.prepare("SELECT * FROM inventory_movements WHERE inventoryId=? AND movementType='custom_status_end'").get(machine(2).id);assert.equal(returnStatusEnd.statusFrom,'returning');assert.equal(returnStatusEnd.statusTo,'returned');assert.equal(JSON.parse(returnStatusEnd.snapshot).statusRecord.location,'维修点');
    db.prepare("INSERT INTO warehouses(id,code,name,warehouseName,status,isDefault) VALUES ('cs-target','CS-TARGET','状态测试仓','状态测试仓','active',0)").run();
    const transfer=await call('transfers','POST',{sourceWarehouseId:warehouse,targetWarehouseId:'cs-target',inventoryIds:[machine(3).id]},201);
    assert(machine(3).currentStatusRecordId);await call('sales','POST',saleBody(3),400);
    await call('returns','POST',{inventoryIds:[machine(3).id],returnReason:'占用测试',refundAmount:1000},400);
    await call('rentals','POST',{inventoryId:machine(3).id,customerName:'测试',customerPhone:'10000',customerAddress:'地址',rentalStartDate:'2026-10-21',rentalEndDate:'2026-10-25',rentalType:'day',rentalUnitPrice:100},400);await call('inventory/status-records','PATCH',{inventoryId:machine(3).id,action:'restore',resultNote:'不应允许'},400);
    result=await call('inventory/lookup','GET',undefined,200,'?context=status-register&q='+encodeURIComponent(machine(3).sn));assert.equal(result.total,0);
    await call('sales','POST',saleBody(9),201);const occupiedExchange=await call('after-sales','POST',{inventoryId:machine(9).id,issueType:'占用换机',resolutionType:'exchange'},201);await call('after-sales','PATCH',{id:occupiedExchange.id,action:'receive'});
    await call('after-sales','PATCH',{id:occupiedExchange.id,action:'exchange',replacementInventoryId:machine(3).id},400);assert.equal(machine(9).status,'after_sale');await call('after-sales','PATCH',{id:occupiedExchange.id,action:'cancel'});
    await call('transfers','PATCH',{id:transfer.id,action:'complete'});assert.equal(machine(3).warehouseId,'cs-target');assert.equal(machine(3).status,'in_stock');assert.equal(machine(3).currentStatusRecordId,null);
    // A downstream log failure rolls back status closure, sale and inventory as one unit.
    db.exec("CREATE TRIGGER cs_force_failure BEFORE INSERT ON inventory_movements WHEN NEW.movementType='sale' BEGIN SELECT RAISE(ABORT,'forced test failure'); END");
    const recordBefore=machine(4).currentStatusRecordId;await call('sales','POST',saleBody(4),500);assert.equal(machine(4).status,'custom');assert.equal(machine(4).currentStatusRecordId,recordBefore);assert.equal(db.prepare('SELECT closedAt FROM inventory_status_records WHERE id=?').get(recordBefore).closedAt,null);db.exec('DROP TRIGGER cs_force_failure');
    // Exchange can use an eligible custom machine and must end its previous registration.
    await call('sales','POST',saleBody(6),201);const afterSale=await call('after-sales','POST',{inventoryId:machine(6).id,issueType:'测试换货',resolutionType:'exchange'},201);
    await call('after-sales','PATCH',{id:afterSale.id,action:'receive'});
    await call('after-sales','PATCH',{id:afterSale.id,action:'exchange',replacementInventoryId:machine(5).id,resolutionNote:'测试换机'});assert.equal(machine(5).status,'sold');assert.equal(machine(5).currentStatusRecordId,null);
    const rollbackTransfer=await call('transfers','POST',{sourceWarehouseId:warehouse,targetWarehouseId:'cs-target',inventoryIds:[machine(4).id]},201);
    db.exec("CREATE TRIGGER cs_transfer_failure BEFORE INSERT ON inventory_movements WHEN NEW.movementType='transfer_in' BEGIN SELECT RAISE(ABORT,'forced transfer failure'); END");
    const activeBefore=machine(4).currentStatusRecordId;await call('transfers','PATCH',{id:rollbackTransfer.id,action:'complete'},400);
    assert.equal(machine(4).status,'custom');assert.equal(machine(4).currentStatusRecordId,activeBefore);assert.equal(machine(4).warehouseId,warehouse);assert.equal(db.prepare('SELECT status FROM transfers WHERE id=?').get(rollbackTransfer.id).status,'pending');
    db.exec('DROP TRIGGER cs_transfer_failure');await call('transfers','PATCH',{id:rollbackTransfer.id,action:'cancel'});
    await call('inventory/status-definitions','PATCH',{id:definition.id,isActive:false});
    result=await call('inventory/lookup','GET',undefined,200,'?context=sale&q='+encodeURIComponent(machine(4).sn));assert.equal(result.total,1,'disabled definition retains existing permissions');
    result=await call('sales','GET',undefined,200,'?search='+encodeURIComponent(machine(4).sn));assert.equal(result.items[0].customStatusName,'外部保管');
    result=await call('rentals','GET',undefined,200,'?resource=inventory&search='+encodeURIComponent(machine(4).sn));assert.equal(result.items[0].customStatusName,'外部保管');
    await call('inventory/status-records','POST',{inventoryId:machine(7).id,definitionId:definition.id,reason:'原因',location:'地点'},400);
    await call('inventory/status-records','PATCH',{inventoryId:machine(4).id,action:'restore',resultNote:'停用后仍可归还'});
    // Warehouse users cannot create statuses, and lookup cannot disclose another warehouse.
    db.prepare("INSERT INTO users(id,username,password,role,status) VALUES ('cs-viewer','cs-viewer','test','warehouse_manager','active')").run();db.prepare("INSERT INTO user_warehouses(userId,warehouseId) VALUES ('cs-viewer','warehouse_main')").run();token=auth.createSession('cs-viewer');
    await call('inventory/status-definitions','POST',{name:'越权'},403);await call('inventory/status-records','POST',{},403);
    for(const context of ['sale','rental','after-sale','exchange','supplier-return','status-register'])await call('inventory/lookup','GET',undefined,403,'?context='+context+'&q=0000');
    await call('inventory/lookup','GET',undefined,403,'?context=inventory&warehouseId=cs-target&q=0000');
    result=await call('inventory/lookup','GET',undefined,200,'?context=inventory&q='+encodeURIComponent(machine(3).sn));assert.equal(result.total,0);
    token=auth.createSession(admin);const before=db.prepare('SELECT COUNT(*) n FROM inventory_status_records').get().n;database.initDatabase();assert.equal(db.prepare('SELECT COUNT(*) n FROM inventory_status_records').get().n,before);
    assert.equal(db.pragma('integrity_check',{simple:true}),'ok');assert.deepEqual(db.pragma('foreign_key_check'),[]);
    console.log('PASS custom inventory status: migrations, permissions, lookup/suffix/full database, live flags, restore, sale/cancel, rental/return, supplier return, transfer reservation/completion, exchange and transactional rollback');
  } finally {
    if(db?.open)db.close();if(oldPath===undefined)delete process.env.INVENTORY_DB_PATH;else process.env.INVENTORY_DB_PATH=oldPath;
    assert(path.resolve(scratch).startsWith(path.resolve(scratchParent)+path.sep));fs.rmSync(scratch,{recursive:true,force:true});
  }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
