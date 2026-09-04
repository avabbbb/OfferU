"""Fail-closed audit for the current known-issue severity ledger."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys
from typing import Any


LEDGER_HEADER = "| ID | Kind | Severity | Status | Release impact |"
VALID_KINDS = {"BUG", "PROVIDER_ISSUE", "RELEASE_GATE", "EXTERNAL_DECISION"}
VALID_SEVERITIES = {"P0", "P1", "P2", "P3", "GATE"}
VALID_STATUSES = {"OPEN", "BLOCKED_EXTERNAL", "NOT_VERIFIED", "RESOLVED"}


def _cells(line: str) -> list[str]:
    value = line.strip()
    if not value.startswith("|") or not value.endswith("|"):
        return []
    return [cell.strip() for cell in value[1:-1].split("|")]


def audit_release_severity(root: Path) -> dict[str, Any]:
    root = root.resolve()
    path = root / "KNOWN_ISSUES.md"
    if not path.is_file():
        raise ValueError("KNOWN_ISSUES.md is missing")

    lines = path.read_text(encoding="utf-8").splitlines()
    rows: list[dict[str, str]] = []
    findings: list[dict[str, Any]] = []
    header_index = next(
        (index for index, line in enumerate(lines) if line.strip() == LEDGER_HEADER),
        None,
    )
    if header_index is None:
        findings.append({"kind": "missing_ledger_header"})
    else:
        for line_number, line in enumerate(lines[header_index + 1 :], header_index + 2):
            if not line.lstrip().startswith("|"):
                if rows and line.strip().startswith("## "):
                    break
                continue
            cells = _cells(line)
            if not cells or all(set(cell) <= {"-", ":", " "} for cell in cells):
                continue
            if len(cells) != 5:
                findings.append({"line": line_number, "kind": "invalid_ledger_row"})
                continue
            issue_id, kind, severity, status, impact = cells
            row = {
                "id": issue_id,
                "kind": kind,
                "severity": severity,
                "status": status,
                "impact": impact,
            }
            rows.append(row)
            if not issue_id:
                findings.append({"line": line_number, "kind": "missing_issue_id"})
            if kind not in VALID_KINDS:
                findings.append({"line": line_number, "kind": "invalid_issue_kind", "value": kind})
            if severity not in VALID_SEVERITIES:
                findings.append({"line": line_number, "kind": "invalid_severity", "value": severity})
            if status not in VALID_STATUSES:
                findings.append({"line": line_number, "kind": "invalid_issue_status", "value": status})
            if not impact:
                findings.append({"line": line_number, "kind": "missing_release_impact"})

    identifiers = [row["id"] for row in rows]
    for issue_id in sorted({value for value in identifiers if value}):
        if identifiers.count(issue_id) > 1:
            findings.append({"kind": "duplicate_issue_id", "id": issue_id})
    if not rows:
        findings.append({"kind": "empty_ledger"})

    counts = {severity: sum(row["severity"] == severity for row in rows) for severity in sorted(VALID_SEVERITIES)}
    p0_p1 = [row["id"] for row in rows if row["severity"] in {"P0", "P1"}]
    if p0_p1:
        findings.append({"kind": "open_p0_p1", "ids": p0_p1})

    return {
        "schema_version": "offeru.release_severity_audit.v1",
        "ledger": "KNOWN_ISSUES.md",
        "issue_count": len(rows),
        "severity_counts": counts,
        "open_p0_p1": p0_p1,
        "findings": findings,
        "status": "clear" if not findings else "violations",
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo-root", type=Path, default=Path.cwd())
    parser.add_argument("--json", action="store_true", dest="as_json")
    args = parser.parse_args(argv)
    try:
        result = audit_release_severity(args.repo_root)
    except (OSError, ValueError) as exc:
        print(f"release severity audit failed: {exc}", file=sys.stderr)
        return 2
    if args.as_json:
        print(json.dumps(result, ensure_ascii=False, indent=2))
    else:
        print(
            f"release severity audit: {result['status']} "
            f"issues={result['issue_count']} p0_p1={len(result['open_p0_p1'])}"
        )
    return 0 if result["status"] == "clear" else 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
