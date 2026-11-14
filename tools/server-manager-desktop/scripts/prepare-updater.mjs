import { access, copyFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const binaryName = process.platform === 'win32' ? 'sugrid-inventory-updater.exe' : 'sugrid-inventory-updater';
const source = path.join(projectRoot, 'src-tauri', 'target', 'release', binaryName);
const destination = path.join(projectRoot, 'src-tauri', 'resources', 'updater', binaryName);
await access(source);
await mkdir(path.dirname(destination), { recursive: true });
await copyFile(source, destination);
console.log(`Windows inventory updater prepared at ${destination}`);
