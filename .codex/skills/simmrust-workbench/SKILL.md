---
name: simmrust-workbench
description: Route broad work in the SIMM Tauri/React/Rust repo to the right focused SIMM skill and validation path. Use for ambiguous or cross-cutting SIMM tasks involving frontend/backend contracts, runtime-aware mod library behavior, Nexus/FOMOD debugging, releases/updater workflows, desktop UI changes, or when Codex needs a repo-specific starting checklist before editing.
---

# SIMM Workbench

## Start Here

Ground in the repo before choosing a path:

1. Read `AGENTS.md`, `ARCHITECTURE.md`, and the changed or likely touched files.
2. Check `git status --short` and preserve unrelated user changes.
3. Classify the task by the routing table below.
4. Pick the narrowest focused skill, then run the matching validation for the touched surface.

## Routing

- IPC, shared DTOs, Tauri commands, `ApiService`, event wiring: use `$simmrust-ipc-contracts`.
- Mods, plugins, UserLibs, shared library storage, runtime compatibility, metadata sync, update state: use `$simmrust-runtime-library`.
- Nexus OAuth/API key, `nxm://`, manual downloads, FOMOD archives, callback replay, runtime prompt loops: use `$simmrust-nexus-fomod-debug`.
- Changelog, version bumps, GitHub Actions release jobs, updater manifests, Windows installer artifacts: use `$simmrust-release-updater`.
- Desktop app layout, overlays, app shell, smoke tests, browser/Tauri UI gaps: use `$simmrust-desktop-ui-validation`.

If a task spans more than one area, start with the skill that owns the failure source, then validate all touched boundaries.

## Validation

Use repo validation from `AGENTS.md`:

- Frontend changes: `bun install`, `bunx tsc --noEmit`, `bun run lint`, `bun run test`, `bun run build`.
- Backend or shared contract changes: add `cargo check --manifest-path src-tauri/Cargo.toml` and `cargo test --manifest-path src-tauri/Cargo.toml`.
- Treat frontend lint warnings as review prompts unless they are correctness issues or in touched code.

Run `scripts/validate_simm_skills.py` after editing this repo-local skill pack.

## References

- `references/repo-map.md`: repo architecture and validation map.
- `scripts/validate_simm_skills.py`: read-only validator wrapper for all repo-local SIMM skills.
