# IPC Contract Playbook

## Add Or Change A Command

1. Search existing commands, `ApiService` methods, and DTOs before adding a new command; extend the existing contract when it already owns the behavior.
2. Add or update service logic in `src-tauri/src/services/`.
3. Keep the command in `src-tauri/src/commands/` thin: validate input, construct services, delegate, convert errors at the command boundary.
4. Register commands in `generate_handler!` in `src-tauri/src/main.rs`.
5. Add a typed wrapper in `src/services/api.ts`.
6. Mirror request and response DTOs between `src-tauri/src/types.rs` and `src/types/index.ts`.
7. Add focused tests for the changed command wrapper or service behavior.

## Add Or Change An Event

1. Define or update backend emission in `src-tauri/src/events.rs`.
2. Emit from the service or command that owns the state transition.
3. Add or update the typed frontend listener helper in `src/services/events.ts`.
4. Subscribe once per scope in the relevant store or component and clean up in the effect return.
5. Test the store/component path when UI behavior depends on the event.

## Review Checklist

- Search for direct `invoke` imports outside `src/services/api.ts`.
- Search for direct `listen` imports outside `src/services/events.ts`.
- Confirm TypeScript names match Rust command names exactly.
- Confirm optional fields and enum values are serialized consistently.
- Run TypeScript validation before treating Vitest or Vite build as enough.
