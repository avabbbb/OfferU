"""Frozen Python entrypoint used by the Tauri desktop release sidecar."""

from __future__ import annotations

import os
from pathlib import Path

from app.runtime_paths import OFFERU_BACKEND_PORT


def configure_runtime() -> Path:
    configured = str(os.environ.get("OFFERU_DATA_DIR") or "").strip()
    data_dir = (
        Path(configured).expanduser().resolve()
        if configured
        else Path(os.environ.get("LOCALAPPDATA") or Path.home()) / "OfferU"
    )
    data_dir.mkdir(parents=True, exist_ok=True)
    os.environ.setdefault("OFFERU_DATA_DIR", str(data_dir))
    os.environ.setdefault(
        "DATABASE_URL",
        f"sqlite+aiosqlite:///{(data_dir / 'djm.db').as_posix()}",
    )
    os.environ.setdefault("OFFERU_BUILD_MODE", "release")
    os.environ.setdefault("OFFERU_RUNTIME_MODE", "desktop-sidecar")
    os.environ["OFFERU_PORT"] = str(OFFERU_BACKEND_PORT)
    return data_dir


if __name__ == "__main__":
    configure_runtime()
    import uvicorn
    from app.main import app

    uvicorn.run(
        app,
        host="127.0.0.1",
        port=OFFERU_BACKEND_PORT,
        reload=False,
        access_log=False,
    )
