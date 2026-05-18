# SIMM Repo Map

Use this as a compact starting map. Re-check files before editing because the repo can move faster than this reference.

## Architecture

- Frontend: React 18, TypeScript, Vite, Vitest, Testing Library.
- Backend: Rust, Tauri 2, SQLite, filesystem services, Windows installer tooling.
- Contract boundary: frontend calls Rust through `src/services/api.ts`; event subscriptions belong in `src/services/events.ts`.
- Backend command handlers live under `src-tauri/src/commands/` and should delegate to service modules under `src-tauri/src/services/`.
- Shared DTOs are mirrored between `src-tauri/src/types.rs` and `src/types/index.ts`.

## Validation Baseline

Frontend changes should mirror the local CI sequence in `AGENTS.md`:

```powershell
bun install
bunx tsc --noEmit
bun run lint
bun run test
bun run build
```

Backend or shared contract changes add:

```powershell
cargo check --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml
```

## Routing Hints

- UI state oddities often cross component, store, `ApiService`, event, and Rust service boundaries.
- Runtime-sensitive mod behavior usually depends on both storage metadata and environment metadata.
- Nexus reports should be split into protocol routing, auth, source API, archive parsing, completion cleanup, and frontend prompt state.
- Release issues often depend on exact current workflow logs and Tauri 2 artifact names, not old updater assumptions.
