# SUGRID Server Manager

Windows desktop manager using Tauri 2, React, TypeScript, Vite, Fluent UI, and Lucide.

The browser preview uses mock data. The packaged Tauri desktop app connects to the configured local inventory project and provides process scanning and control, database backups and restore, Git updates, and diagnostics.

## Preview

Run `npm ci`, then `npm run dev`. The Vite preview uses port 3007 and does not control local services.

## Windows Installer

On a Windows build machine with Rust and Microsoft C++ Build Tools installed, run:

```powershell
npm ci
npm run desktop:build
```

The NSIS installer is written to `src-tauri/target/release/bundle/nsis/`. Copy the installer to the server and run it there; the server does not need Rust or C++ Build Tools. WebView2 is installed by the setup bootstrapper when needed.

On first launch, configure the inventory project directory, port, and the exact database file used by the existing service. The installer packages the manager only; it does not include the inventory web app or its database.

## Checks

- npm run lint
- npm run typecheck
- npm test
- npm run build

Native Tauri development and NSIS packaging require Rust and Microsoft C++ Build Tools on Windows.
