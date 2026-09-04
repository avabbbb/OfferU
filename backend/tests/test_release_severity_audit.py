from pathlib import Path

from scripts.release.audit_release_severity import audit_release_severity


LEDGER = """# Known Issues

## Release triage ledger

| ID | Kind | Severity | Status | Release impact |
| --- | --- | --- | --- | --- |
| PKG-001 | RELEASE_GATE | GATE | BLOCKED_EXTERNAL | certificate required |
| PROVIDER-001 | PROVIDER_ISSUE | P2 | OPEN | replay workaround available |
"""


def test_release_severity_audit_requires_classified_zero_p0_p1(tmp_path: Path) -> None:
    (tmp_path / "KNOWN_ISSUES.md").write_text(LEDGER, encoding="utf-8")

    result = audit_release_severity(tmp_path)

    assert result["status"] == "clear"
    assert result["issue_count"] == 2
    assert result["open_p0_p1"] == []
    assert result["severity_counts"]["GATE"] == 1
    assert result["severity_counts"]["P2"] == 1


def test_release_severity_audit_fails_on_p1(tmp_path: Path) -> None:
    (tmp_path / "KNOWN_ISSUES.md").write_text(
        LEDGER.replace("P2 | OPEN", "P1 | OPEN"),
        encoding="utf-8",
    )

    result = audit_release_severity(tmp_path)

    assert result["status"] == "violations"
    assert result["open_p0_p1"] == ["PROVIDER-001"]
    assert {finding["kind"] for finding in result["findings"]} == {"open_p0_p1"}
