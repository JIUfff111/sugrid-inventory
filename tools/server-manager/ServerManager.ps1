param(
  [int]$Port = 0,
  [string]$HostAddress = '',
  [string]$DatabasePath = '',
  [switch]$StartServiceOnly
)

$ErrorActionPreference = 'Stop'
$script:ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$script:RuntimeRoot = Join-Path $script:ProjectRoot '.tmp\server-manager'
$script:LogRoot = Join-Path $script:RuntimeRoot 'logs'
$script:StatePath = Join-Path $script:RuntimeRoot 'service-state.json'
$script:ConfigPath = Join-Path $script:RuntimeRoot 'config.json'
$script:ManagerLogPath = Join-Path $script:LogRoot 'manager.log'
$script:ManagerCorePath = Join-Path $PSScriptRoot 'manager-core.cjs'
$script:BackupScriptPath = Join-Path $PSScriptRoot 'backup-database.cjs'
$script:Busy = $false
$script:StatusResult = $null

New-Item -ItemType Directory -Path $script:LogRoot -Force | Out-Null

function Get-DefaultDatabasePath {
  if ($env:INVENTORY_DB_PATH) {
    if ([System.IO.Path]::IsPathRooted($env:INVENTORY_DB_PATH)) { return [System.IO.Path]::GetFullPath($env:INVENTORY_DB_PATH) }
    return [System.IO.Path]::GetFullPath((Join-Path $script:ProjectRoot $env:INVENTORY_DB_PATH))
  }

  $envLocalPath = Join-Path $script:ProjectRoot '.env.local'
  if (Test-Path $envLocalPath) {
    $line = Get-Content $envLocalPath | Where-Object { $_ -match '^\s*INVENTORY_DB_PATH\s*=' } | Select-Object -First 1
    if ($line) {
      $value = ($line -replace '^\s*INVENTORY_DB_PATH\s*=\s*', '').Trim()
      if (($value.StartsWith('"') -and $value.EndsWith('"')) -or ($value.StartsWith("'") -and $value.EndsWith("'"))) { $value = $value.Substring(1, $value.Length - 2) }
      if (-not [System.IO.Path]::IsPathRooted($value)) { $value = Join-Path $script:ProjectRoot $value }
      return [System.IO.Path]::GetFullPath($value)
    }
  }
  return [System.IO.Path]::GetFullPath((Join-Path $script:ProjectRoot 'data\inventory.db'))
}

function Get-ManagerConfig {
  $config = @{ port = 3000; host = '0.0.0.0'; databasePath = (Get-DefaultDatabasePath) }
  if (Test-Path $script:ConfigPath) {
    try {
      $stored = Get-Content $script:ConfigPath -Raw | ConvertFrom-Json
      if ($stored.port) { $config.port = [int]$stored.port }
      if ($stored.host) { $config.host = [string]$stored.host }
      if ($stored.databasePath) { $config.databasePath = [string]$stored.databasePath }
    } catch {
      Add-ManagerLog "本地配置文件无效，使用安全默认值：$($_.Exception.Message)"
    }
  }
  if ($Port -gt 0) { $config.port = $Port }
  if ($HostAddress) { $config.host = $HostAddress }
  if ($DatabasePath) {
    $config.databasePath = if ([System.IO.Path]::IsPathRooted($DatabasePath)) { [System.IO.Path]::GetFullPath($DatabasePath) } else { [System.IO.Path]::GetFullPath((Join-Path $script:ProjectRoot $DatabasePath)) }
  }
  return $config
}

$script:Config = Get-ManagerConfig

function Add-ManagerLog([string]$Message) {
  $line = "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] $Message"
  Add-Content -LiteralPath $script:ManagerLogPath -Value $line -Encoding UTF8
  if ($script:LogBox -and -not $script:LogBox.IsDisposed) {
    $script:LogBox.AppendText($line + [Environment]::NewLine)
    $script:LogBox.SelectionStart = $script:LogBox.TextLength
    $script:LogBox.ScrollToCaret()
  }
}

function Save-ManagerConfig {
  $portValue = 0
  if (-not [int]::TryParse($script:PortBox.Text.Trim(), [ref]$portValue) -or $portValue -lt 1 -or $portValue -gt 65535) {
    throw '端口必须是 1 到 65535 之间的数字。'
  }
  $hostValue = [string]$script:HostBox.SelectedItem
  if ($hostValue -notin @('0.0.0.0', '127.0.0.1')) { throw '监听地址只能选择 0.0.0.0 或 127.0.0.1。' }
  $databaseValue = $script:DatabaseBox.Text.Trim()
  if (-not $databaseValue) { throw '请填写数据库文件路径。' }
  if (-not [System.IO.Path]::IsPathRooted($databaseValue)) { $databaseValue = Join-Path $script:ProjectRoot $databaseValue }
  $databaseValue = [System.IO.Path]::GetFullPath($databaseValue)

  $currentStatus = Get-ProjectServiceStatus
  $configurationChanged = $portValue -ne $script:Config.port -or $hostValue -ne $script:Config.host -or -not [string]::Equals($databaseValue, $script:Config.databasePath, [StringComparison]::OrdinalIgnoreCase)
  if ($configurationChanged -and $currentStatus.State -ne 'Stopped') {
    throw '请先停止服务，再修改端口、监听地址或数据库路径。'
  }

  $script:Config = @{ port = $portValue; host = $hostValue; databasePath = $databaseValue }
  $script:PortBox.Text = [string]$portValue
  $script:DatabaseBox.Text = $databaseValue
  $script:Config | ConvertTo-Json | Set-Content -LiteralPath $script:ConfigPath -Encoding UTF8
  Add-ManagerLog "已保存本机设置：端口 $portValue，数据库 $databaseValue"
}

function Get-ListeningProcesses {
  $connections = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue)
  $processIds = @($connections | Select-Object -ExpandProperty OwningProcess -Unique)
  $results = @()
  foreach ($processId in $processIds) {
    $process = Get-CimInstance Win32_Process -Filter "ProcessId = $processId" -ErrorAction SilentlyContinue
    if (-not $process) { continue }
    $commandLine = [string]$process.CommandLine
    $isNextStart = $commandLine -match '(?i)next[\\/]dist[\\/]bin[\\/]next(?:\.js)?"?\s+start|node_modules[\\/]next[\\/]dist[\\/]bin[\\/]next(?:\.js)?"?\s+start'
    $isProject = $isNextStart -and $commandLine.IndexOf($script:ProjectRoot, [StringComparison]::OrdinalIgnoreCase) -ge 0
    $ports = @($connections | Where-Object { $_.OwningProcess -eq $processId } | Select-Object -ExpandProperty LocalPort -Unique)
    $results += [pscustomobject]@{ ProcessId = [int]$processId; CommandLine = $commandLine; IsNextStart = $isNextStart; IsProject = $isProject; ListeningPorts = $ports }
  }
  return $results
}

