# Console and inventory port onto the environment-page redesign

PR [#33](https://github.com/SirTidez/simm/pull/33), designed and implemented by [DooDesch](https://github.com/DooDesch), was squash-merged into beta as `ed7ac5cfdf9e450f276d7120d2886c299ac613f6`. The commit retains the contributor attribution. Changelog and contributor credit were committed and pushed separately as `ddac79b4d3fe10edcc2c7b59f23c1fed41775a03`.

The original feature checkpoint remains available as stash `53dc31a72a74ec26bf611437ad56e28527ddfdff`, named `simm-console-inventory-tooling-before-environment-page-ui-2026-10-23`. Its 48 tracked and 62 untracked files were verified before the merge. The stash has not been popped or dropped.

## Integration

- Console now sits beside Logs in `EnvironmentWorkspaceHeader`. The new global navigation, environment header, line tabs, tables, artwork, and theme foundation remain in place. Console is shown on Windows.
- Console and Logs share the same environment session component and scrolling details sidebar. The page supplies the title and tabs; the embedded component does not duplicate them.
- Mod/plugin message-count clicks switch the environment's active page tab to Logs with the matching severity and source aliases. The redesigned selected-line inspector renders in the shared sidebar.
- View options remain specific to the environment, including sidebar sections, width, and Open Console after launch. Auto-open uses the existing Steam launch event to select that environment's Console tab.
- Pop out console / Dock in SIMM retains native console selection and window controls. Inventory refresh and navigation preserve a popped-out console. Close Game stays available from both tabs and requires confirmation.
- Local DLL author/version extraction, enabled/disabled state, watcher-driven refresh, and shared-library metadata were carried into the redesigned tables and data projections.
- Parsed severity is shared between the log viewer and its tab count. Incidental message words do not create errors or warnings. Only the exact expected interop startup notice is informational; serious interop output remains actionable.
- Saved launch-copy and Node 22.23.4 tooling changes were restored alongside the feature. They are local changes, separate from the published redesign merge.

## Validation

The full frontend suite passed with 561 tests across 48 files. Rust checks and tests passed with 674 tests and 10 existing ignored tests. The frontend production build, custom-protocol native desktop build, and IPC registration scan passed. Lint reported 28 advisory warnings and no errors.

An isolated Tauri instance used a copied database and the real Steam installation of Schedule I 0.4.7f12 / IL2CPP with MelonLoader 0.8.0-ci.2575. No synthetic console producer, injected test mod/plugin, or modified game log was used for visible testing.

- Console and Logs were measured at 1920×1080, 2560×1440, and 3840×2160. Root text stayed at 16px, without document or toolbar overflow. Each page contained one environment heading and no nested Console/Logs tab bar.
- A real Steam launch automatically selected Console and attached to game PID `49396`, owned by Steam PID `39296`.
- Inventory showed PackRat 3.1.0 / SirTidez, Save Expansion 1.0.1 / SirTidez, and SimpleHealthBar 1.5.2 / iTidez.
- Sidebar and parsed Latest.log agreed on zero errors and zero actionable warnings. The expected interop startup notice was informational. Positive severity/source-alias cases are covered by automated tests; this live launch produced no positive mod/plugin counts to click.
- Logs hid the docked native console and rendered a selected-line inspector inside the shared sidebar.
- Pop-out restored the original native styles exactly. Resize and native Mark selection worked. Home/environment navigation and inventory refresh retained pop-out and the same game process.
- Redocking retained the original console window (`6822880`) and game identity and cleared native selection from flag 1 to 0.
- Quitting SIMM with the console popped out left the same Steam-owned game alive. Restarting the isolated app reattached to that game. Close Game from Logs, with the console popped out, shut down the game after confirmation.
- The isolated app, game, and native helpers exited. All 10 installed DLL/configuration baseline hashes matched after testing.

Receipts and captures are under `target/diagnostics/environment-page-ui-handoff-2026-10-23/port-ui/`; command logs and the stash receipt are in its parent folder. One shell-based native selection helper invalidated its own console handle, so the redock test was rerun in a fresh shell and passed. The restart harness was also corrected to await initial session creation before querying it. Neither issue required a product workaround.

## Remaining acceptance

The port is included in the beta commit that adds this record. The redesign merge and its contributor credit were committed separately before this checkpoint. The original stash remains the recovery point.

Manual appearance acceptance, Linux/Proton and Mono runtime qualification, mixed-DPI behavior, and live positive mod/plugin warning/error attribution remain separate from the Windows/IL2CPP evidence above. Switching environments while Console is selected has an explicit routing regression test.
