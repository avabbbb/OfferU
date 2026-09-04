"""Runtime paths shared by the packaged desktop sidecar and development mode."""

from __future__ import annotations

import os
from pathlib import Path


PACKAGE_BACKEND_DIR = Path(__file__).resolve().parents[1]
OFFERU_BACKEND_PORT = 8765


def configured_backend_port() -> int:
    """Return the only supported OfferU backend port.

    The desktop shell, web UI and release diagnostics share one local backend
    origin.  Refuse stale or arbitrary environment overrides instead of
    silently moving the server to a port that users may mistake for a web UI.
    """

    raw_port = str(os.environ.get("OFFERU_PORT") or "").strip()
    if not raw_port:
        return OFFERU_BACKEND_PORT
    try:
        configured = int(raw_port)
    except ValueError as exc:
        raise RuntimeError("OFFERU_PORT must be 8765") from exc
    if configured != OFFERU_BACKEND_PORT:
        raise RuntimeError("OfferU backend port is fixed at 8765")
    return OFFERU_BACKEND_PORT


def runtime_data_dir() -> Path:
    """Return the writable user-data directory for this OfferU process.

    Development keeps the historical ``backend``-relative layout.  A Tauri
    sidecar sets ``OFFERU_DATA_DIR`` to the platform app-data directory so a
    frozen executable never writes into its temporary PyInstaller extraction
    directory.
    """

    configured = str(os.environ.get("OFFERU_DATA_DIR") or "").strip()
    return Path(configured).expanduser().resolve() if configured else PACKAGE_BACKEND_DIR


def runtime_backend_dir() -> Path:
    return runtime_data_dir()


def runtime_data_path(*parts: str) -> Path:
    return runtime_data_dir().joinpath("data", *parts)


def runtime_uploads_dir(*parts: str) -> Path:
    return runtime_data_dir().joinpath("uploads", *parts)


def runtime_config_file() -> Path:
    return runtime_data_dir() / "config.json"


def runtime_env_file() -> Path:
    return runtime_data_dir() / ".env"


def default_database_url() -> str:
    return f"sqlite+aiosqlite:///{(runtime_data_dir() / 'djm.db').as_posix()}"


__all__ = [
    "PACKAGE_BACKEND_DIR",
    "OFFERU_BACKEND_PORT",
    "configured_backend_port",
    "default_database_url",
    "runtime_backend_dir",
    "runtime_config_file",
    "runtime_data_dir",
    "runtime_data_path",
    "runtime_env_file",
    "runtime_uploads_dir",
]
