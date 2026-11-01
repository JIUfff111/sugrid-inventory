const { createHash } = require('node:crypto');
const catalog = require('./sku-catalog/builtin-sku-catalog.json');
const {
  formatCPUDisplay,
  formatGPUDisplay,
  formatScreenDisplay,
  normalizeList,
  normalizeSku,
} = require('./sku-catalog/normalize-options.cjs');
const { modelNameAliases, sameCatalogModelName } = require('./sku-catalog/config-variant-aliases.cjs');

const optionFormatters = {
  cpuOptions: formatCPUDisplay,
  ramOptions: (value) => String(value ?? '').trim(),
  gpuOptions: formatGPUDisplay,
  storageOptions: (value) => String(value ?? '').trim(),
  screenOptions: formatScreenDisplay,
};

function getSkuId(sku) {
  const identity = JSON.stringify([sku.productType, sku.brand, sku.model, sku.year]);
  return `builtin_sku_${createHash('sha256').update(identity).digest('hex').slice(0, 24)}`;
}

function parseOptions(value) {
  if (value == null || value === '') return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) && parsed.every((item) => typeof item === 'string') ? parsed : null;
  } catch {
    return null;
  }
}

function findIdentityRows(db, sku, model) {
  const yearClause = sku.year == null ? 'year IS NULL' : 'year = ?';
  const params = [sku.productType, sku.brand, model, ...(sku.year == null ? [] : [sku.year])];
  return db.prepare(`
    SELECT * FROM skus
    WHERE productType = ? AND brand = ? AND model = ? AND ${yearClause}
    ORDER BY CASE WHEN deleted = 0 THEN 0 ELSE 1 END, id
  `).all(...params);
}

function selectExistingSku(db, sku, id) {
  const byId = db.prepare('SELECT * FROM skus WHERE id = ?').get(id);
  if (byId) return { row: byId, legacyName: null };

  for (const model of [sku.model, ...modelNameAliases(sku)]) {
    const rows = findIdentityRows(db, sku, model);
    if (!rows.length) continue;
    const active = rows.filter((row) => row.deleted === 0);
    if (!active.length) return { blocked: true };
    const safe = active.filter((row) => row.createdBy == null || String(row.id).startsWith('builtin_sku_'));
    if (safe.length !== 1) return { blocked: true };
    return { row: safe[0], legacyName: model === sku.model ? null : model };
  }

  const yearClause = sku.year == null ? 'year IS NULL' : 'year = ?';
  const params = [sku.productType, sku.brand, ...(sku.year == null ? [] : [sku.year])];
  const candidates = db.prepare(`
    SELECT * FROM skus
    WHERE productType = ? AND brand = ? AND ${yearClause}
    ORDER BY CASE WHEN deleted = 0 THEN 0 ELSE 1 END, id
  `).all(...params).filter((row) => sameCatalogModelName(row.model, sku.model, sku.year));
  if (candidates.length) {
    const active = candidates.filter((row) => row.deleted === 0);
    if (!active.length) return { blocked: true };
    const safe = active.filter((row) => row.createdBy == null || String(row.id).startsWith('builtin_sku_'));
    if (safe.length !== 1) return { blocked: true };
    return { row: safe[0], legacyName: safe[0].model };
  }
  return null;
}

function mergeExistingSku(db, row, sku) {
  const values = {};
  let changed = false;
  if (sku.model !== row.model) {
    values.model = sku.model;
    changed = true;
  }

  for (const [field, formatter] of Object.entries(optionFormatters)) {
    const current = parseOptions(row[field]);
    if (current === null) continue;
    const merged = normalizeList([...current, ...(sku[field] || [])], formatter);
    const serialized = JSON.stringify(merged);
    if (serialized !== row[field]) {
      values[field] = serialized;
      changed = true;
    }
  }
  if (!changed) return false;

  values.updatedAt = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const assignments = Object.keys(values).map((field) => `${field} = ?`).join(', ');
  db.prepare(`UPDATE skus SET ${assignments} WHERE id = ?`).run(...Object.values(values), row.id);
  return true;
}

/** Add catalog records and option variants without replacing local SKU data. */
function syncBuiltinSkuCatalog(db) {
  if (catalog.schemaVersion !== 1 || !Array.isArray(catalog.skus)) {
    throw new Error('Built-in SKU catalog has an unsupported format.');
  }

  const insert = db.prepare(`
    INSERT INTO skus (
      id, productType, brand, model, year,
      cpuOptions, ramOptions, gpuOptions, storageOptions, screenOptions
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const sync = db.transaction(() => {
    let inserted = 0;
    let updated = 0;
    let skipped = 0;

    for (const sourceSku of catalog.skus) {
      const sku = normalizeSku(sourceSku);
      const id = getSkuId(sku);
      const existing = selectExistingSku(db, sku, id);
      if (existing?.blocked || (existing?.row && existing.row.deleted !== 0)) {
        skipped++;
        continue;
      }
      if (existing?.row) {
        if (mergeExistingSku(db, existing.row, sku)) updated++;
        continue;
      }

      insert.run(
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
      );
      inserted++;
    }
    return { inserted, updated, skipped };
  });

  return sync.immediate();
}

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
    for (const sourceSku of catalog.skus) {
      const sku = normalizeSku(sourceSku);
      const id = getSkuId(sku);
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

module.exports = { seedBuiltinSkus, syncBuiltinSkuCatalog };
