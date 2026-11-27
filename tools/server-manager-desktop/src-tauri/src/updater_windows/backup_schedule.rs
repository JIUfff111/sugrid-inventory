//! Calendar rules for updater-owned automatic database backups.
//! All calendar boundaries are evaluated in Beijing time (UTC+08:00).

use super::operations::verify_backup_manifest_entry;
use serde::Deserialize;
use std::{
    collections::HashSet,
    fs,
    path::{Path, PathBuf},
    time::{Duration, UNIX_EPOCH},
};

const BEIJING_OFFSET_SECONDS: u64 = 8 * 60 * 60;
const DAY_SECONDS: u64 = 24 * 60 * 60;
const BACKUP_HOUR_SECONDS: u64 = 2 * 60 * 60;
const AUTO_PREFIX: &str = "inventory.auto-";

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ManifestEntry {
    name: String,
    verified: bool,
    #[serde(default)]
    size: u64,
    #[serde(default)]
    modified_at: u64,
    #[serde(default)]
    sha256: Option<String>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct AutoBackup {
    day: i64,
    stamp: u64,
}

pub(super) struct PruningCandidate {
    pub path: PathBuf,
    pub size: u64,
    pub modified_at: u64,
    pub sha256: String,
}

fn beijing_day(now_ms: u64) -> i64 {
    ((now_ms / 1000 + BEIJING_OFFSET_SECONDS) / DAY_SECONDS) as i64
}

fn beijing_second_of_day(now_ms: u64) -> u64 {
    (now_ms / 1000 + BEIJING_OFFSET_SECONDS) % DAY_SECONDS
}

// The civil date conversion is the Gregorian 400-year cycle calculation.
// Day 0 is 1970-01-01, so it is independent of the host's Windows time zone.
fn civil_from_days(day: i64) -> (i64, u32, u32) {
    let day = day + 719_468;
    let era = day.div_euclid(146_097);
    let day_of_era = day - era * 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let mut year = year_of_era + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_part = (5 * day_of_year + 2) / 153;
    let date = day_of_year - (153 * month_part + 2) / 5 + 1;
    let month = month_part + if month_part < 10 { 3 } else { -9 };
    if month <= 2 {
        year += 1;
    }
    (year, month as u32, date as u32)
}

pub(super) fn days_from_civil(year: i64, month: u32, date: u32) -> i64 {
    let year = year - i64::from(month <= 2);
    let era = year.div_euclid(400);
    let year_of_era = year - era * 400;
    let month_part = i64::from(month) + if month > 2 { -3 } else { 9 };
    let day_of_year = (153 * month_part + 2) / 5 + i64::from(date) - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}

fn date_label(day: i64) -> String {
    let (year, month, date) = civil_from_days(day);
    format!("{year:04}{month:02}{date:02}")
}

fn parse_auto_backup(name: &str) -> Option<AutoBackup> {
    let suffix = name.strip_prefix(AUTO_PREFIX)?.strip_suffix(".db")?;
    let (date, stamp) = suffix.split_once('-')?;
    if date.len() != 8
        || !date.bytes().all(|byte| byte.is_ascii_digit())
        || stamp.is_empty()
        || !stamp.bytes().all(|byte| byte.is_ascii_digit())
    {
        return None;
    }
    let year = date[0..4].parse::<i64>().ok()?;
    let month = date[4..6].parse::<u32>().ok()?;
    let date_of_month = date[6..8].parse::<u32>().ok()?;
    if !(1970..=9999).contains(&year) || !(1..=12).contains(&month) {
        return None;
    }
    let day = days_from_civil(year, month, date_of_month);
    if civil_from_days(day) != (year, month, date_of_month) {
        return None;
    }
    Some(AutoBackup {
        day,
        stamp: stamp.parse().ok()?,
    })
}

fn verified_auto_backups(directory: &Path) -> Result<Vec<(ManifestEntry, AutoBackup)>, String> {
    let manifest_path = directory.join("manifest.json");
    match fs::symlink_metadata(&manifest_path) {
        Ok(metadata) if metadata.is_file() && !metadata.file_type().is_symlink() => {}
        Ok(_) => return Err("Backup manifest is not a regular file.".into()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(format!("Cannot inspect backup manifest: {error}")),
    }
    let manifest = match fs::read(&manifest_path) {
        Ok(bytes) => bytes,
        Err(error) => return Err(format!("Cannot read backup manifest: {error}")),
    };
    let entries: Vec<ManifestEntry> = serde_json::from_slice(&manifest)
        .map_err(|error| format!("Cannot parse backup manifest: {error}"))?;
    let mut backups = Vec::new();
    let mut seen = HashSet::new();
    for entry in entries {
        if !entry.verified || !seen.insert(entry.name.clone()) {
            continue;
        }
        let Some(parsed) = parse_auto_backup(&entry.name) else {
            continue;
        };
        let path = directory.join(&entry.name);
        if verify_backup_manifest_entry(
            &path,
            entry.size,
            entry.modified_at,
            entry.sha256.as_deref(),
        )
        .is_ok()
        {
            backups.push((entry, parsed));
        }
    }
    Ok(backups)
}

/// A quick dashboard hint from the backup manifest. This does not rehash or
/// open SQLite files on every UI poll; the scheduler, pruning, and export paths
/// perform full verification before relying on a backup.
pub(super) fn latest_recorded_auto_backup_at(directory: &Path) -> Option<u64> {
    let manifest_path = directory.join("manifest.json");
    let manifest_metadata = fs::symlink_metadata(&manifest_path).ok()?;
    if !manifest_metadata.is_file() || manifest_metadata.file_type().is_symlink() {
        return None;
    }
    let manifest: Vec<ManifestEntry> =
        serde_json::from_slice(&fs::read(manifest_path).ok()?).ok()?;
    let mut entries = manifest
        .into_iter()
        .filter(|entry| {
            entry.verified
                && parse_auto_backup(&entry.name).is_some()
                && entry.sha256.as_ref().is_none_or(|sha256| {
                    sha256.len() == 64 && sha256.bytes().all(|byte| byte.is_ascii_hexdigit())
                })
        })
        .collect::<Vec<_>>();
    entries.sort_by_key(|entry| std::cmp::Reverse(entry.modified_at));
    for entry in entries {
        let path = directory.join(&entry.name);
        let Ok(metadata) = fs::symlink_metadata(path) else {
            continue;
        };
        if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() != entry.size
        {
            continue;
        }
        let Ok(modified_at) = metadata.modified().and_then(|time| {
            time.duration_since(UNIX_EPOCH)
                .map_err(|error| std::io::Error::other(error.to_string()))
        }) else {
            continue;
        };
        if modified_at.as_secs() != entry.modified_at {
            continue;
        }
        return Some(entry.modified_at);
    }
    None
}

#[cfg(test)]
fn latest_verified_auto_backup_at(directory: &Path) -> Option<u64> {
    let manifest_path = directory.join("manifest.json");
    let manifest_metadata = fs::symlink_metadata(&manifest_path).ok()?;
    if !manifest_metadata.is_file() || manifest_metadata.file_type().is_symlink() {
        return None;
    }
    let manifest: Vec<ManifestEntry> =
        serde_json::from_slice(&fs::read(manifest_path).ok()?).ok()?;
    let mut entries = manifest
        .into_iter()
        .filter(|entry| entry.verified && parse_auto_backup(&entry.name).is_some())
        .collect::<Vec<_>>();
    entries.sort_by_key(|entry| std::cmp::Reverse(entry.modified_at));
    for entry in entries {
        let path = directory.join(&entry.name);
        if verify_backup_manifest_entry(
            &path,
            entry.size,
            entry.modified_at,
            entry.sha256.as_deref(),
        )
        .is_err()
        {
            continue;
        }
        return Some(entry.modified_at);
    }
    None
}

/// Return today's label after 02:00 Beijing time if no verified automatic
/// backup for this calendar day exists. A service restart after 02:00 catches
/// up, while an unfinished or unverified file does not suppress a new attempt.
pub fn due_label(directory: &Path, now_ms: u64) -> Result<Option<String>, String> {
    if beijing_second_of_day(now_ms) < BACKUP_HOUR_SECONDS {
        return Ok(None);
    }
    let today = beijing_day(now_ms);
    if verified_auto_backups(directory)?
        .iter()
        .any(|(_, backup)| backup.day == today)
    {
        Ok(None)
    } else {
        Ok(Some(format!("auto-{}", date_label(today))))
    }
}

/// Wake at the next 02:00 Beijing boundary, checking at least once per hour
/// so service shutdown remains prompt. The caller can retry sooner on errors.
pub fn next_check_delay(now_ms: u64) -> Duration {
    let second = beijing_second_of_day(now_ms);
    let until_target = if second < BACKUP_HOUR_SECONDS {
        BACKUP_HOUR_SECONDS - second
    } else {
        DAY_SECONDS - second + BACKUP_HOUR_SECONDS
    };
    Duration::from_secs(until_target.clamp(1, 60 * 60))
}

/// Retry a due backup soon enough to recover from transient worker failures.
/// A worker starts asynchronously, so its outcome is observed at this poll.
pub fn retry_check_delay() -> Duration {
    Duration::from_secs(15 * 60)
}

fn monday(day: i64) -> i64 {
    day - (day + 3).rem_euclid(7)
}

/// Return only updater-owned, verified automatic backups that exceed the
/// rolling 7 daily, 4 completed weekly, and 3 completed monthly generations.
/// The caller deletes these paths and rebuilds the backup manifest afterward.
/// Manual and before-update/restore backups are never returned.
pub fn pruning_candidates(directory: &Path, now_ms: u64) -> Result<Vec<PruningCandidate>, String> {
    let today = beijing_day(now_ms);
    let current_monday = monday(today);
    let (current_year, current_month, _) = civil_from_days(today);
    let current_month_number = current_year * 12 + i64::from(current_month);
    let mut backups = verified_auto_backups(directory)?;
    backups.sort_by(|left, right| {
        right
            .1
            .day
            .cmp(&left.1.day)
            .then_with(|| right.1.stamp.cmp(&left.1.stamp))
    });

    let mut kept_days = HashSet::new();
    let mut kept_weeks = HashSet::new();
    let mut kept_months = HashSet::new();
    let mut remove = Vec::new();
    for (entry, backup) in backups {
        let age = today - backup.day;
        let (year, month, _) = civil_from_days(backup.day);
        let month_number = year * 12 + i64::from(month);
        let month_age = current_month_number - month_number;
        let week_number = monday(backup.day);
        let week_age = (current_monday - week_number) / 7;

        let keep_daily = (0..7).contains(&age) && kept_days.insert(backup.day);
        let keep_weekly = (1..=4).contains(&week_age) && kept_weeks.insert(week_number);
        let keep_monthly = (1..=3).contains(&month_age) && kept_months.insert(month_number);
        if age < 0 || keep_daily || keep_weekly || keep_monthly {
            // A daily copy may also satisfy a weekly or monthly slot.
            kept_weeks.insert(week_number);
            kept_months.insert(month_number);
        } else {
            let Some(sha256) = entry.sha256 else {
                continue;
            };
            remove.push(PruningCandidate {
                path: directory.join(&entry.name),
                size: entry.size,
                modified_at: entry.modified_at,
                sha256,
            });
        }
    }
    Ok(remove)
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;
    use sha2::{Digest, Sha256};
    use std::fs::write;

    fn ms(year: i64, month: u32, date: u32, hour: u64) -> u64 {
        ((days_from_civil(year, month, date) as u64 * DAY_SECONDS + hour * 60 * 60
            - BEIJING_OFFSET_SECONDS)
            * 1000) as u64
    }

    fn directory() -> PathBuf {
        let directory = std::env::temp_dir().join(format!(
            "sugrid-backup-schedule-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir(&directory).unwrap();
        directory
    }

    fn manifest(directory: &Path, names: &[(&str, bool)]) {
        let entries = names
            .iter()
            .map(|(name, verified)| {
                let path = directory.join(name);
                create_inventory_backup(&path);
                let metadata = fs::metadata(&path).unwrap();
                let modified_at = metadata
                    .modified()
                    .unwrap()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_secs();
                let bytes = fs::read(&path).unwrap();
                serde_json::json!({
                    "name": name,
                    "verified": verified,
                    "size": metadata.len(),
                    "modifiedAt": modified_at,
                    "sha256": hex::encode(Sha256::digest(bytes))
                })
            })
            .collect::<Vec<_>>();
        write(
            directory.join("manifest.json"),
            serde_json::to_vec(&entries).unwrap(),
        )
        .unwrap();
    }

    fn create_inventory_backup(path: &Path) {
        let database = Connection::open(path).unwrap();
        database
            .execute_batch(
                "CREATE TABLE users (id INTEGER PRIMARY KEY);
                 CREATE TABLE inventory (id INTEGER PRIMARY KEY);
                 CREATE TABLE purchase_orders (id INTEGER PRIMARY KEY);",
            )
            .unwrap();
        drop(database);
    }

    #[test]
    fn due_after_two_am_in_beijing_and_catches_up_after_restart() {
        let directory = directory();
        let before = ms(2026, 11, 27, 1);
        let after = ms(2026, 11, 27, 3);
        assert_eq!(due_label(&directory, before).unwrap(), None);
        assert_eq!(
            due_label(&directory, after).unwrap(),
            Some("auto-20261127".into())
        );
        manifest(&directory, &[("inventory.auto-20261127-100.db", true)]);
        assert_eq!(due_label(&directory, after).unwrap(), None);
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn invalid_or_unverified_backups_do_not_suppress_daily_work() {
        let directory = directory();
        manifest(
            &directory,
            &[
                ("inventory.auto-20261127-100.db", false),
                ("inventory.auto-20261126-90.db", true),
            ],
        );
        assert!(
            due_label(&directory, ms(2026, 11, 27, 3))
                .unwrap()
                .is_some()
        );
        assert!(parse_auto_backup("inventory.auto-20260230-1.db").is_none());
        assert!(parse_auto_backup("inventory.auto-20261127-1.db-wal").is_none());
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn latest_automatic_backup_comes_from_verified_manifest_not_operation_history() {
        let directory = directory();
        let names = [
            ("inventory.auto-20261125-100.db", true),
            ("inventory.auto-20261126-110.db", true),
            ("inventory.auto-20261127-120.db", false),
            ("inventory.manual-130.db", true),
        ];
        manifest(&directory, &names);
        let entries: Vec<ManifestEntry> =
            serde_json::from_slice(&fs::read(directory.join("manifest.json")).unwrap()).unwrap();
        let expected = entries
            .iter()
            .filter(|entry| {
                entry.verified
                    && parse_auto_backup(&entry.name).is_some()
                    && entry.name.contains("20261126")
            })
            .map(|entry| entry.modified_at)
            .max();
        assert_eq!(latest_recorded_auto_backup_at(&directory), expected);
        assert_eq!(latest_verified_auto_backup_at(&directory), expected);
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn legacy_manifest_without_digest_is_a_record_not_a_verified_backup() {
        let directory = directory();
        let name = "inventory.auto-20261127-100.db";
        manifest(&directory, &[(name, true)]);
        let manifest_path = directory.join("manifest.json");
        let mut entries: Vec<serde_json::Value> =
            serde_json::from_slice(&fs::read(&manifest_path).unwrap()).unwrap();
        entries[0].as_object_mut().unwrap().remove("sha256");
        fs::write(&manifest_path, serde_json::to_vec(&entries).unwrap()).unwrap();

        assert!(latest_recorded_auto_backup_at(&directory).is_some());
        assert_eq!(latest_verified_auto_backup_at(&directory), None);
        assert_eq!(
            due_label(&directory, ms(2026, 11, 27, 3)).unwrap(),
            Some("auto-20261127".into())
        );
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn changed_or_corrupt_backup_does_not_suppress_daily_backup() {
        let directory = directory();
        let name = "inventory.auto-20261127-100.db";
        manifest(&directory, &[(name, true)]);
        let backup_path = directory.join(name);
        let size = fs::metadata(&backup_path).unwrap().len() as usize;
        fs::write(&backup_path, vec![0u8; size]).unwrap();
        let after = ms(2026, 11, 27, 3);
        assert_eq!(
            due_label(&directory, after).unwrap(),
            Some("auto-20261127".into())
        );
        assert_eq!(latest_verified_auto_backup_at(&directory), None);

        let metadata = fs::metadata(&backup_path).unwrap();
        let modified_at = metadata
            .modified()
            .unwrap()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs();
        let bytes = fs::read(&backup_path).unwrap();
        let entries = vec![serde_json::json!({
            "name": name,
            "verified": true,
            "size": metadata.len(),
            "modifiedAt": modified_at,
            "sha256": hex::encode(Sha256::digest(bytes))
        })];
        fs::write(
            directory.join("manifest.json"),
            serde_json::to_vec(&entries).unwrap(),
        )
        .unwrap();
        assert_eq!(
            due_label(&directory, after).unwrap(),
            Some("auto-20261127".into())
        );
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn equal_size_valid_sqlite_with_old_timestamp_still_fails_manifest_hash() {
        let directory = directory();
        let name = "inventory.auto-20261127-101.db";
        manifest(&directory, &[(name, true)]);
        let path = directory.join(name);
        let original = fs::metadata(&path).unwrap();
        let original_size = original.len();
        let original_time = original.modified().unwrap();
        assert!(latest_verified_auto_backup_at(&directory).is_some());

        let database = Connection::open(&path).unwrap();
        database
            .execute("INSERT INTO users(id) VALUES(1)", [])
            .unwrap();
        drop(database);
        assert_eq!(fs::metadata(&path).unwrap().len(), original_size);
        fs::File::options()
            .write(true)
            .open(&path)
            .unwrap()
            .set_times(fs::FileTimes::new().set_modified(original_time))
            .unwrap();

        assert_eq!(latest_verified_auto_backup_at(&directory), None);
        // The dashboard only reports the last manifest record. The scheduler
        // still performs the full content check before skipping a backup.
        assert_eq!(
            latest_recorded_auto_backup_at(&directory),
            Some(
                original_time
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_secs()
            )
        );
        assert_eq!(
            due_label(&directory, ms(2026, 11, 27, 3)).unwrap(),
            Some("auto-20261127".into())
        );
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn retention_keeps_calendar_generations_and_never_touches_manual_copies() {
        let directory = directory();
        let names = [
            ("inventory.auto-20261127-120.db", true),
            ("inventory.auto-20261127-119.db", true),
            ("inventory.auto-20261126-110.db", true),
            ("inventory.auto-20261120-100.db", true),
            ("inventory.auto-20261113-90.db", true),
            ("inventory.auto-20261106-80.db", true),
            ("inventory.auto-20261030-70.db", true),
            ("inventory.auto-20261001-60.db", true),
            ("inventory.auto-20260901-50.db", true),
            ("inventory.auto-20260801-40.db", true),
            ("inventory.auto-20260701-30.db", true),
            ("inventory.manual-29.db", true),
            ("inventory.before-update-20.db", true),
            ("inventory.auto-20260702-31.db", false),
        ];
        manifest(&directory, &names);
        let deleted = pruning_candidates(&directory, ms(2026, 11, 27, 3)).unwrap();
        let deleted_names = deleted
            .iter()
            .map(|candidate| {
                candidate
                    .path
                    .file_name()
                    .unwrap()
                    .to_string_lossy()
                    .into_owned()
            })
            .collect::<HashSet<_>>();
        assert!(deleted_names.contains("inventory.auto-20261127-119.db"));
        assert!(deleted_names.contains("inventory.auto-20260701-30.db"));
        assert!(!deleted_names.contains("inventory.manual-29.db"));
        assert!(!deleted_names.contains("inventory.before-update-20.db"));
        assert!(!deleted_names.contains("inventory.auto-20260702-31.db"));
        assert!(!deleted_names.contains("inventory.auto-20261120-100.db"));
        assert!(!deleted_names.contains("inventory.auto-20261030-70.db"));
        assert!(deleted_names.contains("inventory.auto-20261001-60.db"));
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn next_check_has_a_bounded_sleep() {
        assert_eq!(next_check_delay(ms(2026, 11, 27, 1)).as_secs(), 60 * 60);
        assert_eq!(next_check_delay(ms(2026, 11, 27, 2)).as_secs(), 60 * 60);
        assert_eq!(retry_check_delay().as_secs(), 15 * 60);
    }
}
