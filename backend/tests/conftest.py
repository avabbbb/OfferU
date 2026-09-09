"""Pytest-wide test isolation and non-system-drive temp policy.

The Windows workstation keeps the system drive intentionally small.  Tests
that use Python's standard ``tempfile`` module therefore need one early,
central policy instead of relying on every test author to pass ``dir=``.
"""

from __future__ import annotations

import os
from pathlib import Path
import tempfile


def _test_temp_base() -> Path:
    configured = str(os.environ.get("OFFERU_TEST_TEMP_ROOT") or "").strip()
    if configured:
        base = Path(configured).expanduser()
    elif os.name == "nt":
        # Prefer the explicitly designated data drive used by local acceptance.
        h_root = Path(r"H:\tmp")
        if h_root.drive and h_root.exists():
            base = h_root
        else:
            runner_root = str(os.environ.get("RUNNER_TEMP") or "").strip()
            base = Path(runner_root) if runner_root else Path(tempfile.gettempdir())
    else:
        base = Path(tempfile.gettempdir())

    base = base.resolve()
    if (
        os.name == "nt"
        and base.drive.upper() == "C:"
        and os.environ.get("OFFERU_ALLOW_C_TEST_TEMP") != "1"
    ):
        raise RuntimeError(
            "OfferU tests refuse C: temporary storage; set OFFERU_TEST_TEMP_ROOT "
            "to a non-system drive such as H:\\tmp"
        )
    base.mkdir(parents=True, exist_ok=True)
    return base


_BASE = _test_temp_base()
_PYTEST_TEMP = _BASE / "offeru" / "pytest-temp"
_PYTEST_TEMP.mkdir(parents=True, exist_ok=True)

# Keep all stdlib tempfile users (including tests importing tempfile directly)
# under the same controlled root.  The environment updates also reach child
# Node/Playwright processes launched by a test.
os.environ["OFFERU_TEST_TEMP_ROOT"] = str(_BASE)
for _name in ("TEMP", "TMP", "TMPDIR"):
    os.environ[_name] = str(_PYTEST_TEMP)
tempfile.tempdir = str(_PYTEST_TEMP)
