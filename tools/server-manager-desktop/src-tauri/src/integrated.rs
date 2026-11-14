use serde::{Deserialize, Serialize};
use sha2::Digest;
use std::{
    fs,
    io::{Read, Write},
    net::TcpStream,
    path::{Path, PathBuf},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};
use windows_service::{
    Error as WindowsServiceError,
    service::{ServiceAccess, ServiceState},
    service_manager::{ServiceManager, ServiceManagerAccess},
};

const SERVICE_NAME: &str = "SUGRIDInventory";
const PORT: u16 = 3000;

type AppResult<T> = Result<T, String>;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupSummary {
    pub name: String,
    pub size: u64,
    pub modified_at: u64,
    pub verified: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IntegratedDashboard {
    pub manager_version: String,
    pub service_host_version: Option<String>,
    pub inventory_version: Option<String>,
    pub updater_available: bool,
    pub can_manage: bool,
    pub service_installed: bool,
    pub service_state: String,
    pub service_pid: Option<u32>,
    pub healthy: bool,
    pub service_url: String,
    pub port: u16,
    pub database_path: String,
    pub database_exists: bool,
    pub database_integrity: String,
    pub backup_directory: String,
    pub backups: Vec<BackupSummary>,
    pub status_message: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IntegratedUpdate {
    pub current_version: String,
    pub latest_version: Option<String>,
    pub release_url: Option<String>,
    pub release_notes: Option<String>,
    pub installer_available: bool,
    pub update_available: bool,
    pub message: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InventoryUpdate {
    pub current_version: Option<String>,
    pub latest_version: String,
    pub release_url: String,
    pub release_notes: Option<String>,
    pub update_available: bool,
    pub message: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InventoryCache {
    pub state: String,
    pub version: Option<String>,
    pub message: String,
}

#[derive(Clone, Deserialize)]
struct GithubRelease {
    tag_name: String,
    html_url: String,
    body: Option<String>,
    draft: bool,
    prerelease: bool,
    assets: Vec<GithubAsset>,
}

#[derive(Clone, Deserialize)]
struct GithubAsset {
    name: String,
    browser_download_url: String,
    size: u64,
    digest: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct UpdaterStatus {
    pub available: bool,
    pub can_manage: bool,
    pub updater_protocol: Option<u32>,
    pub inventory_version: Option<String>,
    pub operation_id: Option<String>,
    pub stage: Option<String>,
    pub state: Option<String>,
    pub backup_name: Option<String>,
    pub error: Option<String>,
}

#[derive(Deserialize)]
struct UpdaterResponse {
    id: u64,
    ok: bool,
    result: Option<UpdaterStatus>,
    error: Option<String>,
}

#[cfg(windows)]
fn open_updater_pipe() -> AppResult<fs::File> {
    use std::os::windows::{ffi::OsStrExt, io::FromRawHandle};
    use windows_sys::Win32::{
        Foundation::{GetLastError, INVALID_HANDLE_VALUE},
        Storage::FileSystem::{CreateFileW, OPEN_EXISTING},
        System::Pipes::GetNamedPipeServerProcessId,
    };

    let pipe_name: Vec<u16> = std::ffi::OsStr::new(r"\\.\pipe\SUGRIDInventoryUpdater-v1")
        .encode_wide()
        .chain(Some(0))
        .collect();
    // FILE_GENERIC_READ plus WRITE_DATA and WRITE_ATTRIBUTES. GENERIC_WRITE
    // also grants FILE_CREATE_PIPE_INSTANCE, which clients must not receive.
    let handle = unsafe {
        CreateFileW(
            pipe_name.as_ptr(),
            0x0012_0089 | 0x0002 | 0x0100,
            0,
            std::ptr::null(),
            OPEN_EXISTING,
            0,
            std::ptr::null_mut(),
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        return Err(format!(
            "库存更新服务不可用，Windows 错误码 {}。",
            unsafe { GetLastError() }
        ));
    }
    let mut pipe_server_pid = 0u32;
    if unsafe { GetNamedPipeServerProcessId(handle, &mut pipe_server_pid) } == 0 {
        unsafe { windows_sys::Win32::Foundation::CloseHandle(handle) };
        return Err("无法核实库存更新服务进程。".into());
    }
    let expected_pid = ServiceManager::local_computer(None::<&str>, ServiceManagerAccess::CONNECT)
        .and_then(|manager| {
            manager.open_service("SUGRIDInventoryUpdater", ServiceAccess::QUERY_STATUS)
        })
        .and_then(|service| service.query_status());
    if !expected_pid.is_ok_and(|status| {
        status.current_state == ServiceState::Running
            && status.process_id == Some(pipe_server_pid)
    }) {
        unsafe { windows_sys::Win32::Foundation::CloseHandle(handle) };
        return Err("库存更新管道不属于已启动的 Windows 更新服务。".into());
    }
    Ok(unsafe { fs::File::from_raw_handle(handle) })
}

#[cfg(windows)]
fn read_updater_response(pipe: &mut fs::File) -> AppResult<Vec<u8>> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::System::Pipes::{PIPE_NOWAIT, SetNamedPipeHandleState};

    let mode = PIPE_NOWAIT;
    if unsafe {
        SetNamedPipeHandleState(pipe.as_raw_handle() as _, &mode, std::ptr::null(), std::ptr::null())
    } == 0
    {
        return Err("无法设置库存更新服务响应超时。".into());
    }
    let deadline = Instant::now() + Duration::from_secs(5);
    let mut response = Vec::with_capacity(1024);
    let mut chunk = [0u8; 4096];
    loop {
        if Instant::now() >= deadline {
            return Err("库存更新服务响应超时。".into());
        }
        if response.len() >= 64 * 1024 {
            return Err("库存更新服务响应过大。".into());
        }
        let remaining = 64 * 1024 - response.len();
        let read_limit = remaining.min(chunk.len());
        match pipe.read(&mut chunk[..read_limit]) {
            Ok(0) => std::thread::sleep(Duration::from_millis(10)),
            Ok(count) => {
                response.extend_from_slice(&chunk[..count]);
                if let Some(newline) = response.iter().position(|byte| *byte == b'\n') {
                    if newline + 1 != response.len() {
                        return Err("库存更新服务响应包含额外数据。".into());
                    }
                    return Ok(response);
                }
            }
            Err(error)
                if error.raw_os_error() == Some(232)
                    || error.kind() == std::io::ErrorKind::WouldBlock =>
            {
                std::thread::sleep(Duration::from_millis(10));
            }
            Err(error) => return Err(format!("无法读取库存更新服务响应：{error}")),
        }
    }
}

#[cfg(windows)]
fn updater_request(command: &str, fields: serde_json::Value) -> AppResult<UpdaterStatus> {
    let mut request = serde_json::Map::new();
    request.insert("id".into(), serde_json::json!(1));
    request.insert("command".into(), serde_json::json!(command));
    if let serde_json::Value::Object(fields) = fields {
        request.extend(fields);
    }
    let mut pipe = open_updater_pipe()?;
    let mut bytes = serde_json::to_vec(&request).map_err(|error| error.to_string())?;
    bytes.push(b'\n');
    pipe.write_all(&bytes)
        .map_err(|error| format!("无法向库存更新服务发送请求：{error}"))?;
    pipe.flush()
        .map_err(|error| format!("无法提交库存更新请求：{error}"))?;
    let response_line = read_updater_response(&mut pipe)?;
    let response: UpdaterResponse = serde_json::from_slice(&response_line)
        .map_err(|error| format!("库存更新服务响应无效：{error}"))?;
    if response.id != 1 {
        return Err("库存更新服务响应编号不匹配。".into());
    }
    if !response.ok {
        return Err(response
            .error
            .unwrap_or_else(|| "库存更新服务拒绝此操作。".into()));
    }
    let mut result = response.result.unwrap_or_default();
    result.available = true;
    Ok(result)
}

#[cfg(not(windows))]
fn updater_request(_command: &str, _fields: serde_json::Value) -> AppResult<UpdaterStatus> {
    Err("库存更新服务仅支持 Windows。".into())
}

fn updater_status() -> AppResult<UpdaterStatus> {
    updater_request("status", serde_json::json!({}))
}

fn program_data_root() -> AppResult<PathBuf> {
    let root = std::env::var_os("PROGRAMDATA")
        .map(PathBuf::from)
        .ok_or("Windows did not provide the ProgramData directory.")?;
    Ok(root.join("SUGRID").join("Inventory"))
}

fn database_path() -> AppResult<PathBuf> {
    Ok(program_data_root()?.join("data").join("inventory.db"))
}

fn backup_directory() -> AppResult<PathBuf> {
    Ok(program_data_root()?.join("backups"))
}

fn service_instance_path() -> AppResult<PathBuf> {
    Ok(program_data_root()?
        .join("logs")
        .join("service-instance.txt"))
}

fn service_manager(access: ServiceManagerAccess) -> AppResult<ServiceManager> {
    ServiceManager::local_computer(None::<&str>, access)
        .map_err(|error| format!("Cannot access Windows Service Control Manager: {error}"))
}

fn service_is_missing(error: &WindowsServiceError) -> bool {
    matches!(error, WindowsServiceError::Winapi(error) if error.raw_os_error() == Some(1060))
}

fn read_backup_manifest() -> Vec<BackupSummary> {
    let Ok(path) = backup_directory().map(|directory| directory.join("manifest.json")) else {
        return Vec::new();
    };
    fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Vec<BackupSummary>>(&bytes).ok())
        .unwrap_or_default()
        .into_iter()
        .filter(|backup| safe_backup_name(&backup.name))
        .collect()
}

fn safe_backup_name(name: &str) -> bool {
    let path = Path::new(name);
    let generated_backup = name
        .strip_suffix(".db")
        .is_some_and(|stem| stem.starts_with("inventory.") && stem.len() > "inventory.".len());
    path.file_name().is_some_and(|file_name| file_name == name)
        && path.extension().is_some_and(|extension| extension == "db")
        && generated_backup
}

fn health_check(instance: &str) -> bool {
    let Ok(mut stream) = TcpStream::connect_timeout(
        &format!("127.0.0.1:{PORT}").parse().unwrap(),
        Duration::from_millis(500),
    ) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
    if stream
        .write_all(b"GET /api/health HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n")
        .is_err()
    {
        return false;
    }
    let mut response = String::new();
    stream.take(64 * 1024).read_to_string(&mut response).is_ok()
        && (response.starts_with("HTTP/1.1 200") || response.starts_with("HTTP/1.0 200"))
        && response.contains("\"database\":\"ready\"")
        && response.contains(&format!("\"serviceInstance\":\"{instance}\""))
}

fn service_status() -> AppResult<(bool, String, Option<u32>, bool)> {
    let manager = service_manager(ServiceManagerAccess::CONNECT)?;
    let service = match manager.open_service(SERVICE_NAME, ServiceAccess::QUERY_STATUS) {
        Ok(service) => service,
        Err(error) if service_is_missing(&error) => {
            return Ok((false, "not_installed".into(), None, false));
        }
        Err(error) => return Err(format!("Cannot query inventory service: {error}")),
    };
    let status = service
        .query_status()
        .map_err(|error| format!("Cannot read inventory service status: {error}"))?;
    let instance = fs::read_to_string(service_instance_path()?).unwrap_or_default();
    let healthy = status.current_state == ServiceState::Running
        && !instance.trim().is_empty()
        && health_check(instance.trim());
    let state = match status.current_state {
        ServiceState::Running => "running",
        ServiceState::Stopped => "stopped",
        ServiceState::StartPending | ServiceState::ContinuePending => "starting",
        ServiceState::StopPending | ServiceState::PausePending => "stopping",
        ServiceState::Paused => "paused",
    };
    Ok((true, state.into(), status.process_id, healthy))
}

fn read_dashboard() -> AppResult<IntegratedDashboard> {
    let database = database_path()?;
    let backups = backup_directory()?;
    let updater = updater_status().ok();
    let (service_installed, service_state, service_pid, healthy) = service_status()?;
    let status_message = if !service_installed {
        "尚未安装 Windows 服务。请使用一体化安装包完成安装。".into()
    } else if service_state == "running" && healthy {
        "库存服务运行正常，数据库连接检查通过。".into()
    } else if service_state == "running" {
        "Windows 服务正在运行，但库存网页或数据库健康检查未通过。".into()
    } else {
        "库存服务当前已停止。".into()
    };
    Ok(IntegratedDashboard {
        manager_version: env!("CARGO_PKG_VERSION").to_string(),
        service_host_version: fs::read(program_data_root()?.join("app").join("host-version.json"))
            .ok()
            .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
            .and_then(|value| {
                value
                    .get("version")
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_owned)
            }),
        inventory_version: updater
            .as_ref()
            .and_then(|status| status.inventory_version.clone()),
        updater_available: updater.as_ref().is_some_and(|status| status.available),
        can_manage: updater.as_ref().is_some_and(|status| status.can_manage),
        service_installed,
        service_state,
        service_pid,
        healthy,
        service_url: format!("http://127.0.0.1:{PORT}"),
        port: PORT,
        database_path: database.display().to_string(),
        database_exists: database.is_file(),
        database_integrity: if healthy { "ok" } else { "unknown" }.into(),
        backup_directory: backups.display().to_string(),
        backups: read_backup_manifest(),
        status_message,
    })
}

async fn releases() -> AppResult<Vec<GithubRelease>> {
    reqwest::Client::builder()
        .user_agent("SUGRID-Server-Manager")
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|error| error.to_string())?
        .get("https://api.github.com/repos/JIUfff111/sugrid-inventory/releases?per_page=100")
        .send()
        .await
        .map_err(|error| format!("Cannot check GitHub releases: {error}"))?
        .error_for_status()
        .map_err(|error| format!("GitHub release check failed: {error}"))?
        .json::<Vec<GithubRelease>>()
        .await
        .map_err(|error| format!("GitHub release data is invalid: {error}"))
}

async fn latest_manager_release() -> AppResult<(GithubRelease, GithubAsset)> {
    let release = releases()
        .await?
        .into_iter()
        .filter(|release| !release.draft && !release.prerelease)
        .filter(|release| {
            release.tag_name.starts_with("manager-v") || release.tag_name.starts_with('v')
        })
        .filter_map(|release| {
            let version = release
                .tag_name
                .strip_prefix("manager-v")
                .unwrap_or_else(|| release.tag_name.trim_start_matches('v'));
            semver::Version::parse(version)
                .ok()
                .map(|version| (version, release))
        })
        .max_by(|left, right| left.0.cmp(&right.0))
        .map(|(_, release)| release)
        .ok_or("GitHub 尚无正式管理器版本。")?;
    let installer = release
        .assets
        .iter()
        .find(|asset| asset.name == "SUGRID-Server-Manager-Setup.exe")
        .cloned()
        .ok_or("The latest GitHub release does not include SUGRID-Server-Manager-Setup.exe")?;
    if !installer
        .browser_download_url
        .starts_with("https://github.com/JIUfff111/sugrid-inventory/releases/download/")
    {
        return Err(
            "The installer download URL is outside the configured GitHub repository.".into(),
        );
    }
    Ok((release, installer))
}

async fn latest_inventory_release() -> AppResult<(GithubRelease, GithubAsset)> {
    let release = releases()
        .await?
        .into_iter()
        .filter(|release| !release.draft && !release.prerelease)
        .filter_map(|release| {
            let version = release.tag_name.strip_prefix("inventory-v")?;
            semver::Version::parse(version)
                .ok()
                .filter(|version| version.pre.is_empty())
                .map(|version| (version, release))
        })
        .max_by(|left, right| left.0.cmp(&right.0))
        .map(|(_, release)| release)
        .ok_or("GitHub 尚无已发布的库存版本。")?;
    let asset = release
        .assets
        .iter()
        .find(|asset| asset.name == "sugrid-inventory-windows-x64.zip")
        .cloned()
        .ok_or("库存版本缺少 Windows x64 发布包。")?;
    if !asset
        .browser_download_url
        .starts_with("https://github.com/JIUfff111/sugrid-inventory/releases/download/")
    {
        return Err("库存包下载地址不属于当前项目仓库。".into());
    }
    Ok((release, asset))
}

fn cache_result(
    state: &str,
    version: Option<String>,
    message: impl Into<String>,
) -> InventoryCache {
    InventoryCache {
        state: state.into(),
        version,
        message: message.into(),
    }
}

fn inventory_cache_directory(app: &AppHandle) -> AppResult<PathBuf> {
    app.path()
        .app_local_data_dir()
        .map(|path| path.join("inventory-downloads"))
        .map_err(|error| format!("无法定位库存包缓存目录：{error}"))
}

fn release_package_identity(
    release: &GithubRelease,
    asset: &GithubAsset,
) -> AppResult<(String, String)> {
    let version = release
        .tag_name
        .strip_prefix("inventory-v")
        .ok_or("库存 Release 标签无效。")?;
    let parsed = semver::Version::parse(version).map_err(|_| "库存 Release 版本无效。")?;
    if !parsed.pre.is_empty() {
        return Err("候选库存版本不能作为正式包缓存。".into());
    }
    if asset.size == 0 || asset.size > 1024 * 1024 * 1024 {
        return Err("库存包大小不符合限制。".into());
    }
    let digest = asset
        .digest
        .as_deref()
        .and_then(|value| value.strip_prefix("sha256:"))
        .ok_or("库存 Release 没有 SHA-256 摘要，拒绝缓存。")?;
    if digest.len() != 64
        || !digest
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err("库存 Release 的 SHA-256 摘要无效。".into());
    }
    Ok((version.to_owned(), digest.to_owned()))
}

fn cache_path(directory: &Path, version: &str, digest: &str) -> PathBuf {
    directory.join(format!("inventory-{version}-{digest}.zip"))
}

fn parse_cache_filename(name: &str) -> Option<(semver::Version, String)> {
    let body = name.strip_prefix("inventory-")?.strip_suffix(".zip")?;
    let (version, digest) = body.rsplit_once('-')?;
    if digest.len() != 64
        || !digest
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return None;
    }
    let version = semver::Version::parse(version).ok()?;
    if !version.pre.is_empty() {
        return None;
    }
    Some((version, digest.to_owned()))
}

