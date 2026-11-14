# Independent Inventory Release

The repository has two release streams. `manager-vX.Y.Z` releases update the Windows manager and service host. `inventory-vX.Y.Z` releases contain only the inventory web runtime. Publishing source code or a candidate artifact does not update a server.

## Candidate and publication

- Every push to `main` runs `inventory-candidate` on Windows. It checks lint, TypeScript, packaging tests, and the isolated Next.js build, then uploads `inventory-candidate-<40-character-commit-SHA>` for 30 days. The artifact contains `candidate.json` and `inventory/`; it is not signed and must not be installed by the manager.
- A maintainer starts `inventory-release` manually with the successful candidate run ID and an unused `X.Y.Z` version. The workflow confirms the run succeeded for this repository's `main` branch, downloads its exact candidate, verifies every file against `candidate.json`, signs the manifest, and publishes an `inventory-vX.Y.Z` Release. GitHub Actions environment `inventory-release` must have required reviewers and prevent bypass before its secret is configured.
- A candidate older than 30 days must be rebuilt from the intended commit and rechecked before publication. Do not copy a candidate directly into a server installation.

## Signed ZIP format v1

The published asset is `sugrid-inventory-windows-x64.zip`. Its root contains only `manifest.json`, `manifest.sig`, and ordinary files under `inventory/`. There are no explicit directory entries, links, extra files, or SQLite database files. `manifest.json` is UTF-8 JSON with `formatVersion=1`, `product=sugrid-inventory`, semantic `version`, 40-character `commitSha`, `platform=windows-x64`, `minUpdaterProtocol=1`, and a bytewise sorted `files` array. Each file record has a relative `path`, byte `size`, and lowercase SHA-256 hex digest. `manifest.sig` contains base64 of a 64-byte Ed25519 signature over the **exact bytes** of `manifest.json`, including its final newline. The verifier must not reserialize JSON before checking the signature.

The runtime carries Next.js standalone output, `public`, `.next/static`, Node for Windows x64, and database initializer scripts. Build-time data lives in an isolated temporary SQLite database. No working or production database belongs in a candidate or release.

## Signing setup

Production publishing is intentionally disabled until an Ed25519 key pair is provisioned. Store the PKCS#8 DER private key as base64 in the protected `inventory-release` environment secret `SUGRID_INVENTORY_SIGNING_KEY_PKCS8_B64`. Store the corresponding 32-byte raw public key as lowercase hex in the environment variable `SUGRID_INVENTORY_VERIFY_KEY_HEX` and embed that same public key in the manager/updater build. Neither key may be inferred from a ZIP asset. A missing key, malformed key, or public/private mismatch makes the release workflow fail before it creates a GitHub Release. Do not put a production private key in Git, a workflow artifact, a log, or the server. Disposable local QA keys must be identified as test-only and must not become a production trust root.

The manager accepts signed inventory releases and signed offline imports using the same public key. Manager installer updates use their separate release path.
