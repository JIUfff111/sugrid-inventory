'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');

const projectRoot = path.resolve(__dirname, '..');

function projectFiles(configPath) {
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  assert.equal(config.error, undefined, `Could not read ${configPath}`);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, path.dirname(configPath));
  assert.deepEqual(parsed.errors, [], `Could not parse ${configPath}`);
  return parsed.fileNames.map((file) => path.normalize(file));
}

test('web type check includes web pages but excludes the separate desktop manager', () => {
  const webFiles = projectFiles(path.join(projectRoot, 'tsconfig.json'));
  assert.ok(webFiles.includes(path.join(projectRoot, 'src', 'app', 'page.tsx')));
  assert.ok(
    webFiles.every((file) => !file.startsWith(path.join(projectRoot, 'tools', 'server-manager-desktop') + path.sep)),
    'Web type check must not require desktop-only dependencies',
  );
});

test('desktop manager continues to type check its own source', () => {
  const managerRoot = path.join(projectRoot, 'tools', 'server-manager-desktop');
  const managerFiles = projectFiles(path.join(managerRoot, 'tsconfig.json'));
  assert.ok(managerFiles.includes(path.join(managerRoot, 'src', 'InventoryUpdates.tsx')));
});
