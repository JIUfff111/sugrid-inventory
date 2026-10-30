/* Actual inventory route against fresh in-memory fixtures; production DB is never opened. */
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const Module=require('node:module');
const ts=require('typescript');
const Database=require('better-sqlite3');
const {NextRequest}=require('next/server');
const {createFixture}=require('./create-experience-qa.cjs');
const root=path.resolve(__dirname,'..');
function load(relative,overrides={}) {
  const file=path.join(root,relative),m=new Module(file,module);m.filename=file;m.paths=Module._nodeModulePaths(path.dirname(file));const standard=m.require.bind(m);
  m.require=name=>Object.hasOwn(overrides,name)?overrides[name]:standard(name);
  m._compile(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true},fileName:file}).outputText,file);return m.exports;
}
async function run() {
  const db=new Database(':memory:');
  try {
    const fixture=createFixture(db),database={__esModule:true,default:db},helpers=load('src/lib/api-helpers.ts');
    const auth=load('src/lib/auth.ts',{'@/lib/db':database,'@/lib/api-helpers':helpers,'next/headers':{cookies:async()=>({get:()=>undefined})}});
    let user=auth.getUserById(fixture.adminId);
    const route=load('src/app/api/inventory/route.ts',{'@/lib/db':database,'@/lib/api-helpers':helpers,'@/lib/auth':{...auth,requireUser:async()=>user},'@/lib/inventory-status':load('src/lib/inventory-status.ts',{'@/lib/db':database,'@/lib/api-helpers':helpers}),'@/lib/inventory-purge':load('src/lib/inventory-purge.ts',{'@/lib/db':database})});
    async function query(params='',status=200) { const response=await route.GET(new NextRequest('http://localhost/api/inventory?pageSize=100'+params));const body=await response.json();assert.equal(response.status,status,JSON.stringify(body));return body.data; }
    const all=await query('&status=all');
    assert.equal(all.items.length,56);assert.equal(all.total,56);assert.equal(new Set(all.items.map(i=>i.id)).size,56);
    for(const status of ['in_stock','sold','after_sale','returning','returned','renting','custom'])assert(all.items.some(row=>row.status===status),`${status} history missing`);
    assert.equal(all.stats.total,56);assert.equal(all.stats.inStock,9);assert.equal(all.stats.inStockCost,900);assert.equal(all.stats.available,8);
    const after=all.items.filter(row=>row.id===fixture.afterSaleMachineId);assert.equal(after.length,1);assert.equal(after[0].afterSaleId,'qa-after-stored');assert.equal(after[0].afterSaleStockStatus,'stored');
    assert.equal((await query('&status=after_sale')).items.length,1,'Removing shortcuts must not remove actual historical status queries');
    assert.equal((await query('&search=0002')).items.length,3,'Duplicate last-four searches retain distinct machines');
    assert.equal((await query('&status=returned&availableFor=sale')).items.length,0,'History queries cannot bypass business eligibility');
    assert.equal((await query('&status=custom&availableFor=sale')).items.length,0,'Disabled custom business switch prevents sale candidates');
    const custom=(await query('&status=custom')).items[0];assert.equal(custom.customStatusName,'内部维修');assert.equal(custom.statusRecord.location,'维修台');
    user=auth.getUserById('qa-manager');
    const scoped=await query('&status=all');assert.equal(scoped.items.length,28);assert(scoped.items.every(i=>i.warehouseId==='warehouse_east'));
    assert.equal(scoped.stats.total,28);assert.equal(scoped.stats.inStock,4);assert.equal(scoped.stats.inStockCost,400);
    await query('&warehouseId=warehouse_main',403);
    assert.equal(db.pragma('integrity_check',{simple:true}),'ok');assert.equal(db.pragma('foreign_key_check').length,0);
    console.log('PASS inventory history: all 56 archive rows and real statuses, no after-sale duplicate, temporary stock excluded from formal cost/count, last-four matching, eligibility and warehouse access');
  }finally{db.close();}
}
run().catch(error=>{console.error(error);process.exitCode=1;});

