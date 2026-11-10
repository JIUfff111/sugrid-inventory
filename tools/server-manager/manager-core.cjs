'use strict';

const fs = require('node:fs');
const path = require('node:path');

function parseGitStatus(statusText) {
  return String(statusText || '')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => line.length >= 4 ? line.slice(3) : line);
}

function decideGitUpdate({ branch, remoteBranch = 'main', dirtyPaths = [], ahead = 0, behind = 0 }) {
  if (branch !== remoteBranch) {
    return { state: 'blocked', reason: `当前分支是 ${branch || '(未知)'}，更新目标为 ${remoteBranch}` };
  }
  if (dirtyPaths.length > 0) {
    return { state: 'blocked', reason: '工作区存在未提交或未跟踪文件', dirtyPaths };
  }
  if (ahead > 0 && behind > 0) {
    return { state: 'blocked', reason: '本地和远端分支已分叉，需要人工核对', ahead, behind };
  }
  if (behind === 0) {
    return { state: 'current', reason: ahead > 0 ? `本地领先远端 ${ahead} 个提交` : '本地已是最新版本', ahead, behind };
  }
  return { state: 'ready', reason: `可以快进更新 ${behind} 个提交`, ahead, behind };
}

function readEnvValue(contents, name) {
  const line = String(contents || '').split(/\r?\n/)
    .find((entry) => new RegExp(`^\\s*${name}\\s*=`).test(entry));
  if (!line) return '';
  const value = line.slice(line.indexOf('=') + 1).trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

function resolveDatabasePath(projectRoot, { envValue = process.env.INVENTORY_DB_PATH, envFileContents } = {}) {
  const localEnv = envFileContents === undefined
    ? (() => {
      const envPath = path.join(projectRoot, '.env.local');
      return fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
    })()
    : envFileContents;
  const configuredPath = envValue || readEnvValue(localEnv, 'INVENTORY_DB_PATH') || path.join('data', 'inventory.db');
  return path.resolve(projectRoot, configuredPath);
}

async function createDatabaseBackup(databasePath, { projectRoot, backupDirectory, now = new Date() } = {}) {
  const absoluteDatabasePath = path.resolve(databasePath);
  if (!fs.existsSync(absoluteDatabasePath)) return { state: 'skipped', reason: '数据库文件不存在', path: absoluteDatabasePath };

  const root = path.resolve(projectRoot || path.join(__dirname, '..', '..'));
  const Database = require(require.resolve('better-sqlite3', { paths: [root] }));
  const targetDirectory = path.resolve(backupDirectory || path.join(path.dirname(absoluteDatabasePath), 'backups'));
  fs.mkdirSync(targetDirectory, { recursive: true });
  const timestamp = now.toISOString().replace(/[-:]/g, '');
  const baseName = `${path.basename(absoluteDatabasePath, path.extname(absoluteDatabasePath))}.before-manager-${timestamp}`;
  let destination = path.join(targetDirectory, `${baseName}.db`);
  for (let suffix = 1; fs.existsSync(destination); suffix += 1) {
    destination = path.join(targetDirectory, `${baseName}-${String(suffix).padStart(3, '0')}.db`);
  }
  const source = new Database(absoluteDatabasePath, { readonly: true, fileMustExist: true });
  try {
    await source.backup(destination);
  } finally {
    source.close();
  }

  const verification = new Database(destination, { readonly: true, fileMustExist: true });
  try {
    const integrity = verification.pragma('integrity_check', { simple: true });
    if (integrity !== 'ok') throw new Error(`数据库备份校验失败：${integrity}`);
    return { state: 'created', path: destination, integrity };
  } finally {
    verification.close();
  }
}

function readDecisionArguments(args) {
  const [branch, dirtyCountText, aheadText, behindText] = args;
  if (!branch || args.length !== 4) throw new Error('用法：manager-core.cjs decide <branch> <dirty-count> <ahead> <behind>');
  const counts = [dirtyCountText, aheadText, behindText].map((value) => Number(value));
  if (counts.some((value) => !Number.isSafeInteger(value) || value < 0)) {
    throw new Error('Git 变更数量必须是非负整数。');
  }
  const [dirtyCount, ahead, behind] = counts;
  return decideGitUpdate({
    branch,
    dirtyPaths: dirtyCount > 0 ? ['(working tree not clean)'] : [],
    ahead,
    behind,
  });
}

if (require.main === module) {
  try {
    const [command, ...args] = process.argv.slice(2);
    if (command !== 'decide') throw new Error('支持的命令：decide');
    process.stdout.write(`${JSON.stringify(readDecisionArguments(args))}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { createDatabaseBackup, decideGitUpdate, parseGitStatus, readDecisionArguments, readEnvValue, resolveDatabasePath };
