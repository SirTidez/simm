# API Crate Integration Recommendations

This project now runs NexusMods and Thunderstore calls through immutable crates only.

## Current integration posture

- Command contracts are stable.
- Service adapters are crate-backed only.
- Legacy in-app HTTP branches for these handlers have been removed.

## Next recommended work (non-blocking)

1. Keep dependencies pinned to git commit SHAs in `src-tauri/Cargo.toml` and bump intentionally.
2. Add crate-level semantic versions/tags and release notes so app upgrades can be tracked safely.
3. Keep contract tests around response-shape mapping in app services to catch crate changes early.
