use super::{
    State, begin, begin_named, database_path, finish, hidden, metadata_path, replace_file, root,
    secure_readable_manifest, set_exact_acl, set_stage, stamp, updater_root,
};
use crate::updater_package::{VerifiedPackage, embedded_public_key, verify_and_extract};
use rusqlite::{Connection, OpenFlags, backup::Backup};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    ffi::{OsStr, OsString},
    fs::{self, File},
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    thread,
    time::{Duration, UNIX_EPOCH},
};
use windows_service::{
    service::{ServiceAccess, ServiceState},
    service_manager::{ServiceManager, ServiceManagerAccess},
};

#[cfg(not(feature = "updater-qa"))]
const INVENTORY_SERVICE: &str = "SUGRIDInventory";
#[cfg(feature = "updater-qa")]
const INVENTORY_SERVICE: &str = "SUGRIDInventoryQA";
#[cfg(not(feature = "updater-qa"))]
const INVENTORY_PORT: u16 = 3000;
#[cfg(feature = "updater-qa")]
const INVENTORY_PORT: u16 = 3300;
const MAX_PACKAGE_BYTES: u64 = 1024 * 1024 * 1024;

struct Prepared {
    job: PathBuf,
    verified: VerifiedPackage,
    operation_id: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct MigrationRequest {
    format_version: u32,
    operation_id: String,
    runtime_relative: String,
    database_relative: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct MigrationResult {
    format_version: u32,
    operation_id: String,
    success: bool,
    error_code: Option<String>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct InstalledVersion {
    version: String,
    commit_sha: String,
    installed_at: u64,
    package_sha256: String,
    #[serde(default)]
    database_schema_version: Option<u32>,
    #[serde(default)]
    min_supported_database_schema_version: Option<u32>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BackupManifestItem {
    name: String,
    size: u64,
    modified_at: u64,
    verified: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    sha256: Option<String>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TransactionJournal {
    format_version: u32,
    operation_id: String,
    restore_only: bool,
    was_running: bool,
    old_runtime_exists: bool,
    old_database_exists: bool,
    old_metadata_exists: bool,
}

fn journal_path() -> Result<PathBuf, String> {
    Ok(updater_root()?.join("active-transaction.json"))
}

fn validate_operation_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 80 && id.bytes().all(|byte| byte.is_ascii_digit() || byte == b'-')
}

fn write_journal(journal: &TransactionJournal) -> Result<(), String> {
    if !validate_operation_id(&journal.operation_id) || journal.format_version != 1 {
        return Err("Invalid updater transaction identifier.".into());
    }
    write_atomic(
        &journal_path()?,
        &serde_json::to_vec(journal).map_err(|error| error.to_string())?,
    )
}

fn read_journal() -> Result<Option<TransactionJournal>, String> {
    let path = journal_path()?;
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("Cannot read updater recovery journal: {error}")),
    };
    Ok(Some(parse_journal(&bytes)?))
}

fn parse_journal(bytes: &[u8]) -> Result<TransactionJournal, String> {
    let journal: TransactionJournal = serde_json::from_slice(bytes)
        .map_err(|_| "Updater recovery journal is malformed; manual review is required.")?;
    if journal.format_version != 1 || !validate_operation_id(&journal.operation_id) {
        return Err("Updater recovery journal is invalid; manual review is required.".into());
    }
    Ok(journal)
}

pub fn ensure_no_pending_recovery() -> Result<(), String> {
    if read_journal()?.is_some() {
        Err("An interrupted inventory transaction requires recovery before maintenance.".into())
    } else {
        Ok(())
    }
}

fn inspected_database(path: &Path) -> Result<(), String> {
    if fs::metadata(path).map_err(|error| error.to_string())?.len() < 100 {
        return Err("SQLite database is empty or too small to be valid.".into());
    }
    let db = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|error| format!("Cannot open SQLite database read-only: {error}"))?;
    let integrity: String = db
        .query_row("PRAGMA integrity_check", [], |row| row.get(0))
        .map_err(|error| format!("SQLite integrity check failed: {error}"))?;
    if integrity != "ok" {
        return Err("SQLite integrity check found a damaged database.".into());
    }
    let mut statement = db
        .prepare("PRAGMA foreign_key_check")
        .map_err(|error| error.to_string())?;
    if statement
        .query([])
        .map_err(|error| error.to_string())?
        .next()
        .map_err(|error| error.to_string())?
        .is_some()
    {
        return Err("SQLite foreign key check found violations.".into());
    }
    Ok(())
}

fn inspected_inventory_backup(path: &Path) -> Result<(), String> {
    inspected_database(path)?;
    let db = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|error| format!("Cannot open inventory backup read-only: {error}"))?;
    for table in ["users", "inventory", "purchase_orders"] {
        let exists: i64 = db
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
                [table],
                |row| row.get(0),
            )
            .map_err(|error| error.to_string())?;
        if exists != 1 {
            return Err(format!("Inventory backup is missing the {table} table."));
        }
    }
    Ok(())
}

pub(super) fn check_database_integrity_at(path: &Path) -> Result<Value, String> {
    let checked_at = stamp() / 1000;
    if !path.is_file() {
        return Ok(json!({
            "integrity": "missing",
            "foreignKeyViolations": 0,
            "checkedAt": checked_at,
        }));
    }
    let database = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|error| format!("Cannot open inventory database read-only: {error}"))?;
    database
        .busy_timeout(Duration::from_secs(3))
        .map_err(|error| error.to_string())?;
    let mut integrity = database
        .prepare("PRAGMA integrity_check")
        .map_err(|error| error.to_string())?;
    let mut rows = integrity
        .query([])
        .map_err(|error| format!("Cannot check SQLite integrity: {error}"))?;
    let mut healthy = true;
    while let Some(row) = rows.next().map_err(|error| error.to_string())? {
        healthy &= row.get::<_, String>(0).map_err(|error| error.to_string())? == "ok";
    }
    for table in ["users", "inventory", "purchase_orders"] {
        let exists: i64 = database
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
                [table],
                |row| row.get(0),
            )
            .map_err(|error| error.to_string())?;
        healthy &= exists == 1;
    }
    let mut foreign_keys = database
        .prepare("PRAGMA foreign_key_check")
        .map_err(|error| error.to_string())?;
    let mut foreign_rows = foreign_keys
        .query([])
        .map_err(|error| format!("Cannot check SQLite foreign keys: {error}"))?;
    let mut violations = 0u64;
    while foreign_rows
        .next()
        .map_err(|error| error.to_string())?
        .is_some()
    {
        violations = violations.saturating_add(1);
    }
    healthy &= violations == 0;
    Ok(json!({
        "integrity": if healthy { "ok" } else { "failed" },
        "foreignKeyViolations": violations,
        "checkedAt": checked_at,
    }))
}

pub(super) fn check_database_integrity() -> Result<Value, String> {
    check_database_integrity_at(&database_path()?)
}

pub fn database_schema_version(path: &Path) -> Result<Option<u32>, String> {
    if !path.is_file() {
        return Ok(None);
    }
    let db = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|error| format!("Cannot inspect inventory database schema: {error}"))?;
    let exists: i64 = db
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations')",
            [],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    if exists == 0 {
        return Ok(Some(0));
    }
    let version: Option<i64> = db
        .query_row("SELECT MAX(version) FROM schema_migrations", [], |row| {
            row.get(0)
        })
        .map_err(|error| format!("Cannot read inventory migration version: {error}"))?;
    let version = version.unwrap_or(0);
    if !(0..=1_000_000).contains(&version) {
        return Err("Inventory database has an invalid migration version.".into());
    }
    Ok(Some(version as u32))
}

fn check_schema_compatibility(
    existing: Option<u32>,
    target: u32,
    minimum: u32,
) -> Result<(), String> {
    let current = existing.unwrap_or(0);
    if minimum > target {
        return Err("The release database migration range is invalid.".into());
    }
    if current < minimum {
        return Err(format!(
            "Inventory database migration version {current} is older than this release supports ({minimum})."
        ));
    }
    if current > target {
        return Err(format!(
            "Inventory database migration version {current} is newer than this release ({target}); refusing a schema downgrade."
        ));
    }
    Ok(())
}

