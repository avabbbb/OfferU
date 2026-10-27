from __future__ import annotations

import asyncio
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch
from types import SimpleNamespace

from sqlalchemy import MetaData, create_engine, inspect, text
from sqlalchemy.ext.asyncio import create_async_engine
from sqlalchemy.orm import Session
from sqlalchemy.schema import CreateTable

from app.database import (
    Base,
    CURRENT_SCHEMA_VERSION,
    DatabaseMigrationError,
    SCHEMA_MIGRATIONS,
    prepare_schema_migration,
    run_schema_migrations,
    schema_migration_status,
)
from app.services.data_safety import DataSafetyLayout, database_integrity_report, list_backups

# Register every current ORM table before create_all/smoke checks run.
from app.models.models import AgentRunRecord, JobSearchTask  # noqa: E402


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
                    self.assertEqual(result, {"from_version": 0, "to_version": CURRENT_SCHEMA_VERSION})
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
                self.assertEqual(connection.execute("PRAGMA user_version").fetchone()[0], CURRENT_SCHEMA_VERSION)
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
                    self.assertEqual(run_schema_migrations(connection), {"from_version": 1, "to_version": CURRENT_SCHEMA_VERSION})
            finally:
                engine.dispose()
            self.assertEqual(schema_migration_status(url)["status"], "ready")
            self.assertEqual(len(list_backups(layout)["items"]), 1)

    def test_v4_resume_proposals_become_nullable_without_losing_constraints_or_data(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            database_path = Path(directory) / "version-four.db"
            engine = create_engine(f"sqlite:///{database_path.as_posix()}")
            proposal = Base.metadata.tables["resume_optimization_proposals"]
            try:
                with engine.begin() as connection:
                    connection.exec_driver_sql("PRAGMA foreign_keys = ON")
                    for statement in (
                        'CREATE TABLE "jobs" ("id" INTEGER PRIMARY KEY)',
                        'CREATE TABLE "profiles" ("id" INTEGER PRIMARY KEY)',
                        'CREATE TABLE "job_research_runs" ("run_id" VARCHAR(64) PRIMARY KEY)',
                        'CREATE TABLE "resumes" ("id" INTEGER PRIMARY KEY)',
                        'CREATE TABLE "resume_versions" ("id" INTEGER PRIMARY KEY)',
                    ):
                        connection.exec_driver_sql(statement)
                    migration_support_tables = {
                        "jobs",
                        "profiles",
                        "job_research_runs",
                        "resumes",
                        "resume_versions",
                        proposal.name,
                    }
                    for table in Base.metadata.sorted_tables:
                        if table.name not in migration_support_tables:
                            connection.execute(CreateTable(table))
                    connection.exec_driver_sql('INSERT INTO "jobs" ("id") VALUES (11)')
                    connection.exec_driver_sql('INSERT INTO "profiles" ("id") VALUES (12)')
                    connection.exec_driver_sql(
                        'INSERT INTO "job_research_runs" ("run_id") VALUES (\'research-v4\')'
                    )

                    legacy_metadata = MetaData()
                    for foreign_key in proposal.foreign_keys:
                        referred_table = foreign_key.column.table
                        if referred_table.key not in legacy_metadata.tables:
                            referred_table.to_metadata(legacy_metadata)
                    legacy_proposal = proposal.to_metadata(legacy_metadata)
                    legacy_proposal.c.research_run_id.nullable = False
                    connection.execute(CreateTable(legacy_proposal))
                    connection.execute(
                        proposal.insert().values(
                            proposal_id="proposal-v4",
                            job_id=11,
                            profile_id=12,
                            research_run_id="research-v4",
                            source_snapshot_hash="source-v4",
                            research_snapshot_hash="research-v4",
                        )
                    )
                    connection.exec_driver_sql("PRAGMA user_version = 4")

                    self.assertEqual(
                        run_schema_migrations(connection),
                        {"from_version": 4, "to_version": CURRENT_SCHEMA_VERSION},
                    )
                    research_run_column = next(
                        column
                        for column in inspect(connection).get_columns("resume_optimization_proposals")
                        if column["name"] == "research_run_id"
                    )
                    self.assertTrue(research_run_column["nullable"])
                    self.assertEqual(
                        connection.exec_driver_sql(
                            'SELECT proposal_id, job_id, profile_id, research_run_id, '
                            'source_snapshot_hash, research_snapshot_hash '
                            'FROM "resume_optimization_proposals"'
                        ).one(),
                        (
                            "proposal-v4",
                            11,
                            12,
                            "research-v4",
                            "source-v4",
                            "research-v4",
                        ),
                    )

                    actual_foreign_keys = {
                        (
                            row["referred_table"],
                            tuple(row["constrained_columns"]),
                            tuple(row["referred_columns"]),
                        )
                        for row in inspect(connection).get_foreign_keys(
                            "resume_optimization_proposals"
                        )
                    }
                    expected_foreign_keys = {
                        (
                            foreign_key.column.table.name,
                            (foreign_key.parent.name,),
                            (foreign_key.column.name,),
                        )
                        for foreign_key in proposal.foreign_keys
                    }
                    self.assertEqual(actual_foreign_keys, expected_foreign_keys)

                    actual_indexes = {
                        index["name"]
                        for index in inspect(connection).get_indexes(
                            "resume_optimization_proposals"
                        )
                    }
                    self.assertTrue({index.name for index in proposal.indexes} <= actual_indexes)

                    connection.execute(
                        proposal.insert().values(
                            proposal_id="proposal-no-research-run",
                            job_id=11,
                            profile_id=12,
                            research_run_id=None,
                            source_snapshot_hash="source-v5",
                            research_snapshot_hash="research-v5",
                        )
                    )
            finally:
                engine.dispose()

    def test_v8_drops_template_column_without_cascading_into_sections(self) -> None:
        from app.database import drop_legacy_template_schema

        with tempfile.TemporaryDirectory() as directory:
            database_path = Path(directory) / "v7.db"
            engine = create_engine(f"sqlite:///{database_path.as_posix()}")
            try:
                with engine.begin() as connection:
                    Base.metadata.create_all(connection)
                    connection.exec_driver_sql("CREATE TABLE resume_templates (id INTEGER PRIMARY KEY)")
                    connection.exec_driver_sql("CREATE TABLE html_resumes (id INTEGER PRIMARY KEY)")
                    connection.exec_driver_sql(
                        "ALTER TABLE resumes ADD COLUMN template_id INTEGER REFERENCES resume_templates(id)"
                    )
                    connection.exec_driver_sql("INSERT INTO resume_templates (id) VALUES (1)")
                    connection.exec_driver_sql(
                        "INSERT INTO resumes (id, user_name, title, photo_url, summary, contact_json, "
                        "style_config, is_primary, language, source_mode, workspace_revision, template_id) "
                        "VALUES (1, 'u', 't', '', '', '{}', '{}', 1, 'zh', 'manual', 1, 1)"
                    )
                    connection.exec_driver_sql(
                        "INSERT INTO resume_sections (resume_id, section_type, sort_order, title, visible, content_json) "
                        "VALUES (1, 'experience', 0, 'x', 1, '[]')"
                    )
            finally:
                engine.dispose()

            drop_legacy_template_schema(database_path)

            connection = sqlite3.connect(database_path)
            try:
                columns = [row[1] for row in connection.execute('PRAGMA table_info("resumes")')]
                self.assertNotIn("template_id", columns)
                self.assertEqual(connection.execute("SELECT count(*) FROM resume_sections").fetchone()[0], 1)
                tables = {row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")}
                self.assertFalse({"resume_templates", "html_resumes", "resumes_v8"} & tables)
                connection.execute("PRAGMA foreign_keys=ON")
                connection.execute("DELETE FROM resumes")
                self.assertEqual(connection.execute("SELECT count(*) FROM resume_sections").fetchone()[0], 0)
            finally:
                connection.close()

    def test_v9_adds_columns_missing_from_a_v8_database_idempotently(self) -> None:
        from app.database import _migrate_schema_v9

        with tempfile.TemporaryDirectory() as directory:
            engine = create_engine(f"sqlite:///{Path(directory) / 'drift.db'}")
            try:
                with engine.begin() as connection:
                    connection.execute(text("CREATE TABLE jobs (id INTEGER PRIMARY KEY, title VARCHAR(200))"))
                    connection.execute(text("INSERT INTO jobs (id, title) VALUES (1, 'kept')"))
                    connection.execute(text("CREATE TABLE agent_input_requests (id INTEGER PRIMARY KEY)"))
                    connection.execute(text("INSERT INTO agent_input_requests (id) VALUES (1)"))
                for _ in range(2):
                    with engine.begin() as connection:
                        _migrate_schema_v9(connection)

                columns = inspect(engine)
                job_columns = {column["name"] for column in columns.get_columns("jobs")}
                request_columns = {column["name"] for column in columns.get_columns("agent_input_requests")}
                self.assertIn("boss_security_id", job_columns)
                self.assertTrue(
                    {"selection_mode", "min_selections", "max_selections", "allow_skip"} <= request_columns
                )
                with engine.connect() as connection:
                    self.assertEqual(
                        connection.execute(text("SELECT title, boss_security_id FROM jobs")).one(),
                        ("kept", ""),
                    )
                    self.assertEqual(
                        connection.execute(
                            text("SELECT selection_mode, min_selections, max_selections, allow_skip FROM agent_input_requests")
                        ).one(),
                        ("single", 0, 0, 1),
                    )
            finally:
                engine.dispose()

    def test_v6_migration_is_idempotent_when_tables_already_exist(self) -> None:
        """If create_all already created v6 tables, migration must not fail."""
        with tempfile.TemporaryDirectory() as directory:
            database_path = Path(directory) / "version-five-pre-created.db"
            engine = create_engine(f"sqlite:///{database_path.as_posix()}")
            try:
                with engine.begin() as connection:
                    Base.metadata.create_all(connection)
                    connection.exec_driver_sql("PRAGMA user_version = 5")
                    self.assertEqual(
                        run_schema_migrations(connection),
                        {"from_version": 5, "to_version": CURRENT_SCHEMA_VERSION},
                    )
            finally:
                engine.dispose()


    def test_prototype_v6_history_is_preserved_without_migrating_approval(self) -> None:
        from app.database import _preserve_prototype_decision_history

        with tempfile.TemporaryDirectory() as directory:
            database_path = Path(directory) / "prototype-v6.db"
            engine = create_engine(f"sqlite:///{database_path.as_posix()}")
            try:
                with engine.begin() as connection:
                    connection.exec_driver_sql("PRAGMA foreign_keys = ON")
                    connection.exec_driver_sql(
                        "CREATE TABLE proposal_plans (plan_id TEXT PRIMARY KEY, immutable_json JSON NOT NULL)"
                    )
                    connection.exec_driver_sql(
                        "CREATE TABLE historical_link (id TEXT PRIMARY KEY, plan_id TEXT REFERENCES proposal_plans(plan_id))"
                    )
                    connection.exec_driver_sql(
                        "INSERT INTO proposal_plans VALUES ('owner-old-plan', '{\"approved\":true}')"
                    )
                    connection.exec_driver_sql("INSERT INTO historical_link VALUES ('link', 'owner-old-plan')")
                    connection.exec_driver_sql("PRAGMA user_version = 6")
                url = f"sqlite+aiosqlite:///{database_path.as_posix()}"
                layout = DataSafetyLayout(backend_dir=Path(directory), database_path=database_path)
                prepared = asyncio.run(prepare_schema_migration(url, backend_dir=Path(directory)))
                self.assertTrue(prepared["required"])
                self.assertEqual(len(list_backups(layout)["items"]), 1)
                with engine.begin() as connection:
                    # init_db must archive before create_all encounters the incompatible table.
                    _preserve_prototype_decision_history(connection)
                    Base.metadata.create_all(connection)
                    run_schema_migrations(connection)
                    archived = connection.exec_driver_sql(
                        "SELECT immutable_json FROM legacy_decision_proposal_plans WHERE plan_id = 'owner-old-plan'"
                    ).scalar_one()
                    self.assertEqual(json.loads(archived), {"approved": True})
                    self.assertEqual(inspect(connection).get_foreign_keys("historical_link")[0]["referred_table"],
                                     "legacy_decision_proposal_plans")
                    self.assertEqual(connection.exec_driver_sql("PRAGMA foreign_key_check").all(), [])
                    self.assertEqual(run_schema_migrations(connection)["from_version"], CURRENT_SCHEMA_VERSION)
            finally:
                engine.dispose()

    def test_unrecognized_plan_table_fails_closed_and_preserves_rows(self) -> None:
        from app.database import _preserve_prototype_decision_history

        engine = create_engine("sqlite://")
        try:
            with engine.begin() as connection:
                connection.exec_driver_sql("CREATE TABLE proposal_plans (unexpected TEXT)")
                connection.exec_driver_sql("INSERT INTO proposal_plans VALUES ('must-survive')")
                with self.assertRaisesRegex(DatabaseMigrationError, "无法识别"):
                    _preserve_prototype_decision_history(connection)
                self.assertEqual(connection.exec_driver_sql("SELECT unexpected FROM proposal_plans").scalar_one(),
                                 "must-survive")
        finally:
            engine.dispose()

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
