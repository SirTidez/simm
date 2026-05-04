# SIMM Desktop UI Redesign Spec

Date: 2026-05-03

## Purpose

Redesign SIMM so it feels like a real native desktop utility for managing Schedule I modded environments, not a vibe-coded web dashboard placed inside a desktop shell.

The goal is not to make SIMM more visually impressive in isolation. The goal is to make it more usable for repeated desktop workflows: environment setup, mod discovery, library management, installs, updates, logs, configuration, accounts, and troubleshooting.

## Product Mode

SIMM is an operational desktop app.

Design implications:

- Dense enough for repeated use, but not cramped.
- Clear app chrome, navigation, and workspace ownership.
- Lists, panes, toolbars, split views, inspectors, status bars, and dialogs should do most of the structural work.
- Cards are allowed only where they represent a real object or discrete choice.
- Decorative motion, marketing hero layouts, bento grids, giant rounded panels, and ambient gradient styling are out of scope.
- The first screen should be a working app home/workspace, not a landing page.

## Design Inputs

Use these skills as directional inputs, with SIMM-specific constraints:

- `de-slop-ui`: primary cleanup lens. Remove card/pill/glow/gradient habits and preserve product semantics.
- `ui-ux-pro-max`: accessibility, keyboard, touch target, forms, feedback, typography, layout, and interaction-state checklist.
- `design-taste-frontend`: component architecture, dependency checks, interaction states, CSS performance, and anti-generic visual guardrails.
- `gpt-taste`: use only as an anti-default creativity checklist. Do not apply AIDA, hero sections, GSAP scroll effects, or perpetual motion to SIMM.
- `frontend-app-builder`: use the image-first concept workflow and fidelity gates, adapted for desktop app screens rather than marketing pages.
- `imagegen`, `imagegen-frontend-web`, `image-taste-frontend`, `image-to-code`: use for mockups and extraction only. Generated concepts must become a desktop UI spec, not a web-page reinterpretation.

## Current Mockup Target

The supplied mockups define the target product direction more directly than a fresh exploratory redesign pass. Treat them as the first accepted visual target unless later screenshots override them.

Common traits to preserve:

- Custom Windows-like titlebar with app icon, app name, menu row, and native window controls.
- Full-height left navigation with text labels, selected blue rail state, grouped primary/system destinations, and bottom Settings.
- Workspace headers that are compact: title, one-line purpose text, and toolbar controls, not page hero copy.
- Dense split-pane workflows: list/table or editor in the center, inspector/actions on the right.
- Bottom status bar with segmented operational facts such as result count, source sync, runtime, online state, and app version.
- Dark graphite shell with restrained blue selected/primary states, green/yellow/red semantic status, crisp 1px borders, and small radii.
- Controls look like desktop controls: toolbar buttons, split buttons, select boxes, segmented tabs, row selection, table headers, status chips, context overflow buttons.
- Data surfaces carry the UI, not marketing cards. Cards are reserved for inspectors, dialogs, and repeated object rows only when row/table layout is not enough.

Specific screen targets:

- Mod Library: left nav, top tab strip for Discover/Library/Updates, source/runtime/category/status filters, results table, selected mod inspector with image, compatibility, versions, stats, and stacked actions.
- Environments: toolbar actions across the top, environment table/list on the left, selected environment inspector on the right with overview, quick actions, MelonLoader status, and notes.
- Configuration: file browser sidebar, toolbar with Save/Discard/Reload/Open/Reveal/Validate/Search, section tabs, structured editor rows, right file-information inspector, quick actions, and notes.

The immediate redesign should favor faithful translation of this app-shell grammar over new visual invention.

## Hard Bans

- No landing-page hero section inside the app.
- No AIDA page structure.
- No GSAP scroll storytelling.
- No bento dashboard as the core layout.
- No giant rounded wrapper around the entire product.
- No generic feature-card grid.
- No nested cards unless the nested surface has a distinct job.
- No decorative pill spam.
- No hover-only discoverability for primary or destructive actions.
- No purple/blue glow "AI SaaS" palette.
- No emoji in UI copy, code, comments, alt text, or docs examples.
- No new icon library unless the repo intentionally migrates away from the existing FontAwesome `Icon` wrapper.
- No direct Tauri `invoke` calls from random UI components. Keep `ApiService` as the frontend boundary.

## Desktop App Principles