fn unique_cache_suffix() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    format!("{}-{nanos}", std::process::id())
}

fn verify_cached_package(path: &Path, version: &str, digest: &str) -> AppResult<()> {
    let key = crate::updater_package::embedded_public_key()
        .map_err(|_| "管理器未配置有效的库存发布公钥，无法验证缓存包。")?;
    let directory = path.parent().ok_or("库存包缓存路径无效。")?;
    let extraction = directory.join(format!(".verify-{}", unique_cache_suffix()));
    let result =
        crate::updater_package::verify_and_extract(path, &extraction, key).and_then(|package| {
            if package.manifest.version != version || package.package_sha256 != digest {
                Err("库存包版本或 SHA-256 与发布记录不符。".into())
            } else {
                Ok(())
            }
        });
    let _ = fs::remove_dir_all(extraction);
    result
}

async fn verify_cached_package_async(
    path: PathBuf,
    version: String,
    digest: String,
) -> AppResult<()> {
    tauri::async_runtime::spawn_blocking(move || verify_cached_package(&path, &version, &digest))
        .await
        .map_err(|error| format!("库存包校验任务失败：{error}"))?
}

fn cached_inventory(directory: &Path) -> InventoryCache {
    let entries = match fs::read_dir(directory) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return cache_result("empty", None, "本机尚无已验证的库存包缓存。");
        }
        Err(error) => return cache_result("failed", None, format!("无法读取库存包缓存：{error}")),
    };
    let mut candidates = entries
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_file()))
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().into_owned();
            parse_cache_filename(&name).map(|(version, digest)| (version, digest, entry.path()))
        })
        .collect::<Vec<_>>();
    candidates.sort_by(|left, right| right.0.cmp(&left.0));
    if candidates.is_empty() {
        return cache_result("empty", None, "本机尚无已验证的库存包缓存。");
    }
    let mut last_error = String::new();
    for (version, digest, path) in candidates {
        match verify_cached_package(&path, &version.to_string(), &digest) {
            Ok(()) => {
                return cache_result(
                    "cached",
                    Some(version.to_string()),
                    format!("库存版本 {version} 已缓存，签名与文件清单校验通过。"),
                );
            }
            Err(error) => last_error = error,
        }
    }
    cache_result(
        "failed",
        None,
        format!("已有库存包缓存校验失败：{last_error}"),
    )
}

