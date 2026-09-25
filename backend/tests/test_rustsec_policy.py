from __future__ import annotations

import os
from datetime import date
from unittest.mock import call, patch

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


def test_scoped_exception_checks_release_graphs_and_uses_only_the_reviewed_ignore() -> None:
    strict_report = _report()
    strict_report["settings"]["ignore"] = [check_rustsec.ADVISORY_ID]
    with (
        patch.object(check_rustsec.sys, "platform", "linux"),
        patch.dict(os.environ, {"GITHUB_REF": "refs/heads/codex/test"}),
        patch.object(check_rustsec, "EXCEPTION_EXPIRY", date(2099, 12, 31)),
        patch.object(
            check_rustsec,
            "audit_report",
            side_effect=[
                _report(_finding(check_rustsec.ADVISORY_ID)),
                strict_report,
            ],
        ) as audit,
        patch.object(
            check_rustsec,
            "package_versions",
            side_effect=lambda target: (
                {"0.18.5"} if target == check_rustsec.LINUX_TARGET else {"0.20.0"}
            ),
        ) as packages,
    ):
        assert check_rustsec.main() == 0

    assert packages.call_args_list == [
        call(check_rustsec.LINUX_TARGET),
        *(call(target) for target in check_rustsec.RELEASE_TARGETS),
    ]
    assert audit.call_args_list == [
        call(),
        call("--deny", "unsound", "--ignore", check_rustsec.ADVISORY_ID, "--no-fetch"),
    ]


def test_scoped_exception_fails_when_an_affected_glib_enters_a_release_graph() -> None:
    with (
        patch.object(check_rustsec.sys, "platform", "linux"),
        patch.dict(os.environ, {"GITHUB_REF": "refs/heads/codex/test"}),
        patch.object(check_rustsec, "EXCEPTION_EXPIRY", date(2099, 12, 31)),
        patch.object(
            check_rustsec,
            "audit_report",
            return_value=_report(_finding(check_rustsec.ADVISORY_ID)),
        ) as audit,
        patch.object(
            check_rustsec,
            "package_versions",
            side_effect=lambda target: {"0.18.5"},
        ) as packages,
    ):
        with pytest.raises(RuntimeError, match="occur in release graph"):
            check_rustsec.main()

    assert packages.call_args_list == [
        call(check_rustsec.LINUX_TARGET),
        call(check_rustsec.RELEASE_TARGETS[0]),
    ]
    audit.assert_called_once_with()


def test_scoped_exception_fails_closed_after_its_expiry() -> None:
    with (
        patch.object(check_rustsec.sys, "platform", "linux"),
        patch.dict(os.environ, {"GITHUB_REF": "refs/heads/codex/test"}),
        patch.object(check_rustsec, "EXCEPTION_EXPIRY", date(2000, 1, 1)),
        patch.object(
            check_rustsec,
            "audit_report",
            return_value=_report(_finding(check_rustsec.ADVISORY_ID)),
        ) as audit,
        patch.object(check_rustsec, "package_versions") as packages,
    ):
        with pytest.raises(RuntimeError, match="RustSec exception expired"):
            check_rustsec.main()

    audit.assert_called_once_with()
    packages.assert_not_called()

    with (
        patch.object(check_rustsec.sys, "platform", "linux"),
        patch.dict(os.environ, {"GITHUB_REF": "refs/tags/v0.4.0"}),
        patch.object(check_rustsec, "audit_report") as audit,
    ):
        with pytest.raises(RuntimeError, match="release tags"):
            check_rustsec.main()
    audit.assert_not_called()
