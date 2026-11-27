use std::{
    collections::{BTreeMap, HashSet},
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
};

use base64::Engine;
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use zip::{CompressionMethod, ZipArchive};

pub const UPDATER_PROTOCOL: u32 = 2;
const MAX_PACKAGE_BYTES: u64 = 1024 * 1024 * 1024;
const MAX_MANIFEST_BYTES: u64 = 1024 * 1024;
const MAX_ENTRY_COUNT: usize = 50_000;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReleaseFile {
    pub path: String,
    pub size: u64,
    pub sha256: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReleaseManifest {
    pub format_version: u32,
    pub product: String,
    pub version: String,
    pub commit_sha: String,
    pub platform: String,
    pub min_updater_protocol: u32,
    pub database_schema_version: u32,
    pub min_supported_database_schema_version: u32,
    pub files: Vec<ReleaseFile>,
}

pub struct VerifiedPackage {
    pub manifest: ReleaseManifest,
    pub package_sha256: String,
    pub runtime: PathBuf,
}

fn package_path_valid(path: &str) -> bool {
    if !path.starts_with("inventory/")
        || path.contains(['\\', ':', '<', '>', '"', '|', '?', '*'])
        || path.chars().any(char::is_control)
    {
        return false;
    }
    let lower = path.to_ascii_lowercase();
    if lower == "inventory/data"
        || lower.starts_with("inventory/data/")
        || lower == "inventory/backups"
        || lower.starts_with("inventory/backups/")
        || lower.rsplit('/').next().is_some_and(|name| {
            [".db", ".db-wal", ".db-shm", ".sqlite", ".sqlite3"]
                .iter()
                .any(|extension| name.ends_with(extension))
        })
    {
        return false;
    }
    path.split('/').all(|segment| {
        if segment.is_empty()
            || segment == "."
            || segment == ".."
            || segment.ends_with(['.', ' '])
            || segment.eq_ignore_ascii_case(".env")
            || segment.to_ascii_lowercase().starts_with(".env.")
        {
            return false;
        }
        let base = segment.split('.').next().unwrap_or("").to_ascii_uppercase();
        if matches!(base.as_str(), "CON" | "PRN" | "AUX" | "NUL") {
            return false;
        }
        let mut chars = base.chars();
        let prefix = chars.by_ref().take(3).collect::<String>();
        !((prefix == "COM" || prefix == "LPT")
            && chars.next().is_some_and(|digit| {
                matches!(digit, '1'..='9' | '¹' | '²' | '³') && chars.next().is_none()
            }))
    })
}

fn fixed_lower_hex(value: &str, len: usize) -> bool {
    value.len() == len
        && value
            .bytes()
            .all(|ch| ch.is_ascii_digit() || (b'a'..=b'f').contains(&ch))
}

fn validate_manifest(manifest: &ReleaseManifest) -> Result<(), String> {
    if manifest.format_version != 1
        || manifest.product != "sugrid-inventory"
        || manifest.platform != "windows-x64"
    {
        return Err("The package format, product, or platform is unsupported.".into());
    }
    if manifest.min_updater_protocol > UPDATER_PROTOCOL {
        return Err("The package requires a newer updater.".into());
    }
    if manifest.database_schema_version == 0
        || manifest.database_schema_version > 1_000_000
        || manifest.min_supported_database_schema_version > manifest.database_schema_version
    {
        return Err("The package database migration range is invalid.".into());
    }
    semver::Version::parse(&manifest.version).map_err(|_| "Invalid inventory package version.")?;
    if !fixed_lower_hex(&manifest.commit_sha, 40) {
        return Err("Invalid package commit SHA.".into());
    }
    if manifest.files.is_empty() || manifest.files.len() > MAX_ENTRY_COUNT {
        return Err("The package file list is invalid.".into());
    }
    let mut previous: Option<&str> = None;
    let mut total = 0u64;
    for file in &manifest.files {
        if !package_path_valid(&file.path) || !fixed_lower_hex(&file.sha256, 64) {
            return Err("The package contains an invalid file path or digest.".into());
        }
        if previous.is_some_and(|path| path >= file.path.as_str()) {
            return Err("The package files are not sorted or contain duplicates.".into());
        }
        previous = Some(&file.path);
        total = total
            .checked_add(file.size)
            .ok_or("The package is too large.")?;
        if total > MAX_PACKAGE_BYTES {
            return Err("The package is too large.".into());
        }
    }
    for required in [
        "inventory/server.js",
        "inventory/node.exe",
        "inventory/scripts/init-db.js",
    ] {
        if !manifest.files.iter().any(|entry| entry.path == required) {
            return Err(format!("The package is missing {required}."));
        }
    }
    Ok(())
}

fn read_limited<R: Read>(reader: &mut R, limit: u64) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    reader
        .take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| error.to_string())?;
    if bytes.len() as u64 > limit {
        return Err("A package metadata entry exceeds its size limit.".into());
    }
    Ok(bytes)
}

