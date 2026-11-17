'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');

test('web package lock is complete and matches package.json', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));

  assert.ok(lock.lockfileVersion >= 1);
  assert.equal(lock.name, manifest.name);
  assert.equal(lock.version, manifest.version);

  for (const section of ['dependencies', 'devDependencies']) {
    assert.deepEqual(lock.packages[''][section], manifest[section]);
    for (const name of Object.keys(manifest[section])) {
      assert.ok(lock.packages[`node_modules/${name}`], `Missing locked package: ${name}`);
    }
  }
});
