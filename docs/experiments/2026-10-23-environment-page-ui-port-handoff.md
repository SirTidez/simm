# Console and status integration into the new environment pages

The owner requested a recoverable stash of the current work before merging another developer's UI PR into beta. At checkpoint time, the PR was awaiting checks and the instruction was to leave the merge to the owner. The owner subsequently authorized squash-merging PR #33 and porting the feature. See [the port and validation record](2026-10-23-environment-page-console-port.md) for the merged commits and current results. The original stash remains intact.

## Preserve

- Native Windows MelonLoader console docking and selection, Pop out console / Dock in SIMM, original window controls when popped out, and game survival after SIMM closes.
- Steam launching and process-aware, nonmodal launch confirmation. Do not replace the Steam route or add hide-console arguments.
- Per-environment View options: sidebar sections, width and auto-open. Existing app-wide values seed each environment once; saves remain independent.
- Console/Logs shared session details, profiles, game/runtime/version information, Close Game confirmation, local mod/plugin author/version/enabled state, and automatic inventory refresh.
- Warning/error totals, source attribution and clickable mod/plugin counts that open Logs with the correct source aliases and severity. Preserve multiline messages and exclude only the exact expected interop startup notice from actionable warnings.
- Local DLL metadata and automatic updates in installed mods/plugins and the shared library.

## Fit to the supplied environment-page layout

The screenshot has a persistent environment list, one selected environment header, and Overview / Mods / Plugins / UserLibs / Config / Logs tabs. Integrate this feature inside that environment workspace:

1. Add Console beside the existing Logs tab. Retain the new shell, header and tab styling. Remove the need for a separate top-level Environment Status tool/page.
2. Reuse the environment's existing Logs surface and filters. Count clicks select that environment and its Logs tab rather than opening a second workspace or viewer.
3. Host the session/inventory details beside Console and Logs, with independent scrolling. Reuse Overview metadata rather than building another environment header.
4. Put View options in the environment page's console/status controls, retaining environment-specific persistence. Place Pop out console / Dock in SIMM in the Console toolbar and preserve a reachable, confirmed Close Game action.
5. Auto-open after a launch should select the launched environment's Console tab. Disabled auto-open must leave the current page alone. Changing environment or tab must hide only the docked companion, never close the game; a popped-out console must remain independent.
6. Carry author/version/enabled-state enrichment and per-source counts into the new Mods/Plugins views, following their row/component style.

These are integration targets, not a claim about the uninspected PR's component names or final design. Inspect its routing, environment page, tab components, log viewer and inventory ownership before making changes.

## Where the implementation lives in the checkpoint

- `src/components/NativeConsoleWindow.tsx`, `NativeConsoleMessages.tsx`, `src/native-console.css`: existing view, controls and sidebar. Recompose these into the new environment page; do not transplant the old App shell/styles wholesale.
- `src/hooks/useNativeConsoleSession.ts`, `useNativeConsoleViewport.ts`: serialized inventory/session observation, stale-poll protection and native viewport visibility/geometry.
- `src/components/LogsOverlay.tsx`: embedded log viewer, source/severity focus and sidebar inspector. Prefer adapting/reusing the new UI's Logs view if the PR changes it.
- `src-tauri/src/services/native_console.rs` and `native_console/`: lifecycle, per-environment preferences, native controller/guard and message diagnostics.
- `src-tauri/src/services/melon_log.rs`, `melon_metadata.rs` and `melon_metadata/`: shared explicit MelonLoader header parsing and local assembly metadata.
- `src-tauri/src/commands/native_console.rs`, `commands/filesystem.rs`, command registration, `src/services/api.ts`, `src/services/events.ts` and Rust/TypeScript types: contracts and automatic opening after launch.
- Mod/plugin services, filesystem watcher, snapshot cache, library store and affected views: local inventory refresh and metadata integration.

The stash also contains Node/tooling/security changes and launch-copy adjustments from this session. Review those independently when restoring. The base commit already includes Steam-launch/startup fixes. Prefer selective application and conflict review over a blind stash pop onto the redesigned UI. Keep the stash until the port and validation are accepted.

## Validation baseline and remaining gate

Before checkpointing, the current feature passed 535 frontend tests, 674 Rust tests with 10 existing ignored tests, TypeScript, lint (27 advisory warnings, no errors), frontend build, Cargo check, custom-protocol desktop build and IPC command checks. Real Steam/IL2CPP testing verified the same game/console through pop-out, move/resize, minimize/restore, selection/redock, navigation, SIMM close/restart, and Close Game from Logs. Native console producers and test mod/plugin injection must not be used for visible validation.

The test game and isolated app were closed. DLL/configuration hashes matched their original baseline. Ignored command receipts, test data and captures remain under `target/diagnostics/`; tracked/untracked source, tests, fixtures and experiment documentation are included in the stash.

After porting, run the complete AGENTS.md frontend/backend validation sequence and repeat real Tauri/Steam tests on the new page, including 1080p/1440p/4K layouts, tab/environment changes, independent View options, source-filtered Logs, popup/redock, auto-open disabled/enabled and game survival. Mono and Linux/Proton runtime acceptance remain separate from Windows/IL2CPP proof.

The remaining integration gate is the actual new UI code on the intended beta base, followed by implementation and validation. The screenshot alone is not sufficient to complete that port.