fn prune_inventory_cache(directory: &Path, keep: &Path) -> AppResult<()> {
    for entry in fs::read_dir(directory).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        if entry.path() == keep {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        let kind = entry.file_type().map_err(|error| error.to_string())?;
        if kind.is_file() && name.starts_with("inventory-") && name.ends_with(".zip") {
            fs::remove_file(entry.path())
                .map_err(|error| format!("无法清理旧库存包缓存：{error}"))?;
        } else if (kind.is_file() && name.starts_with("inventory-") && name.ends_with(".part"))
            || (kind.is_dir() && name.starts_with(".verify-"))
        {
            let stale = entry
                .metadata()
                .and_then(|metadata| metadata.modified())
                .ok()
                .and_then(|modified| SystemTime::now().duration_since(modified).ok())
                .is_some_and(|age| age >= Duration::from_secs(24 * 60 * 60));
            if stale && kind.is_file() {
                let _ = fs::remove_file(entry.path());
            } else if stale && kind.is_dir() {
                let _ = fs::remove_dir_all(entry.path());
            }
        }
    }
    Ok(())
}

async fn download_inventory_package(
    asset: &GithubAsset,
    temporary: &Path,
    digest: &str,
) -> AppResult<()> {
    let client = reqwest::Client::builder()
        .user_agent("SUGRID-Server-Manager")
        .timeout(Duration::from_secs(600))
        .build()
        .map_err(|error| error.to_string())?;
    let mut response = client
        .get(&asset.browser_download_url)
        .send()
        .await
        .map_err(|error| format!("无法连接库存包下载地址：{error}"))?
        .error_for_status()
        .map_err(|error| format!("库存包下载失败：{error}"))?;
    let mut output = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(temporary)
        .map_err(|error| format!("无法建立库存包临时文件：{error}"))?;
    let mut hasher = sha2::Sha256::new();
    let mut count = 0u64;
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| format!("库存包下载中断：{error}"))?
    {
        count += chunk.len() as u64;
        if count > asset.size {
            return Err("库存包下载大小超过发布记录。".into());
        }
        output
            .write_all(&chunk)
            .map_err(|error| error.to_string())?;
        hasher.update(&chunk);
    }
    output.sync_all().map_err(|error| error.to_string())?;
    if count != asset.size || hex::encode(hasher.finalize()) != digest {
        return Err("库存包的大小或 SHA-256 与发布记录不符。".into());
    }
    Ok(())
}

