---
name: simmrust-ipc-contracts
description: Maintain SIMM frontend/backend IPC contracts across Tauri commands, Rust DTOs, TypeScript types, ApiService wrappers, event helpers, and tests. Use when adding, renaming, deleting, or debugging invoke commands, Tauri events, shared request/response types, or frontend/backend contract drift.
---

# SIMM IPC Contracts

## Workflow

1. Identify the contract surface: command, event, DTO, store action, or component workflow.
2. Keep Rust command handlers thin and put business logic in `src-tauri/src/services/`.
3. Mirror shared DTO changes between `src-tauri/src/types.rs` and `src/types/index.ts`.
4. Route frontend calls through `src/services/api.ts`; route event listeners through `src/services/events.ts`.
5. Add or update tests on the side where behavior changed, then validate TypeScript before trusting build/test success.

## Invariants

- Backend persisted state is authoritative; frontend state must reflect it.
- Command names in frontend wrappers must match backend registered Tauri commands.
- Use camelCase at IPC boundaries and stable enum/string encodings.
- Clean up event listeners in React effects.
- Avoid direct `invoke` or `listen` imports outside the central service boundary unless the repo has an explicit exception.

## Checks

Run `scripts/check_ipc_contracts.py` for a fast read-only drift scan. Use the output as a review prompt; still inspect the code path before editing.

For deeper guidance, read `references/ipc-contract-playbook.md`.
