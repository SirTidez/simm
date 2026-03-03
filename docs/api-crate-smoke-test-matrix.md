# API Crate Smoke Test Matrix

Date: 2026-03-03

## Scope

Validate crate-only behavior for NexusMods and Thunderstore handlers.

## Automated verification (executed)

- `cd src-tauri && cargo check` -> PASS
- `cd src-tauri && cargo test` -> PASS (`105 passed, 0 failed, 2 ignored`)

## Covered behavior checks

- Nexus crate validation path:
  - `services::nexus_mods::tests::live_validate_api_key_via_crate` -> PASS
- Nexus rate-limit mapping utility:
  - `services::nexus_mods::tests::map_rate_limits_to_legacy_maps_expected_fields` -> PASS
- Thunderstore crate package/search live path:
  - `services::thunderstore::tests::live_search_and_fetch_package` -> exists (`ignored`, manual opt-in)

## Manual desktop verification checklist

1. Validate Nexus API key in Accounts overlay.
2. Confirm premium/supporter badge behavior reflects crate validation output.
3. Confirm Nexus rate limits display updates in Accounts overlay.
4. Install Nexus mod from Mods overlay.
5. Install Thunderstore mod from Mods overlay.
6. Run mod update checks for both sources.
