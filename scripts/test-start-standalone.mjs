import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { prepareStandaloneStart } from './start-standalone.mjs';

const initializerFiles = [
  'scripts/init-db.js',
  'scripts/database.cjs',
  'scripts/builtin-sku-seed.cjs',
  'scripts/sku-catalog/manual-options.cjs',
  'scripts/sku-catalog/normalize-options.cjs',
  'scripts/sku-catalog/config-variant-aliases.cjs',
  'scripts/sku-catalog/builtin-sku-catalog.json',
];

async function makeBuild(root, { distDir = '.next', buildId = 'test-build-123' } = {}) {
  const output = path.join(root, distDir);
  const standalone = path.join(output, 'standalone');
  await mkdir(path.join(standalone, distDir), { recursive: true });
  await mkdir(path.join(output, 'static'), { recursive: true });
  await mkdir(path.join(root, 'public'), { recursive: true });
  await mkdir(path.join(root, 'scripts/sku-catalog'), { recursive: true });

  await writeFile(path.join(standalone, 'server.js'), 'standalone server');
  await writeFile(path.join(output, 'BUILD_ID'), buildId);
  await writeFile(path.join(standalone, distDir, 'BUILD_ID'), buildId);
  await writeFile(path.join(output, 'sugrid-build-success.json'), JSON.stringify({ buildId }));
  await writeFile(path.join(output, 'static/chunk.js'), 'static chunk');
  await writeFile(path.join(root, 'public/icon.svg'), '<svg/>');
  for (const relativePath of initializerFiles) {
    await writeFile(path.join(root, relativePath), relativePath);
  }
  return { output, standalone };
}

async function withTempRoot(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sugrid-standalone-start-'));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('prepares a complete standalone server and an absolute default database path', async () => {
  await withTempRoot(async (root) => {
    const { standalone } = await makeBuild(root);
    const prepared = await prepareStandaloneStart({ root, env: {} });

    assert.equal(prepared.serverPath, path.join(standalone, 'server.js'));
    assert.equal(prepared.databasePath, path.join(root, 'data/inventory.db'));
    assert.equal(prepared.env.INVENTORY_DB_PATH, prepared.databasePath);
    assert.equal(await readFile(path.join(standalone, '.next/static/chunk.js'), 'utf8'), 'static chunk');
    assert.equal(await readFile(path.join(standalone, 'public/icon.svg'), 'utf8'), '<svg/>');
    for (const relativePath of initializerFiles) {
      assert.equal(await readFile(path.join(standalone, relativePath), 'utf8'), relativePath);
    }
  });
});

test('resolves a relative explicit database path from the project root', async () => {
  await withTempRoot(async (root) => {
    await makeBuild(root);
    const prepared = await prepareStandaloneStart({
      root,
      env: { INVENTORY_DB_PATH: 'data/qa/inventory.db', PORT: '3003' },
    });

    assert.equal(prepared.databasePath, path.join(root, 'data/qa/inventory.db'));
    assert.equal(prepared.env.INVENTORY_DB_PATH, prepared.databasePath);
    assert.equal(prepared.env.PORT, '3003');
  });
});

test('test mode requires a database separate from the default production path', async () => {
  await withTempRoot(async (root) => {
    await makeBuild(root);

    await assert.rejects(
      prepareStandaloneStart({ root, env: { INVENTORY_TEST_MODE: '1' } }),
      /test mode|INVENTORY_DB_PATH/i,
    );
    await assert.rejects(
      prepareStandaloneStart({
        root,
        env: { INVENTORY_TEST_MODE: '1', INVENTORY_DB_PATH: 'data/inventory.db' },
      }),
      /test mode|INVENTORY_DB_PATH/i,
    );

    const prepared = await prepareStandaloneStart({
      root,
      env: { INVENTORY_TEST_MODE: '1', INVENTORY_DB_PATH: 'data/qa/inventory.db' },
    });
    assert.equal(prepared.databasePath, path.join(root, 'data/qa/inventory.db'));
  });
});

test('rejects a standalone build without a successful-build marker', async () => {
  await withTempRoot(async (root) => {
    const { output } = await makeBuild(root);
    await rm(path.join(output, 'sugrid-build-success.json'));

    await assert.rejects(
      prepareStandaloneStart({ root, env: {} }),
      /build|success|marker/i,
    );
  });
});

test('rejects a successful-build marker for a different BUILD_ID', async () => {
  await withTempRoot(async (root) => {
    const { output } = await makeBuild(root);
    await writeFile(path.join(output, 'sugrid-build-success.json'), JSON.stringify({ buildId: 'old-build' }));

    await assert.rejects(
      prepareStandaloneStart({ root, env: {} }),
      /build|mismatch|stale/i,
    );
  });
});

test('rejects a standalone server from a different build', async () => {
  await withTempRoot(async (root) => {
    const { standalone } = await makeBuild(root);
    await writeFile(path.join(standalone, '.next/BUILD_ID'), 'old-build');

    await assert.rejects(
      prepareStandaloneStart({ root, env: {} }),
      /build|mismatch|stale/i,
    );
  });
});
