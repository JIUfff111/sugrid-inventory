const { randomBytes, scryptSync } = require('node:crypto');
function hashPassword(password) { const salt = randomBytes(16); return 'scrypt$16384$8$1$' + salt.toString('base64url') + '$' + scryptSync(password, salt, 64, {N:16384,r:8,p:1}).toString('base64url'); }
function initDatabase(db) {
  // 创建用户表
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      realName TEXT,
      role TEXT NOT NULL DEFAULT 'warehouse_manager',
      status TEXT NOT NULL DEFAULT 'active',
      isSystemAccount INTEGER NOT NULL DEFAULT 0,
      deletedAt TEXT,
      deletedBy TEXT,
      createdAt TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      updatedAt TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
    )
  `);

  // 创建供应商表
  db.exec(`
    CREATE TABLE IF NOT EXISTS suppliers (
      id TEXT PRIMARY KEY,
      supplierName TEXT UNIQUE NOT NULL,
      contactPerson TEXT,
      contactPhone TEXT,
      address TEXT,
      remark TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      deleted INTEGER NOT NULL DEFAULT 0,
      createdBy TEXT,
      createdAt TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      updatedAt TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      FOREIGN KEY (createdBy) REFERENCES users(id)
    )
  `);

  // 创建销售渠道表
  db.exec(`
    CREATE TABLE IF NOT EXISTS sales_channels (
      id TEXT PRIMARY KEY,
      channelName TEXT UNIQUE NOT NULL,
      channelType TEXT,
      contactInfo TEXT,
      remark TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      usageCount INTEGER NOT NULL DEFAULT 0,
      deleted INTEGER NOT NULL DEFAULT 0,
      createdBy TEXT,
      createdAt TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      updatedAt TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      FOREIGN KEY (createdBy) REFERENCES users(id)
    )
  `);

  // 创建 SKU 表
  db.exec(`
    CREATE TABLE IF NOT EXISTS skus (
      id TEXT PRIMARY KEY,
      productType TEXT NOT NULL,
      brand TEXT NOT NULL,
      model TEXT NOT NULL,
      year INTEGER,
      cpuOptions TEXT,
      ramOptions TEXT,
      gpuOptions TEXT,
      storageOptions TEXT,
      screenOptions TEXT,
      priceMin REAL,
      priceMax REAL,
      deleted INTEGER NOT NULL DEFAULT 0,
      createdBy TEXT,
      createdAt TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      updatedAt TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      FOREIGN KEY (createdBy) REFERENCES users(id)
    )
  `);

  // 创建采购单表
  db.exec(`
    CREATE TABLE IF NOT EXISTS purchase_orders (
      id TEXT PRIMARY KEY,
      purchaseNo TEXT UNIQUE NOT NULL,
      supplierOrderNo TEXT NOT NULL,
      supplierId TEXT NOT NULL,
      supplierName TEXT NOT NULL,
      purchaseDate TEXT NOT NULL,
      purchasedBy TEXT NOT NULL,
      totalAmount REAL NOT NULL DEFAULT 0,
      totalQuantity INTEGER NOT NULL DEFAULT 0,
      isInbounded INTEGER NOT NULL DEFAULT 0,
      remark TEXT,
      deleted INTEGER NOT NULL DEFAULT 0,
      createdBy TEXT NOT NULL,
      createdAt TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      updatedAt TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      FOREIGN KEY (supplierId) REFERENCES suppliers(id),
      FOREIGN KEY (purchasedBy) REFERENCES users(id),
      FOREIGN KEY (createdBy) REFERENCES users(id)
    )
  `);

  // 创建采购明细表
  db.exec(`
    CREATE TABLE IF NOT EXISTS purchase_items (
      id TEXT PRIMARY KEY,
      purchaseOrderId TEXT NOT NULL,
      productType TEXT NOT NULL,
      brand TEXT NOT NULL,
      model TEXT NOT NULL,
      year INTEGER,
      cpu TEXT NOT NULL,
      ram TEXT NOT NULL,
      gpu TEXT,
      storage TEXT NOT NULL,
      screen TEXT NOT NULL,
      sn TEXT UNIQUE NOT NULL,
      purchasePrice REAL NOT NULL,
      remark TEXT,
      deleted INTEGER NOT NULL DEFAULT 0,
      createdAt TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      FOREIGN KEY (purchaseOrderId) REFERENCES purchase_orders(id) ON DELETE CASCADE
    )
  `);

  // 创建索引：采购明细的 SN
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_purchase_items_sn ON purchase_items(sn)
  `);

  // 创建库存表
  db.exec(`
    CREATE TABLE IF NOT EXISTS inventory (
      id TEXT PRIMARY KEY,
      purchaseOrderId TEXT NOT NULL,
      purchaseItemId TEXT NOT NULL,
      warehouseId TEXT NOT NULL DEFAULT 'warehouse_main',
      sn TEXT UNIQUE NOT NULL,
      productType TEXT NOT NULL,
      brand TEXT NOT NULL,
      model TEXT NOT NULL,
      year INTEGER,
      cpu TEXT NOT NULL,
      ram TEXT NOT NULL,
      gpu TEXT,
      storage TEXT NOT NULL,
      screen TEXT NOT NULL,
      purchasePrice REAL NOT NULL,
      supplierId TEXT NOT NULL,
      supplierName TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'in_stock',
      inboundDate TEXT NOT NULL,
      soldDate TEXT,
      sellingPrice REAL,
      saleChannel TEXT,
      saleOrderNo TEXT,
      profit REAL,
      rentalRecordId TEXT,
      remark TEXT,
      deleted INTEGER NOT NULL DEFAULT 0,
      createdAt TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      updatedAt TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      FOREIGN KEY (purchaseOrderId) REFERENCES purchase_orders(id),
      FOREIGN KEY (purchaseItemId) REFERENCES purchase_items(id),
      FOREIGN KEY (supplierId) REFERENCES suppliers(id)
    )
  `);

  // 创建索引：库存的 SN
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_inventory_sn ON inventory(sn)
  `);

  // 创建索引：库存状态和删除标记（用于快速筛选）
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_inventory_status ON inventory(status, deleted)
  `);

  // 创建销售记录表
  db.exec(`
    CREATE TABLE IF NOT EXISTS sales_records (
      id TEXT PRIMARY KEY,
      recordNo TEXT UNIQUE NOT NULL,
      saleChannel TEXT NOT NULL,
      saleOrderNo TEXT NOT NULL,
      saleDate TEXT NOT NULL,
      items TEXT NOT NULL,
      totalQuantity INTEGER NOT NULL,
      totalCost REAL NOT NULL,
      totalAmount REAL NOT NULL,
      totalProfit REAL NOT NULL,
      status TEXT NOT NULL DEFAULT 'completed',
      cancelledAt TEXT,
      cancelledBy TEXT,
      cancelReason TEXT,
      remark TEXT,
      deleted INTEGER NOT NULL DEFAULT 0,
      createdBy TEXT NOT NULL,
      createdAt TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      FOREIGN KEY (createdBy) REFERENCES users(id)
    )
  `);

  // 创建租赁记录表
  db.exec(`
    CREATE TABLE IF NOT EXISTS rental_records (
      id TEXT PRIMARY KEY,
      rentalNo TEXT UNIQUE NOT NULL,
      inventoryId TEXT NOT NULL,
      sn TEXT NOT NULL,
      brand TEXT NOT NULL,
      model TEXT NOT NULL,
      config TEXT NOT NULL,
      purchasePrice REAL NOT NULL,
      customerName TEXT NOT NULL,
      customerPhone TEXT NOT NULL,
      customerAddress TEXT NOT NULL,
      rentalStartDate TEXT NOT NULL,
      rentalEndDate TEXT NOT NULL,
      rentalType TEXT NOT NULL,
      rentalUnitPrice REAL NOT NULL,
      rentalDuration INTEGER NOT NULL,
      rentalTotalPrice REAL NOT NULL,
      deposit REAL NOT NULL,
      status TEXT NOT NULL DEFAULT 'renting',
      returnDate TEXT,
      returnType TEXT,
      sellingPrice REAL,
      priceDifference REAL,
      saleChannel TEXT,
      saleOrderNo TEXT,
      salesRecordId TEXT,
      remark TEXT,
      deleted INTEGER NOT NULL DEFAULT 0,
      createdBy TEXT NOT NULL,
      createdAt TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      updatedAt TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      FOREIGN KEY (inventoryId) REFERENCES inventory(id),
      FOREIGN KEY (createdBy) REFERENCES users(id)
    )
  `);

  // 创建客户售后记录表
  db.exec(`
    CREATE TABLE IF NOT EXISTS after_sale_records (
      id TEXT PRIMARY KEY,
      afterSaleNo TEXT UNIQUE NOT NULL,
      inventoryId TEXT NOT NULL,
      sn TEXT NOT NULL,
      salesRecordId TEXT,
      saleOrderNo TEXT,
      customerName TEXT NOT NULL,
      customerPhone TEXT NOT NULL,
      issueType TEXT NOT NULL,
      issueDescription TEXT,
      resolutionType TEXT NOT NULL,
      replacementInventoryId TEXT,
      status TEXT NOT NULL DEFAULT 'processing',
      refundAmount REAL NOT NULL DEFAULT 0,
      resolutionNote TEXT,
      resolvedAt TEXT,
      receivedAt TEXT,
      receivedBy TEXT,
      receivedCondition TEXT,
      receivedNote TEXT,
      deleted INTEGER NOT NULL DEFAULT 0,
      createdBy TEXT NOT NULL,
      createdAt TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      updatedAt TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      FOREIGN KEY (inventoryId) REFERENCES inventory(id),
      FOREIGN KEY (salesRecordId) REFERENCES sales_records(id),
      FOREIGN KEY (createdBy) REFERENCES users(id)
    )
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_rental_records_inventory ON rental_records(inventoryId, status, deleted);
    CREATE INDEX IF NOT EXISTS idx_rental_records_status ON rental_records(status, deleted, createdAt);
    CREATE INDEX IF NOT EXISTS idx_after_sale_inventory ON after_sale_records(inventoryId, status, deleted);
    CREATE INDEX IF NOT EXISTS idx_after_sale_status ON after_sale_records(status, deleted, createdAt);
    CREATE INDEX IF NOT EXISTS idx_after_sale_sn ON after_sale_records(sn);
  `);

  // 创建退货单表
  db.exec(`
    CREATE TABLE IF NOT EXISTS return_orders (
      id TEXT PRIMARY KEY,
      returnNo TEXT UNIQUE NOT NULL,
      items TEXT NOT NULL,
      purchaseOrderId TEXT NOT NULL,
      purchaseOrderNo TEXT NOT NULL,
      supplierId TEXT NOT NULL,
      supplierName TEXT NOT NULL,
      returnReason TEXT NOT NULL,
      returnDescription TEXT,
      refundAmount REAL NOT NULL,
      status TEXT NOT NULL DEFAULT 'returning',
      completedAt TEXT,
      deleted INTEGER NOT NULL DEFAULT 0,
      createdBy TEXT NOT NULL,
      createdAt TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      updatedAt TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      FOREIGN KEY (purchaseOrderId) REFERENCES purchase_orders(id),
      FOREIGN KEY (supplierId) REFERENCES suppliers(id),
      FOREIGN KEY (createdBy) REFERENCES users(id)
    )
  `);

  // 创建标签模板表
  db.exec(`
    CREATE TABLE IF NOT EXISTS label_templates (
      id TEXT PRIMARY KEY,
      templateName TEXT UNIQUE NOT NULL,
      templateType TEXT NOT NULL,
      width REAL NOT NULL,
      height REAL NOT NULL,
      orientation TEXT NOT NULL DEFAULT 'portrait',
      fields TEXT NOT NULL,
      isDefault INTEGER NOT NULL DEFAULT 0,
      deleted INTEGER NOT NULL DEFAULT 0,
      createdBy TEXT NOT NULL,
      createdAt TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      updatedAt TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      FOREIGN KEY (createdBy) REFERENCES users(id)
    )
  `);

  console.log('✅ 数据库表结构初始化完成');

  // 表结构迁移：补充后加的列（已存在则忽略）
  const migrations = [
    ['skus', 'ALTER TABLE skus ADD COLUMN year INTEGER'],
    ['purchase_items', 'ALTER TABLE purchase_items ADD COLUMN year INTEGER'],
    ['inventory', 'ALTER TABLE inventory ADD COLUMN year INTEGER'],
    ['purchase_items', 'ALTER TABLE purchase_items ADD COLUMN touchScreen INTEGER'],
    ['purchase_items', 'ALTER TABLE purchase_items ADD COLUMN skuRemark TEXT'],
    ['after_sale_records', 'ALTER TABLE after_sale_records ADD COLUMN replacementInventoryId TEXT'],
    ['purchase_items', 'ALTER TABLE purchase_items ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0'],
    ['inventory', 'ALTER TABLE inventory ADD COLUMN touchScreen INTEGER'],
    ['inventory', 'ALTER TABLE inventory ADD COLUMN skuRemark TEXT'],
    ['sales_records', 'ALTER TABLE sales_records ADD COLUMN trackingNo TEXT'],
    // Multi-warehouse and authentication fields.  The default keeps old and
    // new inventory writes assigned to the bootstrap warehouse.
    ['inventory', "ALTER TABLE inventory ADD COLUMN warehouseId TEXT DEFAULT 'warehouse_main'"],
    ['sales_records', "ALTER TABLE sales_records ADD COLUMN status TEXT NOT NULL DEFAULT 'completed'"],
    ['sales_records', 'ALTER TABLE sales_records ADD COLUMN cancelledAt TEXT'],
    ['sales_records', 'ALTER TABLE sales_records ADD COLUMN cancelledBy TEXT'],
    ['sales_records', 'ALTER TABLE sales_records ADD COLUMN cancelReason TEXT'],
    ['after_sale_records', 'ALTER TABLE after_sale_records ADD COLUMN receivedAt TEXT'],
    ['after_sale_records', 'ALTER TABLE after_sale_records ADD COLUMN receivedBy TEXT'],
    ['after_sale_records', 'ALTER TABLE after_sale_records ADD COLUMN receivedCondition TEXT'],
    ['after_sale_records', 'ALTER TABLE after_sale_records ADD COLUMN receivedNote TEXT'],
  ];
  for (const [table, sql] of migrations) {
    const column = sql.match(/ADD COLUMN (\w+)/i)[1];
    if (!db.pragma('table_info(' + table + ')').some(row => row.name === column)) db.exec(sql);
  }

  // The remainder of the schema is intentionally expressed as CREATE IF NOT
  // EXISTS plus small, explicit updates.  This makes importing an existing
  // database safe: no table is dropped and every migration can be run again.
  db.exec(`
    CREATE TABLE IF NOT EXISTS warehouses (
      id TEXT PRIMARY KEY,
      code TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      warehouseCode TEXT,
      warehouseName TEXT,
      address TEXT,
      remark TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      isDefault INTEGER NOT NULL DEFAULT 0,
      createdBy TEXT,
      createdAt TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      updatedAt TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      FOREIGN KEY (createdBy) REFERENCES users(id)
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_warehouses_code ON warehouses(code);
    CREATE INDEX IF NOT EXISTS idx_warehouses_status ON warehouses(status, isDefault);

    CREATE TABLE IF NOT EXISTS user_warehouses (
      userId TEXT NOT NULL,
      warehouseId TEXT NOT NULL,
      createdBy TEXT,
      createdAt TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      PRIMARY KEY (userId, warehouseId),
      FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (warehouseId) REFERENCES warehouses(id) ON DELETE CASCADE,
      FOREIGN KEY (createdBy) REFERENCES users(id)
    );
    CREATE INDEX IF NOT EXISTS idx_user_warehouses_warehouse ON user_warehouses(warehouseId, userId);

    CREATE TABLE IF NOT EXISTS transfers (
      id TEXT PRIMARY KEY,
      transferNo TEXT UNIQUE NOT NULL,
      sourceWarehouseId TEXT NOT NULL,
      targetWarehouseId TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft',
      remark TEXT,
      createdBy TEXT NOT NULL,
      approvedBy TEXT,
      approvedAt TEXT,
      completedAt TEXT,
      createdAt TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      updatedAt TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      FOREIGN KEY (sourceWarehouseId) REFERENCES warehouses(id),
      FOREIGN KEY (targetWarehouseId) REFERENCES warehouses(id),
      FOREIGN KEY (createdBy) REFERENCES users(id),
      FOREIGN KEY (approvedBy) REFERENCES users(id)
    );
    CREATE INDEX IF NOT EXISTS idx_transfers_status ON transfers(status, createdAt);
    CREATE INDEX IF NOT EXISTS idx_transfers_warehouses ON transfers(sourceWarehouseId, targetWarehouseId);

    CREATE TABLE IF NOT EXISTS transfer_items (
      id TEXT PRIMARY KEY,
      transferId TEXT NOT NULL,
      inventoryId TEXT NOT NULL,
      sn TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      remark TEXT,
      createdAt TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      updatedAt TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      FOREIGN KEY (transferId) REFERENCES transfers(id) ON DELETE CASCADE,
      FOREIGN KEY (inventoryId) REFERENCES inventory(id)
    );
    CREATE INDEX IF NOT EXISTS idx_transfer_items_transfer ON transfer_items(transferId, status);
    CREATE INDEX IF NOT EXISTS idx_transfer_items_inventory ON transfer_items(inventoryId);

    CREATE TABLE IF NOT EXISTS inventory_movements (
      id TEXT PRIMARY KEY,
      inventoryId TEXT NOT NULL,
      warehouseId TEXT,
      fromWarehouseId TEXT,
      toWarehouseId TEXT,
      movementType TEXT NOT NULL,
      quantity INTEGER NOT NULL DEFAULT 1,
      referenceType TEXT,
      referenceId TEXT,
      actorId TEXT,
      note TEXT,
      createdAt TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      FOREIGN KEY (inventoryId) REFERENCES inventory(id),
      FOREIGN KEY (warehouseId) REFERENCES warehouses(id),
      FOREIGN KEY (fromWarehouseId) REFERENCES warehouses(id),
      FOREIGN KEY (toWarehouseId) REFERENCES warehouses(id),
      FOREIGN KEY (actorId) REFERENCES users(id)
    );
    CREATE INDEX IF NOT EXISTS idx_inventory_movements_inventory ON inventory_movements(inventoryId, createdAt);
    CREATE INDEX IF NOT EXISTS idx_inventory_movements_reference ON inventory_movements(referenceType, referenceId);

    CREATE TABLE IF NOT EXISTS after_sale_stock (
      id TEXT PRIMARY KEY,
      afterSaleId TEXT NOT NULL,
      afterSaleRecordId TEXT,
      inventoryId TEXT NOT NULL,
      stockStatus TEXT NOT NULL DEFAULT 'awaiting_receipt',
      receivedAt TEXT,
      receivedBy TEXT,
      condition TEXT,
      note TEXT,
      createdAt TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      updatedAt TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      FOREIGN KEY (afterSaleId) REFERENCES after_sale_records(id) ON DELETE CASCADE,
      FOREIGN KEY (afterSaleRecordId) REFERENCES after_sale_records(id) ON DELETE CASCADE,
      FOREIGN KEY (inventoryId) REFERENCES inventory(id),
      FOREIGN KEY (receivedBy) REFERENCES users(id)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_after_sale_stock_record ON after_sale_stock(afterSaleId);
    CREATE INDEX IF NOT EXISTS idx_after_sale_stock_inventory ON after_sale_stock(inventoryId, stockStatus);

    CREATE TABLE IF NOT EXISTS sales_record_items (
      id TEXT PRIMARY KEY,
      salesRecordId TEXT NOT NULL,
      saleRecordId TEXT,
      inventoryId TEXT NOT NULL,
      sn TEXT NOT NULL,
      purchasePrice REAL NOT NULL DEFAULT 0,
      sellingPrice REAL NOT NULL DEFAULT 0,
      profit REAL NOT NULL DEFAULT 0,
      remark TEXT,
      createdAt TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      FOREIGN KEY (salesRecordId) REFERENCES sales_records(id) ON DELETE CASCADE,
      FOREIGN KEY (saleRecordId) REFERENCES sales_records(id) ON DELETE CASCADE,
      FOREIGN KEY (inventoryId) REFERENCES inventory(id)
    );
    CREATE INDEX IF NOT EXISTS idx_sales_record_items_record ON sales_record_items(salesRecordId);
    CREATE INDEX IF NOT EXISTS idx_sales_record_items_inventory ON sales_record_items(inventoryId);

    CREATE TABLE IF NOT EXISTS return_receipts (
      id TEXT PRIMARY KEY,
      receiptNo TEXT UNIQUE NOT NULL,
      returnOrderId TEXT,
      returnId TEXT,
      inventoryId TEXT,
      sn TEXT,
      status TEXT NOT NULL DEFAULT 'received',
      receivedAt TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      receivedBy TEXT,
      condition TEXT,
      note TEXT,
      createdAt TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      FOREIGN KEY (returnOrderId) REFERENCES return_orders(id),
      FOREIGN KEY (returnId) REFERENCES return_orders(id),
      FOREIGN KEY (inventoryId) REFERENCES inventory(id),
      FOREIGN KEY (receivedBy) REFERENCES users(id)
    );
    CREATE INDEX IF NOT EXISTS idx_return_receipts_order ON return_receipts(returnOrderId, status);
    CREATE INDEX IF NOT EXISTS idx_return_receipts_inventory ON return_receipts(inventoryId);

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      userId TEXT NOT NULL,
      tokenHash TEXT UNIQUE NOT NULL,
      expiresAt TEXT NOT NULL,
      createdAt TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      lastSeenAt TEXT,
      revokedAt TEXT,
      FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(userId, expiresAt);
    CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expiresAt, revokedAt);
  `);

  // Ensure a deterministic default warehouse exists and all historical stock
  // points to it.  INSERT OR IGNORE keeps an administrator's custom name.
  const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
  db.prepare(`
    INSERT OR IGNORE INTO warehouses
      (id, code, name, warehouseCode, warehouseName, status, isDefault, createdAt, updatedAt)
    VALUES ('warehouse_main', 'MAIN', '总仓', 'MAIN', '总仓', 'active', 1, ?, ?)
  `).run(now, now);
  db.prepare(`
    UPDATE warehouses SET isDefault = CASE WHEN id = 'warehouse_main' THEN 1 ELSE isDefault END
    WHERE id = 'warehouse_main'
  `).run();
  db.prepare("UPDATE inventory SET warehouseId = 'warehouse_main' WHERE warehouseId IS NULL OR TRIM(warehouseId) = ''").run();
  applyVersionedMigrations(db);

}

