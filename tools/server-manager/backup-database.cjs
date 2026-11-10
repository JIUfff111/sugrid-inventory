'use strict';

const path = require('node:path');
const { createDatabaseBackup, resolveDatabasePath } = require('./manager-core.cjs');

async function main() {
  const projectRoot = path.resolve(__dirname, '..', '..');
  const databasePath = resolveDatabasePath(projectRoot);
  const result = await createDatabaseBackup(databasePath, { projectRoot });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.state === 'created') process.stdout.write(`备份文件：${result.path}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
