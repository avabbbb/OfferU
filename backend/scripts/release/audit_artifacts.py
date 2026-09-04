"""Fail-closed, value-free secret/PII scan for a release artifact directory."""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path


_PATTERNS: tuple[tuple[str, re.Pattern[bytes]], ...] = (
    (
        "offeru_canary",
        re.compile(rb"OFFERU_[A-Z0-9_]*SECRET_[A-Za-z0-9_-]{4,}"),
    ),
    ("private_key", re.compile(rb"-----BEGIN [A-Z ]*PRIVATE KEY-----")),
    ("bearer_token", re.compile(rb"Bearer\s+[A-Za-z0-9._~+/=-]{20,}", re.IGNORECASE)),
    ("openai_like_key", re.compile(rb"\b(?:sk|rk|pk)-[A-Za-z0-9_-]{20,}")),
    ("github_token", re.compile(rb"\bgh[pousr]_[A-Za-z0-9_]{20,}")),
    ("google_api_key", re.compile(rb"\bAIza[A-Za-z0-9_-]{30,}")),
)
_TEXT_PII_PATTERNS: tuple[tuple[str, re.Pattern[bytes]], ...] = (
    (
        "email_address",
        re.compile(
            rb"(?<![A-Za-z0-9._%+-])[A-Za-z0-9][A-Za-z0-9._%+-]{0,63}"
            rb"@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?"
            rb"(?:\.[A-Za-z]{2,63})+(?![A-Za-z0-9._%+-])"
        ),
    ),
    (
        "phone_number",
        re.compile(rb"(?<!\d)(?:\+?86[ -.]?)?1[3-9]\d{9}(?!\d)"),
    ),
)
_SENSITIVE_FILENAMES = {
    ".env",
    ".env.local",
    "auth.json",
    "cookies.json",
    "offeru.db",
    "djm.db",
}
_TEXT_EXTENSIONS = {
    ".cfg",
    ".conf",
    ".csv",
    ".har",
    ".htm",
    ".html",
    ".ini",
    ".json",
    ".jsonl",
    ".log",
    ".md",
    ".toml",
    ".trace",
    ".txt",
    ".xml",
    ".yaml",
    ".yml",
}
_CHUNK_SIZE = 1024 * 1024
_MAX_PATTERN_LENGTH = 256


def _scan_bytes(path: Path, *, scan_text_pii: bool = False) -> set[str]:
    findings: set[str] = set()
    overlap = b""
    patterns = _PATTERNS + (_TEXT_PII_PATTERNS if scan_text_pii else ())
    with path.open("rb") as stream:
        while True:
            chunk = stream.read(_CHUNK_SIZE)
            if not chunk:
                break
            window = overlap + chunk
            for name, pattern in patterns:
                if pattern.search(window):
                    findings.add(name)
            overlap = window[-_MAX_PATTERN_LENGTH:]
    return findings


def audit_artifact_tree(root: Path) -> dict[str, object]:
    root = Path(root)
    if root.is_symlink():
        raise ValueError("artifact root must not be a symlink")
    root = root.resolve()
    if not root.is_dir():
        raise ValueError(f"artifact directory does not exist: {root}")

    findings: list[dict[str, object]] = []
    files: list[Path] = []
    for path in sorted(root.rglob("*")):
        relative = path.relative_to(root).as_posix()
        if path.is_symlink():
            findings.append({"path": relative, "kind": "symlink"})
            continue
        if path.is_file():
            files.append(path)

    total_bytes = 0
    for path in files:
        relative = path.relative_to(root).as_posix()
        total_bytes += path.stat().st_size
        if path.name.casefold() in _SENSITIVE_FILENAMES:
            findings.append({"path": relative, "kind": "sensitive_filename"})
        for kind in sorted(
            _scan_bytes(path, scan_text_pii=path.suffix.casefold() in _TEXT_EXTENSIONS)
        ):
            findings.append({"path": relative, "kind": kind})

    return {
        "schema_version": "offeru.release_artifact_audit.v1",
        "root": root.name,
        "file_count": len(files),
        "total_bytes": total_bytes,
        "findings": findings,
        "status": "fail" if findings else "clear",
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("root", type=Path)
    parser.add_argument("--json", action="store_true", dest="as_json")
    args = parser.parse_args()
    try:
        result = audit_artifact_tree(args.root)
    except (OSError, ValueError) as exc:
        print(f"release artifact audit failed: {exc}", file=sys.stderr)
        return 2
    if args.as_json:
        print(json.dumps(result, ensure_ascii=False, indent=2))
    else:
        print(
            f"release artifact audit: {result['status']} "
            f"files={result['file_count']} findings={len(result['findings'])}"
        )
    return 1 if result["findings"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
