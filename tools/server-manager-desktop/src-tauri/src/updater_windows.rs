use crate::updater_package::UPDATER_PROTOCOL;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    ffi::{OsStr, OsString, c_void},
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    os::windows::{ffi::OsStrExt, fs::MetadataExt, io::FromRawHandle},
    path::{Path, PathBuf},
    ptr,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use windows_service::{
    define_windows_service,
    service::{
        ServiceAccess, ServiceAction, ServiceActionType, ServiceControl, ServiceControlAccept,
        ServiceErrorControl, ServiceExitCode, ServiceFailureActions, ServiceFailureResetPeriod,
        ServiceInfo, ServiceStartType, ServiceState, ServiceStatus, ServiceType,
    },
    service_control_handler::{self, ServiceControlHandlerResult},
    service_manager::{ServiceManager, ServiceManagerAccess},
};
use windows_sys::Win32::{
    Foundation::{
        CloseHandle, ERROR_NO_DATA, ERROR_PIPE_CONNECTED, GetLastError, HANDLE,
        INVALID_HANDLE_VALUE, LocalFree,
    },
    Security::{
        Authorization::{
            ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW,
            ConvertStringSidToSidW, GetNamedSecurityInfoW, SE_FILE_OBJECT,
            SetNamedSecurityInfoW,
        },
        CheckTokenMembership, DACL_SECURITY_INFORMATION, GetSecurityDescriptorControl,
        GetSecurityDescriptorDacl, GetTokenInformation, LookupAccountNameW,
        PROTECTED_DACL_SECURITY_INFORMATION, RevertToSelf, SE_DACL_PROTECTED,
        SECURITY_ATTRIBUTES, TOKEN_QUERY, TOKEN_USER, TokenUser,
    },
    Storage::FileSystem::{
        MoveFileExW, FILE_ATTRIBUTE_REPARSE_POINT, FILE_FLAG_FIRST_PIPE_INSTANCE,
        PIPE_ACCESS_DUPLEX, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    },
    System::{
        Pipes::{
            ConnectNamedPipe, CreateNamedPipeW, ImpersonateNamedPipeClient, PIPE_NOWAIT,
            PIPE_REJECT_REMOTE_CLIENTS, SetNamedPipeHandleState,
        },
        Threading::{CREATE_NO_WINDOW, GetCurrentThread, OpenThreadToken},
    },
};

#[path = "updater_windows/operations.rs"]
mod operations;
use operations::{
    ensure_no_pending_recovery, recover_interrupted_transaction, run_host, start_backup,
    start_install, start_restore,
};

