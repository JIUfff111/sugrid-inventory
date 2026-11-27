import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

function argument(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function availablePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const address = server.address();
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return address.port;
}

function referencedAssets(html) {
  return [...new Set(
    [...html.matchAll(/\/_next\/static\/[^"'<>\s]+?\.(?:js|css)(?:\?[^"'<>\s]*)?/g)]
      .map(match => match[0].replaceAll('&amp;', '&')),
  )];
}

async function waitForHealth(baseUrl, serviceInstance, child, output) {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Packaged server exited before becoming healthy.\n${output()}`);
    try {
      const response = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(2_000) });
      if (response.ok) {
        const body = await response.json();
        assert.equal(body.status, 'ok');
        assert.equal(body.database, 'ready');
        assert.equal(body.version, 'candidate-smoke');
        assert.equal(body.serviceInstance, serviceInstance);
        return;
      }
    } catch (error) {
      if (error instanceof assert.AssertionError) throw error;
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error(`Packaged server did not pass its database health check.\n${output()}`);
}

export async function smokeInventoryRuntime(runtimeRoot) {
  const runtime = path.resolve(runtimeRoot);
  const executable = path.join(runtime, 'node.exe');
  for (const required of [executable, path.join(runtime, 'server.js'), path.join(runtime, 'scripts', 'init-db.js')]) {
    if (!(await stat(required).catch(() => null))?.isFile()) throw new Error(`Packaged runtime is missing ${required}.`);
  }

  const temporaryBase = path.join(process.cwd(), '.tmp', 'inventory-release');
  await mkdir(temporaryBase, { recursive: true });
  const temporary = await mkdtemp(path.join(temporaryBase, 'smoke-'));
  const database = path.join(temporary, 'inventory-qa.db');
  const serviceInstance = `candidate-smoke-${process.pid}`;
  const environment = {
    ...process.env,
    INVENTORY_DB_PATH: database,
    SUGRID_APP_VERSION: 'candidate-smoke',
    SUGRID_SERVICE_INSTANCE: serviceInstance,
    HOSTNAME: '127.0.0.1',
    NODE_ENV: 'production',
  };
  let child;
  let logs = '';
  const output = () => logs.slice(-8_000);
  try {
    await execFileAsync(executable, ['scripts/init-db.js'], { cwd: runtime, env: environment, timeout: 60_000 });
    assert.ok((await stat(database)).size > 0, 'The isolated QA database was not initialized.');

    const port = await availablePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    child = spawn(executable, ['server.js'], {
      cwd: runtime,
      env: { ...environment, PORT: String(port) },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    child.stdout.on('data', chunk => { logs += chunk.toString(); });
    child.stderr.on('data', chunk => { logs += chunk.toString(); });
    await waitForHealth(baseUrl, serviceInstance, child, output);

    const login = await fetch(`${baseUrl}/login`, { signal: AbortSignal.timeout(10_000) });
    assert.equal(login.status, 200, `Packaged login page returned HTTP ${login.status}.`);
    const html = await login.text();
    assert.match(html, /<html\b/i);
    const assets = referencedAssets(html);
    assert.ok(assets.some(asset => asset.includes('.js')), 'Login page did not reference JavaScript assets.');
    assert.ok(assets.some(asset => asset.includes('.css')), 'Login page did not reference CSS assets.');
    for (const asset of assets) {
      const response = await fetch(new URL(asset, baseUrl), { signal: AbortSignal.timeout(10_000) });
      assert.equal(response.status, 200, `Packaged asset ${asset} returned HTTP ${response.status}.`);
      assert.ok((await response.arrayBuffer()).byteLength > 0, `Packaged asset ${asset} is empty.`);
    }
    return { database: 'isolated QA', login: 200, assets: assets.length };
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n${output()}`.trim());
  } finally {
    if (child && child.exitCode === null) {
      child.kill();
      await Promise.race([
        new Promise(resolve => child.once('exit', resolve)),
        new Promise(resolve => setTimeout(resolve, 5_000)),
      ]);
    }
    await rm(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const runtimeRoot = argument('runtime');
  if (!runtimeRoot) throw new Error('Usage: smoke-inventory-runtime.mjs --runtime <prepared inventory folder>.');
  console.log(JSON.stringify(await smokeInventoryRuntime(runtimeRoot)));
}
