use rusqlite::{Connection, OpenFlags, backup::Backup};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeSet,
    ffi::OsStr,
    fs::{self, File, OpenOptions},
    io::Read,
    net::{TcpStream, ToSocketAddrs},
    path::{Path, PathBuf},
    process::{Child, Command, ExitStatus, Stdio},
    sync::{Arc, Mutex, MutexGuard},
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder};

type AppResult<T> = Result<T, String>;

fn hidden_command(program: impl AsRef<OsStr>) -> Command {
    let mut command = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(windows_sys::Win32::System::Threading::CREATE_NO_WINDOW);
    }
    command
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppConfig {
    pub project_root: String,
    pub database_path: String,
    pub port: u16,
    pub host: String,
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            project_root: String::new(),
            database_path: "data/inventory.db".into(),
            port: 3000,
            host: "0.0.0.0".into(),
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OperationLog {
    pub timestamp: u64,
    pub action: String,
    pub success: bool,
    pub detail: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceProcess {
    pub process_id: u32,
    pub parent_process_id: Option<u32>,
    pub source: String,
    pub state: String,
    pub port: u16,
    pub started_at: String,
    pub executable_path: String,
    pub command_line: String,
    pub managed: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceSnapshot {
    pub configured: bool,
    pub scan_complete: bool,
    pub running: bool,
    pub healthy: bool,
    pub url: String,
    pub message: String,
    pub processes: Vec<ServiceProcess>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitSnapshot {
    pub available: bool,
    pub branch: String,
    pub commit: String,
    pub clean: bool,
    pub dirty_paths: Vec<String>,
    pub ahead: usize,
    pub behind: usize,
    pub remote_matches: bool,
    pub can_update: bool,
    pub state: String,
    pub message: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupItem {
    pub path: String,
    pub name: String,
    pub size: u64,
    pub modified_at: u64,
    pub verified: bool,
    pub detail: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseSnapshot {
    pub path: String,
    pub exists: bool,
    pub integrity: String,
    pub foreign_key_violations: u64,
    pub message: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticItem {
    pub label: String,
    pub state: String,
    pub detail: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Dashboard {
    pub config: AppConfig,
    pub configured: bool,
    pub service: ServiceSnapshot,
    pub git: GitSnapshot,
    pub database: DatabaseSnapshot,
    pub backups: Vec<BackupItem>,
    pub logs: Vec<OperationLog>,
    pub diagnostics: Vec<DiagnosticItem>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateProgress {
    pub key: String,
    pub state: String,
    pub detail: String,
}

struct ManagedService {
    child: Option<Child>,
    process_id: u32,
    process_creation_time: u64,
    started_at: u64,
    project_root: PathBuf,
    database_path: PathBuf,
    port: u16,
    log_path: PathBuf,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ManagedServiceRecord {
    process_id: u32,
    process_creation_time: u64,
    started_at: u64,
    project_root: PathBuf,
    database_path: PathBuf,
    port: u16,
    log_path: PathBuf,
}

impl From<&ManagedService> for ManagedServiceRecord {
    fn from(service: &ManagedService) -> Self {
        Self {
            process_id: service.process_id,
            process_creation_time: service.process_creation_time,
            started_at: service.started_at,
            project_root: service.project_root.clone(),
            database_path: service.database_path.clone(),
            port: service.port,
            log_path: service.log_path.clone(),
        }
    }
}

impl From<ManagedServiceRecord> for ManagedService {
    fn from(record: ManagedServiceRecord) -> Self {
        Self {
            child: None,
            process_id: record.process_id,
            process_creation_time: record.process_creation_time,
            started_at: record.started_at,
            project_root: record.project_root,
            database_path: record.database_path,
            port: record.port,
            log_path: record.log_path,
        }
    }
}

pub struct ManagerState {
    config_path: PathBuf,
    managed_service_path: PathBuf,
    log_path: PathBuf,
    config: Mutex<AppConfig>,
    managed_service: Mutex<Option<ManagedService>>,
    logs: Mutex<Vec<OperationLog>>,
}

impl ManagerState {
    pub fn load(config_path: PathBuf, log_path: PathBuf) -> Self {
        let config = fs::read_to_string(&config_path)
            .ok()
            .and_then(|text| serde_json::from_str(&text).ok())
            .unwrap_or_default();
        let logs = fs::read_to_string(&log_path)
            .unwrap_or_default()
            .lines()
            .filter_map(|line| serde_json::from_str::<OperationLog>(line).ok())
            .rev()
            .take(200)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect();
        let managed_service_path = config_path.with_file_name("managed-service.json");
        let managed_service = fs::read_to_string(&managed_service_path)
            .ok()
            .and_then(|text| serde_json::from_str::<ManagedServiceRecord>(&text).ok())
            .map(ManagedService::from);
        Self {
            config_path,
            managed_service_path,
            log_path,
            config: Mutex::new(config),
            managed_service: Mutex::new(managed_service),
            logs: Mutex::new(logs),
        }
    }

    fn config(&self) -> AppConfig {
        lock(&self.config).clone()
    }

    fn record(&self, action: &str, success: bool, detail: impl Into<String>) {
        let item = OperationLog {
            timestamp: now_millis(),
            action: action.into(),
            success,
            detail: detail.into(),
        };
        if let Ok(line) = serde_json::to_string(&item) {
            if let Some(parent) = self.log_path.parent() {
                let _ = fs::create_dir_all(parent);
            }
            if let Ok(mut file) = OpenOptions::new()
                .create(true)
                .append(true)
                .open(&self.log_path)
            {
                use std::io::Write;
                let _ = writeln!(file, "{line}");
            }
        }
        let mut logs = lock(&self.logs);
        logs.push(item);
        if logs.len() > 200 {
            let excess = logs.len() - 200;
            logs.drain(0..excess);
        }
    }

    fn recent_logs(&self) -> Vec<OperationLog> {
        lock(&self.logs).iter().rev().cloned().collect()
    }

    fn persist_managed_service(&self, service: Option<&ManagedService>) -> AppResult<()> {
        if let Some(service) = service {
            let contents = serde_json::to_vec(&ManagedServiceRecord::from(service))
                .map_err(|error| format!("保存服务身份失败：{error}"))?;
            if let Some(parent) = self.managed_service_path.parent() {
                fs::create_dir_all(parent).map_err(|error| error.to_string())?;
            }
            fs::write(&self.managed_service_path, contents)
                .map_err(|error| format!("写入服务身份文件失败：{error}"))?;
        } else if self.managed_service_path.exists() {
            fs::remove_file(&self.managed_service_path)
                .map_err(|error| format!("清除服务身份文件失败：{error}"))?;
        }
        Ok(())
    }
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn configured_root(config: &AppConfig) -> AppResult<PathBuf> {
    let raw = config.project_root.trim();
    if raw.is_empty() {
        return Err("请先在“设置”中选择库存项目目录。".into());
    }
    let root = PathBuf::from(raw)
        .canonicalize()
        .map_err(|error| format!("项目目录不可访问：{error}"))?;
    if !root.join("package.json").is_file() || !root.join(".git").exists() {
        return Err("项目目录必须同时包含 package.json 和 Git 仓库。".into());
    }
    Ok(root)
}

fn resolved_database(config: &AppConfig, root: &Path) -> AppResult<PathBuf> {
    let input = config.database_path.trim();
    if input.is_empty() {
        return Err("请填写数据库文件路径。".into());
    }
    let path = PathBuf::from(input);
    let joined = if path.is_absolute() {
        path
    } else {
        root.join(path)
    };
    if joined.exists() && joined.is_dir() {
        return Err("数据库路径指向目录，不是 SQLite 文件。".into());
    }
    let parent = joined.parent().ok_or("数据库路径无效。")?;
    let name = joined.file_name().ok_or("数据库路径无效。")?;
    let canonical_parent = parent
        .canonicalize()
        .map_err(|error| format!("数据库目录不可访问：{error}"))?;
    Ok(canonical_parent.join(name))
}

fn normalize_config(mut config: AppConfig) -> AppResult<AppConfig> {
    if config.port == 0 {
        return Err("服务端口必须在 1 到 65535 之间。".into());
    }
    if config.host != "0.0.0.0" && config.host != "127.0.0.1" {
        return Err("监听地址只能使用 0.0.0.0 或 127.0.0.1。".into());
    }
    let root = configured_root(&config)?;
    let database = resolved_database(&config, &root)?;
    config.project_root = root.to_string_lossy().into_owned();
    config.database_path = database.to_string_lossy().into_owned();
    Ok(config)
}

fn is_configured(config: &AppConfig) -> bool {
    configured_root(config).is_ok()
}

fn database_snapshot(config: &AppConfig) -> DatabaseSnapshot {
    let root = match configured_root(config) {
        Ok(root) => root,
        Err(error) => {
            return DatabaseSnapshot {
                path: String::new(),
                exists: false,
                integrity: "unknown".into(),
                foreign_key_violations: 0,
                message: error,
            };
        }
    };
    let path = match resolved_database(config, &root) {
        Ok(path) => path,
        Err(error) => {
            return DatabaseSnapshot {
                path: config.database_path.clone(),
                exists: false,
                integrity: "unknown".into(),
                foreign_key_violations: 0,
                message: error,
            };
        }
    };
    if !path.is_file() {
        return DatabaseSnapshot {
            path: path.to_string_lossy().into_owned(),
            exists: false,
            integrity: "missing".into(),
            foreign_key_violations: 0,
            message: "未找到数据库文件。".into(),
        };
    }
    match inspect_database(&path) {
        Ok((integrity, violations)) => DatabaseSnapshot {
            path: path.to_string_lossy().into_owned(),
            exists: true,
            integrity: integrity.clone(),
            foreign_key_violations: violations,
            message: if integrity == "ok" && violations == 0 {
                "完整性与外键检查通过。".into()
            } else {
                "数据库检查发现问题，请先备份并调查。".into()
            },
        },
        Err(error) => DatabaseSnapshot {
            path: path.to_string_lossy().into_owned(),
            exists: true,
            integrity: "error".into(),
            foreign_key_violations: 0,
            message: error,
        },
    }
}

fn inspect_database(path: &Path) -> AppResult<(String, u64)> {
    let connection = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|error| format!("打开 SQLite 失败：{error}"))?;
    let integrity: String = connection
        .query_row("PRAGMA integrity_check", [], |row| row.get(0))
        .map_err(|error| format!("完整性检查失败：{error}"))?;
    let mut statement = connection
        .prepare("PRAGMA foreign_key_check")
        .map_err(|error| format!("外键检查失败：{error}"))?;
    let mut rows = statement.query([]).map_err(|error| error.to_string())?;
    let mut violations = 0;
    while rows.next().map_err(|error| error.to_string())?.is_some() {
        violations += 1;
    }
    Ok((integrity, violations))
}

fn online_backup(source_path: &Path, destination_path: &Path) -> AppResult<()> {
    let source = Connection::open_with_flags(
        source_path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_FULL_MUTEX,
    )
    .map_err(|error| format!("打开源数据库失败：{error}"))?;
    let mut destination =
        Connection::open(destination_path).map_err(|error| format!("创建备份文件失败：{error}"))?;
    let backup = Backup::new(&source, &mut destination).map_err(|error| error.to_string())?;
    backup
        .run_to_completion(128, Duration::from_millis(25), None)
        .map_err(|error| format!("SQLite 在线备份失败：{error}"))?;
    drop(backup);
    destination
        .close()
        .map_err(|(_, error)| error.to_string())?;
    let (integrity, violations) = inspect_database(destination_path)?;
    if integrity != "ok" || violations > 0 {
        return Err(format!(
            "备份检查失败：integrity_check={integrity}，foreign_key_check={violations} 条。"
        ));
    }
    Ok(())
}

fn backup_directory(database_path: &Path) -> AppResult<PathBuf> {
    let parent = database_path.parent().ok_or("数据库路径无效。")?;
    Ok(parent.join("backups"))
}

fn create_backup_file(database_path: &Path) -> AppResult<PathBuf> {
    if !database_path.is_file() {
        return Err(format!("数据库文件不存在：{}", database_path.display()));
    }
    let directory = backup_directory(database_path)?;
    fs::create_dir_all(&directory).map_err(|error| format!("创建备份目录失败：{error}"))?;
    let stem = database_path
        .file_stem()
        .unwrap_or_default()
        .to_string_lossy();
    let mut suffix = 0_u32;
    let destination = loop {
        let candidate = if suffix == 0 {
            directory.join(format!("{stem}.before-manager-{}.db", now_millis()))
        } else {
            directory.join(format!(
                "{stem}.before-manager-{}-{suffix}.db",
                now_millis()
            ))
        };
        if !candidate.exists() {
            break candidate;
        }
        suffix += 1;
    };
    if let Err(error) = online_backup(database_path, &destination) {
        let _ = fs::remove_file(&destination);
        return Err(error);
    }
    Ok(destination)
}

fn list_backup_files(database_path: &Path) -> Vec<BackupItem> {
    let Ok(directory) = backup_directory(database_path) else {
        return Vec::new();
    };
    let stem = database_path
        .file_stem()
        .unwrap_or_default()
        .to_string_lossy();
    let prefix = format!("{stem}.before-manager-");
    let mut items = fs::read_dir(directory)
        .ok()
        .into_iter()
        .flatten()
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let path = entry.path();
            let name = path.file_name()?.to_string_lossy().to_string();
            if !path.is_file()
                || !name.starts_with(&prefix)
                || path.extension().is_none_or(|ext| ext != "db")
            {
                return None;
            }
            let metadata = entry.metadata().ok()?;
            let modified_at = metadata
                .modified()
                .ok()?
                .duration_since(UNIX_EPOCH)
                .ok()?
                .as_millis() as u64;
            let verified = inspect_database(&path)
                .is_ok_and(|(integrity, violations)| integrity == "ok" && violations == 0);
            Some(BackupItem {
                path: path.to_string_lossy().into_owned(),
                name,
                size: metadata.len(),
                modified_at,
                verified,
                detail: if verified {
                    "完整性与外键检查通过".into()
                } else {
                    "无法通过完整性或外键检查".into()
                },
            })
        })
        .collect::<Vec<_>>();
    items.sort_by_key(|item| std::cmp::Reverse(item.modified_at));
    items
}

fn validate_restore_target(database_path: &Path, backup_path: &Path) -> AppResult<PathBuf> {
    let directory = backup_directory(database_path)?
        .canonicalize()
        .map_err(|error| format!("备份目录不可访问：{error}"))?;
    let backup = backup_path
        .canonicalize()
        .map_err(|error| format!("备份文件不可访问：{error}"))?;
    if backup.parent() != Some(directory.as_path()) {
        return Err("恢复文件必须来自当前数据库的本机备份目录。".into());
    }
    let stem = database_path
        .file_stem()
        .unwrap_or_default()
        .to_string_lossy();
    let name = backup.file_name().unwrap_or_default().to_string_lossy();
    if !name.starts_with(&format!("{stem}.before-manager-"))
        || backup.extension().is_none_or(|ext| ext != "db")
    {
        return Err("备份文件与当前数据库不匹配。".into());
    }
    let (integrity, violations) = inspect_database(&backup)?;
    if integrity != "ok" || violations > 0 {
        return Err(format!(
            "备份无法恢复：integrity_check={integrity}，foreign_key_check={violations} 条。"
        ));
    }
    Ok(backup)
}

#[cfg(test)]
fn replace_database(database_path: &Path, backup_path: &Path) -> AppResult<PathBuf> {
    replace_database_with_guard(database_path, backup_path, || Ok(()))
}

fn replace_database_with_guard(
    database_path: &Path,
    backup_path: &Path,
    before_replace: impl FnOnce() -> AppResult<()>,
) -> AppResult<PathBuf> {
    let temporary = database_path.with_file_name(format!("restore-{}.tmp", now_millis()));
    online_backup(backup_path, &temporary)?;
    let (integrity, violations) = inspect_database(&temporary)?;
    if integrity != "ok" || violations > 0 {
        let _ = fs::remove_file(&temporary);
        return Err("临时恢复文件未通过完整性与外键检查，原数据库保持不变。".into());
    }
    if let Err(error) = before_replace() {
        let _ = fs::remove_file(&temporary);
        return Err(error);
    }
    let rollback = database_path.with_file_name(format!("restore-rollback-{}.db", now_millis()));
    let wal_path = sidecar_path(database_path, "-wal");
    let shm_path = sidecar_path(database_path, "-shm");
    let wal_backup = sidecar_path(&rollback, "-wal");
    let shm_backup = sidecar_path(&rollback, "-shm");
    let had_wal = wal_path.exists();
    let had_shm = shm_path.exists();
    fs::rename(database_path, &rollback).map_err(|error| {
        let _ = fs::remove_file(&temporary);
        format!("数据库文件仍被占用，无法安全替换：{error}")
    })?;
    if had_wal {
        if let Err(error) = fs::rename(&wal_path, &wal_backup) {
            let _ = fs::rename(&rollback, database_path);
            let _ = fs::remove_file(&temporary);
            return Err(format!("无法隔离 SQLite WAL 文件，已保留原数据库：{error}"));
        }
    }
    if had_shm {
        if let Err(error) = fs::rename(&shm_path, &shm_backup) {
            let _ = fs::rename(&rollback, database_path);
            if had_wal {
                let _ = fs::rename(&wal_backup, &wal_path);
            }
            let _ = fs::remove_file(&temporary);
            return Err(format!("无法隔离 SQLite SHM 文件，已保留原数据库：{error}"));
        }
    }
    if let Err(error) = fs::rename(&temporary, database_path) {
        let _ = fs::rename(&rollback, database_path);
        if had_wal {
            let _ = fs::rename(&wal_backup, &wal_path);
        }
        if had_shm {
            let _ = fs::rename(&shm_backup, &shm_path);
        }
        let _ = fs::remove_file(&temporary);
        return Err(format!("替换数据库失败，原数据库已恢复：{error}"));
    }
    let _ = fs::remove_file(rollback);
    let _ = fs::remove_file(wal_backup);
    let _ = fs::remove_file(shm_backup);
    Ok(database_path.to_path_buf())
}

fn restore_database_with_process_check(
    database_path: &Path,
    backup_path: &Path,
    project_root: &Path,
    configured_port: u16,
    mut scan_processes: impl FnMut(&Path, u16) -> AppResult<Vec<ServiceProcess>>,
) -> AppResult<PathBuf> {
    let processes = scan_processes(project_root, configured_port)?;
    if let Some(reason) = restore_blocked_by_processes(&processes) {
        return Err(reason);
    }

    let backup = validate_restore_target(database_path, backup_path)?;
    let safety = create_backup_file(database_path)?;

    replace_database_with_guard(database_path, &backup, || {
        let processes = scan_processes(project_root, configured_port)
            .map_err(|error| format!("替换前再次核验服务进程失败：{error}"))?;
        if let Some(reason) = restore_blocked_by_processes(&processes) {
            return Err(reason);
        }
        Ok(())
    })
    .map_err(|error| format!("{error} 恢复前备份保留于 {}。", safety.display()))?;
    Ok(safety)
}

fn sidecar_path(path: &Path, suffix: &str) -> PathBuf {
    PathBuf::from(format!("{}{}", path.to_string_lossy(), suffix))
}

fn listening_endpoints() -> AppResult<Vec<(u16, u32)>> {
    let script = r#"$ErrorActionPreference = 'Stop'; try { $rows = @(Get-NetTCPConnection -State Listen -ErrorAction Stop | Select-Object LocalPort,OwningProcess); $json = ConvertTo-Json -InputObject @($rows) -Compress; [Console]::Out.Write($json) } catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }"#;
    let output = hidden_command("powershell.exe")
        .args([
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            script,
        ])
        .output()
        .map_err(|error| format!("读取本机监听端口失败：{error}"))?;
    if !output.status.success() {
        return Err(format!(
            "无法完整读取本机 TCP 监听端口：{}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    parse_listening_endpoints(&output.stdout)
}

fn parse_listening_endpoints(stdout: &[u8]) -> AppResult<Vec<(u16, u32)>> {
    let value = serde_json::from_slice::<serde_json::Value>(stdout)
        .map_err(|error| format!("解析 TCP 监听端口失败：{error}"))?;
    let entries = match value {
        serde_json::Value::Array(entries) => entries,
        serde_json::Value::Null => Vec::new(),
        entry => vec![entry],
    };
    let mut endpoints = BTreeSet::new();
    for entry in entries {
        let port = entry
            .get("LocalPort")
            .and_then(serde_json::Value::as_u64)
            .and_then(|value| u16::try_from(value).ok())
            .filter(|value| *value > 0)
            .ok_or("监听端口清单中包含无效端口，扫描未完成。")?;
        let process_id = entry
            .get("OwningProcess")
            .and_then(serde_json::Value::as_u64)
            .and_then(|value| u32::try_from(value).ok())
            .filter(|value| *value > 0)
            .ok_or("监听端口清单中包含无效 PID，扫描未完成。")?;
        endpoints.insert((port, process_id));
    }
    Ok(endpoints.into_iter().collect())
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "PascalCase")]
struct ProcessDetails {
    name: Option<String>,
    process_id: Option<u32>,
    parent_process_id: Option<u32>,
    creation_date: Option<String>,
    executable_path: Option<String>,
    command_line: Option<String>,
}

fn all_process_details_checked() -> AppResult<std::collections::HashMap<u32, ProcessDetails>> {
    let script = r#"$OutputEncoding = New-Object System.Text.UTF8Encoding; [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding; $ErrorActionPreference = 'Stop'; try { $p = @(Get-CimInstance Win32_Process -ErrorAction Stop | Select-Object Name,ProcessId,ParentProcessId,CreationDate,ExecutablePath,CommandLine); if ($p.Count -eq 0) { throw '进程清单为空' }; ConvertTo-Json -InputObject @($p) -Compress -Depth 4 } catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }"#;
    let output = hidden_command("powershell.exe")
        .args([
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            script,
        ])
        .output();
    let output = output.map_err(|error| format!("读取进程信息失败：{error}"))?;
    if !output.status.success() {
        return Err("读取进程信息命令执行失败。".into());
    }
    parse_process_details(&output.stdout)
}

fn parse_process_details(
    stdout: &[u8],
) -> AppResult<std::collections::HashMap<u32, ProcessDetails>> {
    let value = serde_json::from_slice::<serde_json::Value>(stdout)
        .map_err(|error| format!("解析进程信息失败：{error}"))?;
    let entries = match value {
        serde_json::Value::Array(entries) => entries,
        serde_json::Value::Null => Vec::new(),
        entry => vec![entry],
    };
    if entries.is_empty() {
        return Err("进程清单为空，扫描未完成。".into());
    }
    let mut processes = std::collections::HashMap::with_capacity(entries.len());
    for entry in entries {
        let details = serde_json::from_value::<ProcessDetails>(entry)
            .map_err(|error| format!("解析单条进程记录失败，扫描未完成：{error}"))?;
        let process_id = details
            .process_id
            .ok_or("进程清单中包含无效 PID，扫描未完成。")?;
        if processes.insert(process_id, details).is_some() {
            return Err(format!("进程清单中的 PID {process_id} 重复，扫描未完成。"));
        }
    }
    Ok(processes)
}

fn is_project_candidate(details: Option<&ProcessDetails>, project_root: &Path) -> bool {
    let Some(command_line) = details.and_then(|details| details.command_line.as_deref()) else {
        return false;
    };
    let command = command_line.replace('/', "\\").to_ascii_lowercase();
    let root = project_root
        .to_string_lossy()
        .replace('/', "\\")
        .to_ascii_lowercase();
    let expected_cli = format!(
        "{}\\node_modules\\next\\dist\\bin\\next",
        root.trim_end_matches('\\')
    );
    command.contains(&expected_cli)
        || canonical_next_cli_is_within_project(command_line, project_root)
}

fn is_node_process(details: &ProcessDetails) -> bool {
    let executable = details
        .executable_path
        .as_deref()
        .unwrap_or_default()
        .replace('/', "\\")
        .to_ascii_lowercase();
    details
        .name
        .as_deref()
        .is_some_and(|name| name.eq_ignore_ascii_case("node.exe"))
        || executable.ends_with("\\node.exe")
        || executable.eq_ignore_ascii_case("node.exe")
        || details
            .command_line
            .as_deref()
            .is_some_and(|command| command.to_ascii_lowercase().contains("node.exe"))
}

fn next_service_subcommand(command_line: &str) -> Option<&'static str> {
    let command = command_line.replace('/', "\\").to_ascii_lowercase();
    let markers = [
        "node_modules\\next\\dist\\bin\\next",
        "node_modules\\.bin\\next",
    ];
    for marker in markers {
        if let Some(index) = command.find(marker) {
            let rest = command[index + marker.len()..]
                .strip_prefix('"')
                .unwrap_or(&command[index + marker.len()..])
                .trim_start();
            let subcommand = rest.split_whitespace().next()?.trim_matches('"');
            return match subcommand {
                "start" => Some("start"),
                "dev" => Some("dev"),
                _ => None,
            };
        }
    }
    let tokens = command.split_whitespace().collect::<Vec<_>>();
    tokens.windows(2).find_map(|pair| {
        if pair[0].trim_matches('"') == "next" {
            match pair[1].trim_matches('"') {
                "start" => Some("start"),
                "dev" => Some("dev"),
                _ => None,
            }
        } else {
            None
        }
    })
}

fn next_service_port(command_line: &str) -> Option<u16> {
    let tokens = command_line.split_whitespace().collect::<Vec<_>>();
    for (index, token) in tokens.iter().enumerate() {
        let token = token.trim_matches('"');
        if let Some(value) = token.strip_prefix("--port=") {
            if let Ok(port) = value.parse() {
                return Some(port);
            }
        }
        if matches!(token, "--port" | "-p") {
            return tokens
                .get(index + 1)
                .and_then(|value| value.trim_matches('"').parse().ok());
        }
    }
    None
}

fn next_service_uses_port(command_line: &str, port: u16) -> bool {
    next_service_subcommand(command_line).is_some()
        && next_service_port(command_line).unwrap_or(3000) == port
}

fn is_next_service_command(command_line: &str) -> bool {
    next_service_subcommand(command_line).is_some()
}

fn next_cli_path(command_line: &str) -> Option<PathBuf> {
    let command = command_line.replace('/', "\\");
    let normalized = command.to_ascii_lowercase();
    let marker = "node_modules\\next\\dist\\bin\\next";
    let marker_index = normalized.find(marker)?;
    let mut token_start = 0;
    let mut quoted = false;
    let mut quoted_token_start = None;
    for (index, character) in command[..marker_index].char_indices() {
        match character {
            '"' if quoted => {
                quoted = false;
                quoted_token_start = None;
            }
            '"' => {
                quoted = true;
                quoted_token_start = Some(index + character.len_utf8());
            }
            _ if character.is_whitespace() && !quoted => {
                token_start = index + character.len_utf8();
                quoted_token_start = None;
            }
            _ => {}
        }
    }
    let start = quoted_token_start.unwrap_or(token_start);
    Some(PathBuf::from(&command[start..marker_index + marker.len()]))
}

fn canonical_next_cli_is_within_project(command_line: &str, project_root: &Path) -> bool {
    let Some(cli_path) = next_cli_path(command_line) else {
        return false;
    };
    let Ok(cli_path) = cli_path.canonicalize() else {
        return false;
    };
    let root = project_root
        .canonicalize()
        .unwrap_or_else(|_| project_root.to_path_buf());
    let cli = cli_path
        .to_string_lossy()
        .replace('/', "\\")
        .to_ascii_lowercase();
    let root = root
        .to_string_lossy()
        .replace('/', "\\")
        .to_ascii_lowercase()
        .trim_end_matches('\\')
        .to_string();
    cli == root || cli.starts_with(&format!("{root}\\"))
}

fn is_unverified_node_listener(details: Option<&ProcessDetails>) -> bool {
    let Some(details) = details else {
        return false;
    };
    if !is_node_process(details) {
        return false;
    }
    let Some(command_line) = details
        .command_line
        .as_deref()
        .filter(|command| !command.trim().is_empty())
    else {
        return true;
    };
    is_next_service_command(command_line)
        && next_cli_path(command_line)
            .is_none_or(|path| !path.is_absolute() || path.canonicalize().is_err())
}

fn process_identity_unavailable(details: Option<&ProcessDetails>) -> bool {
    let Some(details) = details else {
        return true;
    };
    if details.name.as_deref().is_some_and(|name| {
        ["system", "registry", "secure system", "memory compression"]
            .iter()
            .any(|known| name.eq_ignore_ascii_case(known))
    }) {
        return false;
    }
    let has_executable = details
        .executable_path
        .as_deref()
        .is_some_and(|path| !path.trim().is_empty());
    let has_command = details
        .command_line
        .as_deref()
        .is_some_and(|command| !command.trim().is_empty());
    let node_command_unavailable = is_node_process(details) && !has_command;
    node_command_unavailable || (!has_executable && !has_command)
}

fn is_managed_process_candidate(
    details: Option<&ProcessDetails>,
    project_root: &Path,
    port: u16,
) -> bool {
    let Some(details) = details else { return false };
    let executable = details
        .executable_path
        .as_deref()
        .unwrap_or_default()
        .replace('/', "\\")
        .to_ascii_lowercase();
    let command_line = details
        .command_line
        .as_deref()
        .unwrap_or_default()
        .replace('/', "\\")
        .to_ascii_lowercase();
    executable.ends_with("\\node.exe")
        && is_project_candidate(Some(details), project_root)
        && command_line.contains(&format!("--port {port}"))
}

fn is_stoppable_external_service(
    details: Option<&ProcessDetails>,
    project_root: &Path,
    expected_started_at: &str,
    expected_port: u16,
    listeners: &[(u16, u32)],
) -> bool {
    let Some(details) = details else {
        return false;
    };
    if expected_started_at.is_empty()
        || expected_started_at == "未知"
        || details.creation_date.as_deref() != Some(expected_started_at)
        || !is_node_process(details)
        || !is_project_candidate(Some(details), project_root)
    {
        return false;
    }
    details.command_line.as_deref().is_some_and(|command_line| {
        next_service_uses_port(command_line, expected_port)
            && listeners
                .iter()
                .any(|(port, pid)| *port == expected_port && Some(*pid) == details.process_id)
    })
}

#[cfg(windows)]
fn terminate_external_service_checked(
    process_id: u32,
    port: u16,
    project_root: &Path,
    expected_started_at: &str,
) -> AppResult<()> {
    use windows_sys::Win32::{
        Foundation::{CloseHandle, FILETIME, WAIT_OBJECT_0},
        System::Threading::{
            GetProcessTimes, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE,
            PROCESS_TERMINATE, TerminateProcess, WaitForSingleObject,
        },
    };

    unsafe {
        let access = PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_TERMINATE | PROCESS_SYNCHRONIZE;
        let handle = OpenProcess(access, 0, process_id);
        if handle.is_null() {
            return Err(format!(
                "无法安全打开 PID {process_id}：{}",
                std::io::Error::last_os_error()
            ));
        }
        let mut created = FILETIME::default();
        let mut exited = FILETIME::default();
        let mut kernel = FILETIME::default();
        let mut user = FILETIME::default();
        if GetProcessTimes(handle, &mut created, &mut exited, &mut kernel, &mut user) == 0 {
            let error = std::io::Error::last_os_error();
            CloseHandle(handle);
            return Err(format!("无法核验 PID {process_id} 的启动时间：{error}"));
        }
        let opened_creation_time =
            ((created.dwHighDateTime as u64) << 32) | created.dwLowDateTime as u64;

        let details = match all_process_details_checked() {
            Ok(details) => details,
            Err(error) => {
                CloseHandle(handle);
                return Err(format!("无法完整复核进程清单，拒绝停止：{error}"));
            }
        };
        let listeners = match listening_endpoints() {
            Ok(listeners) => listeners,
            Err(error) => {
                CloseHandle(handle);
                return Err(format!(
                    "无法确认 PID {process_id} 是否仍监听端口 {port}：{error}"
                ));
            }
        };
        if !is_stoppable_external_service(
            details.get(&process_id),
            project_root,
            expected_started_at,
            port,
            &listeners,
        ) {
            CloseHandle(handle);
            return Err("该进程已不再监听所选端口，或启动时间、项目路径、服务命令发生变化，拒绝停止。请重新扫描。".into());
        }

        let mut created_again = FILETIME::default();
        if GetProcessTimes(
            handle,
            &mut created_again,
            &mut exited,
            &mut kernel,
            &mut user,
        ) == 0
        {
            let error = std::io::Error::last_os_error();
            CloseHandle(handle);
            return Err(format!("停止前复核 PID {process_id} 失败：{error}"));
        }
        let creation_time_again =
            ((created_again.dwHighDateTime as u64) << 32) | created_again.dwLowDateTime as u64;
        if creation_time_again != opened_creation_time {
            CloseHandle(handle);
            return Err("PID 身份在停止前发生变化，拒绝停止。".into());
        }

        if TerminateProcess(handle, 1) == 0 {
            let error = std::io::Error::last_os_error();
            CloseHandle(handle);
            return Err(format!("停止 PID {process_id} 失败：{error}"));
        }
        let wait = WaitForSingleObject(handle, 10_000);
        CloseHandle(handle);
        if wait != WAIT_OBJECT_0 {
            return Err(format!(
                "PID {process_id} 已收到停止请求，但未在 10 秒内退出。"
            ));
        }
        Ok(())
    }
}

#[cfg(not(windows))]
fn terminate_external_service_checked(
    _process_id: u32,
    _port: u16,
    _project_root: &Path,
    _expected_started_at: &str,
) -> AppResult<()> {
    Err("外部项目进程控制仅支持 Windows。".into())
}

#[cfg(windows)]
fn process_creation_time(
    process_id: u32,
    access: u32,
) -> AppResult<(windows_sys::Win32::Foundation::HANDLE, u64)> {
    use windows_sys::Win32::{
        Foundation::{CloseHandle, FILETIME},
        System::Threading::{GetProcessTimes, OpenProcess},
    };

    unsafe {
        let handle = OpenProcess(access, 0, process_id);
        if handle.is_null() {
            return Err(format!(
                "无法打开 PID {process_id}：{}",
                std::io::Error::last_os_error()
            ));
        }
        let mut created = FILETIME::default();
        let mut exited = FILETIME::default();
        let mut kernel = FILETIME::default();
        let mut user = FILETIME::default();
        if GetProcessTimes(handle, &mut created, &mut exited, &mut kernel, &mut user) == 0 {
            let error = std::io::Error::last_os_error();
            CloseHandle(handle);
            return Err(format!("读取 PID {process_id} 启动时间失败：{error}"));
        }
        let ticks = ((created.dwHighDateTime as u64) << 32) | created.dwLowDateTime as u64;
        Ok((handle, ticks))
    }
}

#[cfg(not(windows))]
fn process_creation_time(
    _process_id: u32,
    _access: u32,
) -> AppResult<(*mut std::ffi::c_void, u64)> {
    Err("服务进程控制仅支持 Windows。".into())
}

fn managed_process_is_alive(service: &ManagedService) -> AppResult<bool> {
    let details = all_process_details_checked()?;
    let Some(process_details) = details.get(&service.process_id) else {
        return Ok(false);
    };
    let (handle, creation_time) =
        process_creation_time(service.process_id, windows_query_process_access())?;
    #[cfg(windows)]
    unsafe {
        windows_sys::Win32::Foundation::CloseHandle(handle);
    }
    #[cfg(not(windows))]
    let _ = handle;
    if creation_time != service.process_creation_time {
        return Ok(false);
    }
    Ok(is_managed_process_candidate(
        Some(process_details),
        &service.project_root,
        service.port,
    ))
}

#[cfg(windows)]
fn windows_query_process_access() -> u32 {
    windows_sys::Win32::System::Threading::PROCESS_QUERY_LIMITED_INFORMATION
}

#[cfg(not(windows))]
fn windows_query_process_access() -> u32 {
    0
}

#[cfg(windows)]
fn terminate_managed_process(service: &ManagedService) -> AppResult<()> {
    use windows_sys::Win32::{
        Foundation::{CloseHandle, FILETIME, WAIT_OBJECT_0},
        System::Threading::{
            GetProcessTimes, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE,
            PROCESS_TERMINATE, TerminateProcess, WaitForSingleObject,
        },
    };

    unsafe {
        let access = PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_TERMINATE | PROCESS_SYNCHRONIZE;
        let handle = OpenProcess(access, 0, service.process_id);
        if handle.is_null() {
            return Err(format!(
                "无法安全打开 PID {}：{}",
                service.process_id,
                std::io::Error::last_os_error()
            ));
        }
        let mut created = FILETIME::default();
        let mut exited = FILETIME::default();
        let mut kernel = FILETIME::default();
        let mut user = FILETIME::default();
        if GetProcessTimes(handle, &mut created, &mut exited, &mut kernel, &mut user) == 0 {
            let error = std::io::Error::last_os_error();
            CloseHandle(handle);
            return Err(format!("复核 PID 启动时间失败：{error}"));
        }
        let creation_time = ((created.dwHighDateTime as u64) << 32) | created.dwLowDateTime as u64;
        if creation_time != service.process_creation_time {
            CloseHandle(handle);
            return Err("PID 已被其他进程复用，拒绝停止。".into());
        }
        let details = match all_process_details_checked() {
            Ok(details) => details,
            Err(error) => {
                CloseHandle(handle);
                return Err(format!("无法完整复核进程清单，拒绝停止：{error}"));
            }
        };
        if !is_managed_process_candidate(
            details.get(&service.process_id),
            &service.project_root,
            service.port,
        ) {
            CloseHandle(handle);
            return Err("进程路径或命令行与已登记的库存服务不符，拒绝停止。".into());
        }
        if TerminateProcess(handle, 1) == 0 {
            let error = std::io::Error::last_os_error();
            CloseHandle(handle);
            return Err(format!("停止服务失败：{error}"));
        }
        let wait = WaitForSingleObject(handle, 10_000);
        CloseHandle(handle);
        if wait != WAIT_OBJECT_0 {
            return Err("服务进程已收到停止请求，但未在 10 秒内退出。".into());
        }
        Ok(())
    }
}

#[cfg(not(windows))]
fn terminate_managed_process(_service: &ManagedService) -> AppResult<()> {
    Err("服务进程控制仅支持 Windows。".into())
}

fn project_process_rows_checked(
    project_root: &Path,
    configured_port: u16,
) -> AppResult<Vec<ServiceProcess>> {
    let listeners = listening_endpoints()?;
    let details_by_pid = all_process_details_checked()?;
    Ok(project_process_rows_from(
        &listeners,
        &details_by_pid,
        project_root,
        configured_port,
    ))
}

fn process_command_port(details: &ProcessDetails) -> Option<u16> {
    let arguments = details
        .command_line
        .as_deref()?
        .split_whitespace()
        .collect::<Vec<_>>();
    arguments
        .windows(2)
        .find(|pair| pair[0].eq_ignore_ascii_case("--port"))?
        .get(1)?
        .parse::<u16>()
        .ok()
}

fn project_process_rows_from(
    listeners: &[(u16, u32)],
    details_by_pid: &std::collections::HashMap<u32, ProcessDetails>,
    project_root: &Path,
    configured_port: u16,
) -> Vec<ServiceProcess> {
    let listening_processes = listeners
        .iter()
        .map(|(_, pid)| *pid)
        .collect::<BTreeSet<_>>();
    let mut processes = listeners
        .iter()
        .copied()
        .filter(|(port, pid)| {
            *port == configured_port
                || is_project_candidate(details_by_pid.get(pid), project_root)
                || is_unverified_node_listener(details_by_pid.get(pid))
        })
        .map(|(port, pid)| {
            let details = details_by_pid.get(&pid);
            let command_line = details
                .and_then(|details| details.command_line.as_deref())
                .unwrap_or_default();
            let candidate = is_project_candidate(details, project_root);
            let identity_unavailable = process_identity_unavailable(details);
            let unverified_node = is_unverified_node_listener(details);
            ServiceProcess {
                process_id: pid,
                parent_process_id: details.and_then(|details| details.parent_process_id),
                source: if candidate {
                    "外部项目候选（待核验）"
                } else if unverified_node {
                    "Node 监听进程（待核验归属）"
                } else if identity_unavailable {
                    "无法核验的监听进程"
                } else {
                    "未识别的端口占用"
                }
                .into(),
                state: if candidate || unverified_node || identity_unavailable {
                    "待核验"
                } else {
                    "端口冲突"
                }
                .into(),
                port,
                started_at: details
                    .and_then(|details| details.creation_date.clone())
                    .unwrap_or_else(|| "未知".into()),
                executable_path: details
                    .and_then(|details| details.executable_path.clone())
                    .unwrap_or_default(),
                command_line: if candidate || identity_unavailable {
                    command_line.chars().take(240).collect()
                } else {
                    String::new()
                },
                managed: false,
            }
        })
        .collect::<Vec<_>>();
    for (process_id, details) in details_by_pid {
        if listening_processes.contains(process_id)
            || !is_project_candidate(Some(details), project_root)
        {
            continue;
        }
        let command_line = details.command_line.as_deref().unwrap_or_default();
        processes.push(ServiceProcess {
            process_id: *process_id,
            parent_process_id: details.parent_process_id,
            source: "外部项目候选（待核验）".into(),
            state: "项目进程未监听端口".into(),
            port: process_command_port(details).unwrap_or(configured_port),
            started_at: details
                .creation_date
                .clone()
                .unwrap_or_else(|| "未知".into()),
            executable_path: details.executable_path.clone().unwrap_or_default(),
            command_line: command_line.chars().take(240).collect(),
            managed: false,
        });
    }
    processes
}

fn health_check(port: u16) -> bool {
    let address = ("127.0.0.1", port)
        .to_socket_addrs()
        .ok()
        .and_then(|mut addresses| addresses.next());
    let Some(address) = address else { return false };
    let Ok(mut stream) = TcpStream::connect_timeout(&address, Duration::from_millis(700)) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(2)));
    use std::io::Write;
    if stream
        .write_all(b"GET /login HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n")
        .is_err()
    {
        return false;
    }
    let mut response = [0_u8; 64];
    let Ok(read) = stream.read(&mut response) else {
        return false;
    };
    let first_line = String::from_utf8_lossy(&response[..read]);
    first_line.starts_with("HTTP/1.1 200") || first_line.starts_with("HTTP/1.0 200")
}

fn system_login_url(config: &AppConfig) -> AppResult<String> {
    configured_root(config)?;
    if !inventory_login_page_check(config.port) {
        return Err(
            "配置端口上没有检测到可识别的溯格库存登录页。请先启动库存服务并检查端口配置。".into(),
        );
    }
    Ok(format!("http://127.0.0.1:{}/login", config.port))
}

fn inventory_login_page_check(port: u16) -> bool {
    let address = ("127.0.0.1", port)
        .to_socket_addrs()
        .ok()
        .and_then(|mut addresses| addresses.next());
    let Some(address) = address else { return false };
    let Ok(mut stream) = TcpStream::connect_timeout(&address, Duration::from_millis(700)) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(2)));
    use std::io::Write;
    if stream
        .write_all(
            b"GET /login HTTP/1.1\r\nHost: 127.0.0.1\r\nAccept-Encoding: identity\r\nConnection: close\r\n\r\n",
        )
        .is_err()
    {
        return false;
    }
    let mut response = Vec::new();
    if stream.take(128 * 1024).read_to_end(&mut response).is_err() {
        return false;
    }
    let response = String::from_utf8_lossy(&response);
    let Some((headers, body)) = response.split_once("\r\n\r\n") else {
        return false;
    };
    let status_ok = headers
        .lines()
        .next()
        .is_some_and(|line| line.starts_with("HTTP/1.1 200") || line.starts_with("HTTP/1.0 200"));
    status_ok && body.to_ascii_lowercase().contains("sugrid")
}

fn service_snapshot(config: &AppConfig, state: &ManagerState) -> ServiceSnapshot {
    let Ok(root) = configured_root(config) else {
        return ServiceSnapshot {
            configured: false,
            scan_complete: true,
            running: false,
            healthy: false,
            url: String::new(),
            message: "请先配置项目目录。".into(),
            processes: Vec::new(),
        };
    };
    let mut scan_errors = Vec::new();
    let managed = {
        let mut service = lock(&state.managed_service);
        if let Some(current) = service.as_mut() {
            if current.project_root == root
                && current.port == config.port
                && current.database_path == PathBuf::from(&config.database_path)
            {
                let result = match current.child.as_mut() {
                    Some(child) => child
                        .try_wait()
                        .map(|status| status.is_none())
                        .map_err(|error| format!("复核管理器服务进程失败：{error}")),
                    None => managed_process_is_alive(current),
                };
                match result {
                    Ok(true) => Some((current.process_id, current.started_at, true)),
                    Ok(false) => {
                        state.record(
                            "服务退出",
                            false,
                            format!("PID {} 已退出或身份复核失败。", current.process_id),
                        );
                        *service = None;
                        let _ = state.persist_managed_service(None);
                        None
                    }
                    Err(error) => {
                        state.record("服务检查失败", false, error.clone());
                        scan_errors.push(error);
                        Some((current.process_id, current.started_at, false))
                    }
                }
            } else {
                None
            }
        } else {
            None
        }
    };
    let mut processes = match project_process_rows_checked(&root, config.port) {
        Ok(processes) => processes,
        Err(error) => {
            scan_errors.push(error);
            Vec::new()
        }
    };
    if let Some((pid, started_at, identity_verified)) = managed {
        processes.retain(|process| process.process_id != pid);
        processes.insert(
            0,
            ServiceProcess {
                process_id: pid,
                parent_process_id: None,
                source: if identity_verified {
                    "管理器启动"
                } else {
                    "管理器记录（身份待核验）"
                }
                .into(),
                state: if !identity_verified {
                    "身份待核验"
                } else if health_check(config.port) {
                    "运行正常"
                } else {
                    "启动中"
                }
                .into(),
                port: config.port,
                started_at: started_at.to_string(),
                executable_path: String::new(),
                command_line: format!(
                    "node next start --hostname {} --port {}",
                    config.host, config.port
                ),
                managed: identity_verified,
            },
        );
    }
    let scan_complete = scan_errors.is_empty();
    let port_healthy = health_check(config.port);
    let running = processes.iter().any(|process| process.port == config.port)
        || (!scan_complete && port_healthy);
    let healthy = scan_complete && running && port_healthy;
    ServiceSnapshot {
        configured: true,
        scan_complete,
        running,
        healthy,
        url: format!("http://127.0.0.1:{}", config.port),
        message: if !scan_complete {
            format!(
                "进程扫描未完成，服务身份暂不可确认：{} Git 更新和数据库恢复已禁用。",
                scan_errors.join("；")
            )
        } else if processes.iter().any(|process| process.managed) && healthy {
            "服务运行正常，由当前管理器启动。".into()
        } else if processes.iter().any(|process| process.managed) {
            "服务进程仍在运行，等待网页就绪。".into()
        } else if !running && !processes.is_empty() {
            "检测到项目在其他端口运行；当前配置端口尚未启动。".into()
        } else if !running {
            "服务当前未运行。".into()
        } else if healthy {
            "端口可访问，但进程由外部启动；管理器不会停止它。".into()
        } else {
            "端口已占用且无法确认项目归属，管理器不会操作该进程。".into()
        },
        processes,
    }
}

fn restore_blocked_by_processes(processes: &[ServiceProcess]) -> Option<String> {
    (!processes.is_empty()).then(|| {
        format!(
            "检测到 {} 个当前或其他端口的服务进程；请全部停止并核实后再恢复数据库。",
            processes.len()
        )
    })
}

fn start_blocked_by_processes(processes: &[ServiceProcess]) -> Option<String> {
    processes.first().map(|process| {
        format!(
            "检测到待核验的项目进程 PID {}（端口 {}）；请先核实并停止现有服务，再启动新实例。",
            process.process_id, process.port
        )
    })
}

fn verified_managed_process_id(
    state: &ManagerState,
    config: &AppConfig,
    root: &Path,
) -> AppResult<Option<u32>> {
    let mut slot = lock(&state.managed_service);
    let Some(service) = slot.as_mut() else {
        return Ok(None);
    };
    if service.project_root != root
        || service.port != config.port
        || service.database_path != PathBuf::from(&config.database_path)
    {
        return Err("管理器登记的服务与当前项目配置不一致，拒绝继续操作。".into());
    }
    let alive = match service.child.as_mut() {
        Some(child) => child
            .try_wait()
            .map(|status| status.is_none())
            .map_err(|error| format!("复核管理器服务状态失败：{error}"))?,
        None => managed_process_is_alive(service)?,
    };
    if alive {
        Ok(Some(service.process_id))
    } else {
        *slot = None;
        state.persist_managed_service(None)?;
        Ok(None)
    }
}

fn find_executable(file_name: &str) -> AppResult<PathBuf> {
    let path = std::env::var_os("PATH").ok_or("系统 PATH 未配置。")?;
    for entry in std::env::split_paths(&path) {
        let candidate = entry.join(file_name);
        if candidate.is_file() {
            return candidate.canonicalize().map_err(|error| error.to_string());
        }
    }
    Err(format!("找不到 {file_name}，请安装并配置到系统 PATH。"))
}

fn write_process_logs(root: &Path, label: &str) -> AppResult<(PathBuf, File, File)> {
    let directory = root.join(".tmp").join("server-manager").join("logs");
    fs::create_dir_all(&directory).map_err(|error| format!("创建服务日志目录失败：{error}"))?;
    let stamp = now_millis();
    let output = directory.join(format!("{label}-{stamp}.out.log"));
    let error = directory.join(format!("{label}-{stamp}.err.log"));
    let stdout = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&output)
        .map_err(|error| error.to_string())?;
    let stderr = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&error)
        .map_err(|error| error.to_string())?;
    Ok((output, stdout, stderr))
}

fn start_managed_service(config: &AppConfig, state: &ManagerState) -> AppResult<ServiceSnapshot> {
    start_managed_service_with_scan(config, state, project_process_rows_checked)
}

fn start_managed_service_with_scan(
    config: &AppConfig,
    state: &ManagerState,
    scan_processes: impl Fn(&Path, u16) -> AppResult<Vec<ServiceProcess>>,
) -> AppResult<ServiceSnapshot> {
    let config = normalize_config(config.clone())?;
    let root = PathBuf::from(&config.project_root);
    if lock(&state.managed_service).is_some() {
        return Err("管理器已经启动了项目服务。".into());
    }
    let processes = scan_processes(&root, config.port)?;
    if listening_endpoints()?
        .iter()
        .any(|(port, _)| *port == config.port)
    {
        return Err(format!(
            "端口 {} 已被占用；管理器不会覆盖或终止现有进程。",
            config.port
        ));
    }
    if let Some(reason) = start_blocked_by_processes(&processes) {
        return Err(reason);
    }
    let next_cli = root
        .join("node_modules")
        .join("next")
        .join("dist")
        .join("bin")
        .join("next");
    if !next_cli.is_file() {
        return Err("找不到 Next.js CLI，请先在项目目录完成 npm ci。".into());
    }
    if !root.join(".next").join("BUILD_ID").is_file() {
        return Err("找不到生产构建，请先构建项目。".into());
    }
    let node = find_executable("node.exe")?;

    let database_path = PathBuf::from(&config.database_path);
    let (log_path, stdout, stderr) = write_process_logs(&root, "service")?;
    let processes = scan_processes(&root, config.port)?;
    if let Some(reason) = start_blocked_by_processes(&processes) {
        return Err(reason);
    }
    if listening_endpoints()?
        .iter()
        .any(|(port, _)| *port == config.port)
    {
        return Err(format!(
            "端口 {} 已被占用；管理器不会覆盖或终止现有进程。",
            config.port
        ));
    }

    let mut child = hidden_command(node)
        .arg(next_cli)
        .args([
            "start",
            "--hostname",
            &config.host,
            "--port",
            &config.port.to_string(),
        ])
        .current_dir(&root)
        .env("INVENTORY_DB_PATH", &database_path)
        .env("PORT", config.port.to_string())
        .env("HOSTNAME", &config.host)
        .stdout(Stdio::from(stdout))
        .stderr(Stdio::from(stderr))
        .spawn()
        .map_err(|error| format!("启动库存系统失败：{error}"))?;
    let process_id = child.id();
    let started_at = now_millis();
    let (process_handle, process_creation_time) =
        match process_creation_time(process_id, windows_query_process_access()) {
            Ok(identity) => identity,
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(error);
            }
        };
    #[cfg(windows)]
    unsafe {
        windows_sys::Win32::Foundation::CloseHandle(process_handle);
    }
    #[cfg(not(windows))]
    let _ = process_handle;
    let mut service = ManagedService {
        child: Some(child),
        process_id,
        process_creation_time,
        started_at,
        project_root: root,
        database_path,
        port: config.port,
        log_path,
    };
    if let Err(error) = state.persist_managed_service(Some(&service)) {
        if let Some(child) = service.child.as_mut() {
            let _ = child.kill();
            let _ = child.wait();
        }
        return Err(error);
    }
    lock(&state.managed_service).replace(service);
    for _ in 0..30 {
        if health_check(config.port) {
            break;
        }
        thread::sleep(Duration::from_millis(500));
    }
    Ok(service_snapshot(&config, state))
}

fn stop_managed_service(state: &ManagerState, config: &AppConfig) -> AppResult<String> {
    let root = configured_root(config)?;
    let mut slot = lock(&state.managed_service);
    let Some(service) = slot.as_mut() else {
        return Err("当前管理器没有可停止的服务进程；外部进程不会被停止。".into());
    };
    if service.project_root != root
        || service.port != config.port
        || service.database_path != PathBuf::from(&config.database_path)
    {
        return Err("服务身份与当前配置不一致，拒绝停止。".into());
    }
    let pid = service.process_id;
    if let Some(child) = service.child.as_mut() {
        match child.try_wait() {
            Ok(Some(status)) => {
                *slot = None;
                state.persist_managed_service(None)?;
                return Err(format!("PID {pid} 已退出，退出状态：{status}"));
            }
            Err(error) => return Err(format!("无法复核进程状态：{error}")),
            Ok(None) => {
                child
                    .kill()
                    .map_err(|error| format!("停止服务失败：{error}"))?;
                child
                    .wait()
                    .map_err(|error| format!("等待服务退出失败：{error}"))?;
            }
        }
    } else {
        if !managed_process_is_alive(service)? {
            *slot = None;
            state.persist_managed_service(None)?;
            return Err(format!("PID {pid} 的服务身份复核失败，拒绝停止。"));
        }
        terminate_managed_process(service)?;
    }
    *slot = None;
    state.persist_managed_service(None)?;
    Ok(format!("已停止管理器启动的 PID {pid}。"))
}

fn command_output(
    program: &Path,
    args: &[&str],
    root: &Path,
    timeout: Duration,
    log_dir: &Path,
) -> AppResult<(ExitStatus, String, String)> {
    fs::create_dir_all(log_dir).map_err(|error| error.to_string())?;
    let stamp = now_millis();
    let stdout_path = log_dir.join(format!("command-{stamp}.out.log"));
    let stderr_path = log_dir.join(format!("command-{stamp}.err.log"));
    let stdout = File::create(&stdout_path).map_err(|error| error.to_string())?;
    let stderr = File::create(&stderr_path).map_err(|error| error.to_string())?;
    let mut child = hidden_command(program)
        .args(args)
        .current_dir(root)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GCM_INTERACTIVE", "Never")
        .stdout(Stdio::from(stdout))
        .stderr(Stdio::from(stderr))
        .spawn()
        .map_err(|error| format!("启动 {} 失败：{error}", program.display()))?;
    let started = Instant::now();
    let status = loop {
        if let Some(status) = child.try_wait().map_err(|error| error.to_string())? {
            break status;
        }
        if started.elapsed() > timeout {
            let _ = child.kill();
            let _ = child.wait();
            return Err(format!(
                "命令超时（{} 秒），日志：{}",
                timeout.as_secs(),
                stderr_path.display()
            ));
        }
        thread::sleep(Duration::from_millis(100));
    };
    Ok((
        status,
        read_log_tail(&stdout_path),
        read_log_tail(&stderr_path),
    ))
}

fn read_log_tail(path: &Path) -> String {
    let Ok(contents) = fs::read_to_string(path) else {
        return String::new();
    };
    const MAX_CHARS: usize = 24_000;
    if contents.chars().count() <= MAX_CHARS {
        contents
    } else {
        contents
            .chars()
            .rev()
            .take(MAX_CHARS)
            .collect::<String>()
            .chars()
            .rev()
            .collect()
    }
}

fn run_git(root: &Path, args: &[&str], timeout: Duration, log_dir: &Path) -> AppResult<String> {
    let git = find_executable("git.exe")?;
    let (status, stdout, stderr) = command_output(&git, args, root, timeout, log_dir)?;
    if !status.success() {
        return Err(format!("git {} 失败：{}{}", args.join(" "), stderr, stdout));
    }
    Ok(stdout.trim().to_string())
}

fn is_expected_remote(remote: &str) -> bool {
    let value = remote
        .trim()
        .trim_end_matches('/')
        .trim_end_matches(".git")
        .to_ascii_lowercase();
    value == "https://github.com/jiufff111/sugrid-inventory"
        || value == "git@github.com:jiufff111/sugrid-inventory"
        || value == "ssh://git@github.com/jiufff111/sugrid-inventory"
}

fn update_decision(
    branch: &str,
    dirty_paths: &[String],
    ahead: usize,
    behind: usize,
    remote_matches: bool,
    ancestor: bool,
) -> (bool, String) {
    if branch != "main" {
        return (false, format!("当前分支为 {branch}，只允许从 main 更新。"));
    }
    if !remote_matches {
        return (false, "origin 不是已配置的 SUGRID GitHub 仓库。".into());
    }
    if !dirty_paths.is_empty() {
        return (
            false,
            format!(
                "工作区有 {} 项未提交或未跟踪内容，先人工处理。",
                dirty_paths.len()
            ),
        );
    }
    if !ancestor || ahead > 0 {
        return (
            false,
            "本地与 origin/main 已分叉或本地领先，拒绝覆盖。".into(),
        );
    }
    if behind == 0 {
        return (
            false,
            "当前已与 origin/main 同步，没有可拉取的提交。".into(),
        );
    }
    (
        true,
        format!("工作区干净，可以从 origin/main 快进更新 {behind} 个提交。"),
    )
}

fn read_git_snapshot(config: &AppConfig, log_dir: &Path, fetch: bool) -> GitSnapshot {
    let result = (|| -> AppResult<GitSnapshot> {
        let root = configured_root(config)?;
        if fetch {
            run_git(
                &root,
                &["fetch", "--prune", "origin", "main"],
                Duration::from_secs(120),
                log_dir,
            )?;
        }
        let branch = run_git(
            &root,
            &["branch", "--show-current"],
            Duration::from_secs(10),
            log_dir,
        )?;
        let commit = run_git(
            &root,
            &["rev-parse", "--short", "HEAD"],
            Duration::from_secs(10),
            log_dir,
        )?;
        let status = run_git(
            &root,
            &["status", "--porcelain=v1", "--untracked-files=all"],
            Duration::from_secs(15),
            log_dir,
        )?;
        let dirty_paths = status
            .lines()
            .filter(|line| !line.trim().is_empty())
            .map(|line| line.chars().skip(3).collect::<String>())
            .collect::<Vec<_>>();
        let remote = run_git(
            &root,
            &["remote", "get-url", "origin"],
            Duration::from_secs(10),
            log_dir,
        )?;
        let remote_matches = is_expected_remote(&remote);
        let counts = run_git(
            &root,
            &["rev-list", "--left-right", "--count", "HEAD...origin/main"],
            Duration::from_secs(15),
            log_dir,
        )
        .unwrap_or_default();
        let mut count_parts = counts.split_whitespace();
        let ahead = count_parts
            .next()
            .and_then(|value| value.parse().ok())
            .unwrap_or(0);
        let behind = count_parts
            .next()
            .and_then(|value| value.parse().ok())
            .unwrap_or(0);
        let ancestor = run_git(
            &root,
            &["merge-base", "--is-ancestor", "HEAD", "origin/main"],
            Duration::from_secs(10),
            log_dir,
        )
        .is_ok();
        let (can_update, message) = update_decision(
            &branch,
            &dirty_paths,
            ahead,
            behind,
            remote_matches,
            ancestor,
        );
        let state = if can_update {
            "ready"
        } else if behind == 0
            && branch == "main"
            && dirty_paths.is_empty()
            && remote_matches
            && ancestor
        {
            "current"
        } else {
            "blocked"
        };
        Ok(GitSnapshot {
            available: true,
            branch,
            commit,
            clean: dirty_paths.is_empty(),
            dirty_paths,
            ahead,
            behind,
            remote_matches,
            can_update,
            state: state.into(),
            message,
        })
    })();
    result.unwrap_or_else(|error| GitSnapshot {
        available: false,
        branch: "未知".into(),
        commit: String::new(),
        clean: false,
        dirty_paths: Vec::new(),
        ahead: 0,
        behind: 0,
        remote_matches: false,
        can_update: false,
        state: "blocked".into(),
        message: error,
    })
}

fn diagnostics(
    config: &AppConfig,
    service: &ServiceSnapshot,
    database: &DatabaseSnapshot,
    git: &GitSnapshot,
) -> Vec<DiagnosticItem> {
    let mut items = Vec::new();
    let node = find_executable("node.exe").ok();
    let node_version = node
        .as_ref()
        .and_then(|path| hidden_command(path).arg("--version").output().ok())
        .filter(|output| output.status.success())
        .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_string());
    items.push(DiagnosticItem {
        label: "Node.js".into(),
        state: if node_version.is_some() {
            "ok"
        } else {
            "error"
        }
        .into(),
        detail: node_version.unwrap_or_else(|| "未在 PATH 中检测到 node.exe".into()),
    });
    let git_version = find_executable("git.exe")
        .ok()
        .and_then(|path| hidden_command(path).arg("--version").output().ok())
        .filter(|output| output.status.success())
        .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_string());
    items.push(DiagnosticItem {
        label: "Git".into(),
        state: if git_version.is_some() { "ok" } else { "error" }.into(),
        detail: git_version.unwrap_or_else(|| "未在 PATH 中检测到 git.exe".into()),
    });
    items.push(DiagnosticItem {
        label: "项目目录".into(),
        state: if is_configured(config) {
            "ok"
        } else {
            "warning"
        }
        .into(),
        detail: if is_configured(config) {
            config.project_root.clone()
        } else {
            "尚未配置或目录不包含 package.json / .git".into()
        },
    });
    items.push(DiagnosticItem {
        label: "服务".into(),
        state: if service.healthy {
            "ok"
        } else if service.running {
            "warning"
        } else {
            "stopped"
        }
        .into(),
        detail: service.message.clone(),
    });
    items.push(DiagnosticItem {
        label: "SQLite".into(),
        state: if database.integrity == "ok" && database.foreign_key_violations == 0 {
            "ok"
        } else if database.exists {
            "error"
        } else {
            "warning"
        }
        .into(),
        detail: database.message.clone(),
    });
    items.push(DiagnosticItem {
        label: "Git 工作区".into(),
        state: if git.available && git.clean {
            "ok"
        } else if git.available {
            "warning"
        } else {
            "error"
        }
        .into(),
        detail: git.message.clone(),
    });
    items
}

