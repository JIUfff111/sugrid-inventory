/**
 * SKU 预设数据插入脚本
 * 运行方式: node scripts/seed-skus.js
 */

const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'data', 'inventory.db');
const db = new Database(DB_PATH);

console.log('🚀 开始插入 SKU 预设数据...\n');

try {
  // 获取第一个用户的 ID（应该是 admin）
  const firstUser = db.prepare('SELECT id FROM users LIMIT 1').get();
  
  if (!firstUser) {
    console.error('❌ 数据库中没有用户，请先运行 npm run db:init');
    process.exit(1);
  }
  
  const userId = firstUser.id;
  const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
  
  // 预设 SKU 数据
  const skus = [
    // ThinkPad 系列
    {
      id: 'sku_thinkpad_t14_gen3',
      productType: '笔记本电脑',
      brand: 'ThinkPad',
      model: 'T14 Gen3',
      cpuOptions: ['i5-1240P', 'i7-1260P', 'i7-1270P'],
      ramOptions: ['8GB', '16GB', '32GB'],
      gpuOptions: ['集显', 'MX550 2GB'],
      storageOptions: ['256GB SSD', '512GB SSD', '1TB SSD'],
      screenOptions: ['1920x1080', '2560x1600'],
      priceMin: 3500,
      priceMax: 5500
    },
    {
      id: 'sku_thinkpad_t480',
      productType: '笔记本电脑',
      brand: 'ThinkPad',
      model: 'T480',
      cpuOptions: ['i5-8250U', 'i5-8350U', 'i7-8550U', 'i7-8650U'],
      ramOptions: ['8GB', '16GB', '32GB'],
      gpuOptions: ['集显', 'MX150 2GB'],
      storageOptions: ['256GB SSD', '512GB SSD', '1TB SSD'],
      screenOptions: ['1920x1080'],
      priceMin: 2000,
      priceMax: 3500
    },
    {
      id: 'sku_thinkpad_x1_carbon_gen9',
      productType: '笔记本电脑',
      brand: 'ThinkPad',
      model: 'X1 Carbon Gen9',
      cpuOptions: ['i5-1135G7', 'i7-1165G7', 'i7-1185G7'],
      ramOptions: ['8GB', '16GB', '32GB'],
      gpuOptions: ['集显'],
      storageOptions: ['256GB SSD', '512GB SSD', '1TB SSD', '2TB SSD'],
      screenOptions: ['1920x1080', '2560x1440', '3840x2400'],
      priceMin: 4500,
      priceMax: 7000
    },
    
    // 小米系列
    {
      id: 'sku_xiaomi_book_pro_14',
      productType: '笔记本电脑',
      brand: '小米',
      model: 'Book Pro 14',
      cpuOptions: ['i5-11300H', 'i7-11370H'],
      ramOptions: ['16GB', '32GB'],
      gpuOptions: ['集显', 'MX450 2GB'],
      storageOptions: ['512GB SSD', '1TB SSD'],
      screenOptions: ['2560x1600'],
      priceMin: 3500,
      priceMax: 5000
    },
    {
      id: 'sku_xiaomi_book_air_13',
      productType: '笔记本电脑',
      brand: '小米',
      model: 'Book Air 13',
      cpuOptions: ['i5-1240P', 'i7-1260P'],
      ramOptions: ['16GB', '32GB'],
      gpuOptions: ['集显'],
      storageOptions: ['512GB SSD', '1TB SSD'],
      screenOptions: ['2560x1600'],
      priceMin: 3000,
      priceMax: 4500
    },
    
    // 红米系列
    {
      id: 'sku_redmi_book_14',
      productType: '笔记本电脑',
      brand: '小米',
      model: 'RedmiBook 14',
      cpuOptions: ['i5-1135G7', 'i7-1165G7'],
      ramOptions: ['8GB', '16GB'],
      gpuOptions: ['集显'],
      storageOptions: ['512GB SSD'],
      screenOptions: ['1920x1080'],
      priceMin: 2500,
      priceMax: 3500
    },
    {
      id: 'sku_redmi_book_pro_15',
      productType: '笔记本电脑',
      brand: '小米',
      model: 'RedmiBook Pro 15',
      cpuOptions: ['i5-11300H', 'i7-11370H'],
      ramOptions: ['16GB'],
      gpuOptions: ['集显', 'MX450 2GB'],
      storageOptions: ['512GB SSD', '1TB SSD'],
      screenOptions: ['3200x2000'],
      priceMin: 3200,
      priceMax: 4500
    },
    
    // 平板电脑系列
    {
      id: 'sku_xiaomi_pad_6',
      productType: '平板电脑',
      brand: '小米',
      model: '小米平板 6',
      cpuOptions: ['骁龙870'],
      ramOptions: ['6GB', '8GB'],
      gpuOptions: ['集显'],
      storageOptions: ['128GB', '256GB'],
      screenOptions: ['2880x1800'],
      priceMin: 1200,
      priceMax: 1800
    },
    {
      id: 'sku_redmi_pad',
      productType: '平板电脑',
      brand: '小米',
      model: 'Redmi Pad',
      cpuOptions: ['联发科 Helio G99'],
      ramOptions: ['4GB', '6GB'],
      gpuOptions: ['集显'],
      storageOptions: ['128GB'],
      screenOptions: ['2000x1200'],
      priceMin: 800,
      priceMax: 1200
    }
  ];
  
  // 检查是否已有 SKU 数据
  const existingCount = db.prepare('SELECT COUNT(*) as count FROM skus WHERE deleted = 0').get();
  
  if (existingCount.count > 0) {
    console.log(`⚠️  数据库已有 ${existingCount.count} 个 SKU，跳过插入`);
    console.log('如需重新插入，请先清空 skus 表');
    return;
  }
  
  // 插入 SKU 数据
  const insertStmt = db.prepare(`
    INSERT INTO skus (
      id, productType, brand, model,
      cpuOptions, ramOptions, gpuOptions, storageOptions, screenOptions,
      priceMin, priceMax, deleted, createdBy, createdAt, updatedAt
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)
  `);
  
  let insertedCount = 0;
  
  for (const sku of skus) {
    insertStmt.run(
      sku.id,
      sku.productType,
      sku.brand,
      sku.model,
      JSON.stringify(sku.cpuOptions),
      JSON.stringify(sku.ramOptions),
      JSON.stringify(sku.gpuOptions),
      JSON.stringify(sku.storageOptions),
      JSON.stringify(sku.screenOptions),
      sku.priceMin,
      sku.priceMax,
      userId,
      now,
      now
    );
    insertedCount++;
    console.log(`✅ ${sku.brand} ${sku.model}`);
  }
  
  console.log(`\n✨ 成功插入 ${insertedCount} 个 SKU！`);
  console.log('\nSKU 分类统计:');
  console.log('- ThinkPad 笔记本: 3 个');
  console.log('- 小米笔记本: 2 个');
  console.log('- 红米笔记本: 2 个');
  console.log('- 小米平板: 1 个');
  console.log('- 红米平板: 1 个');
  
} catch (error) {
  console.error('\n❌ 插入 SKU 数据失败:', error);
  process.exit(1);
} finally {
  db.close();
  console.log('\n🔒 数据库连接已关闭');
}
