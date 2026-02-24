# FILELOCK.md

Single-writer lock registry for docked workspace redesign.

## Lock Protocol

1. Only edit files assigned to your task.
2. If `Lock State = LOCKED`, no other task may edit that file.
3. Update `Locked By` before edit starts and clear when done.
4. If new files are needed, add them here before editing.
5. Final integration task (T06) must release all locks.

## Active Locks

| File | Assigned Task | Lock State | Locked By | Notes |
|---|---|---|---|---|
| `src/components/App.tsx` | T01 | RELEASED | - | Workspace host + dock router |
| `src/components/EnvironmentList.tsx` | T01 | RELEASED | - | Home + compact sidebar mode |
| `src/components/ModLibraryOverlay.tsx` | T03 | RELEASED | - | Docked Mod Library |
| `src/components/ModsOverlay.tsx` | T03 | RELEASED | - | Docked Mods |
| `src/components/PluginsOverlay.tsx` | T04 | RELEASED | - | Docked Plugins |
| `src/components/UserLibsOverlay.tsx` | T04 | RELEASED | - | Docked UserLibs |
| `src/components/LogsOverlay.tsx` | T04 | RELEASED | - | Docked Logs |
| `src/components/ConfigurationOverlay.tsx` | T04 | RELEASED | - | Docked Config |
| `src/components/Settings.tsx` | T05 | RELEASED | - | Docked Settings |
| `src/components/SteamAccountOverlay.tsx` | T05 | RELEASED | - | Docked Accounts |
| `src/components/HelpOverlay.tsx` | T05 | RELEASED | - | Docked Help |
| `src/components/WelcomeOverlay.tsx` | T05 | RELEASED | - | Docked Welcome |
| `src/components/EnvironmentCreationWizard.tsx` | T05 | RELEASED | - | Docked Create Environment |
| `src/style.css` | T02 | RELEASED | - | Final styling sweep after view conversion |

## Release-Managed Files (T06)

| File | Assigned Task | Lock State | Locked By | Notes |
|---|---|---|---|---|
| `package.json` | T06 | RELEASED | - | Version sync |
| `src-tauri/Cargo.toml` | T06 | RELEASED | - | Version sync |
| `src-tauri/tauri.conf.json` | T06 | RELEASED | - | Version sync |
| `src-tauri/capabilities/default.json` | T06 | RELEASED | - | Capability finalization if needed |
| `src-tauri/gen/schemas/capabilities.json` | T06 | RELEASED | - | Generated capability schema |
| `src-tauri/gen/schemas/desktop-schema.json` | T06 | RELEASED | - | Generated schema |
| `src-tauri/gen/schemas/windows-schema.json` | T06 | RELEASED | - | Generated schema |
| `CHANGELOG.md` | T06 | RELEASED | - | Release notes |
| `TASK_MASTER.md` | T06 | RELEASED | - | Bump log + PM closeout |
| `FILELOCK.md` | T06 | RELEASED | - | Release all locks |