### 1. Shell Should Feel Native

The shell should behave like desktop software:

- Dedicated titlebar/window-control area.
- Persistent navigation that is visually subordinate to the active workspace.
- Clear back/home behavior.
- Status bar for background work, app version, update checks, selected environment, and long-running operations.
- Avoid making the custom titlebar carry too much product navigation.

Target direction:

- Left app rail: primary destinations, compact but labeled on hover/focus.
- Secondary sidebar: environment list or current workspace context.
- Main workspace: split-pane surface with toolbar, list, details, and inspector.
- Bottom status bar: persistent operational state.

### 2. Workflows Beat Pages

Each surface should answer:

- What is selected?
- What can I do next?
- What is running?
- What changed?
- What is risky?

Screen direction:

- Home: environment command center, not a dashboard hero.
- New Game: guided assistant with clear source choice, branch/runtime/output path, and prerequisite status.
- Mod Library: source browser + downloaded inventory + detail inspector.
- Mods: environment-specific installed mod manager with update/install state.
- Plugins/UserLibs: first-class environment asset managers, not thin file viewers.
- Logs: desktop log viewer with source list, filter bar, virtualized output, follow-tail, export, and clear selected line state.
- Configuration: file explorer + structured editor + raw editor + dirty-state footer.
- Accounts: service connection manager with security/storage explanation.
- Settings: categorized preferences with search and reset/default behavior.
- Help: task-first reference and diagnostics entry points.

### 3. Layout Anatomy

Preferred screen anatomy:

```text
Window chrome
Primary app rail | Context sidebar | Workspace toolbar
                 |                 | Main list/table/editor | Detail/inspector
Status bar
```

Use split views instead of modal-first flows when the user is working inside a persistent context.

Use dialogs for:

- Destructive confirmation.
- Credential entry.
- Runtime choice when required.
- File/folder pickers.
- Short blocking decisions.

Avoid dialogs for:

- Browsing libraries.
- Managing environment mods.
- Reading logs.
- Editing config.
- Viewing settings/help.

### 4. Information Density

Target density: 7/10 for desktop utility surfaces.

Rules:

- Prefer rows and tables for repeated mod/environment/file data.
- Prefer inspectors for selected-object details.
- Prefer badges only for compact status or metadata.
- Use monospace only for paths, versions, hashes, commands, logs, and aligned numeric data.
- Keep body text concise and task-first.
- Avoid large empty hero-like spaces.

### 5. Visual System

The visual system should be restrained and durable:

- Neutral base, high-contrast text, one functional accent.
- Semantic colors for success, warning, danger, info.
- 4px/8px spacing scale.
- Small radius system: 4px for controls, 6px for panels, 8px max for major surfaces unless already established.
- Borders and tonal surface shifts before shadows.
- Shadows only for overlays, menus, and true elevation.
- Consistent hover, active, selected, disabled, and focus-visible states.
- No decorative glows.

Potential palette direction:

- Background: charcoal/zinc desktop surface.
- Panels: slightly raised graphite surfaces.
- Text: high-contrast neutral.
- Accent: SIMM blue only where it means primary action or selected state.
- Status: restrained green/yellow/red/cyan tokens.

### 6. Typography

SIMM should use desktop UI typography, not marketing typography.

Rules:

- Use a system or high-quality sans stack that feels native on Windows.
- Keep headings modest.
- Reserve large type for empty states and onboarding only.
- Body text should remain readable at 13-15px depending on density.
- Toolbar labels, table headers, sidebars, captions, and status bar text need explicit sizing.
- Avoid display-font theatrics.

### 7. Interaction And Accessibility

Required:

- Icon-only buttons need `aria-label` and visible tooltip/focus title.
- Primary actions must not rely on hover reveal.
- Every async action needs disabled/loading/error/success handling.
- Destructive actions need explicit confirmation and clear object name.
- Keyboard navigation should cover sidebars, lists, menus, dialogs, and escape routes.
- Focus rings must remain visible.
- `prefers-reduced-motion` must disable non-essential animation.
- Long paths and long mod names must wrap or truncate with a full-value affordance.

### 8. Motion

Motion should feel like desktop state continuity:

- 120-220ms transitions.
- Transform/opacity only where possible.
- Subtle pane enter/exit.
- Selection, expansion, and dialog motion can animate.
- No perpetual motion except progress indicators or active background work.
- No scroll hijacking, parallax, or motion that competes with reading logs/config data.

