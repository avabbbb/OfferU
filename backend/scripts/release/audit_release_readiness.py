"""Fail-closed audit for the Public Release checklist.

This audit validates the checklist itself and reports the release verdict. A
partial result is represented by NOT_VERIFIED in the checklist; PARTIAL is
deliberately rejected so a local slice cannot be mistaken for a release gate.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any


ALLOWED_STATUSES = frozenset(
    {
        "PASS",
        "FAIL",
        "BLOCKED_EXTERNAL",
        "PRE_EXISTING_FAILURE",
        "NOT_VERIFIED",
    }
)
EXPECTED_IDS = tuple(range(114))
ROW_RE = re.compile(
    r"^\|\s*(\d+)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*(.*?)\s*\|$"
)


def audit_release_readiness(checklist_path: Path) -> dict[str, Any]:
    rows: list[dict[str, Any]] = []
    findings: list[str] = []
    if not checklist_path.is_file():
        return {
            "status": "INVALID",
            "verdict": "OFFERU_PUBLIC_RELEASE_NOT_READY",
            "checklist": str(checklist_path),
            "row_count": 0,
            "blocking_ids": [],
            "external_blocker_ids": [],
            "findings": [f"checklist not found: {checklist_path}"],
        }

    for line_number, line in enumerate(
        checklist_path.read_text(encoding="utf-8").splitlines(),
        start=1,
    ):
        match = ROW_RE.match(line)
        if match is None:
            continue
        requirement_id = int(match.group(1))
        requirement = match.group(2).strip()
        status = match.group(3).strip()
        rows.append(
            {
                "id": requirement_id,
                "requirement": requirement,
                "status": status,
                "line": line_number,
            }
        )
        if status not in ALLOWED_STATUSES:
            findings.append(
                f"line {line_number}: unsupported status {status!r} for R{requirement_id}"
            )

    ids = [int(row["id"]) for row in rows]
    duplicate_ids = sorted({item for item in ids if ids.count(item) > 1})
    missing_ids = [item for item in EXPECTED_IDS if item not in ids]
    unexpected_ids = sorted(set(ids) - set(EXPECTED_IDS))
    if duplicate_ids:
        findings.append(f"duplicate requirement ids: {duplicate_ids}")
    if missing_ids:
        findings.append(f"missing requirement ids: {missing_ids}")
    if unexpected_ids:
        findings.append(f"unexpected requirement ids: {unexpected_ids}")

    blocking_rows = [
        row for row in rows if row["status"] not in {"PASS", "BLOCKED_EXTERNAL"}
    ]
    external_rows = [
        row for row in rows if row["status"] == "BLOCKED_EXTERNAL"
    ]
    if findings:
        status = "INVALID"
        verdict = "OFFERU_PUBLIC_RELEASE_NOT_READY"
    elif blocking_rows:
        status = "NOT_READY"
        verdict = "OFFERU_PUBLIC_RELEASE_NOT_READY"
    elif external_rows:
        status = "BLOCKED_EXTERNAL"
        verdict = "BLOCKED_BY_TRUE_EXTERNAL_RELEASE_REQUIREMENT"
    else:
        status = "READY"
        verdict = "OFFERU_PUBLIC_RELEASE_READY"

    return {
        "status": status,
        "verdict": verdict,
        "checklist": str(checklist_path),
        "row_count": len(rows),
        "expected_row_count": len(EXPECTED_IDS),
        "blocking_ids": [int(row["id"]) for row in blocking_rows],
        "external_blocker_ids": [int(row["id"]) for row in external_rows],
        "status_counts": {
            name: sum(1 for row in rows if row["status"] == name)
            for name in sorted(ALLOWED_STATUSES)
        },
        "findings": findings,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--repo-root",
        type=Path,
        default=Path("."),
        help="repository root containing RELEASE_CHECKLIST.md",
    )
    parser.add_argument("--json", action="store_true", dest="as_json")
    parser.add_argument(
        "--require-ready",
        action="store_true",
        help="return a non-zero exit code unless the checklist is release-ready",
    )
    args = parser.parse_args()
    checklist_path = (args.repo_root / "RELEASE_CHECKLIST.md").resolve()
    result = audit_release_readiness(checklist_path)
    if args.as_json:
        print(json.dumps(result, ensure_ascii=False, indent=2))
    else:
        print(f"{result['verdict']} ({result['status']})")
        print(f"checklist rows: {result['row_count']}/{result['expected_row_count']}")
        if result["blocking_ids"]:
            print(f"blocking ids: {', '.join(f'R{item}' for item in result['blocking_ids'])}")
        if result["external_blocker_ids"]:
            print(
                "external blocker ids: "
                + ", ".join(f"R{item}" for item in result["external_blocker_ids"])
            )
        for finding in result["findings"]:
            print(f"finding: {finding}")
    if result["findings"]:
        return 1
    if args.require_ready and result["status"] != "READY":
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
