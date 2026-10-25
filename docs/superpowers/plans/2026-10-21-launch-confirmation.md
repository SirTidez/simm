# Schedule I Launch Confirmation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Investigate the reported Steam launch regression, correct the identified handoff defect when established, and separately improve confirmation feedback and app-owned problem dialogs.

**Architecture:** First trace and compare the previous direct-with-Steam-running route with the current custom-shortcut handoff. Keep any resulting launcher fix separate from the confirmation/UI correction: a backend evidence snapshot and shared React coordinator improve feedback, while shared themed dialogs preserve existing confirmation semantics. Preserve existing verifier callers and telemetry behavior.

**Tech Stack:** Rust, Tokio, Tauri 2, React, TypeScript, Vitest, existing SIMM dialog/button/theme primitives.

**Spec:** `docs/superpowers/specs/2026-10-21-launch-confirmation-design.md`.

## Execution status: Steam handoff and process-aware confirmation

The user authorized the Steam handoff correction first, then explicitly requested process-aware confirmation and late recovery. The continuation implements independent backend observations and shared frontend ownership for both launch entry points. The detailed checklists below retain their original audit catalog; unchecked live-host checks remain acceptance limits.

- [x] Restart transaction: serialize SIMM shortcut operations, stop Steam, register while stopped, start Steam, verify the intended Windows account and retained shortcut, then dispatch. Linux prerequisite setup uses the same transaction.
- [x] Avoid writing `shortcuts.vdf` while Steam is running; request an explicit restart when registration changes are pending.
- [x] Match existing shortcuts by executable, preserving separate installations with identical folder names. Prefer the Windows active account over stale last-used metadata, and reject a conflicting `steam_appid.txt` without overwriting it.
- [x] Propagate process-inspection failures instead of treating them as a stopped client. Record local launch-request and dispatch boundaries without claiming game readiness.
- [x] Replace the remaining app-owned native warning/confirmation calls with the existing themed overlays, preserving queued decisions, cancellation and exact action scope. Native file pickers remain in use.
- [x] Observe fixture regressions fail before fixes and pass afterward. An independent review found one Important account-verification gap: absent/zero ActiveUser could still fall back to last-used metadata after restart. Corrected with a bounded positive-account wait; absent/zero, delayed login, wrong account and inspection-error tests pass.
- [ ] Verify the reported complete failure on an affected host, including Steam's actual in-memory shortcut readiness and the intended game process.
- [ ] Validate native Linux/Proton and live Tauri dialog focus/appearance at 1080p, 1440p and 4k. The local Docker Linux engine is unavailable.

Continuation scope: the earlier monitor deferral is superseded by the user request. Both GUI entry points now share a coordinator, use independent process/log snapshots every two seconds, show neutral nonmodal feedback after 20 seconds, and continue observing up to 120 seconds. A matching running process plus a fresh loader marker clears the notice without another launch. Check again reuses the original timestamp; dismissal does not stop observation. No automatic relaunch, telemetry enablement or branch change is introduced. The legacy verifier remains available to existing callers.

- [x] Extract shared Windows/Linux process discovery, retain compatibility exports, bound the owned Windows query, and preserve unknown/inaccessible outcomes.
- [x] Add independent snapshot service/command and mirrored DTO/API; use the existing freshness and marker policy with chunked reads and unchanged-log caching.
- [x] Add a shared coordinator with synchronous launch reservation, serialized snapshots, late recovery, bounded deadlines and invalidation on environment removal/path change/unmount.
- [x] Route shell and card launch actions through the coordinator and render one themed inline status host with View logs, Check again and Dismiss.
- [x] Preserve queued themed restart approval and actual dispatch-error dialogs; slow/unconfirmed observation does not open a modal.
- [x] Add deterministic late-start, deadline, concurrency, uncertainty, cancellation and telemetry-disabled regressions. Focused GUI suite and TypeScript pass; final complete validation and independent review are recorded in the execution ledger.
- [ ] Complete a real Tauri-window smoke: the isolated attempts were blocked by the occupied default port and an unrelated existing developer session locking the debug executable. That session was left untouched.

