# Schedule I Developer Environment Manager (Rust/Tauri)

A native desktop application for downloading and managing multiple branches of Schedule I (and other Steam games) for mod development. Built with Rust (Tauri) and React.

## Features

- 🎮 **Multi-Branch Management**: Download and manage multiple Schedule I branches (Main, Beta, Alternate, Alternate Beta)
- 🔄 **Real-time Progress**: Live download progress tracking via Tauri events
- 🔐 **Secure Authentication**: Encrypted credential storage
- ⚙️ **Easy Configuration**: Simple settings management for download directories and preferences
- 🚀 **Automatic Detection**: Automatically detects DepotDownloader installation
- 📦 **Environment Management**: Create, view, update, and delete developer environments
- 🛠️ **Mod Management**: Manage mods, plugins, and user libraries
- 🍈 **MelonLoader Integration**: Install and manage MelonLoader directly from GitHub releases
- 🔌 **S1API Support**: Install and manage S1API (Schedule I API) from GitHub releases
- 🛡️ **MLVScan Security Plugin**: Install MLVScan malware scanning plugin from GitHub releases
- 🔍 **Game Version Detection**: Automatic game version extraction from multiple sources (app.info, version.txt, Unity assets, assemblies, executable metadata)
- 📁 **Enhanced File Management**: Create directories directly in the file picker, with default download directory support
- 🔄 **Update Checking**: Check for game updates and mod updates
- 🌐 **External Integrations**: Support for Thunderstore and NexusMods mod repositories

## Prerequisites

- **Rust** (latest stable version) - https://rustup.rs/
- **Node.js** v18 or higher - https://nodejs.org/
- **DepotDownloader** installed on your system
  - Windows: `winget install --exact --id SteamRE.DepotDownloader`
  - macOS: `brew tap steamre/tools && brew install depotdownloader`
  - Linux: Download from [GitHub releases](https://github.com/SteamRE/DepotDownloader/releases)

## Installation

1. Install Tauri CLI:
   ```bash
   npm install -g @tauri-apps/cli
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Build the application:
   ```bash
   npm run tauri build
   ```

## Development

Run in development mode:
```bash
npm run tauri dev
```

## Project Structure

```
simmrust/
├── src-tauri/          # Rust backend
│   ├── src/
│   │   ├── commands/   # Tauri command handlers
│   │   ├── services/    # Business logic
│   │   ├── utils/       # Utilities
│   │   ├── types.rs     # Type definitions
│   │   └── main.rs      # Entry point
│   └── Cargo.toml
├── src/                 # React frontend
│   ├── components/      # React components
│   ├── services/        # API client & events
│   └── types/           # TypeScript types
└── package.json
```

## Architecture

- **Backend**: Rust with Tauri 2.0 framework
- **Frontend**: React with TypeScript (Vite)
- **Communication**: Tauri commands + Tauri events (replaces WebSocket)
- **Data Storage**: JSON files in platform-specific data directory
- **External APIs**: GitHub Releases, NexusMods API, Thunderstore API

## Key Integrations

### MelonLoader
- Automatic installation from GitHub releases (LavaGang/MelonLoader)
- Version selection and management
- Support for Windows x64 builds

### S1API (Schedule I API)
- Installation from GitHub releases (ifBars/S1API)
- Automatic version tracking
- Runtime-aware installation (Mono/IL2CPP)

### MLVScan
- Security plugin installation from GitHub releases (ifBars/MLVScan)
- Supports both DLL and ZIP asset formats
- Automatic malware scanning for mods

### Game Version Detection
The application automatically extracts game versions from multiple sources:
- `app.info` files (text and binary formats)
- `version.txt` files
- Unity binary assets (`globalgamemanagers`)
- Unity game assemblies (`Assembly-CSharp.dll`)
- Executable metadata (PowerShell and binary search)

## Migration from Node.js Version

See [assets/plan/migration-guide.md](assets/plan/migration-guide.md) for detailed migration instructions.

## Recent Updates

### Version 2.0 Features
- ✅ **MLVScan Integration**: Install malware scanning plugin directly from GitHub
- ✅ **S1API GitHub Installation**: Install S1API from GitHub releases with version selection
- ✅ **MelonLoader GitHub Installation**: Install MelonLoader from GitHub releases
- ✅ **Game Version Extraction**: Automatic version detection from multiple sources
- ✅ **Directory Creation**: Create folders directly in the file picker UI
- ✅ **Default Download Directory**: Configurable default directory (defaults to `~/SIMM`)
- ✅ **Update Detection**: Automatic update checking for games and mods
- ✅ **Thunderstore Integration**: Search and download mods from Thunderstore
- ✅ **NexusMods Integration**: API key validation and rate limit checking

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

