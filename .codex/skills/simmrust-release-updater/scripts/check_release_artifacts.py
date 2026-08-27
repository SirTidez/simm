#!/usr/bin/env python3
"""Read-only sanity checks for SIMM release/updater workflows and artifacts."""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import re
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import unquote, urlparse


WORKFLOWS = [
    Path(".github/workflows/publish-release.yml"),
    Path(".github/workflows/publish-beta-release.yml"),
]
MANIFESTS = {
    "stable": Path("updater/stable/latest.json"),
    "beta": Path("updater/beta/latest-beta.json"),
}
SEMVER_RE = re.compile(
    r"^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)"
    r"(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?"
    r"(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$"
)


@dataclass(frozen=True)
class SemVer:
    raw: str
    major: int
    minor: int
    patch: int
    prerelease: tuple[str, ...]

    @classmethod
    def parse(cls, value: str) -> "SemVer":
        match = SEMVER_RE.fullmatch(value.strip())
        if not match:
            raise ValueError(f"'{value}' is not a full SemVer value")
        prerelease = tuple(match.group(4).split(".")) if match.group(4) else ()
        for identifier in prerelease:
            if identifier.isdigit() and len(identifier) > 1 and identifier.startswith("0"):
                raise ValueError(
                    f"'{value}' has a numeric prerelease identifier with a leading zero"
                )
        return cls(
            raw=value.strip(),
            major=int(match.group(1)),
            minor=int(match.group(2)),
            patch=int(match.group(3)),
            prerelease=prerelease,
        )

    def compare_precedence(self, other: "SemVer") -> int:
        left_core = (self.major, self.minor, self.patch)
        right_core = (other.major, other.minor, other.patch)
        if left_core != right_core:
            return 1 if left_core > right_core else -1
        if not self.prerelease and not other.prerelease:
            return 0
        if not self.prerelease:
            return 1
        if not other.prerelease:
            return -1
        for left, right in zip(self.prerelease, other.prerelease):
            if left == right:
                continue
            left_numeric = left.isdigit()
            right_numeric = right.isdigit()
            if left_numeric and right_numeric:
                return 1 if int(left) > int(right) else -1
            if left_numeric != right_numeric:
                return -1 if left_numeric else 1
            return 1 if left > right else -1
        if len(self.prerelease) == len(other.prerelease):
            return 0
        return 1 if len(self.prerelease) > len(other.prerelease) else -1


def find_repo_root(start: Path) -> Path:
    for candidate in [start, *start.parents]:
        if (candidate / "src-tauri" / "tauri.conf.json").exists() and (
            candidate / ".github" / "workflows"
        ).exists():
            return candidate
    raise SystemExit("Could not find SIMM repo root.")


def read_package_version(repo: Path) -> str:
    package = json.loads((repo / "package.json").read_text(encoding="utf-8"))
    return str(package.get("version", "")).strip()


def check_workflow(repo: Path, workflow: Path) -> list[str]:
    path = repo / workflow
    if not path.exists():
        return [f"Missing workflow: {workflow}"]
    issues: list[str] = []
    text = path.read_text(encoding="utf-8", errors="ignore")
    required = [
        ("createUpdaterArtifacts", "enables updater artifacts"),
        ("ConvertFrom-Json -AsHashtable", "uses hashtable JSON mutation"),
        ("target/release/bundle/nsis", "collects NSIS bundle output"),
        ("*.exe", "collects setup executable"),
        (".sig", "checks installer signatures"),
        ("generate-updater-manifest.ps1", "generates an updater manifest"),
        ("windows-x86_64", "validates the Windows updater platform"),
        ("linux-x86_64", "validates the Linux updater platform"),
        ("SHA256SUMS", "builds or validates release checksums"),
    ]
    for needle, description in required:
        if needle not in text:
            issues.append(f"{workflow} does not show that it {description}.")
    if "nsis.zip" in text or "*.nsis.zip" in text:
        issues.append(f"{workflow} still references legacy nsis zip updater artifacts.")
    if workflow.name == "publish-beta-release.yml":
        for needle, description in [
            ("-Channel Beta", "generates an explicitly Beta manifest"),
            ("-MinimumVersion", "compares Beta precedence with the current Stable feed"),
            ('"tag=v${version}"', "uses the full prerelease SemVer as the release tag"),
        ]:
            if needle not in text:
                issues.append(f"{workflow} does not show that it {description}.")
    if workflow.name == "publish-release.yml" and "-Channel Stable" not in text:
        issues.append(f"{workflow} does not generate an explicitly Stable manifest.")
    return issues


def signature_issue(signature: object) -> str | None:
    if not isinstance(signature, str) or not signature.strip():
        return "signature is empty"
    try:
        decoded = base64.b64decode(signature.strip(), validate=True).decode("utf-8")
    except (ValueError, UnicodeDecodeError):
        return "signature is not a base64-encoded minisign payload"
    if "untrusted comment:" not in decoded or "trusted comment:" not in decoded:
        return "signature does not contain the expected minisign comments"
    return None


