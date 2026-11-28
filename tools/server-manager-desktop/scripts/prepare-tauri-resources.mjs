import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export async function prepareTauriResourceDirectories(root = projectRoot) {
  for (const name of ['service-host', 'updater']) {
    await mkdir(path.join(root, 'src-tauri', 'resources', name), { recursive: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await prepareTauriResourceDirectories();
}
