#!/usr/bin/env python3

from __future__ import annotations

import base64
import hashlib
import importlib.util
import sys
import tempfile
import unittest
from pathlib import Path


MODULE_PATH = Path(__file__).with_name("check_release_artifacts.py")
SPEC = importlib.util.spec_from_file_location("check_release_artifacts", MODULE_PATH)
assert SPEC and SPEC.loader
release_check = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = release_check
SPEC.loader.exec_module(release_check)


def test_signature(label: str = "fixture") -> str:
    payload = (
        f"untrusted comment: {label}\n"
        "RWR1bW15LXNpZ25hdHVyZQ==\n"
        "trusted comment: timestamp:0\n"
        "RWR1bW15LXRydXN0ZWQtc2lnbmF0dXJl\n"
    )
    return base64.b64encode(payload.encode("utf-8")).decode("ascii")


def manifest(version: str, signature: str | None = None) -> dict[str, object]:
    signature = signature or test_signature()
    tag = f"v{version}"
    return {
        "version": version,
        "notes": "fixture",
        "pub_date": "2026-08-20T00:00:00Z",
        "platforms": {
            "windows-x86_64": {
                "url": (
                    f"https://github.com/SirTidez/simm/releases/download/{tag}/"
                    f"SIMM_{version}_Setup.exe"
                ),
                "signature": signature,
            },
            "linux-x86_64": {
                "url": (
                    f"https://github.com/SirTidez/simm/releases/download/{tag}/"
                    f"SIMM_{version}_x86_64.AppImage"
                ),
                "signature": signature,
            },
        },
    }


class ReleaseArtifactChecks(unittest.TestCase):
    def test_release_workflows_expose_required_sanity_gates(self) -> None:
        repo = release_check.find_repo_root(Path(__file__).resolve())
        issues = []
        for workflow in release_check.WORKFLOWS:
            issues.extend(release_check.check_workflow(repo, workflow))
        self.assertEqual(issues, [])

    def test_beta_requires_full_identity_newer_than_stable(self) -> None:
        valid = release_check.check_manifest_data(
            manifest("0.8.7-beta.1"),
            "beta-fixture",
            "beta",
            "0.8.7-beta.1",
            "0.8.6",
        )
        self.assertEqual(valid, [])

        same_core = release_check.check_manifest_data(
            manifest("0.8.6-beta.1"),
            "beta-fixture",
            "beta",
            "0.8.6-beta.1",
            "0.8.6",
        )
        self.assertTrue(any("is not newer than Stable" in issue for issue in same_core))

        no_prerelease = release_check.check_manifest_data(
            manifest("0.8.7"), "beta-fixture", "beta", "0.8.7", "0.8.6"
        )
        self.assertTrue(any("full prerelease SemVer" in issue for issue in no_prerelease))

    def test_manifest_rejects_missing_platform_and_stale_url(self) -> None:
        data = manifest("0.8.7-beta.1")
        platforms = data["platforms"]
        assert isinstance(platforms, dict)
        platforms.pop("linux-x86_64")
        windows = platforms["windows-x86_64"]
        assert isinstance(windows, dict)
        windows["url"] = (
            "https://github.com/SirTidez/simm/releases/download/"
            "v0.8.6/SIMM_0.8.6_Setup.exe"
        )

        issues = release_check.check_manifest_data(
            data, "beta-fixture", "beta", "0.8.7-beta.1", "0.8.6"
        )
        self.assertTrue(any("missing platforms.linux-x86_64" in issue for issue in issues))
        self.assertTrue(any("expected 'SIMM_0.8.7-beta.1_Setup.exe'" in issue for issue in issues))
        self.assertTrue(any("release tag 'v0.8.7-beta.1'" in issue for issue in issues))

    def test_artifacts_reject_stale_versions_and_checksum_mismatch(self) -> None:
        version = "0.8.7-beta.1"
        names = release_check.expected_artifact_names(version)
        signature = test_signature()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for name in names.values():
                (root / name).write_bytes(f"bytes:{name}".encode("utf-8"))
            for platform in ("windows-x86_64", "linux-x86_64"):
                (root / f"{names[platform]}.sig").write_text(signature, encoding="utf-8")
            checksum_lines = [
                f"{hashlib.sha256((root / name).read_bytes()).hexdigest()}  {name}"
                for name in names.values()
            ]
            (root / "SHA256SUMS").write_text("\n".join(checksum_lines) + "\n", encoding="utf-8")

            self.assertEqual(release_check.check_artifacts(root, version), [])

            (root / names["linux-x86_64"]).write_bytes(b"corrupted")
            (root / "SIMM_0.8.6_Setup.exe").write_bytes(b"stale")
            issues = release_check.check_artifacts(root, version)
            self.assertTrue(any("does not match" in issue for issue in issues))
            self.assertTrue(any("stale or wrong-version" in issue for issue in issues))

    def test_manifest_signature_must_match_artifact_sidecar(self) -> None:
        version = "0.8.7-beta.1"
        names = release_check.expected_artifact_names(version)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for platform in ("windows-x86_64", "linux-x86_64"):
                (root / f"{names[platform]}.sig").write_text(
                    test_signature("sidecar"), encoding="utf-8"
                )
            issues = release_check.check_manifest_data(
                manifest(version, test_signature("manifest")),
                "beta-fixture",
                "beta",
                version,
                "0.8.6",
                root,
            )
            self.assertEqual(
                sum("signature does not match its .sig sidecar" in issue for issue in issues),
                2,
            )


if __name__ == "__main__":
    unittest.main()
