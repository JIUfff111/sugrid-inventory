/** Run: node scripts/test-print-job-id.cjs */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const filename = path.join(__dirname, '..', 'src', 'lib', 'print-job-id.ts');
const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  fileName: filename,
}).outputText;

function load(crypto) {
  const context = vm.createContext({
    exports: {},
    crypto,
    Date: { now: () => 1793332800000 },
    Math: { random: () => 0 },
  });
  vm.runInContext(compiled, context, { filename });
  return context.exports.createPrintJobId;
}

const secureCrypto = { randomUUID() { assert.equal(this, secureCrypto); return 'secure-uuid'; } };
assert.equal(load(secureCrypto)(), 'secure-uuid', 'Secure contexts retain the native UUID API');

let randomCalls = 0;
const lanCrypto = { getRandomValues(values) {
  assert.equal(this, lanCrypto);
  randomCalls += 1;
  values.fill(0);
  return values;
} };
for (const [name, crypto] of [['LAN HTTP', lanCrypto], ['legacy browser', undefined]]) {
  const create = load(crypto);
  const jobs = Array.from({ length: 1000 }, create);
  assert.equal(new Set(jobs).size, jobs.length, `${name}: retries must get distinct jobs even with identical time and entropy`);
  assert.ok(jobs.every(id => /^[a-z0-9-]+$/.test(id)), `${name}: IDs must work as URL parameters and data attributes`);
  assert.equal(jobs[0], decodeURIComponent(encodeURIComponent(jobs[0])));
}
assert.equal(randomCalls, 1000, 'LAN HTTP can use getRandomValues without randomUUID');
console.log('Print job IDs: secure, LAN HTTP, legacy fallback and retry deduplication passed');
