# Design QA

## Preview

- URL: `http://127.0.0.1:3007/`
- Environment: local interactive sample with mock data only
- Desktop render: 1440 x 1024 Chromium screenshot; also inspected in the Codex in-app browser
- Narrow render: 390 x 844 Chromium screenshot

## Checked

- Main navigation opens overview, project services, Git update, database, logs and diagnostics, and settings.
- Git update confirmation explains the target branch, database backup, and service interruption before the demo starts.
- Build-failure path leaves service startup and health checks unexecuted and shows the backup location and failure log.
- Success path completes all nine steps and shows a passing health check.
- Candidate project process shows its path, port, PID, start time, and command; stopping it is disabled while its identity is unverified.
- Change and failure-log drawers open and close. Error-only log filtering returns an empty state when there are no errors.
- At 390 px, the navigation remains horizontally scrollable and the update summary becomes a two-column layout without overlapping content.
- The preview responds with HTTP 200 and serves the expected application title and root element.

## Automated checks

- `npm run lint`
- `npm run typecheck`
- `npm test` (4 tests passed)
- `npm run build`
- `npm run test:sites` (4 tests passed)

## Limits

- The Tauri desktop binary was not built because Rust/Cargo and MSVC C++ Build Tools are unavailable in this environment.
- All UI actions remain simulated. The sample does not inspect or change local processes, Git state, database files, or configuration files.
