# Schedule I launch confirmation diagnosis and design

Date: 2026-10-21 (America/Los_Angeles)

Scope: investigate the reported game-launch failures, with the Steam/custom-shortcut handoff as the primary regression candidate, and separately correct misleading confirmation feedback and inconsistent dialogs. The original document was a proposal; the user subsequently authorized implementation. It does not establish why an affected user's game fails to start.

## Implementation record

The first implementation pass corrects demonstrated shortcut lifecycle defects and themes the remaining app-owned native dialogs. Restart registration now occurs after Steam shutdown, with a shared transaction lock, deferred live-client writes, retained-entry verification and positive intended-account verification on Windows before dispatch. Executable-based identity preserves same-named installations; conflicting app IDs and process/account inspection failures stop the handoff with an actionable error. Linux prerequisite preparation uses the corrected restart transaction.

Fixtures exercise shutdown rewrites, live-client deferral, duplicate names, account selection, concurrent restart requests and missing post-start entries. The independent review's Important finding was that a zero/absent active account could pass the last-used path fallback after startup. The final account gate waits within a bounded deadline for positive identification and leaves the launch pending until then. The regression was observed failing before the correction and passing afterward.

The user subsequently authorized process-aware confirmation and late recovery. Both GUI launch entry points now use one coordinator and independent process/log snapshots. The 20-second point produces a neutral inline status, followed by continued observation up to 120 seconds; late matching-process and fresh-loader confirmation clears the notice without relaunching. Telemetry-disabled tests verify that observation changes no preferences and creates no sessions/uploads. Check again preserves the original freshness timestamp and dismissal leaves active observation running. Fixture tests do not prove Steam loaded a shortcut into its in-memory library or resolve the unreproduced affected-user failure. Native Linux/Proton and actual game focus remain runtime gates; isolated Tauri-window validation was blocked by the existing developer session locking the debug executable.

Continuation verification: the full frontend/backend sequence passes (489 frontend tests; 634 Rust tests, 10 ignored). Independent review found no blocking source issues. A browser fixture of the actual coordinator/status component passes all three desktop sizes and built-in themes, including late recovery, preserved input focus and action contrast. This is not native Tauri or gameplay acceptance. A direct provider-level StrictMode replay regression remains a nonblocking coverage follow-up.

## User clarification and investigation priority

- The developer's own game eventually starts, including on the rare occasions when startup is substantially delayed. A complete failure to launch has been reported by other users and has not been reproduced on the developer's PC.
- The delayed-log fixture below reproduced only the confirmation timeout. It did not reproduce Steam refusing a launch, a missing game process, a game crash, or the complete user-reported problem.
- The developer suspects a regression in how SIMM launches through Steam or a generated shortcut. That is the first investigation track; changing feedback timing alone cannot close it.
- All app-owned problem/warning dialogs should use SIMM's theme, including non-launch warnings. Native file/directory pickers are outside this presentation change. Required confirmations and security-review decisions must retain their existing approval semantics.

## Verified launch-method history

Source comparison of the local release tags establishes:

| Release/path | Custom installation launch behavior |
| --- | --- |
| `v0.8.5-beta` | `launch_via_steam_executable(app_id, Some(dir))` ensures Steam is running, starts the selected game executable with its directory as the working directory, and sets `SteamAppId` / `SteamGameId` on the child. |
| `v0.8.6` through the current checkout | `launch_via_steam` routes a custom directory through non-Steam shortcut registration and `steam://rungameid/<id>`. It no longer uses that direct executable helper for this route. |

Commit `a3c2a3d` (2026-05-21) introduced this shortcut route and explicit restart/retry behavior. It is absent from `v0.8.5-beta` and included in `v0.8.6`, `v0.8.7`, and `v0.8.8`. Commit `da139e8` (2026-06-13), also between those tags, introduced the launch-confirmation warning. Consequently a new warning and an actual launch-method regression are separate possibilities; release timing alone does not distinguish them.

The main Steam installation takes the normal app-ID launch route. Do not attribute a main-install failure to custom-shortcut registration unless tracing shows that the environment was misclassified or sent through that route.

## Steam handoff hypotheses to test first

These are source-backed risks, not confirmed explanations of the affected-user reports:

