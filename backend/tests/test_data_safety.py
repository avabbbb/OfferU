from __future__ import annotations

import asyncio
from pathlib import Path
import shutil
import sqlite3
import tempfile
import unittest
from unittest.mock import patch
import zipfile

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.database import Base
from app.models.models import Job, Profile
from app.ops import OPERATIONS, execute_operation
from app.services.data_safety import (
    DataSafetyError,
    DataSafetyLayout,
    _validate_member,
    apply_pending_restore_before_database_connect,
    cancel_pending_restore,
    create_backup,
    data_safety_status,
    database_integrity_report,
    list_backups,
    stage_restore,
)


def _write_state(layout: DataSafetyLayout, value: str) -> None:
    layout.database_path.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(layout.database_path)
    try:
        connection.execute(
            "CREATE TABLE IF NOT EXISTS recovery_probe (id INTEGER PRIMARY KEY, value TEXT NOT NULL)"
        )
        connection.execute(
            "INSERT INTO recovery_probe (id, value) VALUES (1, ?) "
            "ON CONFLICT(id) DO UPDATE SET value=excluded.value",
            (value,),
        )
        connection.execute("PRAGMA user_version=7")
        connection.commit()
    finally:
        connection.close()
    layout.uploads_dir.mkdir(parents=True, exist_ok=True)
    layout.artifacts_dir.mkdir(parents=True, exist_ok=True)
    (layout.uploads_dir / "resume.txt").write_text(f"upload:{value}", encoding="utf-8")
    (layout.artifacts_dir / "result.json").write_text(f'{{"value":"{value}"}}', encoding="utf-8")


def _read_state(layout: DataSafetyLayout) -> tuple[str, str, str]:
    connection = sqlite3.connect(layout.database_path)
    try:
        value = str(connection.execute("SELECT value FROM recovery_probe WHERE id=1").fetchone()[0])
    finally:
        connection.close()
    return (
        value,
        (layout.uploads_dir / "resume.txt").read_text(encoding="utf-8"),
        (layout.artifacts_dir / "result.json").read_text(encoding="utf-8"),
    )