## Mockup Workflow

Use the supplied mockups as the baseline. Generate new images only when a screen or state is not covered clearly enough by the supplied set, and generate desktop app screens, not website sections.

### Mockup Set 1: Primary Desktop Shell

Optional only if the supplied shell direction is rejected. Generate three alternatives:

1. Conservative Native Utility
   - Windows desktop utility feel.
   - Strong split-pane hierarchy.
   - Minimal visual flair.

2. Modern Workstation
   - Still native-feeling.
   - Stronger typography and selected states.
   - More polished panels/toolbars.

3. Modding Control Room
   - Slightly richer atmosphere.
   - Dense but readable.
   - Must avoid game-themed gimmicks and neon.

Each mockup must show:

- Window chrome.
- Left app rail.
- Environment/context sidebar.
- Main workspace.
- Detail/inspector panel.
- Bottom status bar.
- Real SIMM destinations and actions.

### Mockup Set 2: Critical Workflows

Generate one mockup each for:

- Home/environment command center.
- New Game wizard.
- Mod Library with discover/library/update modes.
- Environment Mods manager.
- Logs viewer.
- Configuration editor.

Each mockup must show real states:

- Loading or busy state.
- Empty or first-run state where relevant.
- Error or warning state where relevant.
- Selection state.
- Primary and secondary actions.

### Mockup Set 3: Detail States

Generate focused detail mockups for:

- Mod row/list item anatomy.
- Environment sidebar item anatomy.
- Toolbar/filter/search controls.
- Runtime compatibility warning.
- Install target dialog.
- Destructive confirmation dialog.
- Status bar/background job state.

## Image Prompt Template

Use this prompt pattern for each generated mockup:

```text
Design a production-quality Windows desktop app UI mockup for SIMM, Schedule I Mod Manager.
It is a Tauri desktop utility for managing Schedule I game environments, mods, plugins, user libraries, logs, configs, Steam/Nexus accounts, MelonLoader, S1API, and MLVScan.

Product mode: dense operational desktop app, not a website, not a SaaS landing page.
Use native-feeling app chrome, left app rail, context sidebar, split-pane workspace, toolbar, list/table, detail inspector, and bottom status bar.
Avoid hero sections, bento grids, marketing cards, large rounded wrappers, neon glows, decorative gradients, emoji, and oversized headings.

Show [specific screen/state].
Include realistic labels: Home, Library, New Game, Accounts, Help, Settings, Mods, Plugins, UserLibs, Logs, Config.
Use concise desktop copy, clear selected states, visible primary actions, warning/error states, and accessible contrast.
Dark neutral palette with one restrained blue accent, small radii, crisp borders, subtle depth only for overlays.
Readable 16:10 desktop screenshot, implementation-friendly, code-native UI controls.
```

## Implementation Plan

### Phase 0: Audit And Baseline

- Capture current screenshots for all major screens.
- Document current navigation map and component ownership.
- Identify repeated visual primitives in `src/style.css`.
- Identify where modal framing remains in component markup.
- Confirm test coverage for each target surface.
- Compare current app screenshots against the three supplied target mockups and note the largest structural gaps.

Output:

- Screenshot folder.
- UI inventory.
- Component risk map.

### Phase 1: Design System Foundation

- Define shell layout tokens.
- Define type scale.
- Define surface/border/radius/elevation tokens.
- Define toolbar, sidebar, list row, inspector, empty state, callout, dialog, status pill, and status bar patterns.
- Keep existing theme support, but normalize token naming and usage.
- Add reusable desktop primitives before deep screen rewrites: `AppShell`, `WorkspaceToolbar`, `DesktopTable`, `InspectorPanel`, `SegmentedTabs`, `StatusBarSegment`, `SearchField`, and `IconButton`.
- Keep the existing FontAwesome-backed `Icon` wrapper unless there is a deliberate later migration.

Primary files:

- `src/style.css`
- `src/utils/theme.ts`
- small shared component files if needed.

### Phase 2: Shell Redesign

- Simplify window chrome responsibilities.
- Make primary navigation persistent and predictable.
- Strengthen context sidebar.
- Add or refine status bar semantics.
- Keep active workspace routing stable.
- Match the supplied titlebar/menu/rail/status-bar structure before changing individual workflow screens.
- Preserve route behavior and lazy-loaded workspace panels while replacing the web-page centered content frame.

