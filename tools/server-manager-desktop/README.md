# SUGRID Server Manager

Windows desktop manager using Tauri 2, React, TypeScript, Vite, Fluent UI, and Lucide.

The packaged desktop app is the integrated deployment for the SUGRID inventory service. It starts and stops the dedicated `SUGRIDInventory` Windows service through the Service Control Manager; it does not scan or terminate arbitrary Node processes. The browser preview remains a mock-only UI and never controls local services.

## Preview

Run `npm ci`, then `npm run dev`. The Vite preview uses port 3007 and does not control local services.

## Windows Installer

On a Windows build machine with Rust and Microsoft C++ Build Tools installed, run:

```powershell
npm ci
npm run desktop:build
```

The NSIS installer is written to `src-tauri/target/release/bundle/nsis/`. Copy the installer to the Windows server and run it there; the server does not need Rust, Cargo, Node.js, or C++ Build Tools. WebView2 is installed by the setup bootstrapper when needed.

The installer includes the production inventory server and its Node runtime. It registers `SUGRIDInventory` as an automatic Windows service on fixed port `3000`, migrates an existing database when the previous manager configuration identifies one, and keeps the live database outside the installation folder at `%ProgramData%\SUGRID\Inventory\data\inventory.db`. Database backups are stored in `%ProgramData%\SUGRID\Inventory\backups`; logs are stored in `%ProgramData%\SUGRID\Inventory\logs`.

After installation, open the manager and use the integrated pages to check service health, create or restore a backup, and install a newer GitHub Release installer. The manager does not require a project directory or a Git checkout on the server. A failed install or restore keeps the previous runtime/database in place and reports the recovery path.

The legacy browser-based project manager and its `.cmd` launch entry remain available as a fallback. They are not used by the integrated installer.

## Checks

- npm run lint
- npm run typecheck
- npm test
- npm run build

Native Tauri development and NSIS packaging require Rust and Microsoft C++ Build Tools on Windows.