fn required_disk_space(package_bytes: u64, database_bytes: u64) -> Result<u64, String> {
    package_bytes
        .checked_mul(2)
        .and_then(|bytes| {
            database_bytes
                .checked_mul(3)
                .and_then(|database| bytes.checked_add(database))
        })
        .and_then(|bytes| bytes.checked_add(256 * 1024 * 1024))
        .ok_or("Inventory update disk space estimate overflowed.".into())
}

fn check_disk_space(package_bytes: u64, database_bytes: u64) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;

    let required = required_disk_space(package_bytes, database_bytes)?;
    let directory = root()?;
    let wide = directory
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect::<Vec<_>>();
    let mut available = 0u64;
    let success = unsafe {
        GetDiskFreeSpaceExW(
            wide.as_ptr(),
            &mut available,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
        )
    };
    if success == 0 {
        return Err(format!(
            "Cannot check free space on the inventory volume: {}",
            std::io::Error::last_os_error()
        ));
    }
    if available < required {
        return Err(format!(
            "Insufficient disk space for a safe update: {} MiB available, {} MiB required.",
            available / 1024 / 1024,
            required.div_ceil(1024 * 1024)
        ));
    }
    Ok(())
}

pub(super) fn file_sha256(path: &Path) -> Result<String, String> {
    let mut file = File::open(path).map_err(|error| error.to_string())?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let count = file.read(&mut buffer).map_err(|error| error.to_string())?;
        if count == 0 {
            break;
        }
        hasher.update(&buffer[..count]);
    }
    Ok(hex::encode(hasher.finalize()))
}

pub(super) fn verify_backup_manifest_entry(
    path: &Path,
    expected_size: u64,
    expected_modified_at: u64,
    expected_sha256: Option<&str>,
) -> Result<(), String> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| format!("Cannot inspect backup file: {error}"))?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err("Backup entry is not a regular file.".into());
    }
    if metadata.len() != expected_size {
        return Err("Backup file size no longer matches its manifest.".into());
    }
    let modified_at = metadata
        .modified()
        .map_err(|error| format!("Cannot inspect backup modification time: {error}"))?
        .duration_since(UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_secs();
    if modified_at != expected_modified_at {
        return Err("Backup modification time no longer matches its manifest.".into());
    }
    inspected_inventory_backup(path)?;
    let expected_sha256 =
        expected_sha256.ok_or("Backup manifest does not contain a SHA-256 checksum.")?;
    if file_sha256(path)? != expected_sha256 {
        return Err("Backup SHA-256 no longer matches its manifest.".into());
    }
    Ok(())
}

fn write_backup_manifest(directory: &Path) -> Result<(), String> {
    let mut items = Vec::new();
    for entry in fs::read_dir(&directory).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        if !entry
            .file_type()
            .map_err(|error| error.to_string())?
            .is_file()
        {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        if !name.starts_with("inventory.") || !name.ends_with(".db") {
            continue;
        }
        let metadata = entry.metadata().map_err(|error| error.to_string())?;
        let modified_at = metadata
            .modified()
            .map_err(|error| error.to_string())?
            .duration_since(UNIX_EPOCH)
            .map_err(|error| error.to_string())?
            .as_secs();
        let verified = inspected_inventory_backup(&entry.path()).is_ok();
        let sha256 = if verified {
            Some(file_sha256(&entry.path())?)
        } else {
            None
        };
        items.push(BackupManifestItem {
            name,
            size: metadata.len(),
            modified_at,
            verified,
            sha256,
        });
    }
    items.sort_by(|left, right| right.modified_at.cmp(&left.modified_at));
    let manifest = directory.join("manifest.json");
    write_atomic(
        &manifest,
        &serde_json::to_vec_pretty(&items).map_err(|error| error.to_string())?,
    )?;
    secure_readable_manifest(&manifest)
}

fn recorded_backup_at(source: &Path, directory: &Path, label: &str) -> Result<PathBuf, String> {
    let target = backup_path_at(directory, label)?;
    if let Err(error) = online_backup(source, &target) {
        let _ = fs::remove_file(&target);
        return Err(error);
    }
    if let Err(error) = inspected_inventory_backup(&target) {
        let _ = fs::remove_file(&target);
        return Err(error);
    }
    let directory = target
        .parent()
        .ok_or("Inventory backup directory is unavailable.")?;
    if let Err(error) = write_backup_manifest(directory) {
        let _ = fs::remove_file(&target);
        let _ = write_backup_manifest(directory);
        return Err(error);
    }
    Ok(target)
}

fn recorded_backup(source: &Path, label: &str) -> Result<PathBuf, String> {
    recorded_backup_at(source, &root()?.join("backups"), label)
}

fn prune_automatic_backups_in(
    directory: &Path,
    expected: &Path,
    now_ms: u64,
) -> Result<(), String> {
    let canonical_directory = fs::canonicalize(directory)
        .map_err(|error| format!("Cannot verify automatic backup directory: {error}"))?;
    let canonical_expected = fs::canonicalize(&expected)
        .map_err(|error| format!("Cannot verify managed backup directory: {error}"))?;
    if canonical_directory != canonical_expected {
        return Err("Automatic backup directory is outside managed storage.".into());
    }

    let candidates = super::backup_schedule::pruning_candidates(&canonical_directory, now_ms)?;
    remove_expired_auto_backups_in(&canonical_directory, candidates)
}

fn remove_expired_auto_backups_in(
    directory: &Path,
    candidates: Vec<super::backup_schedule::PruningCandidate>,
) -> Result<(), String> {
    for candidate in &candidates {
        verify_backup_manifest_entry(
            &candidate.path,
            candidate.size,
            candidate.modified_at,
            Some(&candidate.sha256),
        )?;
    }
    let removal = candidates.into_iter().try_for_each(|candidate| {
        fs::remove_file(candidate.path)
            .map_err(|error| format!("Cannot remove expired automatic backup: {error}"))
    });
    let manifest = write_backup_manifest(directory);
    match (removal, manifest) {
        (Ok(()), Ok(())) => Ok(()),
        (Err(removal), Ok(())) => Err(removal),
        (Ok(()), Err(manifest)) => Err(manifest),
        (Err(removal), Err(manifest)) => Err(format!(
            "{removal}; also could not update backup manifest: {manifest}"
        )),
    }
}

fn online_backup(source: &Path, target: &Path) -> Result<(), String> {
    if fs::metadata(source)
        .map_err(|error| error.to_string())?
        .len()
        < 100
    {
        return Err("SQLite backup source is empty or invalid.".into());
    }
    let source_db = Connection::open_with_flags(source, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|error| format!("Cannot open backup source read-only: {error}"))?;
    let mut target_db =
        Connection::open(target).map_err(|error| format!("Cannot create backup: {error}"))?;
    {
        let backup = Backup::new(&source_db, &mut target_db).map_err(|error| error.to_string())?;
        backup
            .run_to_completion(100, Duration::from_millis(10), None)
            .map_err(|error| format!("SQLite online backup failed: {error}"))?;
    }
    drop(target_db);
    drop(source_db);
    inspected_database(target)
}

fn finalize_database(path: &Path) -> Result<(), String> {
    let db = Connection::open(path).map_err(|error| error.to_string())?;
    db.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")
        .map_err(|error| error.to_string())?;
    let mode: String = db
        .pragma_update_and_check(None, "journal_mode", "DELETE", |row| row.get(0))
        .map_err(|error| error.to_string())?;
    if mode.to_lowercase() != "delete" {
        return Err("SQLite could not leave WAL mode before database activation.".into());
    }
    drop(db);
    inspected_database(path)
}

fn service() -> Result<windows_service::service::Service, String> {
    let manager = ServiceManager::local_computer(None::<&str>, ServiceManagerAccess::CONNECT)
        .map_err(|error| error.to_string())?;
    manager
        .open_service(
            INVENTORY_SERVICE,
            ServiceAccess::QUERY_STATUS | ServiceAccess::START | ServiceAccess::STOP,
        )
        .map_err(|error| format!("Inventory Windows service is unavailable: {error}"))
}

