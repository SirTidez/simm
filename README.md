# Schedule I Mod Manager (SIMM)

A native Windows desktop app for managing Schedule I game installations, mod libraries, and dev environments. Built with Rust (Tauri 2) and React (TypeScript).

## Feature Index

1) Environment management
2) Library‑first mod workflow
3) Mod sources (Thunderstore, NexusMods, local)
4) Mod updates and runtime compatibility
5) Framework integrations (MelonLoader, S1API, MLVScan)
6) Game version detection
7) Configuration and log tooling
8) Security and permissions
9) UI overlays and workflows

---

## 1) Environment management

- Create, update, and delete multiple environments per game branch.
- Import existing Steam installs or download via DepotDownloader.
- Per‑environment runtime awareness (IL2CPP/Mono).

## 2) Library‑first mod workflow

- Download mods into a shared library, then install into environments from the environment’s mod list.
- Centralized mod storage with symlinks into each environment.
- Deleting a library entry removes it from all environments.

## 3) Mod sources

- Thunderstore search and downloads.
- NexusMods search, file browsing, and downloads.
- Local uploads for unmanaged dev mods (listed but not stored in the library).
- FOMOD installer detection and parsing.

## 4) Mod updates and runtime compatibility

- Check for updates across Thunderstore and NexusMods.
- Runtime matching and compatibility signals (IL2CPP/Mono).
- Runtime selection prompt when a package’s runtime is unknown.

## 5) Framework integrations

- MelonLoader: version selection and install from GitHub releases.
- S1API: downloads to library and runtime‑aware install from the package.
- MLVScan: downloads to library and runtime‑agnostic plugin install.

## 6) Game version detection

Detects versions from multiple sources in priority order:

- `app.info` (text and binary)
- `version.txt`
- Unity assets (`globalgamemanagers`)
- Unity assemblies (`Assembly-CSharp.dll`)
- Executable metadata

## 7) Configuration and log tooling

- Edit MelonLoader configs with grouped UI (MelonPreferences, LoaderConfig).
- View/export game logs and watch logs in real time.
- App log retention and level settings.

## 8) Security and permissions

- AES‑GCM encrypted credential storage.
- Tauri capabilities for scoped filesystem access.

## 9) UI overlays and workflows

- Environment creation wizard
- Mods, Plugins, UserLibs overlays
- Logs, Help, Settings, Steam account overlays
- Error boundary for graceful failure

---

## Architecture

### Data flow

React component → `ApiService` → `invoke()` → Rust command → service → result → UI

### Tech stack

- Rust + Tauri 2 (backend)
- React 18 + TypeScript (frontend)
- Vite (build/dev)
- SQLite (app data) + filesystem storage for mods

### Storage

- Windows data dir: `%APPDATA%\simmrust\`
- Environments and settings stored in SQLite
- Encrypted credentials stored separately
- Mod storage: shared library folder with symlinks to environments

---

## Prerequisites (Windows)

- Rust (stable) https://rustup.rs/
- Node.js v18+ https://nodejs.org/
- DepotDownloader (winget):
  - `winget install --exact --id SteamRE.DepotDownloader`

---

## Development

### Run dev

```bash
npm run tauri dev
```

### Frontend only

```bash
npm run dev
```

### Build

```bash
npm run build
npm run tauri build
```

### Type check

```bash
npx tsc --noEmit
```

### Rust checks

```bash
cd src-tauri && cargo check
```

---

## Project structure (high‑level)

```
src-tauri/       # Rust backend (commands + services)
src/             # React frontend
src/services/    # Tauri invoke client + events
src/components/  # UI overlays and panels
```

---

## Contributing

- Follow existing patterns in `src-tauri/src/services` and `src/services/api.ts`.
- Keep types in sync between Rust (`src-tauri/src/types.rs`) and TS (`src/types/index.ts`).
- Run `cargo fmt` for Rust changes and keep TS lint clean.

---

## License

MIT. See `LICENSE`.
