# Changelog

<<<<<<< Updated upstream
=======
## [0.8.5]

- Began the next UI redesign pass while refining release flow behavior, frontend contract sync, featured Thunderstore library curation, and related commit message handling.
- Expanded the redesign into a new desktop workspace shell with a Home dashboard/news feed, reusable page headers, collapsible sidebar sections, focused environment interactions, refreshed overlay layouts, and supporting UI polish across the app.
- Added installed-mod scan visibility, safer mod-path/security handling, and clearer UI loading states while tightening Mods and Logs behavior around the new shell.
- Polished the configuration editor, downloads, MLVScan, logs, settings, and shared shell UX while reducing rerenders and commit cost in the heaviest desktop overlays.
- Expanded the configuration catalog so SIMM now discovers nested `.cfg` and `.json` files inside the game's `Mods` directory and groups them by mod folder for clearer editor organization.
- Started the Tailwind v4 + shadcn base-nova migration with shared SIMM primitives, migrated key desktop surfaces onto the new component foundation, and added opt-in React Scan profiling for frontend performance work.
- Switched the frontend/dev workflow guidance over to `bun`/`bunx`, added project ESLint configuration, fixed mod source links and mod ownership checks, and temporarily disabled featured downloads until package data finishes loading.
- Continued the shadcn/base-nova rollout across the app shell, Mods workspace, and Mod Library while tightening modal/dialog handling, navigation-state flow, and related shell behavior.
- Added repo-local SIMM Codex workflow tooling with focused skills, playbooks, and validation helpers for desktop UI review, IPC contracts, runtime-library work, Nexus FOMOD debugging, and release updating.
- Fixed managed-mod metadata precedence so installed mods prefer package/source details correctly, and replaced time-based archive temp directories with UUID-backed paths to avoid extraction collisions.
- Finished the current CSS cleanup pass across the desktop shell and migrated surfaces, stabilizing layouts across viewports, pruning dead Tailwind-migration CSS, and aligning authentication, wizard, environment, plugin, welcome, and security-report screens with the newer shadcn/base-nova styling.
- Improved runtime resilience by handling replayed Nexus OAuth callbacks safely, detecting uploaded mod archive types from file signatures before install/update flows proceed, and protecting ZIP extraction from path traversal during mod installs.
- Tightened reviewed backend and desktop-shell behavior by preserving runtime-aware update fan-out, copied-storage ownership, installed scan summaries, rotated-log watching, security-scan overlay reset behavior, and other async/dialog polish surfaced during review.
- Pinned the validated Bun toolchain in CI/docs, aligned release metadata around that workflow, and extended archive hardening so unsafe RAR entries are rejected before extraction.
- Refined the Mod Library and Logs tools with smoother library workflows, tighter status alignment, and upward chunk loading so very large log files can be browsed without losing context.
- Fixed ModsOverlay list structure and scrolling behavior inside environment overlays, stabilizing layout/CSS so long mod lists avoid clipping and remain usable across desktop viewports.
- Hardened stored mod-state recovery by handling invalid storage metadata and metadata load failures more defensively instead of letting malformed package data break the app flow.
- Contributors:
  - `SirTidez`: release-flow refinement, frontend contract sync, featured SteamNetworkLib curation, related commit-message handling, nested Mods config catalog discovery/grouping, continued shadcn shell adoption across the app shell and mod workspaces, navigation-state and modal-flow fixes, repo-local SIMM Codex workflow tooling, managed-mod metadata precedence fixes, UUID-based temp-directory collision prevention during installs, ModsOverlay list-structure/layout CSS fixes for environment-overlay scrolling, ZIP-extraction path-traversal protection for mod installs, matching RAR-entry path-safety hardening before extraction, and defensive handling for invalid storage metadata and metadata load failures. Timestamps: `2026-05-03 17:27:10 PDT`, `2026-05-03 17:49:35 PDT`, `2026-05-03 18:12:00 PDT`, `2026-05-08 03:07:59 PDT`, `2026-05-08 19:19:22 PDT`, `2026-05-09 03:01:43 PDT`, `2026-05-09 03:14:24 PDT`, `2026-05-13 23:17:09 PDT`, `2026-05-15 03:09:17 PDT`, `2026-05-16 02:14:14 PDT`, `2026-05-16 12:27:08 PDT`
  - `ifBars`: initial UI redesign work for the next release line, Home dashboard/news feed, new workspace shell and reusable page headers, collapsible sidebar navigation, installed-mod scanning and safer path/security flows, configuration/downloads/MLVScan/logs/settings polish, Tailwind v4 + shadcn migration scaffolding, shell/log/config performance work, `bun`/`bunx` workflow updates, ESLint setup, mods/webpanel fixes for source links, ownership checks, and featured-download loading states, finished CSS cleanup across migrated shell surfaces, stabilized cross-viewport desktop layout behavior, pruned dead Tailwind-migration CSS, refined Mod Library workflows/status alignment, added replay-safe Nexus OAuth callback handling, detected mod archive formats from file signatures, enabled upward chunk loading for large logs, preserved runtime-aware update/mod-watch behavior during review fixes, tightened async/dialog/accessibility handling across reviewed UI surfaces, reset security-scan overlay state on reopen, and pinned Bun plus release metadata to the validated workflow. Timestamps: `2026-05-04 01:38:44 PDT`, `2026-05-04 23:33:07 PDT`, `2026-05-04 23:41:24 PDT`, `2026-05-06 13:14:24 PDT`, `2026-05-06 18:29:16 PDT`, `2026-05-07 11:30:58 PDT`, `2026-05-07 11:34:33 PDT`, `2026-05-07 11:38:06 PDT`, `2026-05-07 11:39:52 PDT`, `2026-05-07 11:42:23 PDT`, `2026-05-07 11:45:32 PDT`, `2026-05-07 11:47:01 PDT`, `2026-05-07 11:51:51 PDT`, `2026-05-07 16:41:55 PDT`, `2026-05-07 16:56:07 PDT`, `2026-05-07 17:08:59 PDT`, `2026-05-07 17:16:10 PDT`, `2026-05-07 17:18:19 PDT`, `2026-05-07 17:32:55 PDT`, `2026-05-07 17:40:45 PDT`, `2026-05-07 17:45:38 PDT`, `2026-05-07 17:49:35 PDT`, `2026-05-07 17:51:48 PDT`, `2026-05-07 18:02:00 PDT`, `2026-05-07 18:13:07 PDT`, `2026-05-07 18:27:20 PDT`, `2026-05-07 21:48:13 PDT`, `2026-05-07 21:54:23 PDT`, `2026-05-10 19:56:54 PDT`, `2026-05-10 19:57:04 PDT`, `2026-05-10 21:51:20 PDT`, `2026-05-10 21:53:20 PDT`, `2026-05-10 21:53:29 PDT`, `2026-05-10 22:42:03 PDT`, `2026-05-10 23:22:33 PDT`, `2026-05-10 23:27:23 PDT`, `2026-05-12 22:05:00 PDT`, `2026-05-15 16:00:35 PDT`, `2026-05-15 16:00:52 PDT`, `2026-05-15 16:01:11 PDT`, `2026-05-15 18:30:29 PDT`, `2026-05-15 18:30:37 PDT`, `2026-05-15 19:43:17 PDT`

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

