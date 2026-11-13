# Windows Service Installer Troubleshooting

## Confirmed ProgramData Permission Failure

Several installer attempts returned the same generic exit code, but failed at different steps: service startup and recovery, SQLite backup, and data ACL repair. The shared failure class was access to `%ProgramData%\SUGRID\Inventory`; the exit code alone did not identify a single root cause.

The development machine's existing `data\inventory.db` had a protected DACL with no allow entries. SQLite returned `SQLITE_CANTOPEN` with Windows error 5 when opening it, even though the parent directory was readable by an elevated administrator. This prevented the installer from producing a verified online backup.

## Current Installer Behavior

- ACL repair is limited to `%ProgramData%\SUGRID\Inventory` and its managed `data`, `backups`, `logs`, `app`, and `inventory` directories.
- Before changing ACLs, the installer saves an `icacls` snapshot. If repair is needed, it takes ownership only of the SUGRID Inventory subtree, reapplies the ACL policy, and checks both ACL validity and actual directory write access.
- Existing database files are opened as part of permission verification before backup or migration. Installation stops before those steps if access still fails.
- A verified SQLite online backup is created before runtime replacement. Failed permission or service-host steps write a sanitized diagnostic with the operation name and available Windows/command error codes. If ProgramData is not writable, diagnostics fall back to `%TEMP%`.
- Old diagnostic cleanup is best effort before ACL repair and is retried after ACL repair. A locked or restricted stale diagnostic does not block permission repair; remaining cleanup failures are written to the service log.

## Verified Recovery

On 2026-11-13, version 0.1.7 was built and installed on the development machine. All 26 Windows service-host tests passed with administrator privileges. The `SUGRIDInventory` service is configured for automatic startup and reports healthy on port 3000; the login page loaded in the existing browser tab. The installed database returned `integrity_check=ok` and zero `foreign_key_check` violations. The project working database SHA-256 remained equal to the pre-build incident snapshot.

The 0.1.7 NSIS installer is at `tools/server-manager-desktop/src-tauri/target/release/bundle/nsis/SUGRID Server Manager_0.1.7_x64-setup.exe`. Build-time Next.js output uses a temporary SQLite database; it must not initialize the project database.
