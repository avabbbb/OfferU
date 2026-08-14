import os
import subprocess
import sys
from pathlib import Path


BACKEND_DIR = Path(__file__).resolve().parents[1]


def test_sqlite_engine_imports_and_enables_foreign_keys(tmp_path: Path) -> None:
    database_path = tmp_path / "database-engine.db"
    env = os.environ.copy()
    env["DATABASE_URL"] = f"sqlite+aiosqlite:///{database_path.as_posix()}"
    probe = """
import asyncio
from sqlalchemy import text
from app.database import engine

async def main():
    async with engine.connect() as connection:
        print(await connection.scalar(text("PRAGMA foreign_keys")))
    await engine.dispose()

asyncio.run(main())
"""

    result = subprocess.run(
        [sys.executable, "-c", probe],
        cwd=BACKEND_DIR,
        env=env,
        capture_output=True,
        text=True,
        timeout=15,
        check=False,
    )

    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == "1"


def test_all_sqlalchemy_mappers_configure(tmp_path: Path) -> None:
    database_path = tmp_path / "mapper-config.db"
    env = os.environ.copy()
    env["DATABASE_URL"] = f"sqlite+aiosqlite:///{database_path.as_posix()}"
    probe = """
from sqlalchemy.orm import configure_mappers
import app.models.models
import app.models.html_resume

configure_mappers()
print("configured")
"""

    result = subprocess.run(
        [sys.executable, "-c", probe],
        cwd=BACKEND_DIR,
        env=env,
        capture_output=True,
        text=True,
        timeout=15,
        check=False,
    )

    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == "configured"
