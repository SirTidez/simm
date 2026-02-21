# Coding Standards

This document defines coding standards and best practices for SIMM (Schedule I Mod Manager).

The codebase may not yet conform to all rules here; this file defines the target state for new and updated code.

## Table of Contents

- [General Principles](#general-principles)
- [TypeScript and React Standards](#typescript-and-react-standards)
- [Rust Standards](#rust-standards)
- [IPC and Shared Type Contract](#ipc-and-shared-type-contract)
- [Mod Library and Runtime Rules](#mod-library-and-runtime-rules)
- [Event and State Management Rules](#event-and-state-management-rules)
- [Database and Secrets Conventions](#database-and-secrets-conventions)
- [File Organization](#file-organization)
- [Naming Conventions](#naming-conventions)
- [Testing Standards](#testing-standards)
- [Formatting and Checks](#formatting-and-checks)
- [Comments and Documentation](#comments-and-documentation)

## General Principles

### Code Quality

- Write self-documenting code first; comments should explain why, not what.
- Keep command handlers thin and place business logic in service modules.
- Preserve single responsibility at file and function level.
- Prefer explicit, strongly typed interfaces over `any` and loosely shaped objects.
- Remove dead code promptly; do not leave speculative code paths.

### Reliability

- Any user-facing action should have deterministic success/error handling.
- Keep frontend and backend state models synchronized at all times.
- Avoid hidden side effects; emit events for meaningful asynchronous transitions.

### Consistency

- Route all frontend-backend calls through `src/services/api.ts`.
- Route all event subscriptions through `src/services/events.ts`.
- Mirror Rust DTOs in TypeScript interfaces (`src-tauri/src/types.rs` <-> `src/types/index.ts`).

## TypeScript and React Standards

### Component Structure

Use functional components and typed props.

```tsx
type ConfirmOverlayProps = {
  isOpen: boolean;
  onClose: () => void;
};

export function ConfirmOverlay({ isOpen, onClose }: ConfirmOverlayProps) {
  if (!isOpen) return null;
  return <div />;
}
```

### Organization Order

In each component file, follow this order:

1. Imports
2. Types/interfaces
3. Constants/helpers
4. Main component
5. Small private subcomponents/helpers

### State and Effects

- Keep store-level state in context providers (`environmentStore`, `settingsStore`).
- Keep overlay-local concerns in local component state.
- Always clean up event listeners in `useEffect` return callbacks.
- Avoid cascading re-renders by scoping state to the narrowest useful component.

### API and Events

- Do not call `invoke()` directly in arbitrary components when an `ApiService` wrapper exists.
- Add or update typed request/response shapes in `ApiService` whenever command contracts change.
- Use typed event helper functions (`onModsChanged`, `onUpdateAvailable`, etc.), not ad-hoc `listen()` calls scattered through UI.

### Error Handling

- Async handlers must use `try/catch` and set meaningful UI errors when relevant.
- Log unexpected errors with context (which operation failed).
- Never silently swallow errors unless intentionally non-blocking and documented.

### Styling

- Preserve the app's CSS variable based theming model in `settingsStore` and `style.css`.
- Use existing button/modals/badge classes before inventing new patterns.
- Keep overlay z-index layering consistent (`modal-overlay`, `modal-overlay-nested`).

## Rust Standards

### Command-Service Split

- Command modules in `src-tauri/src/commands/` should validate inputs, construct services, and delegate.
- Service modules in `src-tauri/src/services/` own orchestration and domain behavior.

### Error Handling

- Use `anyhow::Result` with `.context(...)` in service code.
- Convert errors to command-friendly strings only at command boundaries.
- Avoid `.unwrap()` in production logic; `.expect(...)` is only acceptable in tests and clearly safe contexts.

### Logging

- Use `log::info!` for important milestones, `log::warn!` for recoverable issues, `log::error!` for correctness-impacting failures.
- Never log secret values (tokens, credentials, decrypted content).

### Shared State and Concurrency

- Shared service instances should use `Arc` and async locks where needed.
- Keep long-running background tasks isolated and resilient to transient failures.
- Any long-lived cached client that depends on settings must refresh runtime-sensitive settings before use.

### Serialization and DTOs

- Use serde rename annotations consistently (`camelCase` at frontend IPC boundaries).
- Ensure enums and optional fields are represented consistently across Rust and TypeScript.

## IPC and Shared Type Contract

### Contract Rules

- Command names in frontend wrappers must match backend command function names.
- When adding/modifying a Rust field, update the corresponding TypeScript interface in the same change.
- Keep date/time and enum encodings stable; document any compatibility-impacting changes.

### Source of Truth

- Backend is authoritative for persisted state.
- Frontend should reflect backend state, not infer conflicting local truth.

## Mod Library and Runtime Rules

These are project-critical invariants.

### Storage Model

- Preserve the library-first storage model: shared storage + per-environment symlinks.
- Do not regress to copying full mod payloads into each environment unless explicitly intended.

### Metadata Rules

- Any install/uninstall/enable/disable operation must keep metadata in sync.
- Runtime/source/version metadata should be persisted where the library projection reads it.
- If installation writes environment metadata, also ensure storage metadata remains authoritative for library views.

### Runtime Handling

- Runtime detection should prefer explicit metadata over filename heuristics.
- If runtime cannot be detected confidently, prompt the user for selection before install.
- Never default unknown runtime in a way that produces misleading compatibility badges.

### Update State

- Update checks must cover all supported source types uniformly.
- Token/settings behavior should be consistent across update endpoints.

## Event and State Management Rules

### Event Emission

- Emit `mods_changed`, `plugins_changed`, `userlibs_changed` when filesystem-visible state changes.
- Emit update events after update-check operations complete.

### Event Consumption

- Frontend stores/components should subscribe once per scope and clean up reliably.
- Prefer updating existing state in place over heavy full-page reload behavior.

### Store Responsibilities

- `environmentStore`: environments, progress, update state, lifecycle actions.
- `settingsStore`: settings/depot info and theme application.
- Keep cross-store coupling minimal.

## Database and Secrets Conventions

### Database

- All schema changes must go through SQL migrations in `src-tauri/migrations/`.
- Keep migration scripts idempotent (`IF NOT EXISTS` patterns where appropriate).

### Secrets

- Store secrets in encrypted form via backend services only.
- Never persist tokens in plain settings JSON payloads.
- Never expose secret material to frontend logs.

## File Organization

```text
simmrustglm/
|- src/                     # React frontend
|  |- components/           # UI overlays and shell components
|  |- services/             # ApiService + event wrappers
|  |- stores/               # React context providers
|  |- types/                # TS IPC/domain interfaces
|  |- style.css             # global and themed styling
|- src-tauri/
|  |- src/commands/         # Tauri command handlers
|  |- src/services/         # backend business/domain logic
|  |- src/events.rs         # backend event emitters
|  |- src/db.rs             # SQLite initialization and migration helpers
|  |- src/types.rs          # shared Rust DTOs and enums
|  |- migrations/           # SQL schema migrations
```

## Naming Conventions

### TypeScript

- Variables/functions: `camelCase`
- React components/types: `PascalCase`
- Event handlers: prefix with `handle` (`handleUploadClick`)
- Boolean fields: prefix with `is`, `has`, `should`, `can`

### Rust

- Modules/functions/fields: `snake_case`
- Types/enums: `PascalCase`
- Constants: `SCREAMING_SNAKE_CASE`

## Testing Standards

### Frontend

- Use Vitest + Testing Library.
- Co-locate tests with feature files when practical (`*.test.ts`, `*.test.tsx`).
- Focus tests on command wrapper behavior, overlay workflows, and runtime-sensitive UI logic.

### Backend

- Use `cargo test` for unit/integration tests in service and command modules.
- Add regression tests for runtime detection, update checks, and metadata synchronization.

## Formatting and Checks

Run before merging:

```bash
# Frontend
npm run build
npm run test

# TypeScript check
npx tsc --noEmit

# Backend
cd src-tauri && cargo check
cd src-tauri && cargo test
cd src-tauri && cargo fmt
```

`tsconfig.json` strictness flags (`strict`, `noUnusedLocals`, `noUnusedParameters`, `noFallthroughCasesInSwitch`) must remain enabled.

## Comments and Documentation

### Comments

- Prefer brief comments explaining intent and invariants.
- Use standardized tags when needed:
  - `TODO:` planned follow-up
  - `FIXME:` known incorrect behavior
  - `NOTE:` important context

### Documentation Updates

Update docs when changing:

- architecture-critical data flow
- IPC contract and type shapes
- mod storage/runtime/update invariants

---

## References

- `README.md`
- `ARCHITECTURE.md`
- `src/services/api.ts`
- `src/services/events.ts`
- `src/stores/environmentStore.tsx`
- `src-tauri/src/main.rs`
- `src-tauri/src/types.rs`
