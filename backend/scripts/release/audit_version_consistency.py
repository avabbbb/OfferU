"""Fail-closed audit for the version declarations shipped by OfferU."""

from __future__ import annotations

import argparse
import json
import re
import sys
import tomllib
from pathlib import Path
from typing import Any


_SEMVER = re.compile(r"^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$")
_BACKEND_VERSION = re.compile(
    r"(?m)^APP_VERSION\s*=\s*[\"']([^\"']+)[\"']\s*$"
)
_FASTAPI_VERSION = re.compile(
    r"(?m)^\s*version\s*=\s*[\"']([^\"']+)[\"']\s*,\s*$"
)


def _read_json_version(path: Path) -> str:
    with path.open("r", encoding="utf-8-sig") as stream:
        payload = json.load(stream)
    version = payload.get("version") if isinstance(payload, dict) else None
    if not isinstance(version, str) or not version:
        raise ValueError(f"version is missing: {path.as_posix()}")
    return version


def _read_cargo_version(path: Path) -> str:
    payload = tomllib.loads(path.read_text(encoding="utf-8"))
    package = payload.get("package") if isinstance(payload, dict) else None
    version = package.get("version") if isinstance(package, dict) else None
    if not isinstance(version, str) or not version:
        raise ValueError(f"package.version is missing: {path.as_posix()}")
    return version


def _read_backend_version(path: Path) -> str:
    match = _BACKEND_VERSION.search(path.read_text(encoding="utf-8"))
    if match is None:
        raise ValueError(f"APP_VERSION is missing: {path.as_posix()}")
    return match.group(1)


def _read_fastapi_version(path: Path) -> str:
    match = _FASTAPI_VERSION.search(path.read_text(encoding="utf-8"))
    if match is None:
        raise ValueError(f"FastAPI version is missing: {path.as_posix()}")
    return match.group(1)


def audit_version_consistency(repo_root: Path) -> dict[str, Any]:
    repo_root = repo_root.resolve()
    source_paths = {
        "frontend_package": repo_root / "frontend" / "package.json",
        "tauri_config": repo_root / "frontend" / "src-tauri" / "tauri.conf.json",
        "rust_package": repo_root / "frontend" / "src-tauri" / "Cargo.toml",
        "backend_cli": repo_root / "backend" / "app" / "cli.py",
        "backend_health": repo_root / "backend" / "app" / "main.py",
    }
    readers = {
        "frontend_package": _read_json_version,
        "tauri_config": _read_json_version,
        "rust_package": _read_cargo_version,
        "backend_cli": _read_backend_version,
        "backend_health": _read_fastapi_version,
    }
    versions: dict[str, str] = {}
    findings: list[str] = []
    for name, path in source_paths.items():
        try:
            version = readers[name](path)
        except (OSError, ValueError, json.JSONDecodeError, tomllib.TOMLDecodeError) as exc:
            findings.append(str(exc))
            continue
        versions[name] = version
        if not _SEMVER.fullmatch(version):
            findings.append(f"{name} has invalid release version format")

    if versions and len(set(versions.values())) != 1:
        findings.append("release version declarations do not match")

    return {
        "schema_version": "offeru.release_version_audit.v1",
        "status": "clear" if not findings and len(versions) == len(source_paths) else "fail",
        "version": next(iter(set(versions.values()))) if len(set(versions.values())) == 1 else None,
        "sources": versions,
        "findings": findings,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo-root", type=Path, default=Path("."))
    parser.add_argument("--json", action="store_true", dest="as_json")
    args = parser.parse_args()
    result = audit_version_consistency(args.repo_root)
    if args.as_json:
        print(json.dumps(result, ensure_ascii=False, indent=2))
    else:
        print(f"release version audit: {result['status']}")
        if result["version"]:
            print(f"version: {result['version']}")
        for finding in result["findings"]:
            print(f"finding: {finding}")
    return 0 if result["status"] == "clear" else 1


if __name__ == "__main__":
    sys.exit(main())