fn dashboard(state: &ManagerState) -> Dashboard {
    let config = state.config();
    let configured = is_configured(&config);
    let service = service_snapshot(&config, state);
    let database = database_snapshot(&config);
    let git = read_git_snapshot(&config, &state.log_path.with_file_name("commands"), false);
    let backups = configured_root(&config)
        .ok()
        .and_then(|root| resolved_database(&config, &root).ok())
        .map(|path| list_backup_files(&path))
        .unwrap_or_default();
    let diagnostics = diagnostics(&config, &service, &database, &git);
    Dashboard {
        config,
        configured,
        service,
        git,
        database,
        backups,
        logs: state.recent_logs(),
        diagnostics,
    }
}

#[tauri::command]
pub async fn get_dashboard(state: State<'_, Arc<ManagerState>>) -> AppResult<Dashboard> {
    let shared = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || Ok(dashboard(&shared)))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub fn save_config(config: AppConfig, state: State<'_, Arc<ManagerState>>) -> AppResult<AppConfig> {
    let normalized = normalize_config(config)?;
    let current = state.config();
    if current.project_root != normalized.project_root
        || current.port != normalized.port
        || current.host != normalized.host
        || current.database_path != normalized.database_path
    {
        let service_running = service_snapshot(&current, state.inner()).running;
        let service_tracked = lock(&state.managed_service).is_some();
        if service_running || service_tracked {
            return Err("服务运行或端口被占用时不能修改项目、端口、监听地址或数据库路径。".into());
        }
    }
    let json = serde_json::to_vec_pretty(&normalized).map_err(|error| error.to_string())?;
    fs::write(&state.config_path, json).map_err(|error| format!("保存配置失败：{error}"))?;
    *lock(&state.config) = normalized.clone();
    state.record(
        "保存配置",
        true,
        format!(
            "项目目录已设置为 {}，端口 {}。",
            normalized.project_root, normalized.port
        ),
    );
    Ok(normalized)
}