1. **Registration lost or not loaded across restart.** `launch_custom_install_via_steam_shortcut_after_restart` registers before requesting Steam shutdown, restarts Steam, clears the reload marker, and sends the saved URL without re-registering or verifying the entry after shutdown. Simulate a client rewrite of the shortcut file on shutdown; then verify actual behavior on an affected host. Existing local shortcuts can exercise a different path from a user's first newly created shortcut.
2. **Process presence mistaken for client readiness.** The restart helper waits for the Steam process, then sleeps five seconds. It does not verify that the intended account/library and shortcut are loaded before dispatch. A process existing is insufficient evidence of launch readiness.
3. **Wrong account or ambiguous shortcut identity.** Registration chooses `MostRecent` from `loginusers.vdf`, with a userdata-folder fallback. Shortcut matching accepts either the app name or executable path; names depend on the leaf folder name. Test multiple accounts and identical leaf folder names at different paths rather than assuming the selected file/entry belongs to the intended installation.
4. **Unknown reload state treated as safe.** Failure to read Steam's process start time becomes `None`, which the reload guard treats as no reload required. Distinguish discovery failure from a stopped client.
5. **Dispatch acknowledged but launch rejected.** The protocol launcher reports OS URL-handler acceptance; the fallback is triggered by dispatch errors, not a subsequent rejection inside Steam. Correlate the URL/shortcut ID with Steam's action and the actual game process before calling it a successful launch.

Compare the exact same game folder/content and Steam account using the old direct-with-Steam-running mechanism, the current SIMM shortcut mechanism, and the corresponding entry's Play action inside Steam. Record whether each creates the intended process and whether it exits. Do not downgrade a user's live SIMM database or alter their primary Steam branch to make this comparison.

## Confirmed findings

- Inspection baseline: clean `beta` checkout, commit `f9b33b2`, version `0.8.9-beta.1`.
- `src/components/App.tsx::verifyShellMelonLoaderLaunch` passes `20000` to the verifier, then calls `message` from `@tauri-apps/plugin-dialog` for every result except `confirmed` and `notInstalled`. This is the source of the native warning dialog. The shell's restart confirmation and launch errors use native dialogs too.
- `src/components/EnvironmentList.tsx::verifyMelonLoaderLaunch` duplicates that policy, but uses the themed `MessageOverlay`. The two launch entry points therefore present the same condition differently.
- `src-tauri/src/services/melon_loader.rs::verify_launch_after` polls every 500 ms, defaults to 20 seconds, and clamps caller timeouts to 1–60 seconds. At the deadline it returns the latest log observation; it does not establish that the game failed.
- Log observations are `noLog`, `staleLog`, `noConfirmation`, `confirmed`, and `notInstalled`. The verifier does not inspect the game process or distinguish a delayed Steam handoff from a failed one.
- Confirmation requires file modification time within a 1.5-second tolerance of the supplied launch timestamp, plus `melonloader` and one recognized startup marker in the log contents. This proves a fresh loader startup marker, not a playable main menu or continued process health.
- Each UI entry point performs one verification call. After an unconfirmed result, neither keeps checking or retracts the warning when the game starts later. Card launch deduplication is local to `EnvironmentList`; the shell has separate state.
- The launch command's `success: true` reports successful dispatch/spawn, not successful game initialization. The warning is shown after that dispatch and does not cancel or kill the game.
- `src-tauri/src/services/game_session_monitor.rs` already discovers processes by installation directory on Windows and Linux/Proton. Its reconciliation and emitted status are gated by telemetry collection preferences. Launch confirmation must not depend on those events or enable telemetry.

## Isolated reproduction and limits

A standalone fixture copied the current verifier, installation-presence helper, log inspector, marker predicate, timestamp helper, response formatter, and constants directly from the source. It created a dummy loader layout under the repository's ignored `target` directory and wrote the startup log after 21.5 seconds. It launched neither Steam nor Schedule I.

Observed results for the same launch timestamp:

| Observation | Elapsed time | Result |
| --- | ---: | --- |
| Default verification returns | 20,488 ms | `noLog`, `confirmed: false` |
| Recheck after the delayed write | 21,514 ms | `confirmed`, `confirmed: true` |

This reproduces the timing false negative in the verifier. Source tracing and the existing UI test demonstrate that this result produces the native shell warning. It does not reproduce an affected user's full installation, explain their startup delay, or prove their game eventually starts.

Reproduction source: `target/diagnostics/launch-confirmation-probe/src/main.rs` (local and ignored). Run from the repository root:

```powershell
cargo run --offline --manifest-path target/diagnostics/launch-confirmation-probe/Cargo.toml --target-dir target
```

Current backend baseline: `cargo test --offline --manifest-path src-tauri/Cargo.toml verify_launch_after -- --nocapture` passed all 3 matching tests. Those tests cover immediate confirmation, absent installation, and stale logs; they do not cover delayed log creation or post-timeout recovery.

The focused frontend baseline passed 12 tests across `App.test.tsx` and `EnvironmentList.test.tsx` (68 unrelated tests excluded by the name filter). Bun first exited with `CouldntReadCurrentDirectory`, and a direct Node invocation initially encountered a sandbox temporary-cache rename restriction. Running Vitest through Node with `TEMP` and `TMP` directed to `target/diagnostics/vitest-temp` resolved that host issue. No application source change was needed. The passing shell regression explicitly expects the current native warning dialog, demonstrating that the inconsistent UI is currently pinned by a test.