/**
 * 插入初始数据
 */
function seedDatabase(db) {
  // 检查是否已有数据
  const userCount = db.prepare('SELECT COUNT(*) as count FROM users').get();
  
  if (userCount.count > 0) {
    console.log('⚠️  数据库已有数据，跳过初始化数据插入');
    return;
  }

  // 插入默认管理员用户（密码：admin123，实际应该加密）
  const userId = 'user_' + Date.now();
  db.prepare(`
    INSERT INTO users (id, username, password, realName, role, status, isSystemAccount)
    VALUES (?, ?, ?, ?, ?, ?, 1)
  `).run(userId, 'admin', hashPassword('admin123'), '系统管理员', 'admin', 'active');
  db.prepare(`
    INSERT OR IGNORE INTO user_warehouses (userId, warehouseId)
    VALUES (?, 'warehouse_main')
  `).run(userId);

  console.log('✅ 初始数据插入完成');

}


function applyVersionedMigrations(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, appliedAt TEXT NOT NULL DEFAULT (datetime('now')))`);
  const migrate = (version, name, run) => {
    if (db.prepare('SELECT version FROM schema_migrations WHERE version = ?').get(version)) return;
    db.transaction(() => { run(); db.prepare('INSERT INTO schema_migrations (version, name) VALUES (?, ?)').run(version, name); })();
  };
  const add = (table, name, definition) => {
    if (!db.pragma('table_info(' + table + ')').some(row => row.name === name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
  };
  migrate(1, 'multiwarehouse lifecycle and immutable business snapshots', () => {
    for (const [table, column, definition] of [
      ['inventory_movements', 'sn', 'TEXT'], ['inventory_movements', 'snapshot', 'TEXT'],
      ['inventory_movements', 'statusFrom', 'TEXT'], ['inventory_movements', 'statusTo', 'TEXT'],
      ['sales_record_items', 'warehouseId', 'TEXT'], ['sales_record_items', 'snapshot', 'TEXT'],
      ['sales_record_items', 'afterSaleId', 'TEXT'], ['sales_record_items', 'itemType', "TEXT NOT NULL DEFAULT 'sale'"],
      ['sales_record_items', 'originalInventoryId', 'TEXT'], ['return_receipts', 'salesRecordId', 'TEXT'],
      ['return_receipts', 'warehouseId', 'TEXT'], ['return_receipts', 'purchasePrice', 'REAL'],
      ['return_receipts', 'reason', 'TEXT'], ['return_receipts', 'snapshot', 'TEXT']
    ]) add(table, column, definition);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_movements_type_time ON inventory_movements(movementType, createdAt);
      CREATE INDEX IF NOT EXISTS idx_movements_actor_time ON inventory_movements(actorId, createdAt);
      CREATE INDEX IF NOT EXISTS idx_inventory_warehouse_status ON inventory(warehouseId,status,deleted);
      CREATE INDEX IF NOT EXISTS idx_after_sale_stock_received ON after_sale_stock(stockStatus,receivedAt);
      CREATE INDEX IF NOT EXISTS idx_receipts_sales ON return_receipts(salesRecordId);
      CREATE TRIGGER IF NOT EXISTS movement_snapshot AFTER INSERT ON inventory_movements BEGIN
        UPDATE inventory_movements SET sn = COALESCE(NEW.sn,(SELECT sn FROM inventory WHERE id = NEW.inventoryId)),
          statusTo = COALESCE(NEW.statusTo,(SELECT status FROM inventory WHERE id = NEW.inventoryId)),
          snapshot = COALESCE(NEW.snapshot,(SELECT json_object('sn',sn,'brand',brand,'model',model,'year',year,'cpu',cpu,'ram',ram,'storage',storage,'gpu',gpu,'purchasePrice',purchasePrice,'sellingPrice',sellingPrice,'status',status,'warehouseId',warehouseId) FROM inventory WHERE id = NEW.inventoryId))
        WHERE id = NEW.id;
      END;`);
    const machines = db.prepare('SELECT * FROM inventory WHERE deleted = 0').all();
    const opening = db.prepare(`INSERT OR IGNORE INTO inventory_movements (id, inventoryId, warehouseId, toWarehouseId, movementType, referenceType, referenceId, actorId, note, createdAt) VALUES (?, ?, ?, ?, 'opening_balance', 'migration', ?, ?, '历史库存初始化；当前快照', ?)`);
    const historical = db.prepare(`INSERT OR IGNORE INTO inventory_movements (id, inventoryId, warehouseId, movementType, referenceType, referenceId, actorId, note, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const item of machines) {
      const purchase = db.prepare('SELECT createdBy FROM purchase_orders WHERE id = ?').get(item.purchaseOrderId);
      const actor = purchase?.createdBy || null;
      opening.run('opening_' + item.id, item.id, item.warehouseId, item.warehouseId, item.purchaseOrderId, actor, item.createdAt);
      historical.run('historical_purchase_' + item.id, item.id, item.warehouseId, 'purchase_in', 'purchase_order', item.purchaseOrderId, actor, '由原采购单补写的历史事件', item.inboundDate || item.createdAt);
    }
    for (const sale of db.prepare('SELECT * FROM sales_records').all()) {
      let items = []; try { items = JSON.parse(sale.items); } catch { continue; }
      for (const line of items) {
        const item = db.prepare('SELECT * FROM inventory WHERE id = ? OR sn = ? LIMIT 1').get(line.inventoryId || line.id || '', line.sn || '');
        if (!item) continue;
        if (!db.prepare('SELECT id FROM sales_record_items WHERE salesRecordId = ? AND inventoryId = ?').get(sale.id,item.id)) {
          db.prepare('INSERT INTO sales_record_items (id,salesRecordId,saleRecordId,inventoryId,sn,purchasePrice,sellingPrice,profit,warehouseId,snapshot,createdAt) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run('historical_sale_item_' + sale.id + '_' + item.id, sale.id, sale.id, item.id, item.sn, line.purchasePrice ?? item.purchasePrice, line.sellingPrice ?? item.sellingPrice ?? 0, line.profit ?? 0, item.warehouseId, JSON.stringify(line), sale.createdAt);
        }
        historical.run('historical_sale_' + sale.id + '_' + item.id,item.id,item.warehouseId,'sale','sales_record',sale.id,sale.createdBy,'由原销售单补写的历史事件',sale.createdAt);
      }
    }
    db.exec(`UPDATE inventory_movements SET sn = (SELECT sn FROM inventory WHERE id = inventoryId), snapshot = (SELECT json_object('sn',sn,'brand',brand,'model',model,'year',year,'status',status,'warehouseId',warehouseId,'purchasePrice',purchasePrice) FROM inventory WHERE id = inventoryId) WHERE snapshot IS NULL;
      UPDATE sales_record_items SET warehouseId = (SELECT warehouseId FROM inventory WHERE id = inventoryId), snapshot = (SELECT json_object('sn',sn,'brand',brand,'model',model,'year',year,'cpu',cpu,'ram',ram,'storage',storage) FROM inventory WHERE id = inventoryId) WHERE snapshot IS NULL;
      INSERT OR IGNORE INTO user_warehouses(userId,warehouseId) SELECT id,'warehouse_main' FROM users WHERE role = 'admin';`);
    for (const user of db.prepare("SELECT id,password FROM users WHERE password NOT LIKE 'scrypt$%'").all()) {
      db.prepare('UPDATE users SET password = ? WHERE id = ?').run(hashPassword(user.password),user.id);
    }
  });
  migrate(2, 'canonical password encoding and transfer reservations', () => {
    for (const user of db.prepare('SELECT id,password FROM users').all()) {
      const parts = user.password.split('$');
      if (parts.length === 6 && /^[a-f0-9]{32}$/.test(parts[4]) && /^[a-f0-9]{128}$/.test(parts[5])) {
        parts[4] = Buffer.from(parts[4],'utf8').toString('base64url');
        parts[5] = Buffer.from(parts[5],'hex').toString('base64url');
        db.prepare('UPDATE users SET password = ? WHERE id = ?').run(parts.join('$'),user.id);
      }
    }
    db.exec(`CREATE TRIGGER IF NOT EXISTS prevent_stock_use_during_transfer BEFORE UPDATE OF status ON inventory
      WHEN OLD.status = 'in_stock' AND NEW.status != 'in_stock' AND EXISTS (
        SELECT 1 FROM transfer_items ti JOIN transfers t ON t.id = ti.transferId
        WHERE ti.inventoryId = OLD.id AND t.status IN ('pending','approved','in_transit'))
      BEGIN SELECT RAISE(ABORT, '该机器有进行中的调拨申请，请先处理或取消调拨'); END;`);
  });
  migrate(3, 'restrict legacy roles to supported permissions', () => {
    db.prepare("UPDATE users SET role = 'warehouse_manager' WHERE role NOT IN ('admin','warehouse_manager')").run();
    db.prepare("INSERT OR IGNORE INTO user_warehouses(userId,warehouseId) SELECT id,'warehouse_main' FROM users WHERE role = 'admin'").run();
  });
  migrate(4, 'custom inventory status and operational eligibility', () => {
    add('inventory', 'currentStatusRecordId', 'TEXT');
    db.exec(`
      CREATE TABLE IF NOT EXISTS inventory_status_definitions (
        id TEXT PRIMARY KEY, name TEXT NOT NULL COLLATE NOCASE UNIQUE,
        color TEXT NOT NULL DEFAULT '#2563eb', allowStockOperations INTEGER NOT NULL DEFAULT 0,
        isActive INTEGER NOT NULL DEFAULT 1, createdBy TEXT, updatedBy TEXT,
        createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS inventory_status_records (
        id TEXT PRIMARY KEY, inventoryId TEXT NOT NULL REFERENCES inventory(id),
        definitionId TEXT NOT NULL REFERENCES inventory_status_definitions(id),
        definitionSnapshot TEXT NOT NULL, reason TEXT NOT NULL, location TEXT NOT NULL,
        responsiblePerson TEXT NOT NULL, expectedReturnDate TEXT, remark TEXT,
        warehouseId TEXT NOT NULL, createdBy TEXT NOT NULL, createdAt TEXT NOT NULL,
        closedAt TEXT, closedBy TEXT, resultNote TEXT, closingReferenceType TEXT, closingReferenceId TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_status_record_active ON inventory_status_records(inventoryId) WHERE closedAt IS NULL;
      CREATE INDEX IF NOT EXISTS idx_status_record_definition ON inventory_status_records(definitionId, closedAt);
      CREATE INDEX IF NOT EXISTS idx_inventory_current_status ON inventory(currentStatusRecordId);
      DROP TRIGGER IF EXISTS prevent_stock_use_during_transfer;
      CREATE TRIGGER prevent_stock_use_during_transfer BEFORE UPDATE OF status ON inventory
      WHEN OLD.status IN ('in_stock','custom') AND NEW.status != OLD.status AND EXISTS (
        SELECT 1 FROM transfer_items ti JOIN transfers t ON t.id = ti.transferId
        WHERE ti.inventoryId = OLD.id AND t.status IN ('pending','approved','in_transit'))
      BEGIN SELECT RAISE(ABORT, '该机器有进行中的调拨申请，请先处理或取消调拨'); END;
    `);
  });
  migrate(5, 'account login events and session device metadata', () => {
    add('sessions', 'browser', 'TEXT');
    add('sessions', 'os', 'TEXT');
    db.exec(`
      CREATE TABLE IF NOT EXISTS login_events (
        id TEXT PRIMARY KEY,
        userId TEXT REFERENCES users(id) ON DELETE SET NULL,
        username TEXT NOT NULL,
        result TEXT NOT NULL,
        browser TEXT,
        os TEXT,
        createdAt TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_login_events_user_time ON login_events(userId, createdAt DESC);
      CREATE INDEX IF NOT EXISTS idx_login_events_result_time ON login_events(result, createdAt DESC);
    `);
  });
  migrate(6, 'protected system account and retained account deletion', () => {
    add('users', 'isSystemAccount', 'INTEGER NOT NULL DEFAULT 0');
    add('users', 'deletedAt', 'TEXT');
    add('users', 'deletedBy', 'TEXT');
    db.prepare("UPDATE users SET isSystemAccount = 1 WHERE username = 'admin' COLLATE NOCASE AND role = 'admin' AND status <> 'deleted'").run();
    db.exec('CREATE INDEX IF NOT EXISTS idx_users_status_created ON users(status, createdAt DESC)');
  });
  migrate(7, 'group Redmi SKUs under Xiaomi brand', () => {
    db.prepare("UPDATE skus SET brand = '小米' WHERE lower(trim(brand)) = 'redmi' OR trim(brand) = '红米'").run();
  });
  migrate(8, 'track purchase SKU selections by entering user', () => {
    add('purchase_items', 'skuId', 'TEXT');
    add('purchase_items', 'recordedBy', 'TEXT');
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_purchase_items_recorded_sku
      ON purchase_items(recordedBy, skuId, deleted);
    `);
  });
}

module.exports = { initDatabase, seedDatabase };
