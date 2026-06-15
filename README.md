# Schedule I Mod Manager (SIMM)

![SIMM logo](src-tauri/icons/128x128@2x.png)

A native desktop application for managing Schedule I installations, mod libraries, and development environments on Windows and Linux. Built with Rust (Tauri 2) and React (TypeScript).

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
- 📁 **Managed Copy Installs**: Keep source archives in the shared library and materialize real files into each environment
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
- **Mod files**: Shared archive/library storage with managed copied files in each environment

## Prerequisites

- **Rust (stable)**: https://rustup.rs/
- **Node.js v22.12+**: https://nodejs.org/
- **Bun 1.3.x**: https://bun.sh/

Linux Schedule I support runs the Windows game through Steam Proton. MelonLoader installs require Protontricks so SIMM can apply the game prefix prerequisites:

- `protontricks 3164500 dotnet6`
- `protontricks 3164500 vcrun2015`

SIMM can install the Linux DepotDownloader release into `~/.local/bin` when DepotDownloader is missing. The MLVScan security scanner installs as a managed dotnet tool on Linux; if a system .NET SDK 8+ is unavailable, SIMM bootstraps a private SDK under its tool cache before installing the scanner.

## Node.js Version

The frontend toolchain is validated against Node 22 in CI and now requires Node 22.12 or newer locally.

- If you use `nvm`, run `nvm use` at the repo root to pick up the checked-in `.nvmrc`
- GitHub Actions uses Node 22 for all frontend jobs, so local validation should use the same baseline

## Windows Installer

Windows releases now ship as an `NSIS` installer with a prerequisite step. Before SIMM installs, the setup wizard detects, installs, and verifies:

- Microsoft Visual C++ Redistributable x64
- .NET Desktop Runtime 6 x64
- DepotDownloader

If `winget` cannot install DepotDownloader automatically, the installer blocks and asks the user to install it manually before continuing.
Managed mod installs use copied files instead of symlinks, so normal launch paths do not need administrator elevation for link creation.

## Linux Packages

Linux releases build AppImage and Debian package artifacts. Steam-managed Schedule I installs launch through Steam so Proton can load MelonLoader with the required `WINEDLLOVERRIDES="version=n,b" %command%` launch option.

On Linux, Settings includes a readiness section for Steam, Protontricks, DepotDownloader, MLVScan/.NET SDK, and `simm://`/`nxm://` desktop handlers. Use **Repair Desktop Links** after moving an AppImage or changing default protocol handlers.

### Install On Linux

The Linux installer downloads the latest GitHub release, verifies `SHA256SUMS`, installs the Debian package on Debian-family distros, and falls back to a user-local AppImage elsewhere:

```bash
curl -fsSL https://raw.githubusercontent.com/SirTidez/simm/master/install.sh -o install.sh
bash install.sh
```

Install a beta or a specific release:

```bash
bash install.sh --channel beta
bash install.sh --version v0.8.6
```

Force the AppImage path, preview the selected install without changing the system, or remove a user-local AppImage install:

```bash
bash install.sh --appimage
bash install.sh --dry-run
bash install.sh --uninstall
```

The installer does not install Steam, Protontricks, DepotDownloader, or .NET runtime tools. SIMM checks Linux readiness inside the app and provides repair actions for supported managed tools and desktop/protocol handlers.

### Linux Build Dependencies

Install the normal Tauri Linux build prerequisites before running the full desktop app or producing Linux packages. On Debian/Ubuntu-based systems:

```bash
sudo apt-get update
sudo apt-get install -y \
  build-essential \
  curl \
  file \
  libayatana-appindicator3-dev \
  libfuse2 \
  libglib2.0-dev \
  libgtk-3-dev \
  libssl-dev \
  libwebkit2gtk-4.1-dev \
  patchelf \
  pkg-config \
  librsvg2-dev
```

### Live Linux Provider Smoke Tests

Provider download smoke tests are ignored by default because they call third-party services and may require account state:

```bash
cargo test --manifest-path src-tauri/Cargo.toml services::thunderstore::tests::live_search_fetch_and_download_package_archive -- --ignored --nocapture
cargo test --manifest-path src-tauri/Cargo.toml services::nexus_mods::tests::live_schedule_i_metadata_query_returns_files -- --ignored --nocapture
SIMM_NEXUS_LIVE_ACCESS_TOKEN=... SIMM_NEXUS_LIVE_MOD_ID=... SIMM_NEXUS_LIVE_FILE_ID=... cargo test --manifest-path src-tauri/Cargo.toml services::nexus_mods::tests::live_oauth_downloads_configured_schedule_i_file -- --ignored --nocapture
```

The Nexus download smoke requires a valid OAuth access token and a Schedule I mod/file id that the account is allowed to download.

Steam and MelonLoader Linux readiness checks are also ignored by default because they inspect the host Steam install:

```bash
cargo test --manifest-path src-tauri/Cargo.toml services::steam::tests::live_detects_schedule_i_installation_branch_and_launch_options_status -- --ignored --nocapture
cargo test --manifest-path src-tauri/Cargo.toml services::melon_loader::tests::live_linux_requirements_status_reads_steam_and_protontricks -- --ignored --nocapture
```

The launch smoke is additionally gated because it starts the real game through Steam/Proton. It requires MelonLoader to already be installed and confirms that `MelonLoader/Latest.log` is refreshed after launch:

```bash
SIMM_LIVE_LAUNCH_GAME=1 cargo test --manifest-path src-tauri/Cargo.toml services::melon_loader::tests::live_linux_launches_schedule_i_and_confirms_melonloader_log -- --ignored --nocapture
SIMM_LIVE_LAUNCH_GAME=1 SIMM_LIVE_LAUNCH_ENV_DIR="/path/to/Schedule I" cargo test --manifest-path src-tauri/Cargo.toml services::melon_loader::tests::live_linux_launches_schedule_i_and_confirms_melonloader_log -- --ignored --nocapture
```

