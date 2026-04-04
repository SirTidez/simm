# PR #16 Review Findings

Confirmed against branch `0.8.0` on 2026-04-03 by reading the current code on disk.

Scope:
- PR: `#16`
- Title: `Add runtime-aware manual mod uploads and stabilize frontend builds`
- Intent: capture valid review findings for a future release
- This file is a backlog summary only; no fixes are applied here

## Confirmed Valid Findings

### 1. Backend runtime guards and cleanup are still incomplete

- `src-tauri/src/commands/nexus_mods.rs`: the cache-hit manual Nexus install path installs from existing storage without first checking whether the requested runtime is compatible with the target environment. This can bypass the newer `downloadedToLibraryOnly` behavior when the archive is already cached.
- `src-tauri/src/commands/mods.rs`: unsupported local uploads are security-scanned before the file type is rejected, so invalid extensions can fail as scan problems instead of returning the intended unsupported-file error immediately.
- `src-tauri/src/commands/mods.rs`: `find_existing_mod_installation(..., None)` still skips runtime filtering for one installation lookup, which can let one runtime satisfy another runtime’s lookup.
- `src-tauri/src/commands/nexus_mods.rs`: the downloaded temp archive is deleted on the success path, but failures from `store_mod_archive` or `install_storage_mod_to_envs` still return early and leave the archive behind.

Related review comments:
- <https://github.com/SirTidez/simm/pull/16#discussion_r3033317535>
- <https://github.com/SirTidez/simm/pull/16#discussion_r3033339752>
- <https://github.com/SirTidez/simm/pull/16#discussion_r3033339758>
- <https://github.com/SirTidez/simm/pull/16#discussion_r3033339762>

### 2. Runtime-aware storage still has two real blind spots

- `src-tauri/src/services/mods.rs`: fallback runtime detection uses `collect_storage_files()`, which strips directory context. Nested layouts like `Mods/Mono/Foo.dll` or `Mods/IL2CPP/Foo.dll` can therefore be misclassified as universally compatible.
- `src-tauri/src/services/mods.rs`: the “already installed, reuse storage” ZIP path re-materializes and rebuilds metadata from the raw stored file tree, not a runtime-filtered file set. A mixed-runtime storage entry can therefore re-link files for the wrong runtime during reuse.

Related review comments:
- <https://github.com/SirTidez/simm/pull/16#discussion_r3033339774>
- <https://github.com/SirTidez/simm/pull/16#discussion_r3033339777>

### 3. Manual upload flow still has privacy and status-reporting issues

- `src/components/ModsOverlay.tsx`: local/manual uploads still call `ApiService.searchNexusMods()` using a filename-derived token for unknown files, which leaks local mod names to a third party without explicit user opt-in.
- `src/components/ModsOverlay.tsx`: dismissing the runtime mismatch flow via cancel still records the item as `success`, which overstates what happened.
- `src/components/ModsOverlay.tsx`: mixed upload batches set the global `error` state whenever any item fails, which hides the workspace even when some uploads succeeded and a batch summary is already available.

Related review comments:
- Review body comment for `src/components/ModsOverlay.tsx` around local upload source detection
- Review body comment for `src/components/ModsOverlay.tsx` around `handleRuntimeMismatchCancel`
- Review body comment for `src/components/ModsOverlay.tsx` around batch summary vs. global error handling

### 4. Mod Library async state and install messaging still need correction

- `src/components/ModLibraryOverlay.tsx`: stale in-flight `handleLoadNexusModFiles(modId)` requests can still resolve after search pruning and repopulate removed file state.
- `src/components/ModLibraryOverlay.tsx`: `getCompatibleInstallSummary()` collapses “blocked because another version is already installed” into the same “no compatible environments” bucket used for true runtime incompatibility, so the messaging is misleading.
- `src/components/ModLibraryOverlay.tsx`: callers still show install success notices even when `installedEnvironmentNames` comes back empty, which can produce a false-positive success message when nothing was installed.

Related review comments:
- <https://github.com/SirTidez/simm/pull/16#discussion_r3033339782>
- Review body comment for `src/components/ModLibraryOverlay.tsx` around `getCompatibleInstallSummary`
- Review body comment for `src/components/ModLibraryOverlay.tsx` around `installEntryToEnvironmentIds`

### 5. Theme selection and custom theme identity handling have several correctness gaps

- `src/utils/theme.ts`: `applyThemeSelection()` will let a custom theme with id `light`, `dark`, or `modern-blue` shadow the real built-in theme.
- `src-tauri/src/services/settings.rs`: duplicate sanitized custom theme ids are not deduped, so multiple files can collapse to the same persisted `settings.theme` identifier.
- `src/components/Settings.tsx`: `getActiveBuiltInTheme()` returns `activeCustomTheme.baseTheme` verbatim, so casing/whitespace mismatches can break the preset selector.
- `src/utils/theme.ts`: `normalizeThemeSelection()` trims but does not canonicalize built-in ids, so values like `"Dark"` or `" light "` do not normalize to the built-in ids consistently.
- `src/stores/settingsStore.tsx`: the initial `Promise.all()` means optional theme-directory failures can block settings bootstrapping entirely even if `getSettings()` succeeded.
- `src/main.tsx`: bootstrap applies `modern-blue` for any unknown stored theme id, so users with custom themes can briefly see the wrong base theme before hydration.

Related review comments:
- <https://github.com/SirTidez/simm/pull/16#discussion_r3033317537>
- <https://github.com/SirTidez/simm/pull/16#discussion_r3033339779>
- Review body comment for `src/components/Settings.tsx` around `getActiveBuiltInTheme`
- Review body comment for `src/stores/settingsStore.tsx` around `Promise.all()`
- Review body comment for `src/utils/theme.ts` around `normalizeThemeSelection`
- Review body nitpick for `src/main.tsx`

## Confirmed Lower-Priority Follow-Ups

- `src/test/setup.ts`: `storageState` is shared across tests and is not cleared between cases, so this is a real source of possible order-dependent test pollution.
- `src/utils/logger.ts`: the ready/interception message still says only warnings and errors are logged even though debug forwarding was added, so the message is now inaccurate.

## Advisory Only

- `src/utils/logger.ts`: the “debug forwarding may need throttling/batching” comment is directionally reasonable, but I did not treat it as a confirmed defect on its own. It is a monitoring/performance follow-up rather than a verified correctness bug.

## Notes

- The runtime-compatibility concern in `src-tauri/src/commands/nexus_mods.rs` was reported twice in different places; it is one real issue and should be tracked once.
- The findings above were kept only if the current branch still demonstrates the behavior directly in code. Cosmetic-only suggestions and duplicate restatements were collapsed.
