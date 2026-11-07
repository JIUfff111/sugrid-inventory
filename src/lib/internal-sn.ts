/** Internal asset numbers for products without a usable manufacturer SN. */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function encodeBase32(bytes: Uint8Array): string {
  let value = 0;
  let bits = 0;
  let result = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      result += ALPHABET[(value >>> bits) & 31];
    }
    value &= (1 << bits) - 1;
  }
  if (bits) result += ALPHABET[(value << (5 - bits)) & 31];
  return result;
}

type GenerationOptions = {
  date?: Date;
  /** Test seam; production always uses Web Crypto. */
  fillRandom?: (bytes: Uint8Array) => void;
};

export function generateInternalSN(existingSNs: Iterable<string> = [], options: GenerationOptions = {}): string {
  const date = options.date ?? new Date();
  if (Number.isNaN(date.getTime())) throw new Error('无法生成内部 SN：日期无效');
  const datePart = `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getDate()).padStart(2, '0')}`;
  const used = new Set(Array.from(existingSNs, sn => sn.trim().toUpperCase()).filter(Boolean));
  const fillRandom = options.fillRandom ?? ((bytes: Uint8Array) => { globalThis.crypto.getRandomValues(bytes); });

  for (let attempt = 0; attempt < 16; attempt += 1) {
    const bytes = new Uint8Array(8);
    fillRandom(bytes);
    const candidate = `SG-${datePart}-${encodeBase32(bytes)}`;
    if (!used.has(candidate)) return candidate;
  }
  throw new Error('暂时无法生成不重复的内部 SN，请重试');
}