Implementation ruling: the coordinator reuses the queued app-dialog API for restart decisions instead of exposing a separate restartRequest object. It keeps the reservation while the decision is pending and rechecks attempt/environment validity before retrying. This preserves one approval mechanism and the intended cancellation scope.

Do not treat UI changes, fixture success or accepted protocol dispatch as proof that the affected-user complete launch failure is resolved.

Historical first-pass validation after the Steam review correction: the required `bun install` (no dependency changes), `bunx tsc --noEmit`, `bun run lint` (0 errors, 23 advisory warnings), `bun run test` (461 passed), `bun run build`, `cargo check --manifest-path src-tauri/Cargo.toml` and `cargo test --manifest-path src-tauri/Cargo.toml` (630 passed, 10 ignored) all exited successfully. Formatting, whitespace and IPC registration checks passed. Bun and the full Rust fixture suite required validation outside the filesystem sandbox; the latter's sandbox-only filesystem/socket failures disappeared there. Steam and Schedule I were not launched, and installed Steam/game configuration was not changed. Changes remain uncommitted on `beta`.

## Continuation validation and review

The full required sequence passed after the final status-button styling correction: `bun install` (no dependency changes), `bunx tsc --noEmit`, `bun run lint` (0 errors, 27 advisory warnings), `bun run test` (489 passed), `bun run build`, `cargo check --manifest-path src-tauri/Cargo.toml` and `cargo test --manifest-path src-tauri/Cargo.toml` (634 passed, 10 ignored). Formatting, whitespace and IPC checks passed.

The independent whole-diff review found no Critical or Important source issues. One nonblocking test improvement remains deferred: mount StrictMode outside both providers to exercise provider replay directly. The existing coordinator lifecycle and caller tests pass, and no provider defect was demonstrated.

A browser-only fixture running the actual coordinator and React status component passed at 1920x1080, 2560x1440 and 3840x2160 in modern-blue, dark and light themes. Root sizing stayed 16px; long names/paths and all actions stayed within the viewport; input focus was preserved; the 20-second state was nonmodal; late confirmation cleared it without relaunch; Check again reused the original attempt. Screenshot review caught low-contrast action styling (rendered contrast 1.11:1); standard SIMM secondary-button styling corrected it, and the rendered check passed after the change. The audit disables transitions in its fixture when measuring settled theme colors. Evidence is retained under ignored `target/diagnostics/launch-tauri-validation/`.

Native Tauri validation remains open because an unrelated existing developer session owns the debug executable; it was left untouched. Linux counterpart validation remains open; run `.\scripts\build-linux-container.cmd -Command check` when the Docker Linux engine is available, then smoke-test actual Mono/IL2CPP launches on a suitable host. Browser/fixture evidence does not establish Steam library readiness or resolution of the affected users' complete launch failure. All source changes remain uncommitted on `beta`.

## Global Constraints

- Poll every 2 seconds without overlapping requests; soft deadline 20 seconds; automatic observation deadline 120 seconds, measured after accepted dispatch.
- Preserve the original backend `launchStartedAt` as the log freshness reference.
- No automatic relaunch, process termination, Steam branch change, telemetry opt-in, uploads, new dependencies, or user timeout setting.
- `unknown` process state must not be treated as `notRunning`; a loader marker must not be treated as gameplay readiness.
- Use existing logger sanitization and UI theme primitives. Keep desktop root font sizing stable at 1080p, 1440p, and 4k.
- Preserve the existing verifier command and response compatibility for CLI/live-test callers.
- The original planning step changed no application source; implementation was subsequently authorized. Changes in this pass remain uncommitted.
- The full failure has been reported by other users and is not reproduced on the developer's PC. The delayed-log fixture proves only a confirmation timeout. Passing UI/timing checks cannot close the reported launch failure.
- Investigate Steam dispatch before selecting the launch fix. Do not silently restore the older direct route as a fallback for an explicit Steam launch; Linux/Proton and Steam-owned behavior need separate validation.
- All app-owned problem/warning dialogs must be themed, including updater and Profiles warnings. Preserve required approvals, exact target/file scope and cancellation behavior; native file/directory pickers are outside this change.

