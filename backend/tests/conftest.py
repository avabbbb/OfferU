"""Pytest-wide test isolation and non-system-drive temp policy.

The Windows workstation keeps the system drive intentionally small.  Tests
that use Python's standard ``tempfile`` module therefore need one early,
central policy instead of relying on every test author to pass ``dir=``.
"""

from __future__ import annotations

import os
from pathlib import Path, PureWindowsPath
import tempfile


def _is_windows_path(value: str) -> bool:
    """Return whether a value uses a Windows drive or UNC path form."""

    drive = PureWindowsPath(value).drive
    return bool(drive) and (len(drive) == 2 or drive.startswith("\\\\"))


def _test_temp_base() -> Path:
    configured = str(os.environ.get("OFFERU_TEST_TEMP_ROOT") or "").strip()
    if os.name != "nt" and configured and _is_windows_path(configured):
        # A Windows developer setting can leak into POSIX CI.  pathlib treats
        # H:/... as a relative path there, which creates a bogus H: directory
        # under the checkout instead of using runner storage.
        configured = ""
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
        runner_root = str(os.environ.get("RUNNER_TEMP") or "").strip()
        if runner_root and not _is_windows_path(runner_root):
            base = Path(runner_root)
        else:
            system_temp = tempfile.gettempdir()
            base = Path(system_temp) if not _is_windows_path(system_temp) else Path("/tmp")

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

# ---------------------------------------------------------------------------
# Real-database isolation (fail-closed)
#
# ``app.database`` builds its module-level engine from ``settings.database_url``
# at first ``app`` import.  ``default_database_url()`` resolves to
# ``runtime_data_dir()/djm.db`` — i.e. ``backend/djm.db``, the real user
# database.  Any test that imported the app without isolation would therefore
# read/write the 118MB production DB.
#
# The ONLY supported way to redirect the real DB is ``OFFERU_DATA_DIR``.  We
# point it at an isolated directory under the pytest temp root BEFORE any app
# module can be imported, then assert the resolved database URL did not fall
# back to the real backend directory.  This is a hard guard: a misconfigured
# environment raises instead of silently touching user data.

_ISOLATED_DATA_DIR = _PYTEST_TEMP / "offeru-data"
_ISOLATED_DATA_DIR.mkdir(parents=True, exist_ok=True)
os.environ["OFFERU_DATA_DIR"] = str(_ISOLATED_DATA_DIR)
# Clear any inherited DATABASE_URL pointing at the real DB so the isolated
# default (OFFERU_DATA_DIR/djm.db) wins.  Individual tests may still override.
os.environ.pop("DATABASE_URL", None)


def _assert_db_isolation() -> None:
    """Fail closed if the resolved DB URL points inside the real backend dir.

    Deliberately avoids importing ``app`` here: conftest runs before the app
    package is guaranteed importable (e.g. when pytest is invoked from the
    repository root).  The real backend dir is simply this file's parent's
    parent — no app dependency needed for a filesystem-path check.
    """
    real_dir = str(Path(__file__).resolve().parents[1])  # backend/
    resolved = os.environ.get("DATABASE_URL")
    if not resolved:
        # Isolated default already applied via OFFERU_DATA_DIR above.
        return
    marker = "///"
    db_path = resolved.split(marker, 1)[-1] if marker in resolved else resolved
    try:
        abs_db = os.path.abspath(db_path)
        is_real = abs_db.startswith(real_dir + os.sep)
    except Exception:
        is_real = False
    if is_real:
        raise RuntimeError(
            "OfferU tests resolved DATABASE_URL to the real backend database "
            f"({resolved}). Refusing to run: set OFFERU_DATA_DIR to an isolated "
            "directory or pass an explicit temp DATABASE_URL."
        )


_assert_db_isolation()
