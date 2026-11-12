import { access, copyFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const binaryName = process.platform === "win32"
  ? "sugrid-inventory-service.exe"
  : "sugrid-inventory-service";
const source = path.join(projectRoot, "src-tauri", "target", "release", binaryName);
const destination = path.join(projectRoot, "src-tauri", "resources", "inventory", binaryName);

await access(source);
await copyFile(source, destination);
console.log(`Integrated Windows service host prepared at ${destination}`);