The MLVScan host smoke installs or updates the Linux dotnet tool, bootstrapping SIMM's private .NET SDK if the host SDK is missing, then scans a real .NET assembly through the same `scan_artifact` path used by downloads. By default the scan body skips unless explicitly enabled:

```bash
cargo test --manifest-path src-tauri/Cargo.toml services::security_scanner::tests::live_linux_install_latest_uses_dotnet_tool_or_private_sdk -- --ignored --nocapture
SIMM_MLVSCAN_LIVE_SCAN=1 cargo test --manifest-path src-tauri/Cargo.toml services::security_scanner::tests::live_linux_scan_executes_against_real_dotnet_assembly -- --ignored --nocapture
SIMM_MLVSCAN_LIVE_SCAN=1 SIMM_MLVSCAN_LIVE_SCAN_DLL="/path/to/Example.dll" cargo test --manifest-path src-tauri/Cargo.toml services::security_scanner::tests::live_linux_scan_executes_against_real_dotnet_assembly -- --ignored --nocapture
```

## Development

### Run Full App (Tauri + Vite)

```bash
bun install
bun run tauri dev
```

### Run Full App On Linux

Use the Linux-specific dev script when running under Wayland, especially on NVIDIA or distros where WebKitGTK fails with messages like `Error 71 (Protocol error) dispatching to Wayland display`, `Cannot create EGL context`, or a blank webview:

```bash
bun install
bun run tauri:dev:linux
```

This script runs `tauri dev` with native Wayland enabled and the WebKitGTK renderer workarounds:

- `WEBKIT_DISABLE_DMABUF_RENDERER=1` to avoid WebKitGTK DMA-BUF renderer failures.
- `WEBKIT_DISABLE_COMPOSITING_MODE=1` to avoid WebKitGTK accelerated compositing failures.

If native Wayland still fails, use the explicit X11/XWayland fallback:

```bash
bun run tauri:dev:linux:x11
```

The X11 fallback forces `GDK_BACKEND=x11` and `WINIT_X11_SCALE_FACTOR=1`. Use it only when the default Linux dev script cannot create a usable WebKitGTK window, because XWayland scaling can report a smaller logical viewport than the physical window size on some Wayland sessions.

### Run Frontend Only

```bash
bun run dev
```

### Build

```bash
bun install
bunx tsc --noEmit
bun run lint
bun run test
bun run build
bun run tauri build
```

### Build Linux Packages

Linux packages must be built from a Linux host with the Linux build dependencies installed:

```bash
bun install
bunx tsc --noEmit
bun run lint
bun run test
bun run build
bun run tauri:build:linux
```

Build only one Linux bundle type when iterating:

```bash
bun run tauri:build:linux:deb
bun run tauri:build:linux:appimage
```

The Linux bundle outputs are written under `target/release/bundle/`:

- `deb/*.deb`
- `appimage/*.AppImage`

After building, validate that the packaged desktop entry declares the `simm://` and `nxm://` handlers:

```bash
bash scripts/validate-linux-desktop-mime.sh target/release/bundle/deb/*.deb
bash scripts/validate-linux-desktop-mime.sh target/release/bundle/appimage/*.AppImage
```

### Build Linux Packages With Docker

The repo includes an Ubuntu-based builder image for creating Linux `.deb` and `.AppImage` artifacts from Windows or any Docker host. It uses Ubuntu 22.04 as the build baseline so Tauri's WebKitGTK 4.1 dependency is available while keeping the generated binaries compatible with older glibc versions than a newer Ubuntu image would require.

From Windows, use the `.cmd` wrapper so PowerShell execution policy does not block the build script:

```powershell
.\scripts\build-linux-container.cmd
```

If the build is launched from a transient Command Prompt window and fails, the wrapper pauses so the error remains visible. Running the same command from an existing terminal is still recommended because it preserves the full Docker log.

From PowerShell directly:

```powershell
.\scripts\build-linux-container.ps1
```

The wrapper builds the `simm-linux-builder:ubuntu22.04` image, bind-mounts the repository at `/workspace`, reuses named Docker volumes for Bun and Cargo caches, and runs:

```bash
bun install
bunx tsc --noEmit
bun run lint
bun run test
bun run build
bun run tauri:build:linux
bash scripts/validate-linux-desktop-mime.sh target/release/bundle/deb/*.deb
bash scripts/validate-linux-desktop-mime.sh target/release/bundle/appimage/*.AppImage
```

Useful variants:

```powershell
.\scripts\build-linux-container.cmd -Command check
.\scripts\build-linux-container.cmd -Command shell
.\scripts\build-linux-container.cmd -BunVersion 1.3.3
.\scripts\build-linux-container.cmd -SkipImageBuild
```

Raw Docker:

```bash
docker build -f docker/linux/Dockerfile -t simm-linux-builder:ubuntu22.04 .
docker run --rm -it \
  --mount type=bind,source="$PWD",target=/workspace \
  --mount type=volume,source=simm-linux-cargo-registry,target=/usr/local/cargo/registry \
  --mount type=volume,source=simm-linux-cargo-git,target=/usr/local/cargo/git \
  --mount type=volume,source=simm-linux-bun-cache,target=/root/.bun/install/cache \
  --workdir /workspace \
  simm-linux-builder:ubuntu22.04 build
```

### Type Check

```bash
bunx tsc --noEmit
```

### Lint

```bash
bun run lint
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