fn verify_signature(
    manifest_bytes: &[u8],
    signature_bytes: &[u8],
    public_key_hex: &str,
) -> Result<(), String> {
    let public_key =
        hex::decode(public_key_hex).map_err(|_| "The updater has no valid release public key.")?;
    let public_key: [u8; 32] = public_key
        .try_into()
        .map_err(|_| "The updater has no valid release public key.")?;
    let key = VerifyingKey::from_bytes(&public_key)
        .map_err(|_| "The updater has no valid release public key.")?;
    let signature_text =
        std::str::from_utf8(signature_bytes).map_err(|_| "Package signature is invalid.")?;
    if signature_text.contains(['\r', '\n']) {
        return Err("Package signature is invalid.".into());
    }
    let decoded = base64::engine::general_purpose::STANDARD
        .decode(signature_text)
        .map_err(|_| "Package signature is invalid.")?;
    let decoded: [u8; 64] = decoded
        .try_into()
        .map_err(|_| "Package signature is invalid.")?;
    key.verify(manifest_bytes, &Signature::from_bytes(&decoded))
        .map_err(|_| "The package signature does not match its manifest.".into())
}

fn sha256_file(path: &Path) -> Result<String, String> {
    let mut input = File::open(path).map_err(|error| error.to_string())?;
    let mut hasher = Sha256::new();
    std::io::copy(&mut input, &mut hasher).map_err(|error| error.to_string())?;
    Ok(hex::encode(hasher.finalize()))
}

