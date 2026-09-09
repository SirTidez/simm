---
name: simmrust-cross-platform
description: Coordinate Windows and Linux parity work in the SIMM Tauri/React/Rust app. Use when changes touch OS-specific behavior, filesystem paths, process launching, Steam/Proton or Windows game integration, MelonLoader prerequisites, desktop/protocol handlers, packaging, installer/AppImage/deb outputs, Tauri cfg-gated code, shell commands, environment variables, native dependencies, or validation that must keep Windows and Linux behavior developed in tandem.
---

# SIMM Cross Platform

## Workflow

1. Read `AGENTS.md`, `ARCHITECTURE.md`, `package.json`, `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json`, and the likely touched files.
2. Check `git status --short` and preserve unrelated user changes.
3. Classify the platform surface before editing:
   - frontend platform UI or readiness messaging
   - Tauri/Rust `cfg` branches and command behavior
   - filesystem/process/shell integration
   - Windows installer/updater or Linux deb/AppImage packaging
   - Steam/Proton/MelonLoader/DepotDownloader/.NET tool readiness
4. Design the change as a paired Windows/Linux contract. If one platform is intentionally unaffected, state why in code review notes or the final response.
5. Route subareas to the focused SIMM skill when needed, but keep this skill responsible for parity:
   - IPC/DTO/event drift: `$simmrust-ipc-contracts`
   - mod runtime/library behavior: `$simmrust-runtime-library`
   - Nexus/NXM/FOMOD flows: `$simmrust-nexus-fomod-debug`
   - release, installer, updater, or artifact work: `$simmrust-release-updater`
   - desktop layout and UI smoke: `$simmrust-desktop-ui-validation`
6. Validate the changed platform surface on the platform that changed and run the counterpart check when behavior can diverge.

## Platform Rules

- Keep OS-specific code explicit with `cfg(target_os = "windows")`, `cfg(target_os = "linux")`, or centralized platform helpers. Avoid scattering string checks through UI components.
- Keep frontend platform labels and Rust platform behavior aligned. If `Settings` or readiness UI mentions a platform capability, verify the backend command path and test data support it.
- Treat desktop protocol handlers as cross-platform behavior: `simm://` and `nxm://` must remain coherent across Windows installer registration and Linux desktop entries.
- Treat app data paths, executable discovery, and shell command invocation as platform contracts. Prefer existing service helpers before adding new ad hoc path logic.
- Do not let a Windows fix silently disable Linux readiness, Proton support, AppImage repair, or Linux package metadata.
- Do not let a Linux fix silently degrade Windows NSIS installer behavior, updater artifacts, Steam/DepotDownloader handling, or credential/secrets behavior.

## Validation

Use the repo CI path from `AGENTS.md` as the baseline:

```powershell
bun install
bunx tsc --noEmit
bun run lint
bun run test
bun run build
cargo check --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml
```

For Linux packaging or Linux-native behavior, use the Docker builder:

```powershell
.\scripts\build-linux-container.cmd
```

Linux artifacts are expected at:

```text
target/release/bundle/deb/*.deb
target/release/bundle/appimage/*.AppImage
```

After Linux package builds, validate desktop scheme handlers:

```bash
bash scripts/validate-linux-desktop-mime.sh target/release/bundle/deb/*.deb
bash scripts/validate-linux-desktop-mime.sh target/release/bundle/appimage/*.AppImage
```

For Windows packaging or updater work, use `$simmrust-release-updater` and inspect the NSIS/updater artifact expectations before changing release scripts.

If full counterpart validation is impractical in the current environment, run the strongest local static checks, document the skipped platform-specific check, and identify the exact command the user should run later.

## Reference

Read `references/platform-parity-playbook.md` when the task touches platform-specific services, packaging, readiness checks, protocol handlers, shell commands, or release artifacts.
