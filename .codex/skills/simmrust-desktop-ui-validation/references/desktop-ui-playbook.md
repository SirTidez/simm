# Desktop UI Playbook

## Product Direction

SIMM should feel like a native operational desktop utility:

- Dense enough for repeated use, but not cramped.
- Persistent navigation, compact workspace headers, toolbars, tables, split panes, inspectors, and status bars.
- Cards only where they represent real objects, repeated rows, dialogs, or framed tools.
- Clear selected state, running state, changed state, risky action state, and next action.

## Preferred Anatomy

```text
Window chrome
Primary app rail | Context sidebar | Workspace toolbar
                 |                 | Main list/table/editor | Detail/inspector
Status bar
```

Use dialogs for destructive confirmation, credential entry, runtime choice, file/folder pickers, and short blocking decisions. Avoid dialogs for browsing libraries or managing persistent environment assets.

## Existing Boundaries

- Keep frontend backend calls in `src/services/api.ts`.
- Keep event listeners in `src/services/events.ts`.
- Keep persistent state in stores where it already belongs.
- Preserve CSS variable theming and existing component classes before inventing new visual systems.
- Use the existing icon wrapper and icon dependency unless migration is explicit.

## Validation

- `bunx tsc --noEmit` is the first frontend correctness gate.
- `bun run lint` warnings are review prompts; `react-hooks/rules-of-hooks` is correctness work.
- `bun run test` and `bun run build` are not enough by themselves.
- Plain Vite smoke tests do not prove Tauri-hosted behavior for code that depends on Tauri APIs.
- When possible, review actual Tauri-hosted UI for window, protocol, filesystem, and IPC-dependent behavior.

## Anti-Patterns

- Landing-page hero structures inside the app.
- Generic dashboard bento grids as the core layout.
- Glow-heavy, gradient-heavy, or decorative visual systems.
- Hover-only access to primary or destructive actions.
- Nested cards where split panes, tables, and inspectors would be clearer.
