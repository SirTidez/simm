# Automatic local inventory refresh

## Change

Installed Mods, Plugins, and Mod Library now follow local DLL changes through the shared filesystem/event infrastructure. No foreground polling or Refresh click is required.

- Environment Mods watchers publish complete inventory snapshots after a quiet period. Installed Mods applies the declared name, author, version, and disabled state from those snapshots. A newer snapshot invalidates an older in-flight request, and late subscription registration is cleaned up after unmount.
- Plugins subscribes to its environment's plugin-change events. Refreshes retain the last inventory while reading, coalesce overlapping events into one follow-up, and reject results from older requests or environments.
- Shared storage has a recursive library watcher and a centralized `mod_library_changed` event. Backend cache invalidation completes before publishing filesystem edges, including plugin-only and UserLib changes. The shared library store refreshes all consumers and retains a trailing invalidation when a change arrives during a scan.
- Watchers retain their registration on repeated reads, follow library directory changes in Settings, and watch an existing parent to detect creation/replacement of the logical Mods root. Staging trees, source-archive activity, read events, and access-time changes do not invalidate shared library inventory.
- The backend library cache includes the storage path. Startup cache seeding cannot replace a newer inventory snapshot.

The existing trailing filesystem debounce is 350 ms. Environment mod snapshots use the existing 250 ms refresh scheduling. DLL parsing stays on blocking workers and uses the static metadata reader from the preceding extraction work. Managed ownership and remote package identity are unchanged.

A watcher-registration failure is logged without blocking app startup, an otherwise readable library, or a successfully saved setting.

## Validation

Completed the required frontend sequence (`bun install`, TypeScript, lint, tests, build) and backend checks/tests. Final results: 523 frontend tests passed; 669 Rust tests passed with 10 intentionally ignored. Lint retains 27 advisory warnings and no errors. IPC contract scanning found no frontend calls without registered commands.

New tests cover late initial responses, metadata and disabled-state updates, subscription cleanup, unrelated environment events, in-flight trailing refreshes, library events, watcher relocation/filtering, and startup seeding races. Initial test compilation found incorrect matcher/path arguments; those were corrected before the successful runs.

Built the actual custom-protocol Tauri app and tested with isolated app data and copies of real SimpleHealthBar and Save Expansion DLLs. Schedule I remained closed. All mutations were confined to the validation directory.

Verified without clicking Refresh:

1. Creating a previously missing environment Mods folder and adding a DLL updates Installed Mods.
2. Replacing its bytes changes the displayed name, author, and version from SimpleHealthBar / iTidez / 1.5.2 to Save Expansion / SirTidez / 1.0.1.
3. Renaming `.dll` to `.dll.disabled` changes the status and inspector action to Enable; renaming back restores Disable.
4. Adding and removing another DLL updates the list.
5. Replacing a library DLL updates its row despite a populated backend cache.
6. Enable/disable renames update the cached library file inventory. The library detail page renders metadata rather than DLL filenames; an initially incorrect filename-label assertion was corrected to verify the inventory contract.
7. Replacing a DLL while its library detail page is open updates the page's name, author, and selected version.
8. Removing/restoring the library root and removing/restoring an entry refreshes the library. SIMM recreates a missing empty storage root, which the restoration test accounts for.
9. Changing the configured library directory refreshes the view and observes subsequent DLL changes in the new directory.
10. A 2.5-second idle observation after the changes received no inventory-change events, checking for a metadata-read refresh loop.

The isolated app was closed after review. No synthetic console or game process was launched. Native plugin rendering is covered by component/service tests rather than a live game/plugin session. Linux runtime behavior has not been exercised in this run.

Evidence: `target/diagnostics/local-auto-refresh-ui/` contains desktop screenshots and the mods, library, lifecycle, and idle results. Full CI logs are in `target/diagnostics/native-console-integration/local-auto-refresh-validation/`; final backend rechecks are in `target/diagnostics/local-auto-refresh-final-*.log`.