fn service_running() -> Result<bool, String> {
    Ok(service()?
        .query_status()
        .map_err(|error| error.to_string())?
        .current_state
        == ServiceState::Running)
}

fn start_migration_service() -> Result<(), String> {
    let service = service()?;
    if service
        .query_status()
        .map_err(|error| error.to_string())?
        .current_state
        != ServiceState::Stopped
    {
        return Err("Inventory service must be stopped before isolated migration.".into());
    }
    service
        .start::<OsString>(&[])
        .map_err(|error| format!("Cannot start LocalService migration: {error}"))
}

fn wait_service_stopped() -> Result<(), String> {
    let service = service()?;
    for _ in 0..600 {
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
    Err("LocalService migration did not stop within two minutes.".into())
}

struct Maintenance {
    stop: Arc<AtomicBool>,
    thread: Option<thread::JoinHandle<()>>,
}

impl Maintenance {
    fn start() -> Result<Self, String> {
        let listener = (0..100)
            .find_map(|_| {
                let bound = TcpListener::bind(("0.0.0.0", INVENTORY_PORT)).ok();
                if bound.is_none() {
                    thread::sleep(Duration::from_millis(100));
                }
                bound
            })
            .ok_or("Inventory port did not become available for the maintenance response.")?;
        listener
            .set_nonblocking(true)
            .map_err(|error| error.to_string())?;
        let stop = Arc::new(AtomicBool::new(false));
        let running = Arc::clone(&stop);
        let thread = thread::spawn(move || {
            while !running.load(Ordering::SeqCst) {
                match listener.accept() {
                    Ok((mut stream, _)) => {
                        let _ = stream.set_write_timeout(Some(Duration::from_secs(2)));
                        let body = "SUGRID 库存系统正在更新，请稍后重试。";
                        let response = format!(
                            "HTTP/1.1 503 Service Unavailable\r\nContent-Type: text/plain; charset=utf-8\r\nCache-Control: no-store\r\nRetry-After: 10\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                            body.len()
                        );
                        let _ = stream.write_all(response.as_bytes());
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(30))
                    }
                    Err(_) => break,
                }
            }
        });
        Ok(Self {
            stop,
            thread: Some(thread),
        })
    }
}
impl Drop for Maintenance {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(handle) = self.thread.take() {
            let _ = handle.join();
        }
    }
}

fn check_cancelled(state: &Arc<State>) -> Result<(), String> {
    if state.cancel.load(Ordering::SeqCst) {
        Err("cancelled".into())
    } else {
        Ok(())
    }
}

fn backup_path_at(directory: &Path, label: &str) -> Result<PathBuf, String> {
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    Ok(directory.join(format!("inventory.{label}-{}.db", stamp())))
}

pub fn run_host(command: &str) -> Result<(), String> {
    if !matches!(
        command,
        "start" | "stop" | "enable-autostart" | "disable-autostart"
    ) {
        return Err("Unsupported inventory service operation.".into());
    }
    let host = super::root()?
        .join("app")
        .join("sugrid-inventory-service.exe");
    let result = hidden(&host)
        .arg(OsStr::new(command))
        .output()
        .map_err(|error| error.to_string())?;
    if result.status.success() {
        Ok(())
    } else {
        Err(format!(
            "Inventory service {command} failed with {}.",
            result.status
        ))
    }
}

fn protect_runtime_tree(path: &Path, writable: bool) -> Result<(), String> {
    let metadata = fs::symlink_metadata(path).map_err(|error| error.to_string())?;
    let local_service = if writable { "0x1301bf" } else { "0x1200a9" };
    if metadata.is_dir() {
        let sddl = format!("D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;{local_service};;;LS)");
        set_exact_acl(path, &sddl)?;
        for entry in fs::read_dir(path).map_err(|error| error.to_string())? {
            let entry = entry.map_err(|error| error.to_string())?;
            protect_runtime_tree(&entry.path(), writable)?;
        }
    } else if metadata.is_file() {
        let sddl = format!("D:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;{local_service};;;LS)");
        set_exact_acl(path, &sddl)?;
    } else {
        return Err("Verified inventory runtime contains an unsupported file type.".into());
    }
    Ok(())
}

fn protect_runtime(path: &Path) -> Result<(), String> {
    let extracted = path
        .parent()
        .ok_or("Inventory runtime has no staging parent.")?;
    let job = extracted
        .parent()
        .ok_or("Inventory staging job is invalid.")?;
    let jobs = job
        .parent()
        .ok_or("Inventory staging jobs directory is invalid.")?;
    let updater = updater_root()?;
    if jobs != updater.join("jobs") || extracted != job.join("extracted") {
        return Err("Inventory runtime is outside protected updater staging.".into());
    }
    // Node resolves every parent directory before loading its entry script.
    // These ACEs do not inherit to the package ZIP or operator configuration.
    for directory in [updater.as_path(), jobs, job, extracted] {
        set_exact_acl(
            directory,
            "D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;;0x1200a9;;;LS)",
        )?;
    }
    protect_runtime_tree(path, false)?;
    let cache = path.join(".next").join("cache");
    fs::create_dir_all(&cache)
        .map_err(|error| format!("Cannot prepare inventory runtime cache: {error}"))?;
    protect_runtime_tree(&cache, true)
}

fn read_installed_version(path: &Path) -> Result<Option<InstalledVersion>, String> {
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("Cannot read installed inventory version: {error}")),
    };
    let version = serde_json::from_slice(&bytes)
        .map_err(|_| "Installed inventory version metadata is malformed.")?;
    Ok(Some(version))
}

fn installed_version() -> Result<Option<InstalledVersion>, String> {
    read_installed_version(&metadata_path()?)
}

fn ensure_newer_version(current: Option<&InstalledVersion>, next: &str) -> Result<(), String> {
    let new = semver::Version::parse(next).map_err(|_| "New inventory version is invalid.")?;
    if let Some(current) = current {
        let old = semver::Version::parse(&current.version)
            .map_err(|_| "Installed inventory version is invalid.")?;
        if new <= old {
            return Err(
                "The selected inventory version is not newer than the installed version.".into(),
            );
        }
    }
    Ok(())
}

fn prepare_install(source: &Path, operation_id: String) -> Result<Prepared, String> {
    ensure_no_pending_recovery()?;
    if !source.is_file() {
        return Err("Selected inventory package is unavailable.".into());
    }
    let size = fs::metadata(source)
        .map_err(|error| error.to_string())?
        .len();
    if size == 0 || size > MAX_PACKAGE_BYTES {
        return Err("Inventory package size is outside the allowed range.".into());
    }
    let database = database_path()?;
    let database_bytes = match fs::metadata(&database) {
        Ok(metadata) => {
            inspected_inventory_backup(&database)?;
            metadata.len()
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => 0,
        Err(error) => {
            return Err(format!(
                "Cannot inspect inventory database before update: {error}"
            ));
        }
    };
    check_disk_space(size, database_bytes)?;
    let public_key = embedded_public_key()?;
    let job = updater_root()?.join("jobs").join(&operation_id);
    fs::create_dir_all(job.parent().ok_or("Invalid staging path.")?)
        .map_err(|error| error.to_string())?;
    fs::create_dir(&job)
        .map_err(|error| format!("Cannot create private inventory staging: {error}"))?;
    let prepared = (|| {
        let copied = job.join("package.zip");
        fs::copy(source, &copied).map_err(|error| {
            format!("Cannot copy inventory package into protected staging: {error}")
        })?;
        if fs::metadata(&copied)
            .map_err(|error| error.to_string())?
            .len()
            != size
        {
            return Err("The copied inventory package changed size.".into());
        }
        let verified = verify_and_extract(&copied, &job.join("extracted"), public_key)?;
        ensure_newer_version(installed_version()?.as_ref(), &verified.manifest.version)?;
        let existing = database_schema_version(&database_path()?)?;
        check_schema_compatibility(
            existing,
            verified.manifest.database_schema_version,
            verified.manifest.min_supported_database_schema_version,
        )?;
        protect_runtime(&verified.runtime)?;
        Ok(Prepared {
            job: job.clone(),
            verified,
            operation_id,
        })
    })();
    if prepared.is_err() {
        let _ = fs::remove_dir_all(&job);
    }
    prepared
}

pub fn start_install(state: &Arc<State>, package_path: Option<&str>) -> Result<Value, String> {
    ensure_no_pending_recovery()?;
    let source = PathBuf::from(package_path.ok_or("Select an inventory ZIP package.")?);
    let operation_id = begin(state, "copying")?;
    let worker = Arc::clone(state);
    let id = operation_id.clone();
    thread::spawn(move || {
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let prepared = prepare_install(&source, id)?;
            set_stage(&worker, "verified");
            install_worker(&worker, &prepared)
        }))
        .unwrap_or_else(|_| {
            Err(
                "Inventory update worker panicked; inspect protected staging before retrying."
                    .into(),
            )
        });
        finish(&worker, result);
    });
    Ok(json!({ "operationId": operation_id }))
}

fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let temporary = path.with_extension(format!("{}-{}.tmp", std::process::id(), stamp()));
    let mut file = File::create(&temporary).map_err(|error| error.to_string())?;
    file.write_all(bytes).map_err(|error| error.to_string())?;
    file.sync_all().map_err(|error| error.to_string())?;
    drop(file);
    if let Err(error) = replace_file(&temporary, path) {
        let _ = fs::remove_file(&temporary);
        return Err(error);
    }
    Ok(())
}

fn migration_handshake(
    state: &Arc<State>,
    prepared: &Prepared,
    staging_db: &Path,
) -> Result<(), String> {
    let data = root()?.join("data");
    let request_path = data.join(".updater-migration-request.json");
    let result_path = data.join(".updater-migration-result.json");
    if request_path.exists() || result_path.exists() {
        return Err(
            "An interrupted LocalService migration requires review before retrying.".into(),
        );
    }
    let request = MigrationRequest {
        format_version: 1,
        operation_id: prepared.operation_id.clone(),
        runtime_relative: format!("updater/jobs/{}/extracted/inventory", prepared.operation_id),
        database_relative: format!("data/inventory.migrating-{}.db", prepared.operation_id),
    };
    if root()?.join(&request.database_relative) != staging_db {
        return Err("Staged migration database path does not match the request.".into());
    }
    let request_bytes = serde_json::to_vec(&request).map_err(|error| error.to_string())?;
    write_atomic(&request_path, &request_bytes)?;
    if let Err(error) = start_migration_service() {
        let _ = fs::remove_file(&request_path);
        return Err(error);
    }
    let mut result: Option<MigrationResult> = None;
    for _ in 0..600 {
        if let Ok(bytes) = fs::read(&result_path) {
            result = Some(
                serde_json::from_slice(&bytes)
                    .map_err(|_| "LocalService migration result is malformed.")?,
            );
            break;
        }
        thread::sleep(Duration::from_millis(200));
    }
    wait_service_stopped()?;
    fs::remove_file(&request_path)
        .map_err(|error| format!("Cannot clear staged migration request: {error}"))?;
    fs::remove_file(&result_path)
        .map_err(|error| format!("Cannot clear staged migration result: {error}"))?;
    let result = result.ok_or("LocalService migration did not produce a result.")?;
    if result.format_version != 1 || result.operation_id != prepared.operation_id {
        return Err("LocalService migration result does not match this update.".into());
    }
    if !result.success {
        return Err(format!(
            "LocalService migration failed: {}",
            result.error_code.unwrap_or_else(|| "unknown".into())
        ));
    }
    check_cancelled(state)?;
    finalize_database(staging_db)
}

fn decode_health_body(response: &str) -> Result<Value, String> {
    let (head, body) = response
        .split_once("\r\n\r\n")
        .ok_or("Inventory HTTP health response is malformed.")?;
    if !head.starts_with("HTTP/1.1 200") && !head.starts_with("HTTP/1.0 200") {
        return Err("Inventory HTTP health check did not return 200.".into());
    }
    let chunked = head.lines().any(|line| {
        line.split_once(':').is_some_and(|(name, value)| {
            name.eq_ignore_ascii_case("transfer-encoding")
                && value.trim().eq_ignore_ascii_case("chunked")
        })
    });
    let json_bytes = if chunked {
        let mut cursor = body.as_bytes();
        let mut decoded = Vec::new();
        loop {
            let end = cursor
                .windows(2)
                .position(|bytes| bytes == b"\r\n")
                .ok_or("Inventory HTTP chunk length is malformed.")?;
            let size_text = std::str::from_utf8(&cursor[..end])
                .map_err(|_| "Inventory HTTP chunk length is invalid.")?;
            let size = usize::from_str_radix(size_text.split(';').next().unwrap_or(""), 16)
                .map_err(|_| "Inventory HTTP chunk length is invalid.")?;
            cursor = &cursor[end + 2..];
            if size == 0 {
                break;
            }
            if size > 64 * 1024 || decoded.len() + size > 64 * 1024 || cursor.len() < size + 2 {
                return Err("Inventory HTTP chunk is incomplete or too large.".into());
            }
            decoded.extend_from_slice(&cursor[..size]);
            if &cursor[size..size + 2] != b"\r\n" {
                return Err("Inventory HTTP chunk separator is malformed.".into());
            }
            cursor = &cursor[size + 2..];
        }
        decoded
    } else {
        body.as_bytes().to_vec()
    };
    serde_json::from_slice(&json_bytes)
        .map_err(|_| "Inventory HTTP health response is invalid JSON.".into())
}

fn health_once(version: &str, instance: &str) -> Result<(), String> {
    let mut stream =
        TcpStream::connect(("127.0.0.1", INVENTORY_PORT)).map_err(|error| error.to_string())?;
    stream
        .set_read_timeout(Some(Duration::from_secs(3)))
        .map_err(|error| error.to_string())?;
    stream
        .write_all(b"GET /api/health HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n")
        .map_err(|error| error.to_string())?;
    let mut response = String::new();
    stream
        .take(64 * 1024)
        .read_to_string(&mut response)
        .map_err(|error| error.to_string())?;
    let health = decode_health_body(&response)?;
    if health.get("status").and_then(Value::as_str) != Some("ok")
        || health.get("database").and_then(Value::as_str) != Some("ready")
        || health.get("version").and_then(Value::as_str) != Some(version)
        || health.get("serviceInstance").and_then(Value::as_str) != Some(instance)
    {
        return Err("Inventory HTTP health does not match the installed release.".into());
    }
    Ok(())
}

fn health_matches_version(version: &str) -> Result<(), String> {
    let instance = fs::read_to_string(root()?.join("logs").join("service-instance.txt"))
        .map_err(|error| format!("Cannot verify inventory service instance: {error}"))?;
    let instance = instance.trim();
    if instance.is_empty() {
        return Err("Inventory service instance identifier is empty.".into());
    }
    let mut last_error = String::new();
    for _ in 0..120 {
        match health_once(version, instance) {
            Ok(()) if service_running()? => return Ok(()),
            Ok(()) => last_error = "Inventory Windows service is not running.".into(),
            Err(error) => last_error = error,
        }
        thread::sleep(Duration::from_millis(500));
    }
    Err(format!(
        "Inventory release did not become healthy within one minute: {last_error}"
    ))
}

fn remove_file_if_present(path: &Path) -> Result<(), String> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("Cannot remove {}: {error}", path.display())),
    }
}

fn rename_with_retry(source: &Path, target: &Path) -> std::io::Result<()> {
    for attempt in 0..=50 {
        match fs::rename(source, target) {
            Ok(()) => return Ok(()),
            Err(error) if attempt < 50 && matches!(error.raw_os_error(), Some(5 | 32 | 33)) => {
                thread::sleep(Duration::from_millis(200));
            }
            Err(error) => return Err(error),
        }
    }
    unreachable!()
}

