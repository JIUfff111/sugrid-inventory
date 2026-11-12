use serde::{Deserialize, Serialize};
use sha2::Digest;
use std::{
    fs,
    io::{Read, Write},
    net::TcpStream,
    path::{Path, PathBuf},
    thread,
    time::Duration,
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

#[derive(Deserialize)]
struct GithubRelease {
    tag_name: String,
    html_url: String,
    body: Option<String>,
    assets: Vec<GithubAsset>,
}

#[derive(Clone, Deserialize)]
struct GithubAsset {
    name: String,
    browser_download_url: String,
    size: u64,
    digest: Option<String>,
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

async fn latest_release() -> AppResult<(GithubRelease, GithubAsset)> {
    let release = reqwest::Client::builder()
        .user_agent("SUGRID-Server-Manager")
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|error| error.to_string())?
        .get("https://api.github.com/repos/JIUfff111/sugrid-inventory/releases/latest")
        .send()
        .await
        .map_err(|error| format!("Cannot check GitHub releases: {error}"))?
        .error_for_status()
        .map_err(|error| format!("GitHub release check failed: {error}"))?
        .json::<GithubRelease>()
        .await
        .map_err(|error| format!("GitHub release data is invalid: {error}"))?;
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

fn update_available(latest: &str) -> bool {
    let current = env!("CARGO_PKG_VERSION");
    let current = semver::Version::parse(current);
    let latest = semver::Version::parse(latest.trim_start_matches('v'));
    match (current, latest) {
        (Ok(current), Ok(latest)) => latest > current,
        _ => false,
    }
}

#[tauri::command]
pub async fn integrated_check_update() -> AppResult<IntegratedUpdate> {
    let current_version = env!("CARGO_PKG_VERSION").to_string();
    let (release, _) = latest_release().await?;
    let update_available = update_available(&release.tag_name);
    Ok(IntegratedUpdate {
        current_version,
        latest_version: Some(release.tag_name.clone()),
        release_url: Some(release.html_url),
        release_notes: release.body,
        installer_available: true,
        update_available,
        message: if update_available {
            format!("发现版本 {}，可获取一体化安装包更新。", release.tag_name)
        } else {
            "当前管理器已是最新版本。".into()
        },
    })
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
    let mut info = SHELLEXECUTEINFOW::default();
    info.cbSize = std::mem::size_of::<SHELLEXECUTEINFOW>() as u32;
    info.fMask = SEE_MASK_NOCLOSEPROCESS;
    info.lpVerb = verb.as_ptr();
    info.lpFile = file.as_ptr();
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
    let (release, installer) = latest_release().await?;
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
    let manager = service_manager(ServiceManagerAccess::CONNECT)?;
    let service = manager
        .open_service(
            SERVICE_NAME,
            ServiceAccess::QUERY_STATUS | ServiceAccess::START,
        )
        .map_err(|error| format!("Cannot open inventory service; install it first: {error}"))?;
    let state = service
        .query_status()
        .map_err(|error| error.to_string())?
        .current_state;
    match state {
        ServiceState::Stopped => service
            .start::<std::ffi::OsString>(&[])
            .map_err(|error| format!("Cannot start inventory service: {error}"))?,
        ServiceState::Running | ServiceState::StartPending | ServiceState::ContinuePending => {}
        other => {
            return Err(format!("库存服务当前处于 {other:?}，暂时不能启动。"));
        }
    }
    for _ in 0..120 {
        let dashboard = read_dashboard()?;
        if dashboard.healthy {
            return Ok(dashboard);
        }
        if dashboard.service_state == "stopped" {
            return Err(
                "服务启动失败，请查看 ProgramData\\SUGRID\\Inventory\\logs\\service.log".into(),
            );
        }
        thread::sleep(Duration::from_millis(500));
    }
    Err("服务启动超时；请查看 ProgramData\\SUGRID\\Inventory\\logs\\service.log".into())
}

#[tauri::command]
pub async fn integrated_stop_service() -> AppResult<IntegratedDashboard> {
    let manager = service_manager(ServiceManagerAccess::CONNECT)?;
    let service = manager
        .open_service(
            SERVICE_NAME,
            ServiceAccess::QUERY_STATUS | ServiceAccess::STOP,
        )
        .map_err(|error| format!("Cannot open inventory service: {error}"))?;
    if service
        .query_status()
        .map_err(|error| error.to_string())?
        .current_state
        != ServiceState::Stopped
    {
        service
            .stop()
            .map_err(|error| format!("Cannot stop inventory service: {error}"))?;
    }
    for _ in 0..100 {
        if service
            .query_status()
            .is_ok_and(|status| status.current_state == ServiceState::Stopped)
        {
            return read_dashboard();
        }
        thread::sleep(Duration::from_millis(250));
    }
    Err("服务在 25 秒内未停止，请检查 Windows 服务状态。".into())
}

#[cfg(windows)]
fn service_host_path(app: &AppHandle) -> AppResult<PathBuf> {
    let packaged = app
        .path()
        .resource_dir()
        .map_err(|error| error.to_string())?
        .join("inventory")
        .join("sugrid-inventory-service.exe");
    if packaged.is_file() {
        return Ok(packaged);
    }
    let development = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("resources")
        .join("inventory")
        .join("sugrid-inventory-service.exe");
    if development.is_file() {
        return Ok(development);
    }
    Err("找不到库存服务维护程序；请重新安装管理器。".into())
}

#[cfg(windows)]
fn quote_windows_arg(value: &str) -> String {
    let mut result = String::from("\"");
    let mut slashes = 0;
    for character in value.chars() {
        match character {
            '\\' => slashes += 1,
            '"' => {
                result.push_str(&"\\".repeat(slashes * 2 + 1));
                result.push('"');
                slashes = 0;
            }
            _ => {
                result.push_str(&"\\".repeat(slashes));
                result.push(character);
                slashes = 0;
            }
        }
    }
    result.push_str(&"\\".repeat(slashes * 2));
    result.push('"');
    result
}

#[cfg(windows)]
fn run_elevated_host(app: &AppHandle, args: &[String]) -> AppResult<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::{
        Foundation::{CloseHandle, GetLastError, WAIT_OBJECT_0},
        System::Threading::{GetExitCodeProcess, WaitForSingleObject},
        UI::{
            Shell::{SEE_MASK_NOCLOSEPROCESS, SHELLEXECUTEINFOW, ShellExecuteExW},
            WindowsAndMessaging::SW_HIDE,
        },
    };

    let executable = service_host_path(app)?;
    let file = executable
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect::<Vec<_>>();
    let verb = "runas".encode_utf16().chain(Some(0)).collect::<Vec<_>>();
    let parameters = args
        .iter()
        .map(|argument| quote_windows_arg(argument))
        .collect::<Vec<_>>()
        .join(" ")
        .encode_utf16()
        .chain(Some(0))
        .collect::<Vec<_>>();
    let mut info = SHELLEXECUTEINFOW::default();
    info.cbSize = std::mem::size_of::<SHELLEXECUTEINFOW>() as u32;
    info.fMask = SEE_MASK_NOCLOSEPROCESS;
    info.lpVerb = verb.as_ptr();
    info.lpFile = file.as_ptr();
    info.lpParameters = parameters.as_ptr();
    info.nShow = SW_HIDE;
    if unsafe { ShellExecuteExW(&mut info) } == 0 {
        return Err(format!(
            "Windows could not start the administrator task ({})",
            unsafe { GetLastError() }
        ));
    }
    let process = info.hProcess;
    if process.is_null() {
        return Err("Windows did not return the administrator task process handle.".into());
    }
    let wait = unsafe { WaitForSingleObject(process, 300_000) };
    if wait != WAIT_OBJECT_0 {
        unsafe { CloseHandle(process) };
        return Err("管理员任务等待超过 5 分钟，未确认操作结果。".into());
    }
    let mut exit_code = 1u32;
    let exit_result = unsafe { GetExitCodeProcess(process, &mut exit_code) };
    unsafe { CloseHandle(process) };
    if exit_result == 0 || exit_code != 0 {
        return Err(format!("管理员任务失败，退出代码：{exit_code}"));
    }
    Ok(())
}

#[tauri::command]
pub async fn integrated_create_backup(app: AppHandle) -> AppResult<IntegratedDashboard> {
    #[cfg(windows)]
    run_elevated_host(&app, &["backup".into()])?;
    #[cfg(not(windows))]
    return Err("数据库备份管理仅支持 Windows 服务部署。".into());
    read_dashboard()
}

#[tauri::command]
pub async fn integrated_restore_backup(
    app: AppHandle,
    name: String,
) -> AppResult<IntegratedDashboard> {
    if !safe_backup_name(&name) {
        return Err("备份文件名无效。".into());
    }
    #[cfg(windows)]
    {
        let path = backup_directory()?.join(name);
        run_elevated_host(
            &app,
            &["restore".into(), path.to_string_lossy().into_owned()],
        )?;
    }
    #[cfg(not(windows))]
    return Err("数据库备份恢复仅支持 Windows 服务部署。".into());
    read_dashboard()
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
}
