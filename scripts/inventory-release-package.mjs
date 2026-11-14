import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, open, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const INVENTORY_ASSET_NAME = 'sugrid-inventory-windows-x64.zip';
export const INVENTORY_PRODUCT = 'sugrid-inventory';
export const INVENTORY_PLATFORM = 'windows-x64';
export const INVENTORY_PROTOCOL = 1;
const privateDatabaseFile = /\.(?:db|sqlite|sqlite3)(?:-(?:wal|shm))?$/i;

function assertSafeRelativePath(value) {
  if (!value || value.includes('\\') || value.startsWith('/') || value.includes('\0') || value.split('/').some(part => part === '' || part === '.' || part === '..')) {
    throw new Error(`Unsafe inventory package path: ${value}`);
  }
  if (privateDatabaseFile.test(value)) throw new Error(`SQLite data cannot enter a release package: ${value}`);
}

async function hashFile(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

export async function inventoryFiles(directory) {
  const entries = [];
  async function visit(current, relative) {
    for (const item of await readdir(current, { withFileTypes: true })) {
      const nextRelative = relative ? `${relative}/${item.name}` : item.name;
      assertSafeRelativePath(nextRelative);
      const absolute = path.join(current, item.name);
      const details = await lstat(absolute);
      if (details.isSymbolicLink()) throw new Error(`Links cannot enter a release package: ${nextRelative}`);
      if (details.isDirectory()) await visit(absolute, nextRelative);
      else if (details.isFile()) entries.push({ path: `inventory/${nextRelative}`, size: details.size, sha256: await hashFile(absolute) });
      else throw new Error(`Unsupported release package entry: ${nextRelative}`);
    }
  }
  await visit(directory, '');
  entries.sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
  if (!entries.some(item => item.path === 'inventory/server.js') || !entries.some(item => item.path === 'inventory/node.exe') || !entries.some(item => item.path === 'inventory/scripts/init-db.js')) {
    throw new Error('The candidate is missing server.js, node.exe, or scripts/init-db.js.');
  }
  return entries;
}

export function candidateMetadata(commitSha, files) {
  if (!/^[a-f0-9]{40}$/.test(commitSha)) throw new Error('Candidate must identify an exact 40-character Git commit SHA.');
  return { formatVersion: 1, product: INVENTORY_PRODUCT, commitSha, platform: INVENTORY_PLATFORM, minUpdaterProtocol: INVENTORY_PROTOCOL, files };
}

export async function verifyCandidate(candidate) {
  if (!(await lstat(candidate)).isDirectory() || !(await lstat(path.join(candidate, 'inventory'))).isDirectory()) throw new Error('Candidate runtime must be an ordinary directory.');
  if (!(await lstat(path.join(candidate, 'candidate.json'))).isFile()) throw new Error('Candidate metadata must be an ordinary file.');
  const topLevel = (await readdir(candidate)).sort();
  if (JSON.stringify(topLevel) !== JSON.stringify(['candidate.json', 'inventory'])) throw new Error('Candidate contains unexpected top-level entries.');
  const metadata = JSON.parse(await readFile(path.join(candidate, 'candidate.json'), 'utf8'));
  const actual = candidateMetadata(metadata.commitSha, await inventoryFiles(path.join(candidate, 'inventory')));
  if (JSON.stringify(metadata) !== JSON.stringify(actual)) throw new Error('Candidate contents do not match candidate.json.');
  return actual;
}

export function releaseManifest(candidate, version) {
  if (!/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(version)) throw new Error('Inventory release version must be X.Y.Z.');
  return { formatVersion: 1, product: INVENTORY_PRODUCT, version, commitSha: candidate.commitSha, platform: INVENTORY_PLATFORM, minUpdaterProtocol: INVENTORY_PROTOCOL, files: candidate.files };
}

export function signManifest(manifestBytes, privateDerBase64, expectedPublicHex) {
  if (!privateDerBase64 || !/^[a-f0-9]{64}$/.test(expectedPublicHex ?? '')) throw new Error('Release signing key and pinned public key must both be configured.');
  const key = createPrivateKey({ key: Buffer.from(privateDerBase64, 'base64'), format: 'der', type: 'pkcs8' });
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('Release signing key must be Ed25519.');
  const publicDer = createPublicKey(key).export({ format: 'der', type: 'spki' });
  const actualPublicHex = publicDer.subarray(-32).toString('hex');
  if (actualPublicHex !== expectedPublicHex) throw new Error('Release signing key does not match the manager verification key.');
  const signature = sign(null, manifestBytes, key);
  if (signature.length !== 64 || !verify(null, manifestBytes, createPublicKey(key), signature)) throw new Error('Release signature verification failed.');
  return signature.toString('base64');
}

const crcTable = Array.from({ length: 256 }, (_, index) => {
  let crc = index;
  for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  return crc >>> 0;
});

async function crc32(file) {
  let crc = 0xffffffff;
  for await (const chunk of createReadStream(file)) for (const byte of chunk) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

async function writeAll(handle, bytes, position) {
  let offset = 0;
  while (offset < bytes.length) {
    const result = await handle.write(bytes, offset, bytes.length - offset, position + offset);
    if (result.bytesWritten === 0) throw new Error('ZIP write stopped unexpectedly.');
    offset += result.bytesWritten;
  }
}

/** ZIP v1 uses stored files only, without ZIP64, links, directory entries, or metadata extras. */
export async function writeStoredZip(destination, files) {
  if (files.length === 0 || files.length > 65535) throw new Error('Unsupported ZIP entry count.');
  const names = new Set();
  for (const file of files) {
    assertSafeRelativePath(file.name);
    if (names.has(file.name)) throw new Error(`Duplicate ZIP entry: ${file.name}`);
    names.add(file.name);
  }
  const handle = await open(destination, 'wx');
  const central = [];
  let position = 0;
  let completed = false;
  try {
    for (const item of files) {
      assertSafeRelativePath(item.name);
      const name = Buffer.from(item.name, 'utf8');
      const details = await lstat(item.source);
      const size = details.size;
      if (!details.isFile() || size >= 0x100000000 || position + size >= 0x100000000 || name.length > 65535) throw new Error(`ZIP64 or non-file entry is unsupported: ${item.name}`);
      const checksum = await crc32(item.source);
      const header = Buffer.alloc(30);
      header.writeUInt32LE(0x04034b50, 0);
      header.writeUInt16LE(20, 4);
      header.writeUInt16LE(0x800, 6);
      header.writeUInt16LE(0, 8);
      header.writeUInt16LE(0x21, 12);
      header.writeUInt32LE(checksum, 14);
      header.writeUInt32LE(size, 18);
      header.writeUInt32LE(size, 22);
      header.writeUInt16LE(name.length, 26);
      const localOffset = position;
      await writeAll(handle, header, position); position += header.length;
      await writeAll(handle, name, position); position += name.length;
      for await (const chunk of createReadStream(item.source)) { await writeAll(handle, chunk, position); position += chunk.length; }
      const record = Buffer.alloc(46);
      record.writeUInt32LE(0x02014b50, 0);
      record.writeUInt16LE(20, 4);
      record.writeUInt16LE(20, 6);
      record.writeUInt16LE(0x800, 8);
      record.writeUInt16LE(0x21, 14);
      record.writeUInt32LE(checksum, 16);
      record.writeUInt32LE(size, 20);
      record.writeUInt32LE(size, 24);
      record.writeUInt16LE(name.length, 28);
      record.writeUInt32LE(0x20 << 16, 38);
      record.writeUInt32LE(localOffset, 42);
      central.push({ record, name });
    }
    const centralOffset = position;
    for (const entry of central) {
      await writeAll(handle, entry.record, position); position += entry.record.length;
      await writeAll(handle, entry.name, position); position += entry.name.length;
    }
    const footer = Buffer.alloc(22);
    footer.writeUInt32LE(0x06054b50, 0);
    footer.writeUInt16LE(files.length, 8);
    footer.writeUInt16LE(files.length, 10);
    footer.writeUInt32LE(position - centralOffset, 12);
    footer.writeUInt32LE(centralOffset, 16);
    await writeAll(handle, footer, position);
    completed = true;
  } finally {
    await handle.close();
    if (!completed) await rm(destination, { force: true });
  }
}

export async function saveCandidateMetadata(destination, commitSha) {
  const metadata = candidateMetadata(commitSha, await inventoryFiles(path.join(destination, 'inventory')));
  await writeFile(path.join(destination, 'candidate.json'), `${JSON.stringify(metadata)}\n`, { flag: 'wx' });
  return metadata;
}
