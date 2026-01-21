# Schedule I Mod Manager (SIMM)

A native desktop application for downloading and managing multiple branches of Schedule I (and other Steam games) for mod development. Built with Rust (Tauri 2.0) and React (TypeScript).

## Overview

SIMM (Schedule I Mod Manager) is a comprehensive tool for managing game installations, mods, plugins, and development environments. It provides a unified interface for downloading game branches, installing modding frameworks, managing mods from multiple sources, and configuring development environments.

## Features

### Core Functionality

- 🎮 **Multi-Branch Management**: Download and manage multiple Schedule I branches (Main, Beta, Alternate, Alternate Beta)
- 🔄 **Real-time Progress**: Live download progress tracking via Tauri events
- 🔐 **Secure Authentication**: Encrypted credential storage using AES-GCM
- ⚙️ **Easy Configuration**: Simple settings management for download directories and preferences
- 🚀 **Automatic Detection**: Automatically detects DepotDownloader installation (winget, homebrew, or manual)
- 📦 **Environment Management**: Create, view, update, and delete developer environments
- 🎨 **Customizable Themes**: Light, dark, modern-blue, and fully customizable themes with gradient editor

### Mod Management

- 🛠️ **Mod Management**: Manage mods, plugins, and user libraries with enable/disable functionality
- 📤 **Mod Upload**: Upload and install mods from local files
- 🔍 **Mod Detection**: Automatic mod detection with runtime matching (IL2CPP/Mono)
- 🔄 **Mod Updates**: Check for mod updates from Thunderstore and NexusMods
- 📦 **Mod Storage**: Centralized mod storage with symlink management
- 🧹 **Cleanup Tools**: Remove duplicate mod storage entries

### Framework Integration

- 🍈 **MelonLoader Integration**: Install and manage MelonLoader directly from GitHub releases (LavaGang/MelonLoader)
  - Version selection and management
  - Support for Windows x64 builds
  - Automatic installation into game directories
- 🔌 **S1API Support**: Install and manage S1API (Schedule I API) from GitHub releases (ifBars/S1API)
  - Runtime-aware installation (Mono/IL2CPP)
  - Automatic version tracking
- 🛡️ **MLVScan Security Plugin**: Install MLVScan malware scanning plugin from GitHub releases (ifBars/MLVScan)
  - Supports both DLL and ZIP asset formats
  - Automatic malware scanning for mods

### Game Management

- 🔍 **Game Version Detection**: Automatic game version extraction from multiple sources:
  - `app.info` files (text and binary formats)
  - `version.txt` files
  - Unity binary assets (`globalgamemanagers`)
  - Unity game assemblies (`Assembly-CSharp.dll`)
  - Executable metadata (PowerShell and binary search)
- 🔄 **Update Checking**: Check for game updates and mod updates
  - Automatic update detection
  - Configurable update check intervals
  - Batch update checking
- 🎮 **Steam Integration**: Detect and create environments from existing Steam installations
- 📁 **Enhanced File Management**: Create directories directly in the file picker, with default download directory support

### External Integrations

- 🌐 **Thunderstore Integration**: 
  - Search and download mods from Thunderstore
  - Package browsing and installation
  - Update checking for Thunderstore mods
- 🌐 **NexusMods Integration**: 
  - API key validation and rate limit checking
  - Search mods, browse files, and download
  - Support for FOMOD installers
  - Mod update checking
- 📦 **GitHub Releases**: 
  - Fetch latest and all releases for MelonLoader, S1API, and MLVScan
  - Version selection and download
  - Optional GitHub token support for rate limit increases

### Configuration & Logging

- ⚙️ **Config File Management**: 
  - Read and edit MelonLoader configuration files
  - Grouped config display (MelonPreferences, LoaderConfig)
  - Section-based configuration updates
- 📋 **Log Management**: 
  - View and export game logs
  - Real-time log file watching
  - App logging with configurable retention
  - Log level configuration (debug, info, warn, error)

### User Interface

- 🎨 **Modern UI**: React-based interface with responsive design
- 🎭 **Multiple Overlays**: 
  - Environment Creation Wizard
  - Settings Panel
  - Mods Overlay
  - Plugins Overlay
  - UserLibs Overlay
  - Logs Overlay
  - Help Overlay
  - Welcome Overlay
  - Steam Account Overlay
- 🛡️ **Error Handling**: Error boundary for graceful error handling
- 📱 **Accessibility**: ARIA labels and keyboard navigation support

