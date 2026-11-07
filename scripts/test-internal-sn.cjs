const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { webcrypto } = require('node:crypto');
const ts = require('typescript');

// Keep this regression runnable on the Node 20 installations used for Next.js.
const source = fs.readFileSync(path.join(__dirname, '../src/lib/internal-sn.ts'), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2017 },
}).outputText;
const moduleUnderTest = { exports: {} };
new Function('module', 'exports', compiled)(moduleUnderTest, moduleUnderTest.exports);
const { generateInternalSN } = moduleUnderTest.exports;
globalThis.crypto ||= webcrypto;

const date = new Date(2026, 10, 7);
let value = 0;
const fillRandom = bytes => { bytes.fill(value++); };
const first = generateInternalSN([], { date, fillRandom });
assert.match(first, /^SG-20261107-[0-9A-HJKMNP-TV-Z]{13}$/);
assert.equal(first, first.toUpperCase());

const second = generateInternalSN([`  ${first.toLowerCase()}  `], {
  date,
  fillRandom: bytes => { bytes.fill(value++); },
});
assert.notEqual(second, first, 'a generated SN must avoid a case-insensitive existing value');

const batch = [];
for (let index = 0; index < 100; index += 1) {
  batch.push(generateInternalSN(batch, { date }));
}
assert.equal(new Set(batch).size, 100, 'generated values in the same batch must be distinct');

assert.throws(() => generateInternalSN([first], { date, fillRandom: bytes => bytes.fill(0) }), /不重复/);
console.log('Internal SN format, secure randomness, collision retry and batch uniqueness passed');
