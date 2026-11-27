# SUGRID Server Manager

Windows desktop manager using Tauri 2, React, TypeScript, Vite, Fluent UI, and Lucide.

The desktop manager and inventory website are separate products in one repository. The manager installs the UI, the `SUGRIDInventory` service host, and the `SUGRIDInventoryUpdater` maintenance service. The inventory website is distributed as a separately signed `inventory-vX.Y.Z` package. The server does not need a Git checkout, Node.js installation, Rust, or build tools. The browser preview remains a mock-only UI and never controls local services.

## Preview

Run `npm ci`, then `npm run dev`. The Vite preview uses port 3007 and does not control local services.

## Windows Installer

On a Windows build machine with Rust and Microsoft C++ Build Tools installed, run:

```powershell
npm ci
npm run desktop:build
```

The NSIS installer is written to `src-tauri/target/release/bundle/nsis/`. Copy the installer to the Windows server and run it there; the server does not need Rust, Cargo, Node.js, or C++ Build Tools. WebView2 is installed by the setup bootstrapper when needed.

The installer does not contain the inventory website. It preserves a previous 0.1.7 inventory runtime and database during the transition. On a fresh installation, the inventory service remains stopped until a signed website package is installed. The setup asks for the Windows account that may perform inventory maintenance; enter the actual account that will run the manager, including on Remote Desktop. Administrators may also perform maintenance. Updating the manager installer still requires UAC, while this selected account can update the inventory website through the dedicated service without repeated UAC prompts.

For an unattended first install, pass `/S` and `/OPERATOR=<Windows-account-or-SID>` to the NSIS setup. The account is mandatory when there is no saved operator list; setup checks it before replacing installed files. An existing operator list is retained during an upgrade.

On first launch, the manager checks and prefetches the latest approved `inventory-vX.Y.Z` GitHub Release. The selected maintenance account can install it or import the same signed ZIP offline. The broker checks the Ed25519 signature and file hashes again in a protected staging directory, backs up SQLite, migrates an isolated database copy, switches the runtime, and checks the health version. An interrupted switch is recovered before further maintenance. A manager update uses a separate `manager-vX.Y.Z` installer.

The website runs on port `3000`. Its database remains at `%ProgramData%\SUGRID\Inventory\data\inventory.db`; backups and logs stay under the same `Inventory` directory. Installing or uninstalling the manager does not delete the website database. The manager accepts only fixed local maintenance operations and does not expose the former project-directory Git updater in the installed application.

## Operating the installed manager

Use **库存服务** to inspect the Windows service and open the local website. **版本更新** installs a signed `inventory-vX.Y.Z` release or imports its signed ZIP; updating the manager itself uses a separate installer. The updater checks package authenticity, database schema compatibility, and free disk space before it changes the installation. It backs up the database, migrates a copy, switches the runtime and database, and checks the health version. The website may be briefly unavailable during the switch. If recovery cannot finish after a failed update, leave the service stopped and inspect the maintenance record before retrying.

Use **数据库与备份** to run an on-demand SQLite integrity and foreign-key check, create a backup, export a verified backup, or restore one after confirming the data-loss prompt. Export rechecks the selected backup's recorded size and modification time and its SQLite integrity. A recorded SHA-256 must match; for an older manifest without one, the updater computes a digest from the checked source and verifies the exported copy against it. The service runs a daily automatic backup at **02:00 Asia/Shanghai** and catches up after a restart if that day's verified backup is missing. Automatic backups retain the latest seven daily, four completed weekly, and three completed monthly generations; manual and before-update/restore backups remain outside automatic pruning. The page also shows the backup schedule and recent maintenance history. If history recording fails, maintenance is paused until the error is resolved.

Keep an exported copy of a verified backup outside the server before a major rollout. The manager's built-in backup directory is `%ProgramData%\SUGRID\Inventory\backups`; the current database is `%ProgramData%\SUGRID\Inventory\data\inventory.db`. Do not copy a live SQLite database file in place of the manager's backup or export action.

The updater handles one named-pipe request at a time. During a long database check or backup export, another open manager window may briefly report an updater-status timeout; the window performing the operation pauses its own status polling. Wait for the operation to finish, then refresh the other window. If the timeout continues, inspect the updater service and maintenance logs before retrying.

Production manager builds must embed `SUGRID_INVENTORY_VERIFY_KEY_HEX`, the public key corresponding to the protected inventory release signing key. If it is missing, inventory package installation fails closed. See [the release procedure](../../docs/inventory-release.md) for the separate candidate, inventory, and manager workflows. Local disposable QA keys must never be used for production releases.

The legacy browser-based project manager and its `.cmd` launch entry remain available as a fallback. They are not used by the integrated installer.

## Checks

- npm run lint
- npm run typecheck
- npm test
- npm run build

Native Tauri development and NSIS packaging require Rust and Microsoft C++ Build Tools on Windows.

The packaged candidate smoke test uses a temporary database and port. A successful local build does not validate the actual Windows installer, maintenance-account ACLs, or update and rollback on the target server. Complete those checks on a separate Windows installation before production deployment.