async fn ensure_inventory_cached(
    app: &AppHandle,
    release: &GithubRelease,
    asset: &GithubAsset,
) -> AppResult<PathBuf> {
    let (version, digest) = release_package_identity(release, asset)?;
    crate::updater_package::embedded_public_key()
        .map_err(|_| "管理器未配置有效的库存发布公钥，拒绝缓存正式包。")?;
    let directory = inventory_cache_directory(app)?;
    fs::create_dir_all(&directory).map_err(|error| format!("无法建立库存包缓存目录：{error}"))?;
    let cached = cache_path(&directory, &version, &digest);
    if cached.is_file() {
        if verify_cached_package_async(cached.clone(), version.clone(), digest.clone())
            .await
            .is_ok()
        {
            prune_inventory_cache(&directory, &cached)?;
            return Ok(cached);
        }
        fs::remove_file(&cached).map_err(|error| format!("无法替换失效库存包缓存：{error}"))?;
    }
    let temporary = directory.join(format!(
        "inventory-{version}-{}.part",
        unique_cache_suffix()
    ));
    let result = async {
        download_inventory_package(asset, &temporary, &digest).await?;
        verify_cached_package_async(temporary.clone(), version, digest).await?;
        fs::rename(&temporary, &cached)
            .map_err(|error| format!("无法保存已验证库存包：{error}"))?;
        prune_inventory_cache(&directory, &cached)?;
        Ok(cached)
    }
    .await;
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

fn update_available(latest: &str) -> bool {
    let current = env!("CARGO_PKG_VERSION");
    let current = semver::Version::parse(current);
    let latest = semver::Version::parse(
        latest
            .strip_prefix("manager-v")
            .unwrap_or_else(|| latest.trim_start_matches('v')),
    );
    match (current, latest) {
        (Ok(current), Ok(latest)) => latest > current,
        _ => false,
    }
}

#[tauri::command]
pub async fn integrated_check_update() -> AppResult<IntegratedUpdate> {
    let current_version = env!("CARGO_PKG_VERSION").to_string();
    let (release, _) = latest_manager_release().await?;
    let update_available = update_available(&release.tag_name);
    Ok(IntegratedUpdate {
        current_version,
        latest_version: Some(release.tag_name.clone()),
        release_url: Some(release.html_url),
        release_notes: release.body,
        installer_available: true,
        update_available,
        message: if update_available {
            format!(
                "发现管理器版本 {}，可获取独立安装包更新。",
                release.tag_name
            )
        } else {
            "当前管理器已是最新版本。".into()
        },
    })
}

#[tauri::command]
pub async fn integrated_check_inventory_update() -> AppResult<InventoryUpdate> {
    let status = updater_status().ok();
    let current_version = status.and_then(|status| status.inventory_version);
    let (release, _) = latest_inventory_release().await?;
    let latest_version = release
        .tag_name
        .strip_prefix("inventory-v")
        .ok_or("库存 Release 标签无效。")?
        .to_string();
    let update_available = match current_version.as_deref() {
        Some(current) => match (
            semver::Version::parse(current),
            semver::Version::parse(&latest_version),
        ) {
            (Ok(current), Ok(latest)) => latest > current,
            _ => false,
        },
        None => true,
    };
    Ok(InventoryUpdate {
        current_version,
        latest_version: latest_version.clone(),
        release_url: release.html_url,
        release_notes: release.body,
        update_available,
        message: if update_available {
            format!("库存版本 {latest_version} 已发布，可由维护账号安装。")
        } else {
            "当前库存系统已是最新正式版本。".into()
        },
    })
}

async fn read_local_inventory_cache(app: &AppHandle) -> InventoryCache {
    let directory = match inventory_cache_directory(app) {
        Ok(directory) => directory,
        Err(error) => return cache_result("failed", None, error),
    };
    tauri::async_runtime::spawn_blocking(move || cached_inventory(&directory))
        .await
        .unwrap_or_else(|error| cache_result("failed", None, format!("缓存校验任务失败：{error}")))
}

#[tauri::command]
pub async fn integrated_cached_inventory(app: AppHandle) -> InventoryCache {
    read_local_inventory_cache(&app).await
}

#[tauri::command]
pub async fn integrated_prefetch_inventory(app: AppHandle) -> InventoryCache {
    let (release, asset) = match latest_inventory_release().await {
        Ok(value) => value,
        Err(error) => {
            let local = read_local_inventory_cache(&app).await;
            let offline = error.starts_with("Cannot check GitHub releases:");
            let state = if offline { "offline" } else { "failed" };
            let detail = if local.version.is_some() {
                format!(
                    "无法查询正式库存版本：{error}。本机已验证缓存版本 {} 可供离线安装。",
                    local.version.as_deref().unwrap_or_default()
                )
            } else {
                format!("无法查询正式库存版本：{error}。{}", local.message)
            };
            return cache_result(state, local.version, detail);
        }
    };
    let version = release
        .tag_name
        .trim_start_matches("inventory-v")
        .to_owned();
    match ensure_inventory_cached(&app, &release, &asset).await {
        Ok(_) => cache_result(
            "cached",
            Some(version.clone()),
            format!("正式库存版本 {version} 已缓存，签名与文件清单校验通过。"),
        ),
        Err(error) => {
            let local = read_local_inventory_cache(&app).await;
            let offline = error.starts_with("无法连接库存包下载地址：")
                || error.starts_with("库存包下载中断：");
            let state = if offline { "offline" } else { "failed" };
            let detail = if let Some(cached_version) = local.version.as_deref() {
                format!(
                    "库存版本 {version} 缓存失败：{error}。本机已验证缓存版本 {cached_version} 可供离线安装。"
                )
            } else {
                format!("库存版本 {version} 缓存失败：{error}")
            };
            cache_result(state, local.version, detail)
        }
    }
}

#[tauri::command]
pub async fn integrated_updater_status() -> AppResult<UpdaterStatus> {
    updater_status()
}

#[tauri::command]
pub async fn integrated_install_inventory_online(
    app: AppHandle,
    version: String,
) -> AppResult<UpdaterStatus> {
    if !updater_status()?.can_manage {
        return Err("当前 Windows 账号没有库存更新权限。".into());
    }
    let (release, asset) = latest_inventory_release().await?;
    if release.tag_name != format!("inventory-v{version}") {
        return Err("库存 Release 已变化，请重新检查版本。".into());
    }
    let package_path = ensure_inventory_cached(&app, &release, &asset).await?;
    updater_request("install", serde_json::json!({"packagePath": package_path}))
}

#[tauri::command]
pub async fn integrated_install_inventory_cached(
    app: AppHandle,
    version: String,
) -> AppResult<UpdaterStatus> {
    if !updater_status()?.can_manage {
        return Err("当前 Windows 账号没有库存更新权限。".into());
    }
    let wanted = semver::Version::parse(&version).map_err(|_| "缓存的库存版本无效。")?;
    if !wanted.pre.is_empty() {
        return Err("不能安装候选库存版本。".into());
    }
    let directory = inventory_cache_directory(&app)?;
    let (path, digest) = fs::read_dir(&directory)
        .map_err(|error| format!("无法读取库存包缓存：{error}"))?
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_file()))
        .find_map(|entry| {
            let name = entry.file_name().to_string_lossy().into_owned();
            parse_cache_filename(&name)
                .and_then(|(found, digest)| (found == wanted).then_some((entry.path(), digest)))
        })
        .ok_or("本机没有指定版本的已缓存库存包。")?;
    verify_cached_package_async(path.clone(), version, digest).await?;
    updater_request("install", serde_json::json!({"packagePath": path}))
}

