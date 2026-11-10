$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$managerScript = Join-Path $projectRoot 'tools\server-manager\ServerManager.ps1'
$listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
$listener.Start()
$port = $listener.LocalEndpoint.Port
$listener.Stop()
$databasePath = Join-Path $projectRoot '.tmp\server-manager\window-smoke.db'
$manager = $null

try {
  $manager = Start-Process -FilePath "$env:WINDIR\System32\WindowsPowerShell\v1.0\powershell.exe" `
    -ArgumentList @('-NoProfile', '-STA', '-File', ('"' + $managerScript + '"'), '-Port', $port, '-HostAddress', '127.0.0.1', '-DatabasePath', ('"' + $databasePath + '"')) `
    -WorkingDirectory $projectRoot -WindowStyle Normal -PassThru

  $deadline = (Get-Date).AddSeconds(20)
  do {
    Start-Sleep -Milliseconds 250
    $manager.Refresh()
  } while (-not $manager.HasExited -and $manager.MainWindowTitle -notlike 'SUGRID*' -and (Get-Date) -lt $deadline)
  if ($manager.HasExited -or $manager.MainWindowTitle -notlike 'SUGRID*') {
    throw 'Manager did not open a visible window.'
  }

  Start-Sleep -Seconds 9
  $manager.Refresh()
  if (-not $manager.Responding) { throw 'Manager did not respond after repeated status refresh.' }
  if (-not $manager.CloseMainWindow()) { throw 'Manager rejected the normal close request.' }
  if (-not $manager.WaitForExit(5000)) { throw 'Manager did not close within 5 seconds.' }
  Write-Output 'PASS Windows manager opens, responds after repeated status refresh, and closes normally'
} finally {
  if ($manager) {
    $manager.Refresh()
    if (-not $manager.HasExited) { Stop-Process -Id $manager.Id -Force }
    $manager.Dispose()
  }
}