## Review Focus

- Existing shortcuts work locally while first registration fails elsewhere: test the startup/reload lifecycle and persisted-versus-loaded entry (Task 0).
- Normal Steam installs and downloaded installs take different routes: classify each affected case before attributing it to shortcuts (Task 0).

- A game starts just after 20 seconds: remain nonmodal and recover without a second launch (Tasks 2–3).
- Another environment's identically named executable runs: match by installation path (Task 1).
- Process inspection is denied or a log is temporarily unreadable: preserve uncertainty (Tasks 1–2).
- Selection changes or an old request completes late: retain the original environment identity and ignore superseded results (Task 2).
- Telemetry is disabled or the user dismisses a notice: launch observation still works and expires on schedule (Tasks 1–3).

## File responsibilities

| File | Responsibility |
| --- | --- |
| `src-tauri/src/services/filesystem.rs`, `src-tauri/src/commands/filesystem.rs` | Primary Steam handoff investigation, local trace boundaries and regression-specific tests/fix selected by Task 0 |
| `src-tauri/src/services/game_process.rs` (new) | Shared Windows/Linux process discovery and per-installation observation |
| `src-tauri/src/services/game_session_monitor.rs` | Consume the shared discovery helper while preserving telemetry preference behavior |
| `src-tauri/src/services/melon_loader.rs` | Reuse existing log inspection for a single observation and legacy waiting verifier |
| `src-tauri/src/commands/melon_loader.rs` | Thin `inspect_game_launch` IPC command |
| `src-tauri/src/types.rs`, `src/types/index.ts` | Mirrored process/loader snapshot DTO |
| `src-tauri/src/services/mod.rs`, `src-tauri/src/main.rs`, `src/services/api.ts` | Service/command registration and API wrapper |
| `src/stores/gameLaunchStore.tsx` (new) | Shared launch provider, attempt identity, deadlines, deduplication, logging and notice dismissal |
| `src/stores/gameLaunchStore.test.tsx` (new) | Fake-clock state-machine and lifecycle regressions |
| `src/components/GameLaunchStatus.tsx` and `.test.tsx` (new) | Themed nonmodal startup status and diagnostics actions |
| `src/components/App.tsx`, `src/components/EnvironmentList.tsx` and their tests | Delegate both launch buttons and replace launch-related native dialogs |
| `src/style.css` | Compact status surface using existing theme variables |
| `src/components/AppDialogProvider.tsx` and `.test.tsx` (new), `src/components/ProfilesWorkspace.tsx` and tests | Shared themed problem/confirmation dialogs with unchanged approval semantics |

### Task 0: Establish the Steam handoff regression before choosing its fix

**Files:** `src-tauri/src/services/filesystem.rs`, `src-tauri/src/commands/filesystem.rs`, the design document, and isolated launch fixtures under ignored `target/diagnostics`.

**Inputs/evidence:** `v0.8.5-beta` starts a custom executable with Steam running and explicit app-ID variables. Commit `a3c2a3d`, present from `v0.8.6`, replaces that route with a registered non-Steam shortcut. Commit `da139e8`, also between those tags, adds the warning. The main Steam environment normally uses the app-ID route without custom-shortcut registration.

**Deliverable:** a named failing stage, captured observations and a regression test for the selected launcher correction; or an explicit still-unreproduced finding if evidence is insufficient. The separate themed-dialog task can proceed independently, but is not the game-launch fix.

