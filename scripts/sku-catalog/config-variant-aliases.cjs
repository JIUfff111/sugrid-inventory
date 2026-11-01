const legacyModelNames = [
  {
    productType: '笔记本电脑',
    brand: '小米',
    model: '小米笔记本 Pro 14',
    year: 2021,
    aliases: ['小米笔记本 Pro 14 2021款'],
  },
  {
    productType: '笔记本电脑',
    brand: '小米',
    model: '小米笔记本 Pro 15',
    year: 2021,
    aliases: ['小米笔记本 Pro 15 2021款'],
  },
  {
    productType: '笔记本电脑',
    brand: '小米',
    model: 'Redmi Book Pro 16',
    year: 2025,
    aliases: ['Redmi Book Pro 16 2025(Ult..'],
  },
];

function modelNameAliases(sku) {
  return legacyModelNames.find((entry) =>
    entry.productType === sku.productType && entry.brand === sku.brand &&
    entry.model === sku.model && entry.year === sku.year)?.aliases ?? [];
}

function canonicalModelName(model, year) {
  let value = String(model ?? '').normalize('NFKC').trim();
  if (year != null) {
    const escapedYear = String(year).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    value = value.replace(new RegExp(`(?<!\\d)${escapedYear}(?:款)?(?!\\d)`, 'gi'), ' ');
  }
  return value
    .replace(/Redmi\s*Book/gi, 'Redmi Book')
    .replace(/小米笔记本\s*Air/gi, 'Xiaomi Book Air')
    .replace(/小米\s*Book/gi, 'Xiaomi Book')
    .replace(/\s*(锐龙版|酷睿版)/g, ' $1')
    .replace(/\s+/g, ' ')
    .trim();
}

function sameCatalogModelName(left, right, year) {
  const compact = (value) => canonicalModelName(value, year)
    .replace(/[\s（）()]/g, '')
    .toLowerCase();
  return compact(left) === compact(right);
}

function repairCatalogModelNames(catalog) {
  for (const entry of legacyModelNames) {
    const legacy = catalog.skus.find((sku) =>
      sku.productType === entry.productType && sku.brand === entry.brand &&
      entry.aliases.includes(sku.model) && sku.year === entry.year);
    if (legacy) legacy.model = entry.model;
  }
  for (const sku of catalog.skus) sku.model = canonicalModelName(sku.model, sku.year);
}

module.exports = { canonicalModelName, modelNameAliases, repairCatalogModelNames, sameCatalogModelName };