function Get-RecordedServiceState {
  if (-not (Test-Path $script:StatePath)) { return $null }
  try { return Get-Content $script:StatePath -Raw | ConvertFrom-Json } catch { return $null }
}

function Get-ProjectServiceStatus {
  $allProcesses = @(Get-ListeningProcesses)
  $processes = @($allProcesses | Where-Object { $_.ListeningPorts -contains $script:Config.port })
  $otherProjectProcesses = @($allProcesses | Where-Object { $_.IsProject -and $_.ListeningPorts -notcontains $script:Config.port })
  if ($processes.Count -eq 0) { return [pscustomobject]@{ State = 'Stopped'; Processes = @(); OtherProjectProcesses = $otherProjectProcesses; Healthy = $false; Managed = $false; DatabasePath = '' } }
  $projectProcesses = @($processes | Where-Object { $_.IsProject })
  if ($projectProcesses.Count -gt 0) {
    $recorded = Get-RecordedServiceState
    $recordedRoot = if ($recorded -and $recorded.projectRoot) { [string]$recorded.projectRoot } else { '' }
    $managed = $false
    if ($recorded -and $recorded.processId -and $recorded.port -eq $script:Config.port -and [string]::Equals($recordedRoot, $script:ProjectRoot, [StringComparison]::OrdinalIgnoreCase)) {
      $managed = @($projectProcesses | Where-Object { $_.ProcessId -eq [int]$recorded.processId }).Count -gt 0
    }
    $healthy = $false
    try { $response = Invoke-WebRequest -Uri "http://127.0.0.1:$($script:Config.port)/login" -UseBasicParsing -TimeoutSec 2; $healthy = $response.StatusCode -eq 200 } catch {}
    $state = if ($managed) { if ($healthy) { 'Running' } else { 'Starting' } } else { if ($healthy) { 'ExternalProject' } else { 'StartingExternal' } }
    $databasePath = if ($managed) { [string]$recorded.databasePath } else { '' }
    return [pscustomobject]@{ State = $state; Processes = $projectProcesses; OtherProjectProcesses = $otherProjectProcesses; Healthy = $healthy; Managed = $managed; DatabasePath = $databasePath }
  }
  if (@($processes | Where-Object { $_.IsNextStart }).Count -gt 0) {
    return [pscustomobject]@{ State = 'UnmanagedNext'; Processes = @($processes | Where-Object { $_.IsNextStart }); OtherProjectProcesses = $otherProjectProcesses; Healthy = $true; Managed = $false; DatabasePath = '' }
  }
  return [pscustomobject]@{ State = 'PortConflict'; Processes = $processes; OtherProjectProcesses = $otherProjectProcesses; Healthy = $false; Managed = $false; DatabasePath = '' }
}

function Assert-DatabasePathKnown {
  $status = Get-ProjectServiceStatus
  if ($status.State -in @('ExternalProject', 'StartingExternal', 'UnmanagedNext', 'PortConflict')) {
    throw '端口上有未由管理器托管的进程，实际数据库路径无法核实。请先接管项目服务或停止冲突进程，再继续数据库操作。'
  }
  if ($status.Managed -and -not [string]::Equals([string]$status.DatabasePath, [string]$script:Config.databasePath, [StringComparison]::OrdinalIgnoreCase)) {
    throw '当前服务使用的数据库路径与管理器配置不一致。请停止服务并核对配置后重试。'
  }
}

function Assert-NoOtherProjectServices {
  $status = Get-ProjectServiceStatus
  if ($status.OtherProjectProcesses.Count -gt 0) {
    $locations = @($status.OtherProjectProcesses | ForEach-Object { "端口 $($_.ListeningPorts -join ',') (PID $($_.ProcessId))" }) -join '；'
    throw "同一项目还有其他端口的服务正在运行：$locations。为避免影响它们，请先停止这些服务，再执行依赖安装、数据库迁移、构建或 Git 更新。"
  }
}

function Set-DatabaseEnvironment {
  $env:INVENTORY_DB_PATH = $script:Config.databasePath
  $env:PORT = [string]$script:Config.port
  $env:HOSTNAME = $script:Config.host
}

