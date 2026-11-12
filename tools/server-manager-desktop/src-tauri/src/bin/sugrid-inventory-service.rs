#![cfg_attr(windows, windows_subsystem = "windows")]

#[cfg(windows)]
mod service_host {
    use rusqlite::{Connection, OpenFlags, backup::Backup};
    use serde::{Deserialize, Serialize};
    use std::{
        ffi::{OsStr, OsString},
        fs::{self, OpenOptions},
        io::{self, Write},
        net::TcpListener,
        path::{Path, PathBuf},
        process::{Command, Stdio},
        sync::mpsc,
        thread,
        time::{Duration, SystemTime, UNIX_EPOCH},
    };
    use windows_service::{
        Error as WindowsServiceError, define_windows_service,
        service::{
            ServiceAccess, ServiceAction, ServiceActionType, ServiceControl, ServiceControlAccept,
            ServiceErrorControl, ServiceExitCode, ServiceFailureActions, ServiceFailureResetPeriod,
            ServiceInfo, ServiceStartType, ServiceState, ServiceStatus, ServiceType,
        },
        service_control_handler::{self, ServiceControlHandlerResult},
        service_manager::{ServiceManager, ServiceManagerAccess},
    };

    const SERVICE_NAME: &str = "SUGRIDInventory";
    const SERVICE_DISPLAY_NAME: &str = "SUGRID Inventory Server";
    const DATA_FOLDER: &str = "SUGRID\\Inventory";
    const PORT: u16 = 3000;

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
        let root = std::env::var_os("PROGRAMDATA")
            .map(PathBuf::from)
            .ok_or("Windows did not provide the ProgramData directory.")?;
        Ok(root.join(DATA_FOLDER))
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
        if !inventory.join("node.exe").is_file() || !inventory.join("server.js").is_file() {
            return Err(format!(
                "The bundled inventory server is incomplete: {}",
                inventory.display()
            ));
        }
        Ok(paths_for(&inventory, &program_data, &executable))
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

    fn write_install_diagnostic(root: &Path, step: &str, error: &str) {
        let _ = fs::create_dir_all(root);
        let path = install_diagnostic_path(root);
        let summary = format!(
            "step={step}; {}; service={SERVICE_NAME}; port={PORT}\r\n",
            install_error_code(error)
        );
        if fs::write(&path, summary).is_ok() {
            // The summary contains no database data, credentials, or local paths.
            let _ = hidden_command("icacls.exe")
                .args([
                    path.to_string_lossy().as_ref(),
                    "/grant:r",
                    "BUILTIN\\Users:(R)",
                ])
                .output();
        }
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
        let raw = PathBuf::from(legacy.database_path.trim());
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
        let source = Connection::open_with_flags(
            source_path,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_FULL_MUTEX,
        )
        .map_err(|error| format!("Cannot open source database: {error}"))?;
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
                inspect_database(&state.staging)?;
                if let Some(backup) = state.backup.as_ref() {
                    verify_critical_rows(backup, &state.staging)?;
                }
                fs::rename(&state.staging, database)
                    .map_err(|error| format!("Could not finish database migration: {error}"))?;
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
        let path_text = path.to_string_lossy().into_owned();
        let output = hidden_command("icacls.exe")
            .args([
                path_text.as_str(),
                "/grant:r",
                "NT AUTHORITY\\LOCAL SERVICE:(OI)(CI)(M)",
                "/T",
                "/C",
            ])
            .output()
            .map_err(|error| format!("Could not set {} permissions: {error}", path.display()))?;
        if !output.status.success() {
            return Err(format!(
                "Could not set {} permissions: {}",
                path.display(),
                String::from_utf8_lossy(&output.stderr).trim()
            ));
        }
        Ok(())
    }

    fn grant_users_directory_listing(path: &Path) -> Result<(), String> {
        let path_text = path.to_string_lossy().into_owned();
        let output = hidden_command("icacls.exe")
            .args([path_text.as_str(), "/grant:r", "BUILTIN\\Users:(RX)"])
            .output()
            .map_err(|error| {
                format!(
                    "Could not allow safe metadata access to {}: {error}",
                    path.display()
                )
            })?;
        if !output.status.success() {
            return Err(format!(
                "Could not allow safe metadata access to {}: {}",
                path.display(),
                String::from_utf8_lossy(&output.stderr).trim()
            ));
        }
        Ok(())
    }