- [ ] Preserve the user's clarification in all findings: local startup eventually succeeds; affected users report full failures; the delayed-log fixture did not reproduce their failure.
- [ ] Trace a launch from GUI selection to environment classification, effective method, selected executable/working directory, selected Steam configuration/account, shortcut entry and computed URL, reload marker, Steam restart/readiness, URL dispatch and matching game-process appearance. Record unknown observations as unknown. Log only local sanitized diagnostics, with no credentials or complete Steam-account details.
- [ ] Build fixture cases for new/unchanged/updated shortcuts, a simulated Steam rewrite on shutdown, process-start inspection failure, mismatched account selection, duplicate folder names on different paths, an externally changed entry, delayed Steam readiness, and URL-handler success followed by simulated Steam rejection. Keep tests off the real Steam files and processes.
- [ ] Recheck the restart ordering contract: shortcut registration currently occurs before shutdown, and the saved ID is launched after restart without checking the entry again. Verify whether the fixture loses that entry and whether the implementation detects it. Include other custom-shortcut setup callers, including Linux prerequisite preparation, in the call-site audit.
- [ ] On a suitable test/affected host, compare the same game content, runtime, MelonLoader files, mods and Steam account using: the old direct-with-Steam-running mechanism; the current SIMM shortcut route; and Play on the corresponding Steam Library entry. Use isolated SIMM configuration/database state; do not downgrade a live database or change the primary Steam branch. Any Steam shutdown or game launch must be deliberate, with the user's active work preserved.
- [ ] Cover this matrix: main versus downloaded install; pre-existing versus newly registered shortcut; Steam initially open versus closed; ordinary launch versus explicit restart; matching versus uncertain active account. Begin with bounded attempts and record progress rather than repeatedly retrying unchanged conditions.
- [ ] Correlate each attempt with Steam's `console_log.txt` action and intended game process. Distinguish no process, early exit, continuing process with delayed loader, and loader confirmation. A successful OS protocol call is only dispatch acceptance.
- [ ] Select the smallest fix from the failing contract. For a lost-registration case, verify the stop-Steam → register/verify while stopped → start-Steam → launch sequence. For another cause, use its own failing fixture; do not bundle an unproven route rollback.
- [ ] Re-run the same failing scenario, its working controls and counterpart-platform checks. Keep affected-host acceptance open until the true game-start failure is addressed; report feedback/UI improvements independently.

### Task 1: Expose independent launch evidence

**Interfaces:**

- Add Rust/TypeScript `GameLaunchInspection` with camelCase fields: `environmentId`, `launchStartedAt`, `processState`, `loaderState`, `logPath`, `modifiedAt` (nullable), and `diagnostic` (nullable).
- `processState`: `running | notRunning | unknown`.
- `loaderState`: `confirmed | notInstalled | noLog | staleLog | noConfirmation | unavailable`.
- Add `ApiService.inspectGameLaunch(environmentId: string, launchStartedAt: number): Promise<GameLaunchInspection>` calling `inspect_game_launch` with those two arguments.
- The command resolves the environment directory from the database and returns one observation. It does not launch the game, wait for a deadline, or enable telemetry.
- Extract the existing `running_schedule_directories` and path-normalization helpers into `game_process.rs`. Keep compatibility re-exports from `game_session_monitor.rs` for existing internal callers. Add `inspect_game_process(game_dir: &Path)` returning the tri-state observation and an optional diagnostic.
- Expose a single log-observation method from `MelonLoaderService`; use the same predicate and freshness tolerance in this method and `verify_launch_after`.

- [ ] Write backend regressions: correct directory running; another directory running; inaccessible executable path; process query error; fresh/stale/partial/missing/unreadable log; missing loader installation; telemetry collection disabled. The last case must exercise launch inspection without starting telemetry or touching preferences.
- [ ] Run the new targeted tests and verify they fail because the new interfaces do not yet exist.
- [ ] Implement the extraction and snapshot command. Bound owned process-query subprocesses to 5 seconds with cleanup; never kill the game. Avoid rereading an unchanged full log on every poll; preserve the legacy predicate and add a large-log regression for any bounded or incremental reader chosen.
- [ ] Register the command and mirror DTOs/API. Preserve legacy `verify_melonloader_launch` behavior and tests. Add a delayed-write verifier regression using Tokio fake time or an injected clock rather than a 20-second CI sleep.
- [ ] Run `cargo test --manifest-path src-tauri/Cargo.toml game_process`, `cargo test --manifest-path src-tauri/Cargo.toml launch`, and `bunx tsc --noEmit`. Require passing targeted tests and no TypeScript errors before Task 2.
- [ ] Review the diff as one backend evidence/API change; commit only this scope if committing is authorized at implementation time.

