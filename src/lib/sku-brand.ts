/** Brand groups used by the SKU catalog; model series names stay unchanged. */
export function canonicalSKUBrand(brand: string): string {
  const value = brand.trim();
  return /^(?:redmi|红米)$/i.test(value) ? '小米' : value;
}
