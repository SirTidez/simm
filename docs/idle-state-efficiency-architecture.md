# Idle-State Efficiency Architecture

Status: implementation-aligned reference for `feature/idle-state-efficiency`

This document defines how SIMM should keep durable state correct while avoiding
repeated database and filesystem work when the application is idle. SQLite
remains the durable authority; process memory is the runtime read model.

## Baseline and scope

The observed idle trace had the following recurring cadence:

| Query family | Per minute | Ten-minute sample |
| --- | ---: | ---: |
| `SELECT data FROM settings WHERE id = ?` | 3 | 30 |
| `SELECT id, data FROM environments` | 3 | 30 |
| `SELECT environment_id, file_name, data FROM mod_metadata WHERE kind = 'mods'` | 2 | 20 |
| Total reads | **8** | **80** |

The sample contained no `INSERT`, `UPDATE`, or `DELETE` statements. A
`rows_affected` value attached to a `SELECT` is not evidence of a write. The
cadence is produced by the game-update scheduler and the maintenance loop in
`src-tauri/src/services/app_init.rs` and
`src-tauri/src/services/runtime_update_scheduler.rs`.

The implementation removes the fixed one-minute cadence. During an unchanged
idle window, settings reads are served from runtime state; environment reads
occur only when the deadline scheduler computes a due check (or after an
explicit action or the 30-minute fallback), and mod reconciliation has a
30-minute safety-net sweep.
Startup, a user action, an external file change, and a manual refresh are active
work and are measured separately.

## Cost model

SQLite execution time in the sample was only a few microseconds per query. That
is useful evidence, but it is not the whole cost:

- **Database cost:** connection acquisition, JSON deserialization, SQLite
  scheduling, and repeated reads of the same rows.
- **Filesystem cost:** directory enumeration, metadata reads, symlink checks,
  and reconciliation of managed files. This grows with the mod library and is
  not represented by the SQL elapsed time.
- **Wakeup cost:** the baseline had two tasks waking every minute even when no
  work was due, often at the same instant. The implementation replaces those
  fixed maintenance wakeups with deadlines and events.
- **Log cost:** SQL debug output creates eight recurring lines per minute in
  the baseline, obscuring meaningful activity and increasing log I/O.

Performance validation must report these dimensions separately. A fast SQL
query does not make an unnecessary filesystem scan or task wakeup free.

## Runtime settings cache

At application preparation, seed `RuntimeSettingsState` with defaults, load the
single `settings` row through the existing settings normalization and migration
path, and replace the seed with the durable snapshot. `RuntimeSettingsState`
contains an `Arc<RwLock<Settings>>`, a save mutex, and a versioned Tokio
`watch` channel. Background services and commands read that snapshot; they do
not construct a new `SettingsService` solely to reread the row. This cache is
used by the idle-facing scheduler, settings commands, environment/mod snapshot
paths, and other converted services; one-shot credential, theme, migration,
test, and fallback paths may still use `SettingsService` directly.

The cache contract is:

1. SQLite is authoritative across launches. Memory is disposable and is
   repopulated from SQLite during startup.
2. A read returns a cheap clone or immutable snapshot and performs no database
   I/O.
3. A partial settings update is serialized with other updates. It merges into
   the latest in-memory snapshot, persists one complete JSON document with the
   existing upsert, replaces the in-memory snapshot only after the database
   operation succeeds, and increments the change version.
4. Logger configuration and other runtime side effects are applied from the
   committed snapshot, not from an uncommitted request. A failed write leaves
   the previous memory snapshot active.
5. Relevant consumers receive the versioned change notification after commit.
   The version is retained by the `watch` channel, so a change that happens
   just before a scheduler waits cannot be lost. There is no settings polling
   timer.
6. `repair_database` reloads settings from SQLite only after the durable repair
   succeeds, replaces the runtime snapshot, reapplies logger settings, and
   emits a new change version. Direct out-of-process edits are intentionally
   not detected by a background poll; another durable-recovery path must use the
   same explicit reload step.

Secrets remain in the existing separate secrets service and are not copied into
the general settings cache. The runtime-state tests cover concurrent partial
updates, failed-write non-publication, retained change versions, and the
explicit repair reload behavior.

