#!/usr/bin/env python3
"""Read-only SIMM IPC drift scanner."""

from __future__ import annotations

import re
import sys
from pathlib import Path


INVOKE_RE = re.compile(r"\binvoke(?:<[^>]+>)?\(\s*['\"]([a-zA-Z0-9_]+)['\"]")
DIRECT_INVOKE_IMPORT_RE = re.compile(r"import\s*\{\s*[^}]*\binvoke\b[^}]*\}\s*from\s*['\"]@tauri-apps/api/core['\"]")
DIRECT_LISTEN_IMPORT_RE = re.compile(r"import\s*\{\s*[^}]*\blisten\b[^}]*\}\s*from\s*['\"]@tauri-apps/api/event['\"]")


def find_repo_root(start: Path) -> Path:
    for candidate in [start, *start.parents]:
        if (candidate / "src-tauri" / "src" / "main.rs").exists() and (candidate / "src" / "services" / "api.ts").exists():
            return candidate
    raise SystemExit("Could not find SIMM repo root.")


def registered_commands(main_rs: str) -> set[str]:
    match = re.search(r"generate_handler!\s*\[(.*?)\]\)", main_rs, re.DOTALL)
    if not match:
        return set()
    commands: set[str] = set()
    for line in match.group(1).splitlines():
        line = line.split("//", 1)[0].strip().rstrip(",")
        if not line:
            continue
        commands.add(line.rsplit("::", 1)[-1])
    return commands


def frontend_invokes(src_dir: Path) -> dict[str, set[str]]:
    invokes: dict[str, set[str]] = {}
    for path in src_dir.rglob("*"):
        if path.suffix not in {".ts", ".tsx"}:
            continue
        text = path.read_text(encoding="utf-8", errors="ignore")
        found = set(INVOKE_RE.findall(text))
        if found:
            invokes[str(path.relative_to(src_dir.parent))] = found
    return invokes


def direct_boundary_imports(src_dir: Path) -> list[str]:
    findings: list[str] = []
    allowed_invoke = src_dir / "services" / "api.ts"
    allowed_listen = src_dir / "services" / "events.ts"
    for path in src_dir.rglob("*"):
        if path.suffix not in {".ts", ".tsx"}:
            continue
        text = path.read_text(encoding="utf-8", errors="ignore")
        if path != allowed_invoke and DIRECT_INVOKE_IMPORT_RE.search(text):
            findings.append(f"{path.relative_to(src_dir.parent)} imports invoke directly")
        if path != allowed_listen and DIRECT_LISTEN_IMPORT_RE.search(text):
            findings.append(f"{path.relative_to(src_dir.parent)} imports listen directly")
    return findings


def main() -> int:
    repo = find_repo_root(Path.cwd().resolve())
    main_rs = (repo / "src-tauri" / "src" / "main.rs").read_text(encoding="utf-8", errors="ignore")
    registered = registered_commands(main_rs)
    invokes_by_file = frontend_invokes(repo / "src")
    invoked = set().union(*invokes_by_file.values()) if invokes_by_file else set()

    missing_backend = sorted(invoked - registered)
    backend_only = sorted(registered - invoked)
    boundary_imports = direct_boundary_imports(repo / "src")

    print(f"Registered Tauri commands: {len(registered)}")
    print(f"Frontend invoke command strings: {len(invoked)}")

    if missing_backend:
        print("\nFrontend invokes with no registered backend command:")
        for command in missing_backend:
            users = sorted(path for path, commands in invokes_by_file.items() if command in commands)
            print(f"- {command}: {', '.join(users)}")

    if backend_only:
        print("\nRegistered backend commands not invoked by frontend scan:")
        for command in backend_only:
            print(f"- {command}")

    if boundary_imports:
        print("\nDirect Tauri boundary imports outside central services:")
        for finding in boundary_imports:
            print(f"- {finding}")

    if missing_backend:
        return 1

    print("\nNo frontend invoke strings are missing registered backend commands.")
    if backend_only or boundary_imports:
        print("Review warnings above before changing IPC boundaries.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
