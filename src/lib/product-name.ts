import { canonicalSKUBrand } from '@/lib/sku-brand';

export type ProductIdentity = {
  brand?: string | null;
  model?: string | null;
  year?: string | number | null;
};

function modelHasBrand(model: string, brand: string): boolean {
  const prefixes = brand === '小米' ? ['小米', 'Xiaomi', 'Redmi', '红米'] : [brand];
  const lower = model.toLocaleLowerCase();
  return prefixes.some(prefix => lower.startsWith(prefix.toLocaleLowerCase()));
}

function displayYear(value: ProductIdentity['year']): string {
  const year = String(value ?? '').trim().replace(/\.0$/, '');
  return /^\d{4}$/.test(year) ? year : '';
}

/** Keep a complete model name intact, adding only a missing brand or year. */
export function formatProductName(item: ProductIdentity, fallback = '未命名商品'): string {
  const brand = canonicalSKUBrand(item.brand || '');
  const model = (item.model || '').trim();
  const name = model && modelHasBrand(model, brand) ? model : [brand, model].filter(Boolean).join(' ');
  const year = displayYear(item.year);
  const hasYear = year && new RegExp(`(^|[^0-9])${year}($|[^0-9])`).test(model);
  return [name, year && !hasYear ? year : ''].filter(Boolean).join(' ') || fallback;
}
