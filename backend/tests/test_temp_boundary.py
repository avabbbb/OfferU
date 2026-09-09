"""Regression checks for the local acceptance temp-storage boundary."""

from __future__ import annotations

import os
from pathlib import Path
import tempfile


def test_pytest_temp_storage_is_off_system_drive_on_windows() -> None:
    """The test harness must not fill the Windows system drive."""

    temp_root = Path(tempfile.gettempdir()).resolve()
    if os.name == "nt":
        assert temp_root.drive.upper() != "C:"
