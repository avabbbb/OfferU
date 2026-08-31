"""Consistent local backup, integrity checking, and restart-only restore."""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import sqlite3
import stat
import tempfile
import threading
from typing import Any
from uuid import uuid4
import zipfile

from sqlalchemy.engine import make_url


BACKEND_DIR = Path(__file__).resolve().parents[2]
BACKUP_FORMAT = "offeru.data-backup.v1"
PENDING_RESTORE_FORMAT = "offeru.pending-restore.v1"
ARCHIVE_SUFFIX = ".offeru-backup"
MAX_ARCHIVE_FILES = 20_000
MAX_ARCHIVE_BYTES = 8 * 1024 * 1024 * 1024
_BACKUP_ID = re.compile(r"^[a-f0-9]{32}$")
_LOCK = threading.RLock()


class DataSafetyError(RuntimeError):
    """Fail-closed error for backup or restore validation."""


@dataclass(frozen=True)
class DataSafetyLayout:
    backend_dir: Path
    database_path: Path

    @property
    def root(self) -> Path:
        return self.backend_dir / "data" / "data_safety"

    @property
    def backup_dir(self) -> Path:
        return self.root / "backups"

    @property
    def restore_dir(self) -> Path:
        return self.root / "restore_staging"

    @property
    def pending_file(self) -> Path:
        return self.root / "pending_restore.json"

    @property
    def uploads_dir(self) -> Path:
        return self.backend_dir / "uploads"

    @property
    def artifacts_dir(self) -> Path:
        return self.backend_dir / "data" / "artifacts"


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def _application_version() -> str:
    return os.getenv("OFFERU_VERSION", "0.4.0")


def _database_path_from_url(database_url: str) -> Path:
    try:
        url = make_url(database_url)
    except Exception as exc:
        raise DataSafetyError("DATABASE_URL 无法解析，不能执行数据安全操作。") from exc
    if not url.drivername.startswith("sqlite"):
        raise DataSafetyError("当前 Data Safety 备份仅支持 OfferU 的 SQLite 本地数据库。")
    if not url.database or url.database == ":memory:":
        raise DataSafetyError("内存 SQLite 数据库不能创建可恢复备份。")
    path = Path(url.database)
    if not path.is_absolute():
        path = Path.cwd() / path
    return path.resolve()


def _runtime_layout(*, database_url: str | None = None, backend_dir: Path = BACKEND_DIR) -> DataSafetyLayout:
    if database_url is None:
        # Imported lazily so this module remains safe before app.database creates its engine.
        from app.config import get_settings

        database_url = get_settings().database_url
    return DataSafetyLayout(
        backend_dir=Path(backend_dir).resolve(),
        database_path=_database_path_from_url(database_url),
    )


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _aggregate_hash(files: list[dict[str, Any]]) -> str:
    digest = hashlib.sha256()
    for item in sorted(files, key=lambda value: str(value["path"])):
        digest.update(str(item["path"]).encode("utf-8"))
        digest.update(b"\0")
        digest.update(str(item["sha256"]).encode("ascii"))
        digest.update(b"\0")
        digest.update(str(item["size"]).encode("ascii"))
        digest.update(b"\n")
    return digest.hexdigest()


def _sqlite_report(database_path: Path) -> dict[str, Any]:
    database_path = Path(database_path).resolve()
    if not database_path.is_file():
        raise DataSafetyError("SQLite 数据库不存在，不能检查或备份。")
    try:
        connection = sqlite3.connect(
            f"{database_path.as_uri()}?mode=ro",
            uri=True,
            timeout=30,
        )
        try:
            connection.execute("PRAGMA query_only=ON")
            integrity_rows = [str(row[0]) for row in connection.execute("PRAGMA integrity_check")]
            foreign_key_rows = [list(row) for row in connection.execute("PRAGMA foreign_key_check")]
            user_version = int(connection.execute("PRAGMA user_version").fetchone()[0])
            schema_version = int(connection.execute("PRAGMA schema_version").fetchone()[0])
        finally:
            connection.close()
    except sqlite3.Error as exc:
        raise DataSafetyError(f"SQLite 完整性检查失败: {exc}") from exc
    ok = integrity_rows == ["ok"] and not foreign_key_rows
    return {
        "status": "ok" if ok else "failed",
        "integrity_check": integrity_rows,
        "foreign_key_violations": foreign_key_rows,
        "schema": {
            "user_version": user_version,
            "schema_version": schema_version,
        },
    }


