from pathlib import Path

from scripts.release.audit_release_readiness import audit_release_readiness


def _write_checklist(path: Path, statuses: list[str]) -> None:
    rows = [
        "| ID | Requirement | Status | Evidence |",
        "| ---: | --- | --- | --- |",
    ]
    rows.extend(
        f"| {index} | Requirement {index} | {status} | evidence |"
        for index, status in enumerate(statuses)
    )
    path.write_text("\n".join(rows) + "\n", encoding="utf-8")


def test_release_checklist_rejects_unsupported_partial_status(tmp_path: Path):
    checklist = tmp_path / "RELEASE_CHECKLIST.md"
    _write_checklist(checklist, ["PARTIAL"] + ["PASS"] * 113)

    result = audit_release_readiness(checklist)

    assert result["status"] == "INVALID"
    assert result["verdict"] == "OFFERU_PUBLIC_RELEASE_NOT_READY"
    assert any("unsupported status 'PARTIAL'" in item for item in result["findings"])


def test_release_checklist_reports_not_ready_for_unverified_gate(tmp_path: Path):
    checklist = tmp_path / "RELEASE_CHECKLIST.md"
    _write_checklist(checklist, ["NOT_VERIFIED"] + ["PASS"] * 113)

    result = audit_release_readiness(checklist)

    assert result["status"] == "NOT_READY"
    assert result["blocking_ids"] == [0]
    assert result["external_blocker_ids"] == []


def test_release_checklist_allows_only_true_external_blockers(tmp_path: Path):
    checklist = tmp_path / "RELEASE_CHECKLIST.md"
    _write_checklist(checklist, ["BLOCKED_EXTERNAL"] + ["PASS"] * 113)

    result = audit_release_readiness(checklist)

    assert result["status"] == "BLOCKED_EXTERNAL"
    assert result["verdict"] == "BLOCKED_BY_TRUE_EXTERNAL_RELEASE_REQUIREMENT"
    assert result["blocking_ids"] == []
    assert result["external_blocker_ids"] == [0]


def test_release_checklist_detects_missing_and_duplicate_ids(tmp_path: Path):
    checklist = tmp_path / "RELEASE_CHECKLIST.md"
    rows = [
        "| ID | Requirement | Status | Evidence |",
        "| ---: | --- | --- | --- |",
        "| 0 | Requirement 0 | PASS | evidence |",
        "| 0 | Duplicate | PASS | evidence |",
    ]
    checklist.write_text("\n".join(rows) + "\n", encoding="utf-8")

    result = audit_release_readiness(checklist)

    assert result["status"] == "INVALID"
    assert any("duplicate requirement ids" in item for item in result["findings"])
    assert any("missing requirement ids" in item for item in result["findings"])
