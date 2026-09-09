---
name: simmrust-runtime-library
description: Preserve SIMM runtime-aware mod library behavior for mods, plugins, UserLibs, shared storage, metadata synchronization, managed copy installs, runtime prompts, compatibility badges, and mod update state. Use for changes under library management, environment installs, runtime detection, source metadata, or update summaries.
---

# SIMM Runtime Library

## Workflow

1. Trace the user action from UI to `ApiService`, Rust command, service, filesystem or DB mutation, event emission, and UI refresh.
2. Identify whether the item is a shared library asset, an environment-local unmanaged item, or a runtime-specific install target.
3. Preserve metadata in the storage projection and environment projection that the UI reads.
4. Emit the correct changed/update events after filesystem-visible state changes.
5. Validate with focused tests for runtime detection, metadata sync, install/uninstall, and update badges.

## Invariants

- Preserve the library-first model: shared storage plus per-environment managed copies.
- Prefer explicit metadata over filename heuristics for runtime decisions.
- Unknown runtime should prompt the user rather than silently default.
- Runtime compatibility must not cross IL2CPP and Mono unless the item is truly runtime-agnostic.
- Do not fix visible badges only; confirm the persisted storage and environment metadata agree.

Read `references/runtime-library-playbook.md` before making non-trivial changes.