fn restore_transaction_files(base: &Path, journal: &TransactionJournal) -> Result<(), String> {
    let job = base
        .join("updater")
        .join("jobs")
        .join(&journal.operation_id);
    let database = base.join("data").join("inventory.db");
    let old_database = job.join("old-inventory.db");
    let runtime = base.join("inventory");
    let old_runtime = job.join("old-inventory");
    let metadata = base.join("inventory-version.json");
    let old_metadata = job.join("old-version.json");

    if !journal.restore_only {
        if old_runtime.is_dir() {
            if runtime.exists() {
                fs::remove_dir_all(&runtime).map_err(|error| {
                    format!("Cannot remove new runtime during recovery: {error}")
                })?;
            }
            rename_with_retry(&old_runtime, &runtime)
                .map_err(|error| format!("Cannot restore previous runtime: {error}"))?;
        } else if journal.old_runtime_exists && !runtime.is_dir() {
            return Err("Previous runtime is missing during recovery.".into());
        } else if !journal.old_runtime_exists && runtime.is_dir() {
            fs::remove_dir_all(&runtime)
                .map_err(|error| format!("Cannot remove first-install runtime: {error}"))?;
        }
    }

    if old_database.is_file() {
        remove_file_if_present(&database)?;
        for suffix in ["-wal", "-shm"] {
            remove_file_if_present(&database.with_file_name(format!("inventory.db{suffix}")))?;
        }
        rename_with_retry(&old_database, &database)
            .map_err(|error| format!("Cannot restore previous database: {error}"))?;
    } else if journal.old_database_exists && !database.is_file() {
        return Err("Previous database is missing during recovery.".into());
    } else if !journal.old_database_exists {
        remove_file_if_present(&database)?;
        for suffix in ["-wal", "-shm"] {
            remove_file_if_present(&database.with_file_name(format!("inventory.db{suffix}")))?;
        }
    }

    if !journal.restore_only {
        if old_metadata.is_file() {
            remove_file_if_present(&metadata)?;
            rename_with_retry(&old_metadata, &metadata)
                .map_err(|error| format!("Cannot restore previous version metadata: {error}"))?;
        } else if journal.old_metadata_exists && !metadata.is_file() {
            return Err("Previous inventory version metadata is missing during recovery.".into());
        } else if !journal.old_metadata_exists {
            remove_file_if_present(&metadata)?;
        }
    }

    if journal.old_database_exists {
        inspected_database(&database)?;
    }
    Ok(())
}

fn recovered_running_version(
    base: &Path,
    journal: &TransactionJournal,
) -> Result<Option<String>, String> {
    if !journal.was_running {
        return Ok(None);
    }
    let runtime = base.join("inventory");
    if !runtime.join("server.js").is_file() || !runtime.join("node.exe").is_file() {
        return Err("Recovered inventory runtime is incomplete; service remains stopped.".into());
    }
    inspected_database(&base.join("data").join("inventory.db"))?;
    Ok(Some(
        read_installed_version(&base.join("inventory-version.json"))?
            .map(|version| version.version)
            .unwrap_or_else(|| "legacy-unknown".into()),
    ))
}

pub fn recover_interrupted_transaction() -> Result<bool, String> {
    let Some(journal) = read_journal()? else {
        return Ok(false);
    };
    run_host("stop")?;
    let base = root()?;
    if !journal.restore_only && !journal.old_runtime_exists {
        run_host("disable-autostart")?;
    }
    let data = base.join("data");
    remove_file_if_present(&data.join(".updater-migration-request.json"))?;
    remove_file_if_present(&data.join(".updater-migration-result.json"))?;
    restore_transaction_files(&base, &journal)?;
    if let Some(version) = recovered_running_version(&base, &journal)? {
        if let Err(error) = run_host("start").and_then(|_| health_matches_version(&version)) {
            let stop_error = run_host("stop").err();
            return Err(match stop_error {
                Some(stop_error) => format!(
                    "Recovered inventory did not become healthy: {error}; service stop also failed: {stop_error}"
                ),
                None => format!("Recovered inventory did not become healthy: {error}"),
            });
        }
    }
    remove_file_if_present(&journal_path()?)?;
    Ok(true)
}

fn install_worker(state: &Arc<State>, prepared: &Prepared) -> Result<Option<String>, String> {
    check_cancelled(state)?;
    ensure_no_pending_recovery()?;
    let database = database_path()?;
    let stage_db = root()?
        .join("data")
        .join(format!("inventory.migrating-{}.db", prepared.operation_id));
    let old_runtime = root()?.join("inventory");
    let old_database = prepared.job.join("old-inventory.db");
    let old_inventory = prepared.job.join("old-inventory");
    let old_metadata = prepared.job.join("old-version.json");
    let metadata = metadata_path()?;
    let old_runtime_exists = old_runtime.exists();
    let old_database_exists = database.exists();
    let old_metadata_exists = metadata.exists();
    let journal = TransactionJournal {
        format_version: 1,
        operation_id: prepared.operation_id.clone(),
        restore_only: false,
        was_running: service_running()?,
        old_runtime_exists,
        old_database_exists,
        old_metadata_exists,
    };
    write_journal(&journal)?;
    let mut maintenance = None;
    let result = (|| {
        run_host("stop")?;
        maintenance = Some(Maintenance::start()?);
        check_cancelled(state)?;
        set_stage(state, "backing_up");
        if old_database_exists {
            recorded_backup(&database, "before-update")?;
            online_backup(&database, &stage_db)?;
        }
        check_cancelled(state)?;
        set_stage(state, "migrating");
        migration_handshake(state, prepared, &stage_db)?;
        let migrated = database_schema_version(&stage_db)?;
        if migrated != Some(prepared.verified.manifest.database_schema_version) {
            return Err(format!(
                "Migrated database version {:?} differs from signed release version {}.",
                migrated, prepared.verified.manifest.database_schema_version
            ));
        }
        check_cancelled(state)?;
        set_stage(state, "switching");
        if old_runtime_exists {
            rename_with_retry(&old_runtime, &old_inventory).map_err(|error| error.to_string())?;
        }
        rename_with_retry(&prepared.verified.runtime, &old_runtime)
            .map_err(|error| format!("Cannot activate the signed inventory runtime: {error}"))?;
        if old_database_exists {
            finalize_database(&database)?;
            rename_with_retry(&database, &old_database).map_err(|error| error.to_string())?;
        }
        rename_with_retry(&stage_db, &database)
            .map_err(|error| format!("Cannot activate the migrated database: {error}"))?;
        if old_metadata_exists {
            rename_with_retry(&metadata, &old_metadata).map_err(|error| error.to_string())?;
        }
        let version = InstalledVersion {
            version: prepared.verified.manifest.version.clone(),
            commit_sha: prepared.verified.manifest.commit_sha.clone(),
            installed_at: stamp(),
            package_sha256: prepared.verified.package_sha256.clone(),
            database_schema_version: Some(prepared.verified.manifest.database_schema_version),
            min_supported_database_schema_version: Some(
                prepared
                    .verified
                    .manifest
                    .min_supported_database_schema_version,
            ),
        };
        write_atomic(
            &metadata,
            &serde_json::to_vec_pretty(&version).map_err(|error| error.to_string())?,
        )?;
        drop(maintenance.take());
        set_stage(state, "starting");
        run_host("start")?;
        set_stage(state, "health_check");
        health_matches_version(&version.version)?;
        if !old_runtime_exists {
            run_host("enable-autostart")?;
            health_matches_version(&version.version)?;
        }
        fs::remove_file(journal_path()?)
            .map_err(|error| format!("Cannot complete updater transaction journal: {error}"))?;
        Ok(Some(version.version))
    })();
    if let Err(error) = result {
        set_stage(state, "rolling_back");
        drop(maintenance.take());
        return match recover_interrupted_transaction() {
            Ok(_) => {
                set_stage(state, "rolled_back");
                let outcome = if !journal.old_runtime_exists {
                    "first inventory installation was rolled back; service remains stopped"
                } else if journal.was_running {
                    "previous inventory version was restored and passed its health check"
                } else {
                    "previous inventory version was restored; service remains stopped"
                };
                Err(format!("{error}; {outcome}"))
            }
            Err(recovery_error) => Err(format!(
                "{error}; recovery failed and the service remains stopped: {recovery_error}"
            )),
        };
    }
    if result.is_ok() {
        let _ = fs::remove_dir_all(&old_inventory);
        let _ = fs::remove_file(&old_database);
        let _ = fs::remove_dir_all(&prepared.job);
    }
    result
}