    fn set_data_permissions(root: &Path) -> Result<(), String> {
        let root_text = root.to_string_lossy().into_owned();
        let output = hidden_command("icacls.exe")
            .args([root_text.as_str(), "/reset", "/T", "/C"])
            .output()
            .map_err(|error| format!("Could not reset inherited data permissions: {error}"))?;
        if !output.status.success() {
            return Err(format!(
                "Could not reset inherited data permissions: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            ));
        }
        let output = hidden_command("icacls.exe")
            .args([
                root_text.as_str(),
                "/inheritance:r",
                "/grant:r",
                "SYSTEM:(OI)(CI)(F)",
                "BUILTIN\\Administrators:(OI)(CI)(F)",
                "NT AUTHORITY\\LOCAL SERVICE:(OI)(CI)(RX)",
            ])
            .output()
            .map_err(|error| format!("Could not secure the ProgramData directory: {error}"))?;
        if !output.status.success() {
            return Err(format!(
                "Could not set ProgramData permissions: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            ));
        }
        grant_users_directory_listing(root)?;

        for directory in ["data", "backups", "logs"] {
            let path = root.join(directory);
            fs::create_dir_all(&path).map_err(|error| error.to_string())?;
            let path_text = path.to_string_lossy().into_owned();
            let output = hidden_command("icacls.exe")
                .args([
                    path_text.as_str(),
                    "/inheritance:r",
                    "/grant:r",
                    "SYSTEM:(OI)(CI)(F)",
                    "BUILTIN\\Administrators:(OI)(CI)(F)",
                    "NT AUTHORITY\\LOCAL SERVICE:(OI)(CI)(M)",
                    "/T",
                    "/C",
                ])
                .output()
                .map_err(|error| {
                    format!("Could not set {} permissions: {error}", path.display())
                })?;
            if !output.status.success() {
                return Err(format!(
                    "Could not set {} permissions: {}",
                    path.display(),
                    String::from_utf8_lossy(&output.stderr).trim()
                ));
            }
        }
        let backups = root.join("backups");
        grant_users_directory_listing(&backups)?;
        grant_users_directory_listing(&root.join("logs"))?;
        // Backup metadata is refreshed by explicit backup operations. ACL repair
        // must not depend on writing a manifest for pre-existing backup files.
        let instance_file = root.join("logs").join("service-instance.txt");
        OpenOptions::new()
            .create(true)
            .write(true)
            .open(&instance_file)
            .map_err(|error| format!("Could not prepare service identity file: {error}"))?;
        let instance_acl = hidden_command("icacls.exe")
            .args([
                instance_file.to_string_lossy().as_ref(),
                "/grant:r",
                "BUILTIN\\Users:(R)",
            ])
            .output()
            .map_err(|error| format!("Could not grant service identity read access: {error}"))?;
        if !instance_acl.status.success() {
            return Err(format!(
                "Could not grant service identity read access: {}",
                String::from_utf8_lossy(&instance_acl.stderr).trim()
            ));
        }
        for directory in ["app", "inventory"] {
            let path = root.join(directory);
            if !path.exists() {
                continue;
            }
            let path_text = path.to_string_lossy().into_owned();
            let output = hidden_command("icacls.exe")
                .args([
                    path_text.as_str(),
                    "/inheritance:r",
                    "/grant:r",
                    "SYSTEM:(OI)(CI)(F)",
                    "BUILTIN\\Administrators:(OI)(CI)(F)",
                    "NT AUTHORITY\\LOCAL SERVICE:(OI)(CI)(RX)",
                    "/T",
                    "/C",
                ])
                .output()
                .map_err(|error| {
                    format!("Could not set {} permissions: {error}", path.display())
                })?;
            if !output.status.success() {
                return Err(format!(
                    "Could not set {} permissions: {}",
                    path.display(),
                    String::from_utf8_lossy(&output.stderr).trim()
                ));
            }
        }
        let cache = root.join("inventory").join(".next").join("cache");
        if cache.exists() {
            grant_local_service_modify(&cache)?;
        }
        Ok(())
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

    fn install_windows_service(paths: &Paths) -> Result<(), String> {
        let manager =
            service_manager(ServiceManagerAccess::CONNECT | ServiceManagerAccess::CREATE_SERVICE)?;
        let info = ServiceInfo {
            name: OsString::from(SERVICE_NAME),
            display_name: OsString::from(SERVICE_DISPLAY_NAME),
            service_type: ServiceType::OWN_PROCESS,
            start_type: ServiceStartType::AutoStart,
            error_control: ServiceErrorControl::Normal,
            executable_path: paths.service_exe.clone(),
            launch_arguments: vec![OsString::from("run")],
            dependencies: vec![],
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
                let status = service.query_status().map_err(|error| error.to_string())?;
                if status.current_state != ServiceState::Stopped {
                    service.stop().map_err(|error| error.to_string())?;
                    wait_for_state(&service, ServiceState::Stopped)?;
                }
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
        let acl =
            "D:(A;;CCLCSWRPWPDTLOCRRC;;;SY)(A;;CCDCLCSWRPWPDTLOCRSDRCWDWO;;;BA)(A;;LCRPWP;;;BU)";
        let acl_result = hidden_command("sc.exe")
            .args(["sdset", SERVICE_NAME, acl])
            .output()
            .map_err(|error| format!("Could not configure service controls: {error}"))?;
        if !acl_result.status.success() {
            return Err(format!(
                "Could not grant local users start/stop access to this service: {}",
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
        let service_was_installed = service_installed()?;
        let was_running = stop_service_if_running()?;
        let mut runtime_stage = None;
        let mut install_step = "preflight";
        let install_result = (|| {
            install_step = "port-preflight";
            ensure_port_available(PORT)?;
            install_step = "prepare-program-data";
            fs::create_dir_all(&paths.program_data).map_err(|error| error.to_string())?;
            fs::create_dir_all(
                &paths
                    .database
                    .parent()
                    .ok_or("Invalid database directory.")?,
            )
            .map_err(|error| error.to_string())?;
            fs::create_dir_all(&paths.backups).map_err(|error| error.to_string())?;
            fs::create_dir_all(&paths.logs).map_err(|error| error.to_string())?;
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
            install_step = "migrate-database";
            migrate_or_initialize(
                &paths.inventory,
                &paths.database,
                &paths.backups,
                &paths.logs,
                legacy_config,
            )?;
            install_step = "apply-data-permissions";
            set_data_permissions(&paths.program_data)?;
            install_step = "install-windows-service";
            install_windows_service(&paths)?;
            install_step = "start-and-health-check";
            start_and_wait_healthy(&paths)?;
            Ok::<(), String>(())
        })();
        if let Err(install_error) = install_result {
            let stop_error = stop_service_if_running().err();
            let rollback_error = runtime_stage
                .take()
                .and_then(|stage| rollback_runtime(stage).err());
            let permissions_error = if rollback_error.is_none() {
                set_data_permissions(&paths.program_data).err()
            } else {
                None
            };
            let recovery_error = if service_was_installed {
                install_windows_service(&paths)
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
            let details = [
                stop_error,
                rollback_error,
                permissions_error,
                recovery_error,
            ]
            .into_iter()
            .flatten()
            .collect::<Vec<_>>();
            let detail = if details.is_empty() {
                "Previous service files were restored.".to_string()
            } else {
                format!("Recovery also reported: {}", details.join("; "))
            };
            append_log(
                &paths,
                &format!(
                    "Installation failed at {install_step}: {install_error}. {detail}. Diagnostic: {}",
                    install_diagnostic_path(&paths.program_data).display()
                ),
            );
            // Recovery may reset ACLs; publish the user-readable summary last.
            write_install_diagnostic(&paths.program_data, install_step, &install_error);
            return Err(format!(
                "Installation failed at {install_step}: {install_error}. {detail}. Diagnostic: {}",
                install_diagnostic_path(&paths.program_data).display()
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

    fn uninstall() -> Result<(), String> {
        let manager = service_manager(ServiceManagerAccess::CONNECT)?;
        let Some(service) = open_optional_service(
            &manager,
            ServiceAccess::QUERY_STATUS | ServiceAccess::STOP | ServiceAccess::DELETE,
        )?
        else {
            return Ok(());
        };
        let status = service.query_status().map_err(|error| error.to_string())?;
        if status.current_state != ServiceState::Stopped {
            service
                .stop()
                .map_err(|error| format!("Could not stop service before uninstall: {error}"))?;
            wait_for_state(&service, ServiceState::Stopped)?;
        }
        service
            .delete()
            .map_err(|error| format!("Could not remove Windows service: {error}"))?;
        let paths = current_paths()?;
        for directory in ["app", "inventory"] {
            let path = paths.program_data.join(directory);
            if let Err(error) = fs::remove_dir_all(&path) {
                if error.kind() != std::io::ErrorKind::NotFound {
                    return Err(format!(
                        "Windows service was removed, but runtime files at {} could not be deleted: {error}",
                        path.display()
                    ));
                }
            }
        }
        Ok(())
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
            .env("SUGRID_APP_VERSION", env!("CARGO_PKG_VERSION"))
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
                if let Ok(paths) = current_paths() {
                    append_log(&paths, &message);
                }
                std::process::exit(0);
            }
            Err(error) => {
                if let Ok(paths) = current_paths() {
                    append_log(&paths, &error);
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
        }

        #[test]
        fn install_diagnostic_is_a_small_user_readable_summary() {
            let root = temp_dir("diagnostic");
            write_install_diagnostic(
                &root,
                "service-start",
                "IO error in winapi call (Win32 error 5)",
            );
            let diagnostic = fs::read_to_string(install_diagnostic_path(&root)).unwrap();
            assert!(diagnostic.contains("step=service-start"));
            assert!(diagnostic.contains("win32=5"));
            assert!(!diagnostic.contains("C:\\Users"));
            assert!(!diagnostic.contains("database"));
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
