---
name: simmrust-release-updater
description: Prepare, debug, and review SIMM changelog, versioning, release notes, GitHub Actions release workflows, Tauri updater manifests, Windows NSIS installer artifacts, and CI failures. Use for release or beta release tasks, updater JSON, signed installer artifacts, workflow PowerShell JSON mutation, changelog backfill, contributor credit normalization, or version alignment.
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
- Workflow JSON mutation that adds nested keys should use hashtable-shaped PowerShell objects.
- Public changelog entries should be feature-oriented, human-readable, and free of private contributor labels.
- Version, package metadata, changelog, and updater surfaces should stay aligned when a release changes them.

Run `scripts/check_release_artifacts.py` for a read-only workflow and script sanity check. Read `references/release-updater-playbook.md` for detailed guidance.
