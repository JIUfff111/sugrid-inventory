/** Run: node scripts/test-sku-display.cjs */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');

const filename = path.join(__dirname, '..', 'src', 'lib', 'sku-display.ts');
const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  fileName: filename,
}).outputText;
const sourceModule = new Module(filename, module);
sourceModule.filename = filename;
sourceModule.paths = Module._nodeModulePaths(path.dirname(filename));
sourceModule._compile(compiled, filename);

const { formatCPUDisplay, formatGPUDisplay, formatScreenDisplay, getSKUProductType, uniqueCPUOptions, uniqueGPUOptions, uniqueScreenOptions } = sourceModule.exports;
const brandFilename = path.join(__dirname, '..', 'src', 'lib', 'sku-brand.ts');
const brandSource = ts.transpileModule(fs.readFileSync(brandFilename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  fileName: brandFilename,
}).outputText;
const brandModule = new Module(brandFilename, module);
brandModule.filename = brandFilename;
brandModule.paths = Module._nodeModulePaths(path.dirname(brandFilename));
brandModule._compile(brandSource, brandFilename);
const { canonicalSKUBrand } = brandModule.exports;

assert.equal(formatCPUDisplay('Intel Core i5-10210U'), 'I5-10210U');
assert.equal(formatCPUDisplay('Intel(R) Core(TM) i5-8265U'), 'I5-8265U');
assert.equal(formatCPUDisplay('Core i7-1165G7'), 'I7-1165G7');
assert.equal(formatCPUDisplay('英特尔酷睿 i5-7200U'), 'I5-7200U');
assert.equal(formatCPUDisplay('AMD Ryzen 5 PRO 4650U'), 'R5-4650U');
assert.equal(formatCPUDisplay('AMD 锐龙7 5800H'), 'R7-5800H');
assert.equal(formatCPUDisplay('Intel Core Ultra 7 155H'), 'Ultra 7 155H');
assert.equal(formatCPUDisplay('Intel 酷睿i7 8750H'), 'I7-8750H');
assert.equal(formatCPUDisplay('英特尔第 10 代酷睿 i5'), '第10代 I5');
assert.equal(formatCPUDisplay('英特尔第 11 代酷睿 i5（来源未列具体型号）'), '第11代 I5');
assert.equal(formatCPUDisplay('Core Ultra 7 155H'), 'Ultra 7 155H');
assert.equal(formatCPUDisplay('AMD Ryzen AI 7 PRO 350'), 'R7 AI-350');
assert.equal(formatCPUDisplay('AMD 锐龙 7 H 255'), 'R7-H255');
assert.equal(formatCPUDisplay(null), '');
assert.equal(formatGPUDisplay('NVIDIA GeForce RTX 4060'), 'RTX 4060');
assert.equal(formatGPUDisplay('NVIDIA GeForce RTX 4060 8GB GDDR6'), 'RTX 4060');
assert.equal(formatGPUDisplay('NVIDIA GeForce GTX 1650 Ti Max-Q 4GB GDDR6'), 'GTX 1650 Ti Max-Q');
assert.equal(formatGPUDisplay('NVIDIA RTX A1000 6GB GDDR6'), 'RTX A1000');
assert.equal(formatGPUDisplay('NVIDIA GeForce RTX 5070Ti 12GB'), 'RTX 5070Ti');
assert.equal(formatGPUDisplay('AMD Radeon RX 6800M 12GB'), 'RX 6800M');
assert.equal(formatGPUDisplay('集成显卡（Intel HD Graphics 620）'), '集显');
assert.equal(formatGPUDisplay('Intel UHD Graphics 620'), '集显');
assert.equal(formatGPUDisplay('Intel(R) UHD Graphics 770'), '集显');
assert.equal(formatGPUDisplay('Intel Iris Xe Graphics'), '集显');
assert.equal(formatGPUDisplay('AMD Radeon 780M'), '集显');
assert.equal(formatGPUDisplay('AMD Radeon(TM) Vega 8 Graphics'), '集显');
assert.equal(formatGPUDisplay('Intel Arc Graphics'), '集显');
assert.equal(formatGPUDisplay('NVIDIA GeForce RTX 3060 6GB 笔记本电脑 GPU'), 'RTX 3060');
assert.equal(formatGPUDisplay('RTX 3070 8GB 笔记本电脑 GPU'), 'RTX 3070');
assert.equal(formatGPUDisplay('NVIDIA GeForce RTX 4060 with 8GB GDDR6 VRAM'), 'RTX 4060');
assert.equal(formatGPUDisplay('独立显卡 NVIDIA GeForce RTX 3060 6GB'), 'RTX 3060');
assert.equal(formatGPUDisplay('魔方 AMD Radeon RX 7600M XT'), 'RX 7600M XT');
assert.equal(formatGPUDisplay('独立显卡（AMD Radeon Pro 450，）'), 'Radeon Pro 450');
assert.equal(formatGPUDisplay('NVIDIA T1200'), 'T1200');
assert.equal(formatGPUDisplay('Qualcomm Adreno 690'), '集显');
assert.equal(formatGPUDisplay('集显'), '集显');
assert.equal(formatGPUDisplay(null), '');
assert.deepEqual(uniqueGPUOptions(['集显', '集成显卡（Intel HD Graphics 620）', 'NVIDIA GeForce RTX 4060 8GB', 'RTX 4060 6GB']), ['集显', 'NVIDIA GeForce RTX 4060 8GB']);
assert.deepEqual(uniqueGPUOptions(['Intel UHD Graphics 620', '集成显卡', 'RTX 4060 8GB 笔记本电脑 GPU', 'NVIDIA GeForce RTX 4060 6GB']), ['Intel UHD Graphics 620', 'RTX 4060 8GB 笔记本电脑 GPU']);

