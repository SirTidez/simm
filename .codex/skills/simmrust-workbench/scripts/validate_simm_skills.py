#!/usr/bin/env python3
"""Run quick validation over all repo-local SIMM skill folders."""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path


SKILL_NAMES = {
    "simmrust-workbench",
    "simmrust-ipc-contracts",
    "simmrust-runtime-library",
    "simmrust-nexus-fomod-debug",
    "simmrust-release-updater",
    "simmrust-desktop-ui-validation",
}


def find_repo_root(start: Path) -> Path:
    for candidate in [start, *start.parents]:
        if (candidate / ".git").exists() and (candidate / ".codex" / "skills").exists():
            return candidate
    raise SystemExit("Could not find repo root with .git and .codex/skills.")


def quick_validate_path() -> Path:
    home = Path.home()
    if not str(home):
        raise SystemExit("Could not locate the user home directory for skill-creator validator.")
    path = (
        home
        / ".codex"
        / "skills"
        / ".system"
        / "skill-creator"
        / "scripts"
        / "quick_validate.py"
    )
    if not path.exists():
        raise SystemExit(f"Missing quick_validate.py at {path}")
    return path


def main() -> int:
    repo = find_repo_root(Path.cwd().resolve())
    skills_dir = repo / ".codex" / "skills"
    validator = quick_validate_path()

    failures: list[str] = []
    for name in sorted(SKILL_NAMES):
        skill_dir = skills_dir / name
        if not skill_dir.exists():
            failures.append(f"Missing skill folder: {skill_dir}")
            continue
        result = subprocess.run(
            [sys.executable, str(validator), str(skill_dir)],
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            check=False,
        )
        print(result.stdout, end="")
        if result.returncode != 0:
            failures.append(f"{name} failed quick_validate.py")

    if failures:
        print("\nSkill validation failures:")
        for failure in failures:
            print(f"- {failure}")
        return 1

    print("\nAll repo-local SIMM skills passed quick validation.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