#[tauri::command]
pub async fn integrated_install_inventory_file(path: String) -> AppResult<UpdaterStatus> {
    if !updater_status()?.can_manage {
        return Err("当前 Windows 账号没有库存更新权限。".into());
    }
    let path = PathBuf::from(path);
    if path
        .extension()
        .is_none_or(|extension| extension.to_string_lossy().to_ascii_lowercase() != "zip")
        || !path.is_file()
    {
        return Err("请选择有效的库存签名 ZIP 包。".into());
    }
    updater_request("install", serde_json::json!({"packagePath": path}))
}

#[tauri::command]
pub async fn integrated_cancel_inventory_update(operation_id: String) -> AppResult<UpdaterStatus> {
    updater_request("cancel", serde_json::json!({"operationId": operation_id}))
}

#[cfg(windows)]
fn launch_installer_as_admin(path: &Path) -> AppResult<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::{
        Foundation::{CloseHandle, GetLastError},
        UI::{
            Shell::{SEE_MASK_NOCLOSEPROCESS, SHELLEXECUTEINFOW, ShellExecuteExW},
            WindowsAndMessaging::SW_SHOWNORMAL,
        },
    };

    let file = path
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect::<Vec<_>>();
    let verb = "runas".encode_utf16().chain(Some(0)).collect::<Vec<_>>();
    let parameters = "/UPDATE".encode_utf16().chain(Some(0)).collect::<Vec<_>>();
    let mut info = SHELLEXECUTEINFOW::default();
    info.cbSize = std::mem::size_of::<SHELLEXECUTEINFOW>() as u32;
    info.fMask = SEE_MASK_NOCLOSEPROCESS;
    info.lpVerb = verb.as_ptr();
    info.lpFile = file.as_ptr();
    info.lpParameters = parameters.as_ptr();
    info.nShow = SW_SHOWNORMAL;
    if unsafe { ShellExecuteExW(&mut info) } == 0 {
        return Err(format!(
            "Windows could not open the installer ({})",
            unsafe { GetLastError() }
        ));
    }
    if !info.hProcess.is_null() {
        unsafe { CloseHandle(info.hProcess) };
    }
    Ok(())
}