### Task 2: Coordinate one launch attempt across the GUI

**Interfaces:**

- Add `GameLaunchStoreProvider` and `useGameLaunchStore()` in `src/stores/gameLaunchStore.tsx`, mounted inside `EnvironmentStoreProvider` around the existing app content.
- Export `requestLaunch(environment: Environment, method: 'steam' | 'steam_restart' | 'direct'): Promise<void>`, `checkAgain(environmentId: string): void`, and `dismissNotice(environmentId: string): void` through the context.
- Expose `attempts: ReadonlyMap<string, GameLaunchAttempt>` and `restartRequest` for a themed explicit Steam-restart decision.
- `GameLaunchAttempt` captures `attemptId`, `environmentId`, `environmentName`, `outputDir`, `method`, original `launchStartedAt`, observation-window start, latest snapshot, `noticeDismissed`, and state `dispatching | checking | slow | confirmed | unconfirmed | exited | failed`.
- A dispatch rejection is `failed`; a successful launch request begins `checking`. Deadline expiration is `unconfirmed`. A loader marker plus a matching running process is `confirmed`; without installed loader, matching process presence is enough, without loader-success copy. Unknown process state stays qualified.
- After an observed process is absent in two consecutive snapshots, transition to `exited` with the spec's neutral copy. Do not infer a crash.

- [ ] Add fake-clock tests for snapshots at 0, 2, and 20 seconds: exactly one dispatch and serialized snapshots; at 20 seconds state is `slow`, with no native dialog or terminal failure.
- [ ] Test a fresh marker and matching process after 22 seconds: state becomes `confirmed`, pending notice clears, and launch call count stays one.
- [ ] Test the 120-second deadline for running, never-observed, unknown and exited processes; stale logs cannot confirm; log errors retain diagnostics; process absence cannot be hidden by a marker.
- [ ] Test shell/card simultaneous requests for one environment, selection changes, removal/path change, provider unmount, in-flight late results and replaced attempts. Assert no duplicate dispatch, incorrect environment labels, late state writes or timer leaks.
- [ ] Test dismissal without cancelling observation and `checkAgain` reusing the original launch timestamp with a fresh bounded window and no dispatch. Before an explicit later launch, recheck running/unknown state and surface uncertainty rather than launching blindly.
- [ ] Implement the provider with a synchronous per-environment reservation before the first await, monotonically unique attempt identities and non-overlapping 2-second polling. Log state transitions locally rather than every polling tick.
- [ ] Run `bun run test -- src/stores/gameLaunchStore.test.tsx` and `bunx tsc --noEmit`; require all new regressions to pass.
- [ ] Review this shared state-machine change independently; commit this scope only if authorized.

### Task 3: Theme all app-owned problem dialogs

**Files:** create `src/components/AppDialogProvider.tsx` and `.test.tsx`; modify `src/components/App.tsx`, `src/components/ProfilesWorkspace.tsx` and their tests. Reuse the current dialog primitives and button/theme system.

**Interfaces:**

- Provide `useAppDialogs()` with `showMessage(options): Promise<void>` and `confirm(options): Promise<boolean>`, using typed title, message, tone and action-label options. Mount the provider around `AppContent` so both the shell and workspaces can use it.
- Use a queued, single-dialog presentation. Resolve a dismissed confirmation as `false`, resolve/clean up pending requests on unmount, and never execute a destructive action merely because a dialog was dismissed.
- Task 4 will use this provider for app-level launch errors and restart decisions; do not introduce modal slow-start notices.

- [ ] Inventory remaining app-owned native messages/confirmations: `App.tsx` updater confirmation/error and launch feedback/restart; `ProfilesWorkspace.tsx` collection security review, profile switches/removals and deletion. Inspect every call rather than doing a text-only replacement. Preserve native `open`/`save` pickers.
- [ ] Add provider tests for confirm/cancel/dismiss, queued requests, unmount cleanup, accessible focus handling and theme-variable use.
- [ ] Add caller regressions showing that declined security review never downloads the file, approval remains bound to the exact target/file, declined profile deletion/removal changes nothing, and updater cancellation or stale-channel checks remain effective.
- [ ] Replace each app-owned problem/confirmation native call with the themed provider, preserving wording, action labels and asynchronous decision boundaries. Include informational app-owned confirmation dialogs for consistent presentation.
- [ ] Run the provider, App and ProfilesWorkspace tests and `bunx tsc --noEmit`. Verify warning/error/restart dialogs are app-themed in a real Tauri window.

