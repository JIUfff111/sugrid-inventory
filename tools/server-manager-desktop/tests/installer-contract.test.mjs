import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const page = readFileSync(new URL('../src-tauri/installer-safe-upgrade.nsi', import.meta.url), 'utf8');
const hooks = readFileSync(new URL('../src-tauri/installer-hooks.nsh', import.meta.url), 'utf8');

test('NSIS upgrades and same-version repairs skip the old uninstaller', () => {
  const reinstall = page.split('Function PageReinstall\n')[1]?.split('FunctionEnd')[0];
  assert.ok(reinstall, 'Missing PageReinstall');
  const nsisBranch = reinstall.indexOf('$' + '{If} $WixMode = 0');
  const inplace = reinstall.indexOf('StrCpy $UpdateMode 1', nsisBranch);
  const skipPage = reinstall.indexOf('Abort', inplace);
  assert.ok(nsisBranch >= 0 && nsisBranch < inplace && inplace < skipPage);
  assert.ok(skipPage < reinstall.indexOf('nsDialogs::Create'));
  const downgrade = reinstall.indexOf('$' + '{If} $R0 = -1');
  const error = reinstall.indexOf('SetErrorLevel 6', downgrade);
  const quit = reinstall.indexOf('Quit', error);
  assert.ok(downgrade >= 0 && downgrade < error && error < quit && quit < nsisBranch);
});

test('updater registration failure exposes its diagnostic and fails installation', () => {
  assert.match(hooks, /nsExec::ExecToStack/);
  assert.match(hooks, /Pop \$0\s+Pop \$1/);
  assert.match(hooks, /"\$\{SUGRID_SERVICE_HOST\}" start/);
  assert.match(hooks, /"\$\{SUGRID_UPDATER\}" start-service/);
  assert.match(hooks, /DetailPrint "Updater installation failed \(exit \$0\): \$1"/);
  assert.match(hooks, /SetErrorLevel 1\s+Abort/);
});

test('first-install account page rejects an unqualified Windows name', () => {
  const pageBody = page.split('Function PageOperator\n')[1]?.split('FunctionEnd')[0];
  const validation = page.split('Function PageLeaveOperator\n')[1]?.split('FunctionEnd')[0];
  assert.ok(pageBody, 'Missing operator page');
  assert.ok(validation, 'Missing operator page validation');
  assert.match(pageBody, /ExpandEnvStrings \$OperatorAccount "%USERDOMAIN%\\%USERNAME%"/);
  assert.match(validation, /\$\{StrLoc\} \$0 \$OperatorAccount '\\' ">"/);
  assert.match(validation, /\$\{StrLoc\} \$0 \$OperatorAccount '@' ">"/);
  assert.match(validation, /Enter a qualified account/);
  assert.match(validation, /Abort/);
});