#[tauri::command]
pub async fn integrated_install_update(app: AppHandle, version: String) -> AppResult<()> {
    let (release, installer) = latest_manager_release().await?;
    if release.tag_name != version || !update_available(&version) {
        return Err(
            "The GitHub release changed or is not newer. Check again before installing.".into(),
        );
    }
    if installer.size == 0 || installer.size > 1024 * 1024 * 1024 {
        return Err("The installer size reported by GitHub is invalid.".into());
    }
    let bytes = reqwest::Client::builder()
        .timeout(Duration::from_secs(600))
        .build()
        .map_err(|error| error.to_string())?
        .get(&installer.browser_download_url)
        .header(reqwest::header::USER_AGENT, "SUGRID-Server-Manager")
        .send()
        .await
        .map_err(|error| format!("Could not download the installer: {error}"))?
        .error_for_status()
        .map_err(|error| format!("Installer download failed: {error}"))?
        .bytes()
        .await
        .map_err(|error| format!("Could not read the installer download: {error}"))?;
    if bytes.len() as u64 != installer.size {
        return Err("The downloaded installer size does not match GitHub metadata.".into());
    }
    if let Some(digest) = installer.digest.as_deref() {
        let expected = digest.strip_prefix("sha256:").unwrap_or(digest);
        let actual = hex::encode(sha2::Sha256::digest(&bytes));
        if !actual.eq_ignore_ascii_case(expected) {
            return Err("The downloaded installer failed its SHA-256 check.".into());
        }
    }
    let temp_dir = std::env::temp_dir().join("SUGRID-Server-Manager");
    fs::create_dir_all(&temp_dir).map_err(|error| error.to_string())?;
    let installer_path = temp_dir.join("SUGRID-Server-Manager-Setup.exe");
    fs::write(&installer_path, &bytes).map_err(|error| error.to_string())?;
    #[cfg(windows)]
    {
        launch_installer_as_admin(&installer_path)?;
        app.exit(0);
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let _ = app;
        Err("Integrated Windows installer updates are only available on Windows.".into())
    }
}

