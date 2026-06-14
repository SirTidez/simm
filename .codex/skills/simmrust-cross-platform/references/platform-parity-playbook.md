# SIMM Platform Parity Playbook

## Purpose

Use this reference to keep Windows and Linux behavior moving together in SIMM. The app is a Tauri 2 desktop application with a React/TypeScript frontend and Rust backend, so platform differences can appear in UI copy, IPC contracts, Rust services, package metadata, and release artifacts.

## High-Risk Platform Surfaces

- `src-tauri/src/services/filesystem.rs`: executable discovery, launch paths, process inspection, Steam integration, path handling.
- `src-tauri/src/services/melon_loader.rs`: Windows prerequisites, Linux Protontricks prerequisites, launch options, live Linux smoke tests.
- `src-tauri/src/services/linux_readiness.rs`: Linux desktop integration, handlers, managed tooling readiness.
- `src-tauri/src/services/security_scanner.rs`: Linux managed .NET SDK/tool bootstrap and scanner execution.
- `src-tauri/src/services/depot_downloader.rs`: platform-specific DepotDownloader asset selection and execution.
- `src-tauri/src/commands/app_init.rs`: readiness/status commands surfaced to the frontend.
- `src/components/Settings.tsx` and tests: platform readiness UI, repair actions, settings platform selection.
- `src/services/api.ts`, `src/services/events.ts`, and `src/types/index.ts`: cross-platform command and DTO contracts.
- `src-tauri/tauri.conf.json`: bundle targets, deep-link schemes, updater endpoints, Linux bundle config, Windows NSIS config.
- `src-tauri/capabilities/*.json`: Tauri permission scope for shell, fs, updater, dialog, deep-link, and process APIs.
- `scripts/validate-linux-desktop-mime.sh`: Linux package desktop handler validation.
- `scripts/build-linux-container.ps1` and `docker/linux/*`: Ubuntu Linux packaging environment.
- `scripts/generate-updater-manifest.ps1`, `src-tauri/windows/*`, and updater files: Windows installer/updater surfaces.

## Design Checklist

Ask these before editing:

1. Does this behavior differ by OS, runtime, package format, shell, filesystem, or installed game/tool location?
2. Which layer owns the platform decision: frontend display, `ApiService`, Tauri command, Rust service, package config, or installer script?
3. Is there an existing centralized helper for platform detection, path resolution, tool discovery, or desktop integration?
4. What is the counterpart behavior on the other platform, and should it change too?
5. Are tests using representative Windows and Linux fixtures, or only the current host platform?

## Implementation Rules

- Prefer Rust services for authoritative platform behavior. The frontend should display status and intent, not reimplement platform rules.
- Prefer typed DTOs for platform-specific readiness output. Keep Rust structs and TypeScript interfaces synchronized.
- Keep shell command construction explicit and platform-scoped. Avoid passing Windows commands through Linux assumptions or Linux shell snippets through Windows assumptions.
- Keep path normalization conservative. Do not convert separators in a way that changes meaning for Proton, Steam, or Windows install paths.
- Use compile-time `cfg` where code truly cannot compile on the other OS; use runtime platform checks where the same binary needs to reason about configured target platform.
- Keep tests resilient on non-host platforms by testing parsers, path transforms, DTO shape, and fixture data without requiring live Steam/Proton/account state.
- Gate live platform checks behind ignored tests or explicit environment variables, as existing live tests do.

## Validation Matrix

Frontend-only platform UI:

```powershell
bun install
bunx tsc --noEmit
bun run lint
bun run test
bun run build
```

Rust service or IPC/platform contract:

```powershell
bun install
bunx tsc --noEmit
bun run lint
bun run test
bun run build
cargo check --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml
```

Linux package or desktop integration:

```powershell
.\scripts\build-linux-container.cmd
```

Linux iteration without full package build:

```powershell
.\scripts\build-linux-container.cmd -Command check
```

Linux artifacts after a full Docker build:

```text
E:\CLionProjects\simmrust\target\release\bundle\deb\*.deb
E:\CLionProjects\simmrust\target\release\bundle\appimage\*.AppImage
```

Linux package handler validation:

```bash
bash scripts/validate-linux-desktop-mime.sh target/release/bundle/deb/*.deb
bash scripts/validate-linux-desktop-mime.sh target/release/bundle/appimage/*.AppImage
```

Windows release or updater work:

```powershell
bun install
bunx tsc --noEmit
bun run lint
bun run test
bun run build
cargo check --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml
```

Then follow `$simmrust-release-updater` for NSIS/updater artifact-specific checks.

## Final Response Requirements

When closing cross-platform work, include:

- what changed on Windows
- what changed on Linux
- what was intentionally unchanged on either platform
- which validation commands passed, failed, or were skipped
- where any generated artifacts are located
