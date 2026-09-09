"""Shared test-artifact paths that keep Windows acceptance runs off C:."""

from __future__ import annotations

import os
import shutil
import tempfile
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator


def test_temp_root(scope: str = "offeru") -> Path:
    configured = str(os.environ.get("OFFERU_TEST_TEMP_ROOT") or "").strip()
    if configured:
        root = Path(configured).expanduser()
    elif os.name == "nt":
        root = Path(r"H:\tmp")
    else:
        root = Path(tempfile.gettempdir())
    root = root / scope
    root.mkdir(parents=True, exist_ok=True)
    return root


@contextmanager
def offeru_temp_directory(prefix: str = "offeru-") -> Iterator[str]:
    root = test_temp_root("python-tests")
    path = Path(tempfile.mkdtemp(prefix=prefix, dir=str(root)))
    try:
        yield str(path)
    finally:
        shutil.rmtree(path, ignore_errors=True)


__all__ = ["offeru_temp_directory", "test_temp_root"]
