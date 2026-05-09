---
name: simmrust-desktop-ui-validation
description: Design, implement, or review SIMM desktop UI changes using the app's native utility direction, existing React/Tauri boundaries, overlay architecture, CSS system, and real Tauri smoke-test concerns. Use for app shell, overlays, mod library UI, environment UI, logs/configuration/accounts/settings screens, responsive desktop layout, or UI ship-readiness work.
---

# SIMM Desktop UI Validation

## Workflow

1. Treat SIMM as an operational desktop utility, not a landing page or marketing dashboard.
2. Read the current component, store, API, event, and CSS surfaces before changing UI.
3. Preserve existing app boundaries: UI actions through `ApiService`, events through `events.ts`, theme variables through the current styling model.
4. Prefer dense split views, tables, toolbars, inspectors, status bars, and dialogs for blocking decisions.
5. Validate with TypeScript first, then tests/build; use real Tauri-hosted review when behavior depends on Tauri APIs.

## Design Guardrails

- No hero sections, bento dashboards, decorative gradients, pill spam, or nested card stacks for core app workflows.
- Primary and destructive actions must not rely on hover-only icon affordances.
- Keep desktop controls compact, labeled where needed, keyboard reachable, and stable across window sizes.
- Use the existing FontAwesome `Icon` wrapper unless the repo intentionally migrates.

Read `references/desktop-ui-playbook.md` before broad UI changes.