def database_integrity_report(layout: DataSafetyLayout) -> dict[str, Any]:
    report = _sqlite_report(layout.database_path)
    return {**report, "checked_at": _utc_now()}


def _online_backup(source_path: Path, destination_path: Path) -> None:
    destination_path.parent.mkdir(parents=True, exist_ok=True)
    if destination_path.exists():
        destination_path.unlink()
    try:
        source = sqlite3.connect(
            f"{source_path.resolve().as_uri()}?mode=ro",
            uri=True,
            timeout=30,
        )
        destination = sqlite3.connect(str(destination_path), timeout=30)
        try:
            source.execute("PRAGMA query_only=ON")
            source.backup(destination, pages=256, sleep=0.05)
            destination.commit()
        finally:
            destination.close()
            source.close()
    except sqlite3.Error as exc:
        raise DataSafetyError(f"SQLite 在线备份失败: {exc}") from exc


def _safe_asset_files(root: Path) -> list[Path]:
    if not root.exists():
        return []
    if root.is_symlink() or not root.is_dir():
        raise DataSafetyError(f"受管资产目录不是安全的本地目录: {root.name}")
    files: list[Path] = []
    for path in sorted(root.rglob("*"), key=lambda item: item.as_posix()):
        if path.is_symlink():
            raise DataSafetyError(f"备份拒绝跟随资产符号链接: {path.name}")
        if path.is_file():
            files.append(path)
    return files


def _copy_assets(source_root: Path, destination_root: Path) -> None:
    destination_root.mkdir(parents=True, exist_ok=True)
    for source in _safe_asset_files(source_root):
        relative = source.relative_to(source_root)
        destination = destination_root / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, destination)


def _snapshot_files(snapshot_dir: Path) -> list[dict[str, Any]]:
    roots = (
        (snapshot_dir / "database.sqlite3", "database.sqlite3"),
        (snapshot_dir / "uploads", "uploads"),
        (snapshot_dir / "data" / "artifacts", "data/artifacts"),
    )
    items: list[dict[str, Any]] = []
    for path, archive_name in roots:
        if path.is_file():
            items.append(
                {
                    "path": archive_name,
                    "size": path.stat().st_size,
                    "sha256": _sha256_file(path),
                }
            )
            continue
        for item in _safe_asset_files(path):
            relative = item.relative_to(path).as_posix()
            items.append(
                {
                    "path": f"{archive_name}/{relative}",
                    "size": item.stat().st_size,
                    "sha256": _sha256_file(item),
                }
            )
    return sorted(items, key=lambda value: str(value["path"]))


