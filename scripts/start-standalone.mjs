import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { cp, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { copyDatabaseInitializer } from './prepare-integrated-server.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

function resolveDistDir(root, distDir) {
  const absolute = path.resolve(root, distDir);
  const relative = path.relative(root, absolute);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('NEXT_DIST_DIR must be a directory inside the project.');
  }
  return { absolute, relative };
}

async function readBuildId(file) {
  const value = (await readFile(file, 'utf8')).trim();
  if (!value) throw new Error(`Build ID is empty: ${file}`);
  return value;
}

export async function prepareStandaloneStart({
  root = projectRoot,
  distDir = process.env.NEXT_DIST_DIR?.trim() || '.next',
  env = process.env,
} = {}) {
  const absoluteRoot = path.resolve(root);
  const { absolute: outputRoot, relative: outputDir } = resolveDistDir(absoluteRoot, distDir);
  const standaloneRoot = path.join(outputRoot, 'standalone');
  const serverPath = path.join(standaloneRoot, 'server.js');
  const markerPath = path.join(outputRoot, 'sugrid-build-success.json');

  let marker;
  try {
    marker = JSON.parse(await readFile(markerPath, 'utf8'));
  } catch {
    throw new Error('Production build has no success marker. Run npm run build and wait for it to finish.');
  }
  const [buildId, standaloneBuildId] = await Promise.all([
    readBuildId(path.join(outputRoot, 'BUILD_ID')),
    readBuildId(path.join(standaloneRoot, outputDir, 'BUILD_ID')),
  ]);
  if (!marker?.buildId || marker.buildId !== buildId || buildId !== standaloneBuildId) {
    throw new Error('Production and standalone build IDs do not match. Run npm run build again.');
  }
  if (!(await stat(serverPath).catch(() => null))?.isFile()) {
    throw new Error('Standalone server is missing. Run npm run build again.');
  }

  const configuredDatabase = env.INVENTORY_DB_PATH?.trim();
  const databasePath = configuredDatabase
    ? path.resolve(absoluteRoot, configuredDatabase)
    : path.join(absoluteRoot, 'data', 'inventory.db');
  if (env.INVENTORY_TEST_MODE === '1' &&
      (!configuredDatabase || databasePath.toLowerCase() === path.join(absoluteRoot, 'data', 'inventory.db').toLowerCase())) {
    throw new Error('Test mode requires a separate INVENTORY_DB_PATH database.');
  }

  await copyDatabaseInitializer(absoluteRoot, standaloneRoot);
  const publicSource = path.join(absoluteRoot, 'public');
  if ((await stat(publicSource).catch(() => null))?.isDirectory()) {
    await cp(publicSource, path.join(standaloneRoot, 'public'), { recursive: true, force: true });
  }
  const staticSource = path.join(outputRoot, 'static');
  if (!(await stat(staticSource).catch(() => null))?.isDirectory()) {
    throw new Error('Production static assets are missing. Run npm run build again.');
  }
  await cp(staticSource, path.join(standaloneRoot, outputDir, 'static'), { recursive: true, force: true });

  return {
    serverPath,
    databasePath,
    env: { ...env, NODE_ENV: 'production', INVENTORY_DB_PATH: databasePath },
  };
}

function parseStartArgs(args, env) {
  for (let index = 0; index < args.length; index++) {
    const [name, inlineValue] = args[index].split('=', 2);
    if (!['--port', '-p', '--hostname', '-H'].includes(name)) {
      throw new Error(`Unknown start option: ${args[index]}`);
    }
    const value = inlineValue ?? args[++index];
    if (!value || value.startsWith('-')) throw new Error(`Missing value for ${name}.`);
    if (name === '--port' || name === '-p') {
      const port = Number(value);
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`Invalid port: ${value}`);
      env.PORT = String(port);
    } else {
      env.HOSTNAME = value;
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.env.NODE_ENV = 'production';
    require('@next/env').loadEnvConfig(projectRoot, false);
    const prepared = await prepareStandaloneStart({
      root: projectRoot,
      distDir: process.env.NEXT_DIST_DIR?.trim() || '.next',
      env: process.env,
    });
    parseStartArgs(process.argv.slice(2), prepared.env);
    const child = spawn(process.execPath, [prepared.serverPath], {
      cwd: projectRoot,
      env: prepared.env,
      stdio: 'inherit',
    });
    const onSigint = () => child.kill('SIGINT');
    const onSigterm = () => child.kill('SIGTERM');
    process.on('SIGINT', onSigint);
    process.on('SIGTERM', onSigterm);
    const result = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => resolve({ code, signal }));
    });
    process.off('SIGINT', onSigint);
    process.off('SIGTERM', onSigterm);
    process.exitCode = result.code ?? (result.signal === 'SIGINT' ? 130 : 1);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