### Task 4: Present themed status from both launch entry points

**Interfaces:**

- `GameLaunchStatus` consumes the shared context; render one compact, keyed notice per relevant unconfirmed/slow attempt using existing FontAwesome, buttons, theme variables and `role="status"` / `aria-live="polite"`.
- Its actions call `checkAgain`, `dismissNotice`, and the existing logs workspace navigation for the captured environment ID. Keep one app-level host so workspace navigation does not duplicate notices.
- Shell and card launch buttons call `requestLaunch`; derive disabled/loading state from the same `attempts` map.
- Use existing `Dialog`/`SimmDialogContent` primitives for actual launch errors and the explicit Steam-restart decision. Scope native-dialog removal to the launch flow; preserve unrelated native file dialogs.

- [ ] Replace tests currently requiring `dialogMocks.message` for the shell's unconfirmed result. Assert no native launch dialog, shared progress, captured environment identity and the exact spec copy for each outcome.
- [ ] Add status-component tests: keyboard-reachable actions, polite live region, no forced focus, late recovery, dismissal, and long environment names/log paths.
- [ ] Route both launch entry points and the explicit restart retry through the shared provider. Remove duplicated verifier callbacks and local launch-state ownership after tests cover parity.
- [ ] Reuse current dialog primitives for restart/error feedback, add compact status styling, and keep root font sizing unchanged.
- [ ] Run `bun run test -- src/components/GameLaunchStatus.test.tsx src/components/App.test.tsx src/components/EnvironmentList.test.tsx` and `bunx tsc --noEmit`. Require no launch-related native dialog expectations or calls in either entry point.
- [ ] Review the unified GUI behavior and commit only this scope if authorized.

### Task 5: Validate the complete correction

- [ ] From the repository root, run the full required sequence in order:

```powershell
bun install
bunx tsc --noEmit
bun run lint
bun run test
bun run build
cargo check --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml
```

- [ ] Treat lint according to `AGENTS.md`: hooks correctness errors are blocking; existing advisory warnings do not authorize broad cleanup. A passing build does not replace TypeScript validation.
- [ ] Run the repository's IPC drift checker and inspect new command registration/DTO results. Do not assume a static checker replaces the tests above.
- [ ] In a real Tauri window, test both launch buttons for normal startup, a controlled delayed-log fixture, no loader, a rejected dispatch, slow Steam startup and explicit restart. Then separately smoke-test actual Mono and IL2CPP startup. Do not delay or modify a user's real loader installation to manufacture the fixture.
- [ ] Verify the game keeps keyboard focus, the status is themed at 1080p/1440p/4k, navigation does not duplicate it, and a late start clears the slow notice without another launch.
- [ ] Validate Linux/Proton separately using the repo's Linux check workflow and an actual launch host; telemetry-disabled behavior must pass on both platforms. Record any unavailable host as an open gate.
- [ ] Compare affected-user diagnostics when available. Do not claim the underlying reported game-start failure is fixed solely because timeout/UI tests pass.
- [ ] Report Task 0's Steam handoff result, the slow-start feedback correction, and themed-dialog coverage separately. An unresolved regression remains an open item even if the other two are complete.

## Planning-time verification

- Confirmed an isolated timing false negative using verbatim current verifier methods: `noLog` at 20.488 seconds, then `confirmed` for the same launch at 21.514 seconds.
- Current `verify_launch_after` backend tests: 3 passed.
- Focused frontend baseline: 12 tests passed across App and EnvironmentList (68 excluded by the name filter), using Node to invoke Vitest with a workspace-local temporary cache after Bun and the default sandbox cache encountered host restrictions.
- No application source, dependency versions, Steam configuration, installed game files or telemetry preferences changed during diagnosis.