>>>>>>> Stashed changes
## [0.8.0]

- Added custom theme support with persisted user-defined palettes, expanded theme variable coverage across the desktop UI, and matching Settings/store/test updates so custom styling survives reloads and applies consistently.
- Hardened environment persistence by healing stored environment payloads whose embedded IDs drifted from their database row IDs, and by reusing a canonical environment record when users point SIMM at the same installation path again.
- Made mod storage and install flows more runtime-aware by keeping stored archives distinct per runtime, surfacing which environments a Nexus/library install actually targeted, and disabling install actions when no compatible environments remain.
- Expanded manual mod installation so local uploads now accept `.rar` archives, support selecting multiple `.dll` / `.zip` / `.rar` files in one batch, keep each selected archive as its own install, and handle per-file runtime prompts, security confirmations, skips, and batch summaries without restarting the flow.
- Improved large-overlay stability and usability by reducing WebView churn in Mods and Mod Library, adding debounced/windowed list behavior for heavy views, and fixing stale log-source state when switching environments in the log viewer.
- Locked frontend dependencies with a committed `package-lock.json` so local validation and GitHub Actions install the same npm toolchain and produce reproducible builds.
- Contributors:
  - `SirTidez`: runtime-aware mod storage/install hardening, installed-environment reporting, `.rar` support, multi-file manual mod uploads, log-viewer environment-switch fixes, CI lockfile stabilization, and release/versioning work.
  - `ESTONlA`: custom theme support, environment identity healing/canonicalization for reused install paths, and performance-oriented Mods/Mod Library overlay improvements to reduce WebView memory pressure.

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