Primary files:

- `src/components/App.tsx`
- `src/components/EnvironmentList.tsx`
- `src/components/Footer.tsx`

### Phase 3: Home And New Game

- Home becomes environment command center.
- Environment rows/cards become clearer desktop objects with visible actions.
- New Game wizard becomes one clear guided setup flow with prerequisite state.

Primary files:

- `src/components/EnvironmentList.tsx`
- `src/components/EnvironmentCreationWizard.tsx`
- `src/components/WelcomeOverlay.tsx`

### Phase 4: Mod Workflows

- Redesign Mod Library around discover, downloaded inventory, updates, and detail inspector.
- Redesign Mods around selected environment, installed state, update state, and install/remove actions.
- Keep runtime-aware logic and existing source behaviors.
- Make Mod Library the first workflow rewrite because the supplied mockup is the clearest end-state: tab strip, filters, results table, and inspector.
- Keep downloaded/managed/local source distinctions visible in row metadata rather than hiding them behind large cards.

Primary files:

- `src/components/ModLibraryOverlay.tsx`
- `src/components/ModsOverlay.tsx`
- `src/services/modLibrarySummary.ts`

### Phase 5: Tooling Workflows

- Logs: source sidebar, filter toolbar, virtualized log body, selected-line detail, export/follow-tail.
- Config: file tree, structured editor, raw editor, dirty footer.
- Plugins/UserLibs: list/detail manager with environment context and clear empty states.
- Configuration should follow the mockup closely: file browser, section tabs, structured editor stack, and right file information/actions/notes panel.
- Logs should borrow the same shell shape even though no supplied log mockup exists: source list, toolbar filters, log table/output, right selected-line/event inspector.

Primary files:

- `src/components/LogsOverlay.tsx`
- `src/components/ConfigurationOverlay.tsx`
- `src/components/PluginsOverlay.tsx`
- `src/components/UserLibsOverlay.tsx`

### Phase 6: System Workflows

- Settings: searchable categories, direct controls, reset/default affordances.
- Accounts: service connection state and security/storage explanations.
- Help: task-first guide and diagnostics shortcuts.

Primary files:

- `src/components/Settings.tsx`
- `src/components/SteamAccountOverlay.tsx`
- `src/components/HelpOverlay.tsx`

### Phase 7: QA And Fidelity

- Compare implementation against accepted mockups.
- Verify desktop viewport, small laptop viewport, and constrained window sizes.
- Verify keyboard navigation, focus states, dialogs, async states, and long text/path handling.
- Run frontend validation with Bun.
- Run Rust validation if contracts or backend behavior changed.

Required frontend validation:

```powershell
bun install --prefer-offline
bunx tsc --noEmit
bun run test
bun run build
```

Required full validation when backend/contracts change:

```powershell
cargo check --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml
```

Do not set `CARGO_TARGET_DIR`.

## Acceptance Criteria

SIMM redesign is acceptable when:

- The app no longer reads as a web dashboard inside custom chrome.
- Primary workflows are visible and discoverable without tooltip dependence.
- Each major screen has a desktop-appropriate split-pane or task-pane structure.
- Lists/tables/inspectors carry repeated data instead of card grids.
- Mod Library and Mods have distinct information architecture.
- Logs and Config feel like real desktop tools.
- Settings, Accounts, and Help are task-first rather than text-heavy panels.
- Status, background jobs, selected environment, and risky actions are always clear.
- Keyboard and focus behavior are preserved.
- Motion is subtle and state-driven.
- Themes remain functional.
- Tests and build pass with Bun and default Cargo target paths.

## Open Decisions

- Whether to keep a permanent left rail plus context sidebar, or collapse context sidebar on small widths.
- Whether Home should use environment rows or compact object cards.
- Whether Mod Library should default to Discover or Downloaded Inventory.
- Whether Settings/Accounts/Help should share a common system-panel frame.
- Whether to introduce a small shared UI primitive layer before or during redesign.
- Whether to generate mockups as preview-only artifacts or commit selected concepts into `docs/ui-redesign/`.

## Recommended Next Step

Generate Mockup Set 1 with three shell directions, choose one direction, then generate Mockup Set 2 only for the chosen direction. Do not implement until the shell direction is accepted.