#[tauri::command]
pub async fn integrated_dashboard() -> AppResult<IntegratedDashboard> {
    read_dashboard()
}

#[tauri::command]
pub async fn integrated_open_inventory(app: AppHandle) -> AppResult<()> {
    let dashboard = read_dashboard()?;
    if !dashboard.healthy {
        return Err("库存服务尚未通过网页与数据库健康检查，请先启动并检查服务。".into());
    }
    let target = format!("{}/login", dashboard.service_url)
        .parse::<tauri::Url>()
        .map_err(|error| format!("库存系统地址无效：{error}"))?;
    if let Some(window) = app.get_webview_window("inventory-system") {
        window
            .navigate(target)
            .map_err(|error| format!("切换到库存系统失败：{error}"))?;
        return Ok(());
    }
    WebviewWindowBuilder::new(&app, "inventory-system", WebviewUrl::External(target))
        .title("溯格库存系统")
        .inner_size(1360.0, 900.0)
        .min_inner_size(980.0, 680.0)
        .build()
        .map_err(|error| format!("打开库存系统失败：{error}"))?;
    Ok(())
}

#[tauri::command]
pub async fn integrated_start_service() -> AppResult<IntegratedDashboard> {
    updater_request("start", serde_json::json!({}))?;
    read_dashboard()
}

