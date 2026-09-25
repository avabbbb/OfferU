"""Regression checks for the local acceptance temp-storage boundary."""

from __future__ import annotations

import os
from pathlib import Path
import subprocess
import sys
import tempfile


def test_pytest_temp_storage_is_off_system_drive_on_windows() -> None:
    """The test harness must not fill the Windows system drive."""

    temp_root = Path(tempfile.gettempdir()).resolve()
    if os.name == "nt":
        assert temp_root.drive.upper() != "C:"


def test_temp_root_selection_is_platform_aware(tmp_path: Path) -> None:
    """Windows-only configured roots must not become relative POSIX paths."""

    configured_root = tmp_path / "configured-root"
    runner_root = tmp_path / "runner-temp"
    if os.name == "nt":
        configured = str(configured_root)
        expected = configured_root
    else:
        configured = r"H:\tmp\offeru"
        expected = runner_root

    env = os.environ.copy()
    env["OFFERU_TEST_TEMP_ROOT"] = configured
    env["RUNNER_TEMP"] = str(runner_root)
    conftest_path = Path(__file__).with_name("conftest.py")
    result = subprocess.run(
        [
            sys.executable,
            "-c",
            "import runpy, sys, tempfile; runpy.run_path(sys.argv[1]); "
            "print(tempfile.gettempdir())",
            str(conftest_path),
        ],
        cwd=tmp_path,
        env=env,
        check=True,
        capture_output=True,
        text=True,
    )

    assert Path(result.stdout.strip()).resolve() == (
        expected / "offeru" / "pytest-temp"
    ).resolve()
