# Changelog

## [0.8.5]

- Began the next UI redesign pass while refining release flow behavior, frontend contract sync, featured Thunderstore library curation, and related commit message handling.
- Expanded the redesign into a new desktop workspace shell with a Home dashboard/news feed, reusable page headers, collapsible sidebar sections, focused environment interactions, refreshed overlay layouts, and supporting UI polish across the app.
- Switched the frontend/dev workflow guidance over to `bun`/`bunx`, added project ESLint configuration, and followed up with fixes for mod source links and latest-version fallback behavior in the mods flow.
- Contributors:
  - `SirTidez`: release-flow refinement, frontend contract sync, featured SteamNetworkLib curation, and related commit-message handling. Timestamps: `2026-05-03 17:27:10 PDT`, `2026-05-03 17:49:35 PDT`, `2026-05-03 18:12:00 PDT`
  - `ifBars`: initial UI redesign work for the next release line, Home dashboard/news feed, new workspace shell and reusable page headers, collapsible sidebar navigation, `bun`/`bunx` workflow updates, ESLint setup, and mods-flow fixes for source links and latest-version fallback. Timestamps: `2026-05-04 01:38:44 PDT`, `2026-05-04 23:33:07 PDT`, `2026-05-04 23:41:24 PDT`

## [0.8.4]

- Finalized the `0.8.4` release bump by configuring FontAwesome in the app.
- Contributors:
  - `SirTidez`: `0.8.4` versioning work and FontAwesome configuration. Timestamps: `2026-04-22 22:40:35 PDT`

## [0.8.3]

- Added automatic prerequisite installation with more reliable `winget` path resolution during environment setup.
- Lazy-loaded workspace panels, replaced older icon usage with FontAwesome, and refined the desktop workspace sidebar copy and styling.
- Added a shared Thunderstore service and startup state handling while expanding Nexus Mods integration and UI behavior.
- Contributors:
  - `SirTidez`: prerequisite auto-install/`winget` fixes, lazy-loaded panels, FontAwesome adoption, shared Thunderstore startup state, broader Nexus UI integration, sidebar refinement, `0.8.3` versioning, and the branch merge that staged the `0.8.3` release line. Timestamps: `2026-04-17 23:21:29 PDT`, `2026-04-21 21:24:41 PDT`, `2026-04-22 19:24:12 PDT`, `2026-04-22 20:28:19 PDT`, `2026-04-22 21:03:42 PDT`, `2026-04-22 21:11:34 PDT`, `2026-04-22 21:25:05 PDT`

## [0.8.2]

- Centralized auth arguments, surfaced backend auth errors more clearly, and normalized release `PubDate` metadata for the `0.8.2` line.
- Contributors:
  - `SirTidez`: auth-argument cleanup, clearer backend auth errors, and `0.8.2` release metadata/versioning updates. Timestamps: `2026-04-17 12:50:23 PDT`, `2026-04-17 13:42:53 PDT`

## [0.8.1]

- Migrated app updates to the Tauri updater with release manifests, defaulted update checks to the beta channel, and tightened release validation/dev-startup behavior.
- Hardened mod installs, library flows, theme bootstrap, environment creation/download follow-up, settings autosave, update metadata propagation, and mod-removal fallback behavior.
- Expanded managed-storage mod support, Thunderstore metadata/version handling, nested DLL collection, S1API revision ordering, GitHub-backed mod updates, and Plugins/UserLibs bucket update checks.
- Locked the frontend onto the Node 22 toolchain, refreshed dependencies, and finished the `0.8.1` release with CI repair and follow-up cleanup.
- Contributors:
  - `SirTidez`: Tauri updater migration, beta-channel defaults, release-validation fixes, hardened install/library/theme flows, environment/download follow-up fixes, settings/update cleanup, Thunderstore metadata and revision handling, nested DLL collection, S1API update detection, GitHub-backed mod updates, Plugins/UserLibs update checks, final CI repair, updater URL switching, dependency/env-list/library-summary refreshes, managed-storage companion-file support, and the branch merge that staged `0.8.1`. Timestamps: `2026-04-03 23:58:37 PDT`, `2026-04-04 00:15:18 PDT`, `2026-04-04 00:31:35 PDT`, `2026-04-04 02:04:16 PDT`, `2026-04-04 02:14:08 PDT`, `2026-04-04 11:59:06 PDT`, `2026-04-04 12:23:53 PDT`, `2026-04-05 00:11:56 PDT`, `2026-04-05 00:24:04 PDT`, `2026-04-05 01:05:22 PDT`, `2026-04-09 13:02:34 PDT`, `2026-04-09 14:28:24 PDT`, `2026-04-09 14:59:32 PDT`, `2026-04-09 15:51:41 PDT`, `2026-04-09 17:19:14 PDT`, `2026-04-09 17:31:03 PDT`, `2026-04-09 17:48:51 PDT`, `2026-04-09 18:04:17 PDT`, `2026-04-12 02:41:31 PDT`, `2026-04-12 02:55:37 PDT`, `2026-04-12 03:19:22 PDT`, `2026-04-12 03:51:34 PDT`, `2026-04-12 04:06:32 PDT`, `2026-04-12 13:59:12 PDT`, `2026-04-12 23:33:58 PDT`, `2026-04-13 17:36:06 PDT`, `2026-04-13 18:17:56 PDT`, `2026-04-13 18:43:20 PDT`