def expected_artifact_names(version: str) -> dict[str, str]:
    return {
        "windows-x86_64": f"SIMM_{version}_Setup.exe",
        "linux-x86_64": f"SIMM_{version}_x86_64.AppImage",
        "linux-deb": f"SIMM_{version}_amd64.deb",
    }


def check_version_identity(
    version_raw: str,
    label: str,
    channel: str,
    package_version: str,
    minimum_version: str | None = None,
) -> tuple[SemVer | None, list[str]]:
    issues: list[str] = []
    try:
        version = SemVer.parse(version_raw)
    except ValueError as error:
        return None, [f"{label} version {error}."]
    try:
        package_semver = SemVer.parse(package_version)
    except ValueError as error:
        return None, [f"Expected package version {error}."]

    if version.raw != package_semver.raw:
        issues.append(
            f"{label} version '{version.raw}' does not match package version "
            f"'{package_semver.raw}'."
        )
    if channel == "stable" and version.prerelease:
        issues.append(f"{label} Stable manifest must not use a prerelease version.")
    if channel == "beta" and not version.prerelease:
        issues.append(f"{label} Beta manifest must use a full prerelease SemVer identity.")
    if channel == "beta" and not minimum_version:
        issues.append(f"{label} Beta identity requires the current Stable version.")
    if minimum_version:
        try:
            minimum = SemVer.parse(minimum_version)
            if version.compare_precedence(minimum) <= 0:
                issues.append(
                    f"{label} version '{version.raw}' is not newer than Stable "
                    f"'{minimum.raw}'."
                )
        except ValueError as error:
            issues.append(f"Minimum version {error}.")
    return version, issues


def check_manifest_data(
    data: object,
    label: str,
    channel: str,
    package_version: str,
    minimum_version: str | None = None,
    artifact_dir: Path | None = None,
) -> list[str]:
    if not isinstance(data, dict):
        return [f"{label} must contain a JSON object."]
    version_raw = str(data.get("version", "")).strip()
    version, issues = check_version_identity(
        version_raw, label, channel, package_version, minimum_version
    )
    if version is None:
        return issues

    platforms = data.get("platforms")
    if not isinstance(platforms, dict):
        return [*issues, f"{label} is missing its platforms object."]
    expected_names = expected_artifact_names(version.raw)
    expected_tag = f"v{version.raw}"
    for platform_name, suffix in [
        ("windows-x86_64", ".exe"),
        ("linux-x86_64", ".AppImage"),
    ]:
        platform = platforms.get(platform_name)
        if not isinstance(platform, dict):
            issues.append(f"{label} is missing platforms.{platform_name}.")
            continue
        url = str(platform.get("url", "")).strip()
        parsed = urlparse(url)
        artifact_name = Path(unquote(parsed.path)).name
        if parsed.scheme != "https" or parsed.netloc != "github.com":
            issues.append(f"{label} {platform_name} URL must be an HTTPS GitHub release URL.")
        if not artifact_name.endswith(suffix):
            issues.append(f"{label} {platform_name} URL must end with '{suffix}'.")
        if artifact_name != expected_names[platform_name]:
            issues.append(
                f"{label} {platform_name} URL names '{artifact_name}', expected "
                f"'{expected_names[platform_name]}'."
            )
        if f"/releases/download/{expected_tag}/" not in parsed.path:
            issues.append(f"{label} {platform_name} URL must use release tag '{expected_tag}'.")
        signature = platform.get("signature")
        if problem := signature_issue(signature):
            issues.append(f"{label} {platform_name} {problem}.")
        if artifact_dir is not None and isinstance(signature, str):
            sidecar = artifact_dir / f"{expected_names[platform_name]}.sig"
            if (
                sidecar.is_file()
                and sidecar.read_text(encoding="utf-8").strip() != signature.strip()
            ):
                issues.append(
                    f"{label} {platform_name} signature does not match its .sig sidecar."
                )
    return issues


def check_manifest(
    repo: Path,
    manifest: Path,
    channel: str,
    package_version: str,
    minimum_version: str | None = None,
    artifact_dir: Path | None = None,
) -> list[str]:
    path = repo / manifest
    if not path.exists():
        return [f"Missing updater manifest: {manifest}"]
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as error:
        return [f"{manifest} is not valid JSON: {error}"]
    return check_manifest_data(
        data,
        str(manifest),
        channel,
        package_version,
        minimum_version,
        artifact_dir,
    )


def read_checksums(path: Path) -> tuple[dict[str, str], list[str]]:
    checksums: dict[str, str] = {}
    issues: list[str] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        match = re.fullmatch(r"([0-9A-Fa-f]{64})\s+\*?(.+)", line.strip())
        if not match:
            issues.append(f"SHA256SUMS has an invalid line: {line!r}.")
            continue
        name = match.group(2)
        if name in checksums:
            issues.append(f"SHA256SUMS contains duplicate entry '{name}'.")
        checksums[name] = match.group(1).lower()
    return checksums, issues


