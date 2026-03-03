# API Crate Refactor Plan

## Goal

Use immutable external crates as the only NexusMods and Thunderstore API handlers:

- `nexus-api` from `https://github.com/SirTidez/nexusmods-api-handler`
- `thunderstore-api` from `https://github.com/SirTidez/thunderstore-api-handler`

while keeping existing Tauri command contracts stable.

## Constraints

- External crates are treated as immutable from this app.
- Existing command names and payload shapes remain stable.
- Remaining gaps are documented with direct references (currently none for requested scope).

## Final architecture

1. Service layer is crate-only:
   - `src-tauri/src/services/nexus_mods.rs`
   - `src-tauri/src/services/thunderstore.rs`
2. Command layer no longer performs mode switching and only handles API key hydration for Nexus.
3. Frontend settings no longer expose API handler mode toggle.

## Crate usage mapping

### Nexus

- GraphQL operations via `nexus_api::execute_graphql(...)`.
- API key validation via `nexus_api::validate_api_key_detailed(...)`.
- Rate limits via detailed validation result (`rate_limits`).
- File downloads via `get_download_links(...)` + `download_from_url(...)`.

### Thunderstore

- Search/package metadata via `thunderstore_api::request("GET", path, ...)`.
- Package downloads via crate absolute URL request `request_url(...)`.

## Acceptance criteria

1. No feature flag controls API handler mode.
2. No legacy direct HTTP API branches remain for Nexus/Thunderstore service calls.
3. Existing command names and payload shapes remain stable.
4. Coverage gaps/recommendations docs remain up to date.

## Status

- [x] Created `api-refactor` worktree and branch.
- [x] Added crate dependencies as pinned git deps.
- [x] Migrated Nexus service to crate-only implementation.
- [x] Migrated Thunderstore service to crate-only implementation.
- [x] Removed API handler feature flag from settings types and UI.
- [x] Removed command-layer mode plumbing.
- [x] Removed temporary unsupported-endpoint stubs now that crate APIs cover requested flows.
- [x] Updated coverage and recommendation docs.
- [x] Ran backend compile/tests successfully.
- [ ] Execute final manual desktop smoke pass on current branch.
