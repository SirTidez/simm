# API Crate Integration Recommendations

This app treats `nexus-api` and `thunderstore-api` as immutable and adapts around their current surface area.

## Immediate recommendations

1. Keep a strict adapter boundary in app services:
   - `src-tauri/src/services/nexus_mods.rs`
   - `src-tauri/src/services/thunderstore.rs`
2. Keep command contracts stable to avoid frontend churn:
   - `src-tauri/src/commands/nexus_mods.rs`
   - `src-tauri/src/commands/thunderstore.rs`
3. Keep crate-only behavior explicit in docs and tests for uncovered endpoints.

## Recommended crate additions (future)

### For `nexus-api`

1. Add a rate-limit API that exposes daily/hourly metrics from response headers.
2. Add REST file download helpers:
   - fetch download link for `(game_id, mod_id, file_id)`
   - download bytes for returned URI
3. Extend `validate_api_key` return data to include support-tier flags needed by UI.

References:

- `C:\Users\SirTidez\WebstormProjects\nexusapitests\crates\nexus-api\src\lib.rs`
- `C:\Users\SirTidez\WebstormProjects\nexusapitests\crates\nexus-api\src\types.rs`

### For `thunderstore-api`

1. Add absolute URL request support (or host allowlist support) for download URLs.
2. Optionally add typed helpers for package search/details/download to reduce app-side parsing and mapping.

References:

- `C:\Users\SirTidez\WebstormProjects\nexusapitests\crates\thunderstore-api\src\lib.rs`
- `C:\Users\SirTidez\WebstormProjects\nexusapitests\crates\thunderstore-api\src\types.rs`

## Dependency migration recommendation

Current implementation uses local path dependencies in `src-tauri/Cargo.toml`.

When repositories are created:

1. Move to git dependencies pinned by commit SHA.
2. Optionally move to submodules if coordinated release management is needed.
3. Keep lockfile updated and verify reproducible builds in CI.

## Validation recommendation

Run crate-only smoke checks before each rollout step:

1. Success paths for crate-supported endpoints
2. Expected hard-failure paths for uncovered endpoints
