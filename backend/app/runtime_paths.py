"""Runtime paths shared by the packaged desktop sidecar and development mode."""

from __future__ import annotations

import os
import sys
from pathlib import Path


PACKAGE_BACKEND_DIR = Path(__file__).resolve().parents[1]
OFFERU_BACKEND_PORT = 8766


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
        raise RuntimeError("OFFERU_PORT must be 8766") from exc
    if configured != OFFERU_BACKEND_PORT:
        raise RuntimeError("OfferU backend port is fixed at 8766")
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


def packaged_resource_dir() -> Path | None:
    """Read-only files shipped with an installed OfferU, separate from user data.

    The PyInstaller sidecar unpacks them under ``_MEIPASS``; the ``offeru``
    Python package (lite install) carries them in ``app/_bundle``.
    """
    if getattr(sys, "frozen", False):
        return Path(getattr(sys, "_MEIPASS", PACKAGE_BACKEND_DIR)).resolve()
    bundle = Path(__file__).resolve().parent / "_bundle"
    return bundle if bundle.is_dir() else None


def resume_frontend_dir() -> Path:
    packaged = packaged_resource_dir()
    return packaged / "resume-frontend" if packaged else PACKAGE_BACKEND_DIR.parent / "frontend" / "dist"


def default_database_url() -> str:
    return f"sqlite+aiosqlite:///{(runtime_data_dir() / 'djm.db').as_posix()}"


def sqlite_path_from_url(database_url: str) -> str | None:
    """Return the raw filesystem part of a sqlite URL, or None for other databases."""

    url = str(database_url or "").strip()
    if not url.lower().startswith("sqlite"):
        return None
    _, sep, rest = url.partition(":///")
    if not sep:
        return None
    return rest.split("?", 1)[0]


def database_location_problem(database_url: str, data_dir: Path) -> str | None:
    """Explain why ``database_url`` would split OfferU's state, or return None.

    Sessions, config and uploads always follow ``OFFERU_DATA_DIR``.  A sqlite
    DATABASE_URL that is relative (resolved against whatever directory the
    process happened to start in) or that points outside the data directory
    sends runs, actions and audit logs somewhere else, which looks like data
    loss later.
    """

    raw = sqlite_path_from_url(database_url)
    if raw is None or raw in ("", ":memory:"):
        return None
    candidate = Path(raw).expanduser()
    if not candidate.is_absolute():
        return f"DATABASE_URL 使用相对路径 {raw!r}，会随启动目录变化"
    root = Path(data_dir).expanduser().resolve()
    resolved = candidate.resolve()
    if resolved != root and root not in resolved.parents:
        return f"DATABASE_URL 指向数据目录之外：{resolved.as_posix()}（数据目录：{root.as_posix()}）"
    return None


__all__ = [
    "PACKAGE_BACKEND_DIR",
    "OFFERU_BACKEND_PORT",
    "configured_backend_port",
    "database_location_problem",
    "default_database_url",
    "runtime_backend_dir",
    "runtime_config_file",
    "runtime_data_dir",
    "runtime_data_path",
    "runtime_env_file",
    "runtime_uploads_dir",
    "sqlite_path_from_url",
    "packaged_resource_dir",
    "resume_frontend_dir",
]
