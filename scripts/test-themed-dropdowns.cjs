const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');

const root = path.join(__dirname, '..');

function* jsxFiles(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) yield* jsxFiles(filename);
    else if (/\.[jt]sx$/.test(entry.name)) yield filename;
  }
}

test('业务页面使用主题下拉组件，不回退到浏览器原生下拉框', () => {
  const nativeDropdowns = [];
  for (const filename of jsxFiles(path.join(root, 'src'))) {
    const source = ts.createSourceFile(filename, fs.readFileSync(filename, 'utf8'), ts.ScriptTarget.Latest);
    function visit(node) {
      if ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) &&
          ts.isIdentifier(node.tagName) && node.tagName.text === 'select') {
        const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
        nativeDropdowns.push(`${path.relative(root, filename)}:${line + 1}`);
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
  assert.deepEqual(nativeDropdowns, [], '原生 <select> 请改用 CustomSelect，以维护统一的下拉样式');
});