class DataSafetyTests(unittest.TestCase):
    def _layout(self, root: Path) -> DataSafetyLayout:
        backend_dir = root / "backend"
        backend_dir.mkdir(parents=True)
        return DataSafetyLayout(
            backend_dir=backend_dir,
            database_path=backend_dir / "isolated.db",
        )

    def test_three_backup_restore_restart_cycles_preserve_database_and_assets(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            layout = self._layout(Path(directory))
            for cycle in range(1, 4):
                expected = f"saved-{cycle}"
                _write_state(layout, expected)
                backup = create_backup(layout, app_version="test")

                _write_state(layout, f"mutated-{cycle}")
                staged = stage_restore(layout, backup_id=backup["backup_id"])
                self.assertTrue(staged["pending_restart"])
                self.assertEqual(_read_state(layout)[0], f"mutated-{cycle}")

                applied = apply_pending_restore_before_database_connect(
                    database_url=f"sqlite+aiosqlite:///{layout.database_path.as_posix()}",
                    backend_dir=layout.backend_dir,
                )
                self.assertTrue(applied["applied"])
                self.assertEqual(
                    _read_state(layout),
                    (expected, f"upload:{expected}", f'{{"value":"{expected}"}}'),
                )
                self.assertEqual(database_integrity_report(layout)["status"], "ok")

            backups = list_backups(layout)
            self.assertEqual(len(backups["items"]), 6)
            self.assertEqual(backups["invalid"], [])

    def test_staging_is_idempotent_and_cancel_preserves_backup(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            layout = self._layout(Path(directory))
            _write_state(layout, "base")
            backup = create_backup(layout, app_version="test")

            first = stage_restore(layout, backup_id=backup["backup_id"])
            second = stage_restore(layout, backup_id=backup["backup_id"])
            self.assertEqual(first["staged_at"], second["staged_at"])
            self.assertEqual(data_safety_status(layout)["pending_restore"]["backup_id"], backup["backup_id"])

            cancelled = cancel_pending_restore(layout)
            self.assertTrue(cancelled["cancelled"])
            self.assertTrue(cancelled["backup_preserved"])
            self.assertIsNone(data_safety_status(layout)["pending_restore"])
            self.assertEqual(len(list_backups(layout)["items"]), 1)

    def test_confirmed_cancel_quarantines_corrupt_pending_marker(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            layout = self._layout(Path(directory))
            layout.pending_file.parent.mkdir(parents=True, exist_ok=True)
            layout.pending_file.write_text("{not-json", encoding="utf-8")

            result = cancel_pending_restore(layout)

            self.assertTrue(result["cancelled"])
            self.assertTrue(result["invalid_marker_quarantined"])
            self.assertTrue(result["staging_preserved"])
            self.assertFalse(layout.pending_file.exists())
            self.assertEqual(
                len(list((layout.root / "cancelled_restore_markers").glob("invalid-*.json"))),
                1,
            )

    def test_different_restore_requires_cancelling_existing_pending_restore(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            layout = self._layout(Path(directory))
            _write_state(layout, "one")
            first = create_backup(layout, app_version="test")
            _write_state(layout, "two")
            second = create_backup(layout, app_version="test")
            stage_restore(layout, backup_id=first["backup_id"])

            with self.assertRaisesRegex(DataSafetyError, "先取消"):
                stage_restore(layout, backup_id=second["backup_id"])

    def test_failed_install_rolls_back_live_state_and_keeps_recovery_material(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            layout = self._layout(Path(directory))
            _write_state(layout, "backup")
            backup = create_backup(layout, app_version="test")
            _write_state(layout, "live-before-failed-restore")
            stage_restore(layout, backup_id=backup["backup_id"])

            with patch(
                "app.services.data_safety._verify_installed_state",
                side_effect=DataSafetyError("forced verification failure"),
            ):
                with self.assertRaisesRegex(DataSafetyError, "自动回滚"):
                    apply_pending_restore_before_database_connect(
                        database_url=f"sqlite+aiosqlite:///{layout.database_path.as_posix()}",
                        backend_dir=layout.backend_dir,
                    )

            self.assertEqual(_read_state(layout)[0], "live-before-failed-restore")
            self.assertTrue(layout.pending_file.is_file())
            self.assertTrue((layout.restore_dir / backup["backup_id"]).is_dir())
            self.assertGreaterEqual(len(list_backups(layout)["items"]), 2)

    def test_sidecar_move_failure_restores_already_moved_sidecars(self) -> None:
        import app.services.data_safety as data_safety

        with tempfile.TemporaryDirectory() as directory:
            layout = self._layout(Path(directory))
            _write_state(layout, "backup")
            backup = create_backup(layout, app_version="test")
            _write_state(layout, "live")
            stage_restore(layout, backup_id=backup["backup_id"])

            wal_path = Path(f"{layout.database_path}-wal")
            shm_path = Path(f"{layout.database_path}-shm")
            wal_path.write_bytes(b"wal-before-failure")
            shm_path.write_bytes(b"shm-before-failure")
            real_replace = data_safety.os.replace
            sidecar_moves = 0

            def fail_second_sidecar_move(source, destination) -> None:  # noqa: ANN001
                nonlocal sidecar_moves
                if str(source).endswith(("-wal", "-shm")):
                    sidecar_moves += 1
                    if sidecar_moves == 2:
                        raise OSError("forced second sidecar move failure")
                real_replace(source, destination)

            with patch.object(data_safety.os, "replace", side_effect=fail_second_sidecar_move):
                with self.assertRaisesRegex(DataSafetyError, "原数据已自动回滚"):
                    apply_pending_restore_before_database_connect(
                        database_url=f"sqlite+aiosqlite:///{layout.database_path.as_posix()}",
                        backend_dir=layout.backend_dir,
                    )

            self.assertEqual(wal_path.read_bytes(), b"wal-before-failure")
            self.assertEqual(shm_path.read_bytes(), b"shm-before-failure")

    def test_windows_alternate_data_stream_member_is_rejected(self) -> None:
        with self.assertRaisesRegex(DataSafetyError, "越界路径"):
            _validate_member(zipfile.ZipInfo("uploads/resume.txt:secret"))

    def test_tampered_archive_is_rejected_without_pending_restore(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            layout = self._layout(Path(directory))
            _write_state(layout, "tamper-source")
            backup = create_backup(layout, app_version="test")
            archive_path = layout.backup_dir / f'{backup["backup_id"]}.offeru-backup'
            tampered_path = archive_path.with_suffix(".tampered")
            with zipfile.ZipFile(archive_path, "r") as source, zipfile.ZipFile(
                tampered_path,
                "w",
                compression=zipfile.ZIP_DEFLATED,
            ) as target:
                for info in source.infolist():
                    payload = source.read(info.filename)
                    target.writestr(
                        info,
                        b"tampered" if info.filename == "database.sqlite3" else payload,
                    )
            tampered_path.replace(archive_path)

            with self.assertRaisesRegex(DataSafetyError, "哈希校验失败"):
                stage_restore(layout, backup_id=backup["backup_id"])
            self.assertFalse(layout.pending_file.exists())

    def test_backup_symlink_is_rejected_without_reading_target(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            layout = self._layout(Path(directory))
            _write_state(layout, "symlink-source")
            backup = create_backup(layout, app_version="test")
            archive_path = layout.backup_dir / f'{backup["backup_id"]}.offeru-backup'
            outside = Path(directory) / "outside.offeru-backup"
            outside.write_bytes(archive_path.read_bytes())
            archive_path.unlink()
            try:
                archive_path.symlink_to(outside)
            except (OSError, NotImplementedError) as exc:
                self.skipTest(f"symlink creation unavailable: {exc}")

            with self.assertRaisesRegex(DataSafetyError, "符号链接"):
                stage_restore(layout, backup_id=backup["backup_id"])
            listed = list_backups(layout)
            self.assertEqual(listed["items"], [])
            self.assertEqual(len(listed["invalid"]), 1)

    def test_database_symlink_is_rejected_before_integrity_or_backup(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            layout = self._layout(Path(directory))
            real_database = Path(directory) / "outside.sqlite3"
            connection = sqlite3.connect(real_database)
            connection.execute("CREATE TABLE probe (value TEXT NOT NULL)")
            connection.execute("INSERT INTO probe(value) VALUES ('outside')")
            connection.commit()
            connection.close()
            try:
                layout.database_path.symlink_to(real_database)
            except (OSError, NotImplementedError) as exc:
                self.skipTest(f"symlink creation unavailable: {exc}")

            with self.assertRaisesRegex(DataSafetyError, "不能是符号链接"):
                database_integrity_report(layout)
            with self.assertRaisesRegex(DataSafetyError, "不能是符号链接"):
                create_backup(layout, app_version="test")
            self.assertFalse(data_safety_status(layout)["database"]["exists"])

    def test_data_safety_directory_symlink_is_rejected_before_read_or_write(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            layout = self._layout(root)
            outside = root / "outside-data-safety"
            outside.mkdir()
            data_dir = layout.backend_dir / "data"
            try:
                data_dir.symlink_to(outside, target_is_directory=True)
            except (OSError, NotImplementedError) as exc:
                self.skipTest(f"symlink creation unavailable: {exc}")

            with self.assertRaisesRegex(DataSafetyError, "符号链接"):
                create_backup(layout, app_version="test")
            self.assertEqual(list(outside.iterdir()), [])

    def test_invalid_marker_quarantine_symlink_is_rejected_before_move(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            layout = self._layout(root)
            layout.pending_file.parent.mkdir(parents=True, exist_ok=True)
            layout.pending_file.write_text("{not-json", encoding="utf-8")
            outside = root / "outside-quarantine"
            outside.mkdir()
            quarantine_dir = layout.root / "cancelled_restore_markers"
            try:
                quarantine_dir.symlink_to(outside, target_is_directory=True)
            except (OSError, NotImplementedError) as exc:
                self.skipTest(f"symlink creation unavailable: {exc}")

            with self.assertRaisesRegex(DataSafetyError, "符号链接"):
                cancel_pending_restore(layout)
            self.assertTrue(layout.pending_file.is_file())
            self.assertEqual(list(outside.iterdir()), [])

    def test_staged_restore_symlink_is_rejected_before_validation(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            layout = self._layout(root)
            _write_state(layout, "staged-source")
            backup = create_backup(layout, app_version="test")
            stage_restore(layout, backup_id=backup["backup_id"])

            outside = root / "outside-staged-restore"
            outside.mkdir()
            shutil.rmtree(layout.restore_dir / backup["backup_id"])
            try:
                (layout.restore_dir / backup["backup_id"]).symlink_to(
                    outside,
                    target_is_directory=True,
                )
            except (OSError, NotImplementedError) as exc:
                self.skipTest(f"symlink creation unavailable: {exc}")

            with self.assertRaisesRegex(DataSafetyError, "符号链接"):
                apply_pending_restore_before_database_connect(
                    database_url=f"sqlite+aiosqlite:///{layout.database_path.as_posix()}",
                    backend_dir=layout.backend_dir,
                )

            self.assertTrue(layout.pending_file.is_file())
            self.assertEqual(list(outside.iterdir()), [])

    def test_restore_preserves_real_profile_and_job_state_after_new_engine_connects(self) -> None:
        async def seed(database_path: Path) -> None:
            engine = create_async_engine(f"sqlite+aiosqlite:///{database_path.as_posix()}")
            session = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
            try:
                async with engine.begin() as connection:
                    await connection.run_sync(Base.metadata.create_all)
                async with session() as db:
                    db.add(Profile(name="恢复前档案", email="recovery@example.com"))
                    db.add(
                        Job(
                            title="恢复前岗位",
                            company="数据安全公司",
                            raw_description="真实领域状态恢复验证",
                            hash_key="data-safety-domain-job",
                        )
                    )
                    await db.commit()
            finally:
                await engine.dispose()

        async def mutate(database_path: Path) -> None:
            engine = create_async_engine(f"sqlite+aiosqlite:///{database_path.as_posix()}")
            session = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
            try:
                async with session() as db:
                    profile = (await db.execute(select(Profile))).scalars().first()
                    job = (await db.execute(select(Job))).scalars().first()
                    assert profile is not None and job is not None
                    profile.name = "恢复后不应保留的档案"
                    job.title = "恢复后不应保留的岗位"
                    await db.commit()
            finally:
                await engine.dispose()

        async def read(database_path: Path) -> tuple[str, str]:
            engine = create_async_engine(f"sqlite+aiosqlite:///{database_path.as_posix()}")
            session = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
            try:
                async with session() as db:
                    profile = (await db.execute(select(Profile))).scalars().first()
                    job = (await db.execute(select(Job))).scalars().first()
                    assert profile is not None and job is not None
                    return profile.name, job.title
            finally:
                await engine.dispose()

        with tempfile.TemporaryDirectory() as directory:
            layout = self._layout(Path(directory))
            asyncio.run(seed(layout.database_path))
            layout.uploads_dir.mkdir(parents=True, exist_ok=True)
            layout.artifacts_dir.mkdir(parents=True, exist_ok=True)
            backup = create_backup(layout, app_version="test")
            asyncio.run(mutate(layout.database_path))
            stage_restore(layout, backup_id=backup["backup_id"])
            apply_pending_restore_before_database_connect(
                database_url=f"sqlite+aiosqlite:///{layout.database_path.as_posix()}",
                backend_dir=layout.backend_dir,
            )

            self.assertEqual(
                asyncio.run(read(layout.database_path)),
                ("恢复前档案", "恢复前岗位"),
            )

    def test_registry_exposes_data_safety_and_rejects_unconfirmed_restore(self) -> None:
        for name in (
            "get_data_safety_status",
            "check_database_integrity",
            "list_data_backups",
            "create_data_backup",
            "stage_data_restore",
            "cancel_data_restore",
            "reset_demo_data",
        ):
            self.assertIn(name, OPERATIONS)

        result = asyncio.run(
            execute_operation(
                "stage_data_restore",
                {"backup_id": "a" * 32, "user_confirmed": False},
                audit=False,
            )
        )
        self.assertFalse(result["ok"])
        self.assertIn("明确确认", " ".join(result["errors"]))

    def test_registry_round_trip_uses_managed_service_without_exposing_absolute_path(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            layout = self._layout(Path(directory))
            _write_state(layout, "registry")
            with patch("app.services.data_safety._runtime_layout", return_value=layout):
                created = asyncio.run(
                    execute_operation("create_data_backup", {}, audit=False)
                )
                listed = asyncio.run(
                    execute_operation("list_data_backups", {}, audit=False)
                )
                status = asyncio.run(
                    execute_operation("get_data_safety_status", {}, audit=False)
                )
                integrity = asyncio.run(
                    execute_operation("check_database_integrity", {}, audit=False)
                )

            self.assertTrue(created["ok"])
            self.assertNotIn("archive_path", created["outputs"])
            self.assertEqual(len(listed["outputs"]["items"]), 1)
            self.assertEqual(status["outputs"]["backup_count"], 1)
            self.assertEqual(integrity["outputs"]["status"], "ok")


if __name__ == "__main__":
    unittest.main()
