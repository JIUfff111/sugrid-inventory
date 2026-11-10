/** Isolated route-level coverage for system data management and inventory purge. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
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
  const scratch = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'sugrid-data-management-'));
  const backupDbPath = path.join(scratch, 'inventory.db');
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  const previousPath = process.env.INVENTORY_DB_PATH;
  process.env.INVENTORY_DB_PATH = backupDbPath;
  try {
    initDatabase(db); seedDatabase(db); initDatabase(db);
    const database = { __esModule: true, default: db };
    const api = load('src/lib/api-helpers.ts');
    let token;
    const auth = load('src/lib/auth.ts', {
      '@/lib/db': database,
      '@/lib/api-helpers': api,
      'next/headers': { cookies: async () => ({ get: () => token ? { value: token } : undefined }) },
    });
    const deps = { '@/lib/db': database, '@/lib/api-helpers': api, '@/lib/auth': auth };
    const dataManagement = load('src/lib/data-management.ts', deps);
    const gpuPurchaseItemErrors = dataManagement.validateRecord(dataManagement.DATA_RESOURCES.purchase_items, {
      purchaseOrderId: 'order', productType: '显卡', brand: '华硕', model: 'RTX 4060',
      sn: 'GPU-IMPORT-001', purchasePrice: 2400,
    });
    assert.deepEqual(gpuPurchaseItemErrors, [], 'graphics-card purchase items should not require computer-only specs');
    const laptopPurchaseItemErrors = dataManagement.validateRecord(dataManagement.DATA_RESOURCES.purchase_items, {
      purchaseOrderId: 'order', productType: '笔记本电脑', brand: 'ThinkPad', model: 'X13',
      sn: 'LAPTOP-IMPORT-001', purchasePrice: 2400,
    });
    assert(laptopPurchaseItemErrors.includes('缺少必填字段 cpu'), 'laptop spec requirements should remain enforced');
    const purge = load('src/lib/inventory-purge.ts', { '@/lib/db': database });
    const inventoryStatus = load('src/lib/inventory-status.ts', { ...deps, '@/lib/inventory-status': undefined });
    const routeDeps = {
      ...deps,
      '@/lib/data-management': dataManagement,
      '@/lib/inventory-purge': purge,
      '@/lib/inventory-status': inventoryStatus,
      '@/lib/sku-brand': load('src/lib/sku-brand.ts'),
      '@/lib/sku-display': load('src/lib/sku-display.ts'),
      '@/lib/manual-sku-options': load('src/lib/manual-sku-options.ts'),
      '@/lib/machine-scan': load('src/lib/machine-scan.ts'),
    };
    const previewImport = load('src/app/api/data-management/import/preview/route.ts', routeDeps);
    const routes = {
      resources: load('src/app/api/data-management/resources/route.ts', routeDeps),
      resource: load('src/app/api/data-management/[resource]/route.ts', routeDeps),
      export: load('src/app/api/data-management/export/route.ts', routeDeps),
      importPreview: previewImport,
      import: load('src/app/api/data-management/import/route.ts', { ...routeDeps, './preview/route': previewImport }),
      inventory: load('src/app/api/inventory/route.ts', routeDeps),
      inventoryEdit: load('src/app/api/inventory/edit/route.ts', routeDeps),
      purgePreview: load('src/app/api/inventory/purge-preview/route.ts', routeDeps),
      purchaseOrders: load('src/app/api/purchase-orders/route.ts', {
        ...routeDeps,
        '@/lib/sku-brand': load('src/lib/sku-brand.ts'),
        '@/lib/sku-display': load('src/lib/sku-display.ts'),
      }),
      snCheck: load('src/app/api/purchase-orders/sn-check/route.ts', routeDeps),
    };
    const request = (url, method = 'GET', body) => new NextRequest(`http://localhost${url}`, {
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    async function call(handler, url, method = 'GET', body, expected = 200, params) {
      const response = await handler(request(url, method, body), params);
      const payload = await response.json();
      assert.equal(response.status, expected, `${method} ${url}: ${JSON.stringify(payload)}`);
      return payload.data;
    }

    const adminId = db.prepare("SELECT id FROM users WHERE username = 'admin'").get().id;
    token = auth.createSession(adminId);
    const purchaseItemIndexes = db.pragma('index_list(purchase_items)');
    assert(!purchaseItemIndexes.some(index => index.unique && db.pragma(`index_info("${String(index.name).replaceAll('"', '""')}")`).some(column => column.name === 'sn')),
      'purchase history SNs must not be protected by a permanent uniqueness constraint');
    const inventorySnIndex = db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_inventory_sn'").get();
    assert.match(inventorySnIndex.sql, /WHERE\s+deleted\s*=\s*0/i, 'inventory SN uniqueness should only apply to active records');
    assert(!dataManagement.DATA_RESOURCES.users.fields.includes('password'));
    const nestedSanitized = JSON.parse(dataManagement.sanitizeRow({ payload: JSON.stringify([{ password: 'secret', token_hash: 'secret', visible: 'ok' }]) }).payload);
    assert.deepEqual(nestedSanitized, [{ visible: 'ok' }]);
    assert(db.pragma('table_info(user_warehouses)').some(column => column.name === 'id'));
    assert(db.prepare('SELECT id FROM user_warehouses WHERE userId = ?').get(adminId).id);
    db.prepare("INSERT INTO suppliers (id,supplierName,status,createdBy) VALUES ('dm-supplier','数据管理供应商','active',?)").run(adminId);
    db.prepare(`INSERT INTO purchase_orders
      (id,purchaseNo,supplierOrderNo,supplierId,supplierName,purchaseDate,purchasedBy,createdBy)
      VALUES ('dm-order','DM-ORDER','', 'dm-supplier','数据管理供应商','2026-10-30',?,?)`).run(adminId, adminId);
    db.prepare("UPDATE purchase_orders SET isInbounded=1 WHERE id='dm-order'").run();
    db.prepare(`INSERT INTO purchase_items
      (id,purchaseOrderId,productType,brand,model,cpu,ram,storage,screen,sn,purchasePrice)
      VALUES ('dm-item','dm-order','笔记本电脑','ThinkPad','X13','I5-10210U','16GB','512GB','2.5K','PURGE-SN-001',1000)`).run();
    db.prepare(`INSERT INTO inventory
      (id,purchaseOrderId,purchaseItemId,sn,productType,brand,model,cpu,ram,storage,screen,purchasePrice,supplierId,supplierName,status,inboundDate,warehouseId)
      VALUES ('dm-machine','dm-order','dm-item','PURGE-SN-001','笔记本电脑','ThinkPad','X13','I5-10210U','16GB','512GB','2.5K',1000,'dm-supplier','数据管理供应商','in_stock','2026-10-30','warehouse_main')`).run();
    db.prepare(`INSERT INTO inventory_movements (id,inventoryId,warehouseId,movementType,referenceType,referenceId,actorId,note)
      VALUES ('dm-movement','dm-machine','warehouse_main','asset_change','inventory','dm-machine',?,'test')`).run(adminId);

    // Recreate a legacy unique SN index to exercise the versioned table rebuild against retained rows and foreign keys.
    db.exec('CREATE UNIQUE INDEX legacy_purchase_item_sn_unique ON purchase_items(sn)');
    db.prepare('DELETE FROM schema_migrations WHERE version=16').run();
    initDatabase(db);
    assert.equal(db.prepare("SELECT sn FROM purchase_items WHERE id='dm-item'").get().sn, 'PURGE-SN-001');
    assert.equal(db.prepare("SELECT purchaseItemId FROM inventory WHERE id='dm-machine'").get().purchaseItemId, 'dm-item');
    assert.deepEqual(db.pragma('foreign_key_check'), [], 'SN migration must preserve inventory foreign keys');
    const activeSnCheck = await call(routes.snCheck.GET, '/api/purchase-orders/sn-check?sn=PURGE-SN-001');
    assert.equal(activeSnCheck.canUse, false, 'an active inventory archive must block reuse of its SN');
    assert(activeSnCheck.blockedBy.some(item => item.type === 'active_inventory' && item.id === 'dm-machine'));
    db.prepare(`INSERT INTO rental_orders
      (id,rentalNo,customerName,customerPhone,customerAddress,rentalStartDate,rentalEndDate,rentalType,createdBy)
      VALUES ('dm-rental-order','DM-RENTAL-001','租赁客户','10000000000','测试地址','2026-10-30','2026-10-31','day',?)`).run(adminId);

    const resources = await call(routes.resources.GET, '/api/data-management/resources');
    assert(resources.some(item => item.key === 'login_events'));
    assert.equal(resources.find(item => item.key === 'purchase_orders')?.deletable, true);
    const createdViewer = await call(routes.resource.POST, '/api/data-management/users', 'POST', {
      id: 'dm-viewer', username: 'dm-viewer', role: 'viewer', status: 'active',
      canViewInventory: 0, canEditInventory: 1,
    }, 201, { params: Promise.resolve({ resource: 'users' }) });
    assert.equal(createdViewer.role, 'viewer');
    assert.equal(createdViewer.status, 'pending', 'data management users must still require password setup');
    assert.deepEqual(db.prepare('SELECT canViewInventory, canEditInventory FROM users WHERE id = ?').get('dm-viewer'), { canViewInventory: 1, canEditInventory: 0 });
    const updatedViewer = await call(routes.resource.PATCH, '/api/data-management/users', 'PATCH', {
      id: 'dm-viewer', canViewInventory: 0, canEditInventory: 1,
    }, 200, { params: Promise.resolve({ resource: 'users' }) });
    assert.equal(updatedViewer.role, 'viewer');
    assert.deepEqual(db.prepare('SELECT canViewInventory, canEditInventory FROM users WHERE id = ?').get('dm-viewer'), { canViewInventory: 1, canEditInventory: 0 });
    await call(routes.resource.POST, '/api/data-management/user_warehouses', 'POST', {
      id: 'dm-viewer-warehouse', userId: 'dm-viewer', warehouseId: 'warehouse_main',
    }, 400, { params: Promise.resolve({ resource: 'user_warehouses' }) });
    const viewerAssignmentPreview = await call(routes.importPreview.POST, '/api/data-management/import/preview', 'POST', {
      resource: 'user_warehouses', mode: 'insert', content: { id: 'dm-viewer-warehouse', userId: 'dm-viewer', warehouseId: 'warehouse_main' },
    });
    assert.equal(viewerAssignmentPreview.canApply, false);
    assert(JSON.stringify(viewerAssignmentPreview.reports[0].errors).includes('普通用户'));
    db.prepare("INSERT INTO users(id,username,password,role,status) VALUES ('dm-demote','dm-demote','test','warehouse_manager','active')").run();
    db.prepare("INSERT INTO user_warehouses(id,userId,warehouseId) VALUES ('dm-demote-warehouse','dm-demote','warehouse_main')").run();
    const demotedViewer = await call(routes.resource.PATCH, '/api/data-management/users', 'PATCH', {
      id: 'dm-demote', role: 'viewer', canEditInventory: 1,
    }, 200, { params: Promise.resolve({ resource: 'users' }) });
    assert.equal(demotedViewer.role, 'viewer');
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM user_warehouses WHERE userId = ?').get('dm-demote').count, 0);
    for (const resource of dataManagement.DATA_RESOURCE_KEYS) {
      const listed = await call(routes.resource.GET, `/api/data-management/${resource}?pageSize=1`, 'GET', undefined, 200, { params: Promise.resolve({ resource }) });
      assert(Array.isArray(listed.items), `${resource} should return a row list`);
    }
    const inventoryRows = await call(routes.resource.GET, '/api/data-management/inventory?search=PURGE-SN-001', 'GET', undefined, 200, { params: Promise.resolve({ resource: 'inventory' }) });
    assert.equal(inventoryRows.items.length, 1);

    const linkedOrderPreview = await call(routes.resource.GET, '/api/data-management/purchase_orders?id=dm-order', 'GET', undefined, 200, { params: Promise.resolve({ resource: 'purchase_orders' }) });
    assert(linkedOrderPreview.references.some(reference => reference.label === '库存机器' && reference.count === 1));
    await call(routes.resource.DELETE, '/api/data-management/purchase_orders?id=dm-order', 'DELETE', undefined, 409, { params: Promise.resolve({ resource: 'purchase_orders' }) });
    assert.equal(db.prepare("SELECT deleted FROM purchase_orders WHERE id='dm-order'").get().deleted, 0);

    db.prepare(`INSERT INTO purchase_orders
      (id,purchaseNo,supplierOrderNo,supplierId,supplierName,purchaseDate,purchasedBy,createdBy,totalQuantity,totalAmount,isInbounded)
      VALUES ('dm-draft-order','DM-DRAFT','', 'dm-supplier','数据管理供应商','2026-10-30',?,?,1,1000,0)`).run(adminId, adminId);
    db.prepare(`INSERT INTO purchase_items
      (id,purchaseOrderId,productType,brand,model,cpu,ram,storage,screen,sn,purchasePrice)
      VALUES ('dm-draft-item','dm-draft-order','笔记本电脑','ThinkPad','X13','I5-10210U','16GB','512GB','2.5K','DRAFT-SN-001',1000)`).run();
    const draftSnCheck = await call(routes.snCheck.GET, '/api/purchase-orders/sn-check?sn=DRAFT-SN-001');
    assert.equal(draftSnCheck.canUse, false, 'an unreceived purchase draft must block reuse of its SN');
    assert(draftSnCheck.blockedBy.some(item => item.type === 'purchase_draft' && item.id === 'dm-draft-order'));
    const draftPreview = await call(routes.resource.GET, '/api/data-management/purchase_orders?id=dm-draft-order', 'GET', undefined, 200, { params: Promise.resolve({ resource: 'purchase_orders' }) });
    assert(draftPreview.references.some(reference => reference.label === '采购明细' && reference.count === 1));
    const deletedDraft = await call(routes.resource.DELETE, '/api/data-management/purchase_orders?id=dm-draft-order', 'DELETE', undefined, 200, { params: Promise.resolve({ resource: 'purchase_orders' }) });
    assert.match(deletedDraft.message, /1 条采购明细/);
    assert.equal(db.prepare("SELECT deleted FROM purchase_orders WHERE id='dm-draft-order'").get().deleted, 1);
    assert.equal(db.prepare("SELECT deleted FROM purchase_items WHERE id='dm-draft-item'").get().deleted, 1);
    const purchaseDeleteAudit = JSON.parse(db.prepare("SELECT summary FROM data_management_audit WHERE action='delete' AND resource='purchase_orders' AND recordId='dm-draft-order'").get().summary);
    assert.equal(purchaseDeleteAudit.purchaseItemCount, 1);
    assert(purchaseDeleteAudit.backup);

    db.prepare(`INSERT INTO purchase_orders
      (id,purchaseNo,supplierOrderNo,supplierId,supplierName,purchaseDate,purchasedBy,createdBy)
      VALUES ('dm-return-order','DM-RETURN','', 'dm-supplier','数据管理供应商','2026-10-30',?,?)`).run(adminId, adminId);
    db.prepare(`INSERT INTO return_orders
      (id,returnNo,items,purchaseOrderId,purchaseOrderNo,supplierId,supplierName,returnReason,refundAmount,createdBy)
      VALUES ('dm-return','DM-RETURN-001','[]','dm-return-order','DM-RETURN','dm-supplier','数据管理供应商','test',0,?)`).run(adminId);
    await call(routes.resource.DELETE, '/api/data-management/purchase_orders?id=dm-return-order', 'DELETE', undefined, 409, { params: Promise.resolve({ resource: 'purchase_orders' }) });
    assert.equal(db.prepare("SELECT deleted FROM purchase_orders WHERE id='dm-return-order'").get().deleted, 0);

    const exportResponse = await routes.export.GET(request('/api/data-management/export?resource=inventory&format=json&search=PURGE-SN-001'));
    assert.equal(exportResponse.status, 200);
    const exportBody = JSON.parse(await exportResponse.text());
    assert.equal(exportBody.resources.inventory.length, 1);
    assert(!JSON.stringify(exportBody).includes('password'));
    assert(!JSON.stringify(exportBody).includes('tokenHash'));

    const duplicatePreview = await call(routes.importPreview.POST, '/api/data-management/import/preview', 'POST', {
      resource: 'suppliers', mode: 'insert', content: { id: 'dm-supplier', supplierName: '冲突', status: 'active' },
    });
    assert.equal(duplicatePreview.reports[0].conflicts, 1);
    assert.equal(duplicatePreview.canApply, false);

    const duplicateRentalOrderPreview = await call(routes.importPreview.POST, '/api/data-management/import/preview', 'POST', {
      resource: 'rental_orders', mode: 'insert', content: {
        id: 'dm-rental-order-copy', rentalNo: 'DM-RENTAL-001', customerName: '租赁客户', customerPhone: '10000000000',
        customerAddress: '测试地址', rentalStartDate: '2026-10-30', rentalEndDate: '2026-10-31', rentalType: 'day', createdBy: adminId,
      },
    });
    assert.equal(duplicateRentalOrderPreview.reports[0].valid, 0);
    assert.equal(duplicateRentalOrderPreview.reports[0].conflicts, 1);
    assert.equal(duplicateRentalOrderPreview.reports[0].errors.length, 0);
    assert(duplicateRentalOrderPreview.reports[0].conflictDetails.some(detail => detail.message.includes('rentalNo 已存在')));
    assert.equal(duplicateRentalOrderPreview.canApply, false);

    const typoPreview = await call(routes.importPreview.POST, '/api/data-management/import/preview', 'POST', {
      resource: 'suppliers', mode: 'insert', content: { id: 'dm-typo', supplierName: '字段检查', status: 'active', supplierNmae: '错误拼写' },
    });
    assert(typoPreview.reports[0].errors.some(error => error.message.includes('supplierNmae')));
    const authFieldPreview = await call(routes.importPreview.POST, '/api/data-management/import/preview', 'POST', {
      resource: 'suppliers', mode: 'insert', content: { id: 'dm-secret', supplierName: '认证字段检查', status: 'active', password: 'must-not-import' },
    });
    assert(authFieldPreview.reports[0].errors.some(error => error.message.includes('password')));
    const nestedSecretPreview = await call(routes.importPreview.POST, '/api/data-management/import/preview', 'POST', {
      resource: 'sales_records', mode: 'insert', content: { id: 'dm-nested-secret', recordNo: 'DM-NESTED', saleChannel: 'test', saleOrderNo: 'DM-NESTED', saleDate: '2026-10-30', items: [{ tokenHash: 'must-not-import' }] },
    });
    assert(nestedSecretPreview.reports[0].errors.some(error => error.message.includes('tokenHash')));
    const foreignKeyPreview = await call(routes.importPreview.POST, '/api/data-management/import/preview', 'POST', {
      resource: 'inventory', mode: 'insert', content: {
        id: 'dm-invalid-fk', purchaseOrderId: 'missing-order', purchaseItemId: 'missing-item', sn: 'DM-FK-SN',
        productType: '笔记本电脑', brand: 'ThinkPad', model: 'X13', cpu: 'I5-10210U', ram: '16GB', storage: '512GB', screen: '2.5K',
        purchasePrice: 1, supplierId: 'missing-supplier', supplierName: 'missing', status: 'in_stock', inboundDate: '2026-10-30', warehouseId: 'missing-warehouse',
      },
    });
    assert(foreignKeyPreview.reports[0].errors.some(error => error.message.includes('purchaseOrderId')));
    assert.deepEqual(dataManagement.parseCsv('\uFEFFid,supplierName,status\r\nrow-1,CSV供应商,active')[0], { id: 'row-1', supplierName: 'CSV供应商', status: 'active' });
    const duplicateIdPreview = await call(routes.importPreview.POST, '/api/data-management/import/preview', 'POST', {
      resource: 'suppliers', mode: 'insert', content: { resources: { suppliers: [
        { id: 'same-id', supplierName: 'A', status: 'active' }, { id: 'same-id', supplierName: 'B', status: 'active' },
      ] } },
    });
    assert(duplicateIdPreview.reports[0].errors.some(error => error.message.includes('ID same-id 重复')));

    const stringJsonPreview = await call(routes.importPreview.POST, '/api/data-management/import/preview', 'POST', {
      resource: 'users', mode: 'insert', content: JSON.stringify({
        schemaVersion: 12,
        resources: { users: [{ id: 'json-user', username: 'json-user', realName: 'JSON 导入', role: 'admin', status: 'active' }] },
      }),
    });
    assert.equal(stringJsonPreview.reports[0].resource, 'users');
    assert.equal(stringJsonPreview.reports[0].valid, 1);
    assert.equal(stringJsonPreview.reports[0].errors.length, 0);

    const stringFullJsonPreview = await call(routes.importPreview.POST, '/api/data-management/import/preview', 'POST', {
      mode: 'insert', content: JSON.stringify({
        schemaVersion: 12,
        resources: { suppliers: [{ id: 'json-supplier', supplierName: 'JSON 全量导入', status: 'active' }] },
      }),
    });
    assert.equal(stringFullJsonPreview.reports[0].resource, 'suppliers');
    assert.equal(stringFullJsonPreview.reports[0].valid, 1);
    assert.equal(stringFullJsonPreview.reports[0].errors.length, 0);

    const partialUserContent = JSON.stringify({ resources: { users: [
      { id: 'partial-conflict', username: 'admin', realName: '冲突账号', role: 'admin', status: 'active' },
      { id: 'partial-new-user', username: 'partial-new-user', realName: '新增账号', role: 'admin', status: 'active' },
    ] } });
    const partialUserPreview = await call(routes.importPreview.POST, '/api/data-management/import/preview', 'POST', {
      resource: 'users', mode: 'insert', content: partialUserContent,
    });
    assert.equal(partialUserPreview.reports[0].valid, 1);
    assert.equal(partialUserPreview.reports[0].conflicts, 1);
    assert.equal(partialUserPreview.reports[0].errors.length, 0);
    assert.equal(partialUserPreview.canApply, true);
    assert(partialUserPreview.reports[0].conflictDetails.some(detail => detail.message.includes('账号已存在')));
    const partialUserImport = await call(routes.import.POST, '/api/data-management/import', 'POST', {
      resource: 'users', mode: 'insert', fileName: 'partial-users.json', content: partialUserContent,
    });
    assert.equal(partialUserImport.inserted, 1);
    assert(db.prepare("SELECT 1 FROM users WHERE id='partial-new-user'").get());
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM users WHERE username='admin'").get().n, 1);

    db.prepare("INSERT INTO label_templates (id,templateName,templateType,width,height,orientation,fields,isDefault,createdBy) VALUES ('dm-template','冲突模板','inventory',100,50,'portrait','[]',0,?)").run(adminId);
    const partialTemplateContent = JSON.stringify({ resources: { label_templates: [
      { id: 'partial-template-conflict', templateName: '冲突模板', templateType: 'inventory', width: 100, height: 50, orientation: 'portrait', fields: '[]' },
      { id: 'partial-template-new', templateName: '新增模板', templateType: 'inventory', width: 100, height: 50, orientation: 'portrait', fields: '[]' },
    ] } });
    const partialTemplatePreview = await call(routes.importPreview.POST, '/api/data-management/import/preview', 'POST', {
      resource: 'label_templates', mode: 'insert', content: partialTemplateContent,
    });
    assert.equal(partialTemplatePreview.reports[0].valid, 1);
    assert.equal(partialTemplatePreview.reports[0].conflicts, 1);
    assert.equal(partialTemplatePreview.reports[0].errors.length, 0);
    assert.equal(partialTemplatePreview.canApply, true);
    const partialTemplateImport = await call(routes.import.POST, '/api/data-management/import', 'POST', {
      resource: 'label_templates', mode: 'insert', fileName: 'partial-templates.json', content: partialTemplateContent,
    });
    assert.equal(partialTemplateImport.inserted, 1);
    assert(db.prepare("SELECT 1 FROM label_templates WHERE id='partial-template-new'").get());
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM label_templates WHERE templateName='冲突模板'").get().n, 1);

    const partialWarehouseContent = JSON.stringify({ resources: { warehouses: [
      { id: 'partial-warehouse-conflict', code: 'MAIN-IMPORT', name: '总仓', status: 'active' },
      { id: 'partial-warehouse-new', code: 'NEW-IMPORT', name: '新导入仓', status: 'active' },
    ] } });
    const partialWarehousePreview = await call(routes.importPreview.POST, '/api/data-management/import/preview', 'POST', {
      resource: 'warehouses', mode: 'insert', content: partialWarehouseContent,
    });
    assert.equal(partialWarehousePreview.reports[0].valid, 1);
    assert.equal(partialWarehousePreview.reports[0].conflicts, 1);
    assert.equal(partialWarehousePreview.reports[0].errors.length, 0);
    const partialWarehouseImport = await call(routes.import.POST, '/api/data-management/import', 'POST', {
      resource: 'warehouses', mode: 'insert', fileName: 'partial-warehouses.json', content: partialWarehouseContent,
    });
    assert.equal(partialWarehouseImport.inserted, 1);
    assert(db.prepare("SELECT 1 FROM warehouses WHERE id='partial-warehouse-new'").get());
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM warehouses WHERE name='总仓'").get().n, 1);

    db.prepare(`INSERT INTO sales_channels
      (id,channelName,channelType,contactInfo,remark,status,usageCount,deleted,createdBy,createdAt,updatedAt)
      VALUES ('partial-channel-conflict','已存在渠道','测试渠道',NULL,NULL,'active',0,0,?,?,?)`)
      .run(adminId, '2026-10-30 00:00:00', '2026-10-30 00:00:00');
    const partialChannelContent = JSON.stringify({ resources: { sales_channels: [
      { id: 'partial-channel-conflict', channelName: '已存在渠道', channelType: '测试渠道', status: 'active', createdBy: 'source-account-not-in-this-db' },
      { id: 'partial-channel-new', channelName: '新增渠道', channelType: '测试渠道', status: 'active', createdBy: 'source-account-not-in-this-db' },
    ] } });
    const partialChannelPreview = await call(routes.importPreview.POST, '/api/data-management/import/preview', 'POST', {
      resource: 'sales_channels', mode: 'insert', content: partialChannelContent,
    });
    assert.equal(partialChannelPreview.reports[0].valid, 1);
    assert.equal(partialChannelPreview.reports[0].conflicts, 1);
    assert.equal(partialChannelPreview.reports[0].errors.length, 0);
    assert.equal(partialChannelPreview.canApply, true);
    assert(partialChannelPreview.reports[0].warnings.some(warning => warning.includes('创建人缺少对应账号')));
    const partialChannelImport = await call(routes.import.POST, '/api/data-management/import', 'POST', {
      resource: 'sales_channels', mode: 'insert', fileName: 'partial-sales-channels.json', content: partialChannelContent,
    });
    assert.equal(partialChannelImport.inserted, 1);
    assert(db.prepare("SELECT createdBy FROM sales_channels WHERE id='partial-channel-new'").get().createdBy === adminId);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sales_channels WHERE channelName='已存在渠道'").get().n, 1);

    const systemUserUpsert = await call(routes.importPreview.POST, '/api/data-management/import/preview', 'POST', {
      resource: 'users', mode: 'upsert', content: { id: adminId, username: 'admin', role: 'warehouse_manager', status: 'active' },
    });
    assert(systemUserUpsert.reports[0].errors.some(error => error.message.includes('内置系统管理员')));

    const imported = await call(routes.import.POST, '/api/data-management/import', 'POST', {
      resource: 'suppliers', mode: 'insert', fileName: 'supplier.json', content: { id: 'dm-imported', supplierName: '导入供应商', status: 'active' },
    });
    assert.equal(imported.inserted, 1);
    assert(db.prepare("SELECT 1 FROM suppliers WHERE id='dm-imported'").get());
    assert(fs.existsSync(path.join(scratch, 'backups')));

    const purgePreview = await call(routes.purgePreview.GET, '/api/inventory/purge-preview?id=dm-machine');
    assert.equal(purgePreview.canDelete, true);
    const purged = await call(routes.inventory.DELETE, '/api/inventory?id=dm-machine', 'DELETE', { password: 'admin123', confirmText: '永久删除', reason: '隔离测试' });
    assert.equal(purged.sn, 'PURGE-SN-001');
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM inventory WHERE id='dm-machine'").get().n, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM inventory_movements WHERE inventoryId='dm-machine'").get().n, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM purchase_orders WHERE id='dm-order'").get().n, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM purchase_items WHERE id='dm-item'").get().n, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM data_management_audit WHERE action='inventory_purge'").get().n, 1);
    const purgeAudit = JSON.parse(db.prepare("SELECT summary FROM data_management_audit WHERE action='inventory_purge'").get().summary);
    assert.match(purgeAudit.backupSha256, /^[a-f0-9]{64}$/);

    const reentered = await call(routes.purchaseOrders.POST, '/api/purchase-orders', 'POST', {
      supplierId: 'dm-supplier', purchaseDate: '2026-11-01', purchasedBy: adminId, status: 'completed',
      items: [{ productType: '笔记本电脑', brand: 'ThinkPad', model: 'X13', cpu: 'I5-10210U', ram: '16GB', storage: '512GB', screen: '2.5K', sn: 'PURGE-SN-001', purchasePrice: 1000 }],
    }, 201);
    assert.equal(reentered.itemCount, 1, 'a purged machine SN should be accepted for a new inbound purchase');
    const reenteredInventoryId = reentered.inventoryIds[0];
    const oldPurchaseDetail = await call(routes.purchaseOrders.GET, '/api/purchase-orders?id=dm-order', 'GET', undefined, 200);
    assert.equal(oldPurchaseDetail.items[0].sn, 'PURGE-SN-001', 'the original purchase SN remains available in its history');
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM purchase_items WHERE sn='PURGE-SN-001'").get().n, 2);

    db.prepare(`INSERT INTO purchase_orders
      (id,purchaseNo,supplierOrderNo,supplierId,supplierName,purchaseDate,purchasedBy,createdBy,totalQuantity,totalAmount,isInbounded)
      VALUES ('soft-order','SOFT-ORDER','', 'dm-supplier','数据管理供应商','2026-10-30',?, ?,1,1000,1)`).run(adminId, adminId);
    db.prepare(`INSERT INTO purchase_items
      (id,purchaseOrderId,productType,brand,model,cpu,ram,storage,screen,sn,purchasePrice)
      VALUES ('soft-item','soft-order','笔记本电脑','ThinkPad','X13','I5-10210U','16GB','512GB','2.5K','SOFT-REMNANT-001',1000)`).run();
    db.prepare(`INSERT INTO inventory
      (id,purchaseOrderId,purchaseItemId,sn,productType,brand,model,cpu,ram,storage,screen,purchasePrice,supplierId,supplierName,status,inboundDate,warehouseId,deleted)
      VALUES ('soft-machine','soft-order','soft-item','SOFT-REMNANT-001','笔记本电脑','ThinkPad','X13','I5-10210U','16GB','512GB','2.5K',1000,'dm-supplier','数据管理供应商','in_stock','2026-10-30','warehouse_main',1)`).run();
    const softCheck = await call(routes.snCheck.GET, '/api/purchase-orders/sn-check?sn=SOFT-REMNANT-001');
    assert.equal(softCheck.canUse, true, 'soft-deleted inventory should not block reusing its SN after migration');
    assert.equal(softCheck.softDeletedInventory[0].id, 'soft-machine');
    const softPreview = await call(routes.purgePreview.GET, '/api/inventory/purge-preview?id=soft-machine');
    assert.equal(softPreview.canDelete, true, 'unreferenced soft-deleted machine should be offered for cleanup');
    await call(routes.inventory.DELETE, '/api/inventory?id=soft-machine', 'DELETE', { password: 'admin123', confirmText: '永久删除', reason: '清理测试残留' });
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM inventory WHERE id='soft-machine'").get().n, 0);
    const softReentry = await call(routes.purchaseOrders.POST, '/api/purchase-orders', 'POST', {
      supplierId: 'dm-supplier', purchaseDate: '2026-11-01', purchasedBy: adminId, status: 'completed',
      items: [{ productType: '笔记本电脑', brand: 'ThinkPad', model: 'X13', cpu: 'I5-10210U', ram: '16GB', storage: '512GB', screen: '2.5K', sn: 'SOFT-REMNANT-001', purchasePrice: 1000 }],
    }, 201);
    assert.equal(softReentry.itemCount, 1, 'cleaned soft-deleted machine SN should be accepted again');

    const editedPrice = await call(routes.inventoryEdit.POST, '/api/inventory/edit', 'POST', {
      inventoryId: reenteredInventoryId, expectedSn: 'PURGE-SN-001', fields: {
        sn: 'PURGE-SN-001', productType: '笔记本电脑', brand: 'ThinkPad', model: 'X13', year: null,
        cpu: 'I5-10210U', ram: '16GB', gpu: '', storage: '512GB', screen: '2.5K', touchScreen: null, purchasePrice: 1234.5,
      },
    });
    assert.equal(editedPrice.item.purchasePrice, 1234.5);
    const reenteredPurchaseItemId = db.prepare('SELECT purchaseItemId FROM inventory WHERE id=?').get(reenteredInventoryId).purchaseItemId;
    assert.equal(db.prepare('SELECT purchasePrice FROM purchase_items WHERE id=?').get(reenteredPurchaseItemId).purchasePrice, 1000);
    assert.equal(db.prepare('SELECT purchasePrice FROM purchase_items WHERE purchaseOrderId=?').get(reentered.id).purchasePrice, 1000,
      'editing inventory purchase price must not rewrite procurement history');
    assert.equal(JSON.parse(db.prepare('SELECT afterData FROM inventory_edit_logs WHERE inventoryId=?').get(reenteredInventoryId).afterData).purchasePrice, 1234.5,
      'purchase price changes must be captured in the machine edit history');
    await call(routes.inventoryEdit.POST, '/api/inventory/edit', 'POST', {
      inventoryId: reenteredInventoryId, expectedSn: 'PURGE-SN-001', fields: {
        sn: 'PURGE-SN-001', productType: '笔记本电脑', brand: 'ThinkPad', model: 'X13', year: null,
        cpu: 'I5-10210U', ram: '16GB', gpu: '', storage: '512GB', screen: '2.5K', touchScreen: null, purchasePrice: -1,
      },
    }, 400);
    assert.equal(db.prepare('SELECT purchasePrice FROM inventory WHERE id=?').get(reenteredInventoryId).purchasePrice, 1234.5,
      'invalid purchase prices must not partially update the machine');

    await call(routes.purchaseOrders.POST, '/api/purchase-orders', 'POST', {
      supplierId: 'dm-supplier', purchaseDate: '2026-11-01', purchasedBy: adminId, status: 'draft',
      items: [{ productType: '笔记本电脑', brand: 'ThinkPad', model: 'X13', cpu: 'I5-10210U', ram: '16GB', storage: '512GB', screen: '2.5K', sn: 'DRAFT-SN-001', purchasePrice: 1000 }],
    }, 201);
    const draftSnCollisionResponse = await routes.purchaseOrders.POST(request('/api/purchase-orders', 'POST', {
      supplierId: 'dm-supplier', purchaseDate: '2026-11-01', purchasedBy: adminId, status: 'completed',
      items: [{ productType: '笔记本电脑', brand: 'ThinkPad', model: 'X13', cpu: 'I5-10210U', ram: '16GB', storage: '512GB', screen: '2.5K', sn: 'DRAFT-SN-001', purchasePrice: 1000 }],
    }));
    const draftSnCollision = await draftSnCollisionResponse.json();
    assert.equal(draftSnCollisionResponse.status, 409);
    assert.equal(draftSnCollision.error.details.kind, 'sn_conflicts');
    assert(draftSnCollision.error.details.conflicts[0].reasons.some(reason => reason.source === 'purchase_draft'));

    db.prepare(`INSERT INTO inventory
      (id,purchaseOrderId,purchaseItemId,sn,productType,brand,model,cpu,ram,storage,screen,purchasePrice,supplierId,supplierName,status,inboundDate,warehouseId)
      VALUES ('dm-blocked','dm-order','dm-item','PURGE-SN-002','笔记本电脑','ThinkPad','X13','I5-10210U','16GB','512GB','2.5K',1000,'dm-supplier','数据管理供应商','sold','2026-10-30','warehouse_main')`).run();
    const blocked = await call(routes.purgePreview.GET, '/api/inventory/purge-preview?id=dm-blocked');
    assert.equal(blocked.canDelete, false);
    assert(blocked.reasons.some(reason => reason.includes('普通在库')));
    const managerId = 'dm-manager';
    db.prepare("INSERT INTO users (id,username,password,role,status) VALUES (?,?,?,?,?)").run(managerId, managerId, 'test', 'admin', 'active');
    token = auth.createSession(managerId);
    await call(routes.resources.GET, '/api/data-management/resources', 'GET', undefined, 403);
    await call(routes.purgePreview.GET, '/api/inventory/purge-preview?id=dm-blocked', 'GET', undefined, 403);
    await call(routes.inventory.DELETE, '/api/inventory?id=dm-blocked', 'DELETE', { password: 'admin123', confirmText: '永久删除' }, 403);
    db.prepare("INSERT INTO users (id,username,password,role,status,isSystemAccount) VALUES ('fake-system','fake-system','test','warehouse_manager','active',1)").run();
    token = auth.createSession('fake-system');
    await call(routes.purgePreview.GET, '/api/inventory/purge-preview?id=dm-blocked', 'GET', undefined, 403);
    await call(routes.inventory.DELETE, '/api/inventory?id=dm-blocked', 'DELETE', { password: 'admin123', confirmText: '永久删除' }, 403);
    token = auth.createSession(adminId);
    assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
    assert.deepEqual(db.pragma('foreign_key_check'), []);
    console.log('PASS isolated data management: system-account permission, filtered export, sensitive-field exclusion, import preview/backup, purge preflight, machine-history cleanup, purchase-history retention and integrity checks');
  } finally {
    if (previousPath === undefined) delete process.env.INVENTORY_DB_PATH; else process.env.INVENTORY_DB_PATH = previousPath;
    db.close();
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
