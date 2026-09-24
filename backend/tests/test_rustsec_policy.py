from __future__ import annotations

import os
from unittest.mock import patch

import pytest

from scripts.security import check_rustsec


def _finding(advisory_id: str, package: str = "glib", version: str = "0.18.5") -> dict:
    return {
        "advisory": {"id": advisory_id},
        "package": {"name": package, "version": version},
    }


def _report(*findings: dict) -> dict:
    return {
        "settings": {
            "ignore": [],
            "target_arch": None,
            "target_os": None,
            "informational_warnings": ["unsound"],
        },
        "vulnerabilities": {"list": []},
        "warnings": {"unsound": list(findings)},
    }


def test_unknown_unsound_advisory_fails_before_exception_is_applied() -> None:
    with (
        patch.object(check_rustsec.sys, "platform", "linux"),
        patch.dict(os.environ, {"GITHUB_REF": "refs/heads/codex/test"}),
        patch.object(
            check_rustsec,
            "audit_report",
            return_value=_report(_finding("RUSTSEC-OTHER")),
        ) as audit,
    ):
        with pytest.raises(RuntimeError, match="does not match the reviewed glib exception"):
            check_rustsec.main()

    audit.assert_called_once_with()


def test_multiple_unsound_findings_fail_without_broadening_the_exception() -> None:
    with (
        patch.object(check_rustsec.sys, "platform", "linux"),
        patch.dict(os.environ, {"GITHUB_REF": "refs/heads/codex/test"}),
        patch.object(
            check_rustsec,
            "audit_report",
            return_value=_report(
                _finding("RUSTSEC-2024-0429"),
                _finding("RUSTSEC-OTHER", package="other", version="1.0.0"),
            ),
        ) as audit,
    ):
        with pytest.raises(RuntimeError, match="unexpected unsound findings"):
            check_rustsec.main()

    audit.assert_called_once_with()


def test_linux_exception_rejects_other_hosts_and_release_refs_before_audit() -> None:
    with (
        patch.object(check_rustsec.sys, "platform", "win32"),
        patch.object(check_rustsec, "audit_report") as audit,
    ):
        with pytest.raises(RuntimeError, match="Linux host"):
            check_rustsec.main()
    audit.assert_not_called()

    with (
        patch.object(check_rustsec.sys, "platform", "linux"),
        patch.dict(os.environ, {"GITHUB_REF": "refs/tags/v0.4.0"}),
        patch.object(check_rustsec, "audit_report") as audit,
    ):
        with pytest.raises(RuntimeError, match="release tags"):
            check_rustsec.main()
    audit.assert_not_called()
