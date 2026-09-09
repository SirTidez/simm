# Task 8: reviewed telemetry upload pipeline

Implemented the durable, user-triggered telemetry upload boundary.

- Migration `0006_telemetry_upload_queue.sql` stores a per-upload UUID and the immutable serialized payload with `pending`, `sending`, `accepted`, and `failed` queue states.
- Upload preparation excludes active sessions and local environment IDs. The upload envelope contains no SIMM, Nexus Mods, Steam, or other account identifiers.
- Queueing and retrying require both collection and upload opt-in. There is no automatic upload timer; only the reviewed upload action and explicit Retry send requests.
- The upload service only uses the configured compile-time base URL and rejects non-HTTPS URLs outside development builds. It records safe status codes only and never returns response bodies to the UI.
- The telemetry workspace now presents a local payload review dialog, exclusions and totals, a separate review acknowledgement, then a disabled-until-confirmed upload checkbox. It shows safe Accepted, Already accepted, Failed before acceptance, and Rejected HTTP status messages.

## Test-first evidence

- Observed RED: `cargo test --manifest-path src-tauri/Cargo.toml telemetry_upload --no-fail-fast` initially failed because `telemetry_upload` did not exist.
- Observed RED: API IPC test failed before API wrapper methods were added.
- Observed RED: the local HTTP acceptance test failed before the service had a test base-URL injection seam.

## Validation

Passed on 2026-07-14:

```text
bun install
bunx tsc --noEmit
bun run lint                 # 0 errors; 20 pre-existing advisory warnings
bun run test                 # 32 files, 309 tests passed
bun run build
cargo check --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml  # 364 passed; 6 intentionally ignored
```

The focused Rust upload suite passed 4 tests, covering opt-in enforcement, local-ID/path-free preview, exact reviewed export preservation plus immutable retry identity, and a real local HTTP 202 acceptance response.

## P1 remediation

- Preview now creates the complete envelope, including its one-time `uploadId`, and the exact pretty-serialized bytes shown in the modal are the bytes inserted into the queue and sent. Queueing validates but never re-envelopes or reserializes reviewed data.
- Logger sanitization now redacts backslash and forward-slash Windows paths, Unix paths, and `file:` URIs. The upload safety boundary rejects those same path forms before they can be stored or transmitted.
- URL configuration is resolved before the state becomes `sending`; an invalid URL yields the safe `configuration_error` failed state. Listing deterministically converts interrupted `sending` rows into retryable `failed` rows.
- Added red-to-green coverage for all of the above, including `C:/Users/Alice/...` rejection, exact preview-byte persistence, invalid configuration, and interrupted-send recovery.

Final P1 validation rerun: 309 frontend tests passed; Cargo passed 369 tests with 6 intentionally ignored. Lint remains 0 errors with 20 existing advisory warnings.

## Follow-up contract and delimiter remediation

- The one-time upload envelope now normalizes `exportedAt`, session `startedAt`/`endedAt`, and event `occurredAt` through RFC 3339 parsing into canonical UTC millisecond strings ending in `Z`. The reviewed bytes remain immutable once queued; later validation verifies, rather than reserializes, those bytes.
- The logger and the upload safety guard both recognize absolute Unix paths after non-whitespace delimiters such as `setting=/home/alice/private.txt`. The logger replaces the path with a safe summary and the upload guard refuses to queue the payload.

Focused validation passed on 2026-07-14:

```text
cargo test --manifest-path src-tauri/Cargo.toml sanitize_log_text_redacts_unix_paths_after_non_whitespace_delimiters -- --nocapture
cargo test --manifest-path src-tauri/Cargo.toml telemetry_upload_tests -- --nocapture
```

The upload suite passed 11 tests, including canonical strict-UTC timestamp serialization and delimiter-embedded Unix path rejection.

## Final review remediation

- Queue-time validation now requires every upload timestamp to already match the canonical UTC millisecond representation produced for the preview (for example `2026-07-14T00:00:00.000Z`). It rejects equivalent-but-differently-serialized strings such as `2026-07-14T00:00:00Z`, preserving the reviewed bytes exactly.
- The database-only upload record now owns the serialized payload. Renderer-facing queue, list, and retry receipts expose only opaque IDs, state, attempts, safe error codes, and timestamps; only the pre-confirmation preview DTO includes the reviewed payload.
- The review modal correctly says its anonymous upload UUID is created when the preview is prepared.

Focused final-remediation validation: `cargo test --manifest-path src-tauri/Cargo.toml telemetry_upload --no-fail-fast` passed 13 tests; `bunx tsc --noEmit` and `bun run test -- src/services/api.test.ts` also passed.
