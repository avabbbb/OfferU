"""Enforce the narrowly scoped Linux-only glib RustSec exception."""

from __future__ import annotations

import json
import os
import subprocess
import sys
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[3]
TAURI_DIR = ROOT / "frontend" / "src-tauri"
ADVISORY_ID = "RUSTSEC-2024-0429"
EXEMPT_PACKAGE = ("glib", "0.18.5")
EXCEPTION_EXPIRY = date(2026, 12, 23)
LINUX_TARGET = "x86_64-unknown-linux-gnu"
RELEASE_TARGETS = (
    "x86_64-pc-windows-msvc",
    "x86_64-apple-darwin",
    "aarch64-apple-darwin",
)


def run(command: list[str]) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(
        command,
        cwd=TAURI_DIR,
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode:
        if result.stdout:
            print(result.stdout, end="")
        if result.stderr:
            print(result.stderr, end="", file=sys.stderr)
        raise RuntimeError(f"command failed ({result.returncode}): {' '.join(command)}")
    return result


def audit_report(*args: str) -> dict[str, Any]:
    result = run(["cargo", "audit", *args, "--format", "json"])
    try:
        return json.loads(result.stdout)
    except json.JSONDecodeError as exc:
        raise RuntimeError("cargo audit did not return valid JSON") from exc


def package_versions(target: str) -> set[str]:
    result = run(
        [
            "cargo",
            "tree",
            "--locked",
            "--target",
            target,
            "--prefix",
            "none",
            "--format",
            "{p}",
        ]
    )
    versions = set()
    for line in result.stdout.splitlines():
        fields = line.split()
        if len(fields) >= 2 and fields[0] == "glib":
            versions.add(fields[1].removeprefix("v"))
    return versions


def is_affected_glib(version: str) -> bool:
    try:
        major, minor, *_ = (int(part) for part in version.split(".", maxsplit=2))
    except ValueError:
        return True
    return (major, minor) >= (0, 15) and (major, minor) < (0, 20)


def main() -> int:
    if sys.platform != "linux":
        raise RuntimeError("the Linux-only exception checker must run on a Linux host")
    if os.environ.get("GITHUB_REF", "").startswith("refs/tags/"):
        raise RuntimeError("release tags must run the strict audit without exceptions")

    report = audit_report()
    settings = report.get("settings", {})
    if (
        settings.get("ignore")
        or settings.get("target_arch")
        or settings.get("target_os")
        or "unsound" not in settings.get("informational_warnings", [])
    ):
        raise RuntimeError(
            "cargo audit must expose unsound warnings without inherited ignores or target filters"
        )
    if report.get("vulnerabilities", {}).get("list"):
        raise RuntimeError("RustSec vulnerability findings must remain fail-closed")

    unsound = report.get("warnings", {}).get("unsound", [])
    if not unsound:
        audit_report("--deny", "unsound", "--no-fetch")
        print("RustSec strict unsound audit passed; no exception is active.")
        return 0

    if len(unsound) != 1:
        raise RuntimeError("unexpected unsound findings; refusing to broaden the exception")
    finding = unsound[0]
    package = finding.get("package", {})
    advisory = finding.get("advisory", {})
    if (advisory.get("id"), package.get("name"), package.get("version")) != (
        ADVISORY_ID,
        *EXEMPT_PACKAGE,
    ):
        raise RuntimeError("the unsound finding does not match the reviewed glib exception")

    today = datetime.now(timezone.utc).date()
    if today >= EXCEPTION_EXPIRY:
        raise RuntimeError(f"RustSec exception expired on {EXCEPTION_EXPIRY.isoformat()}")

    linux_versions = package_versions(LINUX_TARGET)
    if EXEMPT_PACKAGE[1] not in linux_versions or not any(
        is_affected_glib(version) for version in linux_versions
    ):
        raise RuntimeError("the affected glib version is no longer present in the Linux graph")

    for target in RELEASE_TARGETS:
        affected_versions = {
            version
            for version in package_versions(target)
            if is_affected_glib(version)
        }
        if affected_versions:
            raise RuntimeError(
                f"affected glib version(s) {sorted(affected_versions)} occur in release graph {target}"
            )

    strict_report = audit_report(
        "--deny", "unsound", "--ignore", ADVISORY_ID, "--no-fetch"
    )
    strict_settings = strict_report.get("settings", {})
    if strict_settings.get("ignore") != [ADVISORY_ID]:
        raise RuntimeError("strict RustSec audit did not apply exactly the reviewed advisory exception")
    if strict_report.get("warnings", {}).get("unsound"):
        raise RuntimeError("strict RustSec audit found an unsound advisory beyond the exception")

    print(
        f"RustSec passed with {ADVISORY_ID} ({EXEMPT_PACKAGE[0]} {EXEMPT_PACKAGE[1]}) "
        f"limited to the non-release Linux graph; release target graphs are clear. "
        f"Re-review by {EXCEPTION_EXPIRY.isoformat()}."
    )
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except RuntimeError as exc:
        print(f"RustSec policy failed: {exc}", file=sys.stderr)
        raise SystemExit(1) from exc