function Start-ProjectService {
  $status = Get-ProjectServiceStatus
  if ($status.State -eq 'Running') {
    Add-ManagerLog "服务已在运行，PID $((@($status.Processes | ForEach-Object { $_.ProcessId }) -join ', '))"
    return $true
  }
  if ($status.State -in @('Starting', 'ExternalProject', 'StartingExternal', 'UnmanagedNext', 'PortConflict')) {
    Add-ManagerLog "端口 $($script:Config.port) 已被其他进程占用，拒绝重复启动。"
    return $false
  }

  $nextCli = Join-Path $script:ProjectRoot 'node_modules\next\dist\bin\next'
  $buildId = Join-Path $script:ProjectRoot '.next\BUILD_ID'
  if (-not (Test-Path $nextCli)) { Add-ManagerLog '找不到 Next.js CLI，请先安装依赖。'; return $false }
  if (-not (Test-Path $buildId)) { Add-ManagerLog '找不到生产构建，请先执行构建。'; return $false }
  $node = (Get-Command node.exe -ErrorAction SilentlyContinue | Select-Object -First 1).Source
  if (-not $node) { Add-ManagerLog '找不到 node.exe，请先安装 Node.js LTS。'; return $false }

  $safeNextCli = '"' + $nextCli.Replace('"', '\"') + '"'
  $arguments = "$safeNextCli start --hostname $($script:Config.host) --port $($script:Config.port)"
  $logStamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
  $stdoutPath = Join-Path $script:LogRoot "service-$logStamp.out.log"
  $stderrPath = Join-Path $script:LogRoot "service-$logStamp.err.log"
  $envSnapshot = @{}
  foreach ($name in @('INVENTORY_DB_PATH', 'PORT', 'HOSTNAME')) { $envSnapshot[$name] = [Environment]::GetEnvironmentVariable($name, 'Process') }
  Set-DatabaseEnvironment
  try {
    $process = Start-Process -FilePath $node -ArgumentList $arguments -WorkingDirectory $script:ProjectRoot -WindowStyle Hidden -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath -PassThru
  } finally {
    foreach ($name in $envSnapshot.Keys) {
      if ($null -eq $envSnapshot[$name]) { Remove-Item "Env:$name" -ErrorAction SilentlyContinue } else { [Environment]::SetEnvironmentVariable($name, $envSnapshot[$name], 'Process') }
    }
  }
  $state = @{ processId = $process.Id; projectRoot = $script:ProjectRoot; port = $script:Config.port; databasePath = $script:Config.databasePath; startedAt = (Get-Date).ToString('o'); stdout = $stdoutPath; stderr = $stderrPath }
  $state | ConvertTo-Json | Set-Content -LiteralPath $script:StatePath -Encoding UTF8
  Add-ManagerLog "服务已启动：PID $($process.Id)，端口 $($script:Config.port)，数据库 $($script:Config.databasePath)"
  for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Milliseconds 400
    [System.Windows.Forms.Application]::DoEvents()
    $status = Get-ProjectServiceStatus
    if ($status.State -eq 'Running') { Add-ManagerLog '健康检查通过。'; return $true }
    $process.Refresh()
    if ($status.State -eq 'PortConflict') {
      if (-not $process.HasExited) { Stop-Process -Id $process.Id -ErrorAction SilentlyContinue }
      $recorded = Get-RecordedServiceState
      if ($recorded -and $recorded.processId -eq $process.Id) { Remove-Item $script:StatePath -Force -ErrorAction SilentlyContinue }
      Add-ManagerLog '服务启动时端口被其他进程占用，已清理本次启动状态。'
      return $false
    }
    if ($process.HasExited) { break }
  }
  $process.Refresh()
  if (Test-Path $script:StatePath) { Remove-Item $script:StatePath -Force }
  if ($process.HasExited) {
    Add-ManagerLog "服务启动失败：进程在健康检查通过前已退出。查看错误日志：$stderrPath"
  } else {
    Stop-Process -Id $process.Id -ErrorAction SilentlyContinue
    Add-ManagerLog "服务启动失败：健康检查超时，已结束启动进程。查看错误日志：$stderrPath"
  }
  return $false
}

function Stop-ProjectService {
  $status = Get-ProjectServiceStatus
  if ($status.State -eq 'Stopped') { Add-ManagerLog '服务当前已停止。'; return $true }
  if ($status.State -notin @('Running', 'Starting', 'ExternalProject', 'StartingExternal')) {
    Add-ManagerLog '端口上的进程无法确认属于本项目，拒绝停止。'
    return $false
  }
  $removeState = [bool]$status.Managed
  foreach ($processInfo in $status.Processes) {
    Stop-Process -Id $processInfo.ProcessId -ErrorAction Stop
  }
  for ($i = 0; $i -lt 20; $i++) {
    Start-Sleep -Milliseconds 250
    [System.Windows.Forms.Application]::DoEvents()
    if ((Get-ProjectServiceStatus).State -eq 'Stopped') {
      if ($removeState -and (Test-Path $script:StatePath)) { Remove-Item $script:StatePath -Force }
      Add-ManagerLog '服务已停止。'
      return $true
    }
  }
  Add-ManagerLog '等待服务停止超时。'
  return $false
}

function Invoke-ManagerCommand {
  param([string]$Label, [string]$Kind, [string]$Arguments)
  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
  $stdoutPath = Join-Path $script:LogRoot "operation-$stamp.out.log"
  $stderrPath = Join-Path $script:LogRoot "operation-$stamp.err.log"
  $filePath = ''
  $argumentLine = $Arguments
  if ($Kind -eq 'npm') {
    $filePath = $env:ComSpec
    $argumentLine = "/d /c npm.cmd $Arguments"
  } elseif ($Kind -eq 'git') {
    $filePath = (Get-Command git.exe -ErrorAction Stop | Select-Object -First 1).Source
  } elseif ($Kind -eq 'node') {
    $filePath = (Get-Command node.exe -ErrorAction Stop | Select-Object -First 1).Source
  } else { throw "未知命令类型：$Kind" }

  Add-ManagerLog "开始：$Label"
  if ($script:StatusLabel -and -not $script:StatusLabel.IsDisposed) { $script:StatusLabel.Text = "正在执行：$Label" }
  $envSnapshot = @{}
  foreach ($name in @('INVENTORY_DB_PATH', 'PORT', 'HOSTNAME', 'GIT_TERMINAL_PROMPT', 'GCM_INTERACTIVE')) { $envSnapshot[$name] = [Environment]::GetEnvironmentVariable($name, 'Process') }
  if ($Kind -eq 'git') { $env:GIT_TERMINAL_PROMPT = '0'; $env:GCM_INTERACTIVE = 'Never' }
  if ($Kind -eq 'npm' -or ($Kind -eq 'node' -and $Arguments -like '*backup-database.cjs*')) { Set-DatabaseEnvironment }
  $startInfo = New-Object System.Diagnostics.ProcessStartInfo
  $startInfo.FileName = $filePath
  $startInfo.Arguments = $argumentLine
  $startInfo.WorkingDirectory = $script:ProjectRoot
  $startInfo.UseShellExecute = $false
  $startInfo.CreateNoWindow = $true
  $startInfo.RedirectStandardOutput = $true
  $startInfo.RedirectStandardError = $true
  $startInfo.StandardOutputEncoding = [System.Text.Encoding]::UTF8
  $startInfo.StandardErrorEncoding = [System.Text.Encoding]::UTF8
  $process = New-Object System.Diagnostics.Process
  $process.StartInfo = $startInfo
  try {
    if (-not $process.Start()) { throw "无法启动命令：$Label" }
    $stdoutTask = $process.StandardOutput.ReadToEndAsync()
    $stderrTask = $process.StandardError.ReadToEndAsync()
  } finally {
    foreach ($name in $envSnapshot.Keys) {
      if ($null -eq $envSnapshot[$name]) { Remove-Item "Env:$name" -ErrorAction SilentlyContinue } else { [Environment]::SetEnvironmentVariable($name, $envSnapshot[$name], 'Process') }
    }
  }

  while (-not $process.HasExited) {
    [System.Windows.Forms.Application]::DoEvents()
    Start-Sleep -Milliseconds 100
  }
  $process.WaitForExit()
  $stdout = $stdoutTask.GetAwaiter().GetResult()
  $stderr = $stderrTask.GetAwaiter().GetResult()
  [System.IO.File]::WriteAllText($stdoutPath, $stdout, [System.Text.UTF8Encoding]::new($false))
  [System.IO.File]::WriteAllText($stderrPath, $stderr, [System.Text.UTF8Encoding]::new($false))
  foreach ($line in ($stdout -split "`r?`n" | Where-Object { $_ })) { Add-ManagerLog $line }
  foreach ($line in ($stderr -split "`r?`n" | Where-Object { $_ })) { Add-ManagerLog $line }
  $exitCode = $process.ExitCode
  $process.Dispose()
  Add-ManagerLog "结束：$Label，退出码 $exitCode"
  return [pscustomobject]@{ ExitCode = $exitCode; Stdout = $stdout; Stderr = $stderr }
}

