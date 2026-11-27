import assert from 'node:assert/strict';
import { generateKeyPairSync, verify } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createCandidate, createRelease } from './inventory-release-cli.mjs';
import { assertSafeRelativePath, candidateMetadata, databaseSchemaVersion, inventoryFiles, signManifest, verifyCandidate } from './inventory-release-package.mjs';

const sha = 'a'.repeat(40);

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sugrid-inventory-release-'));
  const candidate = path.join(root, 'candidate');
  for (const directory of ['inventory/scripts', 'inventory/.next/static']) await mkdir(path.join(candidate, directory), { recursive: true });
  await writeFile(path.join(candidate, 'inventory/server.js'), 'server');
  await writeFile(path.join(candidate, 'inventory/node.exe'), 'node');
  await writeFile(path.join(candidate, 'inventory/scripts/init-db.js'), 'initializer');
  await writeFile(path.join(candidate, 'inventory/scripts/database.cjs'), "migrate(1, 'start', () => {});\nmigrateWithoutForeignKeys(2, 'next', () => {});\n");
  await writeFile(path.join(candidate, 'inventory/.next/static/chunk.js'), 'static');
  return { root, candidate };
}

function keyPair() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    privateKeyBase64: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
    publicKeyHex: publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex'),
    publicKey,
  };
}

function storedZipEntries(bytes) {
  const entries = new Map();
  let offset = 0;
  while (bytes.readUInt32LE(offset) === 0x04034b50) {
    const method = bytes.readUInt16LE(offset + 8);
    assert.equal(method, 0);
    const size = bytes.readUInt32LE(offset + 18);
    const nameLength = bytes.readUInt16LE(offset + 26);
    const extraLength = bytes.readUInt16LE(offset + 28);
    const name = bytes.subarray(offset + 30, offset + 30 + nameLength).toString('utf8');
    const contentStart = offset + 30 + nameLength + extraLength;
    entries.set(name, bytes.subarray(contentStart, contentStart + size));
    offset = contentStart + size;
  }
  assert.equal(bytes.readUInt32LE(offset), 0x02014b50);
  assert.equal(bytes.readUInt16LE(bytes.length - 22 + 8), entries.size);
  return entries;
}

test('candidate and signed ZIP contain exactly the approved runtime files', async () => {
  const { root, candidate } = await fixture();
  try {
    await createCandidate({ root: candidate, commitSha: sha });
    const keys = keyPair();
    const release = await createRelease({ candidateRoot: candidate, outputRoot: path.join(root, 'release'), version: '1.2.3', commitSha: sha, ...keys });
    const entries = storedZipEntries(await readFile(release.asset));
    assert.deepEqual([...entries.keys()], ['manifest.json', 'manifest.sig', ...[...entries.keys()].filter(name => name.startsWith('inventory/'))]);
    const manifestBytes = entries.get('manifest.json');
    const manifest = JSON.parse(manifestBytes);
    assert.equal(manifest.version, '1.2.3');
    assert.equal(manifest.commitSha, sha);
    assert.equal(manifest.minUpdaterProtocol, 2);
    assert.equal(manifest.databaseSchemaVersion, 2);
    assert.equal(manifest.minSupportedDatabaseSchemaVersion, 0);
    assert.deepEqual(manifest.files.map(file => file.path), [...entries.keys()].filter(name => name.startsWith('inventory/')));
    assert.equal(verify(null, manifestBytes, keys.publicKey, Buffer.from(entries.get('manifest.sig').toString(), 'base64')), true);
    for (const file of manifest.files) assert.equal(entries.get(file.path).length, file.size);
    if (process.platform === 'win32') {
      const extracted = path.join(root, 'extracted');
      await mkdir(extracted);
      execFileSync('tar.exe', ['-xf', release.asset, '-C', extracted]);
      assert.deepEqual(await readFile(path.join(extracted, 'inventory/server.js')), Buffer.from('server'));
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('candidate rejects changed files and private SQLite data', async () => {
  const { root, candidate } = await fixture();
  try {
    await createCandidate({ root: candidate, commitSha: sha });
    await writeFile(path.join(candidate, 'inventory/server.js'), 'tampered');
    await assert.rejects(verifyCandidate(candidate), /do not match/);
    await writeFile(path.join(candidate, 'inventory/data.db-wal'), 'private');
    await assert.rejects(inventoryFiles(path.join(candidate, 'inventory')), /SQLite data/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('candidate rejects paths the Windows updater cannot safely install', () => {
  for (const name of [
    '.env', '.env.production', 'public/.ENV.local', 'data/private.txt',
    'backups/manifest.json', 'public/NUL.txt', 'public/COM1.log',
    'public/trailing.', 'public/trailing ', 'public/a:b.txt',
    'public/secret.sqlite3', 'public/../server.js',
  ]) {
    assert.throws(() => assertSafeRelativePath(name), /Unsafe inventory package path|Private inventory directory|SQLite data/);
  }
  assert.doesNotThrow(() => assertSafeRelativePath('public/brand/logo.svg'));
});

test('candidate database compatibility follows the packaged migration source', async () => {
  const { root, candidate } = await fixture();
  try {
    await createCandidate({ root: candidate, commitSha: sha });
    const metadata = JSON.parse(await readFile(path.join(candidate, 'candidate.json'), 'utf8'));
    assert.equal(metadata.databaseSchemaVersion, 2);
    assert.equal(metadata.minSupportedDatabaseSchemaVersion, 0);
    await writeFile(path.join(candidate, 'inventory/scripts/database.cjs'), "migrate(1, 'start', () => {});\nmigrate(3, 'next', () => {});\n");
    await assert.rejects(verifyCandidate(candidate), /do not match/);
    assert.throws(() => databaseSchemaVersion("migrate(2, 'later');\nmigrate(1, 'earlier');"), /unique and increasing/);
    assert.throws(() => databaseSchemaVersion('no migrations'), /could not be identified/);
    assert.throws(() => candidateMetadata(sha, [], 0), /schema version is invalid/);
    assert.throws(() => candidateMetadata(sha, [], 2, 3), /minimum supported database schema version is invalid/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('candidate rejects unexpected files outside the runtime', async () => {
  const { root, candidate } = await fixture();
  try {
    await createCandidate({ root: candidate, commitSha: sha });
    await writeFile(path.join(candidate, 'unexpected.txt'), 'not approved');
    await assert.rejects(verifyCandidate(candidate), /unexpected top-level/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('release signing requires a configured matching Ed25519 trust root', async () => {
  const keys = keyPair();
  const bytes = Buffer.from('manifest');
  assert.throws(() => signManifest(bytes, undefined, keys.publicKeyHex), /must both be configured/);
  assert.throws(() => signManifest(bytes, keys.privateKeyBase64, undefined), /must both be configured/);
  assert.throws(() => signManifest(bytes, keys.privateKeyBase64, '0'.repeat(64)), /does not match/);
  assert.equal(verify(null, bytes, keys.publicKey, Buffer.from(signManifest(bytes, keys.privateKeyBase64, keys.publicKeyHex), 'base64')), true);
  assert.throws(() => candidateMetadata('bad', []), /exact 40-character/);
});
