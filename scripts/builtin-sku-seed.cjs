const { createHash } = require('node:crypto');
const catalog = require('./sku-catalog/builtin-sku-catalog.json');

/** Load the tracked public model catalog only into an empty built-in SKU table. */
function seedBuiltinSkus(db) {
  if (catalog.schemaVersion !== 1 || !Array.isArray(catalog.skus)) {
    throw new Error('Built-in SKU catalog has an unsupported format.');
  }

  const insert = db.prepare(`
    INSERT OR IGNORE INTO skus (
      id, productType, brand, model, year,
      cpuOptions, ramOptions, gpuOptions, storageOptions, screenOptions
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const seed = db.transaction(() => {
    const existingCount = db.prepare('SELECT COUNT(*) AS count FROM skus').get().count;
    if (existingCount > 0) return 0;

    let inserted = 0;
    for (const sku of catalog.skus) {
      const identity = JSON.stringify([sku.productType, sku.brand, sku.model, sku.year]);
      const id = `builtin_sku_${createHash('sha256').update(identity).digest('hex').slice(0, 24)}`;
      inserted += insert.run(
        id,
        sku.productType,
        sku.brand,
        sku.model,
        sku.year,
        JSON.stringify(sku.cpuOptions),
        JSON.stringify(sku.ramOptions),
        JSON.stringify(sku.gpuOptions),
        JSON.stringify(sku.storageOptions),
        JSON.stringify(sku.screenOptions)
      ).changes;
    }
    return inserted;
  });

  // Lock before checking emptiness so concurrent first starts serialize cleanly.
  const inserted = seed.immediate();
  if (inserted > 0) console.log(`✅ 已加载 ${inserted} 条内置 SKU 型号目录`);
  return inserted;
}

module.exports = { seedBuiltinSkus };
