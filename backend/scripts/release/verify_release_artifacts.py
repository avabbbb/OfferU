"""Fail-closed verification for the files published as an OfferU release."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from pathlib import Path


_SHA256 = re.compile(r"^[0-9a-fA-F]{64}$")
_CHECKSUM_LINE = re.compile(r"^([0-9a-fA-F]{64})  (.+)$")
_CHUNK_SIZE = 1024 * 1024


def _load_json(path: Path) -> object:
    with path.open("r", encoding="utf-8-sig") as stream:
        return json.load(stream)


def _metadata_file(root: Path, name: str) -> Path:
    raw_candidate = root / name
    if raw_candidate.is_symlink():
        raise ValueError(f"release metadata file is a symlink: {name}")
    candidate = raw_candidate.resolve()
    try:
        candidate.relative_to(root)
    except ValueError as exc:
        raise ValueError("release metadata path escapes the artifact root") from exc
    if not candidate.is_file():
        raise ValueError(f"release metadata file is missing: {name}")
    return candidate


def _release_file(root: Path, name: object) -> Path:
    if not isinstance(name, str) or not name or name in {".", ".."}:
        raise ValueError("release artifact name is invalid")
    if "\\" in name or "/" in name or Path(name).is_absolute() or Path(name).name != name:
        raise ValueError("release artifact paths must be files in the artifact root")
    raw_candidate = root / name
    if raw_candidate.is_symlink():
        raise ValueError(f"release artifact file is a symlink: {name}")
    candidate = raw_candidate.resolve()
    try:
        candidate.relative_to(root)
    except ValueError as exc:
        raise ValueError("release artifact path escapes the artifact root") from exc
    if not candidate.is_file():
        raise ValueError(f"release artifact file is missing: {name}")
    return candidate


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        while chunk := stream.read(_CHUNK_SIZE):
            digest.update(chunk)
    return digest.hexdigest()


def _read_manifest(root: Path) -> dict[str, tuple[Path, int, str]]:
    payload = _load_json(_metadata_file(root, "artifacts.json"))
    if not isinstance(payload, list) or not payload:
        raise ValueError("artifacts.json must contain a non-empty list")

    manifest: dict[str, tuple[Path, int, str]] = {}
    for item in payload:
        if not isinstance(item, dict):
            raise ValueError("artifacts.json contains an invalid entry")
        name = item.get("name")
        if not isinstance(name, str) or name in manifest:
            raise ValueError("artifacts.json contains a duplicate or invalid name")
        size = item.get("bytes")
        if isinstance(size, bool) or not isinstance(size, int) or size < 0:
            raise ValueError(f"artifact byte count is invalid: {name}")
        checksum = item.get("sha256")
        if not isinstance(checksum, str) or not _SHA256.fullmatch(checksum):
            raise ValueError(f"artifact SHA-256 is invalid: {name}")
        manifest[name] = (_release_file(root, name), size, checksum.lower())

    names = set(manifest)
    if not any(name.casefold().endswith("-setup.exe") for name in names):
        raise ValueError("release artifact set is missing an NSIS setup executable")
    if not any(name.casefold().endswith(".msi") for name in names):
        raise ValueError("release artifact set is missing an MSI installer")
    return manifest


def _read_checksums(root: Path) -> dict[str, str]:
    checksum_path = _metadata_file(root, "SHA256SUMS.txt")
    checksums: dict[str, str] = {}
    for line in checksum_path.read_text(encoding="utf-8-sig").splitlines():
        if not line.strip():
            continue
        match = _CHECKSUM_LINE.fullmatch(line)
        if match is None:
            raise ValueError("SHA256SUMS.txt contains an invalid line")
        checksum, name = match.groups()
        _release_file(root, name)
        if name in checksums:
            raise ValueError("SHA256SUMS.txt contains a duplicate name")
        checksums[name] = checksum.lower()
    if not checksums:
        raise ValueError("SHA256SUMS.txt is empty")
    return checksums


def verify_release_artifacts(
    root: Path,
    *,
    expected_version: str | None = None,
    require_signed: bool = False,
) -> dict[str, object]:
    root = Path(root)
    if root.is_symlink():
        raise ValueError("release artifact directory must not be a symlink")
    root = root.resolve()
    if not root.is_dir():
        raise ValueError(f"release artifact directory does not exist: {root}")

    manifest = _read_manifest(root)
    checksums = _read_checksums(root)
    if set(checksums) != set(manifest):
        raise ValueError("SHA256SUMS.txt does not match artifacts.json")

    total_bytes = 0
    for name, (path, expected_bytes, expected_hash) in manifest.items():
        actual_bytes = path.stat().st_size
        if actual_bytes != expected_bytes:
            raise ValueError(f"artifact byte count mismatch: {name}")
        actual_hash = _sha256(path)
        if actual_hash != expected_hash or actual_hash != checksums[name]:
            raise ValueError(f"artifact SHA-256 mismatch: {name}")
        total_bytes += actual_bytes

    version_payload = _load_json(_metadata_file(root, "version.json"))
    if not isinstance(version_payload, dict):
        raise ValueError("version.json must contain an object")
    if version_payload.get("product") != "OfferU":
        raise ValueError("version.json has an unexpected product")
    if version_payload.get("target") != "windows-x64":
        raise ValueError("version.json has an unexpected target")
    version = version_payload.get("version")
    if not isinstance(version, str) or not version:
        raise ValueError("version.json has no release version")
    if expected_version is not None and version != expected_version:
        raise ValueError("version.json does not match the expected release version")
    signed = version_payload.get("signed")
    if not isinstance(signed, bool):
        raise ValueError("version.json signed flag is invalid")
    if require_signed and not signed:
        raise ValueError("release artifact set is not marked as signed")

    installer_names = version_payload.get("installers")
    if (
        not isinstance(installer_names, list)
        or not installer_names
        or any(not isinstance(name, str) for name in installer_names)
        or len(set(installer_names)) != len(installer_names)
        or set(installer_names) != set(manifest)
    ):
        raise ValueError("version.json installers do not match artifacts.json")

    return {
        "status": "verified",
        "product": "OfferU",
        "version": version,
        "target": "windows-x64",
        "signed": signed,
        "installer_count": len(manifest),
        "total_bytes": total_bytes,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("root", type=Path)
    parser.add_argument("--expected-version")
    parser.add_argument("--require-signed", action="store_true")
    args = parser.parse_args()
    try:
        result = verify_release_artifacts(
            args.root,
            expected_version=args.expected_version,
            require_signed=args.require_signed,
        )
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        print(f"release artifact verification failed: {exc}", file=sys.stderr)
        return 2
    print(
        f"release artifact verification: PASS version={result['version']} "
        f"target={result['target']} installers={result['installer_count']} "
        f"signed={result['signed']}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