## Deadline-driven update scheduler

The scheduler is event- and deadline-driven rather than a fixed one-minute
interval:

- On each loop it reads the runtime settings snapshot. If automatic checks are
  disabled, it skips the update coordinator before loading environments and
  waits for a state change.
- When enabled, it invokes `run_background_update_checks` immediately at
  startup and after a wake. The coordinator loads current environments, checks
  which are due using `update_check_interval`, and persists/emits results.
- After a run, the scheduler reloads the current environment list to calculate
  the earliest next deadline. It sleeps until that deadline, or wakes early
  from the versioned settings-change channel or the central versioned
  environment-change channel. A temporary environment-query failure uses a
  five-minute retry delay rather than a tight loop.
- `UPDATE_CHECK_RUN_LOCK` serializes background, tray, single-environment
  manual, and all-environments manual runs. A concurrent request waits for the
  active coordinator instead of overlapping it.
- Manual checks bypass due-time filtering but use the same coordinator guard.

`EnvironmentService` calls the central `notify_environment_changed()` seam
after durable environment mutations. Command paths also call
`request_reschedule` where an app handle is available. Settings saves and
repair reloads increment the runtime settings version. These notifications
invalidate the scheduler's wait without reintroducing polling.

## Startup-only legacy migration

Legacy symlink-backed mod migration runs once from `initialize_services`, before
environment watchers are started. It is not part of the recurring maintenance
loop. A successful migration is never retried every minute. If it fails, the
implementation preserves the data and logs a warning; a later application
startup can retry it, but there is no implicit per-minute retry or completion
marker in this path.

## Reconciliation and fallback strategy

Run a full tracked-mod reconciliation once at startup. Thereafter:

- A debounced `mods` filesystem event requests targeted reconciliation for its
  environment. The `plugins` and `userlibs` watcher paths emit their UI events
  but do not run this mod-metadata reconciliation.
- The startup and fallback paths call one tracked-state reconciliation pass at
  a time and derive the shared storage path from the cached runtime settings
  snapshot. The implementation does not claim that every database collection
  used by unrelated operations is loaded once and shared globally.
- A deliberately slow full-scan fallback starts after 30 minutes and repeats
  every 30 minutes, with missed ticks skipped. It covers missed or out-of-band
  changes while SIMM remains open; there is no separate resume hook.
- Targeted snapshot refreshes are coalesced per environment. If another
  request arrives while a snapshot pass is in progress, one follow-up pass is
  retained rather than starting an unbounded set of workers. Errors are logged
  and remain covered by the next fallback sweep.

## Watcher debounce

`notify` can emit several events for one copy, extraction, or editor operation.
`FileSystemWatcherService` maintains one pending generation per
`(environment, watch kind)` and uses a 350 ms trailing-edge quiet window. The
first event starts one worker; later events increment the retained generation
without starting more workers. The worker waits a full quiet window again when
the generation changes, then emits one debounced UI event for the final batch.

For a `mods` batch, the worker also runs targeted
`reconcile_tracked_mod_state_for_environment_at` and requests the separate mod
snapshot projection refresh. `plugins` and `userlibs` batches only emit their
corresponding UI event. The projection refresher adds a 250 ms delay and keeps
one follow-up pass when a refresh is already in progress. A failed pass is
logged and the pending generation is closed if no newer event arrived; the
30-minute reconciliation fallback remains the recovery path.

## Frontend cache ownership and invalidation

`EnvironmentStoreProvider` is the sole frontend owner of the environment
snapshot. Components, including the Mod Library overlay, consume that store
instead of calling `get_environments` independently. `refreshEnvironments`
retains the latest successful result, coalesces in-flight requests, and uses a
snapshot generation to prevent an older response from overwriting a newer
local/event update. `ensureEnvironments` returns the loaded snapshot without an
IPC call. Refresh or local commit paths cover:

- create, update, or delete;
- download completion/error and runtime or branch changes;
- update-available/update-check-complete events; and
- an explicit user refresh.

The `ModLibraryStoreProvider` is the sole frontend owner of the shared library
projection. It retains the last successful result, coalesces in-flight
requests, tracks an invalidation version, and follows an invalidation that
arrives while a request is loading with one fresh request. `ensureLibrary`
returns a non-stale result without IPC; the overlay's explicit refresh path
marks the result stale before fetching.

