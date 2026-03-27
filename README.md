# Schedule I Mod Manager (SIMM)

![SIMM logo](src-tauri/icons/128x128@2x.png)

A native Windows desktop application for managing Schedule I installations, mod libraries, and development environments. Built with Rust (Tauri 2) and React (TypeScript).

## Overview

SIMM (Schedule I Mod Manager) is a unified tool for creating and maintaining game environments, installing and updating mods from multiple sources, and handling common modding workflows with runtime-aware integrations.

## Features

### Core Functionality

- 🎮 **Environment Management**: Create, update, and delete multiple environments per game branch
- 🚚 **Install Sources**: Import existing Steam installs or download environments via DepotDownloader
- 🧠 **Runtime Awareness**: Per-environment runtime support and compatibility handling (IL2CPP/Mono)
- 🔐 **Secure Authentication**: Encrypted credential storage using AES-GCM
- ⚙️ **Scoped Access**: Tauri capability-based permissions for filesystem operations

### Library-First Mod Workflow

- 📦 **Shared Library Model**: Download mods into a centralized library, then install into environments
- 🔗 **Symlink-Based Installs**: Keep environment installs lightweight via library symlinks
- 🧹 **Consistent Cleanup**: Deleting a library item removes it from all linked environments

### Mod Sources & Updates

- 🌐 **Thunderstore Integration**: Search and download packages
- 🌐 **NexusMods Integration**: Search mods, browse files, download packages, and support FOMOD parsing
- 📤 **Local Mod Uploads**: Add unmanaged dev mods (listed in environments, not stored in library)
- 🔄 **Update Checks**: Check for updates across Thunderstore and NexusMods
- ✅ **Compatibility Signals**: Runtime matching with prompts when runtime is unknown

### Framework Integration

- 🍈 **MelonLoader**: Select and install versions from GitHub releases
- 🔌 **S1API**: Download to library and install runtime-aware packages per environment
- 🛡️ **MLVScan**: Download to library and install runtime-agnostic plugin assets

### Game Version Detection

- 🔍 **Multi-Source Version Extraction** in priority order:
  1. `app.info` (text and binary)
  2. `version.txt`
  3. Unity assets (`globalgamemanagers`)
  4. Unity assemblies (`Assembly-CSharp.dll`)
  5. Executable metadata

### Configuration, Logging, and UI

- ⚙️ **Config Tooling**: Edit MelonLoader settings with grouped UI (MelonPreferences, LoaderConfig)
- 📋 **Log Tooling**: View/export logs and watch log output in real time
- 📝 **App Logging**: Configurable log level and retention behavior
- 🎭 **Workflow Overlays**: Environment wizard, Mods, Plugins, UserLibs, Logs, Help, Settings, Steam account
- 🛡️ **Error Boundary**: Graceful failure handling in the UI

## Architecture

### Data Flow

React component -> `ApiService` -> `invoke()` -> Rust command -> service -> result -> UI

### Technology Stack

- **Backend**: Rust + Tauri 2
- **Frontend**: React 18 + TypeScript
- **Build/Dev**: Vite
- **Storage**: SQLite (app data) + filesystem-based mod library

### Data Storage

- **Windows data directory**: `%USERPROFILE%\SIMM\` (legacy `%APPDATA%\simmrust\data.db` is auto-migrated)
- **Persistence**: Environments and settings in SQLite
- **Credentials**: Encrypted and stored separately
- **Mod files**: Shared library with symlinked environment installs

## Prerequisites (Windows)

- **Rust (stable)**: https://rustup.rs/
- **Node.js v18+**: https://nodejs.org/

## Windows Installer

Windows releases now ship as an `NSIS` installer with a prerequisite step. Before SIMM installs, the setup wizard detects, installs, and verifies:

- Microsoft Visual C++ Redistributable x64
- .NET Desktop Runtime 6 x64
- DepotDownloader

If `winget` cannot install DepotDownloader automatically, the installer blocks and asks the user to install it manually before continuing.
The installed Windows app is also marked `requireAdministrator`, so every launch path prompts for elevation and symlink operations do not rely on Developer Mode.

## Development

### Run Full App (Tauri + Vite)

```bash
npm run tauri dev
```

### Run Frontend Only

```bash
npm run dev
```

### Build

```bash
npm run build
npm run tauri build
```

### Type Check

```bash
npx tsc --noEmit
```

### Rust Checks

```bash
cd src-tauri && cargo check
cd src-tauri && cargo clippy
cd src-tauri && cargo test
```

## Project Structure

```text
app-icon.png     # Source app icon (project root). Used to generate all app icons.
src-tauri/       # Rust backend (commands, services, events, shared types)
src/             # React frontend
src/services/    # Frontend API invoke client + event wiring
src/components/  # UI components and overlays
src/stores/      # React context stores
src/types/       # TypeScript shared types
```

### App icon

The file **`app-icon.png`** in the project root is the source image for the application icon. It is used to generate:

- **Taskbar and window icon**: All platform icons in `src-tauri/icons/` (including `icon.ico` on Windows), via the Tauri icon generator.
- **In-app header**: A 256px variant is copied to `src/assets/` for the logo in the top bar.

## Contributing

- Keep command handlers thin and place business logic in `src-tauri/src/services/`
- Route all frontend backend calls through `src/services/api.ts`
- Keep shared types synchronized between `src-tauri/src/types.rs` and `src/types/index.ts`
- Run `cargo fmt` for Rust changes and keep TypeScript checks clean

## License

GNU Affero General Public License v3.0 (AGPLv3). See `LICENSE`.
