# Independent Inventory Release

The repository has two release streams. `manager-vX.Y.Z` releases update the Windows manager and service host. `inventory-vX.Y.Z` releases contain only the inventory web runtime. Publishing source code or a candidate artifact does not update a server.

## Candidate and publication

- Every push to `main` runs `inventory-candidate` on Windows. It checks lint, TypeScript, packaging tests, and the isolated Next.js build. It then initializes a temporary SQLite database, starts the packaged runtime on a temporary local port, and checks `/api/health`, `/login`, and the referenced JavaScript and CSS assets before uploading `inventory-candidate-<40-character-commit-SHA>` for 30 days. The artifact contains `candidate.json` and `inventory/`; it is not signed and must not be installed by the manager.
- A maintainer starts `inventory-release` from `main` with the successful candidate run ID and an unused `X.Y.Z` version. The workflow confirms the run succeeded for this repository's `main` branch, downloads its exact candidate, verifies every file against `candidate.json`, signs the manifest, and publishes an `inventory-vX.Y.Z` Release. GitHub Actions environment `inventory-release` must have required reviewers, prevent bypass, and allow deployments only from `main` before its secret is configured.
- A candidate older than 30 days must be rebuilt from the intended commit and rechecked before publication. Do not copy a candidate directly into a server installation.

## Signed ZIP format v1

The published asset is `sugrid-inventory-windows-x64.zip`. Its root contains only `manifest.json`, `manifest.sig`, and ordinary files under `inventory/`. There are no explicit directory entries, links, extra files, or SQLite database files. `manifest.json` is UTF-8 JSON with `formatVersion=1`, `product=sugrid-inventory`, semantic `version`, 40-character `commitSha`, `platform=windows-x64`, `minUpdaterProtocol=2`, `databaseSchemaVersion`, `minSupportedDatabaseSchemaVersion`, and a bytewise sorted `files` array. The current minimum supported database version is `0`, which allows the packaged migration runner to upgrade legacy databases that predate the versioned migration table. Each file record has a relative `path`, byte `size`, and lowercase SHA-256 hex digest. `manifest.sig` contains base64 of a 64-byte Ed25519 signature over the **exact bytes** of `manifest.json`, including its final newline. The verifier must not reserialize JSON before checking the signature.

The runtime carries Next.js standalone output, `public`, `.next/static`, Node for Windows x64, and database initializer scripts. Build-time data lives in an isolated temporary SQLite database. No working or production database belongs in a candidate or release.

## Installation safeguards

The updater reads the current database migration version before installation. It rejects a release when the database is older than the signed minimum supported version or newer than the signed target version. A legacy database without `schema_migrations` is treated as version `0`. The updater also checks available disk space for the package, database copies, and working space.

Before switching files, the updater creates a verified backup of the current database and runs the packaged migration against a separate copy. It requires the migrated copy to match the signed target version. It then switches the runtime and database and checks the new service's reported version. If the switch fails, the updater attempts to restore the previous runtime and database; a failed recovery leaves the service stopped for investigation. An inventory update can briefly interrupt access on port `3000`.

## Database maintenance

The installed manager's **数据库与备份** page shows the database path, an on-demand read-only SQLite integrity and foreign-key check, the backup schedule, verified backup files, and recent maintenance activity. The authorized Windows maintenance account or an administrator can request backups, restores, and exports through the local updater service. A restore requires confirmation and saves the current database first. Export checks the backup against its recorded size and modification time and runs SQLite integrity and foreign-key checks. If the manifest records a SHA-256 digest, the source must also match it. For an older manifest without a digest, the updater computes one from the checked source and verifies the exported copy against that value; this does not verify the source against a historical digest. Copy the exported backup to separate storage according to the site's retention policy.

The updater schedules an automatic backup at **02:00 Asia/Shanghai** each day. After a service restart, it creates a missing backup for that Beijing calendar day when the scheduled time has passed. An existing automatic backup suppresses another attempt only if its manifest entry and file pass verification. Automatic retention keeps one backup for each of the latest seven calendar days, one for each of the previous four completed weeks, and one for each of the previous three completed months; a newer daily copy can also fill a weekly or monthly slot. Manual and before-update/restore backups are not removed by this automatic policy. A backup operation or cleanup error is recorded for investigation rather than silently treated as success.

The updater stores up to 50 maintenance events, including failed and interrupted operations. If its history cannot be read or written, further maintenance is paused until the history can be recovered. Do not delete the history file to bypass that guard.

## Signing setup

Production publishing is intentionally disabled until an Ed25519 key pair is provisioned. Store the PKCS#8 DER private key as base64 in the protected `inventory-release` environment secret `SUGRID_INVENTORY_SIGNING_KEY_PKCS8_B64`. Store the corresponding 32-byte raw public key as lowercase hex in the environment variable `SUGRID_INVENTORY_VERIFY_KEY_HEX` and embed that same public key in the manager/updater build. Neither key may be inferred from a ZIP asset. A missing key, malformed key, or public/private mismatch makes the release workflow fail before it creates a GitHub Release. Do not put a production private key in Git, a workflow artifact, a log, or the server. Disposable local QA keys must be identified as test-only and must not become a production trust root.

The manager accepts signed inventory releases and signed offline imports using the same public key. Manager installer updates use their separate release path.

## Manager release

Start `manager-release` manually from `main` with a fully specified, approved commit SHA in `main` history and an unused `X.Y.Z` version. The version must match both `tools/server-manager-desktop/src-tauri/tauri.conf.json` and `src-tauri/Cargo.toml`. The Windows job runs manager frontend lint, TypeScript and tests, Rust tests, then builds the NSIS installer and publishes it as `SUGRID-Server-Manager-Setup.exe` under `manager-vX.Y.Z`. The installer contains the manager, service host and updater, not the inventory website. No GitHub release is created by a source push alone.

Configure a separate protected GitHub Actions environment named `manager-release` with required reviewers, prevent bypass, and deployment branches restricted to `main`. Its `SUGRID_INVENTORY_VERIFY_KEY_HEX` environment variable must be the **same production public key** used by `inventory-release`; the job refuses to build without it. Do not use a disposable QA key for the published manager. The inventory signing private key is never available to the manager build.

## Acceptance boundary

The candidate smoke test uses an isolated temporary database and does not exercise the NSIS installer or a live Windows server upgrade. Before the first production rollout, test a fresh manager install, an upgrade over an existing installation, signed online and offline inventory installation, backup export and restore, a failed update with rollback, and the maintenance account's permissions on a separate Windows machine or snapshot. Confirm the inventory service and data after each path. The current code-level and packaged-runtime checks do not by themselves establish that this end-to-end Windows installation has passed.
