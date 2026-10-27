/** Run: node scripts/test-product-name.cjs */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');

function load(relativePath, dependencies = {}) {
  const filename = path.join(__dirname, '..', relativePath);
  const source = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    fileName: filename,
  }).outputText;
  const loaded = new Module(filename, module);
  loaded.filename = filename;
  loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  const originalRequire = loaded.require.bind(loaded);
  loaded.require = name => Object.hasOwn(dependencies, name) ? dependencies[name] : originalRequire(name);
  loaded._compile(source, filename);
  return loaded.exports;
}

const brand = load('src/lib/sku-brand.ts');
const { formatProductName } = load('src/lib/product-name.ts', { '@/lib/sku-brand': brand });

assert.equal(formatProductName({ brand: '小米', model: '小米笔记本 Pro 15 增强版 2021款', year: 2021 }), '小米笔记本 Pro 15 增强版 2021款');
assert.equal(formatProductName({ brand: 'Redmi', model: 'Redmi G 游戏本', year: 2020 }), 'Redmi G 游戏本 2020');
assert.equal(formatProductName({ brand: '红米', model: '红米 Book 14 2021', year: 2021 }), '红米 Book 14 2021');
assert.equal(formatProductName({ brand: 'ThinkPad', model: 'ThinkPad X13 2020', year: 2020 }), 'ThinkPad X13 2020');
assert.equal(formatProductName({ brand: 'ThinkPad', model: 'X13', year: 2020 }), 'ThinkPad X13 2020');
assert.equal(formatProductName({ brand: '小米', model: 'Book Pro 14', year: 2021 }), '小米 Book Pro 14 2021');
assert.equal(formatProductName({ brand: '华硕', model: '灵耀14', year: 2024 }), '华硕 灵耀14 2024');
assert.equal(formatProductName({ brand: '华硕', model: '华硕 灵耀14 2024', year: 2024 }), '华硕 灵耀14 2024');
assert.equal(formatProductName({ brand: 'ROG', model: '枪神9 Plus', year: 2025 }), 'ROG 枪神9 Plus 2025');
assert.equal(formatProductName({ brand: '', model: '', year: null }), '未命名商品');

console.log('Product names preserve complete model names and add only missing brand/year');
