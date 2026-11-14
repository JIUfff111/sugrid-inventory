import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { prepareIntegratedServer } from './prepare-integrated-server.mjs';

const initializerFiles = [
  'scripts/init-db.js',
  'scripts/database.cjs',
  'scripts/builtin-sku-seed.cjs',
  'scripts/sku-catalog/manual-options.cjs',
  'scripts/sku-catalog/normalize-options.cjs',
  'scripts/sku-catalog/config-variant-aliases.cjs',
  'scripts/sku-catalog/builtin-sku-catalog.json',
];

async function createInitializerFixture(root) {
  await mkdir(path.join(root, 'scripts/sku-catalog'), { recursive: true });
  for (const relativePath of initializerFiles) {
    await writeFile(path.join(root, relativePath), relativePath);
  }
}

test('copies a standalone server with public assets, static assets, and optional Node runtime', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sugrid-integrated-'));
  try {
    const standalone = path.join(root, '.next/standalone');
    const staticRoot = path.join(root, '.next/static');
    await mkdir(standalone, { recursive: true });
    await mkdir(staticRoot, { recursive: true });
    await mkdir(path.join(root, 'public'), { recursive: true });
    await mkdir(path.join(root, 'scripts/sku-catalog'), { recursive: true });
    await mkdir(path.join(standalone, 'data'), { recursive: true });
    await writeFile(path.join(standalone, 'server.js'), 'server');
    await writeFile(path.join(standalone, 'data/inventory.db'), 'must not be packaged');
    for (const relativePath of [
      'scripts/init-db.js',
      'scripts/database.cjs',
      'scripts/builtin-sku-seed.cjs',
      'scripts/sku-catalog/manual-options.cjs',
      'scripts/sku-catalog/normalize-options.cjs',
      'scripts/sku-catalog/config-variant-aliases.cjs',
      'scripts/sku-catalog/builtin-sku-catalog.json',
    ]) {
      await writeFile(path.join(root, relativePath), relativePath);
    }
    await writeFile(path.join(staticRoot, 'chunk.js'), 'chunk');
    await writeFile(path.join(root, 'public', 'icon.svg'), '<svg/>');
    const nodeRuntime = path.join(root, 'node.exe');
    await writeFile(nodeRuntime, 'node runtime');

    const output = path.join(root, 'package/inventory');
    await prepareIntegratedServer({ root, output, nodeRuntime });

    assert.equal(await readFile(path.join(output, 'server.js'), 'utf8'), 'server');
    assert.equal(await readFile(path.join(output, 'public/icon.svg'), 'utf8'), '<svg/>');
    assert.equal(await readFile(path.join(output, '.next/static/chunk.js'), 'utf8'), 'chunk');
    assert.equal(await readFile(path.join(output, 'node.exe'), 'utf8'), 'node runtime');
    assert.equal(await readFile(path.join(output, 'scripts/init-db.js'), 'utf8'), 'scripts/init-db.js');
    assert.equal(await readFile(path.join(output, 'scripts/sku-catalog/builtin-sku-catalog.json'), 'utf8'), 'scripts/sku-catalog/builtin-sku-catalog.json');
    await assert.rejects(readFile(path.join(output, 'data/inventory.db')));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('keeps static assets in a custom Next dist directory', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sugrid-integrated-custom-dist-'));
  try {
    await createInitializerFixture(root);
    const distDir = '.next-inventory-release-qa';
    const standalone = path.join(root, distDir, 'standalone');
    const staticRoot = path.join(root, distDir, 'static');
    await mkdir(standalone, { recursive: true });
    await mkdir(staticRoot, { recursive: true });
    await writeFile(path.join(standalone, 'server.js'), 'custom dist server');
    await writeFile(path.join(staticRoot, 'chunk.js'), 'custom dist chunk');
    const output = path.join(root, 'package/inventory');

    await prepareIntegratedServer({ root, output, distDir });

    assert.equal(await readFile(path.join(output, distDir, 'static/chunk.js'), 'utf8'), 'custom dist chunk');
    await assert.rejects(readFile(path.join(output, '.next/static/chunk.js')));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('excludes nested manager resources and rejects SQLite files anywhere in the payload', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sugrid-integrated-private-data-'));
  try {
    const standalone = path.join(root, '.next/standalone');
    const nestedResources = path.join(standalone, 'tools/server-manager-desktop/src-tauri/resources/inventory');
    await mkdir(path.join(nestedResources, 'data/backups'), { recursive: true });
    await writeFile(path.join(standalone, 'server.js'), 'server');
    await mkdir(path.join(root, 'scripts/sku-catalog'), { recursive: true });
    for (const relativePath of [
      'scripts/init-db.js',
      'scripts/database.cjs',
      'scripts/builtin-sku-seed.cjs',
      'scripts/sku-catalog/manual-options.cjs',
      'scripts/sku-catalog/normalize-options.cjs',
      'scripts/sku-catalog/config-variant-aliases.cjs',
      'scripts/sku-catalog/builtin-sku-catalog.json',
    ]) {
      await writeFile(path.join(root, relativePath), relativePath);
    }
    await writeFile(path.join(nestedResources, 'data/backups/inventory.before-install.db'), 'private database');
    const output = path.join(root, 'package/inventory');

    await prepareIntegratedServer({ root, output });

    await assert.rejects(readFile(path.join(output, 'tools/server-manager-desktop/src-tauri/resources/inventory/data/backups/inventory.before-install.db')));
    const pending = [output];
    while (pending.length) {
      const directory = pending.pop();
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const item = path.join(directory, entry.name);
        if (entry.isDirectory()) pending.push(item);
        else assert.doesNotMatch(entry.name, /\.(?:db|sqlite|sqlite3)(?:-(?:wal|shm))?$/i);
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('does not replace a good payload when SQLite data is found in the standalone output', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sugrid-integrated-reject-db-'));
  try {
    await createInitializerFixture(root);
    const standalone = path.join(root, '.next/standalone');
    const output = path.join(root, 'package/inventory');
    await mkdir(path.join(standalone, 'node_modules/dependency'), { recursive: true });
    await mkdir(output, { recursive: true });
    await writeFile(path.join(standalone, 'server.js'), 'new server');
    await writeFile(path.join(standalone, 'node_modules/dependency/test.db'), 'unexpected private data');
    await writeFile(path.join(output, 'old.txt'), 'known good package');

    await assert.rejects(prepareIntegratedServer({ root, output }), /Private SQLite data must not be included/);
    assert.equal(await readFile(path.join(output, 'old.txt'), 'utf8'), 'known good package');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('uses the active Node runtime by default when preparing the installer payload', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sugrid-integrated-default-node-'));
  try {
    await createInitializerFixture(root);
    await mkdir(path.join(root, '.next/standalone'), { recursive: true });
    await writeFile(path.join(root, '.next/standalone/server.js'), 'server');
    const runtime = process.platform === 'win32' ? process.execPath : undefined;
    const output = path.join(root, 'package/inventory');

    await prepareIntegratedServer({ root, output, ...(runtime ? { nodeRuntime: runtime } : {}) });

    if (runtime) assert.equal((await stat(path.join(output, 'node.exe'))).size, (await stat(runtime)).size);
    else await assert.rejects(readFile(path.join(output, 'node')));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('dereferences standalone junctions so Windows packaging needs no symlink privilege', async () => {
  if (process.platform !== 'win32') return;
  const root = await mkdtemp(path.join(os.tmpdir(), 'sugrid-integrated-junction-'));
  try {
    await createInitializerFixture(root);
    const standalone = path.join(root, '.next/standalone');
    const dependency = path.join(root, 'dependency');
    await mkdir(standalone, { recursive: true });
    await mkdir(dependency, { recursive: true });
    await writeFile(path.join(standalone, 'server.js'), 'server');
    await writeFile(path.join(dependency, 'index.js'), 'resolved dependency');
    await symlink(dependency, path.join(standalone, 'linked-dependency'), 'junction');
    const output = path.join(root, 'package/inventory');

    await prepareIntegratedServer({ root, output });

    assert.equal(await readFile(path.join(output, 'linked-dependency/index.js'), 'utf8'), 'resolved dependency');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('replaces an existing package only after the staged server is ready', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sugrid-integrated-replace-'));
  try {
    await createInitializerFixture(root);
    await mkdir(path.join(root, '.next/standalone'), { recursive: true });
    await writeFile(path.join(root, '.next/standalone/server.js'), 'new server');
    const output = path.join(root, 'package/inventory');
    await mkdir(output, { recursive: true });
    await writeFile(path.join(output, 'old.txt'), 'old package');

    await prepareIntegratedServer({ root, output });

    assert.equal(await readFile(path.join(output, 'server.js'), 'utf8'), 'new server');
    await assert.rejects(readFile(path.join(output, 'old.txt')));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('fails without deleting the previous package when no standalone build exists', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sugrid-integrated-missing-'));
  try {
    const output = path.join(root, 'package/inventory');
    await mkdir(output, { recursive: true });
    await writeFile(path.join(output, 'old.txt'), 'old package');

    await assert.rejects(prepareIntegratedServer({ root, output }), /Run next build first/);
    assert.equal(await readFile(path.join(output, 'old.txt'), 'utf8'), 'old package');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('rejects a dist directory outside the project', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sugrid-integrated-path-'));
  try {
    await assert.rejects(
      prepareIntegratedServer({ root, distDir: '..' }),
      /distDir must stay inside the project folder/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
