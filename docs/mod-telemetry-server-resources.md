# Mod Telemetry Server Resources

This scaffold keeps SIMM telemetry local and disabled by default. Future server upload must stay anonymous: no machine identifiers, no usernames, no absolute paths, no stable client IDs, and no implicit collection before explicit opt-in.

## Live Event Contract

Live telemetry uses a separate `schemaVersion: 1` batch contract rather than the older manual snapshot payload. SIMM records sessions locally while a registered Schedule I environment is running, then produces an inspectable export preview without sending it anywhere.

- A local session holds environment branch/runtime/version and an immutable mod inventory captured when monitoring starts.
- Each `WARN`, `ERROR`, or `FATAL` occurrence is retained with time, attribution (`mod`, `system`, or `unknown`), source label, line number, and attach/live origin.
- `fingerprint` is a hash of normalized sanitized text for grouping. It is not a user ID and should not be treated as a privacy guarantee for low-entropy messages.
- Readable `message` content is absent unless the user separately enables sanitized excerpts.
- Export creates fresh random session and event IDs. Each opt-in upload attempt must create a random `uploadId` UUID; it is never a stable client or installation identifier. The payload never exports SIMM's local environment ID, install path, process ID, command line, or database IDs.

The client does not implement HTTP upload, queueing, retries, or endpoint configuration. Server work should consume this versioned batch only after the user has reviewed the local preview. The future route must pass its received raw UTF-8 string or bytes through the contract's `telemetryBatchRouteBoundary.parse` before any JSON parsing, so the 1 MiB raw-body ceiling cannot be bypassed with whitespace.

## Client Batch Payload

The future upload payload is intentionally smaller than the local UI model:

- `schemaVersion`: currently `1` only.
- `uploadId`: a random per-upload UUID used exclusively for safe retries.
- `exportedAt`: UTC export timestamp.
- `sessions`: 1-100 anonymous live sessions, each with environment, mod inventory, and at most 5,000 events.
- `events`: only `WARN`, `ERROR`, and `FATAL` entries, with a fixed-width fingerprint, source label, line number, attribution, and attach/live origin.

All envelopes and nested records reject unknown fields. The server rejects absolute-path-like strings, email addresses, unsupported schema versions, and collections over the documented limits. Raw `message` text is safety-validated and discarded during ingestion; it must never be stored or used for aggregation.

Do not upload local `environmentId`, output directories, storage IDs, usernames, emails, full logs, raw paths, Steam account data, Nexus tokens, or any stable install/client identifier.

## Minimum Server Resources

- `POST /v1/telemetry/batches`: accept anonymous telemetry batches up to 1 MiB. A new `uploadId` receives `202`; a previously accepted `uploadId` receives `200` for a safe retry. Require schema validation and rate limiting by IP at the edge only.
- `GET /v1/telemetry/schema`: expose current accepted schema versions and field constraints so old clients can fail closed.
- `GET /v1/mods/{source}/{name}/health`: aggregated public mod health summaries for users and developers.
- `GET /v1/developers/mods/{source}/{name}/errors`: authenticated developer view for aggregated error signatures.
- `POST /v1/developers/mod-claims`: developer claim workflow for associating source/name pairs with an account.

## Storage Model

- Raw telemetry messages are discarded during ingestion. Only normalized short-lived fields and error signatures may persist for the documented 14-30 day retention window.
- Aggregates persist as documented and are keyed by mod source/name/version, runtime, S1 version, and error signature.
- Error signatures should be derived from sanitized exception type/message/stack frame patterns, not full raw excerpts.
- Any IP-based rate-limit metadata should be kept outside the analytical dataset and expire quickly.

## Privacy And Abuse Controls

- Upload requires explicit opt-in and must be reversible from settings.
- A local preview should show the exact upload payload before first upload.
- Server ingestion should reject payloads containing path-like strings, emails, oversized excerpts, or unexpected identifier fields.
- Public views should enforce minimum sample thresholds before showing mod-specific error rates.
- Developer views should show aggregate signatures and counts, not individual user sessions.
