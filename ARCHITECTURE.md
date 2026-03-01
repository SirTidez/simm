# Architecture

System design and technical architecture of SIMM (Schedule I Mod Manager).

## Table of Contents

- [High-Level Architecture](#high-level-architecture)
- [Core Data Flow](#core-data-flow)
- [Frontend Architecture](#frontend-architecture)
- [Backend Architecture](#backend-architecture)
- [Event System](#event-system)
- [Storage Model](#storage-model)
- [IPC Contract](#ipc-contract)
- [Runtime-Aware Mod Library](#runtime-aware-mod-library)
- [Security and Secrets](#security-and-secrets)
- [Background Jobs and Watchers](#background-jobs-and-watchers)
- [Extension Points](#extension-points)

## High-Level Architecture

SIMM is a desktop app built with a backend-authoritative architecture:

- **Frontend**: React + TypeScript (UI rendering, user interaction)
- **Backend**: Rust + Tauri 2 (state, orchestration, filesystem and network operations)
- **Persistence**: SQLite + filesystem metadata and shared mod storage

```
┌─────────────────────────────────────────────────────────────────────┐
│                        Frontend (React)                            │
│  App Shell + Overlays + Context Stores + ApiService + Events       │
└──────────────────────────────┬──────────────────────────────────────┘
                               │ invoke() / listen()
                               │ (Tauri IPC)
                               ▼
┌─────────────────────────────────────────────────────────────────────┐
│                        Backend (Rust)                              │
│                                                                     │
│  Commands (IPC)  ->  Services  ->  DB + Filesystem + External APIs │
│                                                                     │
│  - environments        - environment         - SQLite              │
│  - mods/plugins        - mods/plugins        - %APPDATA%\simmrust  │
│  - update checks       - update_check        - mod storage dirs     │
│  - settings/auth       - settings/auth       - env output dirs      │
│  - github releases     - github_releases     - Thunderstore/Nexus   │
└─────────────────────────────────────────────────────────────────────┘
```

## Core Data Flow

### Environment Lifecycle

```
User action in UI
    -> ApiService.invoke(command)
    -> command handler (src-tauri/src/commands)
    -> service layer (src-tauri/src/services)
    -> DB/filesystem update
    -> Tauri event emitted (optional)
    -> frontend event listener updates store/UI
```

Typical flow examples:

- Create environment: `create_environment` -> `EnvironmentService` -> SQLite row + environment JSON payload.
- Download/update environment: `start_download` / `check_update` -> DepotDownloader flow -> progress/update events.
- Version extraction: `extract_game_version` -> `GameVersionService` -> updates environment state.

### Mod Workflow (Library-First)

```
Add mod (zip/rar/dll)
    -> store/copy into shared storage
    -> write metadata
    -> symlink into environment Mods/Plugins/UserLibs
    -> emit mods/plugins/userlibs changed event
    -> overlay refreshes list and badges
```

The same storage item can be installed into multiple environments without copying binaries repeatedly.

### Update Workflow

Game update checks and mod update checks are separate but coordinated:

- **Game updates** compare local/remote manifest IDs.
- **Mod updates** compare installed metadata against Thunderstore, NexusMods, and GitHub releases.
- Results are emitted through events and reflected in environment cards, overlays, and footer status summaries.

## Frontend Architecture

### Major UI Components

| Component | File | Purpose |
|---|---|---|
| `App` | `src/components/App.tsx` | Root shell, overlays, providers |
| `EnvironmentList` | `src/components/EnvironmentList.tsx` | Main environment cards and actions |
| `ModLibraryOverlay` | `src/components/ModLibraryOverlay.tsx` | Shared library browsing and install/delete actions |
| `ModsOverlay` | `src/components/ModsOverlay.tsx` | Per-environment mod management |
| `PluginsOverlay` | `src/components/PluginsOverlay.tsx` | Per-environment plugin management |
| `Footer` | `src/components/Footer.tsx` | Aggregate status and mod update summary |
| `Settings` | `src/components/Settings.tsx` | App configuration and integrations |

### State and Service Layer

| Area | File | Responsibility |
|---|---|---|
| Environment store | `src/stores/environmentStore.tsx` | Environments, download progress, update state |
| Settings store | `src/stores/settingsStore.tsx` | Settings load/save, theme application |
| API client | `src/services/api.ts` | Single frontend entry point for `invoke()` commands |
| Event client | `src/services/events.ts` | Typed wrappers for backend event subscriptions |

## Backend Architecture

### Command Layer (IPC Entry Points)

Tauri commands in `src-tauri/src/commands/` are intentionally thin and delegate to services.

Core command groups:

- App/bootstrap: `app_init`, `settings`, `auth`
- Environments and downloads: `environments`, `downloads`, `depotdownloader`
- Mods and library: `mods`, `plugins`, `userlibs`, `fomod`
- Update systems: `update_check`, `mod_update`, `github_releases`
- Tooling: `config`, `logs`, `logger`, `filesystem`, `game_version`

### Service Layer (Business Logic)

Services in `src-tauri/src/services/` own domain workflows:

- `environment.rs`: environment CRUD and branch/runtime behavior
- `mods.rs`: shared mod storage, metadata, symlink orchestration, library projections
- `plugins.rs` / `userlibs.rs`: runtime folder management and enable/disable logic
- `update_check.rs`: game update checks (manifest and version)
- `mod_update.rs`: mod source update checks and summaries
- `github_releases.rs`, `thunderstore.rs`, `nexus_mods.rs`: external provider clients
- `filesystem_watcher.rs`: change watchers that emit UI refresh events

## Event System

SIMM uses direct Tauri events from Rust to frontend listeners.

Backend emitters are centralized in `src-tauri/src/events.rs`.
Frontend listeners are centralized in `src/services/events.ts`.

### Event Names

| Event | Payload Intent |
|---|---|
| `download_progress` | Download status/progress updates |
| `download_complete` | Download completion + manifest |
| `download_error` | Download failure |
| `auth_waiting` / `auth_success` / `auth_error` | Auth flow status |
| `melonloader_installing` / `melonloader_installed` / `melonloader_error` | MelonLoader install lifecycle |
| `update_available` / `update_check_complete` | Environment update check results |
| `mods_changed` / `plugins_changed` / `userlibs_changed` | Filesystem or state mutation notifications |
| `mod_updates_checked` | Per-environment mod update summary |

## Storage Model

### SQLite

Schema is defined in `src-tauri/migrations/0001_init.sql`.

Core tables:

- `app_meta`
- `settings`
- `environments`
- `secrets`
- `mod_metadata`

SQLite is initialized with WAL mode and foreign keys enabled in `src-tauri/src/db.rs`.

### Filesystem

- App data root: `%USERPROFILE%\SIMM\` (or `SIMMRUST_DATA_DIR` override)
- Environment directories: include `Mods`, `Plugins`, `UserLibs`
- Shared mod storage: under `settings.default_download_dir` (library-first design)
- Metadata files:
  - Environment mods metadata: `.mods-metadata.json`
  - Environment plugins metadata: `.plugins-metadata.json`
  - Shared storage metadata: `.storage-metadata.json`

## IPC Contract

Frontend calls backend via `invoke()` only through `ApiService`.

Example command groups exposed in `src-tauri/src/main.rs`:

- Environment management
- Download/auth workflows
- Mods/plugins/userlibs operations
- Update check and mod update summary
- GitHub release queries
- Logs and config operations

TypeScript interfaces in `src/types/index.ts` mirror Rust DTOs in `src-tauri/src/types.rs` (camelCase serialization at boundaries).

## Runtime-Aware Mod Library

Runtime awareness is a core invariant:

- Environments are explicit `IL2CPP` or `Mono`.
- Library entries carry runtime metadata and source metadata.
- Installation logic resolves runtime-compatible storage IDs.
- Unknown-runtime uploads prompt user selection in UI before install.
- Metadata is persisted both at environment level and storage level to preserve runtime tags across views.

This is what allows one storage model to serve multiple environments safely.

## Security and Secrets

- Sensitive values (Steam credentials, Nexus API key) are stored encrypted in the `secrets` table.
- Command surface is capability-scoped via Tauri plugin permissions.
- Frontend only handles intent; credential storage logic stays in backend services.

## Background Jobs and Watchers

On startup (`src-tauri/src/services/app_init.rs`):

- File watchers are created per environment folder (`Mods`, `Plugins`, `UserLibs`).
- A periodic reconciliation task runs to detect metadata drift and emit refresh events.

This keeps UI state aligned with filesystem changes, including out-of-band file edits.

## Extension Points

### Adding a Backend Capability

1. Add service logic in `src-tauri/src/services/<domain>.rs`.
2. Expose command in `src-tauri/src/commands/<domain>.rs`.
3. Register command in `src-tauri/src/main.rs`.
4. Add typed wrapper in `src/services/api.ts`.
5. Mirror/extend DTOs in `src-tauri/src/types.rs` and `src/types/index.ts`.

### Adding a New Event

1. Add emitter in `src-tauri/src/events.rs`.
2. Emit from relevant service/command flow.
3. Add frontend listener helper in `src/services/events.ts`.
4. Consume listener in store/component with proper cleanup.

### Adding a New Mod Source

1. Extend `ModSource` in Rust and TypeScript.
2. Add source client/service integration.
3. Extend update-check path (`mod_update`) and UI badges/actions.
4. Preserve metadata compatibility in storage and environment projections.

---

## References

- `README.md`
- `src-tauri/src/main.rs`
- `src-tauri/src/db.rs`
- `src-tauri/src/events.rs`
- `src/services/api.ts`
- `src/services/events.ts`
- `src/types/index.ts`