function Get-GitSnapshot {
  $fetch = Invoke-ManagerCommand '检查远端更新' 'git' 'fetch origin'
  if ($fetch.ExitCode -ne 0) { throw 'git fetch 失败，请查看日志。' }
  $branch = Invoke-ManagerCommand '读取当前分支' 'git' 'branch --show-current'
  $dirty = Invoke-ManagerCommand '检查本地改动' 'git' 'status --porcelain --untracked-files=all'
  $counts = Invoke-ManagerCommand '比较本地与远端提交' 'git' 'rev-list --left-right --count HEAD...origin/main'
  if ($branch.ExitCode -ne 0 -or $dirty.ExitCode -ne 0 -or $counts.ExitCode -ne 0) { throw '无法读取 Git 状态。' }
  $branchName = $branch.Stdout.Trim()
  $dirtyLines = @($dirty.Stdout -split "`r?`n" | Where-Object { $_.Trim() })
  $countParts = @($counts.Stdout.Trim() -split '\s+')
  $ahead = if ($countParts.Count -ge 1) { [int]$countParts[0] } else { 0 }
  $behind = if ($countParts.Count -ge 2) { [int]$countParts[1] } else { 0 }
  $dirtyCount = $dirtyLines.Count
  $decisionCommand = "`"$script:ManagerCorePath`" decide $branchName $dirtyCount $ahead $behind"
  $decision = Invoke-ManagerCommand '评估更新条件' 'node' $decisionCommand
  if ($decision.ExitCode -ne 0) { throw '更新安全检查运行失败。' }
  return [pscustomobject]@{ Branch = $branchName; DirtyLines = $dirtyLines; Ahead = $ahead; Behind = $behind; Decision = ($decision.Stdout | ConvertFrom-Json) }
}

function Invoke-DatabaseBackup {
  Assert-DatabasePathKnown
  $result = Invoke-ManagerCommand '备份 SQLite 数据库' 'node' '"tools\server-manager\backup-database.cjs"'
  if ($result.ExitCode -ne 0) { throw '数据库备份失败；后续操作已停止。' }
  Add-ManagerLog "数据库路径：$($script:Config.databasePath)"
  return $result
}

function Invoke-DatabaseInitialization {
  Assert-DatabasePathKnown
  Assert-NoOtherProjectServices
  $wasRunning = (Get-ProjectServiceStatus).State -eq 'Running'
  if ($wasRunning -and -not (Stop-ProjectService)) { throw '服务停止失败，数据库初始化已取消。' }
  Invoke-DatabaseBackup | Out-Null
  $init = Invoke-ManagerCommand '初始化数据库结构' 'npm' 'run db:init'
  if ($init.ExitCode -ne 0) { throw '数据库初始化失败；服务保持停止，请查看日志。' }
  if ($wasRunning -and -not (Start-ProjectService)) { throw '数据库初始化已完成，但服务未能启动。请查看日志。' }
}

function Invoke-BuildAndRestart {
  Assert-DatabasePathKnown
  Assert-NoOtherProjectServices
  $wasRunning = (Get-ProjectServiceStatus).State -eq 'Running'
  if ($wasRunning -and -not (Stop-ProjectService)) { throw '服务停止失败，构建已取消。' }
  Invoke-DatabaseBackup | Out-Null
  $init = Invoke-ManagerCommand '更新数据库结构' 'npm' 'run db:init'
  if ($init.ExitCode -ne 0) { throw '数据库初始化失败；服务保持停止，请查看日志。' }
  $build = Invoke-ManagerCommand '构建生产版本' 'npm' 'run build'
  if ($build.ExitCode -ne 0) { throw '生产构建失败；服务保持停止，请查看日志。' }
  if ($wasRunning) {
    if (-not (Start-ProjectService)) { throw '构建已完成，但服务未能启动。请查看日志。' }
  } else { Add-ManagerLog '原服务未运行，构建完成后保持停止状态。' }
}

function Invoke-DependencyInstall {
  Assert-DatabasePathKnown
  Assert-NoOtherProjectServices
  if ((Get-ProjectServiceStatus).State -ne 'Stopped') { throw '请先停止本端口的服务，再安装依赖。' }
  $result = Invoke-ManagerCommand '安装锁定依赖' 'npm' 'ci'
  if ($result.ExitCode -ne 0) { throw '依赖安装失败；请查看操作记录中的错误输出。' }
  Add-ManagerLog '依赖安装完成。'
}

function Invoke-SafeUpdate {
  Assert-DatabasePathKnown
  Assert-NoOtherProjectServices
  $snapshot = Get-GitSnapshot
  if ($snapshot.Decision.state -ne 'ready') {
    Add-ManagerLog "未执行更新：$($snapshot.Decision.reason)"
    foreach ($line in $snapshot.DirtyLines) { Add-ManagerLog "本地文件：$line" }
    return
  }
  $databaseExists = Test-Path $script:Config.databasePath
  $detail = "将从 origin/main 快进更新 $($snapshot.Behind) 个提交。`n`n服务端口：$($script:Config.port)`n数据库：$($script:Config.databasePath)`n数据库文件：$(if ($databaseExists) { '更新前会创建 SQLite 备份' } else { '尚不存在，跳过备份' })`n`n更新会暂时停止服务，完成依赖安装、数据库迁移和构建后再启动。"
  $choice = [System.Windows.Forms.MessageBox]::Show($detail, '确认安全更新', [System.Windows.Forms.MessageBoxButtons]::YesNo, [System.Windows.Forms.MessageBoxIcon]::Warning)
  if ($choice -ne [System.Windows.Forms.DialogResult]::Yes) { Add-ManagerLog '用户取消更新。'; return }

  $wasRunning = (Get-ProjectServiceStatus).State -eq 'Running'
  $pullApplied = $false
  try {
    if ($wasRunning -and -not (Stop-ProjectService)) { throw '服务停止失败，更新已取消。' }
    Invoke-DatabaseBackup | Out-Null
    $pull = Invoke-ManagerCommand '快进拉取 origin/main' 'git' 'pull --ff-only origin main'
    if ($pull.ExitCode -ne 0) { throw 'Git 拉取失败；请先检查日志和当前分支。' }
    $pullApplied = $true
    foreach ($step in @(
        @{ Label = '安装锁定依赖'; Args = 'ci' },
        @{ Label = '更新数据库结构'; Args = 'run db:init' },
        @{ Label = '运行代码规范检查'; Args = 'run lint' },
        @{ Label = '运行 TypeScript 检查'; Args = 'exec -- tsc --noEmit' },
        @{ Label = '构建生产版本'; Args = 'run build' }
      )) {
      $result = Invoke-ManagerCommand $step.Label 'npm' $step.Args
      if ($result.ExitCode -ne 0) { throw "$($step.Label)失败。当前代码已快进到 origin/main，服务保持停止；请查看日志和更新前数据库备份。" }
    }
    if ($wasRunning -and -not (Start-ProjectService)) { throw '更新检查已完成，但服务未能启动。请查看日志。' }
    Add-ManagerLog 'Git 更新和维护检查全部完成。'
  } catch {
    if ($wasRunning -and -not $pullApplied -and (Get-ProjectServiceStatus).State -eq 'Stopped') {
      if (Start-ProjectService) { Add-ManagerLog '拉取前失败，已恢复更新前的服务。' }
      else { Add-ManagerLog '拉取前失败，尝试恢复服务未成功；请查看启动日志。' }
    } elseif ($pullApplied) {
      Add-ManagerLog '更新已拉取但后续步骤未全部完成；为避免用不完整构建启动，服务保持停止。请按日志检查代码版本、数据库备份和失败步骤。'
    }
    throw
  }
}

if ($StartServiceOnly) {
  Add-Type -AssemblyName System.Windows.Forms
  if (-not (Start-ProjectService)) { exit 1 }
  exit 0
}

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

$form = New-Object System.Windows.Forms.Form
$form.Text = 'SUGRID 本机服务管理'
$form.StartPosition = 'CenterScreen'
$form.Size = New-Object System.Drawing.Size(1030, 790)
$form.MinimumSize = New-Object System.Drawing.Size(920, 700)
$form.BackColor = [System.Drawing.Color]::FromArgb(246, 248, 251)
$form.Font = New-Object System.Drawing.Font('Segoe UI', 9)

$header = New-Object System.Windows.Forms.Panel
$header.Dock = 'Top'; $header.Height = 76; $header.BackColor = [System.Drawing.Color]::White
$form.Controls.Add($header)
$title = New-Object System.Windows.Forms.Label
$title.Text = 'SUGRID  服务管理'; $title.Font = New-Object System.Drawing.Font('Segoe UI Semibold', 18); $title.ForeColor = [System.Drawing.Color]::FromArgb(23, 34, 54)
$title.Location = New-Object System.Drawing.Point(24, 15); $title.AutoSize = $true; $header.Controls.Add($title)
$subtitle = New-Object System.Windows.Forms.Label
$subtitle.Text = '本机运维控制台'; $subtitle.ForeColor = [System.Drawing.Color]::FromArgb(99, 111, 130); $subtitle.Location = New-Object System.Drawing.Point(28, 47); $subtitle.AutoSize = $true; $header.Controls.Add($subtitle)

$statusPanel = New-Object System.Windows.Forms.Panel
$statusPanel.Location = New-Object System.Drawing.Point(20, 92); $statusPanel.Size = New-Object System.Drawing.Size(970, 96); $statusPanel.Anchor = 'Top,Left,Right'; $statusPanel.BackColor = [System.Drawing.Color]::White
$form.Controls.Add($statusPanel)
$script:StatusLabel = New-Object System.Windows.Forms.Label
$script:StatusLabel.Text = '正在检查服务'; $script:StatusLabel.Font = New-Object System.Drawing.Font('Segoe UI Semibold', 15); $script:StatusLabel.ForeColor = [System.Drawing.Color]::FromArgb(30, 64, 175)
$script:StatusLabel.Location = New-Object System.Drawing.Point(18, 14); $script:StatusLabel.AutoSize = $true; $statusPanel.Controls.Add($script:StatusLabel)
$script:StatusDetail = New-Object System.Windows.Forms.Label
$script:StatusDetail.Text = ''; $script:StatusDetail.ForeColor = [System.Drawing.Color]::FromArgb(84, 96, 113); $script:StatusDetail.Location = New-Object System.Drawing.Point(20, 49); $script:StatusDetail.AutoSize = $true; $statusPanel.Controls.Add($script:StatusDetail)
$script:OtherServiceLabel = New-Object System.Windows.Forms.Label
$script:OtherServiceLabel.Text = ''; $script:OtherServiceLabel.ForeColor = [System.Drawing.Color]::FromArgb(174, 104, 0); $script:OtherServiceLabel.Location = New-Object System.Drawing.Point(20, 72); $script:OtherServiceLabel.AutoSize = $true; $statusPanel.Controls.Add($script:OtherServiceLabel)
$script:GitLabel = New-Object System.Windows.Forms.Label
$script:GitLabel.Text = 'Git 状态：尚未检查'; $script:GitLabel.ForeColor = [System.Drawing.Color]::FromArgb(84, 96, 113); $script:GitLabel.Location = New-Object System.Drawing.Point(600, 19); $script:GitLabel.AutoSize = $true; $statusPanel.Controls.Add($script:GitLabel)

$configPanel = New-Object System.Windows.Forms.Panel
$configPanel.Location = New-Object System.Drawing.Point(20, 200); $configPanel.Size = New-Object System.Drawing.Size(970, 112); $configPanel.Anchor = 'Top,Left,Right'; $configPanel.BackColor = [System.Drawing.Color]::White
$form.Controls.Add($configPanel)
$configTitle = New-Object System.Windows.Forms.Label
$configTitle.Text = '运行配置'; $configTitle.Font = New-Object System.Drawing.Font('Segoe UI Semibold', 10); $configTitle.Location = New-Object System.Drawing.Point(18, 12); $configTitle.AutoSize = $true; $configPanel.Controls.Add($configTitle)
$rootLabel = New-Object System.Windows.Forms.Label
$rootLabel.Text = "项目目录：$script:ProjectRoot"; $rootLabel.ForeColor = [System.Drawing.Color]::FromArgb(84, 96, 113); $rootLabel.Location = New-Object System.Drawing.Point(20, 39); $rootLabel.AutoSize = $true; $configPanel.Controls.Add($rootLabel)
$portLabel = New-Object System.Windows.Forms.Label
$portLabel.Text = '端口'; $portLabel.Location = New-Object System.Drawing.Point(20, 73); $portLabel.AutoSize = $true; $configPanel.Controls.Add($portLabel)
$script:PortBox = New-Object System.Windows.Forms.TextBox
$script:PortBox.Text = [string]$script:Config.port; $script:PortBox.Location = New-Object System.Drawing.Point(62, 69); $script:PortBox.Size = New-Object System.Drawing.Size(72, 25); $configPanel.Controls.Add($script:PortBox)
$hostLabel = New-Object System.Windows.Forms.Label
$hostLabel.Text = '监听'; $hostLabel.Location = New-Object System.Drawing.Point(154, 73); $hostLabel.AutoSize = $true; $configPanel.Controls.Add($hostLabel)
$script:HostBox = New-Object System.Windows.Forms.ComboBox
$script:HostBox.DropDownStyle = 'DropDownList'; [void]$script:HostBox.Items.Add('0.0.0.0'); [void]$script:HostBox.Items.Add('127.0.0.1'); $script:HostBox.SelectedItem = $script:Config.host
$script:HostBox.Location = New-Object System.Drawing.Point(198, 69); $script:HostBox.Size = New-Object System.Drawing.Size(112, 25); $configPanel.Controls.Add($script:HostBox)
$dbLabel = New-Object System.Windows.Forms.Label
$dbLabel.Text = '数据库'; $dbLabel.Location = New-Object System.Drawing.Point(330, 73); $dbLabel.AutoSize = $true; $configPanel.Controls.Add($dbLabel)
$script:DatabaseBox = New-Object System.Windows.Forms.TextBox
$script:DatabaseBox.Text = $script:Config.databasePath; $script:DatabaseBox.Location = New-Object System.Drawing.Point(382, 69); $script:DatabaseBox.Size = New-Object System.Drawing.Size(445, 25); $script:DatabaseBox.Anchor = 'Top,Left,Right'; $configPanel.Controls.Add($script:DatabaseBox)
$saveButton = New-Object System.Windows.Forms.Button
$saveButton.Text = '保存'; $saveButton.Location = New-Object System.Drawing.Point(844, 67); $saveButton.Size = New-Object System.Drawing.Size(92, 29); $saveButton.Anchor = 'Top,Right'; $configPanel.Controls.Add($saveButton)

$actionPanel = New-Object System.Windows.Forms.Panel
$actionPanel.Location = New-Object System.Drawing.Point(20, 324); $actionPanel.Size = New-Object System.Drawing.Size(970, 160); $actionPanel.Anchor = 'Top,Left,Right'; $actionPanel.BackColor = [System.Drawing.Color]::White
$form.Controls.Add($actionPanel)
$actionTitle = New-Object System.Windows.Forms.Label
$actionTitle.Text = '服务操作'; $actionTitle.Font = New-Object System.Drawing.Font('Segoe UI Semibold', 10); $actionTitle.Location = New-Object System.Drawing.Point(18, 12); $actionTitle.AutoSize = $true; $actionPanel.Controls.Add($actionTitle)
$script:ActionButtons = @{}
function New-ActionButton([string]$Key, [string]$Text, [int]$X, [int]$Y, [int]$Width = 140) {
  $button = New-Object System.Windows.Forms.Button
  $button.Text = $Text; $button.Location = New-Object System.Drawing.Point($X, $Y); $button.Size = New-Object System.Drawing.Size($Width, 36)
  $button.FlatStyle = 'Flat'; $button.FlatAppearance.BorderColor = [System.Drawing.Color]::FromArgb(207, 216, 229)
  $button.BackColor = [System.Drawing.Color]::White; $button.ForeColor = [System.Drawing.Color]::FromArgb(30, 45, 67)
  $actionPanel.Controls.Add($button); $script:ActionButtons[$Key] = $button; return $button
}
$script:ActionButtons.Start = New-ActionButton 'Start' '启动服务' 20 42 120
$script:ActionButtons.Stop = New-ActionButton 'Stop' '停止服务' 148 42 120
$script:ActionButtons.Restart = New-ActionButton 'Restart' '重启服务' 276 42 120
$script:ActionButtons.Adopt = New-ActionButton 'Adopt' '接管 Next 进程' 404 42 150
$script:ActionButtons.Open = New-ActionButton 'Open' '打开业务系统' 562 42 140
$script:ActionButtons.Check = New-ActionButton 'Check' '检查 Git 更新' 710 42 140
$script:ActionButtons.Update = New-ActionButton 'Update' '安全更新并重启' 20 91 150
$script:ActionButtons.Build = New-ActionButton 'Build' '构建并重启' 178 91 140
$script:ActionButtons.Backup = New-ActionButton 'Backup' '备份数据库' 326 91 140
$script:ActionButtons.Init = New-ActionButton 'Init' '初始化数据库' 474 91 140
$script:ActionButtons.Logs = New-ActionButton 'Logs' '打开日志目录' 622 91 140
$script:ActionButtons.Install = New-ActionButton 'Install' '安装依赖' 770 91 140

$logPanel = New-Object System.Windows.Forms.Panel
$logPanel.Location = New-Object System.Drawing.Point(20, 496); $logPanel.Size = New-Object System.Drawing.Size(970, 238); $logPanel.Anchor = 'Top,Bottom,Left,Right'; $logPanel.BackColor = [System.Drawing.Color]::White
$form.Controls.Add($logPanel)
$logTitle = New-Object System.Windows.Forms.Label
$logTitle.Text = '操作记录'; $logTitle.Font = New-Object System.Drawing.Font('Segoe UI Semibold', 10); $logTitle.Location = New-Object System.Drawing.Point(18, 12); $logTitle.AutoSize = $true; $logPanel.Controls.Add($logTitle)
$script:LogBox = New-Object System.Windows.Forms.RichTextBox
$script:LogBox.Location = New-Object System.Drawing.Point(16, 39); $script:LogBox.Size = New-Object System.Drawing.Size(938, 182); $script:LogBox.Anchor = 'Top,Bottom,Left,Right'
$script:LogBox.ReadOnly = $true; $script:LogBox.BorderStyle = 'FixedSingle'; $script:LogBox.BackColor = [System.Drawing.Color]::FromArgb(250, 251, 253)
$script:LogBox.Font = New-Object System.Drawing.Font('Consolas', 9); $logPanel.Controls.Add($script:LogBox)

if (Test-Path $script:ManagerLogPath) {
  $recent = Get-Content $script:ManagerLogPath -Tail 120 -Encoding UTF8
  foreach ($line in $recent) { $script:LogBox.AppendText($line + [Environment]::NewLine) }
}

$script:Timer = New-Object System.Windows.Forms.Timer
$script:Timer.Interval = 2000
$script:Timer.Add_Tick({ Update-ServiceView })

function Set-Busy([bool]$Value) {
  $script:Busy = $Value
  foreach ($button in $script:ActionButtons.Values) { $button.Enabled = -not $Value }
  $saveButton.Enabled = -not $Value
  if ($Value) { $script:StatusLabel.Text = '正在执行维护操作…' }
  else { Update-ServiceView }
}

function Invoke-UiOperation([string]$Name, [scriptblock]$Action) {
  if ($script:Busy) { return }
  try {
    Save-ManagerConfig
    Set-Busy $true
    Add-ManagerLog "开始操作：$Name"
    & $Action
    Add-ManagerLog "操作完成：$Name"
  } catch {
    Add-ManagerLog "操作失败：$($_.Exception.Message)"
    [System.Windows.Forms.MessageBox]::Show($_.Exception.Message, '操作未完成', [System.Windows.Forms.MessageBoxButtons]::OK, [System.Windows.Forms.MessageBoxIcon]::Error) | Out-Null
  } finally { Set-Busy $false }
}

function Update-ServiceView {
  if (-not $script:StatusLabel -or $script:StatusLabel.IsDisposed) { return }
  try { $script:StatusResult = Get-ProjectServiceStatus } catch { $script:StatusResult = [pscustomobject]@{ State = 'Error'; Processes = @(); Healthy = $false } }
  $status = $script:StatusResult
  switch ($status.State) {
    'Running' { $script:StatusLabel.Text = '运行中 · 管理器托管'; $script:StatusLabel.ForeColor = [System.Drawing.Color]::FromArgb(22, 125, 78) }
    'Starting' { $script:StatusLabel.Text = '服务启动中 / 健康检查未通过'; $script:StatusLabel.ForeColor = [System.Drawing.Color]::FromArgb(174, 104, 0) }
    'ExternalProject' { $script:StatusLabel.Text = '运行中 · 外部启动'; $script:StatusLabel.ForeColor = [System.Drawing.Color]::FromArgb(174, 104, 0) }
    'StartingExternal' { $script:StatusLabel.Text = '发现外部服务 · 数据库未核实'; $script:StatusLabel.ForeColor = [System.Drawing.Color]::FromArgb(174, 104, 0) }
    'UnmanagedNext' { $script:StatusLabel.Text = '发现未托管的 Next.js 进程'; $script:StatusLabel.ForeColor = [System.Drawing.Color]::FromArgb(174, 104, 0) }
    'PortConflict' { $script:StatusLabel.Text = '端口被其他程序占用'; $script:StatusLabel.ForeColor = [System.Drawing.Color]::FromArgb(177, 55, 55) }
    default { $script:StatusLabel.Text = '已停止'; $script:StatusLabel.ForeColor = [System.Drawing.Color]::FromArgb(84, 96, 113) }
  }
  $pids = @($status.Processes | ForEach-Object { $_.ProcessId }) -join ', '
  if ($status.State -eq 'PortConflict' -or $status.State -eq 'UnmanagedNext') {
    $command = ($status.Processes | Select-Object -First 1).CommandLine
    $script:StatusDetail.Text = "端口 $($script:Config.port) · PID $pids · $command"
  } elseif ($status.Managed) {
    $script:StatusDetail.Text = "端口 $($script:Config.port) · PID $(if ($pids) { $pids } else { '-' }) · 数据库 $($status.DatabasePath)"
  } elseif ($status.State -in @('ExternalProject', 'StartingExternal')) {
    $script:StatusDetail.Text = "端口 $($script:Config.port) · PID $pids · 实际数据库未核实（设置路径：$($script:Config.databasePath)）"
  } else {
    $script:StatusDetail.Text = "端口 $($script:Config.port) · PID $(if ($pids) { $pids } else { '-' }) · 数据库 $($script:Config.databasePath)"
  }
  $otherServices = @($status.OtherProjectProcesses | ForEach-Object { "端口 $($_.ListeningPorts -join ',') (PID $($_.ProcessId))" })
  $script:OtherServiceLabel.Text = if ($otherServices.Count -gt 0) { "同项目其他服务：$($otherServices -join '；')" } else { '' }
  $script:ActionButtons.Start.Enabled = $status.State -eq 'Stopped'
  $script:ActionButtons.Stop.Enabled = $status.State -in @('Running', 'Starting', 'ExternalProject', 'StartingExternal')
  $script:ActionButtons.Restart.Enabled = $status.State -eq 'Running'
  $script:ActionButtons.Adopt.Enabled = $status.State -in @('UnmanagedNext', 'ExternalProject', 'StartingExternal')
  $script:ActionButtons.Open.Enabled = $status.State -in @('Running', 'ExternalProject')
  $script:ActionButtons.Install.Enabled = $status.State -eq 'Stopped' -and $otherServices.Count -eq 0
}

$saveButton.Add_Click({
  try { Save-ManagerConfig; Update-ServiceView } catch { [System.Windows.Forms.MessageBox]::Show($_.Exception.Message, '配置无效') | Out-Null }
})
$script:ActionButtons.Start.Add_Click({ Invoke-UiOperation '启动服务' { if (-not (Start-ProjectService)) { throw '服务未能启动，请查看日志。' } } })
$script:ActionButtons.Stop.Add_Click({
  $answer = [System.Windows.Forms.MessageBox]::Show("停止端口 $($script:Config.port) 上确认属于本项目的服务？", '确认停止', [System.Windows.Forms.MessageBoxButtons]::YesNo, [System.Windows.Forms.MessageBoxIcon]::Question)
  if ($answer -eq [System.Windows.Forms.DialogResult]::Yes) { Invoke-UiOperation '停止服务' { Stop-ProjectService | Out-Null } }
})
$script:ActionButtons.Restart.Add_Click({ Invoke-UiOperation '重启服务' { if (-not (Stop-ProjectService)) { throw '服务停止失败。' }; if (-not (Start-ProjectService)) { throw '服务未能重启，请查看日志。' } } })
$script:ActionButtons.Adopt.Add_Click({
  $processInfo = $script:StatusResult.Processes | Select-Object -First 1
  $answer = [System.Windows.Forms.MessageBox]::Show("端口上的 Next.js 进程无法从命令行确认项目目录。接管会停止 PID $($processInfo.ProcessId)，再使用上方显示的数据库路径启动本项目。请先核对数据库路径。`n`n是否继续？", '确认接管', [System.Windows.Forms.MessageBoxButtons]::YesNo, [System.Windows.Forms.MessageBoxIcon]::Warning)
  if ($answer -eq [System.Windows.Forms.DialogResult]::Yes) {
    Invoke-UiOperation '接管 Next.js 进程' {
      Stop-Process -Id $processInfo.ProcessId -ErrorAction Stop
      Start-Sleep -Milliseconds 500
      if ((Get-ProjectServiceStatus).State -ne 'Stopped') { throw '原 Next.js 进程仍占用端口，未启动新服务。' }
      if (-not (Start-ProjectService)) { throw '接管已停止原进程，但新服务未能启动。请查看日志。' }
    }
  }
})
$script:ActionButtons.Open.Add_Click({ Start-Process "http://127.0.0.1:$($script:Config.port)" })
$script:ActionButtons.Logs.Add_Click({ Start-Process explorer.exe $script:LogRoot })
$script:ActionButtons.Backup.Add_Click({ Invoke-UiOperation '备份数据库' { Invoke-DatabaseBackup | Out-Null } })
$script:ActionButtons.Install.Add_Click({
  $answer = [System.Windows.Forms.MessageBox]::Show('安装依赖会按 package-lock.json 重新安装 node_modules，并要求本项目所有端口的服务均已停止。是否继续？', '确认安装依赖', [System.Windows.Forms.MessageBoxButtons]::YesNo, [System.Windows.Forms.MessageBoxIcon]::Question)
  if ($answer -eq [System.Windows.Forms.DialogResult]::Yes) { Invoke-UiOperation '安装依赖' { Invoke-DependencyInstall } }
})
$script:ActionButtons.Init.Add_Click({
  $answer = [System.Windows.Forms.MessageBox]::Show("数据库初始化会应用项目迁移。操作前会自动备份数据库。`n`n数据库：$($script:Config.databasePath)`n`n是否继续？", '确认初始化数据库', [System.Windows.Forms.MessageBoxButtons]::YesNo, [System.Windows.Forms.MessageBoxIcon]::Warning)
  if ($answer -eq [System.Windows.Forms.DialogResult]::Yes) { Invoke-UiOperation '初始化数据库' { Invoke-DatabaseInitialization } }
})
$script:ActionButtons.Build.Add_Click({
  $answer = [System.Windows.Forms.MessageBox]::Show("构建时会短暂停止正在运行的服务，并在数据库迁移前自动备份。`n`n数据库：$($script:Config.databasePath)`n`n是否继续？", '确认构建并重启', [System.Windows.Forms.MessageBoxButtons]::YesNo, [System.Windows.Forms.MessageBoxIcon]::Question)
  if ($answer -eq [System.Windows.Forms.DialogResult]::Yes) { Invoke-UiOperation '构建并重启' { Invoke-BuildAndRestart } }
})
$script:ActionButtons.Check.Add_Click({
  Invoke-UiOperation '检查 Git 更新' {
    $snapshot = Get-GitSnapshot
    $script:GitLabel.Text = "Git：$($snapshot.Branch) · ahead $($snapshot.Ahead) / behind $($snapshot.Behind) · $($snapshot.Decision.state)"
    Add-ManagerLog "Git 结论：$($snapshot.Decision.reason)"
    foreach ($line in $snapshot.DirtyLines) { Add-ManagerLog "本地文件：$line" }
  }
})
$script:ActionButtons.Update.Add_Click({ Invoke-UiOperation '安全 Git 更新' { Invoke-SafeUpdate } })

$form.Add_FormClosing({
  if ($script:Busy) {
    $_.Cancel = $true
    [System.Windows.Forms.MessageBox]::Show('维护操作尚未结束。等待操作完成后再关闭管理器；项目服务可在操作完成后独立运行。', '操作进行中') | Out-Null
  }
})

Update-ServiceView
$script:Timer.Start()
$startupPids = @($script:StatusResult.Processes | ForEach-Object { $_.ProcessId }) -join ', '
if ($script:StatusResult.Managed) {
  Add-ManagerLog "管理器已打开：检测到托管服务 $($script:StatusResult.State)，PID $startupPids，端口 $($script:Config.port)，数据库 $($script:StatusResult.DatabasePath)"
} elseif ($script:StatusResult.State -in @('ExternalProject', 'StartingExternal')) {
  Add-ManagerLog "管理器已打开：检测到外部项目服务，PID $startupPids，端口 $($script:Config.port)，实际数据库未核实。"
} else {
  Add-ManagerLog "管理器已打开：端口 $($script:Config.port)，当前状态 $($script:StatusResult.State)，设置数据库 $($script:Config.databasePath)"
}
[void]$form.ShowDialog()
