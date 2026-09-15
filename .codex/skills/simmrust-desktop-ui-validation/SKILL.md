---
name: simmrust-desktop-ui-validation
description: "Design and validate SIMM desktop UI. Use when changing app layout, overlays, interaction states, or responsive behavior that needs real Tauri-host evidence."
---

# SIMM Desktop UI Validation

## Workflow

1. Treat SIMM as an operational desktop utility, not a landing page or marketing dashboard.
2. Read the current component, store, API, event, and CSS surfaces before changing UI.
3. Preserve existing app boundaries: UI actions through `ApiService`, events through `events.ts`, theme variables through the current styling model.
4. Prefer dense split views, tables, toolbars, inspectors, status bars, and dialogs for blocking decisions.
5. For layout changes, account for 1080p, 1440p, and 4k desktop viewports. Keep desktop rem sizing stable and fix component/container constraints instead of relying on viewport-wide root font scaling.
6. Validate with TypeScript first, then tests/build; use real Tauri-hosted review when behavior depends on Tauri APIs.

## Design Guardrails

- No hero sections, bento dashboards, decorative gradients, pill spam, or nested card stacks for core app workflows.
- Primary and destructive actions must not rely on hover-only icon affordances.
- Keep desktop controls compact, labeled where needed, keyboard reachable, and stable across window sizes.
- Avoid desktop breakpoint font-size scaling that makes controls render differently on high-resolution monitors.
- Use the existing FontAwesome `Icon` wrapper unless the repo intentionally migrates.

Read `references/desktop-ui-playbook.md` before broad UI changes.