def _write_json_atomic(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{uuid4().hex}.tmp")
    try:
        temporary.write_text(
            json.dumps(payload, ensure_ascii=False, sort_keys=True, indent=2),
            encoding="utf-8",
        )
        os.replace(temporary, path)
    finally:
        if temporary.exists():
            temporary.unlink()


def _archive_path(layout: DataSafetyLayout, backup_id: str) -> Path:
    if not _BACKUP_ID.fullmatch(str(backup_id or "")):
        raise DataSafetyError("backup_id 格式无效。")
    return layout.backup_dir / f"{backup_id}{ARCHIVE_SUFFIX}"


def create_backup(
    layout: DataSafetyLayout,
    *,
    reason: str = "user",
    app_version: str | None = None,
) -> dict[str, Any]:
    """Create an online SQLite snapshot plus managed assets in a verified archive."""

    if reason not in {"user", "pre_restore", "pre_migration"}:
        raise DataSafetyError("不支持的备份原因。")
    with _LOCK:
        source_report = _sqlite_report(layout.database_path)
        if source_report["status"] != "ok":
            raise DataSafetyError("源数据库完整性检查未通过，拒绝创建可恢复备份。")
        layout.backup_dir.mkdir(parents=True, exist_ok=True)
        backup_id = uuid4().hex
        archive_path = _archive_path(layout, backup_id)
        with tempfile.TemporaryDirectory(prefix="snapshot-", dir=layout.root) as directory:
            snapshot_dir = Path(directory)
            database_snapshot = snapshot_dir / "database.sqlite3"
            _online_backup(layout.database_path, database_snapshot)
            snapshot_report = _sqlite_report(database_snapshot)
            if snapshot_report["status"] != "ok":
                raise DataSafetyError("SQLite 在线备份快照完整性检查未通过。")
            _copy_assets(layout.uploads_dir, snapshot_dir / "uploads")
            _copy_assets(layout.artifacts_dir, snapshot_dir / "data" / "artifacts")
            files = _snapshot_files(snapshot_dir)
            manifest = {
                "backup_format": BACKUP_FORMAT,
                "backup_id": backup_id,
                "version": app_version or _application_version(),
                "schema": snapshot_report["schema"],
                "hash": _aggregate_hash(files),
                "created_at": _utc_now(),
                "reason": reason,
                "files": files,
            }
            manifest_path = snapshot_dir / "manifest.json"
            manifest_path.write_text(
                json.dumps(manifest, ensure_ascii=False, sort_keys=True, indent=2),
                encoding="utf-8",
            )
            temporary_archive = archive_path.with_name(f".{archive_path.name}.tmp")
            try:
                with zipfile.ZipFile(
                    temporary_archive,
                    "w",
                    compression=zipfile.ZIP_DEFLATED,
                    compresslevel=6,
                ) as archive:
                    archive.write(manifest_path, "manifest.json")
                    archive.writestr("uploads/", b"")
                    archive.writestr("data/artifacts/", b"")
                    for item in files:
                        archive.write(snapshot_dir / str(item["path"]), str(item["path"]))
                os.replace(temporary_archive, archive_path)
            finally:
                if temporary_archive.exists():
                    temporary_archive.unlink()
        return {
            "backup_id": backup_id,
            "archive_path": str(archive_path),
            "archive_sha256": _sha256_file(archive_path),
            "size_bytes": archive_path.stat().st_size,
            "version": manifest["version"],
            "schema": manifest["schema"],
            "hash": manifest["hash"],
            "created_at": manifest["created_at"],
            "reason": reason,
        }


def _validate_member(info: zipfile.ZipInfo) -> bool:
    name = info.filename
    if not name or "\\" in name or "\x00" in name:
        raise DataSafetyError("备份归档包含非法成员名称。")
    pure = PurePosixPath(name)
    if pure.is_absolute() or ".." in pure.parts or any(":" in part for part in pure.parts):
        raise DataSafetyError("备份归档包含越界路径。")
    mode = info.external_attr >> 16
    if stat.S_ISLNK(mode):
        raise DataSafetyError("备份归档不能包含符号链接。")
    allowed = (
        name == "manifest.json"
        or name == "database.sqlite3"
        or name == "uploads/"
        or name.startswith("uploads/")
        or name == "data/artifacts/"
        or name.startswith("data/artifacts/")
    )
    if not allowed:
        raise DataSafetyError("备份归档包含非 OfferU 受管文件。")
    return info.is_dir()


def _validated_archive(archive_path: Path, *, expected_backup_id: str | None = None) -> tuple[dict[str, Any], list[zipfile.ZipInfo]]:
    if not archive_path.is_file():
        raise DataSafetyError("指定备份不存在。")
    try:
        with zipfile.ZipFile(archive_path, "r") as archive:
            infos = archive.infolist()
            if len(infos) > MAX_ARCHIVE_FILES:
                raise DataSafetyError("备份归档文件数量超过安全上限。")
            if sum(info.file_size for info in infos) > MAX_ARCHIVE_BYTES:
                raise DataSafetyError("备份归档展开大小超过安全上限。")
            names = [info.filename for info in infos]
            if len(names) != len(set(names)):
                raise DataSafetyError("备份归档包含重复成员。")
            for info in infos:
                _validate_member(info)
            if "manifest.json" not in names or "database.sqlite3" not in names:
                raise DataSafetyError("备份归档缺少 manifest 或数据库快照。")
            manifest_info = archive.getinfo("manifest.json")
            if manifest_info.file_size > 1024 * 1024:
                raise DataSafetyError("备份 manifest 超过安全上限。")
            manifest = json.loads(archive.read("manifest.json").decode("utf-8"))
    except (OSError, ValueError, UnicodeDecodeError, zipfile.BadZipFile, json.JSONDecodeError) as exc:
        raise DataSafetyError("备份归档无法安全读取。") from exc
    if not isinstance(manifest, dict) or manifest.get("backup_format") != BACKUP_FORMAT:
        raise DataSafetyError("备份 manifest 版本不受支持。")
    backup_id = str(manifest.get("backup_id") or "")
    if not _BACKUP_ID.fullmatch(backup_id):
        raise DataSafetyError("备份 manifest 的 backup_id 无效。")
    if expected_backup_id is not None and backup_id != expected_backup_id:
        raise DataSafetyError("备份 ID 与 manifest 不匹配。")
    if not isinstance(manifest.get("version"), str) or not manifest["version"]:
        raise DataSafetyError("备份 manifest 缺少应用版本。")
    schema = manifest.get("schema")
    if not isinstance(schema, dict) or not all(isinstance(schema.get(key), int) for key in ("user_version", "schema_version")):
        raise DataSafetyError("备份 manifest 的 schema 无效。")
    raw_files = manifest.get("files")
    if not isinstance(raw_files, list) or not raw_files:
        raise DataSafetyError("备份 manifest 缺少文件哈希。")
    expected_names: set[str] = set()
    for item in raw_files:
        if not isinstance(item, dict):
            raise DataSafetyError("备份 manifest 文件记录无效。")
        name = str(item.get("path") or "")
        if name in expected_names or name == "manifest.json":
            raise DataSafetyError("备份 manifest 包含重复文件。")
        synthetic = zipfile.ZipInfo(name)
        if _validate_member(synthetic):
            raise DataSafetyError("备份 manifest 不能把目录登记为文件。")
        if not isinstance(item.get("size"), int) or item["size"] < 0:
            raise DataSafetyError("备份 manifest 文件大小无效。")
        digest = str(item.get("sha256") or "")
        if not re.fullmatch(r"[a-f0-9]{64}", digest):
            raise DataSafetyError("备份 manifest 文件哈希无效。")
        expected_names.add(name)
    archive_files = {info.filename for info in infos if not info.is_dir() and info.filename != "manifest.json"}
    if archive_files != expected_names:
        raise DataSafetyError("备份归档成员与 manifest 不一致。")
    if str(manifest.get("hash") or "") != _aggregate_hash(raw_files):
        raise DataSafetyError("备份 manifest 聚合哈希无效。")
    return manifest, infos


def _validate_snapshot(snapshot_dir: Path, manifest: dict[str, Any]) -> None:
    files = _snapshot_files(snapshot_dir)
    if files != manifest["files"] or _aggregate_hash(files) != manifest["hash"]:
        raise DataSafetyError("恢复暂存内容与 manifest 哈希不一致。")
    report = _sqlite_report(snapshot_dir / "database.sqlite3")
    if report["status"] != "ok" or report["schema"] != manifest["schema"]:
        raise DataSafetyError("恢复数据库完整性或 schema 校验未通过。")


def _materialize_archive(archive_path: Path, destination: Path, *, expected_backup_id: str) -> dict[str, Any]:
    manifest, _ = _validated_archive(archive_path, expected_backup_id=expected_backup_id)
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = Path(tempfile.mkdtemp(prefix=f".{expected_backup_id}-", dir=destination.parent))
    try:
        (temporary / "uploads").mkdir(parents=True)
        (temporary / "data" / "artifacts").mkdir(parents=True)
        with zipfile.ZipFile(archive_path, "r") as archive:
            records = {str(item["path"]): item for item in manifest["files"]}
            for name, record in records.items():
                target = temporary.joinpath(*PurePosixPath(name).parts)
                target.parent.mkdir(parents=True, exist_ok=True)
                digest = hashlib.sha256()
                size = 0
                with archive.open(name, "r") as source, target.open("xb") as output:
                    while chunk := source.read(1024 * 1024):
                        size += len(chunk)
                        digest.update(chunk)
                        output.write(chunk)
                if size != record["size"] or digest.hexdigest() != record["sha256"]:
                    raise DataSafetyError("备份文件哈希校验失败。")
        _validate_snapshot(temporary, manifest)
        if destination.exists():
            _remove_path(destination)
        os.replace(temporary, destination)
    except Exception:
        if temporary.exists():
            shutil.rmtree(temporary, ignore_errors=True)
        raise
    return manifest


def stage_restore(layout: DataSafetyLayout, *, backup_id: str) -> dict[str, Any]:
    """Validate and stage a managed backup; never replace the live database."""

    with _LOCK:
        archive_path = _archive_path(layout, backup_id)
        archive_hash = _sha256_file(archive_path) if archive_path.is_file() else ""
        pending = _read_pending(layout)
        if pending is not None:
            pending_id = str(pending["backup_id"])
            if pending_id != backup_id:
                raise DataSafetyError("已有待重启恢复任务，请先取消后再选择其他备份。")
            if archive_hash != pending["archive_sha256"]:
                raise DataSafetyError("待恢复归档已变化，请取消本次恢复并重新选择备份。")
            manifest, _ = _validated_archive(archive_path, expected_backup_id=backup_id)
            stage_dir = layout.restore_dir / backup_id
            if not stage_dir.is_dir():
                raise DataSafetyError("待恢复暂存目录不存在，请取消本次恢复并重新选择备份。")
            _validate_snapshot(stage_dir, manifest)
            return {
                "backup_id": backup_id,
                "version": manifest["version"],
                "schema": manifest["schema"],
                "hash": manifest["hash"],
                "staged_at": pending["staged_at"],
                "pending_restart": True,
                "database_replaced": False,
            }
        stage_dir = layout.restore_dir / backup_id
        manifest = _materialize_archive(
            archive_path,
            stage_dir,
            expected_backup_id=backup_id,
        )
        marker = {
            "pending_format": PENDING_RESTORE_FORMAT,
            "backup_id": backup_id,
            "archive_sha256": archive_hash,
            "staged_at": _utc_now(),
        }
        _write_json_atomic(layout.pending_file, marker)
        return {
            "backup_id": backup_id,
            "version": manifest["version"],
            "schema": manifest["schema"],
            "hash": manifest["hash"],
            "staged_at": marker["staged_at"],
            "pending_restart": True,
            "database_replaced": False,
        }


def _read_pending(layout: DataSafetyLayout) -> dict[str, Any] | None:
    if not layout.pending_file.exists():
        return None
    try:
        marker = json.loads(layout.pending_file.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise DataSafetyError("pending restore 标记损坏；为保护原数据库，启动已停止。") from exc
    if not isinstance(marker, dict) or marker.get("pending_format") != PENDING_RESTORE_FORMAT:
        raise DataSafetyError("pending restore 标记版本无效；为保护原数据库，启动已停止。")
    backup_id = str(marker.get("backup_id") or "")
    archive_hash = str(marker.get("archive_sha256") or "")
    if not _BACKUP_ID.fullmatch(backup_id) or not re.fullmatch(r"[a-f0-9]{64}", archive_hash):
        raise DataSafetyError("pending restore 标记内容无效；为保护原数据库，启动已停止。")
    return marker


def _remove_path(path: Path) -> None:
    if not path.exists() and not path.is_symlink():
        return
    if path.is_dir() and not path.is_symlink():
        shutil.rmtree(path)
    else:
        path.unlink()


def _verify_installed_state(layout: DataSafetyLayout, manifest: dict[str, Any]) -> None:
    report = _sqlite_report(layout.database_path)
    if report["status"] != "ok" or report["schema"] != manifest["schema"]:
        raise DataSafetyError("替换后的数据库完整性或 schema 校验未通过。")
    installed: list[dict[str, Any]] = [
        {
            "path": "database.sqlite3",
            "size": layout.database_path.stat().st_size,
            "sha256": _sha256_file(layout.database_path),
        }
    ]
    for root, prefix in ((layout.uploads_dir, "uploads"), (layout.artifacts_dir, "data/artifacts")):
        for path in _safe_asset_files(root):
            installed.append(
                {
                    "path": f"{prefix}/{path.relative_to(root).as_posix()}",
                    "size": path.stat().st_size,
                    "sha256": _sha256_file(path),
                }
            )
    installed.sort(key=lambda value: str(value["path"]))
    if installed != manifest["files"] or _aggregate_hash(installed) != manifest["hash"]:
        raise DataSafetyError("替换后的受管资产哈希校验未通过。")


def _install_snapshot(layout: DataSafetyLayout, snapshot_dir: Path, manifest: dict[str, Any]) -> None:
    token = uuid4().hex
    targets = (
        (snapshot_dir / "database.sqlite3", layout.database_path, False),
        (snapshot_dir / "uploads", layout.uploads_dir, True),
        (snapshot_dir / "data" / "artifacts", layout.artifacts_dir, True),
    )
    prepared: list[tuple[Path, Path, Path, bool, bool]] = []
    moved_sidecars: list[tuple[Path, Path]] = []
    try:
        for source, target, is_directory in targets:
            target.parent.mkdir(parents=True, exist_ok=True)
            if target.is_symlink():
                raise DataSafetyError("恢复拒绝替换符号链接形式的受管路径。")
            temporary = target.parent / f".{target.name}.offeru-restore-{token}"
            rollback = target.parent / f".{target.name}.offeru-rollback-{token}"
            if is_directory:
                shutil.copytree(source, temporary)
            else:
                shutil.copy2(source, temporary)
            prepared.append((temporary, target, rollback, is_directory, target.exists()))
        for suffix in ("-wal", "-shm"):
            sidecar = Path(f"{layout.database_path}{suffix}")
            if sidecar.exists():
                rollback = sidecar.parent / f".{sidecar.name}.offeru-rollback-{token}"
                os.replace(sidecar, rollback)
                moved_sidecars.append((sidecar, rollback))
        installed: list[tuple[Path, Path, bool]] = []
        moved_old: list[tuple[Path, Path]] = []
        try:
            for temporary, target, rollback, _, existed in prepared:
                if existed:
                    os.replace(target, rollback)
                    moved_old.append((target, rollback))
                os.replace(temporary, target)
                installed.append((target, rollback, existed))
            _verify_installed_state(layout, manifest)
        except Exception as install_error:
            rollback_error: Exception | None = None
            try:
                for target, _, _ in reversed(installed):
                    _remove_path(target)
                for target, rollback in reversed(moved_old):
                    if rollback.exists():
                        os.replace(rollback, target)
                for sidecar, rollback in reversed(moved_sidecars):
                    if rollback.exists():
                        os.replace(rollback, sidecar)
            except Exception as exc:
                rollback_error = exc
            if rollback_error is not None:
                raise DataSafetyError(
                    "恢复替换失败，自动回滚也失败；pre-restore 备份已保留，启动已停止。"
                ) from rollback_error
            raise DataSafetyError("恢复替换失败，原数据已自动回滚，启动已停止。") from install_error
        for _, rollback in moved_old:
            _remove_path(rollback)
        for _, rollback in moved_sidecars:
            _remove_path(rollback)
    finally:
        for temporary, _, rollback, _, _ in prepared:
            _remove_path(temporary)
            _remove_path(rollback)


def restore_backup_snapshot(layout: DataSafetyLayout, *, backup_id: str) -> dict[str, Any]:
    """Restore a verified managed snapshot for an internal startup rollback."""

    with _LOCK:
        archive_path = _archive_path(layout, backup_id)
        stage_dir = layout.restore_dir / backup_id
        manifest = _materialize_archive(
            archive_path,
            stage_dir,
            expected_backup_id=backup_id,
        )
        try:
            _install_snapshot(layout, stage_dir, manifest)
        finally:
            _remove_path(stage_dir)
        return {
            "backup_id": backup_id,
            "schema": manifest["schema"],
            "hash": manifest["hash"],
            "integrity_check": "ok",
        }


def apply_pending_restore_before_database_connect(
    *,
    database_url: str | None = None,
    backend_dir: Path = BACKEND_DIR,
) -> dict[str, Any]:
    """Apply a validated pending restore before app.database is imported.

    Failure is deliberately raised to the process entrypoint. The pending marker,
    staged snapshot, original data (or its pre-restore archive) remain recoverable.
    """

    layout = _runtime_layout(database_url=database_url, backend_dir=backend_dir)
    with _LOCK:
        marker = _read_pending(layout)
        if marker is None:
            return {"applied": False, "reason": "no_pending_restore"}
        backup_id = str(marker["backup_id"])
        archive_path = _archive_path(layout, backup_id)
        if not archive_path.is_file() or _sha256_file(archive_path) != marker["archive_sha256"]:
            raise DataSafetyError("待恢复归档已变化；为保护原数据库，启动已停止。")
        stage_dir = layout.restore_dir / backup_id
        manifest, _ = _validated_archive(archive_path, expected_backup_id=backup_id)
        if not stage_dir.is_dir():
            raise DataSafetyError("待恢复暂存目录不存在；为保护原数据库，启动已停止。")
        _validate_snapshot(stage_dir, manifest)
        pre_restore = create_backup(layout, reason="pre_restore")
        _install_snapshot(layout, stage_dir, manifest)
        layout.pending_file.unlink()
        shutil.rmtree(stage_dir, ignore_errors=True)
        return {
            "applied": True,
            "backup_id": backup_id,
            "pre_restore_backup_id": pre_restore["backup_id"],
            "integrity_check": "ok",
        }


def list_backups(layout: DataSafetyLayout) -> dict[str, Any]:
    with _LOCK:
        if not layout.backup_dir.exists():
            return {"items": [], "invalid": []}
        items: list[dict[str, Any]] = []
        invalid: list[dict[str, str]] = []
        for archive_path in sorted(layout.backup_dir.glob(f"*{ARCHIVE_SUFFIX}")):
            backup_id = archive_path.name.removesuffix(ARCHIVE_SUFFIX)
            try:
                manifest, _ = _validated_archive(archive_path, expected_backup_id=backup_id)
                items.append(
                    {
                        "backup_id": backup_id,
                        "version": manifest["version"],
                        "schema": manifest["schema"],
                        "hash": manifest["hash"],
                        "created_at": manifest["created_at"],
                        "reason": manifest.get("reason", "user"),
                        "size_bytes": archive_path.stat().st_size,
                    }
                )
            except DataSafetyError as exc:
                invalid.append({"backup_id": backup_id, "error": str(exc)})
        items.sort(key=lambda item: str(item["created_at"]), reverse=True)
        return {"items": items, "invalid": invalid}


def data_safety_status(layout: DataSafetyLayout) -> dict[str, Any]:
    with _LOCK:
        pending = _read_pending(layout)
        backups = list_backups(layout)
        return {
            "database": {
                "exists": layout.database_path.is_file(),
                "filename": layout.database_path.name,
            },
            "backup_count": len(backups["items"]),
            "invalid_backup_count": len(backups["invalid"]),
            "pending_restore": (
                {
                    "backup_id": pending["backup_id"],
                    "staged_at": pending["staged_at"],
                    "pending_restart": True,
                }
                if pending is not None
                else None
            ),
            "storage_mode": "managed_local",
        }


def cancel_pending_restore(layout: DataSafetyLayout) -> dict[str, Any]:
    """Cancel only staged restore state; the backup archive remains untouched."""

    with _LOCK:
        try:
            pending = _read_pending(layout)
        except DataSafetyError:
            quarantine_dir = layout.root / "cancelled_restore_markers"
            quarantine_dir.mkdir(parents=True, exist_ok=True)
            quarantine = quarantine_dir / f"invalid-{uuid4().hex}.json"
            os.replace(layout.pending_file, quarantine)
            return {
                "cancelled": True,
                "invalid_marker_quarantined": True,
                "staging_preserved": True,
                "backup_preserved": True,
            }
        if pending is None:
            return {"cancelled": False, "reason": "no_pending_restore"}
        backup_id = str(pending["backup_id"])
        _remove_path(layout.restore_dir / backup_id)
        layout.pending_file.unlink(missing_ok=True)
        return {
            "cancelled": True,
            "backup_id": backup_id,
            "backup_preserved": True,
        }


async def check_database_integrity() -> dict[str, Any]:
    return await asyncio.to_thread(database_integrity_report, _runtime_layout())


async def get_data_safety_status() -> dict[str, Any]:
    return await asyncio.to_thread(data_safety_status, _runtime_layout())


async def create_data_backup() -> dict[str, Any]:
    result = await asyncio.to_thread(create_backup, _runtime_layout())
    return {key: value for key, value in result.items() if key != "archive_path"}


async def list_data_backups() -> dict[str, Any]:
    return await asyncio.to_thread(list_backups, _runtime_layout())


async def stage_data_restore(*, backup_id: str, user_confirmed: bool) -> dict[str, Any]:
    if user_confirmed is not True:
        raise DataSafetyError("恢复暂存必须由使用者明确确认。")
    return await asyncio.to_thread(stage_restore, _runtime_layout(), backup_id=backup_id)


async def cancel_data_restore(*, user_confirmed: bool) -> dict[str, Any]:
    if user_confirmed is not True:
        raise DataSafetyError("取消待恢复任务必须由使用者明确确认。")
    return await asyncio.to_thread(cancel_pending_restore, _runtime_layout())