pub fn start_backup(state: &Arc<State>) -> Result<Value, String> {
    ensure_no_pending_recovery()?;
    let operation_id = begin(state, "backing_up")?;
    let worker = Arc::clone(state);
    thread::spawn(move || {
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            check_cancelled(&worker)?;
            let source = database_path()?;
            if !source.is_file() {
                return Err("Inventory database is unavailable for backup.".into());
            }
            recorded_backup(&source, "manual")?;
            Ok(None)
        }))
        .unwrap_or_else(|_| Err("Inventory backup worker failed unexpectedly.".into()));
        finish(&worker, result);
    });
    Ok(json!({ "operationId": operation_id }))
}

pub fn run_scheduled_backup(
    state: &Arc<State>,
    label: &str,
    directory: &Path,
) -> Result<(), String> {
    if !label
        .strip_prefix("auto-")
        .is_some_and(|date| date.len() == 8 && date.bytes().all(|byte| byte.is_ascii_digit()))
    {
        return Err("Automatic backup label is invalid.".into());
    }
    let expected = root()?.join("backups");
    fs::create_dir_all(&expected).map_err(|error| error.to_string())?;
    let canonical_directory = fs::canonicalize(directory)
        .map_err(|error| format!("Cannot verify automatic backup directory: {error}"))?;
    let canonical_expected = fs::canonicalize(&expected)
        .map_err(|error| format!("Cannot verify managed backup directory: {error}"))?;
    if canonical_directory != canonical_expected {
        return Err("Automatic backup directory is outside managed storage.".into());
    }

    let _operation_id = begin_named(state, "automatic_backup", "backing_up")?;
    let worker = Arc::clone(state);
    let label = label.to_owned();
    let directory = directory.to_owned();
    thread::spawn(move || {
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            check_cancelled(&worker)?;
            let source = database_path()?;
            if !source.is_file() {
                return Err("Inventory database is unavailable for automatic backup.".into());
            }
            recorded_backup_at(&source, &directory, &label)?;
            set_stage(&worker, "retaining");
            if let Err(error) = prune_automatic_backups_in(&directory, &directory, stamp()) {
                super::append_updater_log(&format!(
                    "Automatic backup retention cleanup failed: {error}"
                ));
            }
            Ok(None)
        }))
        .unwrap_or_else(|_| Err("Automatic inventory backup failed unexpectedly.".into()));
        finish(&worker, result);
    });
    Ok(())
}

pub(super) fn selected_backup_path(name: &str) -> Result<PathBuf, String> {
    selected_backup_path_at(&root()?.join("backups"), name)
}

fn selected_backup_path_at(directory: &Path, name: &str) -> Result<PathBuf, String> {
    if name.len() < 14
        || name.len() > 160
        || !name.starts_with("inventory.")
        || !name.ends_with(".db")
        || !name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'_'))
    {
        return Err("Select a named SUGRID SQLite backup from the backup list.".into());
    }
    let source = directory.join(name);
    if !fs::symlink_metadata(&source)
        .map_err(|_| "Selected SQLite backup does not exist.")?
        .file_type()
        .is_file()
    {
        return Err("Selected SQLite backup does not exist.".into());
    }
    let canonical_directory = fs::canonicalize(&directory).map_err(|error| error.to_string())?;
    let canonical_source = fs::canonicalize(&source).map_err(|error| error.to_string())?;
    if canonical_source.parent() != Some(canonical_directory.as_path()) {
        return Err("Selected SQLite backup leaves the protected backup directory.".into());
    }
    let manifest: Vec<BackupManifestItem> = serde_json::from_slice(
        &fs::read(directory.join("manifest.json"))
            .map_err(|error| format!("Cannot read backup manifest: {error}"))?,
    )
    .map_err(|_| "Backup manifest is invalid.")?;
    let item = manifest
        .iter()
        .find(|item| item.name == name && item.verified)
        .ok_or("Selected backup is not listed as verified.")?;
    let metadata = fs::metadata(&source).map_err(|error| error.to_string())?;
    if metadata.len() != item.size {
        return Err("Selected backup size no longer matches its manifest.".into());
    }
    let modified_at = metadata
        .modified()
        .map_err(|error| error.to_string())?
        .duration_since(UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_secs();
    if modified_at != item.modified_at {
        return Err("Selected backup modification time no longer matches its manifest.".into());
    }
    inspected_inventory_backup(&source)?;
    if let Some(expected) = &item.sha256 {
        if &file_sha256(&source)? != expected {
            return Err("Selected backup SHA-256 no longer matches its manifest.".into());
        }
    }
    Ok(source)
}

fn restore_worker(
    state: &Arc<State>,
    operation_id: &str,
    source: &Path,
) -> Result<Option<String>, String> {
    ensure_no_pending_recovery()?;
    check_cancelled(state)?;
    let base = root()?;
    let database = database_path()?;
    let job = updater_root()?.join("jobs").join(operation_id);
    fs::create_dir(&job).map_err(|error| format!("Cannot prepare restore staging: {error}"))?;
    let staged = job.join("restore.db");
    set_stage(state, "verifying");
    online_backup(source, &staged)?;
    finalize_database(&staged)?;
    if let Some(installed) = installed_version()? {
        if let Some(target) = installed.database_schema_version {
            check_schema_compatibility(
                database_schema_version(&staged)?,
                target,
                installed.min_supported_database_schema_version.unwrap_or(0),
            )?;
        }
    }
    check_cancelled(state)?;
    let old_exists = database.is_file();
    let old_database = job.join("old-inventory.db");
    let old_runtime_exists = base.join("inventory").is_dir();
    let journal = TransactionJournal {
        format_version: 1,
        operation_id: operation_id.into(),
        restore_only: true,
        was_running: service_running()?,
        old_runtime_exists,
        old_database_exists: old_exists,
        old_metadata_exists: metadata_path()?.exists(),
    };
    write_journal(&journal)?;
    let mut maintenance = None;
    let result = (|| {
        run_host("stop")?;
        maintenance = Some(Maintenance::start()?);
        set_stage(state, "backing_up");
        if old_exists {
            recorded_backup(&database, "before-restore")?;
        }
        check_cancelled(state)?;
        set_stage(state, "switching");
        if old_exists {
            finalize_database(&database)?;
            rename_with_retry(&database, &old_database)
                .map_err(|error| format!("Cannot preserve previous database: {error}"))?;
        }
        rename_with_retry(&staged, &database)
            .map_err(|error| format!("Cannot activate selected database backup: {error}"))?;
        inspected_database(&database)?;
        drop(maintenance.take());
        if journal.was_running {
            set_stage(state, "starting");
            run_host("start")?;
            set_stage(state, "health_check");
            let version = installed_version()?
                .map(|value| value.version)
                .unwrap_or_else(|| "legacy-unknown".into());
            health_matches_version(&version)?;
        }
        fs::remove_file(journal_path()?)
            .map_err(|error| format!("Cannot complete restore transaction journal: {error}"))?;
        Ok::<Option<String>, String>(None)
    })();
    if let Err(error) = result {
        set_stage(state, "rolling_back");
        drop(maintenance.take());
        return match recover_interrupted_transaction() {
            Ok(_) => {
                set_stage(state, "rolled_back");
                let outcome = if !journal.old_database_exists {
                    "database restore was rolled back; no previous database was present"
                } else if journal.was_running {
                    "previous database was restored and passed its health check"
                } else {
                    "previous database was restored; service remains stopped"
                };
                Err(format!("{error}; {outcome}"))
            }
            Err(recovery_error) => Err(format!(
                "{error}; restore recovery failed and the service remains stopped: {recovery_error}"
            )),
        };
    }
    let _ = fs::remove_dir_all(&job);
    Ok(None)
}