def check_artifacts(artifact_dir: Path, version: str) -> list[str]:
    issues: list[str] = []
    expected = expected_artifact_names(version)
    required = [
        expected["windows-x86_64"],
        f'{expected["windows-x86_64"]}.sig',
        expected["linux-x86_64"],
        f'{expected["linux-x86_64"]}.sig',
        expected["linux-deb"],
        "SHA256SUMS",
    ]
    for name in required:
        if not (artifact_dir / name).is_file():
            issues.append(f"Release artifact set is missing '{name}'.")
    for pattern in ("SIMM_*_Setup.exe", "SIMM_*_x86_64.AppImage", "SIMM_*_amd64.deb"):
        for candidate in artifact_dir.glob(pattern):
            if candidate.name not in expected.values():
                issues.append(
                    f"Release artifact set contains stale or wrong-version '{candidate.name}'."
                )
    checksum_path = artifact_dir / "SHA256SUMS"
    if checksum_path.is_file():
        checksums, checksum_issues = read_checksums(checksum_path)
        issues.extend(checksum_issues)
        for name in expected.values():
            artifact = artifact_dir / name
            if not artifact.is_file():
                continue
            expected_hash = checksums.get(name)
            if not expected_hash:
                issues.append(f"SHA256SUMS is missing '{name}'.")
                continue
            actual_hash = hashlib.sha256(artifact.read_bytes()).hexdigest()
            if actual_hash != expected_hash:
                issues.append(f"SHA256SUMS does not match '{name}'.")
    for platform in ("windows-x86_64", "linux-x86_64"):
        sidecar = artifact_dir / f"{expected[platform]}.sig"
        if sidecar.is_file():
            if problem := signature_issue(sidecar.read_text(encoding="utf-8")):
                issues.append(f"{sidecar.name} {problem}.")
    return issues


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, help="Validate one updater manifest.")
    parser.add_argument("--channel", choices=("stable", "beta"))
    parser.add_argument("--package-version")
    parser.add_argument("--minimum-version")
    parser.add_argument("--artifact-dir", type=Path)
    parser.add_argument("--artifacts-only", action="store_true")
    parser.add_argument("--version-only", action="store_true")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    repo = find_repo_root(Path.cwd().resolve())
    package_version = args.package_version or read_package_version(repo)
    issues: list[str] = []

    if args.version_only:
        if not args.channel or not args.package_version:
            raise SystemExit("--version-only requires --channel and --package-version.")
        _, version_issues = check_version_identity(
            args.package_version,
            "Release candidate",
            args.channel,
            args.package_version,
            args.minimum_version,
        )
        issues.extend(version_issues)
    elif args.artifacts_only:
        if not args.artifact_dir or not args.package_version:
            raise SystemExit("--artifacts-only requires --artifact-dir and --package-version.")
        issues.extend(check_artifacts(args.artifact_dir.resolve(), args.package_version))
    elif args.manifest:
        if not args.channel:
            raise SystemExit("--manifest requires --channel.")
        issues.extend(
            check_manifest(
                repo,
                args.manifest,
                args.channel,
                package_version,
                args.minimum_version,
                args.artifact_dir.resolve() if args.artifact_dir else None,
            )
        )
    else:
        for workflow in WORKFLOWS:
            issues.extend(check_workflow(repo, workflow))
        stable_path = repo / MANIFESTS["stable"]
        stable_version: str | None = None
        if stable_path.is_file():
            try:
                stable_data = json.loads(stable_path.read_text(encoding="utf-8"))
                if isinstance(stable_data, dict):
                    stable_version = str(stable_data.get("version", ""))
            except json.JSONDecodeError:
                pass
        stable_expected = stable_version or package_version
        issues.extend(
            check_manifest(repo, MANIFESTS["stable"], "stable", stable_expected)
        )
        beta_path = repo / MANIFESTS["beta"]
        beta_expected = package_version
        if beta_path.is_file():
            try:
                beta_data = json.loads(beta_path.read_text(encoding="utf-8"))
                if isinstance(beta_data, dict):
                    beta_expected = str(beta_data.get("version", ""))
            except json.JSONDecodeError:
                pass
        issues.extend(
            check_manifest(
                repo,
                MANIFESTS["beta"],
                "beta",
                beta_expected,
                stable_version,
            )
        )
        generator = repo / "scripts" / "generate-updater-manifest.ps1"
        if not generator.exists():
            issues.append("Missing scripts/generate-updater-manifest.ps1.")

    if issues:
        print("Release/updater sanity check found issues:")
        for issue in issues:
            print(f"- {issue}")
        return 1

    print("Release/updater sanity check passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