pub fn verify_and_extract(
    package: &Path,
    destination: &Path,
    public_key_hex: &str,
) -> Result<VerifiedPackage, String> {
    if destination.exists() {
        return Err("The package staging directory already exists.".into());
    }
    let package_metadata =
        fs::metadata(package).map_err(|error| format!("Cannot read inventory package: {error}"))?;
    if package_metadata.len() == 0 || package_metadata.len() > MAX_PACKAGE_BYTES {
        return Err("The package size is outside the allowed range.".into());
    }
    let package_sha256 = sha256_file(package)?;
    let mut archive = ZipArchive::new(File::open(package).map_err(|error| error.to_string())?)
        .map_err(|error| format!("Invalid inventory ZIP: {error}"))?;
    if archive.len() < 5 || archive.len() > MAX_ENTRY_COUNT + 2 {
        return Err("Unexpected number of files in inventory package.".into());
    }
    let mut names = HashSet::new();
    for index in 0..archive.len() {
        let entry = archive.by_index(index).map_err(|error| error.to_string())?;
        let name = entry.name();
        if !names.insert(name.to_owned())
            || entry.is_dir()
            || (name != "manifest.json" && name != "manifest.sig" && !package_path_valid(name))
        {
            return Err("The package contains an unexpected, duplicate, or unsafe entry.".into());
        }
        if entry.compression() != CompressionMethod::Stored || entry.size() > MAX_PACKAGE_BYTES {
            return Err("The package contains an unsupported entry.".into());
        }
        if entry
            .unix_mode()
            .is_some_and(|mode| mode & 0o170000 != 0 && mode & 0o170000 != 0o100000)
        {
            return Err("The package contains a symbolic link or non-file entry.".into());
        }
    }
    let manifest_bytes = read_limited(
        &mut archive
            .by_name("manifest.json")
            .map_err(|_| "The package manifest is missing.")?,
        MAX_MANIFEST_BYTES,
    )?;
    let signature_bytes = read_limited(
        &mut archive
            .by_name("manifest.sig")
            .map_err(|_| "The package signature is missing.")?,
        128,
    )?;
    verify_signature(&manifest_bytes, &signature_bytes, public_key_hex)?;
    let manifest: ReleaseManifest = serde_json::from_slice(&manifest_bytes)
        .map_err(|_| "The package manifest is malformed.")?;
    validate_manifest(&manifest)?;
    if names.len() != manifest.files.len() + 2 {
        return Err("The package contents differ from its signed manifest.".into());
    }
    let expected = manifest
        .files
        .iter()
        .map(|entry| (entry.path.as_str(), entry))
        .collect::<BTreeMap<_, _>>();
    if !names
        .iter()
        .filter(|name| name.starts_with("inventory/"))
        .all(|name| expected.contains_key(name.as_str()))
    {
        return Err("The package contains an unsigned file.".into());
    }
    fs::create_dir(destination)
        .map_err(|error| format!("Cannot create private staging: {error}"))?;
    let extraction: Result<(), String> = (|| {
        for file in &manifest.files {
            let target = destination.join(&file.path);
            fs::create_dir_all(target.parent().ok_or("Invalid package file path.")?)
                .map_err(|error| error.to_string())?;
            let mut source = archive
                .by_name(&file.path)
                .map_err(|_| "A signed file is missing from the package.")?;
            if source.size() != file.size {
                return Err("A package file size does not match the signed manifest.".into());
            }
            let mut output = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&target)
                .map_err(|error| error.to_string())?;
            let mut hasher = Sha256::new();
            let mut buffer = [0u8; 64 * 1024];
            let mut copied = 0u64;
            loop {
                let read = source
                    .read(&mut buffer)
                    .map_err(|error| error.to_string())?;
                if read == 0 {
                    break;
                }
                copied += read as u64;
                if copied > file.size {
                    return Err("A package file exceeds its signed size.".into());
                }
                output
                    .write_all(&buffer[..read])
                    .map_err(|error| error.to_string())?;
                hasher.update(&buffer[..read]);
            }
            output.sync_all().map_err(|error| error.to_string())?;
            if copied != file.size || hex::encode(hasher.finalize()) != file.sha256 {
                return Err("A package file failed its SHA-256 check.".into());
            }
        }
        Ok(())
    })();
    if extraction.is_err() {
        let _ = fs::remove_dir_all(destination);
    }
    extraction?;
    Ok(VerifiedPackage {
        manifest,
        package_sha256,
        runtime: destination.join("inventory"),
    })
}

