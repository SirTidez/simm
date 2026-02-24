# TASK_MASTER.md

Product-managed execution plan for the docked workspace redesign.

## Senior PM Review

- Product goal: make SIMM feel like a native desktop workstation, not modal-heavy web UI.
- UX direction: single active docked workspace, compact environment title sidebar, explicit back-to-home path.
- Scope for this cycle: all currently opened views (Mods/Library/Plugins/UserLibs/Logs/Config/Settings/Accounts/Help/Welcome/Wizard).
- Out of scope: multi-tab workspace for general users.
- Roadmap carry-forward: tabbed workspace under future developer-only feature gate.

## Global Rules

1. Respect `FILELOCK.md` before editing.
2. Each task edits only assigned files.
3. Keep behavior parity; this is a layout/interaction refactor, not backend contract rewrites.
4. Use subtle motion only.
5. Preserve accessibility affordances (keyboard close/navigation, visible focus, clear labels).

## Versioning Policy (Required)

- LARGE change -> minor bump format `0.x.0`.
- SMALL change -> patch bump format `0.x.y`.

Because version files are centrally owned (to prevent lock conflicts), each task must:

- Report a `BUMP_REQUEST` (`LARGE` or `SMALL`, with reason) to the orchestrator in its completion message.
- T06 logs and applies all requested bumps sequentially, then updates:
  - `package.json`
  - `src-tauri/Cargo.toml`
  - `src-tauri/tauri.conf.json`
  - `CHANGELOG.md`

## Status Board

| Task | Owner | Status | Depends On | Bump Class |
|---|---|---|---|---|
| T01 Workspace Host + Navigation Backbone | ENG-A | DONE | - | LARGE |
| T03 Dock Mod Workflows | ENG-B | DONE | T01 (interface only) | LARGE |
| T04 Dock Tooling Views | ENG-C | DONE | T01 (interface only) | LARGE |
| T05 Dock System/Onboarding Views | ENG-D | DONE | T01 (interface only) | LARGE |
| T02 Shared Workspace Styling Sweep | ENG-E | DONE | T01,T03,T04,T05 | LARGE |
| T06 Release Integration + PM Review | ENG-PM | DONE | All tasks done | SMALL |

## Task Prompts

### T01 - Workspace Host + Navigation Backbone

- Files: `src/components/App.tsx`, `src/components/EnvironmentList.tsx`

```md
Implement the docked workspace host.

Requirements:
1) Add single active workspace routing with typed payload support (environmentId where needed).
2) Default state is full Home view.
3) When workspace active, show compact environment title sidebar.
4) Add clear "Back to Home" action.
5) Route open actions to workspace transitions (mods/plugins/logs/config/library/settings/help/accounts/wizard/welcome).
6) Keep existing functional flows intact.
7) On completion report BUMP_REQUEST: LARGE (T01) in your final message.
```

### T03 - Dock Mod Workflows

- Files: `src/components/ModLibraryOverlay.tsx`, `src/components/ModsOverlay.tsx`

```md
Convert Mod Library + Mods to docked workspace panel layouts.

Requirements:
1) Remove modal-first framing, preserve update/install/version logic.
2) Adopt pane structure (header tools, list/detail zones, concise labels).
3) Keep runtime-aware install/update behavior and existing fixes.
4) Ensure panel can run inside active workspace host.
5) On completion report BUMP_REQUEST: LARGE (T03) in your final message.
```

### T04 - Dock Environment Tooling Views

- Files: `src/components/PluginsOverlay.tsx`, `src/components/UserLibsOverlay.tsx`, `src/components/LogsOverlay.tsx`, `src/components/ConfigurationOverlay.tsx`

```md
Convert tooling overlays to docked workspace panels.

Requirements:
1) Replace modal-centric containers with workspace-pane layouts.
2) Keep behavior parity and existing data contracts.
3) Improve copy/action clarity to match desktop tone.
4) Ensure environment-context payload rendering remains correct.
5) On completion report BUMP_REQUEST: LARGE (T04) in your final message.
```

### T05 - Dock System + Onboarding Views

- Files: `src/components/Settings.tsx`, `src/components/SteamAccountOverlay.tsx`, `src/components/HelpOverlay.tsx`, `src/components/WelcomeOverlay.tsx`, `src/components/EnvironmentCreationWizard.tsx`

```md
Convert system/onboarding overlays to docked workspace panels.

Requirements:
1) Remove modal-first framing and align to workspace structure.
2) Preserve account/settings/wizard functionality.
3) Perform concise desktop copy pass.
4) Keep keyboard escape/close flows predictable.
5) On completion report BUMP_REQUEST: LARGE (T05) in your final message.
```

### T02 - Shared Workspace Styling Sweep

- Files: `src/style.css`

```md
Finalize shared workspace visuals after component conversion.

Requirements:
1) Add coherent shell/sidebar/pane typography and spacing system.
2) Keep subtle transitions and responsive desktop behavior.
3) Ensure visual consistency across all docked panels.
4) Do not reintroduce outer app border.
5) On completion report BUMP_REQUEST: LARGE (T02) in your final message.
```

### T06 - Release Integration + Final PM Review

- Files: `package.json`, `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json`, `CHANGELOG.md`, `TASK_MASTER.md`, `FILELOCK.md`

```md
Run integration, apply versioning, and close out plan.

Requirements:
1) Collect all BUMP_REQUEST entries and apply sequential version updates.
2) Sync versions across package.json/Cargo.toml/tauri.conf.json.
3) Update CHANGELOG with task-level outcomes and UX highlights.
4) Set all file locks to RELEASED.
5) Add final PM review section: what shipped, risks, follow-ups.
6) Add/retain roadmap TODO for developer-gated tabbed workspace.
```

## BUMP_REQUEST Log

- T01 -> LARGE (workspace host/router + compact sidebar + back-to-home)
- T03 -> LARGE (dock conversion for Mod Library + Mods flows)
- T04 -> LARGE (dock conversion for tooling views)
- T05 -> LARGE (dock conversion for system/onboarding views)
- T02 -> LARGE (shared workspace styling sweep)
- T06 -> SMALL (release metadata integration, planning closeout, and lock release)

## Final PM Review (T06)

- Shipped scope: completed docked workspace redesign across host routing, environment-context navigation, all major view conversions, and shared styling harmonization.
- Shipped scope: integrated release metadata and synchronized final version across frontend, Rust crate, and Tauri app config.
- Shipped scope: confirmed custom titlebar desktop behavior remains in place for drag/window-control usability in the workspace shell.
- Residual risks: broad capability filesystem allowances remain permissive (`$HOME/**`, `$APPDATA/**`, `$TEMP/**`) and should be narrowed before hardening-focused release.
- Residual risks: workspace interaction parity has strong compile/build confidence but still benefits from targeted manual regression passes on wizard/account/help edge paths.
- Follow-up actions: (1) add focused QA checklist for docked workflows, (2) evaluate tighter Tauri capabilities policy, (3) continue roadmap item for developer-gated tabbed workspace mode.

## Roadmap TODO

- TODO: Add **Tabbed Workspace Mode** behind future "I'm a developer" setting, with tab persistence and per-tab dirty indicators.