#[tauri::command]
pub async fn scan_services(state: State<'_, Arc<ManagerState>>) -> AppResult<ServiceSnapshot> {
    let shared = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let config = shared.config();
        Ok(service_snapshot(&config, &shared))
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn start_service(state: State<'_, Arc<ManagerState>>) -> AppResult<ServiceSnapshot> {
    let shared = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let config = shared.config();
        match start_managed_service(&config, &shared) {
            Ok(snapshot) => {
                shared.record("启动服务", true, snapshot.message.clone());
                Ok(snapshot)
            }
            Err(error) => {
                shared.record("启动服务", false, error.clone());
                Err(error)
            }
        }
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn stop_service(state: State<'_, Arc<ManagerState>>) -> AppResult<String> {
    let shared = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let config = shared.config();
        match stop_managed_service(&shared, &config) {
            Ok(detail) => {
                shared.record("停止服务", true, detail.clone());
                Ok(detail)
            }
            Err(error) => {
                shared.record("停止服务", false, error.clone());
                Err(error)
            }
        }
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn stop_external_service(
    process_id: u32,
    port: u16,
    started_at: String,
    confirmation: String,
    state: State<'_, Arc<ManagerState>>,
) -> AppResult<String> {
    let shared = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let result: AppResult<String> = (|| {
            if confirmation != format!("停止 {process_id}") {
                return Err("确认文字不正确，未停止任何进程。".into());
            }
            let config = shared.config();
            let root = configured_root(&config)?;
            let processes = project_process_rows_checked(&root, config.port)?;
            let candidate = processes
                .iter()
                .find(|process| process.process_id == process_id && process.port == port)
                .ok_or("该进程已不存在或端口已变化，请重新扫描。")?;
            if candidate.managed
                || candidate.source != "外部项目候选（待核验）"
                || candidate.state != "待核验"
                || candidate.started_at != started_at
            {
                return Err("该进程不是正在监听所选端口的库存服务，或身份与确认时不一致，拒绝停止。请重新扫描。".into());
            }
            terminate_external_service_checked(process_id, port, &root, &started_at)?;
            Ok(format!(
                "已停止核验过的项目进程 PID {process_id}（端口 {port}）。"
            ))
        })();
        match result {
            Ok(message) => {
                shared.record("停止外部项目服务", true, message.clone());
                Ok(message)
            }
            Err(error) => {
                shared.record("停止外部项目服务", false, error.clone());
                Err(error)
            }
        }
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn open_system(app: AppHandle, state: State<'_, Arc<ManagerState>>) -> AppResult<String> {
    let shared = state.inner().clone();
    let config = shared.config();
    let url = tauri::async_runtime::spawn_blocking(move || system_login_url(&config))
        .await
        .map_err(|error| error.to_string())??;
    let result: AppResult<String> = (|| {
        let target = url
            .parse::<tauri::Url>()
            .map_err(|error| format!("库存系统地址无效：{error}"))?;
        let window = if let Some(window) = app.get_webview_window("inventory-system") {
            window
                .navigate(target)
                .map_err(|error| format!("切换到库存系统失败：{error}"))?;
            window
        } else {
            WebviewWindowBuilder::new(&app, "inventory-system", WebviewUrl::External(target))
                .title("溯格库存系统")
                .inner_size(1360.0, 900.0)
                .min_inner_size(980.0, 680.0)
                .center()
                .build()
                .map_err(|error| format!("打开库存系统窗口失败：{error}"))?
        };
        window
            .show()
            .map_err(|error| format!("显示库存系统窗口失败：{error}"))?;
        window
            .set_focus()
            .map_err(|error| format!("切换到库存系统窗口失败：{error}"))?;
        Ok(format!("已在新窗口打开库存系统：{url}"))
    })();
    match result {
        Ok(message) => {
            shared.record("打开库存系统", true, message.clone());
            Ok(message)
        }
        Err(error) => {
            shared.record("打开库存系统", false, error.clone());
            Err(error)
        }
    }
}

#[tauri::command]
pub async fn create_backup(state: State<'_, Arc<ManagerState>>) -> AppResult<BackupItem> {
    let shared = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let config = shared.config();
        let root = configured_root(&config)?;
        let path = resolved_database(&config, &root)?;
        match create_backup_file(&path) {
            Ok(backup) => {
                let item = list_backup_files(&path)
                    .into_iter()
                    .find(|item| item.path == backup.to_string_lossy())
                    .ok_or("备份创建后无法读取备份记录。")?;
                shared.record(
                    "创建数据库备份",
                    true,
                    format!("{}（{} bytes）", item.path, item.size),
                );
                Ok(item)
            }
            Err(error) => {
                shared.record("创建数据库备份", false, error.clone());
                Err(error)
            }
        }
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn validate_backup(
    path: String,
    state: State<'_, Arc<ManagerState>>,
) -> AppResult<BackupItem> {
    let shared = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let config = shared.config();
        let root = configured_root(&config)?;
        let database = resolved_database(&config, &root)?;
        let validated = validate_restore_target(&database, Path::new(&path))?;
        let item = list_backup_files(&database)
            .into_iter()
            .find(|item| item.path == validated.to_string_lossy())
            .ok_or("找不到备份记录。")?;
        Ok(item)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn restore_backup(
    path: String,
    state: State<'_, Arc<ManagerState>>,
) -> AppResult<String> {
    let shared = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let config = shared.config();
        let root = configured_root(&config)?;
        let database = resolved_database(&config, &root)?;
        match restore_database_with_process_check(
            &database,
            Path::new(&path),
            &root,
            config.port,
            project_process_rows_checked,
        ) {
            Ok(safety) => {
                shared.record(
                    "恢复数据库",
                    true,
                    format!("已从 {path} 恢复；恢复前备份：{}", safety.display()),
                );
                Ok(format!("恢复完成。恢复前数据库备份：{}", safety.display()))
            }
            Err(error) => {
                shared.record("恢复数据库", false, error.clone());
                Err(error)
            }
        }
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn check_for_updates(state: State<'_, Arc<ManagerState>>) -> AppResult<GitSnapshot> {
    let shared = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let config = shared.config();
        let git = read_git_snapshot(&config, &shared.log_path.with_file_name("commands"), true);
        shared.record(
            "检查 Git 更新",
            git.available && git.state != "blocked",
            git.message.clone(),
        );
        Ok(git)
    })
    .await
    .map_err(|error| error.to_string())?
}

fn emit_progress(app: &AppHandle, key: &str, state: &str, detail: impl Into<String>) {
    let _ = app.emit(
        "manager-operation-progress",
        UpdateProgress {
            key: key.into(),
            state: state.into(),
            detail: detail.into(),
        },
    );
}

fn run_npm(
    root: &Path,
    node: &Path,
    command: &[&str],
    timeout: Duration,
    log_dir: &Path,
    database: Option<&Path>,
) -> AppResult<String> {
    let node_home = node.parent().ok_or("无法解析 Node.js 安装目录。")?;
    let npm_cli = node_home
        .join("node_modules")
        .join("npm")
        .join("bin")
        .join("npm-cli.js");
    if !npm_cli.is_file() {
        return Err("找不到 npm-cli.js，无法安全运行 npm 命令。".into());
    }
    let mut args = vec![npm_cli.to_string_lossy().to_string()];
    args.extend(command.iter().map(|value| value.to_string()));
    run_command_with_env(node, &args, root, timeout, log_dir, database)
}

fn run_command_with_env(
    program: &Path,
    args: &[String],
    root: &Path,
    timeout: Duration,
    log_dir: &Path,
    database: Option<&Path>,
) -> AppResult<String> {
    fs::create_dir_all(log_dir).map_err(|error| error.to_string())?;
    let stamp = now_millis();
    let stdout_path = log_dir.join(format!("update-{stamp}.out.log"));
    let stderr_path = log_dir.join(format!("update-{stamp}.err.log"));
    let stdout = File::create(&stdout_path).map_err(|error| error.to_string())?;
    let stderr = File::create(&stderr_path).map_err(|error| error.to_string())?;
    let mut command = hidden_command(program);
    command
        .args(args)
        .current_dir(root)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GCM_INTERACTIVE", "Never")
        .stdout(Stdio::from(stdout))
        .stderr(Stdio::from(stderr));
    if let Some(database) = database {
        command.env("INVENTORY_DB_PATH", database);
    }
    let mut child = command
        .spawn()
        .map_err(|error| format!("运行 {} 失败：{error}", program.display()))?;
    let start = Instant::now();
    let status = loop {
        if let Some(status) = child.try_wait().map_err(|error| error.to_string())? {
            break status;
        }
        if start.elapsed() > timeout {
            let _ = child.kill();
            let _ = child.wait();
            return Err(format!(
                "命令超时（{} 秒）；日志：{}",
                timeout.as_secs(),
                stderr_path.display()
            ));
        }
        thread::sleep(Duration::from_millis(100));
    };
    let output = format!(
        "{}{}",
        read_log_tail(&stdout_path),
        read_log_tail(&stderr_path)
    );
    if status.success() {
        Ok(output)
    } else {
        Err(format!("退出码 {:?}：{}", status.code(), output))
    }
}

fn emit_step(
    app: &AppHandle,
    state: &ManagerState,
    key: &str,
    title: &str,
    run: impl FnOnce() -> AppResult<String>,
) -> AppResult<String> {
    emit_progress(app, key, "running", title);
    let result = run();
    match result {
        Ok(detail) => {
            let summary = detail.trim().chars().take(400).collect::<String>();
            emit_progress(
                app,
                key,
                "complete",
                if summary.is_empty() {
                    title.to_string()
                } else {
                    summary.clone()
                },
            );
            state.record(title, true, summary);
            Ok(detail)
        }
        Err(error) => {
            emit_progress(app, key, "failed", error.clone());
            state.record(title, false, error.clone());
            Err(error)
        }
    }
}

fn run_update(app: AppHandle, state: Arc<ManagerState>) -> AppResult<String> {
    let config = state.config();
    let root = configured_root(&config)?;
    let database_path = resolved_database(&config, &root)?;
    let log_dir = state.log_path.with_file_name("commands");
    emit_progress(
        &app,
        "preflight",
        "running",
        "检查工作区、远端和服务身份。 ",
    );
    let git = read_git_snapshot(&config, &log_dir, true);
    if !git.can_update {
        let reason = git.message.clone();
        emit_progress(&app, "preflight", "failed", reason.clone());
        state.record("更新前置检查", false, reason.clone());
        return Err(reason);
    }
    let mut processes = project_process_rows_checked(&root, config.port)?;
    let managed_process_id = verified_managed_process_id(&state, &config, &root)?;
    if let Some(process_id) = managed_process_id {
        processes.retain(|process| process.process_id != process_id);
    }
    if !processes.is_empty() {
        let reason =
            "配置端口有未由管理器启动的进程，无法确认其数据库路径；已阻止更新。".to_string();
        emit_progress(&app, "preflight", "failed", reason.clone());
        state.record("更新前置检查", false, reason.clone());
        return Err(reason);
    }
    emit_progress(&app, "preflight", "complete", git.message.clone());
    state.record("更新前置检查", true, git.message);

    let backup = emit_step(&app, &state, "backup", "SQLite 在线备份", || {
        let path = create_backup_file(&database_path)?;
        Ok(path.to_string_lossy().into_owned())
    })?;
    let managed = lock(&state.managed_service).is_some();
    if managed {
        emit_step(
            &app,
            &state,
            "stop",
            "停止管理器启动的库存服务",
            || stop_managed_service(&state, &config),
        )?;
    } else {
        emit_progress(&app, "stop", "complete", "库存服务原本未运行。 ");
    }

    let git = find_executable("git.exe")?;
    emit_step(&app, &state, "pull", "从 origin/main 快进更新", || {
        let processes = project_process_rows_checked(&root, config.port)?;
        if !processes.is_empty() {
            return Err(
                "更新前再次检测到项目进程；已阻止拉取，避免服务并发使用代码或数据库。".into(),
            );
        }
        let (status, stdout, stderr) = command_output(
            &git,
            &["pull", "--ff-only", "origin", "main"],
            &root,
            Duration::from_secs(180),
            &log_dir,
        )?;
        if status.success() {
            Ok(format!("{stdout}{stderr}"))
        } else {
            Err(format!("git pull --ff-only 失败：{stderr}{stdout}"))
        }
    })?;

    let node = find_executable("node.exe")?;
    emit_step(&app, &state, "dependencies", "npm ci 安装依赖", || {
        run_npm(
            &root,
            &node,
            &["ci"],
            Duration::from_secs(600),
            &log_dir,
            None,
        )
    })?;
    emit_step(&app, &state, "migrate", "运行数据库迁移", || {
        run_npm(
            &root,
            &node,
            &["run", "db:init"],
            Duration::from_secs(180),
            &log_dir,
            Some(&database_path),
        )
        .map(|_| "数据库迁移完成。".into())
    })?;
    emit_step(
        &app,
        &state,
        "build",
        "运行 Lint、TypeScript 和生产构建",
        || {
            run_npm(
                &root,
                &node,
                &["run", "lint"],
                Duration::from_secs(300),
                &log_dir,
                None,
            )?;
            let tsc = root
                .join("node_modules")
                .join("typescript")
                .join("bin")
                .join("tsc");
            let tsc = if tsc.with_extension("js").is_file() {
                tsc.with_extension("js")
            } else {
                tsc
            };
            run_command_with_env(
                &node,
                &[tsc.to_string_lossy().into_owned(), "--noEmit".into()],
                &root,
                Duration::from_secs(300),
                &log_dir,
                Some(&database_path),
            )?;
            run_npm(
                &root,
                &node,
                &["run", "build"],
                Duration::from_secs(900),
                &log_dir,
                Some(&database_path),
            )
        },
    )?;

    emit_step(&app, &state, "start", "启动库存服务", || {
        let snapshot = start_managed_service(&config, &state)?;
        Ok(snapshot.message)
    })?;
    emit_step(
        &app,
        &state,
        "health",
        "检查登录页与数据库连接",
        || {
            if !health_check(config.port) {
                return Err(format!(
                    "服务已启动，但 http://127.0.0.1:{}/login 未返回 HTTP 200。更新前备份：{backup}",
                    config.port
                ));
            }
            let database = database_snapshot(&config);
            if database.integrity != "ok" || database.foreign_key_violations > 0 {
                return Err(format!(
                    "服务可访问，但数据库完整性检查失败：{}",
                    database.message
                ));
            }
            Ok(format!(
                "http://127.0.0.1:{}/login 返回 HTTP 200；数据库完整性通过。",
                config.port
            ))
        },
    )?;
    Ok(format!("更新完成，服务健康。更新前数据库备份：{backup}"))
}

#[tauri::command]
pub async fn run_safe_update(
    app: AppHandle,
    state: State<'_, Arc<ManagerState>>,
) -> AppResult<String> {
    let shared = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || run_update(app, shared))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn run_diagnostics(
    state: State<'_, Arc<ManagerState>>,
) -> AppResult<Vec<DiagnosticItem>> {
    let shared = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let config = shared.config();
        let service = service_snapshot(&config, &shared);
        let database = database_snapshot(&config);
        let git = read_git_snapshot(&config, &shared.log_path.with_file_name("commands"), false);
        Ok(diagnostics(&config, &service, &database, &git))
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;

    #[cfg(windows)]
    #[test]
    fn hidden_command_does_not_attach_a_console() {
        let script = r#"Add-Type -MemberDefinition '[DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow();' -Name ConsoleProbe -Namespace Native; if ([Native.ConsoleProbe]::GetConsoleWindow() -eq [IntPtr]::Zero) { [Console]::Write('hidden') } else { [Console]::Error.Write('console attached'); exit 1 }"#;
        let output = hidden_command("powershell.exe")
            .args([
                "-NoLogo",
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                script,
            ])
            .output()
            .expect("PowerShell should be available on Windows");

        assert!(
            output.status.success(),
            "the child process attached a console: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(String::from_utf8_lossy(&output.stdout).trim(), "hidden");
    }

    #[test]
    fn update_requires_clean_main_and_fast_forward_remote() {
        assert!(update_decision("main", &[], 0, 2, true, true).0);
        assert!(!update_decision("main", &["file".into()], 0, 1, true, true).0);
        assert!(!update_decision("codex/feature", &[], 0, 1, true, true).0);
        assert!(!update_decision("main", &[], 1, 1, true, false).0);
        assert!(!update_decision("main", &[], 0, 1, false, true).0);
        assert!(!update_decision("main", &[], 0, 0, true, true).0);
    }

    #[test]
    fn only_the_configured_repository_remote_is_accepted() {
        assert!(is_expected_remote(
            "https://github.com/JIUfff111/sugrid-inventory.git"
        ));
        assert!(is_expected_remote(
            "git@github.com:JIUfff111/sugrid-inventory.git"
        ));
        assert!(!is_expected_remote("https://example.com/other.git"));
    }

    #[test]
    fn process_details_parser_rejects_empty_invalid_and_duplicate_records() {
        let valid = br#"[{"Name":"node.exe","ProcessId":42,"ParentProcessId":10,"CreationDate":"2026-11-11T10:00:00Z","ExecutablePath":"C:\\Program Files\\nodejs\\node.exe","CommandLine":"node next"}]"#;
        assert_eq!(parse_process_details(valid).unwrap().len(), 1);
        assert!(parse_process_details(b"[]").is_err());
        assert!(parse_process_details(br#"[{"Name":"node.exe"}]"#).is_err());
        assert!(parse_process_details(br#"[{"ProcessId":0}]"#).is_ok());
        assert!(parse_process_details(br#"[{"ProcessId":42},{"ProcessId":42}]"#).is_err());
        assert!(parse_process_details(br#"[{"ProcessId":"not-a-pid"}]"#).is_err());
    }

    #[test]
    fn listener_parser_rejects_incomplete_rows_and_deduplicates_ipv4_ipv6() {
        assert_eq!(
            parse_listening_endpoints(
                br#"[{"LocalPort":3000,"OwningProcess":42},{"LocalPort":3000,"OwningProcess":42}]"#
            )
            .unwrap(),
            vec![(3000, 42)]
        );
        assert!(parse_listening_endpoints(br#"[{"LocalPort":3000}]"#).is_err());
        assert!(parse_listening_endpoints(br#"[{"LocalPort":0,"OwningProcess":42}]"#).is_err());
    }

    fn temp_dir(label: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!("sugrid-manager-{label}-{}", now_millis()));
        fs::create_dir_all(&path).unwrap();
        path
    }

    fn test_login_server(body: &'static str) -> (u16, thread::JoinHandle<()>) {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0_u8; 512];
            let _ = stream.read(&mut request);
            use std::io::Write;
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            stream.write_all(response.as_bytes()).unwrap();
        });
        (port, server)
    }

    #[test]
    fn open_system_accepts_a_healthy_external_service_without_process_scanning() {
        let directory = temp_dir("open-system");
        fs::create_dir_all(directory.join(".git")).unwrap();
        fs::write(directory.join("package.json"), "{} ").unwrap();
        let (port, server) = test_login_server("<title>溯格 SUGRID</title>");
        let config = AppConfig {
            project_root: directory.to_string_lossy().into_owned(),
            database_path: "data/inventory.db".into(),
            port,
            host: "127.0.0.1".into(),
        };

        let url = system_login_url(&config).unwrap();
        server.join().unwrap();

        assert_eq!(url, format!("http://127.0.0.1:{port}/login"));
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn open_system_rejects_an_unrelated_server_on_the_configured_port() {
        let directory = temp_dir("open-system-unrelated");
        fs::create_dir_all(directory.join(".git")).unwrap();
        fs::write(directory.join("package.json"), "{} ").unwrap();
        let (port, server) = test_login_server("<title>Other local application</title>");
        let config = AppConfig {
            project_root: directory.to_string_lossy().into_owned(),
            database_path: "data/inventory.db".into(),
            port,
            host: "127.0.0.1".into(),
        };

        let error = system_login_url(&config).unwrap_err();
        server.join().unwrap();

        assert!(error.contains("没有检测到可识别的溯格库存登录页"));
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn online_backup_contains_current_rows_and_passes_checks() {
        let directory = temp_dir("backup-test");
        let source = directory.join("inventory.db");
        let backup = directory
            .join("backups")
            .join("inventory.before-manager-test.db");
        fs::create_dir_all(backup.parent().unwrap()).unwrap();
        let connection = Connection::open(&source).unwrap();
        connection.execute_batch("PRAGMA foreign_keys=ON; CREATE TABLE parents(id INTEGER PRIMARY KEY); CREATE TABLE children(id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES parents(id)); INSERT INTO parents VALUES(1); INSERT INTO children VALUES(1,1);").unwrap();
        drop(connection);
        online_backup(&source, &backup).unwrap();
        let (integrity, violations) = inspect_database(&backup).unwrap();
        assert_eq!(integrity, "ok");
        assert_eq!(violations, 0);
        let restored = Connection::open(&backup).unwrap();
        assert_eq!(
            restored
                .query_row("SELECT COUNT(*) FROM children", [], |row| row
                    .get::<_, u32>(0))
                .unwrap(),
            1
        );
        drop(restored);
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn restore_path_must_belong_to_database_backup_directory() {
        let directory = temp_dir("restore-path");
        let database = directory.join("inventory.db");
        let backup_dir = directory.join("backups");
        fs::create_dir_all(&backup_dir).unwrap();
        let good = backup_dir.join("inventory.before-manager-1.db");
        Connection::open(&good)
            .unwrap()
            .execute_batch("CREATE TABLE test(value TEXT);")
            .unwrap();
        assert!(validate_restore_target(&database, &good).is_ok());
        let external = directory.join("other.db");
        Connection::open(&external)
            .unwrap()
            .execute_batch("CREATE TABLE test(value TEXT);")
            .unwrap();
        assert!(validate_restore_target(&database, &external).is_err());
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn project_candidate_requires_both_next_and_the_configured_root() {
        let root = PathBuf::from(r"C:\SUGRID\inventory");
        let matching = ProcessDetails {
            name: Some("node.exe".into()),
            process_id: Some(20),
            parent_process_id: Some(10),
            creation_date: None,
            executable_path: Some(r"C:\Program Files\nodejs\node.exe".into()),
            command_line: Some(
                r#"node "C:\SUGRID\inventory\node_modules\next\dist\bin\next" start"#.into(),
            ),
        };
        let other_project = ProcessDetails {
            command_line: Some(
                r#"node "C:\OTHER\inventory\node_modules\next\dist\bin\next" start"#.into(),
            ),
            ..matching.clone()
        };
        assert!(is_project_candidate(Some(&matching), &root));
        assert!(!is_project_candidate(Some(&other_project), &root));
        assert!(!is_project_candidate(None, &root));
    }

    #[test]
    fn managed_process_requires_node_project_path_and_configured_port() {
        let root = PathBuf::from(r"C:\SUGRID\inventory");
        let matching = ProcessDetails {
            name: Some("node.exe".into()),
            process_id: Some(22),
            parent_process_id: Some(10),
            creation_date: None,
            executable_path: Some(r"C:\Program Files\nodejs\node.exe".into()),
            command_line: Some(
                r#"node "C:\SUGRID\inventory\node_modules\next\dist\bin\next" start --hostname 0.0.0.0 --port 3000"#.into(),
            ),
        };
        let wrong_port = ProcessDetails {
            command_line: Some(
                matching
                    .command_line
                    .as_deref()
                    .unwrap()
                    .replace("3000", "3001"),
            ),
            ..matching.clone()
        };
        let wrong_executable = ProcessDetails {
            executable_path: Some(r"C:\Windows\System32\cmd.exe".into()),
            ..matching.clone()
        };
        assert!(is_managed_process_candidate(Some(&matching), &root, 3000));
        assert!(!is_managed_process_candidate(
            Some(&wrong_port),
            &root,
            3000
        ));
        assert!(!is_managed_process_candidate(
            Some(&wrong_executable),
            &root,
            3000
        ));
    }

    #[test]
    fn project_process_scan_includes_candidates_before_they_bind_a_port() {
        let root = PathBuf::from(r"C:\SUGRID\inventory");
        let details = ProcessDetails {
            name: Some("node.exe".into()),
            process_id: Some(31),
            parent_process_id: Some(10),
            creation_date: Some("2026-11-11T10:00:00Z".into()),
            executable_path: Some(r"C:\Program Files\nodejs\node.exe".into()),
            command_line: Some(
                r#"node "C:\SUGRID\inventory\node_modules\next\dist\bin\next" start --port 3003"#
                    .into(),
            ),
        };
        let details_by_pid = [(31, details)].into_iter().collect();
        let processes = project_process_rows_from(&[], &details_by_pid, &root, 3000);
        assert_eq!(processes.len(), 1);
        assert_eq!(processes[0].process_id, 31);
        assert_eq!(processes[0].port, 3003);
        assert_eq!(processes[0].state, "项目进程未监听端口");
    }

    #[test]
    fn unverified_node_listener_is_visible_and_blocks_restore_without_becoming_an_inventory_label()
    {
        let root = PathBuf::from(r"C:\SUGRID\inventory");
        let node = ProcessDetails {
            name: Some("node.exe".into()),
            process_id: Some(61),
            parent_process_id: None,
            creation_date: None,
            executable_path: Some(r"C:\Program Files\nodejs\node.exe".into()),
            command_line: None,
        };
        let details = [(61, node)].into_iter().collect();
        let processes = project_process_rows_from(&[(3003, 61)], &details, &root, 3000);
        assert_eq!(processes.len(), 1);
        assert_eq!(processes[0].source, "Node 监听进程（待核验归属）");
        assert_eq!(processes[0].state, "待核验");
        assert!(restore_blocked_by_processes(&processes).is_some());
        assert!(start_blocked_by_processes(&processes).is_some());
    }

    #[test]
    fn relative_next_listener_is_reviewed_but_absolute_external_next_is_not() {
        let relative = ProcessDetails {
            name: Some("node.exe".into()),
            process_id: Some(63),
            parent_process_id: None,
            creation_date: None,
            executable_path: Some(r"C:\Program Files\nodejs\node.exe".into()),
            command_line: Some(
                r#"node.exe .\node_modules\next\dist\bin\next start --port 3003"#.into(),
            ),
        };
        assert!(is_unverified_node_listener(Some(&relative)));

        let external_root = temp_dir("external-next");
        let external_cli = external_root.join("node_modules/next/dist/bin/next");
        fs::create_dir_all(external_cli.parent().unwrap()).unwrap();
        fs::write(&external_cli, "").unwrap();
        let external = ProcessDetails {
            command_line: Some(format!(
                "node.exe \"{}\" start --port 3003",
                external_cli.display()
            )),
            ..relative
        };
        assert!(!is_unverified_node_listener(Some(&external)));
        fs::remove_dir_all(external_root).unwrap();
    }

    #[test]
    fn canonical_next_cli_path_matches_the_project_through_a_path_alias() {
        let directory = temp_dir("project-path-alias");
        let project = directory.join("inventory");
        let next_cli = project.join("node_modules/next/dist/bin/next");
        fs::create_dir_all(next_cli.parent().unwrap()).unwrap();
        fs::create_dir_all(project.join("alias-component")).unwrap();
        fs::write(&next_cli, "").unwrap();
        let root = project.canonicalize().unwrap();
        let alias_path = project
            .join("alias-component")
            .join("..")
            .join("node_modules/next/dist/bin/next");
        let command_line = format!("node.exe \"{}\" start --port 3003", alias_path.display());
        assert!(canonical_next_cli_is_within_project(&command_line, &root));
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn external_stop_requires_the_same_project_command_and_start_time() {
        let directory = temp_dir("external-stop-identity");
        let project = directory.join("inventory");
        let next_cli = project.join("node_modules/next/dist/bin/next");
        fs::create_dir_all(next_cli.parent().unwrap()).unwrap();
        fs::write(&next_cli, "").unwrap();
        let started_at = "2026-11-11T10:00:00.000000Z";
        let matching = ProcessDetails {
            name: Some("node.exe".into()),
            process_id: Some(91),
            parent_process_id: Some(10),
            creation_date: Some(started_at.into()),
            executable_path: Some(r"C:\Program Files\nodejs\node.exe".into()),
            command_line: Some(format!(
                "node.exe \"{}\" start --port 3003",
                next_cli.display()
            )),
        };
        let listeners = [(3003, 91)];
        assert!(is_stoppable_external_service(
            Some(&matching),
            &project,
            started_at,
            3003,
            &listeners
        ));
        assert!(!is_stoppable_external_service(
            Some(&matching),
            &project,
            "2026-11-11T10:00:01.000000Z",
            3003,
            &listeners
        ));
        assert!(!is_stoppable_external_service(
            Some(&matching),
            &project,
            started_at,
            3004,
            &listeners
        ));
        assert!(!is_stoppable_external_service(
            Some(&matching),
            &project,
            started_at,
            3003,
            &[(3003, 92)]
        ));

        let unrelated = ProcessDetails {
            command_line: Some(
                r"node.exe C:\other-project\node_modules\next\dist\bin\next start --port 3003"
                    .into(),
            ),
            ..matching.clone()
        };
        assert!(!is_stoppable_external_service(
            Some(&unrelated),
            &project,
            started_at,
            3003,
            &listeners
        ));

        let build_process = ProcessDetails {
            command_line: Some(format!(
                "node.exe \"{}\" build --port 3003",
                next_cli.display()
            )),
            ..matching.clone()
        };
        assert!(!is_stoppable_external_service(
            Some(&build_process),
            &project,
            started_at,
            3003,
            &listeners
        ));
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn next_service_commands_only_accept_start_or_dev_and_match_explicit_port() {
        assert!(next_service_uses_port(
            r#"node.exe .\node_modules\next\dist\bin\next start --port 3003"#,
            3003
        ));
        assert!(next_service_uses_port(
            r#"node.exe .\node_modules\next\dist\bin\next dev -p 3010"#,
            3010
        ));
        assert!(next_service_uses_port("node next start", 3000));
        assert!(!next_service_uses_port(
            r#"node.exe .\node_modules\next\dist\bin\next build"#,
            3003
        ));
        assert!(!next_service_uses_port(
            r#"node.exe .\node_modules\next\dist\bin\next start --port=3003"#,
            3004
        ));
    }

    #[cfg(windows)]
    #[test]
    fn external_stop_terminates_only_the_verified_temporary_project_service() {
        struct ChildGuard(Child);
        impl Drop for ChildGuard {
            fn drop(&mut self) {
                let _ = self.0.kill();
                let _ = self.0.wait();
            }
        }

        let directory = temp_dir("external-stop-runtime");
        let project = directory.join("inventory");
        let next_cli = project.join("node_modules/next/dist/bin/next");
        fs::create_dir_all(next_cli.parent().unwrap()).unwrap();
        fs::create_dir_all(project.join(".git")).unwrap();
        fs::write(project.join("package.json"), "{} ").unwrap();
        fs::write(
            &next_cli,
            "const http=require('node:http');const args=process.argv;const port=Number(args[args.indexOf('--port')+1]);http.createServer((_req,res)=>{res.writeHead(200);res.end('ok')}).listen(port,'127.0.0.1');",
        )
        .unwrap();
        let port = TcpListener::bind(("127.0.0.1", 0))
            .unwrap()
            .local_addr()
            .unwrap()
            .port();
        let node = find_executable("node.exe").unwrap();
        let child = hidden_command(node)
            .arg(&next_cli)
            .args(["start", "--port", &port.to_string()])
            .current_dir(&project)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let mut child = ChildGuard(child);

        for _ in 0..50 {
            if health_check(port) {
                break;
            }
            thread::sleep(Duration::from_millis(50));
        }
        assert!(
            health_check(port),
            "temporary project process failed to start"
        );
        let processes = project_process_rows_checked(&project, 3000).unwrap();
        let candidate = processes
            .iter()
            .find(|process| process.process_id == child.0.id() && process.port == port)
            .expect("temporary process should be recognized as this project");
        let started_at = candidate.started_at.clone();
        assert_ne!(started_at, "未知");

        terminate_external_service_checked(child.0.id(), port, &project, &started_at).unwrap();
        assert!(child.0.try_wait().unwrap().is_some());
        assert!(!health_check(port));
        fs::remove_dir_all(directory).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn canonical_next_cli_path_matches_the_project_through_a_directory_junction() {
        let directory = temp_dir("project-junction");
        let project = directory.join("inventory");
        let next_cli = project.join("node_modules/next/dist/bin/next");
        fs::create_dir_all(next_cli.parent().unwrap()).unwrap();
        fs::write(&next_cli, "").unwrap();
        let junction = directory.join("project-alias");
        let quote_path = |path: &Path| format!("'{}'", path.to_string_lossy().replace('\'', "''"));
        let command = format!(
            "New-Item -ItemType Junction -Path {} -Target {} | Out-Null",
            quote_path(&junction),
            quote_path(&project)
        );
        let output = hidden_command("powershell.exe")
            .args(["-NoLogo", "-NoProfile", "-NonInteractive", "-Command"])
            .arg(command)
            .output()
            .expect("PowerShell is available on Windows");
        assert!(
            output.status.success(),
            "could not create test junction: {}",
            String::from_utf8_lossy(&output.stderr)
        );

        let root = project.canonicalize().unwrap();
        let alias_path = junction.join("node_modules/next/dist/bin/next");
        let command_line = format!("node.exe \"{}\" start --port 3003", alias_path.display());
        assert!(canonical_next_cli_is_within_project(&command_line, &root));
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn unknown_non_node_listener_on_another_port_is_not_classified_as_inventory() {
        let root = PathBuf::from(r"C:\SUGRID\inventory");
        let processes =
            project_process_rows_from(&[(445, 72)], &std::collections::HashMap::new(), &root, 3000);
        assert!(processes.is_empty());
        assert!(start_blocked_by_processes(&processes).is_none());
    }

    #[test]
    fn service_start_refuses_an_existing_project_process_before_spawning() {
        let directory = temp_dir("start-blocked");
        let project = directory.join("project");
        fs::create_dir_all(project.join(".git")).unwrap();
        fs::create_dir_all(project.join("data")).unwrap();
        fs::write(project.join("package.json"), "{} ").unwrap();
        let port = TcpListener::bind(("127.0.0.1", 0))
            .unwrap()
            .local_addr()
            .unwrap()
            .port();
        let config = AppConfig {
            project_root: project.to_string_lossy().into_owned(),
            database_path: "data/inventory.db".into(),
            port,
            host: "127.0.0.1".into(),
        };
        let state = ManagerState::load(
            directory.join("manager.json"),
            directory.join("operations.jsonl"),
        );
        let candidate = ServiceProcess {
            process_id: 82,
            parent_process_id: Some(10),
            source: "外部项目候选（待核验）".into(),
            state: "待核验".into(),
            port: 3003,
            started_at: "未知".into(),
            executable_path: r"C:\Program Files\nodejs\node.exe".into(),
            command_line: r#"node .\node_modules\next\dist\bin\next start --port 3003"#.into(),
            managed: false,
        };
        let result =
            start_managed_service_with_scan(&config, &state, |_, _| Ok(vec![candidate.clone()]));
        assert!(result.is_err_and(|error| error.contains("PID 82")));
        assert!(lock(&state.managed_service).is_none());
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn service_start_rechecks_project_processes_immediately_before_spawning() {
        let directory = temp_dir("start-rescan");
        let project = directory.join("project");
        let next_cli = project.join("node_modules/next/dist/bin/next");
        fs::create_dir_all(next_cli.parent().unwrap()).unwrap();
        fs::create_dir_all(project.join(".next")).unwrap();
        fs::create_dir_all(project.join(".git")).unwrap();
        fs::create_dir_all(project.join("data")).unwrap();
        fs::write(project.join("package.json"), "{} ").unwrap();
        fs::write(&next_cli, "").unwrap();
        fs::write(project.join(".next/BUILD_ID"), "test").unwrap();
        let port = TcpListener::bind(("127.0.0.1", 0))
            .unwrap()
            .local_addr()
            .unwrap()
            .port();
        let config = AppConfig {
            project_root: project.to_string_lossy().into_owned(),
            database_path: "data/inventory.db".into(),
            port,
            host: "127.0.0.1".into(),
        };
        let state = ManagerState::load(
            directory.join("manager.json"),
            directory.join("operations.jsonl"),
        );
        let candidate = ServiceProcess {
            process_id: 83,
            parent_process_id: Some(10),
            source: "外部项目候选（待核验）".into(),
            state: "待核验".into(),
            port: 3004,
            started_at: "未知".into(),
            executable_path: r"C:\Program Files\nodejs\node.exe".into(),
            command_line: r#"node .\node_modules\next\dist\bin\next start --port 3004"#.into(),
            managed: false,
        };
        let scan_count = std::cell::Cell::new(0);
        let result = start_managed_service_with_scan(&config, &state, |_, _| {
            let scan = scan_count.get();
            scan_count.set(scan + 1);
            if scan == 0 {
                Ok(Vec::new())
            } else {
                Ok(vec![candidate.clone()])
            }
        });
        assert!(result.is_err_and(|error| error.contains("PID 83")));
        assert_eq!(scan_count.get(), 2);
        assert!(lock(&state.managed_service).is_none());
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn node_listener_without_command_line_is_reviewed_but_known_system_process_is_not_project() {
        let root = PathBuf::from(r"C:\SUGRID\inventory");
        let node = ProcessDetails {
            name: Some("node.exe".into()),
            process_id: Some(62),
            parent_process_id: Some(10),
            creation_date: None,
            executable_path: Some(r"C:\Program Files\nodejs\node.exe".into()),
            command_line: None,
        };
        let details = [(62, node)].into_iter().collect();
        let processes = project_process_rows_from(&[(3003, 62)], &details, &root, 3000);
        assert_eq!(processes.len(), 1);
        assert_eq!(processes[0].source, "Node 监听进程（待核验归属）");

        let system = ProcessDetails {
            name: Some("System".into()),
            process_id: Some(4),
            parent_process_id: None,
            creation_date: None,
            executable_path: None,
            command_line: None,
        };
        let details = [(4, system)].into_iter().collect();
        assert!(project_process_rows_from(&[(445, 4)], &details, &root, 3000).is_empty());
        assert_eq!(
            project_process_rows_from(&[(3000, 4)], &details, &root, 3000).len(),
            1,
            "配置端口冲突仍需显示，即使其为已识别的系统进程"
        );
    }

    #[test]
    fn manager_reloads_the_managed_process_identity_record() {
        let directory = temp_dir("managed-record");
        let config_path = directory.join("manager.json");
        let log_path = directory.join("operations.jsonl");
        let state = ManagerState::load(config_path.clone(), log_path.clone());
        let service = ManagedService {
            child: None,
            process_id: 4242,
            process_creation_time: 987654321,
            started_at: 123456,
            project_root: directory.join("project"),
            database_path: directory.join("data").join("inventory.db"),
            port: 3000,
            log_path: directory.join("service.log"),
        };
        state.persist_managed_service(Some(&service)).unwrap();
        state.persist_managed_service(Some(&service)).unwrap();

        let reopened = ManagerState::load(config_path, log_path);
        let managed = lock(&reopened.managed_service);
        let restored = managed.as_ref().unwrap();
        assert!(restored.child.is_none());
        assert_eq!(restored.process_id, service.process_id);
        assert_eq!(
            restored.process_creation_time,
            service.process_creation_time
        );
        assert_eq!(restored.project_root, service.project_root);
        assert_eq!(restored.database_path, service.database_path);
        assert_eq!(restored.port, service.port);
        drop(managed);
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn database_migration_command_can_receive_the_configured_database_path() {
        let directory = temp_dir("db-env");
        let database = directory.join("custom-data").join("inventory.db");
        let logs = directory.join("logs");
        let windows_dir = PathBuf::from(std::env::var_os("WINDIR").unwrap());
        let cmd = windows_dir.join("System32").join("cmd.exe");
        let output = run_command_with_env(
            &cmd,
            &["/d".into(), "/c".into(), "set INVENTORY_DB_PATH".into()],
            &directory,
            Duration::from_secs(10),
            &logs,
            Some(&database),
        )
        .unwrap();
        assert!(output.contains(&database.to_string_lossy().to_string()));
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn database_restore_is_blocked_by_a_project_service_on_another_port() {
        let process = ServiceProcess {
            process_id: 72,
            parent_process_id: Some(11),
            source: "外部项目候选（待核验）".into(),
            state: "待核验".into(),
            port: 3003,
            started_at: "2026-11-11T00:00:00Z".into(),
            executable_path: r"C:\Program Files\nodejs\node.exe".into(),
            command_line: "node next start".into(),
            managed: false,
        };
        assert!(restore_blocked_by_processes(&[process]).is_some());
        assert!(restore_blocked_by_processes(&[]).is_none());
    }

    #[cfg(windows)]
    #[test]
    fn windows_process_creation_time_can_be_read_for_the_current_process() {
        use windows_sys::Win32::{
            Foundation::CloseHandle, System::Threading::PROCESS_QUERY_LIMITED_INFORMATION,
        };

        let (handle, created) =
            process_creation_time(std::process::id(), PROCESS_QUERY_LIMITED_INFORMATION).unwrap();
        assert!(created > 0);
        unsafe { CloseHandle(handle) };
    }

    #[cfg(windows)]
    #[test]
    fn manager_reclaims_and_stops_its_service_after_restart() -> AppResult<()> {
        let directory = temp_dir("service-restart");
        let project = directory.join("project");
        let config_path = directory.join("manager.json");
        let log_path = directory.join("operations.jsonl");
        let database_path = directory.join("data").join("inventory.db");
        fs::create_dir_all(database_path.parent().unwrap()).map_err(|error| error.to_string())?;
        fs::create_dir_all(project.join(".git")).map_err(|error| error.to_string())?;
        fs::create_dir_all(project.join(".next")).map_err(|error| error.to_string())?;
        let next_cli = project
            .join("node_modules")
            .join("next")
            .join("dist")
            .join("bin")
            .join("next");
        fs::create_dir_all(next_cli.parent().unwrap()).map_err(|error| error.to_string())?;
        fs::write(
            project.join("package.json"),
            "{\"name\":\"manager-process-qa\"}",
        )
        .map_err(|error| error.to_string())?;
        fs::write(project.join(".next").join("BUILD_ID"), "qa")
            .map_err(|error| error.to_string())?;
        fs::write(
            &next_cli,
            "const http = require('node:http'); const args = process.argv; const port = Number(args[args.indexOf('--port') + 1]); http.createServer((_req, res) => { res.writeHead(200); res.end('ok'); }).listen(port, '127.0.0.1');",
        )
        .map_err(|error| error.to_string())?;
        let port = TcpListener::bind(("127.0.0.1", 0))
            .map_err(|error| error.to_string())?
            .local_addr()
            .map_err(|error| error.to_string())?
            .port();
        let config = AppConfig {
            project_root: project.to_string_lossy().into_owned(),
            database_path: database_path.to_string_lossy().into_owned(),
            port,
            host: "127.0.0.1".into(),
        };
        let config = normalize_config(config)?;
        let state = ManagerState::load(config_path.clone(), log_path.clone());
        let started = start_managed_service_with_scan(&config, &state, |_, _| Ok(Vec::new()));
        let started_healthy = started.as_ref().is_ok_and(|snapshot| snapshot.healthy);
        let started_detail = started
            .as_ref()
            .map(|snapshot| {
                format!(
                    "healthy={}, scan_complete={}, message={}",
                    snapshot.healthy, snapshot.scan_complete, snapshot.message
                )
            })
            .unwrap_or_else(|error| error.clone());
        let mut child_guard = {
            let mut managed = lock(&state.managed_service);
            managed.as_mut().and_then(|service| service.child.take())
        };
        drop(state);

        let reopened = ManagerState::load(config_path, log_path);
        let recovered_snapshot = service_snapshot(&config, &reopened);
        let recovered_identity = recovered_snapshot
            .processes
            .iter()
            .any(|process| process.managed && process.port == port);
        let stopped = stop_managed_service(&reopened, &config);
        let stopped_cleanly = stopped.is_ok();
        let stop_detail = match &stopped {
            Ok(message) => message.clone(),
            Err(error) => error.clone(),
        };
        let still_running = listening_endpoints()
            .map(|listeners| {
                listeners
                    .iter()
                    .any(|(listener_port, _)| *listener_port == port)
            })
            .unwrap_or(true);
        if still_running {
            if let Some(child) = child_guard.as_mut() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
        let still_running_after_cleanup = listening_endpoints()
            .map(|listeners| {
                listeners
                    .iter()
                    .any(|(listener_port, _)| *listener_port == port)
            })
            .unwrap_or(true);
        fs::remove_dir_all(directory).map_err(|error| error.to_string())?;

        assert!(
            started_healthy,
            "临时项目服务未通过 HTTP 健康检查：{started_detail}"
        );
        assert!(recovered_identity, "管理器重启后未恢复已登记的项目进程身份");
        assert!(
            stopped_cleanly,
            "管理器重启后未能安全停止已登记的服务：{stop_detail}"
        );
        assert!(!still_running, "管理器停止后随机端口仍有监听服务");
        assert!(
            !still_running_after_cleanup,
            "测试清理后的随机端口仍有监听服务"
        );
        Ok(())
    }

    #[test]
    fn configuration_rejects_unapproved_host_and_normalizes_relative_database_path() {
        let directory = temp_dir("config-test");
        fs::write(directory.join("package.json"), "{}").unwrap();
        fs::create_dir(directory.join(".git")).unwrap();
        fs::create_dir(directory.join("data")).unwrap();
        let valid = normalize_config(AppConfig {
            project_root: directory.to_string_lossy().into_owned(),
            database_path: "data/test.db".into(),
            port: 3000,
            host: "127.0.0.1".into(),
        })
        .unwrap();
        assert_eq!(
            PathBuf::from(valid.database_path),
            directory
                .canonicalize()
                .unwrap()
                .join("data")
                .join("test.db")
        );
        let invalid = normalize_config(AppConfig {
            project_root: directory.to_string_lossy().into_owned(),
            database_path: "data/test.db".into(),
            port: 3000,
            host: "0.0.0.0; arbitrary-command".into(),
        });
        assert!(invalid.is_err());
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn restore_replaces_a_database_only_after_the_snapshot_is_valid() {
        let directory = temp_dir("restore-test");
        let target = directory.join("inventory.db");
        let backup = directory.join("inventory.backup.db");
        Connection::open(&target)
            .unwrap()
            .execute_batch(
                "CREATE TABLE sample(value TEXT); INSERT INTO sample VALUES ('current');",
            )
            .unwrap();
        Connection::open(&backup)
            .unwrap()
            .execute_batch("CREATE TABLE sample(value TEXT); INSERT INTO sample VALUES ('backup');")
            .unwrap();
        replace_database(&target, &backup).unwrap();
        let connection = Connection::open(&target).unwrap();
        let value: String = connection
            .query_row("SELECT value FROM sample", [], |row| row.get(0))
            .unwrap();
        assert_eq!(value, "backup");
        drop(connection);
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn restore_rechecks_processes_after_safety_backup_and_preserves_current_database() {
        let directory = temp_dir("restore-rescan");
        let database = directory.join("inventory.db");
        Connection::open(&database)
            .unwrap()
            .execute_batch("CREATE TABLE sample(value TEXT); INSERT INTO sample VALUES ('before');")
            .unwrap();
        let selected_backup = create_backup_file(&database).unwrap();
        Connection::open(&database)
            .unwrap()
            .execute("UPDATE sample SET value='current'", [])
            .unwrap();

        let candidate = ServiceProcess {
            process_id: 84,
            parent_process_id: Some(10),
            source: "外部项目候选（待核验）".into(),
            state: "待核验".into(),
            port: 3005,
            started_at: "未知".into(),
            executable_path: r"C:\Program Files\nodejs\node.exe".into(),
            command_line: r#"node .\node_modules\next\dist\bin\next start --port 3005"#.into(),
            managed: false,
        };
        let scan_count = std::cell::Cell::new(0);
        let result = restore_database_with_process_check(
            &database,
            &selected_backup,
            &directory,
            3000,
            |_, _| {
                let scan = scan_count.get();
                scan_count.set(scan + 1);
                if scan == 0 {
                    Ok(Vec::new())
                } else {
                    Ok(vec![candidate.clone()])
                }
            },
        );
        let error = result.unwrap_err();
        assert!(error.contains("恢复前备份保留于"));
        assert_eq!(scan_count.get(), 2);
        let current: String = Connection::open(&database)
            .unwrap()
            .query_row("SELECT value FROM sample", [], |row| row.get(0))
            .unwrap();
        assert_eq!(current, "current");
        assert!(
            list_backup_files(&database)
                .iter()
                .any(|backup| backup.verified)
        );
        fs::remove_dir_all(directory).unwrap();
    }
}