pub fn start_restore(state: &Arc<State>, backup_name: Option<&str>) -> Result<Value, String> {
    ensure_no_pending_recovery()?;
    let source = selected_backup_path(backup_name.ok_or("Select a SQLite backup to restore.")?)?;
    let operation_id = begin(state, "verifying")?;
    let worker = Arc::clone(state);
    let id = operation_id.clone();
    thread::spawn(move || {
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            restore_worker(&worker, &id, &source)
        }))
        .unwrap_or_else(|_| {
            Err("Inventory restore worker panicked; recovery is required before retrying.".into())
        });
        finish(&worker, result);
    });
    Ok(json!({ "operationId": operation_id }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering as AtomicOrdering};

    static NEXT: AtomicU64 = AtomicU64::new(1);

    fn test_root() -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "sugrid-updater-transaction-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, AtomicOrdering::Relaxed)
        ));
        fs::create_dir_all(&root).unwrap();
        root
    }

    #[test]
    fn interrupted_switch_restores_previous_runtime_database_and_metadata() {
        let base = test_root();
        let job = base.join("updater/jobs/123-456");
        fs::create_dir_all(job.join("old-inventory")).unwrap();
        fs::create_dir_all(base.join("inventory")).unwrap();
        fs::write(job.join("old-inventory/server.js"), "old").unwrap();
        fs::write(base.join("inventory/server.js"), "new").unwrap();
        fs::create_dir_all(base.join("data")).unwrap();
        let old_db = job.join("old-inventory.db");
        Connection::open(&old_db)
            .unwrap()
            .execute_batch("CREATE TABLE records(id INTEGER PRIMARY KEY);")
            .unwrap();
        fs::write(base.join("data/inventory.db"), "new broken database").unwrap();
        fs::write(job.join("old-version.json"), "old").unwrap();
        fs::write(base.join("inventory-version.json"), "new").unwrap();
        let journal = TransactionJournal {
            format_version: 1,
            operation_id: "123-456".into(),
            restore_only: false,
            was_running: false,
            old_runtime_exists: true,
            old_database_exists: true,
            old_metadata_exists: true,
        };
        restore_transaction_files(&base, &journal).unwrap();
        assert_eq!(
            fs::read_to_string(base.join("inventory/server.js")).unwrap(),
            "old"
        );
        assert_eq!(
            fs::read_to_string(base.join("inventory-version.json")).unwrap(),
            "old"
        );
        inspected_database(&base.join("data/inventory.db")).unwrap();
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn restore_rejects_unknown_backup_names() {
        for name in [
            "../inventory.db",
            "C:inventory.db",
            "inventory.db",
            "inventory.foo.exe",
        ] {
            assert!(selected_backup_path(name).is_err());
        }
    }

    #[test]
    fn inventory_restore_rejects_empty_or_wrong_schema_backup() {
        let base = test_root();
        let empty = base.join("empty.db");
        fs::write(&empty, []).unwrap();
        assert!(inspected_inventory_backup(&empty).is_err());
        let wrong_schema = base.join("wrong-schema.db");
        Connection::open(&wrong_schema)
            .unwrap()
            .execute_batch("CREATE TABLE unrelated(id INTEGER PRIMARY KEY);")
            .unwrap();
        assert!(inspected_inventory_backup(&wrong_schema).is_err());
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn inventory_restore_accepts_integral_expected_schema() {
        let base = test_root();
        let database = base.join("inventory.db");
        Connection::open(&database)
            .unwrap()
            .execute_batch(
                "CREATE TABLE users(id INTEGER PRIMARY KEY); \
                 CREATE TABLE inventory(id INTEGER PRIMARY KEY); \
                 CREATE TABLE purchase_orders(id INTEGER PRIMARY KEY);",
            )
            .unwrap();
        inspected_inventory_backup(&database).unwrap();
        assert_eq!(file_sha256(&database).unwrap().len(), 64);
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn legacy_manifest_without_digest_is_rechecked_before_export_selection() {
        let base = test_root();
        let backups = base.join("backups");
        fs::create_dir_all(&backups).unwrap();
        let name = "inventory.manual-20261127-1.db";
        let source = backups.join(name);
        Connection::open(&source)
            .unwrap()
            .execute_batch(
                "CREATE TABLE users(id INTEGER PRIMARY KEY); \
                 CREATE TABLE inventory(id INTEGER PRIMARY KEY); \
                 CREATE TABLE purchase_orders(id INTEGER PRIMARY KEY);",
            )
            .unwrap();
        let metadata = fs::metadata(&source).unwrap();
        let entry = BackupManifestItem {
            name: name.into(),
            size: metadata.len(),
            modified_at: metadata
                .modified()
                .unwrap()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_secs(),
            verified: true,
            sha256: None,
        };
        let manifest = backups.join("manifest.json");
        fs::write(&manifest, serde_json::to_vec(&[&entry]).unwrap()).unwrap();
        assert_eq!(selected_backup_path_at(&backups, name).unwrap(), source);

        fs::write(&source, vec![0u8; metadata.len() as usize]).unwrap();
        assert!(selected_backup_path_at(&backups, name).is_err());

        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn schema_compatibility_rejects_newer_or_out_of_range_databases() {
        assert!(check_schema_compatibility(Some(36), 37, 0).is_ok());
        assert!(check_schema_compatibility(Some(36), 35, 0).is_err());
        assert!(check_schema_compatibility(Some(1), 37, 2).is_err());
        assert!(check_schema_compatibility(Some(1), 2, 3).is_err());
    }

    #[test]
    fn schema_inspection_supports_legacy_databases_and_reads_migration_version() {
        let base = test_root();
        let database = base.join("inventory.db");
        Connection::open(&database)
            .unwrap()
            .execute_batch("CREATE TABLE records(id INTEGER PRIMARY KEY);")
            .unwrap();
        assert_eq!(database_schema_version(&database).unwrap(), Some(0));
        Connection::open(&database)
            .unwrap()
            .execute_batch("CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY); INSERT INTO schema_migrations(version) VALUES (35), (36);")
            .unwrap();
        assert_eq!(database_schema_version(&database).unwrap(), Some(36));
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn database_check_reports_foreign_key_failures_without_writing_data() {
        let base = test_root();
        let database_path = base.join("inventory.db");
        assert_eq!(
            check_database_integrity_at(&database_path).unwrap()["integrity"],
            "missing"
        );
        let database = Connection::open(&database_path).unwrap();
        database
            .execute_batch(
                "CREATE TABLE users(id INTEGER PRIMARY KEY);
                 CREATE TABLE inventory(id INTEGER PRIMARY KEY);
                 CREATE TABLE purchase_orders(id INTEGER PRIMARY KEY);
                 CREATE TABLE parent(id INTEGER PRIMARY KEY);
                 CREATE TABLE child(parent_id INTEGER REFERENCES parent(id));
                 PRAGMA foreign_keys=OFF;
                 INSERT INTO child(parent_id) VALUES(42);",
            )
            .unwrap();
        drop(database);
        let result = check_database_integrity_at(&database_path).unwrap();
        assert_eq!(result["integrity"], "failed");
        assert_eq!(result["foreignKeyViolations"], 1);
        assert_eq!(result["checkedAt"].as_u64().is_some(), true);
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn disk_space_estimate_accounts_for_staging_database_and_margin() {
        assert_eq!(
            required_disk_space(10, 20).unwrap(),
            256 * 1024 * 1024 + 20 + 60
        );
        assert!(required_disk_space(u64::MAX, 1).is_err());
    }

    #[test]
    fn backup_manifest_records_verified_online_backup() {
        let base = test_root();
        let source = base.join("inventory.db");
        let backups = base.join("backups");
        Connection::open(&source)
            .unwrap()
            .execute_batch(
                "CREATE TABLE users(id INTEGER PRIMARY KEY); \
                 CREATE TABLE inventory(id INTEGER PRIMARY KEY); \
                 CREATE TABLE purchase_orders(id INTEGER PRIMARY KEY);",
            )
            .unwrap();

        let created = recorded_backup_at(&source, &backups, "auto-20261127").unwrap();
        assert!(created.is_file());
        let manifest: Vec<BackupManifestItem> =
            serde_json::from_slice(&fs::read(backups.join("manifest.json")).unwrap()).unwrap();
        assert_eq!(manifest.len(), 1);
        assert!(manifest[0].verified);
        let expected_hash = file_sha256(&created).unwrap();
        assert_eq!(manifest[0].sha256.as_deref(), Some(expected_hash.as_str()));
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn automatic_retention_removes_only_expired_verified_auto_backups_and_rebuilds_manifest() {
        let base = test_root();
        let backups = base.join("backups");
        fs::create_dir_all(&backups).unwrap();
        let source = base.join("inventory.db");
        Connection::open(&source)
            .unwrap()
            .execute_batch(
                "CREATE TABLE users(id INTEGER PRIMARY KEY); \
                 CREATE TABLE inventory(id INTEGER PRIMARY KEY); \
                 CREATE TABLE purchase_orders(id INTEGER PRIMARY KEY);",
            )
            .unwrap();

        let names = [
            "inventory.auto-20261127-100.db",
            "inventory.auto-20261126-90.db",
            "inventory.auto-20261120-80.db",
            "inventory.auto-20260701-70.db",
            "inventory.manual-60.db",
            "inventory.before-update-50.db",
        ];
        for name in names {
            online_backup(&source, &backups.join(name)).unwrap();
        }
        write_backup_manifest(&backups).unwrap();

        let now =
            ((super::super::backup_schedule::days_from_civil(2026, 11, 27) as u64 * 24 * 60 * 60
                + 3 * 60 * 60
                - 8 * 60 * 60)
                * 1000) as u64;
        prune_automatic_backups_in(&backups, &backups, now).unwrap();

        assert!(!backups.join("inventory.auto-20260701-70.db").exists());
        assert!(backups.join("inventory.manual-60.db").exists());
        assert!(backups.join("inventory.before-update-50.db").exists());
        let manifest: Vec<BackupManifestItem> =
            serde_json::from_slice(&fs::read(backups.join("manifest.json")).unwrap()).unwrap();
        assert!(
            manifest
                .iter()
                .all(|item| item.name != "inventory.auto-20260701-70.db")
        );
        assert!(
            manifest
                .iter()
                .any(|item| item.name == "inventory.manual-60.db" && item.verified)
        );
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn automatic_retention_rechecks_all_candidates_before_removing_any_file() {
        let base = test_root();
        let backups = base.join("backups");
        fs::create_dir_all(&backups).unwrap();
        let source = base.join("inventory.db");
        Connection::open(&source)
            .unwrap()
            .execute_batch(
                "CREATE TABLE users(id INTEGER PRIMARY KEY); \
                 CREATE TABLE inventory(id INTEGER PRIMARY KEY); \
                 CREATE TABLE purchase_orders(id INTEGER PRIMARY KEY);",
            )
            .unwrap();
        let first = backups.join("inventory.auto-20260701-70.db");
        let second = backups.join("inventory.auto-20260702-71.db");
        online_backup(&source, &first).unwrap();
        online_backup(&source, &second).unwrap();
        write_backup_manifest(&backups).unwrap();

        let now =
            ((super::super::backup_schedule::days_from_civil(2026, 11, 27) as u64 * 24 * 60 * 60
                + 3 * 60 * 60
                - 8 * 60 * 60)
                * 1000) as u64;
        let candidates = super::super::backup_schedule::pruning_candidates(&backups, now).unwrap();
        assert_eq!(candidates.len(), 2);
        Connection::open(&second)
            .unwrap()
            .execute("INSERT INTO users(id) VALUES (1)", [])
            .unwrap();
        assert!(remove_expired_auto_backups_in(&backups, candidates).is_err());
        assert!(first.exists());
        assert!(second.exists());
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn installed_versions_cannot_repeat_or_downgrade() {
        let current = InstalledVersion {
            version: "1.2.3".into(),
            commit_sha: "a".repeat(40),
            installed_at: 0,
            package_sha256: "b".repeat(64),
            database_schema_version: Some(36),
            min_supported_database_schema_version: Some(0),
        };
        assert!(ensure_newer_version(Some(&current), "1.2.3").is_err());
        assert!(ensure_newer_version(Some(&current), "1.2.2").is_err());
        assert!(ensure_newer_version(Some(&current), "1.2.4").is_ok());
        assert!(ensure_newer_version(None, "0.0.1").is_ok());
    }

    #[test]
    fn cancellation_is_honored_before_switch() {
        let state = Arc::new(State::new());
        assert!(check_cancelled(&state).is_ok());
        state.cancel.store(true, Ordering::SeqCst);
        assert_eq!(check_cancelled(&state).unwrap_err(), "cancelled");
    }

    #[test]
    fn recovery_does_not_discard_untouched_previous_files() {
        let base = test_root();
        fs::create_dir_all(base.join("inventory")).unwrap();
        fs::create_dir_all(base.join("data")).unwrap();
        fs::write(base.join("inventory/server.js"), "old").unwrap();
        let database = base.join("data/inventory.db");
        Connection::open(&database)
            .unwrap()
            .execute_batch("CREATE TABLE records(id INTEGER PRIMARY KEY);")
            .unwrap();
        fs::write(base.join("inventory-version.json"), "old").unwrap();
        let journal = TransactionJournal {
            format_version: 1,
            operation_id: "123-456".into(),
            restore_only: false,
            was_running: false,
            old_runtime_exists: true,
            old_database_exists: true,
            old_metadata_exists: true,
        };
        restore_transaction_files(&base, &journal).unwrap();
        assert_eq!(
            fs::read_to_string(base.join("inventory/server.js")).unwrap(),
            "old"
        );
        inspected_database(&database).unwrap();
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn running_recovery_requires_runtime_and_database_before_health_check() {
        let base = test_root();
        let runtime = base.join("inventory");
        let data = base.join("data");
        fs::create_dir_all(&runtime).unwrap();
        fs::create_dir_all(&data).unwrap();
        fs::write(runtime.join("server.js"), "server").unwrap();
        let journal = TransactionJournal {
            format_version: 1,
            operation_id: "123-456".into(),
            restore_only: false,
            was_running: true,
            old_runtime_exists: true,
            old_database_exists: true,
            old_metadata_exists: false,
        };
        assert!(recovered_running_version(&base, &journal).is_err());
        fs::write(runtime.join("node.exe"), "node").unwrap();
        assert!(recovered_running_version(&base, &journal).is_err());
        Connection::open(data.join("inventory.db"))
            .unwrap()
            .execute_batch("CREATE TABLE records(id INTEGER PRIMARY KEY);")
            .unwrap();
        assert_eq!(
            recovered_running_version(&base, &journal)
                .unwrap()
                .as_deref(),
            Some("legacy-unknown")
        );
        let metadata = InstalledVersion {
            version: "1.2.3".into(),
            commit_sha: "a".repeat(40),
            installed_at: 0,
            package_sha256: "b".repeat(64),
            database_schema_version: Some(36),
            min_supported_database_schema_version: Some(0),
        };
        fs::write(
            base.join("inventory-version.json"),
            serde_json::to_vec(&metadata).unwrap(),
        )
        .unwrap();
        assert_eq!(
            recovered_running_version(&base, &journal)
                .unwrap()
                .as_deref(),
            Some("1.2.3")
        );
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn recovery_journal_rejects_tampered_paths_and_unknown_fields() {
        let journal = TransactionJournal {
            format_version: 1,
            operation_id: "123-456".into(),
            restore_only: false,
            was_running: true,
            old_runtime_exists: true,
            old_database_exists: true,
            old_metadata_exists: true,
        };
        let valid = serde_json::to_vec(&journal).unwrap();
        assert!(parse_journal(&valid).is_ok());
        let traversal = String::from_utf8(valid.clone())
            .unwrap()
            .replace("123-456", "../../outside");
        assert!(parse_journal(traversal.as_bytes()).is_err());
        let unknown = String::from_utf8(valid)
            .unwrap()
            .replace("{", "{\"unexpected\":true,");
        assert!(parse_journal(unknown.as_bytes()).is_err());
    }

    #[test]
    fn health_parser_accepts_chunked_json_and_rejects_truncated_chunks() {
        let body =
            br#"{"status":"ok","database":"ready","version":"1.0.0","serviceInstance":"qa"}"#;
        let response = format!(
            "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n{:x}\r\n{}\r\n0\r\n\r\n",
            body.len(),
            std::str::from_utf8(body).unwrap()
        );
        assert_eq!(decode_health_body(&response).unwrap()["version"], "1.0.0");
        assert!(
            decode_health_body(
                "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n10\r\nshort\r\n0\r\n\r\n"
            )
            .is_err()
        );
    }
}
