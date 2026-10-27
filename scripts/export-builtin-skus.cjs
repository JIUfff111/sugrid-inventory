const Database = require('better-sqlite3');
const fs = require('node:fs');
const path = require('node:path');

const args = process.argv.slice(2);
const getArg = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
};

const databasePath = path.resolve(getArg('--database') || path.join(__dirname, '..', 'data', 'inventory.db'));
const outputPath = path.join(__dirname, 'sku-catalog', 'builtin-sku-catalog.json');
const write = args.includes('--write');

if (args.includes('--help')) {
  console.log('Usage: node scripts/export-builtin-skus.cjs [--database <path>] [--write]');
  console.log('Reads only active SKU catalog fields. --write updates the tracked seed JSON.');
  process.exit(0);
}

const db = new Database(databasePath, { readonly: true, fileMustExist: true });
try {
  const rows = db.prepare(`
    SELECT productType, brand, model, year,
      cpuOptions, ramOptions, gpuOptions, storageOptions, screenOptions
    FROM skus
    WHERE deleted = 0
    ORDER BY productType, brand COLLATE NOCASE, model COLLATE NOCASE, year
  `).all();

  const optionKeys = ['cpuOptions', 'ramOptions', 'gpuOptions', 'storageOptions', 'screenOptions'];
  const skus = rows.map((row, index) => {
    if (!row.productType?.trim() || !row.brand?.trim() || !row.model?.trim()) {
      throw new Error(`SKU row ${index + 1} is missing a required identity field.`);
    }
    const sku = {
      productType: row.productType.trim(),
      brand: row.brand.trim(),
      model: row.model.trim(),
      year: row.year == null ? null : Number(row.year),
    };
    if (sku.year !== null && !Number.isInteger(sku.year)) {
      throw new Error(`SKU row ${index + 1} has an invalid year.`);
    }
    for (const key of optionKeys) {
      let values = [];
      if (row[key]) {
        try { values = JSON.parse(row[key]); }
        catch { throw new Error(`SKU row ${index + 1} has invalid ${key} JSON.`); }
      }
      if (!Array.isArray(values) || values.some(value => typeof value !== 'string')) {
        throw new Error(`SKU row ${index + 1} has an invalid ${key} list.`);
      }
      sku[key] = values;
    }
    return sku;
  });

  if (!skus.length) throw new Error('No active SKU rows found.');
  const catalog = { schemaVersion: 1, skus };
  if (write) {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, `${JSON.stringify(catalog, null, 2)}\n`, 'utf8');
    console.log(`Wrote ${skus.length} active SKU entries to ${path.relative(process.cwd(), outputPath)}.`);
  } else {
    console.log(`Validated ${skus.length} active SKU entries. Use --write to update the tracked seed file.`);
  }
} finally {
  db.close();
}
