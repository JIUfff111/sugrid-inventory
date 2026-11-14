import { cp, mkdir, mkdtemp, readdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const databaseInitializerFiles = [
  'scripts/init-db.js',
  'scripts/database.cjs',
  'scripts/builtin-sku-seed.cjs',
  'scripts/sku-catalog/manual-options.cjs',
  'scripts/sku-catalog/normalize-options.cjs',
  'scripts/sku-catalog/config-variant-aliases.cjs',
  'scripts/sku-catalog/builtin-sku-catalog.json',
];

function option(name) {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

function resolveInside(root, value, label) {
  const resolved = path.resolve(root, value);
  const relative = path.relative(root, resolved);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`${label} must stay inside the project folder.`);
  }
  return resolved;
}

async function copyDatabaseInitializer(root, destination) {
  for (const relativePath of databaseInitializerFiles) {
    const source = resolveInside(root, relativePath, 'initializer file');
    const target = path.join(destination, relativePath);
    await mkdir(path.dirname(target), { recursive: true });
    await cp(source, target, { force: true });
  }
}

export async function prepareIntegratedServer({
  root = projectRoot,
  output = path.join(root, 'tools/server-manager-desktop/src-tauri/resources/inventory'),
  nodeRuntime = process.platform === 'win32' ? process.execPath : undefined,
  distDir = process.env.NEXT_DIST_DIR?.trim() || '.next',
} = {}) {
  const absoluteRoot = path.resolve(root);
  const sourceRoot = resolveInside(absoluteRoot, distDir, 'distDir');
  const standaloneRoot = path.join(sourceRoot, 'standalone');
  const standaloneServer = path.join(standaloneRoot, 'server.js');
  const destination = path.resolve(output);

  try {
    await stat(standaloneServer);
  } catch {
    throw new Error(`Standalone server was not found at ${standaloneServer}. Run next build first.`);
  }

  await mkdir(path.dirname(destination), { recursive: true });
  const stagingRoot = await mkdtemp(path.join(path.dirname(destination), '.inventory-stage-'));
  const previousRoot = `${destination}.previous-${process.pid}`;
  let movedPrevious = false;

  try {
    await cp(standaloneRoot, stagingRoot, { recursive: true, force: true, dereference: true });

    for (const privateDirectory of ['data', 'docs', '.git', '.tmp', 'tmp', 'logs', 'backups', 'tools']) {
      await rm(path.join(stagingRoot, privateDirectory), { recursive: true, force: true });
    }

    await copyDatabaseInitializer(absoluteRoot, stagingRoot);

    const publicSource = path.join(absoluteRoot, 'public');
    try {
      await stat(publicSource);
      await cp(publicSource, path.join(stagingRoot, 'public'), { recursive: true, force: true });
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }

    const staticSource = path.join(sourceRoot, 'static');
    try {
      await stat(staticSource);
      const stagedDistDir = path.relative(absoluteRoot, sourceRoot);
      await cp(staticSource, path.join(stagingRoot, stagedDistDir, 'static'), { recursive: true, force: true });
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }

    if (nodeRuntime) {
      const runtimePath = path.resolve(nodeRuntime);
      const runtimeInfo = await stat(runtimePath).catch(() => null);
      if (!runtimeInfo?.isFile()) throw new Error(`Node runtime was not found at ${runtimePath}.`);
      await cp(runtimePath, path.join(stagingRoot, process.platform === 'win32' ? 'node.exe' : 'node'));
    }

    const pending = [stagingRoot];
    while (pending.length) {
      const directory = pending.pop();
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const item = path.join(directory, entry.name);
        if (entry.isDirectory()) pending.push(item);
        else if (/\.(?:db|sqlite|sqlite3)(?:-(?:wal|shm))?$/i.test(entry.name)) {
          throw new Error(`Private SQLite data must not be included in the installer payload: ${item}`);
        }
      }
    }

    await stat(path.join(stagingRoot, 'server.js'));
    if (await stat(destination).then(() => true, () => false)) {
      await rm(previousRoot, { recursive: true, force: true });
      await rename(destination, previousRoot);
      movedPrevious = true;
    }

    try {
      await rename(stagingRoot, destination);
    } catch (error) {
      if (movedPrevious) await rename(previousRoot, destination);
      throw error;
    }

    if (movedPrevious) await rm(previousRoot, { recursive: true, force: true });
    return destination;
  } catch (error) {
    await rm(stagingRoot, { recursive: true, force: true });
    if (movedPrevious && !(await stat(destination).then(() => true, () => false))) {
      await rename(previousRoot, destination);
    }
    throw error;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const nodeRuntime = option('--node-runtime') ?? (process.platform === 'win32' ? process.execPath : undefined);
  const output = option('--output');
  const destination = await prepareIntegratedServer({
    ...(output ? { output: resolveInside(projectRoot, output, 'output') } : {}),
    ...(nodeRuntime ? { nodeRuntime } : {}),
  });
  console.log(`Standalone inventory server prepared at ${destination}`);
  if (!nodeRuntime) console.warn('No Node.js runtime was bundled; the output is not suitable for offline Windows installation.');
}
