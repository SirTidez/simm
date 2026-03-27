## UI Ship-Readiness Memory

Date: 2026-03-19

This note captures the current ship-readiness concerns found during the live Tauri UI review and supporting repo inspection.

### Primary issues

- The automated UI path is not exercising the shipped runtime. `playwright.config.ts` runs plain Vite, while `e2e/smoke.spec.ts` relies on a synthetic Tauri shim.
- The plain browser path is not safe. `src/components/App.tsx` calls `getCurrentWindow()` during render, which crashes outside the Tauri host.
- The shell is too dense for a desktop app. Branding, primary navigation, and window controls are compressed into the custom titlebar.
- Environment cards hide core actions behind icon-only buttons and tooltips, which hurts discoverability and keyboard use.
- The `New Game` flow works but is visually fragmented and does not guide the user through a clear primary path.
- `Mod Library` and `Mods` are overloaded with browse, inventory, update, and destructive actions on the same surface.
- `Logs` and `Configuration` lag behind the rest of the product in hierarchy and desktop credibility.
- `Accounts`, `Settings`, and `Help` size correctly now, but they are still information-heavy rather than task-first.
- `Plugins` and `User Libraries` work, but they feel like thin file viewers rather than first-class management surfaces.

### Runtime observations

- The live Tauri walkthrough covered `Home`, `Accounts`, `Help`, `Settings`, `New Game`, `Mod Library`, `Mods`, `Logs`, `Plugins`, `User Libraries`, and `Configuration`.
- Runtime screenshots were captured under `output/playwright/`.
- The current smoke failure is stale selector and copy drift rather than a confirmed wizard regression.

### Recommended order

1. Replace the synthetic browser smoke with a real Tauri-hosted Playwright smoke.
2. Simplify the shell and make home-card actions visible and labeled.
3. Redesign `New Game`, `Mod Library`, and `Mods` around clearer modes.
4. Upgrade `Logs`, `Configuration`, `Accounts`, and `Help` into stronger utility panels.
5. Tighten the shared visual system and reduce tooltip dependence.
