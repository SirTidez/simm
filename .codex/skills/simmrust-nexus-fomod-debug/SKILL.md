---
name: simmrust-nexus-fomod-debug
description: Diagnose and fix SIMM NexusMods integrations, nxm deeplink handling, OAuth/API key behavior, manual download completion, FOMOD parsing, runtime-selection prompts, and callback replay loops. Use when reports mention Nexus, Vortex handoff, simm OAuth callbacks, ModuleConfig.xml, FOMOD archives, repeated prompts, invalid_grant, or manual download failures.
---

# SIMM Nexus FOMOD Debug

## Workflow

1. Treat report wording as a symptom; trace the actual failing path first.
2. Separate deeplink routing, OAuth refresh, API key calls, archive parsing, manual completion, and UI prompt state.
3. Verify artifacts directly when archives are involved; do not infer FOMOD status from a zip name.
4. Check both backend cleanup and frontend callback-consumption state for repeated prompt or replay bugs.
5. Validate with the smallest tests that cover parser behavior, completion cleanup, and focus/deeplink state.

## Evidence To Gather

- Exact URL or callback shape, with secrets removed.
- Archive table of contents and `fomod/ModuleConfig.xml` encoding when FOMOD parsing is suspected.
- Current protocol owner or runtime registration path when `nxm://` opens another app.
- Whether an OAuth failure is initial code exchange or stale refresh-token recovery.

Read `references/nexus-fomod-playbook.md` before editing.
