'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const test = require('node:test');
const Database = require('better-sqlite3');
const managerCorePath = path.resolve(__dirname, '../tools/server-manager/manager-core.cjs');
const { createDatabaseBackup, decideGitUpdate, parseGitStatus, readDecisionArguments, readEnvValue, resolveDatabasePath } = require('../tools/server-manager/manager-core.cjs');

test('git status parser keeps tracked, renamed, and untracked paths', () => {
  assert.deepEqual(parseGitStatus(' M src/app/page.tsx\n?? docs/new sku.csv\nR  old.md -> new.md\n'), [
    'src/app/page.tsx',
    'docs/new sku.csv',
    'old.md -> new.md',
  ]);
});

test('update policy only allows a clean fast-forward on the configured branch', () => {
  assert.equal(decideGitUpdate({ branch: 'main', behind: 2 }).state, 'ready');
  assert.equal(decideGitUpdate({ branch: 'main', ahead: 1, behind: 0 }).state, 'current');
  assert.equal(decideGitUpdate({ branch: 'main', dirtyPaths: ['package-lock.json'], behind: 1 }).state, 'blocked');
  assert.equal(decideGitUpdate({ branch: 'feature', behind: 1 }).state, 'blocked');
  assert.equal(decideGitUpdate({ branch: 'main', ahead: 1, behind: 1 }).state, 'blocked');
});

test('Git decision CLI returns JSON for the PowerShell manager', () => {
  const output = execFileSync(process.execPath, [managerCorePath, 'decide', 'main', '0', '0', '2'], { encoding: 'utf8' });
  assert.equal(JSON.parse(output).state, 'ready');
  assert.equal(readDecisionArguments(['main', '1', '0', '2']).state, 'blocked');
  assert.throws(() => readDecisionArguments(['main', '-1', '0', '2']), /非负整数/);
});

test('database path resolves from environment, local env file, then project default', () => {
  const root = path.join(os.tmpdir(), 'sugrid-manager-path-test');
  assert.equal(resolveDatabasePath(root, { envValue: 'custom/db.sqlite' }), path.join(root, 'custom', 'db.sqlite'));
  assert.equal(resolveDatabasePath(root, { envValue: '', envFileContents: 'OTHER=1\nINVENTORY_DB_PATH="data/local.db"\n' }), path.join(root, 'data', 'local.db'));
  assert.equal(readEnvValue('INVENTORY_DB_PATH = \'C:/db/main.db\'', 'INVENTORY_DB_PATH'), 'C:/db/main.db');
  assert.equal(resolveDatabasePath(root, { envValue: '', envFileContents: '' }), path.join(root, 'data', 'inventory.db'));
});

test('SQLite backup is consistent and readable without modifying the source database', async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'sugrid-manager-backup-'));
  const sourcePath = path.join(folder, 'inventory.db');
  const db = new Database(sourcePath);
  db.exec("CREATE TABLE sample (value TEXT); INSERT INTO sample VALUES ('kept');");
  db.close();

  try {
    const result = await createDatabaseBackup(sourcePath, {
      projectRoot: path.resolve(__dirname, '..'),
      backupDirectory: path.join(folder, 'backups'),
      now: new Date('2026-11-10T12:00:00.000Z'),
    });
    assert.equal(result.state, 'created');
    assert.equal(result.integrity, 'ok');
    const backup = new Database(result.path, { readonly: true });
    assert.equal(backup.prepare('SELECT value FROM sample').get().value, 'kept');
    backup.close();
    const original = new Database(sourcePath, { readonly: true });
    assert.equal(original.prepare('SELECT value FROM sample').get().value, 'kept');
    original.close();

    const second = await createDatabaseBackup(sourcePath, {
      projectRoot: path.resolve(__dirname, '..'),
      backupDirectory: path.join(folder, 'backups'),
      now: new Date('2026-11-10T12:00:00.000Z'),
    });
    assert.equal(second.state, 'created');
    assert.notEqual(second.path, result.path);
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
});
