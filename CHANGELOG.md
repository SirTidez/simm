# Changelog

## [0.7.1]

- Migrated NexusMods and Thunderstore handlers to crate-only integrations in the Tauri backend service layer.
- Removed the temporary API handler feature flag and deleted legacy direct HTTP fallback paths from app services.
- Integrated new crate capabilities for Nexus detailed API key validation (premium/supporter flags), rate-limit extraction, and file download flows.
- Integrated new Thunderstore absolute URL download support through crate APIs.
- Switched crate dependencies from local path references to pinned git revisions:
  - `https://github.com/SirTidez/nexusmods-api-handler`
  - `https://github.com/SirTidez/thunderstore-api-handler`
- Updated integration docs and smoke matrix to reflect full crate coverage and crate-only runtime behavior.

## [0.6.1]

- Integrated cumulative workspace redesign scope from T01-T05 (five sequential LARGE bumps) and finalized release integration in T06 (SMALL).
- Replaced modal-first navigation with a docked single-workspace host, compact environment sidebar mode, and explicit back-to-home flow.
- Shipped docked panel conversions for mods, tooling, system, and onboarding views with unified workspace styling.
- Finalized custom titlebar behavior support for desktop ergonomics (drag region + window controls) within the redesigned shell.
- Retained roadmap carry-forward for developer-gated tabbed workspace mode.

## [0.1.0]

- Initial release with full feature set
- Multi-branch environment management
- Mod and plugin management
- MelonLoader, S1API, and MLVScan integration
- Thunderstore and NexusMods support
- Game version detection
- Config file management
- Log viewing and management
- Custom theme support
