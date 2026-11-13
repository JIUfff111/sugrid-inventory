import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareIntegratedServer } from './prepare-integrated-server.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
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
} finally {
  await rm(buildData, { recursive: true, force: true });
}
