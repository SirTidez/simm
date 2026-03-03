# API Crate Coverage Gaps

This file tracks functionality used by this app that is not yet fully covered by the immutable crates.

## Nexus gaps

### 1) Rate limits (daily/hourly usage)

- **App usage**:
  - `src-tauri/src/services/nexus_mods.rs:102` (`get_rate_limits`)
  - `src-tauri/src/commands/nexus_mods.rs:87` (`get_nexus_mods_rate_limits`)
  - `src/components/SteamAccountOverlay.tsx:55` (rate limit display)
- **Reason this is uncovered**:
  - Current crate surface (`execute_graphql`, `validate_api_key`) does not expose response headers needed for rate-limit metrics.
- **Crate references**:
  - `C:\Users\SirTidez\WebstormProjects\nexusapitests\crates\nexus-api\src\lib.rs:13` (`execute_graphql`)
  - `C:\Users\SirTidez\WebstormProjects\nexusapitests\crates\nexus-api\src\lib.rs:98` (`validate_api_key`)

### 2) Mod file download bytes for install/update

- **App usage**:
  - `src-tauri/src/services/nexus_mods.rs:696` (`download_mod_file`)
  - `src-tauri/src/commands/nexus_mods.rs:172` (`download_nexus_mods_mod_file`)
  - `src-tauri/src/commands/nexus_mods.rs:226` (`install_nexus_mods_mod`)
  - `src-tauri/src/services/mod_update.rs:450` (Nexus update path)
- **Reason this is uncovered**:
  - Crate currently provides GraphQL + validation only, and does not wrap the REST `download_link` + binary transfer flow.
- **Crate references**:
  - `C:\Users\SirTidez\WebstormProjects\nexusapitests\crates\nexus-api\src\lib.rs:13`

### 3) Premium/supporter flags for account UX

- **App usage**:
  - `src/components/SteamAccountOverlay.tsx:10` (premium/supporter badge)
- **Reason this is uncovered**:
  - Crate `validate_api_key` returns `UserInfo` (`member_id`, `name`) only.
- **Crate references**:
  - `C:\Users\SirTidez\WebstormProjects\nexusapitests\crates\nexus-api\src\types.rs:38` (`UserInfo`)

## Thunderstore gaps

### 1) Absolute download URL support beyond thunderstore.io host

- **App usage**:
  - `src-tauri/src/services/thunderstore.rs:302` (`download_package`)
  - `src-tauri/src/commands/thunderstore.rs:53` (`download_thunderstore_package`)
  - `src-tauri/src/services/mod_update.rs:376` (Thunderstore update path)
- **Reason this is partially uncovered**:
  - Crate API is path-based against fixed `BASE_URL`, which currently restricts crate-mode download behavior to `thunderstore.io` host URLs.
  - Crate mode intentionally hard errors for non-`thunderstore.io` hosts.
- **Crate references**:
  - `C:\Users\SirTidez\WebstormProjects\nexusapitests\crates\thunderstore-api\src\lib.rs:9` (`BASE_URL`)
  - `C:\Users\SirTidez\WebstormProjects\nexusapitests\crates\thunderstore-api\src\lib.rs:14` (`request`)

## Current crate-mode behavior

- Supported operations run through crate handlers.
- Uncovered operations fail fast with explicit errors and inline TODO markers in code.
