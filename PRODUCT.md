# Product

> Facts marked *(inferred)* come from the repository (README, docs/simm-desktop-ui-redesign-spec.md, code) and were not yet confirmed by the maintainers.

## Platform

web

Tauri 2 desktop app (Windows and Linux) rendering a React web UI. The design language is a desktop utility, not native per-OS controls.

## Users

Two audiences, and the product must work perfectly for both (confirmed by the maintainer):

- **Mod developers** — the original audience. SIMM began as a tool to make mod development easier: several environments (branches, IL2CPP vs. Mono runtimes), logs, MelonLoader configs, local dev mods, switching many times per session.
- **Players** — the audience SIMM grew into. Schedule I players who want to install, update, and remove mods without touching files. *(inferred)* They usually run one environment, open SIMM before playing, and need the next safe action to be obvious.

The developer depth has to integrate meaningfully with the player path. *(open decision)* The existing Player / Power User experience mode (setup guide and Settings → App mode) currently only gates downloading separate Steam branches; whether to keep it, rename it, or retire it in favour of placement-based depth has not been decided by the maintainer.

## Product Purpose

SIMM (Schedule I Mod Manager) creates and maintains isolated game environments, downloads mods from Thunderstore and NexusMods into a shared library, installs them runtime-aware into each environment, and handles the surrounding modding chores: MelonLoader/S1API/MLVScan frameworks, update checks, logs, configs, save backups, profiles, and security scanning. Success is a working modded game with no manual file juggling and no surprise breakage.

## Positioning

The library-first model: mods live once in a shared library and are materialized into any number of environments, each aware of its runtime (IL2CPP or Mono), so one mod library serves stable, beta, and dev setups side by side.

## Operating Context

- Opened on a desktop at 1080p, 1440p, or 4K, often right before or between game sessions, sometimes alongside the running game.
- Repeated, task-driven use: check updates, install a mod, launch, read the log when something breaks, tweak a config, relaunch.
- Long-running background work (Steam depot downloads, mod downloads, scans) runs while the user keeps working.
- Accounts: Steam (depot downloads), NexusMods (API key / SSO); credentials are stored encrypted.

## Capabilities and Constraints

- Environments: create (import Steam install or download a branch via DepotDownloader), update, delete, launch; runtime and game version detection.
- Mod Library: Discover (Thunderstore + NexusMods search, collections), downloaded Library, Updates; install targets per environment; runtime compatibility prompts.
- Per-environment managers: Mods, Plugins, UserLibs, Logs (live tail, export), Configuration (structured + raw editor).
- Profiles (export/import mod sets), Save backups, Telemetry (opt-in), Security scan reports (MLVScan), app updates (stable/beta channels).
- Themes: built-in light, dark, modern-blue, plus user-defined custom themes. Must keep working.
- The frontend talks to the backend only via `ApiService` (`src/services/api.ts`).
- Icons: FontAwesome via the `Icon` wrapper; shadcn/base-ui primitives under `src/components/ui`.
- Layout must stay stable across 1080p, 1440p, and 4K; no root-font scaling at desktop breakpoints.

## Brand Commitments

- Name: SIMM — Schedule I Mod Manager. App icon in `src-tauri/icons/`.
- Recognition over reinvention (maintainer, 2026-10): stay as close to the current look as possible so existing users feel at home and no needless friction appears. Keep the dark navy/graphite "modern-blue" identity, the blue accent, the app icon, and the overall shell shape; fix what is broken rather than replacing the world.
- What is broken (maintainer, 2026-10): the visuals are poorly executed, surfaces are overcrowded, and UI and UX are out of step.
- Structure (maintainer, 2026-10): each environment is an object with its own tabs (Overview, Mods, Plugins, UserLibs, Config, Logs). Saves were proposed as a tab too, but save games belong to the Steam account, not to an environment (`SaveBackupsWorkspace` has no environment), so Saves stays a global destination. Developer tools live inside the environment, one step deeper, instead of all on one surface. Home is "ready to play". The Mod Library stays global; downloads live in the status bar.
- Still binding from the maintainers' spec (`docs/simm-desktop-ui-redesign-spec.md`): an operational desktop utility, not a web dashboard. No landing-page heroes, bento grids, feature-card grids, glows, decorative gradients, or emoji in UI copy.

## Evidence on Hand

- Target mockups: `docs/redesign-goal/` (Mod Library, Environments, Config).
- Earlier screenshots: `assets/screenshots/`.
- No testimonials, user counts, or download statistics exist; do not invent them.

## Product Principles

1. Calm by default, deep on demand: a player sees the next safe action first; developer depth (logs, configs, runtimes, raw files) sits one deliberate step away, never piled onto the same surface. The current UI fails this — surfaces are overcrowded and UI and UX do not agree (maintainer, 2026-10).
2. The selected environment is always clear; every action says which environment it touches.
3. Background work is visible but never blocks the user.
4. Risky actions (delete, overwrite, runtime mismatch, failed scans) are named explicitly with the affected object and a way back.
5. Data carries the UI: lists, tables, and inspectors before cards.
6. One vocabulary across screens: the same control looks and behaves the same everywhere.

## Accessibility & Inclusion

- Full keyboard operation of navigation, lists, menus, and dialogs; visible focus.
- Icon-only buttons carry accessible names and tooltips; primary actions never depend on hover.
- `prefers-reduced-motion` respected.
