from __future__ import annotations

import os
from pathlib import Path

from app.runtime_paths import (
    PACKAGE_BACKEND_DIR,
    OFFERU_BACKEND_PORT,
    default_database_url,
    configured_backend_port,
    runtime_config_file,
    runtime_data_dir,
    runtime_data_path,
    runtime_env_file,
    runtime_uploads_dir,
)


def test_development_paths_stay_backend_relative(monkeypatch) -> None:
    monkeypatch.delenv("OFFERU_DATA_DIR", raising=False)

    assert runtime_data_dir() == PACKAGE_BACKEND_DIR
    assert runtime_config_file() == PACKAGE_BACKEND_DIR / "config.json"
    assert runtime_env_file() == PACKAGE_BACKEND_DIR / ".env"
    assert runtime_data_path("artifacts") == PACKAGE_BACKEND_DIR / "data" / "artifacts"
    assert runtime_uploads_dir("photos") == PACKAGE_BACKEND_DIR / "uploads" / "photos"
    assert default_database_url().endswith("/backend/djm.db")


def test_backend_port_is_fixed_and_ignores_legacy_override(monkeypatch) -> None:
    monkeypatch.delenv("OFFERU_PORT", raising=False)
    monkeypatch.setenv("OFFERU_LEGACY_PORT", "8080")

    assert configured_backend_port() == OFFERU_BACKEND_PORT == 8765


def test_backend_port_rejects_non_release_port(monkeypatch) -> None:
    monkeypatch.setenv("OFFERU_PORT", "8080")

    try:
        configured_backend_port()
    except RuntimeError as exc:
        assert str(exc) == "OfferU backend port is fixed at 8765"
    else:
        raise AssertionError("non-8765 backend port must be rejected")


def test_sidecar_paths_follow_explicit_user_data_dir(monkeypatch, tmp_path: Path) -> None:
    data_dir = tmp_path / "OfferU Data"
    monkeypatch.setenv("OFFERU_DATA_DIR", str(data_dir))

    assert runtime_data_dir() == data_dir.resolve()
    assert runtime_config_file() == data_dir / "config.json"
    assert runtime_env_file() == data_dir / ".env"
    assert runtime_data_path("pi_sessions") == data_dir / "data" / "pi_sessions"
    assert runtime_uploads_dir("templates") == data_dir / "uploads" / "templates"
    assert default_database_url() == (
        f"sqlite+aiosqlite:///{(data_dir / 'djm.db').resolve().as_posix()}"
    )


def test_sidecar_entry_configures_writable_runtime(monkeypatch, tmp_path: Path) -> None:
    from sidecar_entry import configure_runtime

    data_dir = tmp_path / "runtime"
    for name in ("OFFERU_DATA_DIR", "DATABASE_URL", "OFFERU_BUILD_MODE", "OFFERU_RUNTIME_MODE", "OFFERU_PORT"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path / "local-app-data"))

    assert configure_runtime() == (tmp_path / "local-app-data" / "OfferU").resolve()
    assert Path(os.environ["OFFERU_DATA_DIR"]) == (
        tmp_path / "local-app-data" / "OfferU"
    ).resolve()
    assert Path(os.environ["OFFERU_DATA_DIR"]).is_dir()
    assert os.environ["OFFERU_BUILD_MODE"] == "release"
    assert os.environ["OFFERU_RUNTIME_MODE"] == "desktop-sidecar"
    assert os.environ["OFFERU_PORT"] == "8765"
