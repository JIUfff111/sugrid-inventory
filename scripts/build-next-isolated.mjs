import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareIntegratedServer } from './prepare-integrated-server.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.NODE_ENV = 'production';
createRequire(import.meta.url)('@next/env').loadEnvConfig(root, false);
const distDir = process.env.NEXT_DIST_DIR?.trim() || '.next';
const buildRoot = path.resolve(root, distDir);
const buildDir = path.relative(root, buildRoot);
if (!buildDir || buildDir === '..' || buildDir.startsWith(`..${path.sep}`) || path.isAbsolute(buildDir)) {
  throw new Error('NEXT_DIST_DIR must be a directory inside the project.');
}
const buildMarker = path.join(buildRoot, 'sugrid-build-success.json');
const temporaryRoot = path.join(root, '.tmp');
await mkdir(temporaryRoot, { recursive: true });
const buildData = await mkdtemp(path.join(temporaryRoot, 'next-build-'));
const nextCli = path.join(root, 'node_modules', 'next', 'dist', 'bin', 'next');
const env = {
  ...process.env,
  INVENTORY_DB_PATH: path.join(buildData, 'inventory.db'),
  INVENTORY_TEST_MODE: '1',
};

try {
  await rm(buildMarker, { force: true });
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [nextCli, 'build'], {
      cwd: root,
      env,
      stdio: 'inherit',
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });

  if (result.code !== 0) {
    throw new Error(`Next.js build failed${result.signal ? ` (${result.signal})` : ` (${result.code})`}.`);
  }

  if (process.argv.includes('--prepare-integrated-server')) {
    const destination = await prepareIntegratedServer({ root });
    console.log(`Standalone inventory server prepared at ${destination}`);
  }

  const buildId = (await readFile(path.join(buildRoot, 'BUILD_ID'), 'utf8')).trim();
  const standaloneBuildId = (await readFile(path.join(buildRoot, 'standalone', buildDir, 'BUILD_ID'), 'utf8')).trim();
  if (!buildId || buildId !== standaloneBuildId) {
    throw new Error('Standalone BUILD_ID does not match the completed Next.js build.');
  }
  await writeFile(buildMarker, JSON.stringify({ buildId }));
} finally {
  await rm(buildData, { recursive: true, force: true });
}