pub fn embedded_public_key() -> Result<&'static str, String> {
    let key = option_env!("SUGRID_INVENTORY_VERIFY_KEY_HEX")
        .ok_or("The updater was built without a release public key.")?;
    if !fixed_lower_hex(key, 64) {
        return Err("The updater release public key is invalid.".into());
    }
    Ok(key)
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};
    use zip::{ZipWriter, write::SimpleFileOptions};

    fn create_package(root: &Path, tamper: bool, extra: bool) -> (PathBuf, String) {
        let key = SigningKey::from_bytes(&[7u8; 32]);
        let files = [
            ("inventory/node.exe", b"node".as_slice()),
            ("inventory/scripts/init-db.js", b"init".as_slice()),
            ("inventory/server.js", b"server".as_slice()),
        ];
        let manifest = ReleaseManifest {
            format_version: 1,
            product: "sugrid-inventory".into(),
            version: "1.2.3".into(),
            commit_sha: "a".repeat(40),
            platform: "windows-x64".into(),
            min_updater_protocol: 1,
            database_schema_version: 36,
            min_supported_database_schema_version: 0,
            files: files
                .iter()
                .map(|(path, bytes)| ReleaseFile {
                    path: (*path).into(),
                    size: bytes.len() as u64,
                    sha256: hex::encode(Sha256::digest(bytes)),
                })
                .collect(),
        };
        let manifest_bytes = serde_json::to_vec(&manifest).unwrap();
        let signature =
            base64::engine::general_purpose::STANDARD.encode(key.sign(&manifest_bytes).to_bytes());
        let package = root.join("test.zip");
        let mut archive = ZipWriter::new(File::create(&package).unwrap());
        let options = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
        archive.start_file("manifest.json", options).unwrap();
        archive.write_all(&manifest_bytes).unwrap();
        archive.start_file("manifest.sig", options).unwrap();
        archive.write_all(signature.as_bytes()).unwrap();
        for (path, bytes) in files {
            archive.start_file(path, options).unwrap();
            archive
                .write_all(if tamper && path == "inventory/server.js" {
                    b"tamper"
                } else {
                    bytes
                })
                .unwrap();
        }
        if extra {
            archive.start_file("inventory/extra.txt", options).unwrap();
            archive.write_all(b"extra").unwrap();
        }
        archive.finish().unwrap();
        (package, hex::encode(key.verifying_key().to_bytes()))
    }

    #[test]
    fn authentic_package_extracts_only_signed_runtime() {
        let root = std::env::temp_dir().join(format!("sugrid-package-test-{}", std::process::id()));
        fs::create_dir_all(&root).unwrap();
        let (package, key) = create_package(&root, false, false);
        let verified = verify_and_extract(&package, &root.join("stage"), &key).unwrap();
        assert_eq!(verified.manifest.version, "1.2.3");
        assert_eq!(
            fs::read(verified.runtime.join("server.js")).unwrap(),
            b"server"
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn tamper_and_unsigned_files_are_rejected() {
        let root =
            std::env::temp_dir().join(format!("sugrid-package-reject-{}", std::process::id()));
        fs::create_dir_all(&root).unwrap();
        let (package, key) = create_package(&root, true, false);
        assert!(verify_and_extract(&package, &root.join("tamper"), &key).is_err());
        let (_, key) = create_package(&root, false, true);
        assert!(verify_and_extract(&package, &root.join("extra"), &key).is_err());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn windows_aliases_and_private_database_paths_are_rejected() {
        for path in [
            "inventory/data/inventory.db",
            "inventory/backups/backup.sqlite3",
            "inventory/app/records.db-wal",
            "inventory/app/records.db-shm",
            "inventory/.env.production",
            "inventory/public/.ENV.local/secret.txt",
            "inventory/CON",
            "inventory/sub/con.txt",
            "inventory/sub/COM1.log",
            "inventory/sub/LPT¹.txt",
            "inventory/sub/file. ",
            "inventory/sub/file.",
            "inventory/sub/file ",
            "inventory/sub/has?mark.js",
            "inventory/sub/control\u{0001}.js",
        ] {
            assert!(
                !package_path_valid(path),
                "unsafe Windows path accepted: {path}"
            );
        }
        for path in [
            "inventory/server.js",
            "inventory/scripts/init-db.js",
            "inventory/.next/server/app/api/health/route.js",
            "inventory/public/valid-file.txt",
        ] {
            assert!(
                package_path_valid(path),
                "valid runtime path rejected: {path}"
            );
        }
    }

    #[test]
    fn package_requires_a_valid_signed_database_migration_range() {
        let root =
            std::env::temp_dir().join(format!("sugrid-package-schema-test-{}", std::process::id()));
        fs::create_dir_all(&root).unwrap();
        let (package, key) = create_package(&root, false, false);
        assert!(verify_and_extract(&package, &root.join("valid"), &key).is_ok());
        let _ = fs::remove_dir_all(root);

        let mut manifest = ReleaseManifest {
            format_version: 1,
            product: "sugrid-inventory".into(),
            version: "1.2.3".into(),
            commit_sha: "a".repeat(40),
            platform: "windows-x64".into(),
            min_updater_protocol: 2,
            database_schema_version: 35,
            min_supported_database_schema_version: 36,
            files: vec![],
        };
        assert!(validate_manifest(&manifest).is_err());
        manifest.min_supported_database_schema_version = 0;
        manifest.database_schema_version = 0;
        assert!(validate_manifest(&manifest).is_err());
    }
}
