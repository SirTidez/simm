# Changelog

## [0.7.8]

- Added managed MLVScan integration for protected downloads, including automatic scanner setup, status reporting, local security scans for `.dll` / `.zip` / `.rar` payloads, and report-driven block / confirm decisions before files enter the library.
- Surfaced MLVScan results across the desktop UI with security badges, full report overlays, scanner controls in Settings, and library / installed-mod flows that can retry after an explicit user confirmation when policy allows it.
- Hardened the release with follow-up fixes for update-check inference, ZIP extraction safety, storage path validation, cached security-report handling, grouped runtime scan summaries, and CI-facing frontend timing regressions.
- Contributors:
  - `ifBars`: MLVScan scanner integration, security policy/report plumbing, overlays, badges, and scanner-facing UI.
  - `SirTidez`: follow-up hardening and CI fixes, including update-check inference, archive/path safety, symlink/install correctness, grouped scan summary handling, and flaky test cleanup.

## [0.7.7]

- Corrected environment update detection so same-track installs no longer invert their update state after a branch release, including beta / alternate-beta paired runtime inference and stale update-field clearing.
- Fixed persisted update-check state so stale `updateGameVersion` data is cleared correctly and single-environment checks use the same backend persistence rules as batch checks.
- Removed the temporary manual Nexus browser fallback from the Accounts view after confirming the report was mistaken, keeping the OAuth flow on the standard in-app handoff path.

## [0.7.6]

- Polished the final desktop editor surfaces, including a redesigned Configuration editor with sidebar-driven file/raw navigation, section tabs, denser structured rows, horizontal tab overflow controls, and corrected raw-editor/full-height behavior.
- Finished the last high-traffic UI cleanup across Logs, Downloads, Accounts, and Home, tightening overflow handling, flattening redundant cards, and improving dense desktop layout behavior for real-world data.
- Restyled app scrollbars with a softer glass treatment, removed legacy scrollbar arrows, and standardized hover-based visibility across panes and editors.
- Fixed environment creation so a user-selected install folder is used as the actual target directory instead of being forcibly renamed to the branch name.
- Improved DepotDownloader progress parsing and download display behavior so file-count progress is captured more reliably and stale placeholder file counters are no longer shown.
- Consolidated application logging into a single per-launch `SIMM-log-<timestamp>.log` file, routed more frontend/backend/external-tool output through the shared logger, and expanded sanitization/redaction coverage.
- Hardened database safety and release maintenance flows with configurable backup retention, manual backup controls in Settings, automatic pre-upgrade/pre-migration snapshots, and additional review-driven fixes across config, mod-library, and wizard behavior.

## [0.7.5]

- Completed the desktop UI refactor across the app shell and primary workspaces, replacing older modal-first and card-heavy surfaces with a docked workspace model for Home, Welcome, Wizard, Settings, Help, Accounts, Logs, Configuration, Mods, Plugins, UserLibs, and supporting dialogs.
- Rebuilt the major management views for denser desktop use, including refreshed environment cards, a compact activity-driven Downloads panel, a tighter Logs tool with improved inspector behavior, and a flatter Configuration editor with a hybrid explorer and single-sheet structured editing.
- Standardized dialog and status surfaces across authentication, confirmations, messages, MelonLoader selection, and maintenance workflows so the app now uses one consistent visual and interaction language.
- Simplified theming to built-in presets only, aligned `Modern Blue` with the current product styling, fixed startup theme flash behavior, and ensured `Light`, `Dark`, and `Modern Blue` apply consistently across the refactored shell.
- Consolidated the remaining legacy settings and account surfaces into denser desktop forms, including preset-only theme selection, a simpler Accounts identity view, and maintenance controls that fit the current app layout.
- Added unified SQLite database backups with automatic snapshots before version-upgrade or migration work, a manual backup action in Settings, and retention controls for how many backups SIMM keeps in the `SIMM/backups` directory.
- Consolidated frontend and backend logging into a single per-launch session file, improved sanitization of external tool output, and reduced log-file churn to one session log per app launch.

## [0.7.3]

- Reworked the mod management UI around grid-first cards, standardized search/discovery layouts, added in-overlay Mod View pages, and improved metadata/icon recovery across library and installed mods.
- Added log-to-library navigation so log entries can jump directly into the relevant mod view, with supporting log pane filtering and naming fixes.
- Replaced the NexusMods API-key download flow with OAuth-based account login, account tier/capability display, deep-link handling, and premium/free-aware download behavior.
- Added Nexus free-user website-confirmation support, `nxm` handoff handling for Schedule I while SIMM is open, runtime prompting including `Both`, and tighter library linking for multi-file Nexus downloads.
- Polished the mod library presentation with source badges, immediate refresh after Nexus/manual downloads, and improved title/badge layout behavior.
- Fixed frontend CI/typecheck regressions in the mod overlays and updated GitHub Actions Node/npm install steps to be more reliable without a committed npm lockfile.

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
