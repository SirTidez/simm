---
name: simmrust-release-updater
description: "Prepare and diagnose SIMM releases. Use when changing version metadata, release workflows, signed installers, updater feeds, or changelogs."
---

# SIMM Release Updater

## Workflow

1. Identify whether the task is changelog, version metadata, CI diagnosis, updater manifest, installer artifact, or release publication.
2. For CI debugging, inspect the latest relevant run or workflow log before assuming the previous blocker recurred.
3. For changelog work, derive public entries from the requested source of truth and omit bot-only updater-manifest churn unless explicitly requested.
4. For Tauri updater work, validate the signed Windows installer artifact shape before editing manifest logic.
5. Validate changed release workflows or manifests with focused local checks plus the relevant GitHub evidence.

## Invariants

- Tauri 2 Windows updater artifacts are a signed installer `.exe` plus `.exe.sig`.
- Manual Beta releases include the versioned mod integration SDK package plus separate Mono and IL2CPP bridge deployment archives.
- Build release bridge archives from a pinned, hash-verified MelonLoader reference package.
- Workflow JSON mutation that adds nested keys should use hashtable-shaped PowerShell objects.
- Public changelog entries should be feature-oriented, human-readable, and free of private contributor labels.
- Version, package metadata, changelog, and updater surfaces should stay aligned when a release changes them.

Run `scripts/check_release_artifacts.py` for a read-only workflow and script sanity check. Read `references/release-updater-playbook.md` for detailed guidance.