## [0.8.0]

- Added custom theme support with persisted user-defined palettes, expanded theme variable coverage across the desktop UI, and matching Settings/store/test updates so custom styling survives reloads and applies consistently.
- Hardened environment persistence by healing stored environment payloads whose embedded IDs drifted from their database row IDs, and by reusing a canonical environment record when users point SIMM at the same installation path again.
- Made mod storage and install flows more runtime-aware by keeping stored archives distinct per runtime, surfacing which environments a Nexus/library install actually targeted, and disabling install actions when no compatible environments remain.
- Expanded manual mod installation so local uploads now accept `.rar` archives, support selecting multiple `.dll` / `.zip` / `.rar` files in one batch, keep each selected archive as its own install, and handle per-file runtime prompts, security confirmations, skips, and batch summaries without restarting the flow.
- Improved large-overlay stability and usability by reducing WebView churn in Mods and Mod Library, adding debounced/windowed list behavior for heavy views, and fixing stale log-source state when switching environments in the log viewer.
- Locked frontend dependencies with a committed `package-lock.json` so local validation and GitHub Actions install the same npm toolchain and produce reproducible builds.
- Contributors:
  - `SirTidez`: runtime-aware mod storage/install hardening, installed-environment reporting, `.rar` support, multi-file manual mod uploads, log-viewer environment-switch fixes, CI lockfile stabilization, release/versioning work, release merge, and funding-support follow-up. Timestamps: `2026-03-30 20:51:25 PDT`, `2026-03-30 21:24:33 PDT`, `2026-03-31 21:16:31 PDT`, `2026-04-02 16:47:37 PDT`, `2026-04-03 08:08:53 PDT`, `2026-04-03 08:27:21 PDT`, `2026-04-03 08:51:33 PDT`
  - `ESTONlA`: custom theme support, environment identity healing/canonicalization for reused install paths, and performance-oriented Mods/Mod Library overlay improvements to reduce WebView memory pressure. Timestamps: `2026-03-30 07:36:08 PDT`, `2026-03-30 09:10:46 PDT`, `2026-03-31 17:17:11 PDT`

## [0.7.9]

- Polished the mod library and workspace flow with better install targeting, selectable versions, grouped scan-report visibility, attached UserLib tracking, text wrapping fixes, and tighter navigation behavior.
- Hardened runtime-aware update summaries, local promotion handling, copied-mod source preservation, Steam manifest context, and several stale frontend test expectations.
- Captured follow-up game launch/Nexus download fixes and completed the `0.7.9` release/versioning updates.
- Contributors:
  - `SirTidez`: mod-library navigation and install-targeting fixes, workspace polish, grouped scan-report visibility, selectable versions, attached UserLib tracking, runtime-aware update summaries, copied-mod/local-promotion handling, Steam manifest preservation, stale test cleanup, and `0.7.9` release/versioning updates. Timestamps: `2026-03-27 23:12:07 PDT`, `2026-03-28 00:34:02 PDT`, `2026-03-28 00:40:16 PDT`, `2026-03-28 00:50:32 PDT`, `2026-03-28 01:27:00 PDT`, `2026-03-28 03:01:18 PDT`, `2026-03-28 13:06:55 PDT`, `2026-03-28 13:14:51 PDT`, `2026-03-28 14:59:41 PDT`, `2026-03-30 01:29:29 PDT`, `2026-03-30 03:47:01 PDT`, `2026-03-30 04:20:02 PDT`, `2026-03-30 04:36:46 PDT`, `2026-03-30 04:43:46 PDT`, `2026-03-30 04:57:18 PDT`, `2026-03-30 05:01:45 PDT`
  - `ESTONlA`: game-launch and Nexus-download follow-up fixes that fed into the `0.7.9` release line. Timestamps: `2026-03-29 14:39:34 PDT`, `2026-03-29 14:45:49 PDT`

