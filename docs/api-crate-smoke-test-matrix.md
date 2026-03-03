# API Crate Smoke Test Matrix

Date: 2026-03-02

## Scope

Validate crate-only behavior for NexusMods and Thunderstore handlers.

## Automated verification (executed)

### Build/test baseline

- `cd src-tauri && cargo check` -> PASS
- `cd src-tauri && cargo test` -> PASS (`108+ tests passing; exact count depends on ignored live tests`)

### Explicit failure paths (expected uncovered crate endpoints)

- `services::nexus_mods::tests::crate_mode_rate_limits_returns_explicit_uncovered_error` -> PASS
- `services::nexus_mods::tests::crate_mode_download_returns_explicit_uncovered_error` -> PASS

### Thunderstore download URL conversion

- `services::thunderstore::tests::crate_download_path_supports_thunderstore_url` -> PASS
- `services::thunderstore::tests::crate_download_path_keeps_query_params` -> PASS
- `services::thunderstore::tests::crate_download_path_rejects_non_thunderstore_host` -> PASS

### Live API smoke checks (executed)

- `cargo test live_search_and_fetch_package -- --ignored` -> PASS
  - `services::thunderstore::tests::live_search_and_fetch_package`
- `cargo test live_validate_api_key_via_crate` -> PASS
  - `services::nexus_mods::tests::live_validate_api_key_via_crate`

## Manual desktop matrix

1. Nexus key validation in Accounts overlay -> should succeed.
2. Nexus rate limits fetch -> should fail fast with unsupported crate error (known gap).
3. Nexus install/download flow -> should fail fast with unsupported crate error (known gap).
4. Thunderstore search + package details -> should succeed.
5. Thunderstore download using `https://thunderstore.io/package/download/.../` -> should succeed.
6. Thunderstore download from non-`thunderstore.io` host (if encountered) -> should fail fast with unsupported host error.

## Notes

- TypeScript compiler check remains blocked in this environment because `npx tsc --noEmit` cannot run without TypeScript installed locally.
- Known uncovered areas are tracked in `docs/api-crate-coverage-gaps.md`.
