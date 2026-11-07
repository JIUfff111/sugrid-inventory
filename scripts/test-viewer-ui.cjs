/** Render the real navigation for each role and verify the viewer's visible choices. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const ts = require('typescript');

const root = path.resolve(__dirname, '..');
function load(relativePath, overrides = {}) {
  const filename = path.join(root, relativePath);
  const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.ReactJSX,
      esModuleInterop: true,
    },
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

const access = load('src/lib/access.ts');
const link = ({ href, children, ...props }) => React.createElement('a', { href, ...props }, children);
const TopNav = load('src/components/TopNav.tsx', {
  'next/link': { __esModule: true, default: link },
  'next/navigation': { usePathname: () => '/inventory', useRouter: () => ({ replace() {}, refresh() {} }) },
  '@/components/Brand': { BrandLogo: () => React.createElement('span', null, 'SUGRID') },
  '@/lib/access': access,
}).default;
const user = role => ({ id: role, username: role, realName: null, role, canViewInventory: true, canEditInventory: false, warehouses: [] });
const viewer = renderToStaticMarkup(React.createElement(TopNav, { user: user('viewer') }));
assert.match(viewer, /在库清单/);
assert.match(viewer, /普通用户/);
assert.match(viewer, /个人账号/);
for (const unavailable of ['采购订单', '库存分析', '租赁管理', '销售出库', '账号与权限', '仓库管理', '库存调拨']) {
  assert.equal(viewer.includes(unavailable), false, `viewer navigation exposed ${unavailable}`);
}
assert.equal(access.canVisit('viewer', '/inventory'), true);
assert.equal(access.canVisit('viewer', '/settings/account'), true);
for (const path of ['/', '/orders', '/inventory/analysis', '/transfers', '/settings/users', '/settings/data']) {
  assert.equal(access.canVisit('viewer', path), false, `viewer may visit ${path}`);
}
const manager = renderToStaticMarkup(React.createElement(TopNav, { user: user('warehouse_manager') }));
assert.match(manager, /库存分析/, 'existing warehouse manager navigation must remain available');
const admin = renderToStaticMarkup(React.createElement(TopNav, { user: user('admin') }));
assert.match(admin, /采购订单/, 'existing administrator navigation must remain available');
console.log('Viewer navigation and route visibility checks passed');
