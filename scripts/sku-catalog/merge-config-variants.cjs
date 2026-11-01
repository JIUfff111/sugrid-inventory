const fs = require('node:fs');
const path = require('node:path');
const {
  formatCPUDisplay,
  formatGPUDisplay,
  formatScreenDisplay,
  normalizeList,
} = require('./normalize-options.cjs');
const { canonicalModelName, repairCatalogModelNames } = require('./config-variant-aliases.cjs');

const catalogPath = path.join(__dirname, 'builtin-sku-catalog.json');
const supplementPath = path.join(
  __dirname,
  '..',
  '..',
  'docs',
  'sku-catalog',
  '03-supplements',
  'config-variants-2026-11-01',
  'research',
  'sku-variants.json'
);
const ramOptions = ['8GB', '16GB', '24GB', '32GB'];
const optionFormatters = {
  cpuOptions: formatCPUDisplay,
  ramOptions: (value) => String(value ?? '').trim(),
  gpuOptions: formatGPUDisplay,
  storageOptions: (value) => String(value ?? '').trim(),
  screenOptions: formatScreenDisplay,
};

function canonicalBrand(brand) {
  return ['redmi', '红米'].includes(String(brand).trim().toLowerCase()) ? '小米' : String(brand).trim();
}

function canonicalModel(model) {
  return String(model ?? '')
    .trim()
    .replace(/Redmi\s*Book/gi, 'Redmi Book')
    .replace(/（(酷睿版|锐龙版)）/g, ' $1')
    .replace(/\s+/g, ' ');
}

function identity(sku) {
  return JSON.stringify([sku.productType, sku.brand, sku.model, sku.year ?? null]);
}

function yearlessModel(model, year) {
  return canonicalModelName(model, year);
}

function variantType(sku) {
  const model = String(sku.model ?? '').normalize('NFKC');
  if (/锐龙版|Ryzen/i.test(model)) return 'amd';
  if (/酷睿版|Intel Core/i.test(model)) return 'intel';
  const cpus = normalizeList(sku.cpuOptions, formatCPUDisplay);
  if (cpus.length && cpus.every((cpu) => /^(?:R[3579]-|R AI-|AMD\b|锐龙)/i.test(cpu))) return 'amd';
  if (cpus.length && cpus.every((cpu) => /^(?:I[3579]-|Ultra\b|Core\s+[3579]\b|Intel\b)/i.test(cpu))) return 'intel';
  return null;
}

function familyKey(sku) {
  return yearlessModel(sku.model, sku.year)
    .normalize('NFKC')
    .replace(/小米笔记本\s*Air/gi, 'Xiaomi Book Air')
    .replace(/小米\s*Book/gi, 'Xiaomi Book')
    .replace(/Redmi\s*Book/gi, 'RedmiBook')
    .replace(/\s*\(?(?:酷睿版|锐龙版|12代酷睿)\)?/gi, ' ')
    .replace(/游戏本/gi, ' ')
    .replace(/[\s（）()]+/g, '')
    .toLowerCase();
}

function normalizeOptions(options, formatter) {
  return normalizeList(options, formatter);
}

function mergeOptions(target, source) {
  for (const [field, formatter] of Object.entries(optionFormatters)) {
    if (field === 'ramOptions') {
      target[field] = [...ramOptions];
      continue;
    }
    target[field] = normalizeOptions([...(target[field] || []), ...(source[field] || [])], formatter);
  }
}

function coalesceCatalogIdentities(catalog) {
  const byIdentity = new Map();
  for (const sku of catalog.skus) {
    const key = identity(sku);
    const existing = byIdentity.get(key);
    if (existing) mergeOptions(existing, sku);
    else byIdentity.set(key, sku);
  }
  catalog.skus = [...byIdentity.values()];
}

function findMatch(supplement, catalog) {
  const exact = catalog.skus.filter((sku) => identity(sku) === identity(supplement));
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) throw new Error(`Duplicate catalog identity: ${identity(supplement)}`);

  const family = familyKey(supplement);
  const variant = variantType(supplement);
  const matches = catalog.skus.filter((sku) => {
    if (sku.productType !== supplement.productType || sku.brand !== supplement.brand || sku.year !== supplement.year) return false;
    if (familyKey(sku) !== family) return false;
    const existingVariant = variantType(sku);
    return !variant || !existingVariant || variant === existingVariant;
  });
  if (matches.length > 1) {
    throw new Error(`Ambiguous supplement identity ${identity(supplement)}: ${matches.map(identity).join(', ')}`);
  }
  return matches[0] || null;
}

function main() {
  const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
  const supplement = JSON.parse(fs.readFileSync(supplementPath, 'utf8'));
  if (catalog.schemaVersion !== 1 || !Array.isArray(catalog.skus) || !Array.isArray(supplement.models)) {
    throw new Error('SKU catalog or configuration supplement has an unsupported format.');
  }

  repairCatalogModelNames(catalog);
  coalesceCatalogIdentities(catalog);
  const seenSource = new Set();
  let matched = 0;
  let added = 0;
  for (const model of supplement.models) {
    const normalized = {
      productType: String(model.productType ?? '').trim(),
      brand: canonicalBrand(model.brand),
      model: canonicalModelName(canonicalModel(model.model), model.modelYear),
      year: model.modelYear == null || model.modelYear === '' ? null : Number(model.modelYear),
      cpuOptions: model.cpuOptions,
      ramOptions,
      gpuOptions: model.gpuOptions,
      storageOptions: model.storageOptions,
      screenOptions: model.screenOptions,
    };
    if (!normalized.productType || !normalized.brand || !normalized.model ||
        (normalized.year !== null && !Number.isInteger(normalized.year))) {
      throw new Error(`Invalid supplement model identity: ${JSON.stringify(model)}`);
    }
    const sourceKey = identity(normalized);
    if (seenSource.has(sourceKey)) throw new Error(`Duplicate supplement model identity: ${sourceKey}`);
    seenSource.add(sourceKey);

    const target = findMatch(normalized, catalog);
    if (target) {
      mergeOptions(target, normalized);
      matched++;
    } else {
      const addedSku = {
        productType: normalized.productType,
        brand: normalized.brand,
        model: normalized.model,
        year: normalized.year,
        cpuOptions: [],
        ramOptions,
        gpuOptions: [],
        storageOptions: [],
        screenOptions: [],
      };
      mergeOptions(addedSku, normalized);
      catalog.skus.push(addedSku);
      added++;
    }
  }

  const finalIdentities = new Set();
  for (const sku of catalog.skus) {
    const key = identity(sku);
    if (finalIdentities.has(key)) throw new Error(`Duplicate output catalog identity: ${key}`);
    finalIdentities.add(key);
    sku.ramOptions = [...ramOptions];
  }
  fs.writeFileSync(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`, 'utf8');
  console.log(`Merged ${supplement.models.length} models: ${matched} matched existing models, ${added} new, ${catalog.skus.length} total.`);
}

if (require.main === module) main();

module.exports = { canonicalBrand, canonicalModel, familyKey, findMatch, variantType };
