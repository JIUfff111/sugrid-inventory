import { mkdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { INVENTORY_ASSET_NAME, releaseManifest, saveCandidateMetadata, signManifest, verifyCandidate, writeStoredZip } from './inventory-release-package.mjs';

function argument(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function required(name) {
  const value = argument(name);
  if (!value || value.startsWith('--')) throw new Error(`Missing --${name}.`);
  return value;
}

export async function createCandidate({ root, commitSha }) {
  const metadata = await saveCandidateMetadata(root, commitSha);
  return { root, commitSha: metadata.commitSha, files: metadata.files.length };
}

export async function createRelease({ candidateRoot, outputRoot, version, commitSha, privateKeyBase64, publicKeyHex }) {
  const candidate = await verifyCandidate(candidateRoot);
  if (candidate.commitSha !== commitSha) throw new Error('Candidate Git commit does not match the approved workflow run.');
  const manifest = releaseManifest(candidate, version);
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest)}\n`, 'utf8');
  const signature = signManifest(manifestBytes, privateKeyBase64, publicKeyHex);
  await mkdir(outputRoot, { recursive: true });
  const manifestFile = path.join(outputRoot, 'manifest.json');
  const signatureFile = path.join(outputRoot, 'manifest.sig');
  await writeFile(manifestFile, manifestBytes);
  await writeFile(signatureFile, signature);
  const asset = path.join(outputRoot, INVENTORY_ASSET_NAME);
  await writeStoredZip(asset, [
    { name: 'manifest.json', source: manifestFile },
    { name: 'manifest.sig', source: signatureFile },
    ...manifest.files.map(file => ({ name: file.path, source: path.join(candidateRoot, ...file.path.split('/')) })),
  ]);
  return { asset, version, commitSha, bytes: (await stat(asset)).size };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    let result;
    switch (process.argv[2]) {
      case 'candidate':
        result = await createCandidate({ root: path.resolve(required('root')), commitSha: required('commit') });
        break;
      case 'release':
        result = await createRelease({
          candidateRoot: path.resolve(required('candidate')),
          outputRoot: path.resolve(required('output')),
          version: required('version'),
          commitSha: required('commit'),
          privateKeyBase64: process.env.SUGRID_INVENTORY_SIGNING_KEY_PKCS8_B64,
          publicKeyHex: process.env.SUGRID_INVENTORY_VERIFY_KEY_HEX,
        });
        break;
      default: throw new Error('Usage: inventory-release-cli.mjs candidate|release [options].');
    }
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
