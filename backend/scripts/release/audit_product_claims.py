"""Fail closed on high-risk unqualified claims in release-facing surfaces."""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path


_SURFACE_FILES = {
    "README.md",
    "README_EN.md",
    "QUICKSTART.md",
    "RELEASE_NOTES.md",
}
_SURFACE_SUFFIXES = {".ts", ".tsx"}
_CLAIM_PATTERNS: tuple[tuple[str, re.Pattern[str]], ...] = (
    (
        "automatic_external_write",
        re.compile(
            r"(?:自动(?:提交申请|投递|发送邮件|联系第三方)|"
            r"(?:auto[- ]?|automatically\s+)(?:submit|send|contact)"
            r"(?: applications?| email| third[- ]party)?)",
            re.IGNORECASE,
        ),
    ),
    (
        "unbounded_live_market_claim",
        re.compile(
            r"(?:全网实时|实时市场(?:数据|岗位)?|real[- ]time market|"
            r"live market research)",
            re.IGNORECASE,
        ),
    ),
    (
        "public_release_ready_claim",
        re.compile(r"(?:OFFERU_PUBLIC_RELEASE_READY|Public Release Ready)", re.IGNORECASE),
    ),
)
_SAFE_CONTEXT = re.compile(
    r"(?:不会|不自动|不是|尚未|未完成|未通过|未验证|不代表|仅用于|仅支持|"
    r"需要|仍需|阻塞|实验性|候选|not ready|not verified|not available|"
    r"does not|doesn't|not a|experimental|blocked|fixture|demo)",
    re.IGNORECASE,
)


def _surface_paths(root: Path) -> list[Path]:
    paths = [root / name for name in sorted(_SURFACE_FILES) if (root / name).is_file()]
    frontend_source = root / "frontend" / "src"
    if frontend_source.is_dir():
        paths.extend(
            path
            for path in frontend_source.rglob("*")
            if path.is_file() and path.suffix in _SURFACE_SUFFIXES
        )
    return sorted(paths)


def _claim_findings(root: Path, path: Path) -> list[dict[str, object]]:
    lines = path.read_text(encoding="utf-8").splitlines()
    findings: list[dict[str, object]] = []
    for index, line in enumerate(lines):
        window = "\n".join(lines[max(0, index - 1) : min(len(lines), index + 2)])
        for category, pattern in _CLAIM_PATTERNS:
            if pattern.search(line) and not _SAFE_CONTEXT.search(window):
                findings.append(
                    {
                        "path": path.relative_to(root).as_posix(),
                        "line": index + 1,
                        "category": category,
                    }
                )
    return findings


def audit_product_claims(root: Path) -> dict[str, object]:
    root = root.resolve()
    if not root.is_dir():
        raise ValueError(f"repository root does not exist: {root}")
    paths = _surface_paths(root)
    findings: list[dict[str, object]] = []
    for path in paths:
        try:
            findings.extend(_claim_findings(root, path))
        except UnicodeDecodeError:
            findings.append(
                {
                    "path": path.relative_to(root).as_posix(),
                    "line": 0,
                    "category": "unreadable_surface_file",
                }
            )
    return {
        "schema_version": "offeru.product_claim_audit.v1",
        "surface_file_count": len(paths),
        "findings": findings,
        "status": "fail" if findings else "clear",
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo-root", type=Path, default=Path.cwd())
    parser.add_argument("--json", action="store_true", dest="as_json")
    args = parser.parse_args()
    try:
        result = audit_product_claims(args.repo_root)
    except (OSError, ValueError) as exc:
        print(f"product claim audit failed: {exc}", file=sys.stderr)
        return 2
    if args.as_json:
        print(json.dumps(result, ensure_ascii=False, indent=2))
    else:
        print(
            f"product claim audit: {result['status']} "
            f"surfaces={result['surface_file_count']} findings={len(result['findings'])}"
        )
    return 1 if result["findings"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