The two filesystem events intentionally have different meanings:

- `mods_changed` is the leading edge. The store only marks the library stale
  and increments its version; it does not reload while the backend is still
  reconciling the filesystem.
- `mods_snapshot_updated` is the projection boundary. It carries the completed
  per-environment snapshot, after which the store invalidates and refreshes.

Plugins/userlibs changes, completed mod-update checks, and the transition from
running to idle for metadata refresh also request an invalidation-and-refresh.
Install, uninstall, delete, download, and explicit refresh flows do the same
through their existing command/event paths. Opening a view consumes a valid
snapshot rather than starting a polling cycle.

On the backend, `get_mod_library` uses the process-global `MOD_LIBRARY_CACHE`:
an async-protected entry with a 750 ms TTL. Mutation paths clear it after a
successful library mutation. The snapshot refresher clears it when a completed
projection is published, and also when an environment is removed or has no
output directory. This cache is separate from the per-environment
`mods_snapshot_cache`; `mods_changed` is the frontend stale edge, while backend
library-cache invalidation and `mods_snapshot_updated` establish the completed
projection boundary.

## Observability

The current implementation exposes operation-level evidence without logging
settings values or secrets:

- update runs log checked/loaded counts, manual mode, elapsed time, skip/no-due
  outcomes, and scheduler wake/wait reasons;
- the 30-minute fallback logs affected-environment count and elapsed time;
- watcher batches log environment, kind, retained generation, event count,
  duration, and outcome; and
- repair reloads and backend library-cache changes log reload/invalidation
  reasons where applicable.

SQL debug logging can remain available for diagnosis, but routine idle health
should be judged from these operation summaries and the SQL counters. If more
instrumentation is added, keep database duration, filesystem duration, wake
reason, and cache/coalescing counts distinct so a reduction in SQL is not
mistaken for a reduction in filesystem work.

## Windows verification procedure

Use a build from the target worktree and a disposable or backed-up SIMM data
directory. Start the app with SQL debug logging enabled, record the session log
path (`%USERPROFILE%\SIMM\logs\SIMM-log-*.log`, or the configured
`SIMMRUST_DATA_DIR` equivalent), and note the timestamp immediately after the
home screen becomes idle.

In PowerShell, select the current session log and capture a ten-minute window:

```powershell
$log = Get-ChildItem "$env:USERPROFILE\SIMM\logs\SIMM-log-*.log" |
  Sort-Object LastWriteTime | Select-Object -Last 1
$before = (Get-Content -LiteralPath $log.FullName | Measure-Object).Count
Start-Sleep -Seconds 600
$window = Get-Content -LiteralPath $log.FullName |
  Select-Object -Skip $before
$window = $window |
  Where-Object { $_ -match 'db\.statement|settings|environments|mod_metadata' }
$window | Select-String 'SELECT data FROM settings' | Measure-Object | Select-Object Count
$window | Select-String 'SELECT id, data FROM environments' | Measure-Object | Select-Object Count
$window | Select-String 'SELECT environment_id, file_name, data FROM mod_metadata' |
  Measure-Object | Select-Object Count
$window | Select-String '\b(INSERT|UPDATE|DELETE)\b.*(settings|environments|mod_metadata)' |
  Measure-Object | Select-Object Count
```

For a live process, use `Get-Content -Wait` in a second PowerShell window or
export the log after stopping the app. Exclude startup and deliberate user
actions from the measured interval. The post-change idle result should show
zero recurring settings reads/writes and no one-minute environment or
mod-metadata cadence; a longer fallback sweep is acceptable only at its
documented deadline. Compare operation summaries to SQL lines so a reduction
in SQL is not mistaken for a reduction in filesystem work.

Finally, exercise the lost-update check in the same disposable profile: issue
two concurrent partial settings saves for different fields, wait for both
success responses, restart SIMM, and read the settings once. Both fields must
survive, the log must show two committed writes (or the implementation's
documented serialized equivalent), and no failed save may appear as a published
cache generation. Restore or delete the disposable profile after verification.
