from __future__ import annotations

import asyncio
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch
from types import SimpleNamespace

from sqlalchemy import create_engine, text
from sqlalchemy.ext.asyncio import create_async_engine

from app.database import (
    Base,
    DatabaseMigrationError,
    SCHEMA_MIGRATIONS,
    prepare_schema_migration,
    run_schema_migrations,
    schema_migration_status,
)
from app.services.data_safety import DataSafetyLayout, database_integrity_report, list_backups

# Register every current ORM table before create_all/smoke checks run.
import app.models.models  # noqa: F401, E402


class DatabaseMigrationTests(unittest.TestCase):
    def _fixture(self, root: Path) -> tuple[Path, Path, str, DataSafetyLayout]:
        backend_dir = root / "backend"
        backend_dir.mkdir(parents=True)
        database_path = backend_dir / "old-schema.db"
        connection = sqlite3.connect(database_path)
        try:
            connection.executescript(
                """
                CREATE TABLE pools (
                    id INTEGER PRIMARY KEY,
                    name TEXT NOT NULL,
                    scope TEXT NOT NULL
                );
                INSERT INTO pools(id, name, scope) VALUES (1, '旧池', 'screened');
                CREATE TABLE jobs (
                    id INTEGER PRIMARY KEY,
                    title TEXT NOT NULL,
                    company TEXT NOT NULL,
                    triage_status TEXT NOT NULL,
                    hash_key TEXT NOT NULL UNIQUE
                );
                INSERT INTO jobs(id, title, company, triage_status, hash_key)
                    VALUES (1, '旧岗位', '旧公司', 'screened', 'old-schema-job');
                PRAGMA user_version = 0;
                """
            )
        finally:
            connection.close()
        url = f"sqlite+aiosqlite:///{database_path.as_posix()}"
        layout = DataSafetyLayout(backend_dir=backend_dir, database_path=database_path)
        return database_path, backend_dir, url, layout

    def test_old_schema_gets_backup_and_reaches_current_version(self) -> None:
        def migrate(url: str) -> None:
            engine = create_engine(url.replace("+aiosqlite", ""))
            try:
                with engine.begin() as connection:
                    Base.metadata.create_all(connection)
                    result = run_schema_migrations(connection)
                    self.assertEqual(result, {"from_version": 0, "to_version": 2})
            finally:
                engine.dispose()

        with tempfile.TemporaryDirectory() as directory:
            database_path, backend_dir, url, layout = self._fixture(Path(directory))
            prepared = asyncio.run(
                prepare_schema_migration(url, backend_dir=backend_dir)
            )
            self.assertTrue(prepared["required"])
            self.assertEqual(prepared["from_version"], 0)
            backups = list_backups(layout)
            self.assertEqual(len(backups["items"]), 1)
            self.assertEqual(backups["items"][0]["reason"], "pre_migration")
            migrate(url)

            connection = sqlite3.connect(database_path)
            try:
                self.assertEqual(connection.execute("PRAGMA user_version").fetchone()[0], 2)
                job_status = connection.execute(
                    "SELECT triage_status FROM jobs WHERE id = 1"
                ).fetchone()[0]
                pool_scope = connection.execute(
                    "SELECT scope FROM pools WHERE id = 1"
                ).fetchone()[0]
                table_names = {
                    row[0]
                    for row in connection.execute(
                        "SELECT name FROM sqlite_master WHERE type = 'table'"
                    )
                }
            finally:
                connection.close()
            self.assertEqual(job_status, "picked")
            self.assertEqual(pool_scope, "picked")
            self.assertIn("resumes", table_names)
            self.assertEqual(schema_migration_status(url)["status"], "ready")
            self.assertEqual(database_integrity_report(layout)["status"], "ok")

    def test_version_one_fixture_applies_only_the_next_migration(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            backend_dir = root / "backend"
            backend_dir.mkdir(parents=True)
            database_path = backend_dir / "version-one.db"
            engine = create_engine(f"sqlite:///{database_path.as_posix()}")
            try:
                with engine.begin() as connection:
                    Base.metadata.create_all(connection)
                    connection.execute(text("PRAGMA user_version = 1"))
            finally:
                engine.dispose()
            url = f"sqlite+aiosqlite:///{database_path.as_posix()}"
            layout = DataSafetyLayout(backend_dir=backend_dir, database_path=database_path)

            prepared = asyncio.run(
                prepare_schema_migration(url, backend_dir=backend_dir)
            )
            self.assertEqual(prepared["from_version"], 1)
            self.assertTrue(prepared["required"])
            engine = create_engine(f"sqlite:///{database_path.as_posix()}")
            try:
                with engine.begin() as connection:
                    self.assertEqual(run_schema_migrations(connection), {"from_version": 1, "to_version": 2})
            finally:
                engine.dispose()
            self.assertEqual(schema_migration_status(url)["status"], "ready")
            self.assertEqual(len(list_backups(layout)["items"]), 1)

    def test_future_schema_version_fails_closed_without_creating_backup(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            database_path, backend_dir, url, layout = self._fixture(Path(directory))
            connection = sqlite3.connect(database_path)
            try:
                connection.execute("PRAGMA user_version = 99")
                connection.commit()
            finally:
                connection.close()

            with self.assertRaisesRegex(DatabaseMigrationError, "高于当前支持"):
                asyncio.run(prepare_schema_migration(url, backend_dir=backend_dir))
            self.assertEqual(schema_migration_status(url)["status"], "failed")
            self.assertEqual(list_backups(layout)["items"], [])

    def test_init_db_restores_pre_migration_backup_after_failure(self) -> None:
        import app.database as database

        def fail_after_ddl(connection) -> None:  # noqa: ANN001
            connection.execute(text("ALTER TABLE jobs ADD COLUMN transient_column TEXT"))
            raise RuntimeError("forced init migration failure")

        with tempfile.TemporaryDirectory() as directory:
            database_path, backend_dir, url, layout = self._fixture(Path(directory))
            engine = create_async_engine(url)
            try:
                with patch.object(database, "engine", engine), patch.object(
                    database,
                    "settings",
                    SimpleNamespace(database_url=url),
                ), patch.dict(SCHEMA_MIGRATIONS, {1: fail_after_ddl}):
                    with self.assertRaisesRegex(DatabaseMigrationError, "已从迁移前备份"):
                        asyncio.run(database.init_db(backend_dir=backend_dir))
            finally:
                asyncio.run(engine.dispose())

            connection = sqlite3.connect(database_path)
            try:
                columns = {
                    row[1]
                    for row in connection.execute("PRAGMA table_info(jobs)")
                }
                version = connection.execute("PRAGMA user_version").fetchone()[0]
            finally:
                connection.close()
            self.assertNotIn("transient_column", columns)
            self.assertEqual(version, 0)
            self.assertEqual(len(list_backups(layout)["items"]), 1)


if __name__ == "__main__":
    unittest.main()
