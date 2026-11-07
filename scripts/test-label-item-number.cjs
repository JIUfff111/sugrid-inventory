/** Label template compatibility and optional-number tests on isolated SQLite. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const Database = require('better-sqlite3');
const { NextRequest } = require('next/server');
const { initDatabase, seedDatabase } = require('./database.cjs');

const root = path.resolve(__dirname, '..');
function load(relativePath, overrides = {}) {
  const filename = path.join(root, relativePath);
  const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    fileName: filename,
  }).outputText;
  const target = new Module(filename, module);
  target.filename = filename;
  target.paths = Module._nodeModulePaths(path.dirname(filename));
  const native = target.require.bind(target);
  target.require = name => Object.hasOwn(overrides, name) ? overrides[name] : native(name);
  target._compile(compiled, filename);
  return target.exports;
}

async function run() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  try {
    initDatabase(db);
    seedDatabase(db);
    const database = { __esModule: true, default: db };
    let token = '';
    const headers = { 'content-type': 'application/json', 'user-agent': 'label-item-number-test' };
    const helpers = load('src/lib/api-helpers.ts');
    const auth = load('src/lib/auth.ts', {
      '@/lib/db': database,
      '@/lib/api-helpers': helpers,
      'next/headers': { cookies: async () => ({ get: () => token ? { value: token } : undefined, set: () => {} }) },
    });
    const adminId = db.prepare("SELECT id FROM users WHERE username='admin'").get().id;
    token = auth.createSession(adminId);
    const labels = load('src/app/api/label-templates/route.ts', {
      '@/lib/db': database,
      '@/lib/auth': auth,
      '@/lib/api-helpers': helpers,
    });
    const legacyFields = [
      { key: 'product', visible: true, order: 0, fontSize: 14, align: 'left', x: 3, y: 4 },
      { key: 'config', visible: true, order: 1, fontSize: 13, align: 'left', x: 5, y: 22 },
      { key: 'sn', visible: false, order: 2, fontSize: 8, align: 'left', x: 4, y: 34 },
      { key: 'purchasePrice', visible: false, order: 3, fontSize: 8, align: 'left', x: 4, y: 49 },
      { key: 'supplier', visible: false, order: 4, fontSize: 8, align: 'left', x: 4, y: 64 },
      { key: 'inboundDate', visible: true, order: 5, fontSize: 12, align: 'left', x: 3, y: 82 },
    ];
    const legacyElements = [{
      id: 'legacy-sn-barcode', type: 'barcode', x: 8, y: 42, width: 84, height: 31,
      contentKey: 'sn', style: { foreground: '#000000', background: '#ffffff', showText: true, fontSize: 9 },
    }];
    db.prepare(`INSERT INTO label_templates
      (id,templateName,templateType,width,height,orientation,fields,isDefault,deleted,createdBy)
      VALUES ('legacy-label','旧标签兼容检查','inventory',60,40,'landscape',?,1,0,?)`
    ).run(JSON.stringify({ fields: legacyFields, fieldGap: 1, layoutMode: 'free', elements: legacyElements }), adminId);

    const legacyResponse = await labels.GET();
    const legacyBody = await legacyResponse.json();
    assert.equal(legacyResponse.status, 200);
    const legacy = legacyBody.data.find(row => row.id === 'legacy-label');
    assert.equal(legacy.fields.length, 7, 'old six-field templates gain one hidden item number field');
    assert.deepEqual(legacy.fields.slice(0, 6), legacyFields, 'legacy field positions and visibility remain unchanged');
    assert.deepEqual(legacy.fields[6], { key: 'itemNumber', visible: false, order: 6, fontSize: 8, align: 'left', x: 4, y: 96 });
    assert.equal(legacy.elements[0].contentKey, 'sn', 'legacy/default barcode remains bound to SN');

    const request = body => new NextRequest('http://127.0.0.1:3003/api/label-templates', {
      method: 'POST', headers, body: JSON.stringify(body),
    });
    const modernFields = [...legacyFields, { key: 'itemNumber', visible: true, order: 6, fontSize: 8, align: 'left', x: 4, y: 96 }];
    const modernResponse = await labels.POST(request({
      templateName: '商品编号标签', width: 60, height: 40, orientation: 'landscape',
      layoutMode: 'free', fields: modernFields,
      elements: [{ ...legacyElements[0], id: 'number-barcode', contentKey: 'itemNumber' }],
    }));
    const modernBody = await modernResponse.json();
    assert.equal(modernResponse.status, 201, JSON.stringify(modernBody));
    assert.equal(modernBody.data.fields.find(field => field.key === 'itemNumber').visible, true);
    assert.equal(modernBody.data.elements[0].contentKey, 'itemNumber');

    const legacyPostResponse = await labels.POST(request({
      templateName: '旧格式保存兼容', width: 60, height: 40, orientation: 'landscape',
      layoutMode: 'free', fields: legacyFields, elements: legacyElements,
    }));
    const legacyPostBody = await legacyPostResponse.json();
    assert.equal(legacyPostResponse.status, 201, JSON.stringify(legacyPostBody));
    assert.equal(legacyPostBody.data.fields.at(-1).key, 'itemNumber');
    assert.equal(legacyPostBody.data.fields.at(-1).visible, false);

    const printSource = fs.readFileSync(path.join(root, 'src/components/InventoryLabelPrint.tsx'), 'utf8');
    const previewSource = fs.readFileSync(path.join(root, 'src/app/settings/print/preview/page.tsx'), 'utf8');
    const canvasSource = fs.readFileSync(path.join(root, 'src/components/LabelCanvas.tsx'), 'utf8');
    assert.match(printSource, /itemNumber:\s*item\.itemNumber\s*\|\|\s*''/, 'direct printing receives the inventory item number');
    assert.match(previewSource, /case 'itemNumber': return item\.itemNumber \|\| ''/, 'print preview receives the inventory item number');
    assert.match(canvasSource, /data-barcode-status="ready" aria-label="编号未填写"/, 'an empty optional number does not block printing as a barcode error');
    console.log('Label item number: legacy templates, hidden default, SN barcode compatibility, selectable number barcode, and empty optional number passed');
  } finally {
    db.close();
  }
}

run().catch(error => { console.error(error); process.exitCode = 1; });