#[cfg(not(feature = "updater-qa"))]
pub const SERVICE_NAME: &str = "SUGRIDInventoryUpdater";
#[cfg(feature = "updater-qa")]
pub const SERVICE_NAME: &str = "SUGRIDInventoryUpdaterQA";
#[cfg(not(feature = "updater-qa"))]
const INVENTORY_SERVICE_NAME: &str = "SUGRIDInventory";
#[cfg(feature = "updater-qa")]
const INVENTORY_SERVICE_NAME: &str = "SUGRIDInventoryQA";
#[cfg(not(feature = "updater-qa"))]
pub const PIPE_NAME: &str = r"\\.\pipe\SUGRIDInventoryUpdater-v1";
#[cfg(feature = "updater-qa")]
pub const PIPE_NAME: &str = r"\\.\pipe\SUGRIDInventoryUpdaterQA-v1";
#[cfg(not(feature = "updater-qa"))]
const SERVICE_DISPLAY_NAME: &str = "SUGRID Inventory Updater";
#[cfg(feature = "updater-qa")]
const SERVICE_DISPLAY_NAME: &str = "SUGRID Inventory Updater QA";
const MAX_REQUEST_BYTES: usize = 64 * 1024;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(2);

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Operators {
    allowed_sids: Vec<String>,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Operation {
    pub operation_id: Option<String>,
    pub stage: String,
    pub state: String,
    pub error: Option<String>,
    pub inventory_version: Option<String>,
}
impl Default for Operation {
    fn default() -> Self {
        Self {
            operation_id: None,
            stage: "idle".into(),
            state: "idle".into(),
            error: None,
            inventory_version: None,
        }
    }
}
pub struct State {
    pub operation: Mutex<Operation>,
    pub cancel: AtomicBool,
    stop: AtomicBool,
}
impl State {
    fn new() -> Self {
        Self {
            operation: Mutex::new(Operation::default()),
            cancel: AtomicBool::new(false),
            stop: AtomicBool::new(false),
        }
    }
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Request {
    id: u64,
    command: String,
    package_path: Option<String>,
    backup_name: Option<String>,
    operation_id: Option<String>,
}
#[derive(Serialize)]
struct Response {
    id: u64,
    ok: bool,
    result: Option<Value>,
    error: Option<String>,
}
impl Response {
    fn ok(id: u64, result: Value) -> Self {
        Self {
            id,
            ok: true,
            result: Some(result),
            error: None,
        }
    }
    fn error(id: u64, error: impl Into<String>) -> Self {
        Self {
            id,
            ok: false,
            result: None,
            error: Some(error.into()),
        }
    }
}

pub fn root() -> Result<PathBuf, String> {
    #[cfg(feature = "updater-qa")]
    {
        return option_env!("SUGRID_UPDATER_QA_ROOT")
            .map(PathBuf::from)
            .ok_or("QA build requires SUGRID_UPDATER_QA_ROOT at compile time.".into());
    }
    #[cfg(not(feature = "updater-qa"))]
    {
    Ok(
        PathBuf::from(std::env::var_os("PROGRAMDATA").ok_or("ProgramData is unavailable.")?)
            .join("SUGRID")
            .join("Inventory"),
    )
    }
}
pub fn updater_root() -> Result<PathBuf, String> {
    Ok(root()?.join("updater"))
}
pub fn metadata_path() -> Result<PathBuf, String> {
    Ok(root()?.join("inventory-version.json"))
}
pub fn database_path() -> Result<PathBuf, String> {
    Ok(root()?.join("data").join("inventory.db"))
}
pub fn stamp() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
fn wide(value: &OsStr) -> Vec<u16> {
    value.encode_wide().chain(Some(0)).collect()
}
fn win_err(context: &str) -> String {
    format!("{context}: Windows error {}", unsafe { GetLastError() })
}

fn replace_file(source: &Path, target: &Path) -> Result<(), String> {
    if unsafe {
        MoveFileExW(
            wide(source.as_os_str()).as_ptr(),
            wide(target.as_os_str()).as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    } == 0
    {
        return Err(win_err("Cannot atomically replace updater file"));
    }
    Ok(())
}

fn set_exact_acl(path: &Path, sddl: &str) -> Result<(), String> {
    let metadata = fs::symlink_metadata(path).map_err(|error| error.to_string())?;
    if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        return Err("Updater security boundary contains a reparse point.".into());
    }
    let mut desired_descriptor = ptr::null_mut();
    if unsafe {
        ConvertStringSecurityDescriptorToSecurityDescriptorW(
            wide(OsStr::new(sddl)).as_ptr(),
            1,
            &mut desired_descriptor,
            ptr::null_mut(),
        )
    } == 0
    {
        return Err(win_err("Cannot construct updater ACL"));
    }
    let result = (|| {
        let mut present = 0;
        let mut defaulted = 0;
        let mut desired_acl = ptr::null_mut();
        if unsafe {
            GetSecurityDescriptorDacl(
                desired_descriptor,
                &mut present,
                &mut desired_acl,
                &mut defaulted,
            )
        } == 0 || present == 0 || desired_acl.is_null()
        {
            return Err(win_err("Cannot extract updater ACL"));
        }
        let path_wide = wide(path.as_os_str());
        let code = unsafe {
            SetNamedSecurityInfoW(
                path_wide.as_ptr(),
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
                ptr::null_mut(),
                ptr::null_mut(),
                desired_acl,
                ptr::null(),
            )
        };
        if code != 0 {
            return Err(format!("Cannot set exact updater ACL: Windows error {code}"));
        }
        let mut actual_acl = ptr::null_mut();
        let mut actual_descriptor = ptr::null_mut();
        let code = unsafe {
            GetNamedSecurityInfoW(
                path_wide.as_ptr(),
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION,
                ptr::null_mut(),
                ptr::null_mut(),
                &mut actual_acl,
                ptr::null_mut(),
                &mut actual_descriptor,
            )
        };
        if code != 0 {
            return Err(format!("Cannot verify updater ACL: Windows error {code}"));
        }
        let verified = (|| {
            if actual_descriptor.is_null() || actual_acl.is_null() {
                return Err("Updater ACL verification returned no DACL.".into());
            }
            let mut control = 0;
            let mut revision = 0;
            if unsafe {
                GetSecurityDescriptorControl(actual_descriptor, &mut control, &mut revision)
            } == 0 || control & SE_DACL_PROTECTED == 0
            {
                return Err("Updater ACL is not protected from inheritance.".into());
            }
            let expected_size = unsafe { (*desired_acl).AclSize as usize };
            let actual_size = unsafe { (*actual_acl).AclSize as usize };
            if expected_size != actual_size
                || unsafe {
                    std::slice::from_raw_parts(desired_acl.cast::<u8>(), expected_size)
                        != std::slice::from_raw_parts(actual_acl.cast::<u8>(), actual_size)
                }
            {
                return Err("Updater ACL contains unexpected permissions.".into());
            }
            Ok(())
        })();
        unsafe { LocalFree(actual_descriptor) };
        verified
    })();
    unsafe { LocalFree(desired_descriptor) };
    result
}

fn secure_private_directory(path: &Path) -> Result<(), String> {
    set_exact_acl(path, "D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)")
}

fn secure_private_file(path: &Path) -> Result<(), String> {
    set_exact_acl(path, "D:P(A;;FA;;;SY)(A;;FA;;;BA)")
}

pub fn secure_readable_manifest(path: &Path) -> Result<(), String> {
    set_exact_acl(path, "D:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;FR;;;BU)")
}
pub fn hidden(program: impl AsRef<OsStr>) -> std::process::Command {
    use std::os::windows::process::CommandExt;
    let mut command = std::process::Command::new(program);
    command.creation_flags(CREATE_NO_WINDOW);
    command.stdin(std::process::Stdio::null());
    command
}

fn sid_string(sid: *mut c_void) -> Result<String, String> {
    let mut text: *mut u16 = ptr::null_mut();
    if unsafe { ConvertSidToStringSidW(sid, &mut text) } == 0 {
        return Err(win_err("Cannot convert Windows SID"));
    }
    let mut len = 0;
    while unsafe { *text.add(len) } != 0 {
        len += 1;
    }
    let value = String::from_utf16_lossy(unsafe { std::slice::from_raw_parts(text, len) });
    unsafe {
        LocalFree(text.cast());
    }
    Ok(value)
}
fn validate_sid(value: &str) -> Result<(), String> {
    let mut sid = ptr::null_mut();
    if unsafe { ConvertStringSidToSidW(wide(OsStr::new(value)).as_ptr(), &mut sid) } == 0 {
        return Err("Invalid operator SID.".into());
    }
    unsafe {
        LocalFree(sid);
    }
    Ok(())
}
fn account_name_sid(name: &str) -> Result<String, String> {
    if name.is_empty()
        || name.len() > 256
        || (!name.contains('\\') && !name.contains('@'))
    {
        return Err("Pass an explicit DOMAIN\\user, .\\user, UPN, or Windows SID.".into());
    }
    let account = wide(OsStr::new(name));
    let mut sid_len = 0;
    let mut domain_len = 0;
    let mut use_type = 0;
    unsafe {
        LookupAccountNameW(
            ptr::null(),
            account.as_ptr(),
            ptr::null_mut(),
            &mut sid_len,
            ptr::null_mut(),
            &mut domain_len,
            &mut use_type,
        );
    }
    if sid_len == 0 {
        return Err(win_err("Cannot resolve maintenance account SID"));
    }
    let mut sid = vec![0u8; sid_len as usize];
    let mut domain_buffer = vec![0u16; domain_len as usize];
    if unsafe {
        LookupAccountNameW(
            ptr::null(),
            account.as_ptr(),
            sid.as_mut_ptr().cast(),
            &mut sid_len,
            domain_buffer.as_mut_ptr(),
            &mut domain_len,
            &mut use_type,
        )
    } == 0
    {
        return Err(win_err("Cannot resolve maintenance account SID"));
    }
    if use_type != 1 {
        return Err("Maintenance account must resolve to a Windows user, not a group.".into());
    }
    sid_string(sid.as_mut_ptr().cast())
}
fn token_identity(pipe: HANDLE) -> Result<(String, bool), String> {
    if unsafe { ImpersonateNamedPipeClient(pipe) } == 0 {
        return Err(win_err("Cannot authenticate pipe client"));
    }
    let result = (|| {
        let mut token = ptr::null_mut();
        if unsafe { OpenThreadToken(GetCurrentThread(), TOKEN_QUERY, 1, &mut token) } == 0 {
            return Err(win_err("Cannot query client token"));
        }
        let identity = (|| {
            let mut length = 0;
            unsafe {
                GetTokenInformation(token, TokenUser, ptr::null_mut(), 0, &mut length);
            }
            if length < std::mem::size_of::<TOKEN_USER>() as u32 {
                return Err("Invalid client token.".into());
            }
            let mut bytes = vec![0u8; length as usize];
            if unsafe {
                GetTokenInformation(
                    token,
                    TokenUser,
                    bytes.as_mut_ptr().cast(),
                    length,
                    &mut length,
                )
            } == 0
            {
                return Err(win_err("Cannot read client token"));
            }
            let user = unsafe { &*(bytes.as_ptr() as *const TOKEN_USER) };
            let sid = sid_string(user.User.Sid)?;
            let mut admin_sid = ptr::null_mut();
            if unsafe {
                ConvertStringSidToSidW(wide(OsStr::new("S-1-5-32-544")).as_ptr(), &mut admin_sid)
            } == 0
            {
                return Err(win_err("Cannot resolve Administrators SID"));
            }
            let mut admin = 0;
            let membership = unsafe { CheckTokenMembership(token, admin_sid, &mut admin) };
            unsafe {
                LocalFree(admin_sid);
            }
            if membership == 0 {
                return Err(win_err("Cannot check administrator membership"));
            }
            Ok((sid, admin != 0))
        })();
        unsafe {
            CloseHandle(token);
        }
        identity
    })();
    unsafe {
        RevertToSelf();
    }
    result
}
fn update_operators(sid: &str, add: bool) -> Result<(), String> {
    validate_sid(sid)?;
    let directory = updater_root()?;
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    secure_private_directory(&directory)?;
    let path = directory.join("operators.json");
    let mut config = if path.exists() {
        serde_json::from_slice::<Operators>(&fs::read(&path).map_err(|error| error.to_string())?)
            .map_err(|_| "Existing updater operator configuration is invalid.")?
    } else {
        Operators {
            allowed_sids: Vec::new(),
        }
    };
    if add {
        if !config
            .allowed_sids
            .iter()
            .any(|item| item.eq_ignore_ascii_case(sid))
        {
            config.allowed_sids.push(sid.to_owned());
        }
    } else {
        config
            .allowed_sids
            .retain(|item| !item.eq_ignore_ascii_case(sid));
        if config.allowed_sids.is_empty() {
            return Err("At least one updater operator must remain.".into());
        }
    }
    let temporary = directory.join(format!("operators-{}.tmp", stamp()));
    fs::write(
        &temporary,
        serde_json::to_vec_pretty(&config).map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())?;
    if let Err(error) = secure_private_file(&temporary) {
        let _ = fs::remove_file(&temporary);
        return Err(error);
    }
    if let Err(error) = replace_file(&temporary, &path) {
        let _ = fs::remove_file(&temporary);
        return Err(error);
    }
    secure_private_file(&path)?;
    Ok(())
}
fn can_manage(sid: &str, admin: bool) -> bool {
    admin
        || fs::read(updater_root().unwrap_or_default().join("operators.json"))
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Operators>(&bytes).ok())
            .is_some_and(|config| {
                config
                    .allowed_sids
                    .iter()
                    .any(|allowed| allowed.eq_ignore_ascii_case(sid))
            })
}
fn pipe_security() -> Result<(SECURITY_ATTRIBUTES, *mut c_void), String> {
    // Users receive data read/write only. Generic write also grants FILE_CREATE_PIPE_INSTANCE and is unsafe here.
    // FILE_GENERIC_READ plus WRITE_DATA and WRITE_ATTRIBUTES. Do not grant
    // FILE_CREATE_PIPE_INSTANCE, which is included in generic write.
    let sddl = wide(OsStr::new("D:P(A;;GA;;;SY)(A;;GA;;;BA)(A;;0x12018b;;;BU)S:(ML;;NW;;;ME)"));
    let mut descriptor = ptr::null_mut();
    if unsafe {
        ConvertStringSecurityDescriptorToSecurityDescriptorW(
            sddl.as_ptr(),
            1,
            &mut descriptor,
            ptr::null_mut(),
        )
    } == 0
    {
        return Err(win_err("Cannot protect updater pipe"));
    }
    Ok((
        SECURITY_ATTRIBUTES {
            nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: descriptor,
            bInheritHandle: 0,
        },
        descriptor,
    ))
}
fn pipe_once(state: &Arc<State>) -> Result<(), String> {
    let (attributes, descriptor) = pipe_security()?;
    let name = wide(OsStr::new(PIPE_NAME));
    let pipe = unsafe {
        CreateNamedPipeW(
            name.as_ptr(),
            PIPE_ACCESS_DUPLEX | FILE_FLAG_FIRST_PIPE_INSTANCE,
            PIPE_REJECT_REMOTE_CLIENTS,
            4,
            64 * 1024,
            64 * 1024,
            0,
            &attributes,
        )
    };
    unsafe {
        LocalFree(descriptor);
    }
    if pipe == INVALID_HANDLE_VALUE {
        return Err(win_err("Cannot create updater pipe"));
    }
    let connected = unsafe { ConnectNamedPipe(pipe, ptr::null_mut()) } != 0
        || unsafe { GetLastError() } == ERROR_PIPE_CONNECTED;
    if connected {
        let mut file = unsafe { File::from_raw_handle(pipe) };
        let _ = handle_client(&mut file, pipe, state);
    } else {
        unsafe {
            CloseHandle(pipe);
        }
    }
    Ok(())
}
fn handle_client(file: &mut File, pipe: HANDLE, state: &Arc<State>) -> Result<(), String> {
    let bytes = read_bounded_request(file, pipe)?;
    let request: Request = serde_json::from_slice(&bytes)
        .map_err(|_| "Malformed updater request.")?;
    let response = match token_identity(pipe) {
        Ok((sid, admin)) => dispatch(request, &sid, admin, state),
        Err(error) => Response::error(request.id, error),
    };
    let mut output = serde_json::to_vec(&response).map_err(|error| error.to_string())?;
    output.push(b'\n');
    file.write_all(&output).map_err(|error| error.to_string())
}
fn read_bounded_request(file: &mut File, pipe: HANDLE) -> Result<Vec<u8>, String> {
    let mode = PIPE_NOWAIT;
    if unsafe { SetNamedPipeHandleState(pipe, &mode, ptr::null(), ptr::null()) } == 0 {
        return Err(win_err("Cannot set updater request deadline"));
    }
    let deadline = std::time::Instant::now() + REQUEST_TIMEOUT;
    let mut bytes = Vec::with_capacity(1024);
    let mut chunk = [0u8; 4096];
    loop {
        if std::time::Instant::now() >= deadline {
            return Err("Updater request timed out.".into());
        }
        if bytes.len() >= MAX_REQUEST_BYTES {
            return Err("Updater request is too large.".into());
        }
        let remaining = MAX_REQUEST_BYTES - bytes.len();
        let read_limit = remaining.min(chunk.len());
        match file.read(&mut chunk[..read_limit]) {
            Ok(0) => thread::sleep(Duration::from_millis(10)),
            Ok(count) => {
                bytes.extend_from_slice(&chunk[..count]);
                if let Some(newline) = bytes.iter().position(|byte| *byte == b'\n') {
                    if newline + 1 != bytes.len() {
                        return Err("Updater request contains trailing data.".into());
                    }
                    return Ok(bytes);
                }
            }
            Err(error)
                if error.raw_os_error() == Some(ERROR_NO_DATA as i32)
                    || error.kind() == std::io::ErrorKind::WouldBlock =>
            {
                thread::sleep(Duration::from_millis(10));
            }
            Err(error) => return Err(format!("Cannot read updater request: {error}")),
        }
    }
}
fn service_manager(access: ServiceManagerAccess) -> Result<ServiceManager, String> {
    ServiceManager::local_computer(None::<&str>, access).map_err(|error| error.to_string())
}
fn saved_operator_sid(bytes: &[u8]) -> Result<String, String> {
    let saved: Operators = serde_json::from_slice(bytes)
        .map_err(|_| "Existing updater operator configuration is invalid.")?;
    let sid = saved
        .allowed_sids
        .first()
        .ok_or("Existing updater operator list is empty.")?;
    validate_sid(sid)?;
    Ok(sid.clone())
}

fn operator_for_install_at(path: &Path, operator: Option<&str>) -> Result<(String, bool), String> {
    match fs::read(path) {
        // A repair or upgrade must retain the protected operator list even if
        // the installer accidentally forwards a stale or empty account field.
        Ok(bytes) => Ok((saved_operator_sid(&bytes)?, false)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let input = operator.ok_or("First install requires an explicit maintenance account.")?;
            let sid = if input.starts_with("S-1-") {
                validate_sid(input)?;
                input.to_owned()
            } else {
                account_name_sid(input)?
            };
            Ok((sid, true))
        }
        Err(error) => Err(format!("Cannot read updater operator configuration: {error}")),
    }
}

fn operator_for_install(operator: Option<&str>) -> Result<(String, bool), String> {
    operator_for_install_at(&updater_root()?.join("operators.json"), operator)
}

fn install_service(operator: Option<&str>) -> Result<(), String> {
    let (sid, first_install) = operator_for_install(operator)?;
    let manager = service_manager(ServiceManagerAccess::CONNECT | ServiceManagerAccess::CREATE_SERVICE)
        .map_err(|error| format!("Cannot open Windows Service Control Manager for updater install: {error}"))?;
    let info = ServiceInfo {
        name: OsString::from(SERVICE_NAME),
        display_name: OsString::from(SERVICE_DISPLAY_NAME),
        service_type: ServiceType::OWN_PROCESS,
        start_type: ServiceStartType::AutoStart,
        error_control: ServiceErrorControl::Normal,
        executable_path: std::env::current_exe().map_err(|error| error.to_string())?,
        launch_arguments: vec![OsString::from("run")],
        dependencies: vec![],
        account_name: None,
        account_password: None,
    };
    let access = ServiceAccess::QUERY_STATUS
        | ServiceAccess::CHANGE_CONFIG
        | ServiceAccess::START
        | ServiceAccess::STOP
        | ServiceAccess::DELETE;
    let service = match manager.open_service(SERVICE_NAME, access) {
        Ok(service) => {
            service
                .change_config(&info)
                .map_err(|error| format!("Cannot update existing updater service configuration: {error}"))?;
            service
        }
        Err(_) => manager
            .create_service(&info, access)
            .map_err(|error| format!("Cannot create updater service: {error}"))?,
    };
    service
        .set_description("Installs authenticated SUGRID inventory releases and manages backups.")
        .map_err(|error| format!("Cannot set updater service description: {error}"))?;
    service
        .update_failure_actions(ServiceFailureActions {
            reset_period: ServiceFailureResetPeriod::After(Duration::from_secs(86400)),
            reboot_msg: None,
            command: None,
            actions: Some(vec![
                ServiceAction {
                    action_type: ServiceActionType::Restart,
                    delay: Duration::from_secs(5),
                },
                ServiceAction {
                    action_type: ServiceActionType::Restart,
                    delay: Duration::from_secs(15),
                },
            ]),
        })
        .map_err(|error| format!("Cannot configure updater service recovery: {error}"))?;
    if service
        .query_status()
        .map_err(|error| format!("Cannot query updater service state: {error}"))?
        .current_state
        == ServiceState::Stopped
    {
        service
            .start::<OsString>(&[])
            .map_err(|error| format!("Cannot start updater service: {error}"))?;
    }
    // Do not rewrite a protected operator list during a repair or upgrade.
    if first_install {
        update_operators(&sid, true)
            .map_err(|error| format!("Cannot save updater maintenance account: {error}"))?;
    }
    Ok(())
}
fn stop_service() -> Result<(), String> {
    ensure_no_pending_recovery()?;
    let manager = service_manager(ServiceManagerAccess::CONNECT)?;
    let service = match manager
        .open_service(
            SERVICE_NAME,
            ServiceAccess::QUERY_STATUS | ServiceAccess::STOP,
        )
    {
        Ok(service) => service,
        Err(windows_service::Error::Winapi(error)) if error.raw_os_error() == Some(1060) => {
            return Ok(());
        }
        Err(error) => return Err(error.to_string()),
    };
    if service
        .query_status()
        .map_err(|error| error.to_string())?
        .current_state
        == ServiceState::Stopped
    {
        return Ok(());
    }
    let inventory_was_running = match manager.open_service(
        INVENTORY_SERVICE_NAME,
        ServiceAccess::QUERY_STATUS,
    ) {
        Ok(inventory) => inventory
            .query_status()
            .map_err(|error| error.to_string())?
            .current_state
            != ServiceState::Stopped,
        Err(windows_service::Error::Winapi(error)) if error.raw_os_error() == Some(1060) => false,
        Err(error) => return Err(error.to_string()),
    };
    if inventory_was_running {
        run_host("stop")?;
    }
    if let Err(error) = service.stop() {
        if inventory_was_running {
            let _ = run_host("start");
        }
        return Err(format!("Cannot stop updater service: {error}"));
    }
    for _ in 0..100 {
        if service
            .query_status()
            .map_err(|error| error.to_string())?
            .current_state
            == ServiceState::Stopped
        {
            return Ok(());
        }
        thread::sleep(Duration::from_millis(200));
    }
    if inventory_was_running {
        let _ = run_host("start");
    }
    Err("Updater service did not stop in time.".into())
}

fn start_service() -> Result<(), String> {
    let manager = service_manager(ServiceManagerAccess::CONNECT)
        .map_err(|error| format!("Cannot open Windows Service Control Manager: {error}"))?;
    let service = manager
        .open_service(
            SERVICE_NAME,
            ServiceAccess::QUERY_STATUS | ServiceAccess::START,
        )
        .map_err(|error| format!("Cannot open updater service: {error}"))?;
    match service
        .query_status()
        .map_err(|error| format!("Cannot query updater service state: {error}"))?
        .current_state
    {
        ServiceState::Stopped => service
            .start::<OsString>(&[])
            .map_err(|error| format!("Cannot start updater service: {error}"))?,
        ServiceState::Running | ServiceState::StartPending | ServiceState::ContinuePending => {}
        state => return Err(format!("Updater service cannot start from state {state:?}.")),
    }
    Ok(())
}

fn uninstall_service() -> Result<(), String> {
    stop_service()?;
    let manager = service_manager(ServiceManagerAccess::CONNECT)?;
    let service = match manager.open_service(SERVICE_NAME, ServiceAccess::DELETE) {
        Ok(service) => service,
        Err(windows_service::Error::Winapi(error)) if error.raw_os_error() == Some(1060) => {
            return Ok(());
        }
        Err(error) => return Err(error.to_string()),
    };
    service.delete().map_err(|error| error.to_string())
}
define_windows_service!(ffi_service_main, service_main);
fn service_main(_arguments: Vec<OsString>) {
    if let Err(error) = run_service() {
        append_updater_log(&format!("Updater service failed: {error}"));
        std::process::exit(1);
    }
}
fn append_updater_log(message: &str) {
    if let Ok(directory) = updater_root() {
        let _ = fs::create_dir_all(&directory);
        if let Ok(mut file) = OpenOptions::new()
            .create(true)
            .append(true)
            .open(directory.join("service.log"))
        {
            let _ = writeln!(file, "{} {message}", stamp());
        }
    }
}
fn run_service() -> Result<(), String> {
    let state = Arc::new(State::new());
    let control = Arc::clone(&state);
    let handler = service_control_handler::register(SERVICE_NAME, move |event| match event {
        ServiceControl::Stop
            if control
                .operation
                .lock()
                .is_ok_and(|operation| operation.state == "running") =>
        {
            ServiceControlHandlerResult::NotImplemented
        }
        ServiceControl::Stop | ServiceControl::Shutdown => {
            control.stop.store(true, Ordering::SeqCst);
            let _ = OpenOptions::new().read(true).write(true).open(PIPE_NAME);
            ServiceControlHandlerResult::NoError
        }
        ServiceControl::Interrogate => ServiceControlHandlerResult::NoError,
        _ => ServiceControlHandlerResult::NotImplemented,
    })
    .map_err(|error| error.to_string())?;
    let status = |current_state, controls_accepted| ServiceStatus {
        service_type: ServiceType::OWN_PROCESS,
        current_state,
        controls_accepted,
        exit_code: ServiceExitCode::Win32(0),
        checkpoint: 0,
        wait_hint: Duration::default(),
        process_id: None,
    };
    handler
        .set_service_status(ServiceStatus {
            current_state: ServiceState::StartPending,
            wait_hint: Duration::from_secs(120),
            checkpoint: 1,
            ..status(ServiceState::StartPending, ServiceControlAccept::empty())
        })
        .map_err(|error| error.to_string())?;
    match recover_interrupted_transaction() {
        Ok(true) => {
            append_updater_log("Interrupted inventory transaction was rolled back before updater startup.");
            if let Ok(mut operation) = state.operation.lock() {
                operation.stage = "rolling_back".into();
                operation.state = "recovered".into();
                operation.error = Some("上次库存维护中断；已恢复旧运行文件和数据库。".into());
            }
        }
        Ok(false) => {}
        Err(error) => {
            append_updater_log(&format!("Interrupted transaction recovery failed: {error}"));
            handler
                .set_service_status(ServiceStatus {
                    current_state: ServiceState::Stopped,
                    exit_code: ServiceExitCode::ServiceSpecific(1),
                    ..status(ServiceState::Stopped, ServiceControlAccept::empty())
                })
                .map_err(|status_error| status_error.to_string())?;
            return Err(format!("Inventory recovery requires manual review: {error}"));
        }
    }
    handler
        .set_service_status(status(
            ServiceState::Running,
            ServiceControlAccept::STOP | ServiceControlAccept::SHUTDOWN,
        ))
        .map_err(|error| error.to_string())?;
    while !state.stop.load(Ordering::SeqCst) {
        if let Err(error) = pipe_once(&state) {
            append_updater_log(&format!("Updater pipe error: {error}"));
            if error.starts_with("Cannot protect updater pipe") {
                return Err(error);
            }
            thread::sleep(Duration::from_secs(1));
        }
    }
    handler
        .set_service_status(status(ServiceState::Stopped, ServiceControlAccept::empty()))
        .map_err(|error| error.to_string())
}
fn dispatch(request: Request, sid: &str, admin: bool, state: &Arc<State>) -> Response {
    let permitted = can_manage(sid, admin);
    dispatch_permitted(request, permitted, state)
}
fn dispatch_permitted(request: Request, permitted: bool, state: &Arc<State>) -> Response {
    let id = request.id;
    let result = match request.command.as_str() {
        "status" => status(state, permitted),
        "install" | "backup" | "restore" | "cancel" | "start" | "stop" if !permitted => {
            Err("This Windows account cannot manage inventory service updates.".into())
        }
        "install" => start_install(state, request.package_path.as_deref()),
        "backup" => start_backup(state),
        "restore" => start_restore(state, request.backup_name.as_deref()),
        "cancel" => cancel_operation(state, request.operation_id.as_deref()),
        "start" => service_command(state, "start"),
        "stop" => service_command(state, "stop"),
        _ => Err("Unsupported updater command.".into()),
    };
    match result {
        Ok(value) => Response::ok(id, value),
        Err(error) => Response::error(id, error),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn non_maintainer_cannot_submit_system_operations() {
        let state = Arc::new(State::new());
        for command in ["install", "backup", "restore", "cancel", "start", "stop"] {
            let response = dispatch_permitted(
                Request {
                    id: 7,
                    command: command.into(),
                    package_path: None,
                    backup_name: None,
                    operation_id: None,
                },
                false,
                &state,
            );
            assert!(!response.ok, "{command} must require maintenance permission");
            assert!(response.error.unwrap().contains("cannot manage"));
        }
    }

    #[test]
    fn ambiguous_account_names_are_rejected() {
        assert!(account_name_sid("user").is_err());
        assert!(account_name_sid("").is_err());
        assert!(account_name_sid(".\\sugrid_qa_user_does_not_exist").is_err());
    }

    #[test]
    fn saved_operator_list_is_authoritative_for_repairs() {
        let bytes = serde_json::to_vec(&Operators {
            allowed_sids: vec!["S-1-5-18".into()],
        })
        .unwrap();
        assert_eq!(saved_operator_sid(&bytes).unwrap(), "S-1-5-18");
        assert!(saved_operator_sid(b"not-json").is_err());
        assert!(saved_operator_sid(b"{\"allowedSids\":[]}").is_err());
    }

    #[test]
    fn existing_operator_file_overrides_stale_installer_input() {
        let path = std::env::temp_dir().join(format!(
            "sugrid-operator-repair-test-{}.json",
            std::process::id()
        ));
        let bytes = serde_json::to_vec(&Operators {
            allowed_sids: vec!["S-1-5-18".into()],
        })
        .unwrap();
        fs::write(&path, bytes).unwrap();
        let result = operator_for_install_at(&path, Some("bare-user"));
        fs::remove_file(&path).unwrap();
        assert_eq!(result.unwrap(), ("S-1-5-18".into(), false));
    }
}
fn status(state: &Arc<State>, permitted: bool) -> Result<Value, String> {
    let operation = state
        .operation
        .lock()
        .map_err(|_| "Updater state is unavailable.")?
        .clone();
    let version = fs::read(metadata_path()?)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        .and_then(|value| {
            value
                .get("version")
                .and_then(Value::as_str)
                .map(str::to_owned)
        });
    Ok(
        json!({"updaterProtocol":UPDATER_PROTOCOL,"canManage":permitted,"inventoryVersion":version,"operationId":operation.operation_id,"stage":operation.stage,"state":operation.state,"error":operation.error}),
    )
}
fn service_command(state: &Arc<State>, command: &str) -> Result<Value, String> {
    if command == "start" {
        ensure_no_pending_recovery()?;
    }
    if state
        .operation
        .lock()
        .map_err(|_| "Updater state is unavailable.")?
        .state
        == "running"
    {
        return Err("Another maintenance operation is running.".into());
    }
    run_host(command)?;
    status(state, true)
}
fn cancel_operation(state: &Arc<State>, id: Option<&str>) -> Result<Value, String> {
    let operation = state
        .operation
        .lock()
        .map_err(|_| "Updater state is unavailable.")?;
    if operation.state != "running" || operation.operation_id.as_deref() != id {
        return Err("The requested operation is not active.".into());
    }
    if !matches!(
        operation.stage.as_str(),
        "copying" | "verifying" | "backing_up" | "migrating"
    ) {
        return Err("The operation has passed the cancellation point.".into());
    }
    state.cancel.store(true, Ordering::SeqCst);
    drop(operation);
    status(state, true)
}
pub fn begin(state: &Arc<State>, stage: &str) -> Result<String, String> {
    let mut operation = state
        .operation
        .lock()
        .map_err(|_| "Updater state is unavailable.")?;
    if operation.state == "running" {
        return Err("Another maintenance operation is running.".into());
    }
    let id = format!("{}-{}", stamp(), std::process::id());
    *operation = Operation {
        operation_id: Some(id.clone()),
        stage: stage.into(),
        state: "running".into(),
        error: None,
        inventory_version: None,
    };
    state.cancel.store(false, Ordering::SeqCst);
    Ok(id)
}
pub fn set_stage(state: &Arc<State>, stage: &str) {
    if let Ok(mut operation) = state.operation.lock() {
        operation.stage = stage.into();
    }
}
pub fn finish(state: &Arc<State>, result: Result<Option<String>, String>) {
    if let Ok(mut operation) = state.operation.lock() {
        match result {
            Ok(version) => {
                operation.stage = "complete".into();
                operation.state = "succeeded".into();
                operation.inventory_version = version;
                operation.error = None;
            }
            Err(error) if error == "cancelled" => {
                operation.state = "cancelled".into();
                operation.error = None;
            }
            Err(error) => {
                operation.state = "failed".into();
                operation.error = Some(error);
            }
        }
    }
}
pub fn main() {
    let mut args = std::env::args().skip(1);
    let command = args.next().unwrap_or_else(|| "run".to_string());
    let argument = args.next();
    let result = if args.next().is_some() {
        Err("Unexpected trailing updater arguments.".into())
    } else {
        match command.as_str() {
        "run" if argument.is_none() => windows_service::service_dispatcher::start(SERVICE_NAME, ffi_service_main)
            .map_err(|error| error.to_string()),
        "install-service" => install_service(argument.as_deref()),
        "add-operator" => argument
            .ok_or_else(|| "An operator SID is required.".to_string())
            .and_then(|sid| update_operators(&sid, true)),
        "remove-operator" => argument
            .ok_or_else(|| "An operator SID is required.".to_string())
            .and_then(|sid| update_operators(&sid, false)),
        "start-service" if argument.is_none() => start_service(),
        "stop-service" if argument.is_none() => stop_service(),
        "uninstall-service" if argument.is_none() => uninstall_service(),
        #[cfg(feature = "updater-qa")]
        "verify-package" => (|| {
            let source = argument.ok_or("QA verification requires a package path.")?;
            let destination = std::env::temp_dir().join(format!(
                "sugrid-qa-verify-{}-{}",
                std::process::id(),
                stamp()
            ));
            let verified = crate::updater_package::verify_and_extract(
                Path::new(&source),
                &destination,
                crate::updater_package::embedded_public_key()?,
            );
            let _ = fs::remove_dir_all(&destination);
            let verified = verified?;
            println!(
                "verified inventory {} commit {}",
                verified.manifest.version, verified.manifest.commit_sha
            );
            Ok(())
        })(),
        _ => Err("Unsupported updater command.".into()),
        }
    };
    if let Err(error) = result {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