#[tauri::command]
pub async fn integrated_stop_service() -> AppResult<IntegratedDashboard> {
    updater_request("stop", serde_json::json!({}))?;
    read_dashboard()
}

#[tauri::command]
pub async fn integrated_create_backup() -> AppResult<UpdaterStatus> {
    updater_request("backup", serde_json::json!({}))
}

#[tauri::command]
pub async fn integrated_restore_backup(name: String) -> AppResult<UpdaterStatus> {
    if !safe_backup_name(&name) {
        return Err("备份文件名无效。".into());
    }
    updater_request("restore", serde_json::json!({"backupName": name}))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backup_manifest_names_cannot_escape_the_managed_backup_folder() {
        assert!(safe_backup_name("inventory.before-install-123.db"));
        assert!(!safe_backup_name("../../inventory.before-install-123.db"));
        assert!(!safe_backup_name("inventory.db"));
        assert!(!safe_backup_name("other.before-install-123.db"));
    }

    #[test]
    fn release_versions_only_offer_a_newer_semver() {
        assert!(!update_available(env!("CARGO_PKG_VERSION")));
        assert!(!update_available("v0.0.1"));
        assert!(!update_available("not-a-version"));
        assert!(update_available("999.0.0"));
    }

    #[test]
    fn inventory_cache_only_accepts_versioned_sha256_names() {
        let digest = "a".repeat(64);
        assert_eq!(
            parse_cache_filename(&format!("inventory-1.2.3-{digest}.zip"))
                .map(|(version, _)| version.to_string()),
            Some("1.2.3".into())
        );
        assert!(parse_cache_filename("inventory-1.2.3-other.zip").is_none());
        assert!(parse_cache_filename(&format!("inventory-../../1.2.3-{digest}.zip")).is_none());
        assert!(parse_cache_filename(&format!("inventory-1.2.3-rc.1-{digest}.zip")).is_none());
        assert!(parse_cache_filename(&format!("manager-1.2.3-{digest}.zip")).is_none());
    }

    #[test]
    fn inventory_release_identity_requires_formal_version_and_digest() {
        let release = GithubRelease {
            tag_name: "inventory-v1.2.3".into(),
            html_url: String::new(),
            body: None,
            draft: false,
            prerelease: false,
            assets: Vec::new(),
        };
        let asset = GithubAsset {
            name: "sugrid-inventory-windows-x64.zip".into(),
            browser_download_url: String::new(),
            size: 1024,
            digest: Some(format!("sha256:{}", "b".repeat(64))),
        };
        assert_eq!(
            release_package_identity(&release, &asset).unwrap().0,
            "1.2.3"
        );
        assert!(
            release_package_identity(
                &GithubRelease {
                    tag_name: "manager-v1.2.3".into(),
                    ..release.clone()
                },
                &asset
            )
            .is_err()
        );
        assert!(
            release_package_identity(
                &GithubRelease {
                    tag_name: "inventory-v1.2.3-rc.1".into(),
                    ..release.clone()
                },
                &asset
            )
            .is_err()
        );
        assert!(
            release_package_identity(
                &release,
                &GithubAsset {
                    digest: Some("sha256:bad".into()),
                    ..asset
                }
            )
            .is_err()
        );
    }
}
