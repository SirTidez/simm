# Automatic status inventory refresh — 2026-10-22

Environment Status now refreshes its inventory when the current environment emits mods_changed or plugins_changed. Existing recursive filesystem watchers provide these events for external DLL writes, add/remove operations, and enable/disable renames; SIMM's own install/manage commands use the same event boundary.

The session hook subscribes before the initial inventory read, filters by environment ID, and combines bursts after a short quiet period. Inventory scans run one at a time. Events arriving during a scan retain a trailing pass, and delayed status polls cannot replace a newer inventory result. Automatic refresh retains the visible list while scanning and preserves the filter and inspector scroll position. Leaving the workspace cancels timers, queued work and subscriptions, including listeners that finish registering late.

The one-second status poll still reads the cached session; it does not rescan DLLs every second. Refresh inventory remains available as a manual fallback and uses the same queue. A failed scan leaves the last inventory visible and can recover on the next file event or manual refresh.

Read/access and access-time-only filesystem notifications are ignored. This prevents the metadata reader from repeatedly invalidating its own inventory on platforms that report read activity. Content writes, write-time changes and renames remain relevant, including rename events whose destination is inside the watched directory.

Automatic refresh reuses the existing observation-only session API. It does not retry docking or dispatch a game launch. Ready state stays stable during scans so the native console viewport remains attached. Steam dispatch and native recovery code are unchanged.

## Validation

Focused tests cover environment filtering, combined mod/plugin bursts, changes during initialization, serialized trailing scans, delayed poll results, environment switches, late subscription cleanup, error recovery, and rendered version/enabled-state updates without clearing the filter. A watcher test covers read suppression, content/write-time events and enable/disable or incoming renames.

The complete local CI sequence passed: bun install, TypeScript checking, lint, frontend tests, frontend build, Cargo check and Cargo tests. The frontend suite passed 505 tests across 46 files. Rust passed 647 tests with 10 existing ignored tests. Lint reported 27 advisory warnings and no errors. The custom-protocol Tauri build also passed.

The Windows runtime test used the real Tauri app with an isolated SIMM data directory and a disposable native console producer. It performed actual filesystem mutations, without emitting synthetic events or clicking Refresh inventory:

| Change | Observed sidebar result |
| --- | --- |
| Overwrite an installed mod DLL | Version changed from 2.7.1-beta.4+local to 3.4.5 |
| Disable then enable the mod by renaming it | Disabled state appeared and cleared |
| Create a previously absent Plugins directory and add a disabled plugin | Plugin appeared with version 1.8.2 and Disabled state |
| Replace the disabled plugin DLL | Version changed to 3.4.5 |
| Enable the plugin by renaming it | Disabled state cleared |
| Add a mod in a nested directory | Nested mod appeared with version 2.7.1-beta.4+local |
| Atomically replace the original mod DLL | Declared version updated to 2.7.1-beta.4+local |
| Delete the nested mod and plugin | Both entries disappeared |

All ten mutations passed, with observed UI update times between 216 and 1,360 ms. The search filter remained intact through version and status changes. Each step verified that the game process identity was unchanged and the native console remained docked. The producer retained the same console window and advanced from 89 to 183 writes during the test. No error alert appeared.

After normal SIMM exit, the producer remained alive and reached 414 writes. It was then stopped through its own test stop file. No SIMM or game-named test processes remained. No real game files were changed or real game launch dispatched. These results validate Windows filesystem-to-sidebar behavior and native session continuity; Linux notification filtering has unit coverage but was not tested in a live Linux app.

Machine-readable runtime results and cleanup evidence are in target/diagnostics/native-console-integration/status/automatic-inventory.json and automatic-inventory-cleanup.json. Full command logs are under target/diagnostics/native-console-integration/auto-inventory-validation/.