## Prerequisites

- **Rust** (latest stable version) - https://rustup.rs/
- **Node.js** v18 or higher - https://nodejs.org/
- **DepotDownloader** installed on your system
  - Windows: `winget install --exact --id SteamRE.DepotDownloader`
  - macOS: `brew tap steamre/tools && brew install depotdownloader`
  - Linux: Download from [GitHub releases](https://github.com/SteamRE/DepotDownloader/releases)

## Installation

1. **Install Tauri CLI**:
   ```bash
   npm install -g @tauri-apps/cli
   ```

2. **Install dependencies**:
   ```bash
   npm install
   ```

3. **Build the application**:
   ```bash
   npm run tauri build
   ```

   The built application will be in `src-tauri/target/release/` (or `debug/` for debug builds).

## Development

### Run in Development Mode

```bash
npm run tauri dev
```

This will:
- Start the Vite dev server on `http://localhost:1420`
- Launch the Tauri application with hot-reload
- Open DevTools automatically in debug mode

### Project Structure

```
simmrust/
├── src-tauri/                    # Rust backend (Tauri 2.0)
│   ├── src/
│   │   ├── commands/              # Tauri command handlers (API endpoints)
│   │   │   ├── app_init.rs       # Application initialization
│   │   │   ├── auth.rs           # Authentication
│   │   │   ├── config.rs         # Configuration file management
│   │   │   ├── depotdownloader.rs # DepotDownloader detection
│   │   │   ├── downloads.rs      # Download management
│   │   │   ├── environments.rs   # Environment CRUD operations
│   │   │   ├── filesystem.rs     # File system operations
│   │   │   ├── fomod.rs          # FOMOD installer support
│   │   │   ├── game_version.rs   # Game version extraction
│   │   │   ├── github_releases.rs # GitHub Releases API
│   │   │   ├── logs.rs           # Log file management
│   │   │   ├── melon_loader.rs   # MelonLoader installation
│   │   │   ├── mod_update.rs     # Mod update checking
│   │   │   ├── mod.rs            # Mod metadata
│   │   │   ├── mods.rs           # Mod management
│   │   │   ├── nexus_mods.rs     # NexusMods API integration
│   │   │   ├── plugins.rs        # Plugin management
│   │   │   ├── settings.rs       # Settings management
│   │   │   ├── thunderstore.rs   # Thunderstore API integration
│   │   │   ├── update_check.rs   # Update checking
│   │   │   └── userlibs.rs       # User library management
│   │   ├── services/             # Business logic layer
│   │   │   ├── app_init.rs       # Service initialization
│   │   │   ├── auth.rs           # Authentication service
│   │   │   ├── config.rs         # Config file parsing
│   │   │   ├── depot_downloader.rs # DepotDownloader execution
│   │   │   ├── environment.rs    # Environment operations
│   │   │   ├── filesystem.rs     # File operations
│   │   │   ├── filesystem_watcher.rs # File system watching
│   │   │   ├── fomod.rs          # FOMOD parsing
│   │   │   ├── game_version.rs   # Version extraction logic
│   │   │   ├── github_releases.rs # GitHub API client
│   │   │   ├── logger.rs         # Logging service
│   │   │   ├── logs.rs           # Log file operations
│   │   │   ├── melon_loader.rs   # MelonLoader installation logic
│   │   │   ├── mod_update.rs     # Mod update logic
│   │   │   ├── mod.rs            # Mod metadata extraction
│   │   │   ├── mods.rs           # Mod file operations
│   │   │   ├── nexus_mods.rs     # NexusMods API client
│   │   │   ├── plugins.rs        # Plugin operations
│   │   │   ├── settings.rs       # Settings persistence
│   │   │   ├── steam.rs          # Steam integration
│   │   │   ├── thunderstore.rs   # Thunderstore API client
│   │   │   ├── update_check.rs   # Update check logic
│   │   │   └── userlibs.rs       # UserLib operations
│   │   ├── utils/                # Utility functions
│   │   │   ├── depot_downloader_detector.rs # DepotDownloader detection
│   │   │   ├── directory_init.rs # Directory initialization
│   │   │   ├── global_logger.rs  # Global logging setup
│   │   │   ├── mod.rs            # Module exports
│   │   │   └── validation.rs     # Input validation
│   │   ├── events.rs             # Tauri event definitions
│   │   ├── types.rs              # Rust type definitions
│   │   └── main.rs               # Application entry point
│   ├── capabilities/             # Tauri security capabilities
│   │   └── default.json          # Default permissions
│   ├── icons/                    # Application icons
│   ├── Cargo.toml                # Rust dependencies
│   └── tauri.conf.json           # Tauri configuration
├── src/                          # React frontend
│   ├── components/               # React components
│   │   ├── App.tsx               # Main application component
│   │   ├── AuthenticationModal.tsx
│   │   ├── ColorPicker.tsx
│   │   ├── ConfigurationOverlay.tsx
│   │   ├── ConfirmOverlay.tsx
│   │   ├── CustomThemeEditor.tsx
│   │   ├── EnvironmentCreationWizard.tsx
│   │   ├── EnvironmentList.tsx
│   │   ├── ErrorBoundary.tsx
│   │   ├── Footer.tsx
│   │   ├── GradientEditor.tsx
│   │   ├── HelpOverlay.tsx
│   │   ├── LogsOverlay.tsx
│   │   ├── MessageOverlay.tsx
│   │   ├── ModsOverlay.tsx
│   │   ├── PluginsOverlay.tsx
│   │   ├── Settings.tsx
│   │   ├── SteamAccountOverlay.tsx
│   │   ├── UserLibsOverlay.tsx
│   │   └── WelcomeOverlay.tsx
│   ├── services/                 # Frontend services
│   │   ├── api.ts                # Tauri API client (invoke wrapper)
│   │   ├── events.ts             # Tauri event handlers
│   │   └── logger.ts             # Frontend logging
│   ├── stores/                   # State management
│   │   ├── environmentStore.tsx  # Environment state
│   │   └── settingsStore.tsx    # Settings state
│   ├── types/                    # TypeScript type definitions
│   │   └── index.ts              # Shared types
│   ├── utils/                    # Utility functions
│   │   └── logger.ts             # Console interception
│   ├── main.tsx                  # React entry point
│   └── style.css                 # Global styles
├── .gitignore
├── Cargo.toml                    # Workspace Cargo.toml
├── package.json                  # Node.js dependencies
├── tsconfig.json                 # TypeScript configuration
├── tsconfig.node.json            # Node TypeScript config
├── vite.config.ts                # Vite configuration
└── README.md                     # This file
```

## Architecture

### Technology Stack

- **Backend**: Rust with Tauri 2.0 framework
- **Frontend**: React 18 with TypeScript
- **Build Tool**: Vite 7
- **Communication**: Tauri commands (`invoke`) + Tauri events (replaces WebSocket)
- **Data Storage**: JSON files in platform-specific data directory
- **External APIs**: 
  - GitHub Releases API (via `octocrab`)
  - NexusMods API
  - Thunderstore API

### Data Storage

Application data is stored in platform-specific directories:

- **Windows**: `%APPDATA%\simmrust\`
- **macOS**: `~/Library/Application Support/simmrust/`
- **Linux**: `~/.local/share/simmrust/`

Stored files:
- `environments.json` - Environment configurations
- `settings.json` - Application settings
- `credentials.enc` - Encrypted Steam credentials (AES-GCM)
- `github_token.enc` - Encrypted GitHub token (optional)
- `nexus_mods_api_key.enc` - Encrypted NexusMods API key (optional)
- `logs/` - Application log files

### Security

- **Credential Encryption**: All sensitive credentials are encrypted using AES-GCM
- **Secure Storage**: Credentials stored separately from settings
- **Tauri Capabilities**: Fine-grained file system permissions
- **Input Validation**: All user inputs are validated before processing

### State Management

- **React Context**: Used for global state (environments, settings)
- **Tauri Events**: Real-time updates for downloads, progress, etc.
- **Local State**: Component-level state for UI interactions

## Key Integrations

### MelonLoader

- **Source**: GitHub releases from `LavaGang/MelonLoader`
- **Installation**: Automatic installation into game directories
- **Version Management**: Select and install specific versions
- **Platform Support**: Windows x64 builds

### S1API (Schedule I API)

- **Source**: GitHub releases from `ifBars/S1API`
- **Runtime Awareness**: Automatically detects and installs correct runtime version (Mono/IL2CPP)
- **Version Tracking**: Tracks installed version per environment

### MLVScan

- **Source**: GitHub releases from `ifBars/MLVScan`
- **Formats**: Supports both DLL and ZIP asset formats
- **Security**: Malware scanning plugin for mods

### Game Version Detection

The application automatically extracts game versions from multiple sources in order of priority:

1. `app.info` files (text and binary formats)
2. `version.txt` files
3. Unity binary assets (`globalgamemanagers`)
4. Unity game assemblies (`Assembly-CSharp.dll`)
5. Executable metadata (PowerShell and binary search)

### FOMOD Support

- Automatic FOMOD installer detection
- XML parsing for FOMOD installers
- Support for NexusMods FOMOD installers

## API Commands

The application exposes Tauri commands for frontend-backend communication. Key command categories:

- **App Init**: `was_simm_directory_just_created`, `get_home_directory`
- **DepotDownloader**: `detect_depot_downloader`
- **Settings**: `get_settings`, `save_settings`, credential management
- **Environments**: CRUD operations, Steam detection, config retrieval
- **Downloads**: `start_download`, `cancel_download`, `get_download_progress`
- **Auth**: `authenticate`
- **Filesystem**: `open_folder`, `launch_game`, `browse_directory`, `create_directory`
- **Mods**: List, enable/disable, delete, upload, S1API installation
- **Plugins**: List, enable/disable, delete, upload, MLVScan installation
- **UserLibs**: List, enable/disable
- **Updates**: `check_update`, `check_all_updates`, `get_update_status`
- **MelonLoader**: Status, install/uninstall, version management
- **GitHub Releases**: Latest/all releases for MelonLoader, S1API, MLVScan
- **NexusMods**: API key validation, search, download, update checking
- **Thunderstore**: Search, download packages
- **Mod Updates**: `check_mod_updates`, `update_mod`
- **Logs**: File management, watching, app logging
- **Config**: Read, update configuration files
- **FOMOD**: Detection and parsing
- **Game Version**: Extraction from various sources

## Development Workflow

### Adding New Features

1. **Backend (Rust)**:
   - Add service logic in `src-tauri/src/services/`
   - Add command handler in `src-tauri/src/commands/`
   - Register command in `src-tauri/src/main.rs`
   - Update types in `src-tauri/src/types.rs` if needed

2. **Frontend (TypeScript)**:
   - Add API method in `src/services/api.ts`
   - Create/update components in `src/components/`
   - Update types in `src/types/index.ts` if needed
   - Update stores if state management is needed

### Testing

- Run `npm run tauri dev` for development with hot-reload
- Check console logs for debugging
- Use DevTools (automatically opened in debug mode)

### Building

- **Debug**: `npm run tauri build` (or `cargo build` in `src-tauri/`)
- **Release**: `npm run tauri build -- --release`
- Output: `src-tauri/target/release/` (or `debug/`)

## Configuration

### Settings

Accessible via the Settings button in the header. Key settings:

- **Default Download Directory**: Default location for game installations (defaults to `~/SIMM`)
- **DepotDownloader Path**: Manual path override (auto-detected if not set)
- **Steam Username**: For Steam authentication
- **Max Concurrent Downloads**: Number of simultaneous downloads
- **Theme**: Light, dark, modern-blue, or custom
- **Log Level**: Debug, info, warn, error
- **Update Check Interval**: Minutes between automatic update checks
- **NexusMods API Key**: For NexusMods integration (optional)
- **Thunderstore Game ID**: Game identifier for Thunderstore
- **Log Retention Days**: Number of days to keep log files (default: 7)

### Environment Types

- **DepotDownloader**: Download game via DepotDownloader
- **Steam**: Use existing Steam installation

## Troubleshooting

### Common Issues

1. **DepotDownloader not detected**:
   - Ensure DepotDownloader is installed via winget/homebrew or manually
   - Check settings for manual path override

2. **Download fails**:
   - Verify Steam credentials are correct
   - Check network connection
   - Ensure sufficient disk space

3. **Mods not appearing**:
   - Check mods folder path in environment
   - Verify mod files are in correct format
   - Check runtime compatibility (IL2CPP vs Mono)

4. **Version extraction fails**:
   - Ensure game is fully downloaded
   - Check that game files are not corrupted
   - Try manual version entry

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## Contributing

Contributions are welcome! Please ensure:

- Code follows existing patterns and style
- Rust code is properly formatted (`cargo fmt`)
- TypeScript code follows the project's conventions
- New features include appropriate error handling
- Documentation is updated for new features

## Version History

### Version 0.1.0 (Current)

- Initial release with full feature set
- Multi-branch environment management
- Mod and plugin management
- MelonLoader, S1API, and MLVScan integration
- Thunderstore and NexusMods support
- Game version detection
- Config file management
- Log viewing and management
- Custom theme support
