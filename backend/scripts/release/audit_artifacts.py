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
_ALLOWED_TEXT_MATCHES: dict[tuple[str, str], frozenset[tuple[str, bytes]]] = {
    (
        "chrome-mv3",
        "manifest.json",
    ): frozenset({("email_address", b"offeru-extension@offeru.local")}),
}
_CHUNK_SIZE = 1024 * 1024
_MAX_PATTERN_LENGTH = 256
_BINARY_CONTAINER_EXTENSIONS = {".exe", ".msi", ".dmg"}
_CONTEXTUAL_BINARY_SECRET_KINDS = {
    "bearer_token",
    "openai_like_key",
    "github_token",
    "google_api_key",
}


def _match_has_text_context(window: bytes, start: int, end: int) -> bool:
    """Ignore accidental token-shaped runs inside compressed installer bytes."""
    left = max(0, start - 24)
    right = min(len(window), end + 24)
    context = window[left:right]
    if not context:
        return False
    printable = sum(byte in (9, 10, 13) or 32 <= byte <= 126 for byte in context)
    return printable / len(context) >= 0.85


_SHA256_HEX = re.compile(r"[0-9a-f]{64}\Z", re.IGNORECASE)
_SHA256SUMS_LINE = re.compile(rb"^([0-9a-f]{64})( {2})(.*?)(\r?\n)?$", re.IGNORECASE)


def _mask_release_metadata_checksums(path: Path, content: bytes) -> bytes:
    if path.name.casefold() == "artifacts.json":
        try:
            manifest = json.loads(content)
        except (UnicodeDecodeError, json.JSONDecodeError):
            return content
        if not isinstance(manifest, list):
            return content
        changed = False
        for item in manifest:
            if not isinstance(item, dict):
                continue
            digest = item.get("sha256")
            if isinstance(digest, str) and _SHA256_HEX.fullmatch(digest):
                item["sha256"] = ""
                changed = True
        return json.dumps(manifest, ensure_ascii=False).encode("utf-8") if changed else content

    if path.name.casefold() == "sha256sums.txt":
        lines: list[bytes] = []
        for line in content.splitlines(keepends=True):
            match = _SHA256SUMS_LINE.fullmatch(line)
            if match:
                line = (b"0" * 64) + match.group(2) + match.group(3) + (match.group(4) or b"")
            lines.append(line)
        return b"".join(lines)
    return content


def _scan_bytes(
    path: Path,
    *,
    scan_text_pii: bool = False,
    mask_release_metadata_checksums: bool = False,
    allowed_matches: frozenset[tuple[str, bytes]] = frozenset(),
) -> set[str]:
    findings: set[str] = set()
    if (
        scan_text_pii
        and mask_release_metadata_checksums
        and path.stat().st_size <= _CHUNK_SIZE
    ):
        content = path.read_bytes()
        for name, pattern in _PATTERNS:
            if pattern.search(content):
                findings.add(name)
        pii_content = _mask_release_metadata_checksums(path, content)
        for name, pattern in _TEXT_PII_PATTERNS:
            if any(
                (name, match.group(0)) not in allowed_matches
                for match in pattern.finditer(pii_content)
            ):
                findings.add(name)
        return findings

    overlap = b""
    patterns = _PATTERNS + (_TEXT_PII_PATTERNS if scan_text_pii else ())
    with path.open("rb") as stream:
        while True:
            chunk = stream.read(_CHUNK_SIZE)
            if not chunk:
                break
            window = overlap + chunk
            for name, pattern in patterns:
                for match in pattern.finditer(window):
                    if (name, match.group(0)) in allowed_matches:
                        continue
                    if (
                        path.suffix.casefold() in _BINARY_CONTAINER_EXTENSIONS
                        and name in _CONTEXTUAL_BINARY_SECRET_KINDS
                        and not _match_has_text_context(window, match.start(), match.end())
                    ):
                        continue
                    findings.add(name)
                    break
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
        allowed_matches = _ALLOWED_TEXT_MATCHES.get(
            (root.name, relative),
            frozenset(),
        )
        for kind in sorted(
            _scan_bytes(
                path,
                scan_text_pii=path.suffix.casefold() in _TEXT_EXTENSIONS,
                mask_release_metadata_checksums=(
                    root.name.casefold() == "release-artifacts"
                    and relative.casefold() in {"artifacts.json", "sha256sums.txt"}
                ),
                allowed_matches=allowed_matches,
            )
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
