#!/usr/bin/env python3
"""Read-only sanity checks for SIMM release/updater workflows."""

from __future__ import annotations

import json
import sys
from pathlib import Path


WORKFLOWS = [
    Path(".github/workflows/publish-release.yml"),
    Path(".github/workflows/publish-beta-release.yml"),
]
MANIFESTS = [
    Path("updater/stable/latest.json"),
    Path("updater/beta/latest-beta.json"),
]


def find_repo_root(start: Path) -> Path:
    for candidate in [start, *start.parents]:
        if (candidate / "src-tauri" / "tauri.conf.json").exists() and (candidate / ".github" / "workflows").exists():
            return candidate
    raise SystemExit("Could not find SIMM repo root.")


def check_workflow(repo: Path, workflow: Path) -> list[str]:
    path = repo / workflow
    issues: list[str] = []
    if not path.exists():
        return [f"Missing workflow: {workflow}"]
    text = path.read_text(encoding="utf-8", errors="ignore")
    required = [
        ("createUpdaterArtifacts", "enables updater artifacts"),
        ("ConvertFrom-Json -AsHashtable", "uses hashtable JSON mutation"),
        ("target/release/bundle/nsis", "collects NSIS bundle output"),
        ("*.exe", "collects setup executable"),
        (".sig", "checks installer signature"),
        ("generate-updater-manifest.ps1", "generates updater manifest"),
        ("windows-x86_64", "validates Windows updater platform"),
    ]
    for needle, description in required:
        if needle not in text:
            issues.append(f"{workflow} does not show that it {description}.")
    if "nsis.zip" in text or "*.nsis.zip" in text:
        issues.append(f"{workflow} still references legacy nsis zip updater artifacts.")
    return issues


def check_manifest(repo: Path, manifest: Path) -> list[str]:
    path = repo / manifest
    if not path.exists():
        return []
    issues: list[str] = []
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as error:
        return [f"{manifest} is not valid JSON: {error}"]
    platform = data.get("platforms", {}).get("windows-x86_64")
    if not platform:
        issues.append(f"{manifest} is missing platforms.windows-x86_64.")
        return issues
    url = platform.get("url", "")
    if url and not url.endswith(".exe"):
        issues.append(f"{manifest} platform URL should point to the signed installer .exe.")
    if not platform.get("signature"):
        issues.append(f"{manifest} platform is missing signature.")
    return issues


def main() -> int:
    repo = find_repo_root(Path.cwd().resolve())
    issues: list[str] = []
    for workflow in WORKFLOWS:
        issues.extend(check_workflow(repo, workflow))
    script = repo / "scripts" / "generate-updater-manifest.ps1"
    if not script.exists():
        issues.append("Missing scripts/generate-updater-manifest.ps1.")
    for manifest in MANIFESTS:
        issues.extend(check_manifest(repo, manifest))

    if issues:
        print("Release/updater sanity check found issues:")
        for issue in issues:
            print(f"- {issue}")
        return 1

    print("Release/updater sanity check passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
