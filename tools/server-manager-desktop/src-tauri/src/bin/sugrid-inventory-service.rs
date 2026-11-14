#![cfg_attr(all(windows, not(feature = "updater-qa")), windows_subsystem = "windows")]

#[cfg(windows)]
mod service_host {
    use rusqlite::{Connection, OpenFlags, backup::Backup, ffi};
    use serde::{Deserialize, Serialize};
    use std::{
        ffi::{CString, OsStr, OsString},
        fs::{self, OpenOptions},
        io::{self, Write},
        net::TcpListener,
        path::{Path, PathBuf},
        process::{Command, Stdio},
        ptr,
        sync::mpsc,
        thread,
        time::{Duration, SystemTime, UNIX_EPOCH},
    };
    use windows_service::{
        Error as WindowsServiceError, define_windows_service,
        service::{
            ServiceAccess, ServiceAction, ServiceActionType, ServiceControl, ServiceControlAccept,
            ServiceDependency, ServiceErrorControl, ServiceExitCode, ServiceFailureActions,
            ServiceFailureResetPeriod, ServiceInfo, ServiceStartType, ServiceState, ServiceStatus,
            ServiceType,
        },
        service_control_handler::{self, ServiceControlHandlerResult},
        service_manager::{ServiceManager, ServiceManagerAccess},
    };

    #[cfg(not(feature = "updater-qa"))]
    const SERVICE_NAME: &str = "SUGRIDInventory";
    #[cfg(feature = "updater-qa")]
    const SERVICE_NAME: &str = "SUGRIDInventoryQA";
    #[cfg(not(feature = "updater-qa"))]
    const UPDATER_SERVICE_NAME: &str = "SUGRIDInventoryUpdater";
    #[cfg(feature = "updater-qa")]
    const UPDATER_SERVICE_NAME: &str = "SUGRIDInventoryUpdaterQA";
    #[cfg(not(feature = "updater-qa"))]
    const SERVICE_DISPLAY_NAME: &str = "SUGRID Inventory Server";
    #[cfg(feature = "updater-qa")]
    const SERVICE_DISPLAY_NAME: &str = "SUGRID Inventory Server QA";
    const DATA_FOLDER: &str = "SUGRID\\Inventory";
    #[cfg(not(feature = "updater-qa"))]
    const PORT: u16 = 3000;
    #[cfg(feature = "updater-qa")]
    const PORT: u16 = 3300;

