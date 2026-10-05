from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess


ROOT = Path(__file__).resolve().parents[1]
BUILDER = ROOT / "scripts" / "build_identity.mjs"


def _git(root: Path, *args: str) -> None:
    subprocess.run(
        ["git", "-C", str(root), *args],
        check=True,
        capture_output=True,
        text=True,
    )


def test_build_identity_artifact_is_immutable_source_bound_and_safe(tmp_path: Path) -> None:
    root = tmp_path / "source"
    (root / "backend" / "app").mkdir(parents=True)
    (root / "frontend").mkdir()
    (root / ".tmp").mkdir()
    (root / ".gitignore").write_text(".tmp/\n", encoding="utf-8")
    (root / "frontend" / "package.json").write_text(
        json.dumps({"version": "0.4.0"}), encoding="utf-8"
    )
    source = root / "backend" / "app" / "main.py"
    source.write_text("VERSION = '0.4.0'\n", encoding="utf-8")
    _git(root, "init", "--quiet")
    _git(root, "add", ".gitignore", "frontend/package.json", "backend/app/main.py")
    _git(
        root,
        "-c",
        "user.name=OfferU Test",
        "-c",
        "user.email=test@example.invalid",
        "commit",
        "--quiet",
        "-m",
        "fixture",
    )
    artifact = root / ".tmp" / "offeru-build-identity.json"
    node = os.environ.get("OFFERU_NODE_PATH") or "node"

    generate = [node, str(BUILDER), "--root", str(root), "--output", str(artifact)]
    subprocess.run(
        generate,
        check=True,
        capture_output=True,
        text=True,
    )
    identity = json.loads(artifact.read_text(encoding="utf-8"))
    assert set(identity) == {
        "schema_version",
        "version",
        "commit",
        "build_timestamp",
        "dirty",
        "source_fingerprint",
    }
    assert identity["version"] == "0.4.0"
    assert identity["commit"] == _git_output(root, "rev-parse", "HEAD")
    assert identity["dirty"] is False
    assert identity["source_fingerprint"].startswith("sha256:")
    assert identity["build_timestamp"].endswith("Z")
    assert "OFFERU_APPROVAL_TOKEN" not in artifact.read_text(encoding="utf-8")

    subprocess.run(generate, check=True, capture_output=True, text=True)
    verify = [node, str(BUILDER), "--root", str(root), "--verify", str(artifact)]
    subprocess.run(verify, check=True, capture_output=True, text=True)

    source.write_text("VERSION = '0.4.0'\nCHANGED = True\n", encoding="utf-8")
    stale = subprocess.run(verify, capture_output=True, text=True)
    assert stale.returncode != 0
    assert "OFFERU_APPROVAL_TOKEN" not in stale.stdout + stale.stderr


def test_node_and_powershell_sidecars_package_the_builders_identity_artifact() -> None:
    node_builder = (ROOT / "scripts" / "build_sidecar.mjs").read_text(encoding="utf-8")
    powershell_builder = (ROOT / "scripts" / "build_sidecar.ps1").read_text(encoding="utf-8")
    native_builder = (ROOT.parent / "frontend" / "src-tauri" / "build.rs").read_text(encoding="utf-8")
    runtime_identity = (ROOT / "app" / "services" / "runtime_identity.py").read_text(encoding="utf-8")

    assert '"offeru-build-identity.json"' in node_builder
    assert 'scripts/build_identity.mjs' in node_builder
    assert 'offeru-assets' in node_builder
    assert '"offeru-build-identity.json"' in powershell_builder
    assert 'scripts\\build_identity.mjs' in powershell_builder
    assert 'offeru-assets' in powershell_builder
    assert '.tmp/offeru-build-identity.json' in native_builder
    assert '--verify' in native_builder
    assert 'OFFERU_BUILD_SOURCE_FINGERPRINT' in native_builder
    assert 'offeru-assets" / "offeru-build-identity.json' in runtime_identity


def _git_output(root: Path, *args: str) -> str:
    result = subprocess.run(
        ["git", "-C", str(root), *args],
        check=True,
        capture_output=True,
        text=True,
    )
    return result.stdout.strip()
