# Nexus FOMOD Debug Playbook

## Split The Problem First

Classify the failure before editing:

- `nxm://` protocol routing: protocol owner, runtime registration, single-instance handling, Vortex handoff.
- OAuth: callback URI, initial code exchange, refresh-token recovery, scary log severity.
- API key or provider API: validation, rate limits, premium/supporter flags, download links.
- Manual download completion: pending session state, runtime choice, terminal cleanup.
- FOMOD archive parsing: archive structure, `fomod/ModuleConfig.xml`, XML encoding, option extraction.
- Frontend replay: focus polling, consumed callback tracking, repeated runtime prompt state.

## Evidence Commands

- Use archive listing tools to verify `fomod/ModuleConfig.xml` exists before calling a zip a FOMOD.
- Inspect the first bytes of `ModuleConfig.xml` when decoding fails; UTF-16 with BOM should be handled byte-wise.
- Check the exact callback URI in frontend, backend, and provider configuration when OAuth routing is suspected.
- Inspect protocol registration state on the affected machine when another app handles `nxm://`.

## Lessons To Preserve

- A package name is not evidence that the archive is FOMOD-shaped.
- A stale OAuth refresh token can be recoverable and should not always surface as an alarming app error.
- Repeated runtime-selection prompts can come from callback replay, not just backend parser failure.
- Backend cleanup should clear pending manual-download state for terminal failures while preserving it for genuine runtime-selection responses.

## Validation Targets

- Parser unit tests for XML encodings and FOMOD path casing.
- Backend completion tests for terminal failure versus runtime-selection-required responses.
- Frontend tests for consumed callbacks and focus replay behavior.
- TypeScript validation after tests; do not use APIs unsupported by the repo's configured target.