assert.equal(formatScreenDisplay('16英寸 2560x1600 165Hz 100%sRGB 500nits'), '2.5K');
assert.equal(formatScreenDisplay('14.2英寸 2520×1680 120Hz OLED'), '2.5K');
assert.equal(formatScreenDisplay('13英寸 2880 x 1800 Liquid Retina'), '2.8K');
assert.equal(formatScreenDisplay('16英寸 3072x1920 165Hz'), '3K');
assert.equal(formatScreenDisplay('16英寸 3840x2400 OLED'), '4K');
assert.equal(formatScreenDisplay('16英寸 1920x1200 60Hz'), 'FHD+');
assert.equal(formatScreenDisplay('15.6英寸 1920x1080 144Hz'), 'FHD');
assert.equal(formatScreenDisplay('屏幕规格未列出'), '规格待核实');
assert.equal(formatScreenDisplay(''), '');
assert.deepEqual(uniqueScreenOptions(['16英寸 2560x1600 165Hz', '14英寸 2560x1600 60Hz', '1920x1080']), ['16英寸 2560x1600 165Hz', '1920x1080']);

const sourceOptions = [
  'i5-8250U', 'Intel Core i5-8250U',
  'AMD Ryzen 5 PRO 4650U', 'Ryzen 5 PRO 4650U',
];
assert.deepEqual(uniqueCPUOptions(sourceOptions), ['i5-8250U', 'AMD Ryzen 5 PRO 4650U']);
assert.equal(sourceOptions[1], 'Intel Core i5-8250U', 'Display normalization must not rewrite stored SKU options');
const sourceScreens = ['16英寸 2560x1600 165Hz 100%sRGB 500nits'];
assert.equal(formatScreenDisplay(sourceScreens[0]), '2.5K');
assert.equal(sourceScreens[0], '16英寸 2560x1600 165Hz 100%sRGB 500nits', 'Display normalization must not rewrite stored SKU options');

const models = [
  { productType: '笔记本电脑', brand: 'Redmi', model: 'Redmi Book 14' },
  { productType: '游戏本', brand: 'Redmi', model: 'Redmi G 游戏本' },
  { productType: '平板电脑', brand: '小米', model: '小米平板' },
];
const categories = [...new Set(models.map(row => getSKUProductType(row.productType)))];
assert.deepEqual(categories, ['笔记本电脑', '平板电脑']);
assert.deepEqual(models.filter(row => getSKUProductType(row.productType) === '笔记本电脑')
  .map(row => row.model), ['Redmi Book 14', 'Redmi G 游戏本']);
assert.deepEqual(['小米', 'Redmi', '红米', 'ThinkPad'].map(canonicalSKUBrand),
  ['小米', '小米', '小米', 'ThinkPad']);
assert.deepEqual([...new Set(models.map(row => canonicalSKUBrand(row.brand)))], ['小米']);
assert.equal(models[1].model, 'Redmi G 游戏本', 'Grouping must preserve the model series name');

console.log('SKU CPU/GPU/screen display and laptop grouping checks passed');
