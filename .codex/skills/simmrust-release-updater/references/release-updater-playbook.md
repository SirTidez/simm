# Release Updater Playbook

## Release Surface

The public and automation surfaces can include:

- `CHANGELOG.md`
- `package.json`
- `src-tauri/tauri.conf.json`
- GitHub release and beta release workflows
- `scripts/generate-updater-manifest.ps1`
- `updater/stable/latest.json`
- `updater/beta/latest-beta.json`

Only edit the surfaces the user requested or the release task truly requires.

## CI Debugging

1. Inspect the latest relevant workflow run or failure log first.
2. Identify whether the failure is before build, during Tauri build, artifact collection, release upload, manifest generation, or manifest commit.
3. Re-check current Tauri and updater versions before assuming legacy artifact names.
4. Keep workflow mutations reversible inside the job when they edit checked-in config for build purposes.

## Tauri 2 Artifact Rules

- Signed Windows updater output is the NSIS setup `.exe` plus a matching `.exe.sig`.
- Do not expect a legacy `*.nsis.zip` updater bundle.
- Manifest validation should ensure `windows-x86_64` exists, URL points at the signed installer, and signature is present.
- PowerShell JSON edits that add nested keys should operate on hashtables rather than `PSCustomObject` shapes.

## Changelog Rules

- Follow the user-requested source of truth: committed history, branch history, or local changes.
- Put work under the correct version heading.
- Omit commit SHAs and links unless requested.
- Omit bot-only automation churn and per-version updater-manifest noise unless requested.
- Keep public contributor credit feature-oriented and free of private personal labels.

## Validation Targets

- Run the release helper script for workflow and manifest sanity checks.
- Search final release notes for private names or automation-only noise.
- For version changes, confirm app metadata, package metadata, changelog, and updater references are aligned.
