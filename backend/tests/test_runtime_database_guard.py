from pathlib import Path

import pytest

from app import entry
from app.runtime_paths import database_location_problem


_KEYS = (
    "DATABASE_URL",
    "OFFERU_DATA_DIR",
    "OFFERU_ALLOW_EXTERNAL_DATABASE",
    "OFFERU_RUNTIME_MODE",
    "OFFERU_PORT",
    "OFFERU_FRONTEND_HEALTH_URL",
)


@pytest.fixture
def clean_env(monkeypatch):
    for key in _KEYS:
        monkeypatch.delenv(key, raising=False)
    return monkeypatch


def test_default_database_lives_in_data_dir(clean_env, tmp_path):
    resolved = entry.configure(tmp_path / "data")
    url = entry.os.environ["DATABASE_URL"]
    assert url.endswith((resolved / "djm.db").as_posix())
    assert database_location_problem(url, resolved) is None


def test_inherited_relative_sqlite_url_refuses_to_start(clean_env, tmp_path):
    clean_env.setenv("DATABASE_URL", "sqlite+aiosqlite:///./offeru.db")
    with pytest.raises(SystemExit) as exc:
        entry.configure(tmp_path / "data")
    assert "相对路径" in str(exc.value)


def test_inherited_url_outside_data_dir_refuses_to_start(clean_env, tmp_path):
    outside = (tmp_path / "elsewhere" / "offeru.db").as_posix()
    clean_env.setenv("DATABASE_URL", f"sqlite+aiosqlite:///{outside}")
    with pytest.raises(SystemExit) as exc:
        entry.configure(tmp_path / "data")
    assert "数据目录之外" in str(exc.value)


def test_inherited_url_inside_data_dir_is_kept(clean_env, tmp_path):
    data = (tmp_path / "data").resolve()
    url = f"sqlite+aiosqlite:///{(data / 'custom.db').as_posix()}"
    clean_env.setenv("DATABASE_URL", url)
    entry.configure(data)
    assert entry.os.environ["DATABASE_URL"] == url


def test_explicit_override_keeps_external_database(clean_env, tmp_path, capsys):
    outside = (tmp_path / "elsewhere" / "offeru.db").as_posix()
    clean_env.setenv("DATABASE_URL", f"sqlite+aiosqlite:///{outside}")
    clean_env.setenv("OFFERU_ALLOW_EXTERNAL_DATABASE", "1")
    entry.configure(tmp_path / "data")
    assert entry.os.environ["DATABASE_URL"].endswith(outside)
    assert "警告" in capsys.readouterr().err


@pytest.mark.parametrize("url", ["postgresql+asyncpg://u@h/db", "sqlite+aiosqlite:///:memory:"])
def test_non_file_databases_are_not_flagged(url, tmp_path):
    assert database_location_problem(url, tmp_path) is None


def test_diagnostics_reports_split_database(clean_env, tmp_path):
    from app.services.diagnostics import _database_location_mismatch

    data = (tmp_path / "data").resolve()
    assert _database_location_mismatch("sqlite+aiosqlite:///./offeru.db") is None
    clean_env.setenv("OFFERU_DATA_DIR", str(data))
    assert _database_location_mismatch("sqlite+aiosqlite:///./offeru.db") is True
    assert _database_location_mismatch(f"sqlite+aiosqlite:///{(data / 'djm.db').as_posix()}") is False