## [0.7.8]

- Added managed MLVScan integration for protected downloads, including automatic scanner setup, status reporting, local security scans for `.dll` / `.zip` / `.rar` payloads, and report-driven block / confirm decisions before files enter the library.
- Surfaced MLVScan results across the desktop UI with security badges, full report overlays, scanner controls in Settings, and library / installed-mod flows that can retry after an explicit user confirmation when policy allows it.
- Hardened the release with follow-up fixes for update-check inference, ZIP extraction safety, storage path validation, cached security-report handling, grouped runtime scan summaries, and CI-facing frontend timing regressions.
- Contributors:
  - `ifBars`: MLVScan scanner integration, security policy/report plumbing, overlays, badges, and scanner-facing UI. Timestamps: `2026-03-12 22:05:07 PDT`, `2026-03-26 22:51:21 PDT`, `2026-03-26 23:52:00 PDT`
  - `SirTidez`: follow-up hardening and CI fixes, including update-check inference, archive/path safety, symlink/install correctness, grouped scan summary handling, and flaky test cleanup. Timestamps: `2026-03-15 02:11:05 PDT`, `2026-03-27 00:36:00 PDT`, `2026-03-27 00:44:42 PDT`, `2026-03-27 01:15:58 PDT`
  - `SirTidez`: release packaging. Timestamps: `2026-03-27 01:26:16 PDT`

## [0.7.7]

- Corrected environment update detection so same-track installs no longer invert their update state after a branch release, including beta / alternate-beta paired runtime inference and stale update-field clearing.
- Fixed persisted update-check state so stale `updateGameVersion` data is cleared correctly and single-environment checks use the same backend persistence rules as batch checks.
- Removed the temporary manual Nexus browser fallback from the Accounts view after confirming the report was mistaken, keeping the OAuth flow on the standard in-app handoff path.
- Contributors:
  - `SirTidez`: update-check inference/persistence fixes and removal of the temporary manual Nexus browser fallback. Timestamps: `2026-03-26 17:46:32 PDT`, `2026-03-26 21:17:16 PDT`

## [0.7.6]

- Polished the final desktop editor surfaces, including a redesigned Configuration editor with sidebar-driven file/raw navigation, section tabs, denser structured rows, horizontal tab overflow controls, and corrected raw-editor/full-height behavior.
- Finished the last high-traffic UI cleanup across Logs, Downloads, Accounts, and Home, tightening overflow handling, flattening redundant cards, and improving dense desktop layout behavior for real-world data.
- Restyled app scrollbars with a softer glass treatment, removed legacy scrollbar arrows, and standardized hover-based visibility across panes and editors.
- Fixed environment creation so a user-selected install folder is used as the actual target directory instead of being forcibly renamed to the branch name.
- Improved DepotDownloader progress parsing and download display behavior so file-count progress is captured more reliably and stale placeholder file counters are no longer shown.
- Consolidated application logging into a single per-launch `SIMM-log-<timestamp>.log` file, routed more frontend/backend/external-tool output through the shared logger, and expanded sanitization/redaction coverage.
- Hardened database safety and release maintenance flows with configurable backup retention, manual backup controls in Settings, automatic pre-upgrade/pre-migration snapshots, and additional review-driven fixes across config, mod-library, and wizard behavior.
- Contributors:
  - `SirTidez`: structured-editor/UI polish, updated release screenshots/assets, and `0.7.6` release/versioning updates. Timestamps: `2026-03-26 15:43:37 PDT`, `2026-03-26 15:44:28 PDT`, `2026-03-26 15:47:15 PDT`

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
