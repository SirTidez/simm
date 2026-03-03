# API Crate Refactor Plan

## Goal

Use immutable external crates as the only NexusMods and Thunderstore API handlers:

- `nexus-api` from `C:\Users\SirTidez\WebstormProjects\nexusapitests\crates\nexus-api`
- `thunderstore-api` from `C:\Users\SirTidez\WebstormProjects\nexusapitests\crates\thunderstore-api`

while keeping existing Tauri command contracts stable.

## Constraints

- External crates are treated as immutable from this app.
- Existing command names and payload shapes remain stable.
- Unsupported crate functionality fails fast with explicit errors.
- Uncovered endpoints are documented with direct references.

## Final architecture

1. Service layer is crate-only:
   - `src-tauri/src/services/nexus_mods.rs`
   - `src-tauri/src/services/thunderstore.rs`
2. Command layer no longer performs mode switching and only handles API key hydration for Nexus.
3. Frontend settings no longer expose API handler mode toggle.

## Crate usage mapping

### Nexus

- GraphQL operations via `nexus_api::execute_graphql(...)`.
- API key validation via `nexus_api::validate_api_key(...)`.
- Uncovered in crate:
  - rate-limit header metrics
  - file download (download link + binary bytes)

### Thunderstore

- Search/package metadata via `thunderstore_api::request("GET", path, ...)`.
- Package downloads via crate request using converted path from `download_url`.
- Non-`thunderstore.io` hosts fail fast (explicit error).

## Acceptance criteria

1. No feature flag controls API handler mode.
2. No legacy direct HTTP API branches remain for Nexus/Thunderstore service calls.
3. Existing command names and payload shapes remain stable.
4. Unsupported crate endpoints fail with clear errors.
5. Coverage gaps/recommendations docs remain up to date.

## Status

- [x] Created `api-refactor` worktree and branch.
- [x] Added crate dependencies as local path deps.
- [x] Migrated Nexus service to crate-only implementation.
- [x] Migrated Thunderstore service to crate-only implementation.
- [x] Removed API handler feature flag from settings types and UI.
- [x] Removed command-layer mode plumbing.
- [x] Retained TODO markers and explicit unsupported-endpoint errors.
- [x] Updated coverage and recommendation docs.
- [x] Ran backend compile/tests successfully.
- [ ] Execute final manual desktop smoke pass on current branch.