## Proposed behavior

The following feedback changes are a separate correction. They improve evidence and presentation; they do not substitute for identifying and validating any Steam handoff fix from the investigation above.

### Evidence and timing

- Preserve the distinction between launch dispatch, the matching game process, loader startup, and gameplay readiness.
- Use a backend snapshot command for independent process and loader observations. Poll from one shared frontend launch coordinator every 2 seconds, without overlapping requests. The old verifier remains compatible for existing callers.
- Start observation deadlines when dispatch is accepted. Retain the original backend `launchStartedAt` as the log freshness reference; Steam restart time must not consume the observation budget.
- At 20 seconds without loader confirmation, show a neutral, nonmodal `Schedule I is taking longer to start` status and continue checking the same attempt.
- Stop automatic observation after 120 seconds. This is a bounded observation deadline, not evidence of a crash. Do not introduce a user timeout setting in the initial fix.
- When the matching process is running but loader startup remains unconfirmed, say `Schedule I is running; MelonLoader has not been confirmed.`
- When no matching process was observed by the deadline, say `SIMM could not confirm that Schedule I started.`
- When a process was observed and is subsequently absent for two consecutive snapshots, say `Schedule I closed before MelonLoader startup was confirmed.` Do not label an intentional exit as a crash.
- Process inspection errors or inaccessible executable paths produce `unknown`, not `notRunning`. They must not establish failure. Log access errors produce an unavailable observation with a diagnostic, not a loader-not-installed result.
- A late fresh startup marker clears the slow-start status without another launch request. Do not loosen freshness checks or accept a stale log to make the warning disappear.
- Loader confirmation does not terminate observation when the current snapshot says the process is absent. Confirmation plus a running matching process can complete the attempt; unknown process state remains qualified. A previously confirmed loader followed by a stopped process is not game success.
- For an environment without MelonLoader, omit loader warnings; process observation remains independent. An observed process can complete this attempt without loader confirmation.

### Shared UI and lifecycle

- A single provider owns launch attempts for the shell and environment cards, including deduplication across both entry points.
- Identify attempts with a unique frontend attempt ID. Ignore responses belonging to superseded attempts. Capture the environment ID/name/path at request time; changing selection cannot relabel an earlier result.
- Use the existing themed dialog primitives for app-owned problem messages and confirmation decisions, including actual dispatch errors and the explicit Steam-restart decision. Audit the remaining native warning/error dialogs in the updater and Profiles workspace as a separate presentation task. Preserve existing destructive/security confirmation wording, buttons, cancellation and approval scope. Use a compact themed, nonmodal status surface for slow or unconfirmed startup, with `role="status"` and polite announcements. Do not steal focus from the game.
- Expose `View logs`, `Check again`, and `Dismiss` on an unconfirmed notice. `Check again` starts a new bounded observation window for the same launch timestamp and never launches another process. `Dismiss` hides the notice but does not stop an active observation window.
- Do not offer or perform an automatic relaunch. While process state is running or unknown after an unconfirmed attempt, an explicit new launch must first recheck and explain the uncertainty instead of blindly dispatching another instance.
- Keep monitoring across workspace navigation. Cancel timers and discard late results on app/provider unmount, environment removal/path change, attempt replacement, or terminal completion.
- Do not depend on telemetry opt-in, collect gameplay telemetry, add uploads, persist launch history, or change Steam branches as part of this correction.

### Diagnostics

Record locally: attempt ID, environment ID, launch method, dispatch accepted/rejected, elapsed time, process observation, loader observation, log modification time, and completion reason. Use existing logger path sanitization. Do not emit a warning every polling tick, log tokens, or upload this information automatically.

For users who still cannot start the game, compare the matching environment's SIMM launch diagnostics, Steam `console_log.txt` at the handoff, `MelonLoader/Latest.log` if created, and Unity `Player.log` if reached. The earlier secondary-install shortcut registration hypothesis is part of the primary handoff investigation; this warning alone does not identify it.

## Acceptance gates

- The reported complete launch failure remains open until an affected-host trace or a controlled handoff reproduction identifies a failing stage and a proposed fix passes the same scenario. Passing timeout/theme tests alone cannot close it.

- Deterministic tests cover a log arriving after 20 seconds, all deadline outcomes, stale/partial/unreadable logs, process uncertainty, late recovery, cross-entry-point deduplication, environment changes, and telemetry disabled.
- No launch-feedback or Steam-restart native dialog remains in either GUI entry point.
- A real Tauri smoke test verifies focus, theme, and behavior with normal and slow startup on Windows; Linux/Proton receives its own launch smoke. Frontend mocks and fixture logs do not satisfy those runtime gates.
- Review 1080p, 1440p, and 4k layouts with stable root font sizing.
- Follow the full frontend/backend validation sequence in `AGENTS.md` before shipping.