    #[derive(Debug, Serialize, Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct LegacyConfig {
        project_root: String,
        database_path: String,
    }

    #[derive(Debug, Serialize, Deserialize)]
    struct MigrationState {
        source: Option<PathBuf>,
        backup: Option<PathBuf>,
        staging: PathBuf,
    }

    #[derive(Debug, Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct UpdaterMigrationRequest {
        format_version: u32,
        operation_id: String,
        runtime_relative: String,
        database_relative: String,
    }

    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct UpdaterMigrationResult<'a> {
        format_version: u32,
        operation_id: &'a str,
        success: bool,
        error_code: Option<&'a str>,
    }

    #[derive(Debug, Serialize, Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct BackupManifestItem {
        name: String,
        size: u64,
        modified_at: u64,
        verified: bool,
    }

    #[derive(Clone, Debug)]
    struct Paths {
        inventory: PathBuf,
        service_exe: PathBuf,
        source_service_exe: PathBuf,
        program_data: PathBuf,
        database: PathBuf,
        backups: PathBuf,
        logs: PathBuf,
    }

    fn data_root() -> Result<PathBuf, String> {
        #[cfg(feature = "updater-qa")]
        {
            return option_env!("SUGRID_UPDATER_QA_ROOT")
                .map(PathBuf::from)
                .ok_or("QA build requires SUGRID_UPDATER_QA_ROOT at compile time.".into());
        }
        #[cfg(not(feature = "updater-qa"))]
        {
        let root = std::env::var_os("PROGRAMDATA")
            .map(PathBuf::from)
            .ok_or("Windows did not provide the ProgramData directory.")?;
        Ok(root.join(DATA_FOLDER))
        }
    }

    fn current_paths() -> Result<Paths, String> {
        let executable = std::env::current_exe().map_err(|error| error.to_string())?;
        let service_dir = executable
            .parent()
            .ok_or("Service executable has no parent directory.")?;
        let program_data = data_root()?;
        let inventory = if service_dir
            .file_name()
            .is_some_and(|name| name == "inventory")
        {
            service_dir.to_path_buf()
        } else {
            program_data.join("inventory")
        };
        Ok(paths_for(&inventory, &program_data, &executable))
    }

    fn inventory_runtime_available(paths: &Paths) -> bool {
        paths.inventory.join("node.exe").is_file() && paths.inventory.join("server.js").is_file()
    }

    fn installed_inventory_version(paths: &Paths) -> String {
        fs::read(paths.program_data.join("inventory-version.json"))
            .ok()
            .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
            .and_then(|value| {
                value
                    .get("version")
                    .and_then(|version| version.as_str())
                    .map(str::to_owned)
            })
            .filter(|version| {
                !version.is_empty()
                    && version.len() <= 64
                    && version.bytes().all(|byte| {
                        byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'_')
                    })
            })
            .unwrap_or_else(|| "legacy-unknown".to_string())
    }

    fn paths_for(inventory: &Path, root: &Path, executable: &Path) -> Paths {
        Paths {
            inventory: inventory.to_path_buf(),
            service_exe: root.join("app").join("sugrid-inventory-service.exe"),
            source_service_exe: executable.to_path_buf(),
            program_data: root.to_path_buf(),
            database: root.join("data").join("inventory.db"),
            backups: root.join("backups"),
            logs: root.join("logs"),
        }
    }

    fn now_stamp() -> String {
        let millis = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis();
        millis.to_string()
    }

    fn windows_service_error(error: &WindowsServiceError) -> String {
        let code = std::error::Error::source(error)
            .and_then(|source| source.downcast_ref::<io::Error>())
            .and_then(io::Error::raw_os_error);
        match code {
            Some(code) => format!("{error} (Win32 error {code})"),
            None => error.to_string(),
        }
    }

    fn io_error_summary(error: &io::Error) -> String {
        match error.raw_os_error() {
            Some(code) => format!("{error} (os error {code})"),
            None => error.to_string(),
        }
    }

    fn install_diagnostic_path(root: &Path) -> PathBuf {
        root.join("install-diagnostics.txt")
    }

    fn install_error_code(error: &str) -> String {
        // Keep the public summary free of local paths and database contents.
        if error.contains("sqlite_primary=") && error.contains("sqlite_extended=") {
            let primary = error_value(error, "sqlite_primary=").unwrap_or("unknown");
            let extended = error_value(error, "sqlite_extended=").unwrap_or("unknown");
            let system = error_value(error, "sqlite_system=").unwrap_or("unknown");
            return format!(
                "sqlite_primary={primary},sqlite_extended={extended},sqlite_system={system}"
            );
        }
        if let Some(exit_code) = error_value(error, "command_exit=") {
            let mut details = vec![format!("command_exit={exit_code}")];
            if let Some(os_code) = error_value(error, "acl_os=") {
                details.push(format!("os={os_code}"));
            }
            return details.join(",");
        }
        if let Some(os_code) = error_value(error, "acl_os=") {
            return format!("os={os_code}");
        }
        let marker = "Win32 error ";
        if let Some(start) = error.find(marker) {
            let code = error[start + marker.len()..]
                .chars()
                .take_while(char::is_ascii_digit)
                .collect::<String>();
            if !code.is_empty() {
                return format!("win32={code}");
            }
        }
        let marker = "os error ";
        if let Some(start) = error.find(marker) {
            let code = error[start + marker.len()..]
                .chars()
                .take_while(char::is_ascii_digit)
                .collect::<String>();
            if !code.is_empty() {
                return format!("os={code}");
            }
        }
        "code=unavailable".into()
    }

    fn error_value<'a>(error: &'a str, marker: &str) -> Option<&'a str> {
        let start = error.find(marker)? + marker.len();
        let value = error[start..]
            .chars()
            .take_while(char::is_ascii_digit)
            .collect::<String>();
        (!value.is_empty()).then_some(&error[start..start + value.len()])
    }

    fn diagnostic_token<'a>(error: &'a str, marker: &str) -> Option<&'a str> {
        let start = error.find(marker)? + marker.len();
        let value = error[start..]
            .chars()
            .take_while(|character| {
                character.is_ascii_alphanumeric() || *character == '-' || *character == '_'
            })
            .count();
        (value > 0).then_some(&error[start..start + value])
    }

    fn install_error_kind(step: &str, error: &str) -> &'static str {
        if step == "backup-database" {
            if error.starts_with("Database file does not exist:") {
                "source-database-missing"
            } else if error.starts_with("Cannot open source database:") {
                "source-database-open-failed"
            } else if error.starts_with("Cannot create database copy:") {
                "backup-file-create-failed"
            } else if error.starts_with("SQLite online backup failed:") {
                "sqlite-backup-failed"
            } else if error.starts_with("Cannot open database:")
                || error.starts_with("SQLite integrity_check")
            {
                "backup-verification-failed"
            } else {
                "backup-failed"
            }
        } else {
            match step {
                "prepare-program-data" | "apply-data-permissions" | "apply-runtime-permissions" => {
                    "data-permissions-failed"
                }
                "install-windows-service" => "service-install-failed",
                "start-and-health-check" => "service-start-or-health-check-failed",
                "migrate-database" => "database-migration-failed",
                _ => "installation-step-failed",
            }
        }
    }

    fn is_permission_setup_step(step: &str) -> bool {
        matches!(
            step,
            "prepare-program-data" | "apply-data-permissions" | "apply-runtime-permissions"
        )
    }

    fn install_diagnostic_contents(step: &str, error: &str) -> String {
        format!(
            "step={step}; reason={}; operation={}; previous_operation={}; command={}; failure={}; {}; service={SERVICE_NAME}; port={PORT}\r\n",
            install_error_kind(step, error),
            diagnostic_token(error, "acl-operation=").unwrap_or("not-available"),
            diagnostic_token(error, "previous-operation=").unwrap_or("not-available"),
            diagnostic_token(error, "acl-command=").unwrap_or("not-available"),
            diagnostic_token(error, "acl-reason=").unwrap_or("not-available"),
            install_error_code(error),
        )
    }

    fn write_install_diagnostic_to(
        root: &Path,
        fallback_directory: &Path,
        step: &str,
        error: &str,
    ) -> Option<PathBuf> {
        let summary = install_diagnostic_contents(step, error);
        let path = install_diagnostic_path(root);
        if fs::create_dir_all(root).is_ok() && fs::write(&path, &summary).is_ok() {
            // The summary contains no database data, credentials, or local paths.
            let grant = hidden_command("icacls.exe")
                .args([
                    path.to_string_lossy().as_ref(),
                    "/grant:r",
                    "BUILTIN\\Users:(R)",
                ])
                .output();
            if grant.is_ok_and(|output| output.status.success()) {
                return Some(path);
            }
            let _ = fs::remove_file(&path);
        }

        let fallback = fallback_directory.join("sugrid-install-diagnostics.txt");
        if fs::write(&fallback, summary).is_ok() {
            Some(fallback)
        } else {
            None
        }
    }

    fn write_install_diagnostic(root: &Path, step: &str, error: &str) -> Option<PathBuf> {
        write_install_diagnostic_to(root, &std::env::temp_dir(), step, error)
    }

    fn command_diagnostic_contents(command: &str, error: &str) -> String {
        let safe_command = match command {
            "install"
            | "uninstall"
            | "stop"
            | "start"
            | "restore"
            | "backup"
            | "prepare-data-permissions"
            | "run" => command,
            _ => "unknown",
        };
        let step = match safe_command {
            "prepare-data-permissions" => "apply-data-permissions",
            "backup" | "restore" => "backup-database",
            _ => "preflight",
        };
        format!(
            "command={safe_command}; reason={}; {}; service={SERVICE_NAME}; port={PORT}\r\n",
            install_error_kind(step, error),
            install_error_code(error),
        )
    }

    fn write_command_diagnostic(command: &str, error: &str) -> Option<PathBuf> {
        let path = std::env::temp_dir().join("sugrid-service-host-diagnostic.txt");
        fs::write(&path, command_diagnostic_contents(command, error))
            .ok()
            .map(|()| path)
    }

    fn clear_stale_install_diagnostics(root: &Path, temporary_directory: &Path) -> Vec<String> {
        let mut failures = Vec::new();
        for (location, path) in [
            ("program-data", install_diagnostic_path(root)),
            (
                "temporary-installer",
                temporary_directory.join("sugrid-install-diagnostics.txt"),
            ),
            (
                "temporary-service-host",
                temporary_directory.join("sugrid-service-host-diagnostic.txt"),
            ),
        ] {
            match fs::remove_file(&path) {
                Ok(()) => {}
                Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                Err(error) => failures.push(format!("{location}: {}", io_error_summary(&error))),
            }
        }
        failures
    }

    fn append_log(paths: &Paths, message: &str) {
        let _ = fs::create_dir_all(&paths.logs);
        if let Ok(mut file) = OpenOptions::new()
            .create(true)
            .append(true)
            .open(paths.logs.join("service-manager.log"))
        {
            let _ = writeln!(file, "{} {message}", now_stamp());
        }
    }

    fn append_service_host_log(message: &str) {
        // This also works when current_paths fails before the service handler is registered.
        if let Ok(root) = data_root() {
            let logs = root.join("logs");
            if let Ok(mut file) = OpenOptions::new()
                .create(true)
                .append(true)
                .open(logs.join("service-host.log"))
            {
                let _ = writeln!(file, "{} {message}", now_stamp());
            }
        }
    }

    fn hidden_command(program: impl AsRef<OsStr>) -> Command {
        use std::os::windows::process::CommandExt;
        let mut command = Command::new(program);
        command.creation_flags(windows_sys::Win32::System::Threading::CREATE_NO_WINDOW);
        command
    }

    fn path_from_legacy_config(path: &Path, destination: &Path) -> Result<Option<PathBuf>, String> {
        if !path.is_file() {
            return Ok(None);
        }
        let text = fs::read_to_string(path)
            .map_err(|error| format!("Cannot read previous manager settings: {error}"))?;
        let legacy: LegacyConfig = serde_json::from_str(&text)
            .map_err(|error| format!("Previous manager settings are invalid: {error}"))?;
        let root = legacy.project_root.trim();
        if root.is_empty() {
            return Ok(None);
        }
        let raw = normalize_legacy_path(&legacy.database_path);
        if raw.as_os_str().is_empty() {
            return Err("Previous manager settings do not contain a database path.".into());
        }
        let candidate = if raw.is_absolute() {
            raw
        } else {
            PathBuf::from(root).join(raw)
        };
        if same_path(&candidate, destination) {
            return Ok(None);
        }
        if !candidate.is_file() {
            return Err(format!(
                "The previously configured database was not found: {}",
                candidate.display()
            ));
        }
        Ok(Some(
            candidate
                .canonicalize()
                .map_err(|error| error.to_string())?,
        ))
    }

    fn normalize_legacy_path(value: &str) -> PathBuf {
        let value = value.trim();
        if let Some(path) = value.strip_prefix(r#"\\?\UNC\"#) {
            return PathBuf::from(format!(r#"\\{}"#, path));
        }
        if let Some(path) = value.strip_prefix(r#"\\?\"#) {
            return PathBuf::from(path);
        }
        PathBuf::from(value)
    }

    fn same_path(left: &Path, right: &Path) -> bool {
        let left = left.canonicalize().unwrap_or_else(|_| left.to_path_buf());
        let right = right.canonicalize().unwrap_or_else(|_| right.to_path_buf());
        left.to_string_lossy()
            .eq_ignore_ascii_case(&right.to_string_lossy())
    }

    fn inspect_database(path: &Path) -> Result<(), String> {
        let database = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
            .map_err(|error| format!("Cannot open SQLite database {}: {error}", path.display()))?;
        let integrity: String = database
            .query_row("PRAGMA integrity_check", [], |row| row.get(0))
            .map_err(|error| format!("SQLite integrity check failed: {error}"))?;
        if integrity != "ok" {
            return Err(format!("SQLite integrity check returned: {integrity}"));
        }
        let violations: u64 = database
            .prepare("PRAGMA foreign_key_check")
            .map_err(|error| error.to_string())?
            .query_map([], |_| Ok(()))
            .map_err(|error| error.to_string())?
            .count() as u64;
        if violations != 0 {
            return Err(format!(
                "SQLite foreign_key_check found {violations} violation(s)."
            ));
        }
        Ok(())
    }

    fn online_backup(source_path: &Path, destination_path: &Path) -> Result<(), String> {
        let source = open_backup_source_database(source_path)?;
        let mut destination = Connection::open(destination_path)
            .map_err(|error| format!("Cannot create database copy: {error}"))?;
        let backup = Backup::new(&source, &mut destination).map_err(|error| error.to_string())?;
        backup
            .run_to_completion(128, Duration::from_millis(25), None)
            .map_err(|error| format!("SQLite online backup failed: {error}"))?;
        drop(backup);
        destination
            .close()
            .map_err(|(_, error)| error.to_string())?;
        inspect_database(destination_path)
    }

    fn open_source_database(path: &Path) -> Result<Connection, String> {
        open_source_database_with_flags(
            path,
            OpenFlags::SQLITE_OPEN_READ_ONLY
                | OpenFlags::SQLITE_OPEN_FULL_MUTEX
                | OpenFlags::SQLITE_OPEN_EXRESCODE,
        )
    }

    fn open_backup_source_database(path: &Path) -> Result<Connection, String> {
        open_backup_source_database_with(path, open_source_database, |path| {
            open_source_database_with_flags(
                path,
                OpenFlags::SQLITE_OPEN_READ_WRITE
                    | OpenFlags::SQLITE_OPEN_FULL_MUTEX
                    | OpenFlags::SQLITE_OPEN_EXRESCODE,
            )
        })
    }

    fn open_backup_source_database_with<ReadOnly, ReadWrite>(
        path: &Path,
        read_only_open: ReadOnly,
        read_write_open: ReadWrite,
    ) -> Result<Connection, String>
    where
        ReadOnly: FnOnce(&Path) -> Result<Connection, String>,
        ReadWrite: FnOnce(&Path) -> Result<Connection, String>,
    {
        match read_only_open(path) {
            Ok(database) => Ok(database),
            Err(read_only_error)
                if read_only_error.contains("sqlite_primary=14")
                    && read_only_error.contains("sqlite_system=5")
                    && path.is_file() =>
            {
                read_write_open(path).map_err(|read_write_error| {
                    format!(
                        "Cannot open source database: read-only WAL access failed ({read_only_error}); read-write recovery access failed ({read_write_error})"
                    )
                })
            }
            Err(error) => Err(error),
        }
    }

    fn open_source_database_with_flags(
        path: &Path,
        flags: OpenFlags,
    ) -> Result<Connection, String> {
        let path_text = path
            .to_str()
            .ok_or_else(|| "Cannot open source database: invalid database path".to_string())?;
        let c_path = CString::new(path_text)
            .map_err(|_| "Cannot open source database: invalid database path".to_string())?;
        let flags = flags.bits();
        let mut handle = ptr::null_mut();
        let result =
            unsafe { ffi::sqlite3_open_v2(c_path.as_ptr(), &mut handle, flags, ptr::null()) };
        if result != ffi::SQLITE_OK {
            let details = if handle.is_null() {
                format!(
                    "sqlite_primary={} sqlite_extended={result} sqlite_system=0",
                    result & 0xff
                )
            } else {
                let primary = unsafe { ffi::sqlite3_errcode(handle) };
                let extended = unsafe { ffi::sqlite3_extended_errcode(handle) };
                let system = unsafe { ffi::sqlite3_system_errno(handle) };
                let _ = unsafe { ffi::sqlite3_close(handle) };
                format!(
                    "sqlite_primary={primary} sqlite_extended={extended} sqlite_system={system}"
                )
            };
            return Err(format!("Cannot open source database: {details}"));
        }
        unsafe { Connection::from_handle_owned(handle) }
            .map_err(|error| format!("Cannot wrap source database connection: {error}"))
    }

    fn migration_sidecar_path(database: &Path, suffix: &str) -> PathBuf {
        let mut name = database.file_name().unwrap_or_default().to_os_string();
        name.push(suffix);
        database.with_file_name(name)
    }

    fn finalize_database_for_activation(database_path: &Path) -> Result<(), String> {
        let database = Connection::open_with_flags(
            database_path,
            OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_FULL_MUTEX,
        )
        .map_err(|error| format!("Cannot prepare migration database: {error}"))?;
        let (busy, wal_frames, checkpointed_frames): (i64, i64, i64) = database
            .query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?))
            })
            .map_err(|error| format!("Cannot checkpoint migration database: {error}"))?;
        if busy != 0 || (wal_frames >= 0 && checkpointed_frames < wal_frames) {
            return Err(format!(
                "Migration database WAL checkpoint was incomplete (busy={busy}, frames={wal_frames}, checkpointed={checkpointed_frames})."
            ));
        }
        let journal_mode: String = database
            .query_row("PRAGMA journal_mode=DELETE", [], |row| row.get(0))
            .map_err(|error| format!("Cannot switch migration database to DELETE mode: {error}"))?;
        if !journal_mode.eq_ignore_ascii_case("delete") {
            return Err(format!(
                "Migration database stayed in {journal_mode} journal mode."
            ));
        }
        drop(database);

        for suffix in ["-wal", "-shm"] {
            let sidecar = migration_sidecar_path(database_path, suffix);
            if sidecar.exists() {
                fs::remove_file(&sidecar).map_err(|error| {
                    format!("Could not remove finalized SQLite sidecar: {error}")
                })?;
            }
        }
        Ok(())
    }

    fn recover_legacy_migration_sidecars(
        database_path: &Path,
        staging_path: &Path,
    ) -> Result<(), String> {
        if staging_path.exists() {
            return Err(
                "Both the active database and the migration staging database exist. Neither was changed.".into(),
            );
        }
        let staging_wal = migration_sidecar_path(staging_path, "-wal");
        let database_wal = migration_sidecar_path(database_path, "-wal");
        if staging_wal.exists() {
            let staging_wal_len = fs::metadata(&staging_wal)
                .map_err(|error| format!("Could not inspect the migration WAL file: {error}"))?
                .len();
            if staging_wal_len == 0 {
                fs::remove_file(&staging_wal).map_err(|error| {
                    format!("Could not remove the empty migration WAL file: {error}")
                })?;
            } else {
                if database_wal.exists() {
                    return Err(
                        "Both the migrated database and its old staging database have WAL files. They were preserved for manual recovery.".into(),
                    );
                }
                fs::rename(&staging_wal, &database_wal).map_err(|error| {
                    format!("Could not recover the migration WAL file: {error}")
                })?;
            }
        }
        finalize_database_for_activation(database_path)?;
        let staging_shm = migration_sidecar_path(staging_path, "-shm");
        if staging_shm.exists() {
            fs::remove_file(&staging_shm)
                .map_err(|error| format!("Could not remove stale migration SHM file: {error}"))?;
        }
        Ok(())
    }

    fn create_backup_file(
        database: &Path,
        backup_dir: &Path,
    ) -> Result<(PathBuf, Option<String>), String> {
        if !database.is_file() {
            return Err(format!(
                "Database file does not exist: {}",
                database.display()
            ));
        }
        fs::create_dir_all(backup_dir).map_err(|error| error.to_string())?;
        let destination = backup_dir.join(format!("inventory.before-install-{}.db", now_stamp()));
        online_backup(database, &destination)?;
        // The verified database copy remains usable if its listing cannot be refreshed.
        let manifest_warning = write_backup_manifest(backup_dir).err();
        Ok((destination, manifest_warning))
    }

    fn write_backup_manifest(backup_dir: &Path) -> Result<(), String> {
        let mut items = fs::read_dir(backup_dir)
            .map_err(|error| error.to_string())?
            .filter_map(Result::ok)
            .filter(|entry| {
                entry.file_type().is_ok_and(|kind| kind.is_file())
                    && entry
                        .path()
                        .extension()
                        .is_some_and(|extension| extension == "db")
            })
            .filter_map(|entry| {
                let metadata = entry.metadata().ok()?;
                let name = entry.file_name().to_string_lossy().into_owned();
                let modified_at = metadata
                    .modified()
                    .ok()?
                    .duration_since(UNIX_EPOCH)
                    .ok()?
                    .as_secs();
                Some(BackupManifestItem {
                    name,
                    size: metadata.len(),
                    modified_at,
                    verified: inspect_database(&entry.path()).is_ok(),
                })
            })
            .collect::<Vec<_>>();
        items.sort_by(|left, right| right.modified_at.cmp(&left.modified_at));
        let manifest = backup_dir.join("manifest.json");
        // Write to a sibling file first so a permission or interruption never
        // truncates the last usable manifest. Callers may keep the verified
        // database backup even when this metadata refresh is unavailable.
        let temporary = backup_dir.join(format!(
            ".manifest-{}-{}.tmp",
            std::process::id(),
            now_stamp()
        ));
        fs::write(
            &temporary,
            serde_json::to_vec_pretty(&items).map_err(|error| error.to_string())?,
        )
        .map_err(|error| format!("Could not stage backup manifest: {error}"))?;
        let output = hidden_command("icacls.exe")
            .args([
                temporary.to_string_lossy().as_ref(),
                "/grant:r",
                "BUILTIN\\Users:(R)",
            ])
            .output()
            .map_err(|error| {
                let _ = fs::remove_file(&temporary);
                format!("Could not allow the manager to read backup metadata: {error}")
            })?;
        if !output.status.success() {
            let _ = fs::remove_file(&temporary);
            return Err(format!(
                "Could not allow the manager to read backup metadata: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            ));
        }
        if let Err(error) = replace_manifest_file(&temporary, &manifest) {
            let _ = fs::remove_file(&temporary);
            return Err(error);
        }
        Ok(())
    }

    fn replace_manifest_file(temporary: &Path, manifest: &Path) -> Result<(), String> {
        use std::os::windows::ffi::OsStrExt;
        let source = temporary
            .as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect::<Vec<_>>();
        let destination = manifest
            .as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect::<Vec<_>>();
        let ok = unsafe {
            windows_sys::Win32::Storage::FileSystem::MoveFileExW(
                source.as_ptr(),
                destination.as_ptr(),
                windows_sys::Win32::Storage::FileSystem::MOVEFILE_REPLACE_EXISTING,
            )
        };
        if ok == 0 {
            return Err(format!(
                "Could not replace backup manifest: {}",
                std::io::Error::last_os_error()
            ));
        }
        Ok(())
    }

    fn copy_directory(source: &Path, destination: &Path) -> Result<(), String> {
        fs::create_dir_all(destination).map_err(|error| error.to_string())?;
        for entry in fs::read_dir(source).map_err(|error| error.to_string())? {
            let entry = entry.map_err(|error| error.to_string())?;
            let from = entry.path();
            let to = destination.join(entry.file_name());
            let kind = entry.file_type().map_err(|error| error.to_string())?;
            if kind.is_dir() {
                copy_directory(&from, &to)?;
            } else if kind.is_file() {
                fs::copy(&from, &to)
                    .map_err(|error| format!("Could not copy {}: {error}", from.display()))?;
            } else {
                return Err(format!(
                    "Unsupported special file in installer payload: {}",
                    from.display()
                ));
            }
        }
        Ok(())
    }

    fn table_counts(path: &Path) -> Result<Vec<(String, i64)>, String> {
        let database = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
            .map_err(|error| error.to_string())?;
        let mut counts = Vec::new();
        for table in ["users", "inventory", "purchase_orders", "purchase_items"] {
            let exists: bool = database
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1)",
                    [table],
                    |row| row.get(0),
                )
                .map_err(|error| error.to_string())?;
            if exists {
                let count = database
                    .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
                        row.get(0)
                    })
                    .map_err(|error| error.to_string())?;
                counts.push((table.to_string(), count));
            }
        }
        Ok(counts)
    }

    fn verify_critical_rows(source: &Path, destination: &Path) -> Result<(), String> {
        let before = table_counts(source)?;
        let after = table_counts(destination)?;
        for (table, count) in before {
            if after
                .iter()
                .find(|(name, _)| name == &table)
                .map(|(_, value)| *value)
                != Some(count)
            {
                return Err(format!("Database migration changed the {table} row count."));
            }
        }
        Ok(())
    }

    fn migration_complete_path(database: &Path) -> PathBuf {
        database.with_file_name(".migration-complete.json")
    }

    fn migration_prepared_path(database: &Path) -> PathBuf {
        database.with_file_name(".migration-prepared.json")
    }

    fn write_state(path: &Path, state: &MigrationState) -> Result<(), String> {
        let temp = path.with_extension(format!("json.{}.tmp", std::process::id()));
        let bytes = serde_json::to_vec_pretty(state).map_err(|error| error.to_string())?;
        fs::write(&temp, bytes).map_err(|error| error.to_string())?;
        fs::rename(&temp, path).map_err(|error| {
            let _ = fs::remove_file(&temp);
            format!("Cannot record database migration state: {error}")
        })
    }

    fn run_initializer(inventory: &Path, database: &Path, logs: &Path) -> Result<(), String> {
        let node = inventory.join("node.exe");
        let initializer = inventory.join("scripts").join("init-db.js");
        if !initializer.is_file() {
            return Err(
                "The bundled database initializer is missing from the installer package.".into(),
            );
        }
        fs::create_dir_all(logs).map_err(|error| error.to_string())?;
        let output = hidden_command(node)
            .arg(&initializer)
            .current_dir(inventory)
            .env("INVENTORY_DB_PATH", database)
            .env("INVENTORY_TEST_MODE", "0")
            .output()
            .map_err(|error| format!("Could not run the bundled database migrations: {error}"))?;
        let mut log = OpenOptions::new()
            .create(true)
            .append(true)
            .open(logs.join("database-migration.log"))
            .map_err(|error| error.to_string())?;
        let _ = log.write_all(&output.stdout);
        let _ = log.write_all(&output.stderr);
        if !output.status.success() {
            return Err(format!(
                "Bundled database migration exited with {}. See the local migration log.",
                output.status
            ));
        }
        Ok(())
    }

    fn staged_migration_paths(
        paths: &Paths,
        request: &UpdaterMigrationRequest,
    ) -> Result<(PathBuf, PathBuf), String> {
        let id = &request.operation_id;
        if request.format_version != 1
            || id.is_empty()
            || id.len() > 80
            || !id.bytes().all(|byte| byte.is_ascii_digit() || byte == b'-')
            || request.runtime_relative != format!("updater/jobs/{id}/extracted/inventory")
            || request.database_relative != format!("data/inventory.migrating-{id}.db")
        {
            return Err("Invalid staged updater migration request.".into());
        }
        let runtime = paths.program_data.join(&request.runtime_relative);
        let database = paths.program_data.join(&request.database_relative);
        if !runtime.join("node.exe").is_file()
            || !runtime.join("scripts").join("init-db.js").is_file()
        {
            return Err("Staged updater runtime is unavailable.".into());
        }
        Ok((runtime, database))
    }

    fn run_staged_updater_migration(paths: &Paths) -> Result<Option<()>, String> {
        let data = paths.program_data.join("data");
        let request_path = data.join(".updater-migration-request.json");
        if !request_path.exists() {
            return Ok(None);
        }
        let request: UpdaterMigrationRequest = serde_json::from_slice(
            &fs::read(&request_path).map_err(|error| error.to_string())?,
        )
        .map_err(|_| "Staged updater migration request is malformed.")?;
        let migration = staged_migration_paths(paths, &request).and_then(|(runtime, database)| {
            run_initializer(&runtime, &database, &paths.logs)?;
            finalize_database_for_activation(&database)?;
            inspect_database(&database)
        });
        let error_code = if migration.is_ok() {
            None
        } else {
            Some("migration-failed")
        };
        let result = UpdaterMigrationResult {
            format_version: 1,
            operation_id: &request.operation_id,
            success: migration.is_ok(),
            error_code,
        };
        let result_path = data.join(".updater-migration-result.json");
        let temporary = data.join(format!(
            ".updater-migration-result-{}.tmp",
            request.operation_id
        ));
        fs::write(
            &temporary,
            serde_json::to_vec(&result).map_err(|error| error.to_string())?,
        )
        .map_err(|error| error.to_string())?;
        fs::rename(&temporary, &result_path).map_err(|error| error.to_string())?;
        migration.map(Some)
    }

    fn migrate_or_initialize(
        inventory: &Path,
        database: &Path,
        backup_dir: &Path,
        logs: &Path,
        legacy_config: &Path,
    ) -> Result<(), String> {
        migrate_database_paths(
            inventory,
            database,
            backup_dir,
            logs,
            legacy_config,
            |path| run_initializer(inventory, path, logs),
        )
    }

    fn migrate_database_paths(
        _inventory: &Path,
        database: &Path,
        backup_dir: &Path,
        _logs: &Path,
        legacy_config: &Path,
        initialize: impl Fn(&Path) -> Result<(), String>,
    ) -> Result<(), String> {
        fs::create_dir_all(database.parent().ok_or("Invalid database path.")?)
            .map_err(|error| error.to_string())?;
        fs::create_dir_all(backup_dir).map_err(|error| error.to_string())?;
        let complete = migration_complete_path(database);
        let prepared = migration_prepared_path(database);
        let staging = database.with_file_name("inventory.migrating.db");

        if complete.is_file() {
            let state: MigrationState =
                serde_json::from_slice(&fs::read(&complete).map_err(|error| error.to_string())?)
                    .map_err(|error| format!("Database migration record is invalid: {error}"))?;
            recover_legacy_migration_sidecars(database, &state.staging)?;
            inspect_database(database)?;
            return Ok(());
        }

        if prepared.is_file() {
            let state: MigrationState =
                serde_json::from_slice(&fs::read(&prepared).map_err(|error| error.to_string())?)
                    .map_err(|error| {
                        format!("Database migration recovery record is invalid: {error}")
                    })?;
            if !database.exists() && state.staging.is_file() {
                finalize_database_for_activation(&state.staging)?;
                inspect_database(&state.staging)?;
                if let Some(backup) = state.backup.as_ref() {
                    verify_critical_rows(backup, &state.staging)?;
                }
                fs::rename(&state.staging, database)
                    .map_err(|error| format!("Could not finish database migration: {error}"))?;
            } else if database.exists() {
                recover_legacy_migration_sidecars(database, &state.staging)?;
            }
            inspect_database(database)?;
            if let Some(backup) = state.backup.as_ref() {
                verify_critical_rows(backup, database)?;
            }
            write_state(&complete, &state)?;
            return Ok(());
        }

        if database.exists() {
            let source = path_from_legacy_config(legacy_config, database)?;
            if source.is_some() {
                return Err(format!(
                    "Both the existing ProgramData database and a previous project database exist. Nothing was replaced. Review {} and {} before retrying.",
                    database.display(),
                    source.unwrap().display()
                ));
            }
            finalize_database_for_activation(database)?;
            inspect_database(database)?;
            let state = MigrationState {
                source: None,
                backup: None,
                staging,
            };
            write_state(&complete, &state)?;
            return Ok(());
        }

        if staging.exists() {
            return Err(format!(
                "An incomplete database migration file exists at {} without a recovery record. It was left untouched.",
                staging.display()
            ));
        }

        let source = path_from_legacy_config(legacy_config, database)?;
        let backup = if let Some(source_path) = source.as_ref() {
            inspect_database(source_path)?;
            let backup_path =
                backup_dir.join(format!("inventory.before-integrated-{}.db", now_stamp()));
            online_backup(source_path, &backup_path)?;
            Some(backup_path)
        } else {
            None
        };

        if let Some(backup_path) = backup.as_ref() {
            fs::copy(backup_path, &staging)
                .map_err(|error| format!("Could not stage database migration: {error}"))?;
        }
        initialize(&staging)?;
        finalize_database_for_activation(&staging)?;
        inspect_database(&staging)?;
        if let Some(backup_path) = backup.as_ref() {
            verify_critical_rows(backup_path, &staging)?;
        }

        let state = MigrationState {
            source,
            backup,
            staging: staging.clone(),
        };
        write_state(&prepared, &state)?;
        fs::rename(&staging, database)
            .map_err(|error| format!("Could not activate the validated database: {error}"))?;
        write_state(&complete, &state)?;
        Ok(())
    }

    fn grant_local_service_modify(path: &Path) -> Result<(), String> {
        run_path_icacls(
            "grant-runtime-cache-modify",
            path,
            &["/grant:r", "NT AUTHORITY\\LOCAL SERVICE:(OI)(CI)(M)"],
        )?;
        run_path_icacls(
            "enable-runtime-cache-inheritance",
            path,
            &["/inheritance:e", "/T"],
        )
    }

    fn acl_command_failure(
        operation: &str,
        command: &str,
        exit_code: Option<i32>,
        os_code: Option<i32>,
    ) -> String {
        let exit = exit_code
            .map(|code| code.to_string())
            .unwrap_or_else(|| "unknown".into());
        let os = os_code
            .map(|code| format!("; acl_os={code}"))
            .unwrap_or_default();
        let reason = if exit_code == Some(5) || os_code == Some(5) {
            "access-denied"
        } else if exit_code.is_some() {
            "command-failed"
        } else {
            "process-start-failed"
        };
        format!(
            "acl-operation={operation}; acl-command={command}; command_exit={exit}{os}; acl-reason={reason}"
        )
    }

    fn is_access_denied(error: &str) -> bool {
        diagnostic_token(error, "acl-reason=") == Some("access-denied")
            || error_value(error, "acl_os=") == Some("5")
            || error_value(error, "sqlite_system=") == Some("5")
    }

    fn ensure_no_reparse_points(root: &Path) -> Result<(), String> {
        use std::os::windows::fs::MetadataExt;

        fn visit(path: &Path) -> Result<(), String> {
            let metadata = fs::symlink_metadata(path)
                .map_err(|error| acl_io_failure("inspect-program-data-entry", &error))?;
            if metadata.file_attributes() & 0x400 != 0 {
                return Err(acl_command_failure(
                    "reject-program-data-reparse-point",
                    "filesystem",
                    Some(1),
                    None,
                ));
            }
            if metadata.is_dir() {
                for entry in fs::read_dir(path)
                    .map_err(|error| acl_io_failure("list-program-data-entry", &error))?
                {
                    let entry =
                        entry.map_err(|error| acl_io_failure("read-program-data-entry", &error))?;
                    visit(&entry.path())?;
                }
            }
            Ok(())
        }

        visit(root)
    }

    fn output_reports_access_denied(output: &[u8]) -> bool {
        let utf8 = String::from_utf8_lossy(output);
        let utf16 = String::from_utf16_lossy(
            &output
                .chunks_exact(2)
                .map(|bytes| u16::from_le_bytes([bytes[0], bytes[1]]))
                .collect::<Vec<_>>(),
        );
        [utf8.as_ref(), utf16.as_str()].iter().any(|text| {
            text.contains("Access is denied")
                || text.contains("Access denied")
                || text.contains("拒绝访问")
                || text.contains("拒绝存取")
        })
    }

    fn acl_io_failure(operation: &str, error: &io::Error) -> String {
        let code = error.raw_os_error();
        let mut message = acl_command_failure(operation, "filesystem", None, code);
        if code != Some(5) {
            message = message.replace(
                "acl-reason=process-start-failed",
                "acl-reason=filesystem-failed",
            );
        }
        message
    }

    fn run_hidden_checked(operation: &str, program: &str, args: &[OsString]) -> Result<(), String> {
        let output = hidden_command(program)
            .args(args)
            .output()
            .map_err(|error| {
                acl_command_failure(
                    operation,
                    program.trim_end_matches(".exe"),
                    None,
                    error.raw_os_error(),
                )
            })?;
        if output.status.success() {
            return Ok(());
        }
        let denied = output_reports_access_denied(&output.stdout)
            || output_reports_access_denied(&output.stderr);
        Err(acl_command_failure(
            operation,
            program.trim_end_matches(".exe"),
            output.status.code(),
            denied.then_some(5),
        ))
    }

    fn run_path_icacls(operation: &str, path: &Path, options: &[&str]) -> Result<(), String> {
        let mut args = vec![path.as_os_str().to_owned()];
        args.extend(options.iter().map(OsString::from));
        run_hidden_checked(operation, "icacls.exe", &args)
    }

    struct AclSnapshot {
        path: PathBuf,
        complete: bool,
        exit_code: Option<i32>,
    }

    fn save_acl_snapshot(root: &Path) -> Result<AclSnapshot, String> {
        let path = std::env::temp_dir().join(format!(
            "sugrid-inventory-acl-{}-{}.acl",
            now_stamp(),
            std::process::id()
        ));
        let args = vec![
            root.as_os_str().to_owned(),
            OsString::from("/save"),
            path.as_os_str().to_owned(),
            OsString::from("/T"),
            OsString::from("/C"),
        ];
        let output = hidden_command("icacls.exe")
            .args(&args)
            .output()
            .map_err(|error| {
                acl_command_failure("save-acl-snapshot", "icacls", None, error.raw_os_error())
            })?;
        let metadata = fs::metadata(&path).map_err(|error| {
            acl_command_failure(
                "save-acl-snapshot",
                "icacls",
                output.status.code(),
                error.raw_os_error(),
            )
        })?;
        if metadata.len() == 0 {
            return Err(acl_command_failure(
                "save-acl-snapshot",
                "icacls",
                output.status.code(),
                None,
            ));
        }
        Ok(AclSnapshot {
            path,
            complete: output.status.success(),
            exit_code: output.status.code(),
        })
    }

    fn retain_acl_snapshot(snapshot: &AclSnapshot, paths: &Paths) -> Result<(), String> {
        let retained = paths.logs.join(format!(
            "permissions-before-{}-{}.acl",
            now_stamp(),
            std::process::id()
        ));
        fs::copy(&snapshot.path, &retained)
            .map_err(|error| acl_io_failure("retain-acl-snapshot", &error))?;
        run_path_icacls(
            "secure-acl-snapshot",
            &retained,
            &[
                "/inheritance:r",
                "/grant:r",
                "SYSTEM:(F)",
                "BUILTIN\\Administrators:(F)",
            ],
        )?;
        let _ = fs::remove_file(&snapshot.path);
        Ok(())
    }

    fn probe_directory_write(path: &Path, operation: &str) -> Result<(), String> {
        let probe = path.join(format!(".sugrid-permission-check-{}", now_stamp()));
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&probe)
            .map_err(|error| acl_io_failure(operation, &error))?;
        file.write_all(b"permission-check")
            .map_err(|error| acl_io_failure(operation, &error))?;
        drop(file);
        fs::remove_file(&probe).map_err(|error| acl_io_failure(operation, &error))
    }

    fn apply_data_acl_policy(root: &Path) -> Result<(), String> {
        // The updater owns its private jobs and operator settings. Resetting
        // the whole root would erase their protected ACLs during host upgrades.
        run_path_icacls(
            "set-program-data-root-acl",
            root,
            &[
                "/inheritance:r",
                "/grant:r",
                "SYSTEM:(OI)(CI)(F)",
                "BUILTIN\\Administrators:(OI)(CI)(F)",
                "NT AUTHORITY\\LOCAL SERVICE:(OI)(CI)(RX)",
            ],
        )?;
        run_path_icacls(
            "grant-root-directory-listing",
            root,
            &["/grant:r", "BUILTIN\\Users:(RX)"],
        )?;

        for (directory, operation) in [
            ("data", "grant-data-directory-access"),
            ("logs", "grant-log-directory-access"),
        ] {
            let path = root.join(directory);
            fs::create_dir_all(&path).map_err(|error| {
                acl_io_failure(&format!("create-{directory}-directory"), &error)
            })?;
            run_path_icacls(
                &format!("reset-{directory}-descendant-acls"),
                &path,
                &["/reset", "/T"],
            )?;
            run_path_icacls(
                operation,
                &path,
                &[
                    "/inheritance:r",
                    "/grant:r",
                    "SYSTEM:(OI)(CI)(F)",
                    "BUILTIN\\Administrators:(OI)(CI)(F)",
                    "NT AUTHORITY\\LOCAL SERVICE:(OI)(CI)(M)",
                ],
            )?;
        }

        let backups = root.join("backups");
        fs::create_dir_all(&backups)
            .map_err(|error| acl_io_failure("create-backups-directory", &error))?;
        run_path_icacls("reset-backup-descendant-acls", &backups, &["/reset", "/T"])?;
        run_path_icacls(
            "grant-backup-directory-access",
            &backups,
            &[
                "/inheritance:r",
                "/grant:r",
                "SYSTEM:(OI)(CI)(F)",
                "BUILTIN\\Administrators:(OI)(CI)(F)",
                "NT AUTHORITY\\LOCAL SERVICE:(OI)(CI)(RX)",
            ],
        )?;

        for directory in ["data", "backups", "logs"] {
            run_path_icacls(
                &format!("enable-{directory}-descendant-inheritance"),
                &root.join(directory),
                &["/inheritance:e", "/T"],
            )?;
        }

        run_path_icacls(
            "grant-backup-directory-listing",
            &root.join("backups"),
            &["/grant:r", "BUILTIN\\Users:(RX)"],
        )?;
        run_path_icacls(
            "grant-log-directory-listing",
            &root.join("logs"),
            &["/grant:r", "BUILTIN\\Users:(RX)"],
        )?;

        let instance_file = root.join("logs").join("service-instance.txt");
        OpenOptions::new()
            .create(true)
            .write(true)
            .open(&instance_file)
            .map_err(|error| acl_io_failure("prepare-service-identity-file", &error))?;
        run_path_icacls(
            "grant-service-identity-read",
            &instance_file,
            &["/grant:r", "BUILTIN\\Users:(R)"],
        )?;

        apply_runtime_acl_policy(root)?;

        run_path_icacls("verify-inventory-acl-tree", root, &["/verify", "/T"])?;
        for (directory, operation) in [
            ("data", "verify-data-directory-access"),
            ("backups", "verify-backup-directory-access"),
            ("logs", "verify-log-directory-access"),
        ] {
            probe_directory_write(&root.join(directory), operation)?;
        }
        Ok(())
    }

    fn apply_runtime_acl_policy(root: &Path) -> Result<(), String> {
        for directory in ["app", "inventory"] {
            let path = root.join(directory);
            match fs::metadata(&path) {
                Ok(metadata) if metadata.is_dir() => {}
                Ok(_) => continue,
                Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
                Err(error) => {
                    return Err(acl_io_failure(
                        &format!("inspect-{directory}-runtime-directory"),
                        &error,
                    ));
                }
            }
            run_path_icacls(
                &format!("grant-{directory}-runtime-access"),
                &path,
                &[
                    "/inheritance:r",
                    "/grant:r",
                    "SYSTEM:(OI)(CI)(F)",
                    "BUILTIN\\Administrators:(OI)(CI)(F)",
                    "NT AUTHORITY\\LOCAL SERVICE:(OI)(CI)(RX)",
                ],
            )?;
        }
        for directory in ["app", "inventory"] {
            let path = root.join(directory);
            if path.is_dir() {
                run_path_icacls(
                    &format!("enable-{directory}-descendant-inheritance"),
                    &path,
                    &["/inheritance:e", "/T"],
                )?;
            }
        }

        let cache = root.join("inventory").join(".next").join("cache");
        match cache.try_exists() {
            Ok(true) => grant_local_service_modify(&cache)?,
            Ok(false) => {}
            Err(error) => return Err(acl_io_failure("inspect-runtime-cache", &error)),
        }
        Ok(())
    }

    fn apply_and_verify_data_permissions(paths: &Paths) -> Result<(), String> {
        apply_data_acl_policy(&paths.program_data)?;
        if paths.database.is_file() {
            let database = open_backup_source_database(&paths.database).map_err(|error| {
                format!("acl-operation=verify-database-file-access; acl-command=sqlite; {error}")
            })?;
            drop(database);
        }
        Ok(())
    }

    fn set_data_permissions(paths: &Paths) -> Result<(), String> {
        ensure_no_reparse_points(&paths.program_data)?;
        let snapshot = save_acl_snapshot(&paths.program_data)?;
        if !snapshot.complete {
            let retained = retain_acl_snapshot(&snapshot, paths).is_ok();
            let failure =
                acl_command_failure("save-acl-snapshot", "icacls", snapshot.exit_code, None);
            return Err(if retained {
                format!("{failure}; acl-snapshot=retained")
            } else {
                format!("{failure}; acl-snapshot=temporary")
            });
        }

        let permission_result = match apply_and_verify_data_permissions(paths) {
            Ok(()) => Ok(()),
            Err(initial_error) => {
                if !is_access_denied(&initial_error) {
                    let snapshot_result = retain_acl_snapshot(&snapshot, paths);
                    return Err(if snapshot_result.is_ok() {
                        format!("{initial_error}; acl-snapshot=retained")
                    } else {
                        format!("{initial_error}; acl-snapshot=temporary")
                    });
                }
                let previous_operation = diagnostic_token(&initial_error, "acl-operation=")
                    .unwrap_or("unknown-operation");
                let take_ownership = run_hidden_checked(
                    "take-ownership",
                    "takeown.exe",
                    &[
                        OsString::from("/F"),
                        paths.program_data.as_os_str().to_owned(),
                        OsString::from("/A"),
                        OsString::from("/R"),
                        OsString::from("/D"),
                        OsString::from("Y"),
                        OsString::from("/SKIPSL"),
                    ],
                );
                match take_ownership {
                    Err(error) => Err(format!("{error}; previous-operation={previous_operation}")),
                    Ok(()) => apply_and_verify_data_permissions(paths).map_err(|error| {
                        format!(
                            "{error}; previous-operation={previous_operation}; ownership=updated"
                        )
                    }),
                }
            }
        };

        let snapshot_result = retain_acl_snapshot(&snapshot, paths);
        match (permission_result, snapshot_result) {
            (Ok(()), Ok(())) => Ok(()),
            (Ok(()), Err(error)) => Err(error),
            (Err(error), Ok(())) => Err(format!("{error}; acl-snapshot=retained")),
            (Err(error), Err(_)) => Err(format!("{error}; acl-snapshot=temporary")),
        }
    }

    struct RuntimeStage {
        stage: PathBuf,
        old_inventory: Option<PathBuf>,
        old_app: Option<PathBuf>,
        target_inventory: PathBuf,
        target_app: PathBuf,
    }

    fn stage_runtime(paths: &Paths) -> Result<RuntimeStage, String> {
        let suffix = format!("{}-{}", now_stamp(), std::process::id());
        let stage = paths.program_data.join(format!(".install-stage-{suffix}"));
        let staged_inventory = stage.join("inventory");
        let staged_app = stage.join("app");
        let target_inventory = paths.program_data.join("inventory");
        let target_app = paths.program_data.join("app");
        let old_inventory = paths
            .program_data
            .join(format!(".inventory-previous-{suffix}"));
        let old_app = paths.program_data.join(format!(".app-previous-{suffix}"));

        if stage.exists() || old_inventory.exists() || old_app.exists() {
            return Err(
                "A previous interrupted runtime update needs review before installation.".into(),
            );
        }
        fs::create_dir_all(&staged_app).map_err(|error| error.to_string())?;
        fs::copy(
            &paths.source_service_exe,
            staged_app.join("sugrid-inventory-service.exe"),
        )
        .map_err(|error| format!("Could not stage Windows service host: {error}"))?;
        copy_directory(&paths.inventory, &staged_inventory)
            .map_err(|error| format!("Could not stage the bundled inventory server: {error}"))?;
        if !staged_inventory.join("server.js").is_file()
            || !staged_inventory.join("node.exe").is_file()
        {
            let _ = fs::remove_dir_all(&stage);
            return Err("The staged inventory server is missing server.js or node.exe.".into());
        }

        let had_inventory = target_inventory.exists();
        let had_app = target_app.exists();
        if had_inventory {
            fs::rename(&target_inventory, &old_inventory).map_err(|error| {
                format!("Could not preserve the installed server files: {error}")
            })?;
        }
        if had_app {
            if let Err(error) = fs::rename(&target_app, &old_app) {
                if had_inventory {
                    let _ = fs::rename(&old_inventory, &target_inventory);
                }
                return Err(format!(
                    "Could not preserve the installed service host: {error}"
                ));
            }
        }

        let replace_result = (|| {
            fs::rename(&staged_inventory, &target_inventory).map_err(|error| {
                format!("Could not activate the inventory server files: {error}")
            })?;
            fs::rename(&staged_app, &target_app)
                .map_err(|error| format!("Could not activate the Windows service host: {error}"))?;
            Ok::<(), String>(())
        })();
        if let Err(error) = replace_result {
            let _ = fs::remove_dir_all(&target_inventory);
            let _ = fs::remove_dir_all(&target_app);
            if had_inventory {
                let _ = fs::rename(&old_inventory, &target_inventory);
            }
            if had_app {
                let _ = fs::rename(&old_app, &target_app);
            }
            let _ = fs::remove_dir_all(&stage);
            return Err(error);
        }

        Ok(RuntimeStage {
            stage,
            old_inventory: had_inventory.then_some(old_inventory),
            old_app: had_app.then_some(old_app),
            target_inventory,
            target_app,
        })
    }

    fn rollback_runtime(stage: RuntimeStage) -> Result<(), String> {
        if stage.target_inventory.exists() {
            fs::remove_dir_all(&stage.target_inventory)
                .map_err(|error| format!("Could not remove failed inventory runtime: {error}"))?;
        }
        if stage.target_app.exists() {
            fs::remove_dir_all(&stage.target_app)
                .map_err(|error| format!("Could not remove failed service host: {error}"))?;
        }
        if let Some(old) = stage.old_inventory {
            fs::rename(old, stage.target_inventory).map_err(|error| {
                format!("Could not restore the previous inventory runtime: {error}")
            })?;
        }
        if let Some(old) = stage.old_app {
            fs::rename(old, stage.target_app)
                .map_err(|error| format!("Could not restore the previous service host: {error}"))?;
        }
        let _ = fs::remove_dir_all(stage.stage);
        Ok(())
    }

    fn commit_runtime(stage: RuntimeStage) {
        if let Some(old) = stage.old_inventory {
            let _ = fs::remove_dir_all(old);
        }
        if let Some(old) = stage.old_app {
            let _ = fs::remove_dir_all(old);
        }
        let _ = fs::remove_dir_all(stage.stage);
    }

    fn is_service_missing(error: &WindowsServiceError) -> bool {
        matches!(error, WindowsServiceError::Winapi(error) if error.raw_os_error() == Some(1060))
    }

    fn open_optional_service(
        manager: &ServiceManager,
        access: ServiceAccess,
    ) -> Result<Option<windows_service::service::Service>, String> {
        match manager.open_service(SERVICE_NAME, access) {
            Ok(service) => Ok(Some(service)),
            Err(error) if is_service_missing(&error) => Ok(None),
            Err(error) => Err(format!(
                "Could not open Windows service {SERVICE_NAME}: {error}"
            )),
        }
    }

    fn service_installed() -> Result<bool, String> {
        let manager = service_manager(ServiceManagerAccess::CONNECT)?;
        Ok(open_optional_service(&manager, ServiceAccess::QUERY_STATUS)?.is_some())
    }

    fn service_manager(access: ServiceManagerAccess) -> Result<ServiceManager, String> {
        ServiceManager::local_computer(None::<&str>, access)
            .map_err(|error| format!("Could not access Windows Service Control Manager: {error}"))
    }

    fn open_service(access: ServiceAccess) -> Result<windows_service::service::Service, String> {
        service_manager(ServiceManagerAccess::CONNECT)?
            .open_service(SERVICE_NAME, access)
            .map_err(|error| {
                format!(
                    "Windows service {SERVICE_NAME} is not installed or is inaccessible: {error}"
                )
            })
    }

    fn wait_for_state(
        service: &windows_service::service::Service,
        expected: ServiceState,
    ) -> Result<ServiceStatus, String> {
        for _ in 0..100 {
            let status = service.query_status().map_err(|error| error.to_string())?;
            if status.current_state == expected {
                return Ok(status);
            }
            thread::sleep(Duration::from_millis(250));
        }
        Err(format!(
            "Windows service did not reach {expected:?} within 25 seconds."
        ))
    }

    fn service_instance_path(paths: &Paths) -> PathBuf {
        paths.logs.join("service-instance.txt")
    }

    fn new_service_instance(paths: &Paths) -> Result<String, String> {
        let instance = format!("{}-{}", now_stamp(), std::process::id());
        let mut file = OpenOptions::new()
            .write(true)
            .truncate(true)
            .open(service_instance_path(paths))
            .map_err(|error| format!("Could not open prepared service identity file: {error}"))?;
        file.write_all(instance.as_bytes())
            .map_err(|error| format!("Could not record service instance: {error}"))?;
        Ok(instance)
    }

    fn stop_service_if_running() -> Result<bool, String> {
        let manager = service_manager(ServiceManagerAccess::CONNECT)?;
        let Some(service) =
            open_optional_service(&manager, ServiceAccess::QUERY_STATUS | ServiceAccess::STOP)?
        else {
            return Ok(false);
        };
        let status = service.query_status().map_err(|error| error.to_string())?;
        if status.current_state == ServiceState::Stopped {
            return Ok(false);
        }
        service
            .stop()
            .map_err(|error| format!("Could not stop inventory service: {error}"))?;
        wait_for_state(&service, ServiceState::Stopped)?;
        Ok(true)
    }

    fn install_windows_service(paths: &Paths, start_type: ServiceStartType) -> Result<(), String> {
        let manager =
            service_manager(ServiceManagerAccess::CONNECT | ServiceManagerAccess::CREATE_SERVICE)?;
        let info = ServiceInfo {
            name: OsString::from(SERVICE_NAME),
            display_name: OsString::from(SERVICE_DISPLAY_NAME),
            service_type: ServiceType::OWN_PROCESS,
            start_type,
            error_control: ServiceErrorControl::Normal,
            executable_path: paths.service_exe.clone(),
            launch_arguments: vec![OsString::from("run")],
            dependencies: vec![ServiceDependency::Service(OsString::from(UPDATER_SERVICE_NAME))],
            account_name: Some(OsString::from("NT AUTHORITY\\LocalService")),
            account_password: None,
        };
        let access = ServiceAccess::QUERY_STATUS
            | ServiceAccess::QUERY_CONFIG
            | ServiceAccess::CHANGE_CONFIG
            | ServiceAccess::START
            | ServiceAccess::STOP
            | ServiceAccess::DELETE;
        let service = match open_optional_service(&manager, access)? {
            Some(service) => {
                service.change_config(&info).map_err(|error| {
                    format!("Could not update Windows service configuration: {error}")
                })?;
                service
            }
            None => manager
                .create_service(&info, access)
                .map_err(|error| format!("Could not install Windows service: {error}"))?,
        };
        service
            .set_description("Runs the bundled SUGRID inventory web application on this computer.")
            .map_err(|error| format!("Could not describe Windows service: {error}"))?;
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
            .map_err(|error| format!("Could not configure service recovery: {error}"))?;
        let acl = "D:(A;;CCLCSWRPWPDTLOCRRC;;;SY)(A;;CCDCLCSWRPWPDTLOCRSDRCWDWO;;;BA)(A;;CCLCRC;;;AU)";
        let acl_result = hidden_command("sc.exe")
            .args(["sdset", SERVICE_NAME, acl])
            .output()
            .map_err(|error| format!("Could not configure service controls: {error}"))?;
        if !acl_result.status.success() {
            return Err(format!(
                "Could not grant authenticated users read access to this service: {}",
                String::from_utf8_lossy(&acl_result.stderr).trim()
            ));
        }
        Ok(())
    }

    fn start_and_wait_healthy(paths: &Paths) -> Result<(), String> {
        let service = open_service(ServiceAccess::QUERY_STATUS | ServiceAccess::START)?;
        let state = service
            .query_status()
            .map_err(|error| {
                format!(
                    "Could not query inventory service before start: {}",
                    windows_service_error(&error)
                )
            })?
            .current_state;
        match state {
            ServiceState::Stopped => service.start::<OsString>(&[]).map_err(|error| {
                let status = service
                    .query_status()
                    .map(|status| {
                        format!(
                            "state={:?}, exit_code={:?}",
                            status.current_state, status.exit_code
                        )
                    })
                    .unwrap_or_else(|status_error| {
                        format!(
                            "status unavailable: {}",
                            windows_service_error(&status_error)
                        )
                    });
                format!(
                    "Could not start the inventory service: {}; {status}",
                    windows_service_error(&error)
                )
            })?,
            ServiceState::Running | ServiceState::StartPending | ServiceState::ContinuePending => {}
            other => {
                return Err(format!(
                    "The inventory service cannot be started from state {other:?}."
                ));
            }
        }
        for _ in 0..120 {
            if service
                .query_status()
                .is_ok_and(|status| status.current_state == ServiceState::Running)
                && fs::read_to_string(service_instance_path(paths))
                    .ok()
                    .is_some_and(|instance| health_check(PORT, instance.trim()))
            {
                return Ok(());
            }
            thread::sleep(Duration::from_millis(500));
        }
        let status = service
            .query_status()
            .map(|status| {
                format!(
                    "state={:?}, exit_code={:?}",
                    status.current_state, status.exit_code
                )
            })
            .unwrap_or_else(|status_error| {
                format!(
                    "status unavailable: {}",
                    windows_service_error(&status_error)
                )
            });
        let error = format!(
            "The inventory service did not become healthy at http://127.0.0.1:{PORT}/api/health ({status}). Check {}.",
            paths.logs.join("service.log").display()
        );
        Err(error)
    }

    fn health_check(port: u16, instance: &str) -> bool {
        use std::{
            io::{Read, Write},
            net::TcpStream,
        };
        let Ok(mut stream) = TcpStream::connect_timeout(
            &format!("127.0.0.1:{port}").parse().unwrap(),
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
            && response.starts_with("HTTP/1.1 200")
            && response.contains("\"status\":\"ok\"")
            && response.contains(&format!("\"serviceInstance\":\"{instance}\""))
    }

    fn ensure_port_available(port: u16) -> Result<(), String> {
        TcpListener::bind(("0.0.0.0", port))
            .map(drop)
            .map_err(|error| {
                format!(
                    "Port {port} is already in use or unavailable: {}",
                    io_error_summary(&error)
                )
            })
    }

    fn install(legacy_config: &Path) -> Result<(), String> {
        let mut paths = current_paths()?;
        let _ = clear_stale_install_diagnostics(&paths.program_data, &std::env::temp_dir());
        let service_was_installed = service_installed()?;
        let was_running = stop_service_if_running()?;
        let mut runtime_stage = None;
        let mut install_step = "preflight";
        let install_result = (|| {
            install_step = "port-preflight";
            ensure_port_available(PORT)?;
            install_step = "prepare-program-data";
            fs::create_dir_all(&paths.program_data)
                .map_err(|error| acl_io_failure("create-program-data-root", &error))?;
            install_step = "apply-data-permissions";
            set_data_permissions(&paths)?;
            let diagnostic_cleanup_failures =
                clear_stale_install_diagnostics(&paths.program_data, &std::env::temp_dir());
            if !diagnostic_cleanup_failures.is_empty() {
                append_log(
                    &paths,
                    &format!(
                        "Could not remove stale diagnostics after permission repair: {}",
                        diagnostic_cleanup_failures.join("; ")
                    ),
                );
            }
            if paths.database.is_file() {
                install_step = "backup-database";
                let (backup, manifest_warning) =
                    create_backup_file(&paths.database, &paths.backups)?;
                append_log(
                    &paths,
                    &format!("Pre-install SQLite backup created: {}", backup.display()),
                );
                if let Some(warning) = manifest_warning {
                    append_log(
                        &paths,
                        &format!("Backup listing could not be refreshed: {warning}"),
                    );
                }
            }
            install_step = "stage-runtime";
            runtime_stage = Some(stage_runtime(&paths)?);
            paths.inventory = paths.program_data.join("inventory");
            install_step = "apply-runtime-permissions";
            apply_runtime_acl_policy(&paths.program_data)?;
            install_step = "migrate-database";
            migrate_or_initialize(
                &paths.inventory,
                &paths.database,
                &paths.backups,
                &paths.logs,
                legacy_config,
            )?;
            install_step = "install-windows-service";
            install_windows_service(&paths, ServiceStartType::AutoStart)?;
            install_step = "start-and-health-check";
            start_and_wait_healthy(&paths)?;
            Ok::<(), String>(())
        })();
        if let Err(install_error) = install_result {
            let stop_error = stop_service_if_running().err();
            let rollback_error = runtime_stage
                .take()
                .and_then(|stage| rollback_runtime(stage).err());
            let recovery_error = if is_permission_setup_step(install_step) {
                if service_was_installed && was_running {
                    start_and_wait_healthy(&paths).err()
                } else {
                    None
                }
            } else if service_was_installed {
                install_windows_service(&paths, ServiceStartType::AutoStart)
                    .and_then(|_| {
                        if was_running {
                            start_and_wait_healthy(&paths)
                        } else {
                            Ok(())
                        }
                    })
                    .err()
            } else {
                uninstall().err()
            };
            let details = [stop_error, rollback_error, recovery_error]
                .into_iter()
                .flatten()
                .collect::<Vec<_>>();
            let detail = if details.is_empty() {
                "Previous service files were restored.".to_string()
            } else {
                format!("Recovery also reported: {}", details.join("; "))
            };
            // Recovery may reset ACLs; publish the user-readable summary last.
            let diagnostic =
                write_install_diagnostic(&paths.program_data, install_step, &install_error)
                    .map(|path| path.display().to_string())
                    .unwrap_or_else(|| "No diagnostic file could be written.".into());
            append_log(
                &paths,
                &format!(
                    "Installation failed at {install_step}: {install_error}. {detail}. Diagnostic: {diagnostic}"
                ),
            );
            return Err(format!(
                "Installation failed at {install_step}: {install_error}. {detail}. Diagnostic: {diagnostic}"
            ));
        }
        if let Some(stage) = runtime_stage {
            commit_runtime(stage);
        } else {
            return Err("Integrated service installation did not produce a runtime stage.".into());
        }
        append_log(
            &paths,
            "Integrated service installation completed and passed the HTTP/database health check.",
        );
        Ok(())
    }

    fn remove_service_registration_only() -> Result<(), String> {
        let manager = service_manager(ServiceManagerAccess::CONNECT)?;
        if let Some(service) = open_optional_service(
            &manager,
            ServiceAccess::QUERY_STATUS | ServiceAccess::STOP | ServiceAccess::DELETE,
        )? {
            if service
                .query_status()
                .map_err(|error| error.to_string())?
                .current_state
                != ServiceState::Stopped
            {
                service.stop().map_err(|error| error.to_string())?;
                wait_for_state(&service, ServiceState::Stopped)?;
            }
            service.delete().map_err(|error| error.to_string())?;
        }
        Ok(())
    }

    // The manager installer carries only the service host. Inventory runtime and
    // the ProgramData database belong to the separately released product.
    fn install_host_only() -> Result<(), String> {
        let paths = current_paths()?;
        let active_transaction = paths
            .program_data
            .join("updater")
            .join("active-transaction.json");
        if active_transaction
            .try_exists()
            .map_err(|error| format!("Cannot inspect updater transaction: {error}"))?
        {
            return Err("Inventory update or recovery is active; finish it before upgrading the service host.".into());
        }
        fs::create_dir_all(&paths.program_data)
            .map_err(|error| acl_io_failure("create-program-data-root", &error))?;
        set_data_permissions(&paths)?;
        if paths.database.is_file() {
            let (backup, warning) = create_backup_file(&paths.database, &paths.backups)?;
            append_log(
                &paths,
                &format!("Host upgrade backup created: {}", backup.display()),
            );
            if let Some(warning) = warning {
                append_log(
                    &paths,
                    &format!("Backup listing could not be refreshed: {warning}"),
                );
            }
        }

        let suffix = format!("{}-{}", now_stamp(), std::process::id());
        let stage = paths.program_data.join(format!(".app-stage-{suffix}"));
        let previous = paths.program_data.join(format!(".app-previous-{suffix}"));
        let target = paths.program_data.join("app");
        if stage.exists() || previous.exists() {
            return Err("Interrupted host upgrade directories require review.".into());
        }
        fs::create_dir(&stage).map_err(|error| format!("Could not stage service host: {error}"))?;
        if let Err(error) = fs::copy(
            &paths.source_service_exe,
            stage.join("sugrid-inventory-service.exe"),
        ) {
            let _ = fs::remove_dir_all(&stage);
            return Err(format!("Could not copy service host: {error}"));
        }
        fs::write(
            stage.join("host-version.json"),
            serde_json::to_vec(&serde_json::json!({ "version": env!("CARGO_PKG_VERSION") }))
                .map_err(|error| error.to_string())?,
        )
        .map_err(|error| format!("Could not write host version: {error}"))?;

        let service_existed = service_installed()?;
        let was_running = stop_service_if_running()?;
        let had_target = target.exists();
        let mut activated = false;
        let result = (|| {
            if had_target {
                fs::rename(&target, &previous)
                    .map_err(|error| format!("Could not preserve old service host: {error}"))?;
            }
            fs::rename(&stage, &target)
                .map_err(|error| format!("Could not activate new service host: {error}"))?;
            activated = true;
            apply_runtime_acl_policy(&paths.program_data)?;
            install_windows_service(
                &paths,
                if inventory_runtime_available(&paths) && paths.database.is_file() {
                    ServiceStartType::AutoStart
                } else {
                    ServiceStartType::OnDemand
                },
            )?;
            if inventory_runtime_available(&paths) && paths.database.is_file() {
                start_and_wait_healthy(&paths)?;
            }
            Ok::<(), String>(())
        })();
        if let Err(error) = result {
            let _ = stop_service_if_running();
            if activated {
                let _ = fs::remove_dir_all(&target);
            }
            let restore_result = if had_target {
                fs::rename(&previous, &target)
                    .map_err(|restore| format!("Could not restore old service host: {restore}"))
            } else {
                Ok(())
            };
            let _ = fs::remove_dir_all(&stage);
            let service_result = if service_existed && had_target {
                install_windows_service(&paths, ServiceStartType::AutoStart).and_then(|_| {
                    if was_running
                        && inventory_runtime_available(&paths)
                        && paths.database.is_file()
                    {
                        start_and_wait_healthy(&paths)
                    } else {
                        Ok(())
                    }
                })
            } else if !service_existed {
                remove_service_registration_only()
            } else {
                Ok(())
            };
            return Err(format!(
                "Host-only installation failed: {error}; runtime recovery: {}; service recovery: {}",
                restore_result.err().unwrap_or_else(|| "ok".into()),
                service_result.err().unwrap_or_else(|| "ok".into())
            ));
        }
        let _ = fs::remove_dir_all(&previous);
        append_log(
            &paths,
            "Service host installed without replacing inventory runtime or database.",
        );
        Ok(())
    }

    fn uninstall() -> Result<(), String> {
        // Removing the manager must never delete independently released runtime
        // files, the database, or its backups. Keep the installed host binary
        // for a safe subsequent repair or reinstall as well.
        remove_service_registration_only()
    }

    fn restore_backup(backup_path: &Path) -> Result<String, String> {
        let paths = current_paths()?;
        let canonical_backup = backup_path
            .canonicalize()
            .map_err(|error| format!("Backup file is unavailable: {error}"))?;
        let canonical_dir = paths
            .backups
            .canonicalize()
            .map_err(|error| error.to_string())?;
        if !canonical_backup.starts_with(&canonical_dir)
            || canonical_backup
                .extension()
                .is_none_or(|extension| extension != "db")
        {
            return Err(
                "Restore is limited to verified SQLite backups inside the SUGRID backup folder."
                    .into(),
            );
        }
        inspect_database(&canonical_backup)?;
        let was_running = stop_service_if_running()?;
        let safety = paths
            .backups
            .join(format!("inventory.before-restore-{}.db", now_stamp()));
        online_backup(&paths.database, &safety)?;
        if let Err(error) = write_backup_manifest(&paths.backups) {
            append_log(
                &paths,
                &format!("Backup listing could not be refreshed: {error}"),
            );
        }
        let stage = paths
            .database
            .with_file_name(format!("inventory.restore-{}.db", std::process::id()));
        if stage.exists() {
            fs::remove_file(&stage).map_err(|error| error.to_string())?;
        }
        online_backup(&canonical_backup, &stage)?;
        verify_critical_rows(&canonical_backup, &stage)?;

        let wal = PathBuf::from(format!("{}-wal", paths.database.display()));
        let shm = PathBuf::from(format!("{}-shm", paths.database.display()));
        let _ = fs::remove_file(&wal);
        let _ = fs::remove_file(&shm);
        let rollback = paths
            .database
            .with_file_name(format!("inventory.rollback-{}.db", std::process::id()));
        fs::rename(&paths.database, &rollback)
            .map_err(|error| format!("Could not preserve the current database: {error}"))?;
        if let Err(error) = fs::rename(&stage, &paths.database) {
            let _ = fs::rename(&rollback, &paths.database);
            return Err(format!("Could not activate the selected backup: {error}"));
        }
        if let Err(error) = inspect_database(&paths.database)
            .and_then(|_| verify_critical_rows(&canonical_backup, &paths.database))
        {
            let _ = fs::remove_file(&paths.database);
            let _ = fs::rename(&rollback, &paths.database);
            return Err(format!(
                "Restored database validation failed; the previous database was put back: {error}"
            ));
        }
        fs::remove_file(&rollback).map_err(|error| {
            format!("Database restored, but temporary rollback file could not be removed: {error}")
        })?;
        if was_running {
            let service = open_service(ServiceAccess::QUERY_STATUS | ServiceAccess::START)?;
            service.start::<OsString>(&[]).map_err(|error| {
                format!(
                    "Database restored and validated, but the service could not restart: {error}"
                )
            })?;
            start_and_wait_healthy(&paths)?;
        }
        Ok(format!(
            "Database restored successfully. Safety backup: {}",
            safety.display()
        ))
    }

    define_windows_service!(ffi_service_main, service_main);

    fn service_main(_arguments: Vec<OsString>) {
        if let Err(error) = run_service() {
            append_service_host_log(&format!("Service host stopped with error: {error}"));
            if let Ok(paths) = current_paths() {
                append_log(&paths, &format!("Service host stopped with error: {error}"));
            }
        }
    }

    fn set_status(
        handle: &windows_service::service_control_handler::ServiceStatusHandle,
        current_state: ServiceState,
        controls_accepted: ServiceControlAccept,
        exit_code: ServiceExitCode,
        checkpoint: u32,
        wait_hint: Duration,
    ) -> Result<(), String> {
        handle
            .set_service_status(ServiceStatus {
                service_type: ServiceType::OWN_PROCESS,
                current_state,
                controls_accepted,
                exit_code,
                checkpoint,
                wait_hint,
                process_id: None,
            })
            .map_err(|error| error.to_string())
    }

    fn launch_inventory(paths: &Paths) -> Result<std::process::Child, String> {
        let log_path = paths.logs.join("service.log");
        let _ = fs::create_dir_all(&paths.logs);
        let output = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&log_path)
            .map_err(|error| format!("Cannot open service log {}: {error}", log_path.display()))?;
        let error = output.try_clone().map_err(|error| error.to_string())?;
        let mut command = Command::new(paths.inventory.join("node.exe"));
        command
            .arg("server.js")
            .current_dir(&paths.inventory)
            .env("NODE_ENV", "production")
            .env("PORT", PORT.to_string())
            .env("HOSTNAME", "0.0.0.0")
            .env("INVENTORY_DB_PATH", &paths.database)
            .env("SUGRID_APP_VERSION", installed_inventory_version(paths))
            .env(
                "SUGRID_SERVICE_INSTANCE",
                fs::read_to_string(service_instance_path(paths))
                    .map_err(|error| format!("Could not read service instance id: {error}"))?
                    .trim(),
            )
            .stdout(Stdio::from(output))
            .stderr(Stdio::from(error));
        use std::os::windows::process::CommandExt;
        command.creation_flags(windows_sys::Win32::System::Threading::CREATE_NO_WINDOW);
        command
            .spawn()
            .map_err(|error| format!("Could not launch the bundled inventory server: {error}"))
    }

    fn run_service() -> Result<(), String> {
        append_service_host_log("Service host entered startup.");
        let paths = current_paths()?;
        append_service_host_log("Bundled runtime paths verified.");
        let (shutdown_tx, shutdown_rx) = mpsc::channel::<()>();
        let handler = move |event| match event {
            ServiceControl::Interrogate => ServiceControlHandlerResult::NoError,
            ServiceControl::Stop | ServiceControl::Shutdown => {
                let _ = shutdown_tx.send(());
                ServiceControlHandlerResult::NoError
            }
            _ => ServiceControlHandlerResult::NotImplemented,
        };
        let status_handle = service_control_handler::register(SERVICE_NAME, handler)
            .map_err(|error| format!("Could not register service control handler: {error}"))?;
        set_status(
            &status_handle,
            ServiceState::StartPending,
            ServiceControlAccept::empty(),
            ServiceExitCode::Win32(0),
            1,
            Duration::from_secs(30),
        )?;

        if paths
            .program_data
            .join("data")
            .join(".updater-migration-request.json")
            .exists()
        {
            let migration = run_staged_updater_migration(&paths);
            // The result file, not SCM failure actions, controls updater recovery.
            set_status(
                &status_handle,
                ServiceState::Stopped,
                ServiceControlAccept::empty(),
                ServiceExitCode::Win32(0),
                0,
                Duration::default(),
            )?;
            return migration.map(|_| ());
        }

        let startup = (|| {
            ensure_port_available(PORT)?;
            append_service_host_log("Port 3000 is available.");
            let instance = new_service_instance(&paths)?;
            append_service_host_log("Service identity recorded.");
            let mut child = launch_inventory(&paths)?;
            append_service_host_log(&format!(
                "Bundled inventory process launched with PID {}.",
                child.id()
            ));
            for _ in 0..120 {
                if health_check(PORT, &instance) {
                    return Ok(child);
                }
                if let Some(status) = child.try_wait().map_err(|error| {
                    format!("Could not inspect inventory server startup: {error}")
                })? {
                    return Err(format!(
                        "The inventory server exited with {status} before passing health checks. Check {}.",
                        paths.logs.join("service.log").display()
                    ));
                }
                thread::sleep(Duration::from_millis(500));
            }
            let _ = child.kill();
            let _ = child.wait();
            Err(format!(
                "The inventory server did not become healthy. Check {}.",
                paths.logs.join("service.log").display()
            ))
        })();
        let mut child = match startup {
            Ok(child) => child,
            Err(error) => {
                append_service_host_log(&format!("Service startup failed: {error}"));
                let _ = set_status(
                    &status_handle,
                    ServiceState::Stopped,
                    ServiceControlAccept::empty(),
                    ServiceExitCode::ServiceSpecific(1),
                    0,
                    Duration::default(),
                );
                return Err(error);
            }
        };
        if let Err(error) = set_status(
            &status_handle,
            ServiceState::Running,
            ServiceControlAccept::STOP | ServiceControlAccept::SHUTDOWN,
            ServiceExitCode::Win32(0),
            0,
            Duration::default(),
        ) {
            let _ = child.kill();
            let _ = child.wait();
            return Err(format!("Could not report running service status: {error}"));
        }
        append_log(
            &paths,
            &format!("Inventory server started with PID {}.", child.id()),
        );

        loop {
            match shutdown_rx.recv_timeout(Duration::from_millis(500)) {
                Ok(()) | Err(mpsc::RecvTimeoutError::Disconnected) => {
                    set_status(
                        &status_handle,
                        ServiceState::StopPending,
                        ServiceControlAccept::empty(),
                        ServiceExitCode::Win32(0),
                        1,
                        Duration::from_secs(10),
                    )?;
                    let _ = child.kill();
                    let _ = child.wait();
                    set_status(
                        &status_handle,
                        ServiceState::Stopped,
                        ServiceControlAccept::empty(),
                        ServiceExitCode::Win32(0),
                        0,
                        Duration::default(),
                    )?;
                    append_log(
                        &paths,
                        "Inventory server stopped by Windows Service Control Manager.",
                    );
                    return Ok(());
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {}
            }
            if let Some(status) = child.try_wait().map_err(|error| error.to_string())? {
                append_log(
                    &paths,
                    &format!("Inventory server exited with {status}; retrying in 5 seconds."),
                );
                match shutdown_rx.recv_timeout(Duration::from_secs(5)) {
                    Ok(()) | Err(mpsc::RecvTimeoutError::Disconnected) => {
                        set_status(
                            &status_handle,
                            ServiceState::StopPending,
                            ServiceControlAccept::empty(),
                            ServiceExitCode::Win32(0),
                            1,
                            Duration::from_secs(10),
                        )?;
                        set_status(
                            &status_handle,
                            ServiceState::Stopped,
                            ServiceControlAccept::empty(),
                            ServiceExitCode::Win32(0),
                            0,
                            Duration::default(),
                        )?;
                        return Ok(());
                    }
                    Err(mpsc::RecvTimeoutError::Timeout) => {
                        ensure_port_available(PORT)?;
                        let instance = new_service_instance(&paths)?;
                        child = launch_inventory(&paths)?;
                        for _ in 0..120 {
                            if health_check(PORT, &instance) {
                                break;
                            }
                            if child
                                .try_wait()
                                .map_err(|error| error.to_string())?
                                .is_some()
                            {
                                return Err("The restarted inventory server exited before becoming healthy.".into());
                            }
                            thread::sleep(Duration::from_millis(500));
                        }
                        if !health_check(PORT, &instance) {
                            let _ = child.kill();
                            let _ = child.wait();
                            return Err(
                                "The restarted inventory server did not become healthy.".into()
                            );
                        }
                    }
                }
            }
        }
    }

    fn dispatch(command: &str, legacy_config: Option<&Path>) -> Result<String, String> {
        match command {
            "enable-autostart" => {
                let paths = current_paths()?;
                if !inventory_runtime_available(&paths) || !paths.database.is_file() {
                    return Err(
                        "Cannot enable automatic startup before inventory is installed.".into(),
                    );
                }
                install_windows_service(&paths, ServiceStartType::AutoStart)?;
                Ok("Inventory Windows service is configured for automatic startup.".into())
            }
            "disable-autostart" => {
                let paths = current_paths()?;
                install_windows_service(&paths, ServiceStartType::OnDemand)?;
                Ok("Inventory Windows service is configured for manual startup.".into())
            }
            "install-host" => {
                install_host_only()?;
                Ok("Windows service host installed; inventory runtime was preserved.".into())
            }
            "prepare-data-permissions" => {
                let paths = current_paths()?;
                set_data_permissions(&paths)?;
                Ok("ProgramData permissions were repaired and verified.".into())
            }
            "install" => {
                let config =
                    legacy_config.ok_or("Installer must pass the previous manager config path.")?;
                install(config)?;
                Ok("Windows service installed, database verified, and health check passed.".into())
            }
            "uninstall" => {
                uninstall()?;
                Ok("Windows service removed. ProgramData data and backups were retained.".into())
            }
            "stop" => {
                let was_running = stop_service_if_running()?;
                Ok(if was_running {
                    "Windows service stopped."
                } else {
                    "Windows service was already stopped."
                }
                .into())
            }
            "start" => {
                let service = open_service(ServiceAccess::QUERY_STATUS | ServiceAccess::START)?;
                let state = service
                    .query_status()
                    .map_err(|error| error.to_string())?
                    .current_state;
                match state {
                    ServiceState::Stopped => service
                        .start::<OsString>(&[])
                        .map_err(|error| format!("Could not start inventory service: {error}"))?,
                    ServiceState::Running
                    | ServiceState::StartPending
                    | ServiceState::ContinuePending => {}
                    other => {
                        return Err(format!(
                            "The inventory service cannot be started from state {other:?}."
                        ));
                    }
                }
                let mut paths = current_paths()?;
                paths.inventory = paths.program_data.join("inventory");
                start_and_wait_healthy(&paths)?;
                Ok("Windows inventory service is running and healthy.".into())
            }
            "restore" => {
                let backup = legacy_config.ok_or("Restore requires the selected backup path.")?;
                restore_backup(backup)
            }
            "backup" => {
                let paths = current_paths()?;
                let (backup, manifest_warning) =
                    create_backup_file(&paths.database, &paths.backups)?;
                if let Some(warning) = manifest_warning {
                    append_log(
                        &paths,
                        &format!("Backup listing could not be refreshed: {warning}"),
                    );
                    Ok(format!(
                        "Database backup created and verified at {}. The backup listing could not be refreshed; see service-manager.log.",
                        backup.display()
                    ))
                } else {
                    Ok(format!("Database backup created: {}", backup.display()))
                }
            }
            "run" => {
                windows_service::service_dispatcher::start(SERVICE_NAME, ffi_service_main)
                    .map_err(|error| format!("Service dispatcher failed: {error}"))?;
                Ok("Service dispatcher exited.".into())
            }
            _ => Err("Unsupported service command.".into()),
        }
    }

    pub fn main() {
        let mut arguments = std::env::args_os().skip(1);
        let command = arguments.next().unwrap_or_else(|| OsString::from("run"));
        let command = command.to_string_lossy().to_string();
        let argument = arguments.next();
        let path = argument.as_deref().map(Path::new);
        match dispatch(&command, path) {
            Ok(message) => {
                let _ = fs::remove_file(
                    std::env::temp_dir().join("sugrid-service-host-diagnostic.txt"),
                );
                if let Ok(paths) = current_paths() {
                    append_log(&paths, &message);
                }
                std::process::exit(0);
            }
            Err(error) => {
                let diagnostic = write_command_diagnostic(&command, &error);
                if let Ok(paths) = current_paths() {
                    append_log(
                        &paths,
                        &format!(
                            "{error}. Diagnostic: {}",
                            diagnostic
                                .as_ref()
                                .map(|path| path.display().to_string())
                                .unwrap_or_else(|| "unavailable".into())
                        ),
                    );
                }
                std::process::exit(1);
            }
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use std::sync::atomic::{AtomicU64, Ordering};

        static NEXT: AtomicU64 = AtomicU64::new(1);

        fn temp_dir(label: &str) -> PathBuf {
            let path = std::env::temp_dir().join(format!(
                "sugrid-service-{label}-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir_all(&path).unwrap();
            path
        }

        #[test]
        fn staged_updater_migration_rejects_path_substitution() {
            let base = temp_dir("staged-updater-paths");
            let paths = paths_for(&base.join("inventory"), &base, &base.join("host.exe"));
            let runtime = base.join("updater/jobs/123-456/extracted/inventory");
            fs::create_dir_all(runtime.join("scripts")).unwrap();
            fs::write(runtime.join("node.exe"), "qa").unwrap();
            fs::write(runtime.join("scripts/init-db.js"), "qa").unwrap();
            let mut request = UpdaterMigrationRequest {
                format_version: 1,
                operation_id: "123-456".into(),
                runtime_relative: "updater/jobs/123-456/extracted/inventory".into(),
                database_relative: "data/inventory.migrating-123-456.db".into(),
            };
            let (selected, _) = staged_migration_paths(&paths, &request).unwrap();
            assert_eq!(selected, runtime);
            request.database_relative = "../inventory.db".into();
            assert!(staged_migration_paths(&paths, &request).is_err());
            request.database_relative = "data/inventory.migrating-123-456.db".into();
            request.operation_id = "../../outside".into();
            assert!(staged_migration_paths(&paths, &request).is_err());
            fs::remove_dir_all(base).unwrap();
        }

        #[test]
        fn legacy_extended_path_prefixes_are_normalized() {
            assert_eq!(
                normalize_legacy_path(r"\\?\C:\data\inventory.db"),
                PathBuf::from(r"C:\data\inventory.db")
            );
            assert_eq!(
                normalize_legacy_path(r"\\?\UNC\server\share\inventory.db"),
                PathBuf::from(r"\\server\share\inventory.db")
            );
            assert_eq!(
                normalize_legacy_path(r"C:\data\inventory.db"),
                PathBuf::from(r"C:\data\inventory.db")
            );
        }

        fn migrate_for_test(
            source: Option<&Path>,
            target: &Path,
            backup_dir: &Path,
        ) -> Result<(), String> {
            let inventory = target.parent().unwrap().join("app");
            let logs = target.parent().unwrap().join("logs");
            fs::create_dir_all(&inventory).unwrap();
            fs::create_dir_all(&logs).unwrap();
            let config = target.parent().unwrap().join("legacy.json");
            if let Some(source) = source {
                fs::write(
                    &config,
                    serde_json::to_vec(&LegacyConfig {
                        project_root: source.parent().unwrap().to_string_lossy().into_owned(),
                        database_path: source.file_name().unwrap().to_string_lossy().into_owned(),
                    })
                    .unwrap(),
                )
                .unwrap();
            } else {
                fs::write(
                    &config,
                    br#"{"projectRoot":"","databasePath":"data/inventory.db"}"#,
                )
                .unwrap();
            }
            migrate_database_paths(&inventory, target, backup_dir, &logs, &config, |database| {
                let db = Connection::open(database).map_err(|error| error.to_string())?;
                db.execute_batch("CREATE TABLE IF NOT EXISTS users(id TEXT); CREATE TABLE IF NOT EXISTS inventory(id TEXT); CREATE TABLE IF NOT EXISTS purchase_orders(id TEXT); CREATE TABLE IF NOT EXISTS purchase_items(id TEXT);")
                    .map_err(|error| error.to_string())?;
                Ok(())
            })
        }

        fn persist_wal_after_close(database: &Connection) {
            let mut persist = 1i32;
            let result = unsafe {
                ffi::sqlite3_file_control(
                    database.handle(),
                    c"main".as_ptr(),
                    ffi::SQLITE_FCNTL_PERSIST_WAL,
                    (&mut persist as *mut i32).cast(),
                )
            };
            assert_eq!(result, ffi::SQLITE_OK);
        }

        fn runtime_paths_for_test(root: &Path) -> Paths {
            let source = root.join("installer-resource").join("inventory");
            fs::create_dir_all(&source).unwrap();
            fs::write(source.join("server.js"), "new-server").unwrap();
            fs::write(source.join("node.exe"), "node-runtime").unwrap();
            let source_service_exe = root.join("installer-resource").join("service.exe");
            fs::write(&source_service_exe, "new-service").unwrap();
            let program_data = root.join("ProgramData").join("SUGRID").join("Inventory");
            let inventory = program_data.join("inventory");
            let app = program_data.join("app");
            fs::create_dir_all(&inventory).unwrap();
            fs::create_dir_all(&app).unwrap();
            fs::write(inventory.join("server.js"), "old-server").unwrap();
            fs::write(inventory.join("node.exe"), "old-node").unwrap();
            fs::write(app.join("sugrid-inventory-service.exe"), "old-service").unwrap();
            Paths {
                inventory: source,
                service_exe: app.join("sugrid-inventory-service.exe"),
                source_service_exe,
                program_data: program_data.clone(),
                database: program_data.join("data").join("inventory.db"),
                backups: program_data.join("backups"),
                logs: program_data.join("logs"),
            }
        }

        fn service_paths_for_data_root(root: &Path) -> Paths {
            Paths {
                inventory: root.join("inventory"),
                service_exe: root.join("app").join("sugrid-inventory-service.exe"),
                source_service_exe: root.join("service-host.exe"),
                program_data: root.to_path_buf(),
                database: root.join("data").join("inventory.db"),
                backups: root.join("backups"),
                logs: root.join("logs"),
            }
        }

        #[test]
        fn install_error_code_extracts_win32_and_os_codes_without_local_details() {
            assert_eq!(
                install_error_code("Could not start: IO error in winapi call (Win32 error 5)"),
                "win32=5"
            );
            assert_eq!(
                install_error_code("Port 3000 unavailable: Permission denied (os error 10013)"),
                "os=10013"
            );
            assert_eq!(
                install_error_code("health check failed"),
                "code=unavailable"
            );
            assert_eq!(
                install_error_code(
                    "Cannot open source database: sqlite_primary=14 sqlite_extended=14 sqlite_system=5"
                ),
                "sqlite_primary=14,sqlite_extended=14,sqlite_system=5"
            );
            assert_eq!(
                install_error_code(
                    "acl-operation=reset-existing-acls; acl-command=icacls; command_exit=1; acl-reason=command-failed"
                ),
                "command_exit=1"
            );
            assert_eq!(
                diagnostic_token(
                    "acl-operation=reset-existing-acls; command_exit=1",
                    "acl-operation="
                ),
                Some("reset-existing-acls")
            );
        }

        #[test]
        fn source_open_failure_reports_sqlite_codes_without_local_paths() {
            let root = temp_dir("sqlite-open-diagnostic");
            let missing = root.join("missing.db");
            let error = open_source_database(&missing).unwrap_err();
            assert!(error.contains("sqlite_primary=14"));
            assert!(error.contains("sqlite_extended=14"));
            assert!(!error.contains(&root.to_string_lossy().to_string()));
            let _ = fs::remove_dir_all(root);
        }

        #[test]
        fn online_backup_recovers_wal_source_without_shared_memory_sidecar() {
            let root = temp_dir("wal-readonly-fallback");
            let source = root.join("source.db");
            let writer = Connection::open(&source).unwrap();
            writer.pragma_update(None, "journal_mode", "WAL").unwrap();
            writer
                .execute_batch(
                    "CREATE TABLE inventory(id TEXT); INSERT INTO inventory VALUES ('wal-row');",
                )
                .unwrap();
            persist_wal_after_close(&writer);
            drop(writer);

            let shared_memory = migration_sidecar_path(&source, "-shm");
            assert!(migration_sidecar_path(&source, "-wal").is_file());
            fs::remove_file(&shared_memory).unwrap();

            let destination = root.join("backup.db");
            online_backup(&source, &destination).unwrap();
            let backup =
                Connection::open_with_flags(&destination, OpenFlags::SQLITE_OPEN_READ_ONLY)
                    .unwrap();
            let row: String = backup
                .query_row("SELECT id FROM inventory", [], |row| row.get(0))
                .unwrap();
            assert_eq!(row, "wal-row");
            drop(backup);
            let _ = fs::remove_dir_all(root);
        }

        #[test]
        fn backup_source_uses_readwrite_fallback_after_sqlite_access_denied() {
            let root = temp_dir("backup-open-fallback");
            let source = root.join("source.db");
            let database = Connection::open(&source).unwrap();
            database
                .execute_batch("CREATE TABLE inventory(id TEXT)")
                .unwrap();
            drop(database);

            let read_write_called = std::cell::Cell::new(false);
            let opened = open_backup_source_database_with(
                &source,
                |_| {
                    Err("Cannot open source database: sqlite_primary=14 sqlite_extended=14 sqlite_system=5".into())
                },
                |path| {
                    read_write_called.set(true);
                    Connection::open_with_flags(
                        path,
                        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_FULL_MUTEX,
                    )
                    .map_err(|error| error.to_string())
                },
            )
            .unwrap();

            assert!(read_write_called.get());
            drop(opened);
            let _ = fs::remove_dir_all(root);
        }

        #[test]
        fn install_error_kind_identifies_database_backup_failure_stage() {
            assert_eq!(
                install_error_kind(
                    "backup-database",
                    "Cannot open source database: unable to open database file"
                ),
                "source-database-open-failed"
            );
            assert_eq!(
                install_error_kind(
                    "backup-database",
                    "Cannot create database copy: Access is denied (os error 5)"
                ),
                "backup-file-create-failed"
            );
            assert_eq!(
                install_error_kind(
                    "backup-database",
                    "SQLite online backup failed: database is locked"
                ),
                "sqlite-backup-failed"
            );
        }

        #[test]
        fn install_diagnostic_is_a_small_user_readable_summary() {
            let root = temp_dir("diagnostic");
            write_install_diagnostic(
                &root,
                "start-and-health-check",
                "IO error in winapi call (Win32 error 5)",
            );
            let diagnostic = fs::read_to_string(install_diagnostic_path(&root)).unwrap();
            assert!(diagnostic.contains("step=start-and-health-check"));
            assert!(diagnostic.contains("reason=service-start-or-health-check-failed"));
            assert!(diagnostic.contains("win32=5"));
            assert!(!diagnostic.contains("C:\\Users"));
            assert!(!diagnostic.contains("database"));
            let _ = fs::remove_dir_all(root);
        }

        #[test]
        fn acl_failure_diagnostic_names_the_failed_command_without_paths() {
            let root = temp_dir("acl-failure-diagnostic");
            let error = acl_command_failure("reset-existing-acls", "icacls", Some(1), Some(5));
            write_install_diagnostic(&root, "apply-data-permissions", &error);
            let diagnostic = fs::read_to_string(install_diagnostic_path(&root)).unwrap();
            assert!(diagnostic.contains("operation=reset-existing-acls"));
            assert!(diagnostic.contains("command=icacls"));
            assert!(diagnostic.contains("failure=access-denied"));
            assert!(diagnostic.contains("command_exit=1,os=5"));
            assert!(!diagnostic.contains(&root.to_string_lossy().to_string()));
            let _ = fs::remove_dir_all(root);
        }

        #[test]
        fn install_diagnostic_falls_back_when_program_data_cannot_be_written() {
            let root = temp_dir("diagnostic-fallback");
            let blocked_root = root.join("not-a-directory");
            fs::write(&blocked_root, "file").unwrap();
            let fallback = root.join("fallback");
            fs::create_dir_all(&fallback).unwrap();

            let path = write_install_diagnostic_to(
                &blocked_root,
                &fallback,
                "apply-data-permissions",
                &acl_command_failure("grant-log-directory-access", "icacls", Some(1), Some(5)),
            )
            .unwrap();

            assert_eq!(path, fallback.join("sugrid-install-diagnostics.txt"));
            let diagnostic = fs::read_to_string(path).unwrap();
            assert!(diagnostic.contains("operation=grant-log-directory-access"));
            assert!(diagnostic.contains("command=icacls"));
            assert!(diagnostic.contains("command_exit=1,os=5"));
            let _ = fs::remove_dir_all(root);
        }

        #[test]
        fn command_diagnostic_does_not_include_paths_or_database_details() {
            let diagnostic = command_diagnostic_contents(
                "backup",
                "Cannot open source database: sqlite_primary=14 sqlite_extended=14 sqlite_system=5 at C:\\Users\\example\\inventory.db",
            );
            assert!(diagnostic.contains("command=backup"));
            assert!(diagnostic.contains("sqlite_system=5"));
            assert!(!diagnostic.contains("C:\\Users"));
            assert!(!diagnostic.contains("inventory.db"));
            assert!(
                command_diagnostic_contents("prepare-data-permissions", "ok")
                    .contains("command=prepare-data-permissions")
            );
            let permission_error = command_diagnostic_contents(
                "prepare-data-permissions",
                &acl_command_failure("reset-existing-acls", "icacls", Some(1), Some(5)),
            );
            assert!(permission_error.contains("reason=data-permissions-failed"));
            assert!(permission_error.contains("command_exit=1,os=5"));
        }

        #[test]
        fn ownership_is_taken_only_after_access_denied() {
            assert!(is_access_denied(
                "acl-operation=reset-existing-acls; acl-reason=access-denied; command_exit=1; acl_os=5"
            ));
            assert!(is_access_denied("acl-operation=probe; acl_os=5"));
            assert!(!is_access_denied(
                "acl-operation=reset-existing-acls; acl-reason=command-failed; command_exit=1"
            ));
            assert!(is_access_denied(
                "acl-operation=verify-database-file-access; sqlite_primary=14; sqlite_system=5"
            ));
            assert!(is_permission_setup_step("apply-data-permissions"));
            assert!(is_permission_setup_step("apply-runtime-permissions"));
            assert!(!is_permission_setup_step("backup-database"));
        }

        #[test]
        fn data_permissions_refuse_reparse_points_before_recursive_acl_commands() {
            use std::os::windows::fs::symlink_dir;

            let root = temp_dir("acl-reparse-point");
            let external = temp_dir("acl-reparse-target");
            symlink_dir(&external, root.join("junction")).unwrap();

            let error = ensure_no_reparse_points(&root).unwrap_err();

            assert!(error.contains("reject-program-data-reparse-point"));
            assert!(!error.contains(&external.to_string_lossy().to_string()));
            let _ = fs::remove_dir(root.join("junction"));
            let _ = fs::remove_dir_all(root);
            let _ = fs::remove_dir_all(external);
        }

        #[test]
        fn stale_install_diagnostics_are_removed_before_a_retry() {
            let root = temp_dir("stale-diagnostic");
            let temporary_directory = root.join("temp");
            fs::create_dir_all(&temporary_directory).unwrap();
            for path in [
                install_diagnostic_path(&root),
                temporary_directory.join("sugrid-install-diagnostics.txt"),
                temporary_directory.join("sugrid-service-host-diagnostic.txt"),
            ] {
                fs::write(path, "previous failure").unwrap();
            }

            assert!(clear_stale_install_diagnostics(&root, &temporary_directory).is_empty());

            assert!(!install_diagnostic_path(&root).exists());
            assert!(
                !temporary_directory
                    .join("sugrid-install-diagnostics.txt")
                    .exists()
            );
            assert!(
                !temporary_directory
                    .join("sugrid-service-host-diagnostic.txt")
                    .exists()
            );
            let _ = fs::remove_dir_all(root);
        }

        #[test]
        fn stale_diagnostic_cleanup_failure_does_not_block_other_cleanup() {
            let root = temp_dir("stale-diagnostic-cleanup-failure");
            let temporary_directory = root.join("temp");
            fs::create_dir_all(&temporary_directory).unwrap();
            fs::create_dir_all(install_diagnostic_path(&root)).unwrap();
            let stale_temp = temporary_directory.join("sugrid-install-diagnostics.txt");
            let stale_service = temporary_directory.join("sugrid-service-host-diagnostic.txt");
            fs::write(&stale_temp, "previous installer failure").unwrap();
            fs::write(&stale_service, "previous service failure").unwrap();

            let failures = clear_stale_install_diagnostics(&root, &temporary_directory);

            assert_eq!(failures.len(), 1);
            assert!(failures[0].contains("program-data"));
            assert!(install_diagnostic_path(&root).is_dir());
            assert!(!stale_temp.exists());
            assert!(!stale_service.exists());
            let _ = fs::remove_dir_all(root);
        }

        #[test]
        fn data_permissions_repair_a_restricted_acl_and_keep_a_snapshot() {
            let root = temp_dir("acl-repair");
            let paths = service_paths_for_data_root(&root);
            for directory in ["data", "backups", "logs", "app", "inventory"] {
                fs::create_dir_all(root.join(directory)).unwrap();
                fs::write(root.join(directory).join("existing.txt"), "existing").unwrap();
            }
            fs::create_dir_all(root.join("inventory/.next/cache")).unwrap();

            run_path_icacls(
                "test-restrict-acl",
                &paths.database.parent().unwrap().to_path_buf(),
                &[
                    "/inheritance:r",
                    "/grant:r",
                    "*S-1-5-32-545:(RX)",
                    "SYSTEM:(OI)(CI)(F)",
                ],
            )
            .unwrap();

            set_data_permissions(&paths).unwrap();

            assert!(paths.logs.join("service-instance.txt").is_file());
            assert!(
                paths
                    .logs
                    .read_dir()
                    .unwrap()
                    .filter_map(Result::ok)
                    .any(|entry| entry
                        .file_name()
                        .to_string_lossy()
                        .starts_with("permissions-before-"))
            );
            for directory in ["data", "backups", "logs"] {
                assert!(root.join(directory).read_dir().unwrap().all(|entry| {
                    !entry
                        .unwrap()
                        .file_name()
                        .to_string_lossy()
                        .starts_with(".sugrid-permission-check-")
                }));
            }
            let _ = fs::remove_dir_all(root);
        }

        #[test]
        fn data_permissions_remove_explicit_denials_only_in_managed_data_trees() {
            let root = temp_dir("acl-explicit-deny");
            let paths = service_paths_for_data_root(&root);
            let managed = [
                root.join("data/nested/machine.bin"),
                root.join("backups/backup.bin"),
                root.join("logs/trace.bin"),
            ];
            let private = root.join("updater/operators.json");
            for path in managed.iter().chain(std::iter::once(&private)) {
                fs::create_dir_all(path.parent().unwrap()).unwrap();
                fs::write(path, b"preserve").unwrap();
                run_path_icacls("test-deny-local-service", path, &["/deny", "*S-1-5-19:(R)"])
                    .unwrap();
            }

            set_data_permissions(&paths).unwrap();

            for path in &managed {
                assert_eq!(fs::read(path).unwrap(), b"preserve");
                let output = hidden_command("icacls.exe").arg(path).output().unwrap();
                assert!(output.status.success());
                let acl = String::from_utf8_lossy(&output.stdout);
                assert!(!acl.contains("(DENY)"), "explicit denial remains: {acl}");
                assert!(acl.contains("LOCAL SERVICE"), "service ACE is missing: {acl}");
            }
            let output = hidden_command("icacls.exe").arg(&private).output().unwrap();
            assert!(output.status.success());
            assert!(String::from_utf8_lossy(&output.stdout).contains("(DENY)"));
            assert_eq!(fs::read(&private).unwrap(), b"preserve");
            let _ = fs::remove_dir_all(root);
        }

        #[test]
        fn data_permissions_repair_a_database_file_with_an_empty_protected_acl() {
            let root = temp_dir("acl-empty-file");
            let paths = service_paths_for_data_root(&root);
            for directory in ["data", "backups", "logs", "app", "inventory"] {
                fs::create_dir_all(root.join(directory)).unwrap();
            }
            let database_path = paths.database.clone();
            let database = Connection::open(&database_path).unwrap();
            database
                .execute_batch(
                    "CREATE TABLE inventory(id TEXT); INSERT INTO inventory VALUES ('kept-row');",
                )
                .unwrap();
            drop(database);
            run_path_icacls("test-empty-file-acl", &database_path, &["/inheritance:r"]).unwrap();

            assert!(open_source_database(&database_path).is_err());

            set_data_permissions(&paths).unwrap();

            let database = open_source_database(&database_path).unwrap();
            let row: String = database
                .query_row("SELECT id FROM inventory", [], |row| row.get(0))
                .unwrap();
            assert_eq!(row, "kept-row");
            drop(database);
            let _ = fs::remove_dir_all(root);
        }

        #[test]
        fn runtime_acl_is_applied_when_cache_is_created_after_base_permissions() {
            let root = temp_dir("runtime-acl-after-copy");
            let paths = service_paths_for_data_root(&root);
            fs::create_dir_all(paths.database.parent().unwrap()).unwrap();
            fs::create_dir_all(&paths.backups).unwrap();
            fs::create_dir_all(&paths.logs).unwrap();
            apply_data_acl_policy(&root).unwrap();

            let cache = root.join("inventory/.next/cache");
            fs::create_dir_all(&cache).unwrap();
            fs::write(cache.join("existing.bin"), b"cache-entry").unwrap();

            apply_runtime_acl_policy(&root).unwrap();

            probe_directory_write(&cache, "verify-runtime-cache-write").unwrap();
            let output = hidden_command("icacls.exe").arg(&cache).output().unwrap();
            assert!(output.status.success());
            let acl = String::from_utf8_lossy(&output.stdout);
            assert!(acl.contains("LOCAL SERVICE"));
            assert!(acl.contains("(OI)(CI)(M)"));
            let _ = fs::remove_dir_all(root);
        }

        #[test]
        fn data_permissions_take_ownership_only_after_a_real_acl_denial() {
            let root = temp_dir("acl-take-ownership");
            let paths = service_paths_for_data_root(&root);
            for directory in ["data", "backups", "logs"] {
                fs::create_dir_all(root.join(directory)).unwrap();
            }
            let restricted = paths.database.parent().unwrap().join("restricted.bin");
            fs::write(&restricted, b"preserve").unwrap();
            run_path_icacls(
                "test-set-non-admin-owner",
                &restricted,
                &["/setowner", "*S-1-5-20"],
            )
            .unwrap();
            run_path_icacls(
                "test-restrict-owner-acl",
                &restricted,
                &["/inheritance:r", "/grant:r", "*S-1-1-0:(RC)"],
            )
            .unwrap();
            let reset = hidden_command("icacls.exe")
                .args([restricted.as_os_str(), OsStr::new("/reset")])
                .output()
                .unwrap();
            assert!(!reset.status.success(), "test ACL must deny WRITE_DAC");

            set_data_permissions(&paths).unwrap();

            assert_eq!(fs::read(&restricted).unwrap(), b"preserve");
            probe_directory_write(
                &paths.database.parent().unwrap(),
                "verify-takeover-data-write",
            )
            .unwrap();
            let _ = fs::remove_dir_all(root);
        }

        #[test]
        fn failed_install_can_restore_the_previous_runtime() {
            let root = temp_dir("runtime-rollback");
            let paths = runtime_paths_for_test(&root);
            let stage = stage_runtime(&paths).unwrap();
            assert_eq!(
                fs::read_to_string(paths.program_data.join("inventory/server.js")).unwrap(),
                "new-server"
            );
            rollback_runtime(stage).unwrap();
            assert_eq!(
                fs::read_to_string(paths.program_data.join("inventory/server.js")).unwrap(),
                "old-server"
            );
            assert_eq!(
                fs::read_to_string(&paths.service_exe).unwrap(),
                "old-service"
            );
            assert!(
                root.join("ProgramData/SUGRID/Inventory")
                    .read_dir()
                    .unwrap()
                    .all(|entry| !entry
                        .unwrap()
                        .file_name()
                        .to_string_lossy()
                        .contains("previous-"))
            );
            let _ = fs::remove_dir_all(root);
        }

        #[test]
        fn successful_runtime_update_commits_and_removes_previous_files() {
            let root = temp_dir("runtime-commit");
            let paths = runtime_paths_for_test(&root);
            let stage = stage_runtime(&paths).unwrap();
            commit_runtime(stage);
            assert_eq!(
                fs::read_to_string(paths.inventory.join("server.js")).unwrap(),
                "new-server"
            );
            assert_eq!(
                fs::read_to_string(&paths.service_exe).unwrap(),
                "new-service"
            );
            assert!(
                root.join("ProgramData/SUGRID/Inventory")
                    .read_dir()
                    .unwrap()
                    .all(|entry| !entry
                        .unwrap()
                        .file_name()
                        .to_string_lossy()
                        .contains("previous-"))
            );
            let _ = fs::remove_dir_all(root);
        }

        #[test]
        fn migration_uses_sqlite_backup_for_uncheckpointed_wal_and_keeps_source() {
            let root = temp_dir("wal-migration");
            let source = root.join("legacy.db");
            let source_writer = Connection::open(&source).unwrap();
            source_writer
                .pragma_update(None, "journal_mode", "WAL")
                .unwrap();
            source_writer.execute_batch("CREATE TABLE users(id TEXT); CREATE TABLE inventory(id TEXT); CREATE TABLE purchase_orders(id TEXT); CREATE TABLE purchase_items(id TEXT);").unwrap();
            let reader = Connection::open(&source).unwrap();
            reader
                .execute_batch("BEGIN; SELECT * FROM inventory;")
                .unwrap();
            source_writer
                .execute("INSERT INTO users VALUES ('admin')", [])
                .unwrap();
            source_writer
                .execute("INSERT INTO inventory VALUES ('machine')", [])
                .unwrap();
            let target = root.join("ProgramData/data/inventory.db");
            let backups = root.join("ProgramData/backups");
            migrate_for_test(Some(&source), &target, &backups).unwrap();
            let migrated = Connection::open(&target).unwrap();
            let inventory_count: i64 = migrated
                .query_row("SELECT COUNT(*) FROM inventory", [], |row| row.get(0))
                .unwrap();
            assert_eq!(inventory_count, 1);
            assert!(source.exists());
            let backup_count = fs::read_dir(&backups)
                .unwrap()
                .filter_map(Result::ok)
                .filter(|entry| {
                    entry
                        .path()
                        .extension()
                        .is_some_and(|extension| extension == "db")
                })
                .count();
            assert_eq!(backup_count, 1);
            drop(reader);
            drop(source_writer);
            let _ = fs::remove_dir_all(root);
        }

        #[test]
        fn migration_checkpoints_staging_wal_before_activating_database() {
            let root = temp_dir("wal-staging-activation");
            let target = root.join("ProgramData/data/inventory.db");
            let backups = root.join("ProgramData/backups");
            let inventory = target.parent().unwrap().join("app");
            let logs = target.parent().unwrap().join("logs");
            let config = target.parent().unwrap().join("legacy.json");
            fs::create_dir_all(&inventory).unwrap();
            fs::create_dir_all(&logs).unwrap();
            fs::write(
                &config,
                br#"{"projectRoot":"","databasePath":"data/inventory.db"}"#,
            )
            .unwrap();

            migrate_database_paths(
                &inventory,
                &target,
                &backups,
                &logs,
                &config,
                |staging| {
                    let database = Connection::open(staging).map_err(|error| error.to_string())?;
                    database
                        .pragma_update(None, "journal_mode", "WAL")
                        .map_err(|error| error.to_string())?;
                    persist_wal_after_close(&database);
                    database
                        .execute_batch(
                            "CREATE TABLE users(id TEXT); CREATE TABLE inventory(id TEXT); CREATE TABLE purchase_orders(id TEXT); CREATE TABLE purchase_items(id TEXT); INSERT INTO inventory VALUES ('wal-row');",
                        )
                        .map_err(|error| error.to_string())?;
                    Ok(())
                },
            )
            .unwrap();

            let database = Connection::open(&target).unwrap();
            let journal_mode: String = database
                .query_row("PRAGMA journal_mode", [], |row| row.get(0))
                .unwrap();
            let inventory_count: i64 = database
                .query_row("SELECT COUNT(*) FROM inventory", [], |row| row.get(0))
                .unwrap();
            assert_eq!(journal_mode, "delete");
            assert_eq!(inventory_count, 1);
            drop(database);
            for suffix in ["-wal", "-shm"] {
                assert!(!migration_sidecar_path(&target, suffix).exists());
                assert!(
                    !migration_sidecar_path(
                        &target.with_file_name("inventory.migrating.db"),
                        suffix
                    )
                    .exists()
                );
            }
            let _ = fs::remove_dir_all(root);
        }

        #[test]
        fn completed_legacy_migration_recovers_staging_wal_sidecar_before_validation() {
            let root = temp_dir("legacy-wal-recovery");
            let target = root.join("ProgramData/data/inventory.db");
            let staging = target.with_file_name("inventory.migrating.db");
            let backups = root.join("ProgramData/backups");
            let inventory = target.parent().unwrap().join("app");
            let logs = target.parent().unwrap().join("logs");
            let config = target.parent().unwrap().join("legacy.json");
            fs::create_dir_all(&inventory).unwrap();
            fs::create_dir_all(&logs).unwrap();
            fs::write(
                &config,
                br#"{"projectRoot":"","databasePath":"data/inventory.db"}"#,
            )
            .unwrap();
            let database = Connection::open(&staging).unwrap();
            database.pragma_update(None, "journal_mode", "WAL").unwrap();
            persist_wal_after_close(&database);
            database.execute_batch("CREATE TABLE users(id TEXT); CREATE TABLE inventory(id TEXT); CREATE TABLE purchase_orders(id TEXT); CREATE TABLE purchase_items(id TEXT); INSERT INTO inventory VALUES ('recovered-wal-row');").unwrap();
            drop(database);
            let staging_wal = migration_sidecar_path(&staging, "-wal");
            assert!(staging_wal.is_file());
            fs::rename(&staging, &target).unwrap();
            let state = MigrationState {
                source: None,
                backup: None,
                staging: staging.clone(),
            };
            write_state(&migration_complete_path(&target), &state).unwrap();

            migrate_database_paths(&inventory, &target, &backups, &logs, &config, |_| {
                panic!("completed migrations must not rerun the initializer")
            })
            .unwrap();

            let database = Connection::open(&target).unwrap();
            let inventory_count: i64 = database
                .query_row("SELECT COUNT(*) FROM inventory", [], |row| row.get(0))
                .unwrap();
            assert_eq!(inventory_count, 1);
            assert!(!staging_wal.exists());
            assert!(!migration_sidecar_path(&target, "-wal").exists());
            let _ = fs::remove_dir_all(root);
        }

        #[test]
        fn completed_legacy_migration_discards_empty_staging_wal_sidecar() {
            let root = temp_dir("legacy-empty-wal-recovery");
            let target = root.join("ProgramData/data/inventory.db");
            let staging = target.with_file_name("inventory.migrating.db");
            let backups = root.join("ProgramData/backups");
            let inventory = target.parent().unwrap().join("app");
            let logs = target.parent().unwrap().join("logs");
            let config = target.parent().unwrap().join("legacy.json");
            fs::create_dir_all(&inventory).unwrap();
            fs::create_dir_all(&logs).unwrap();
            fs::write(
                &config,
                br#"{"projectRoot":"","databasePath":"data/inventory.db"}"#,
            )
            .unwrap();
            let database = Connection::open(&staging).unwrap();
            database.pragma_update(None, "journal_mode", "WAL").unwrap();
            database.execute_batch("CREATE TABLE users(id TEXT); CREATE TABLE inventory(id TEXT); CREATE TABLE purchase_orders(id TEXT); CREATE TABLE purchase_items(id TEXT); INSERT INTO inventory VALUES ('kept-row');").unwrap();
            drop(database);
            let staging_wal = migration_sidecar_path(&staging, "-wal");
            fs::write(&staging_wal, []).unwrap();
            let staging_shm = migration_sidecar_path(&staging, "-shm");
            fs::write(&staging_shm, vec![0u8; 32_768]).unwrap();
            fs::rename(&staging, &target).unwrap();
            let state = MigrationState {
                source: None,
                backup: None,
                staging: staging.clone(),
            };
            write_state(&migration_complete_path(&target), &state).unwrap();

            migrate_database_paths(&inventory, &target, &backups, &logs, &config, |_| {
                panic!("completed migrations must not rerun the initializer")
            })
            .unwrap();

            let database = Connection::open(&target).unwrap();
            let inventory_count: i64 = database
                .query_row("SELECT COUNT(*) FROM inventory", [], |row| row.get(0))
                .unwrap();
            assert_eq!(inventory_count, 1);
            assert!(!staging_wal.exists());
            assert!(!staging_shm.exists());
            let _ = fs::remove_dir_all(root);
        }

        #[test]
        fn existing_target_and_legacy_source_are_never_merged_automatically() {
            let root = temp_dir("ambiguous-migration");
            let source = root.join("legacy.db");
            let source_db = Connection::open(&source).unwrap();
            source_db.execute_batch("CREATE TABLE users(id TEXT); CREATE TABLE inventory(id TEXT); CREATE TABLE purchase_orders(id TEXT); CREATE TABLE purchase_items(id TEXT);").unwrap();
            let target = root.join("ProgramData/data/inventory.db");
            fs::create_dir_all(target.parent().unwrap()).unwrap();
            let target_db = Connection::open(&target).unwrap();
            target_db.execute_batch("CREATE TABLE users(id TEXT); CREATE TABLE inventory(id TEXT); CREATE TABLE purchase_orders(id TEXT); CREATE TABLE purchase_items(id TEXT);").unwrap();
            drop(target_db);
            let backups = root.join("ProgramData/backups");
            let result = migrate_for_test(Some(&source), &target, &backups);
            assert!(
                result
                    .unwrap_err()
                    .contains("Both the existing ProgramData database")
            );
            drop(source_db);
            let _ = fs::remove_dir_all(root);
        }

        #[test]
        fn fresh_install_creates_a_verified_database_and_can_resume_after_prepared_swap() {
            let root = temp_dir("fresh-migration");
            let target = root.join("ProgramData/data/inventory.db");
            let backups = root.join("ProgramData/backups");
            migrate_for_test(None, &target, &backups).unwrap();
            assert!(migration_complete_path(&target).is_file());
            assert!(inspect_database(&target).is_ok());
            let _ = fs::remove_dir_all(root);
        }
    }
}

#[cfg(windows)]
fn main() {
    service_host::main();
}

#[cfg(not(windows))]
fn main() {
    eprintln!("SUGRID Inventory Service runs only on Windows.");
    std::process::exit(2);
}
