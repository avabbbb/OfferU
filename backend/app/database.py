# =============================================
# OfferU - 数据库引擎
# =============================================
# 异步 SQLAlchemy 引擎配置
# 支持 SQLite（开发）和 PostgreSQL（生产）
# =============================================

import asyncio
from pathlib import Path
import sqlite3
from typing import Any, Callable

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy import MetaData, event
from sqlalchemy.orm import DeclarativeBase

from app.config import get_settings
from app.runtime_paths import runtime_backend_dir
from app.services.security_redaction import safe_error_message

settings = get_settings()

CURRENT_SCHEMA_VERSION = 8
LEGACY_TEMPLATE_TABLES = ("html_resumes", "html_resume_templates", "resume_templates")


class DatabaseMigrationError(RuntimeError):
    """Fail-closed error for an unsupported or failed schema migration."""

# 创建异步数据库引擎
# echo=False 关闭 SQL 日志；生产环境 database_url 应为 postgresql+asyncpg://...
# 开发环境默认使用 sqlite+aiosqlite:///./djm.db
engine = create_async_engine(settings.database_url, echo=False)


if engine.dialect.name == "sqlite":
    # SQLite 默认关闭外键约束：所有 ondelete=CASCADE/SET NULL 从不生效，
    # 删除岗位/池后遗留孤儿行（job_research_runs、applications 等）。
    # 每个连接建立时显式开启；PostgreSQL/MySQL 天然启用，无需处理。
    @event.listens_for(engine.sync_engine, "connect")
    def _enable_sqlite_foreign_keys(dbapi_connection, connection_record):  # noqa: ANN001
        cursor = dbapi_connection.cursor()
        cursor.execute("PRAGMA foreign_keys=ON")
        cursor.close()

# expire_on_commit=False：commit 后 ORM 对象属性不失效，
# 避免异步上下文中意外触发延迟加载（async session 不允许隐式 IO）
async_session = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)


class Base(DeclarativeBase):
    """所有 ORM 模型的基类"""
    pass


async def get_db():
    """FastAPI 依赖注入：提供数据库会话"""
    async with async_session() as session:
        yield session


async def init_db(*, backend_dir: Path | None = None):
    """Create the schema and apply versioned SQLite migrations safely."""

    # Keep schema creation independent from route import order.  The runtime
    # entrypoint normally imports these modules as a side effect of registering
    # routers, but recovery/doctor/e2e callers may invoke init_db directly.
    from app.models import models as _models  # noqa: F401

    migration = await prepare_schema_migration(
        database_url=settings.database_url,
        backend_dir=backend_dir,
    )
    try:
        if migration.get("required") and migration["from_version"] < 8:
            await asyncio.to_thread(
                drop_legacy_template_schema, _sqlite_path_for_url(settings.database_url)
            )
        async with engine.begin() as conn:
            if engine.dialect.name == "sqlite":
                await conn.run_sync(_preserve_prototype_decision_history)
            await conn.run_sync(Base.metadata.create_all)
            if engine.dialect.name == "sqlite":
                await conn.run_sync(run_schema_migrations)
            else:
                await conn.run_sync(_auto_migrate)
    except Exception as exc:
        if migration.get("required"):
            backup_id = migration.get("backup_id") or "unknown"
            rollback_error: Exception | None = None
            try:
                await engine.dispose()
                from app.services.data_safety import _runtime_layout, restore_backup_snapshot

                await asyncio.to_thread(
                    restore_backup_snapshot,
                    _runtime_layout(
                        database_url=settings.database_url,
                        backend_dir=backend_dir or runtime_backend_dir(),
                    ),
                    backup_id=backup_id,
                )
            except Exception as rollback_exc:
                rollback_error = rollback_exc
            if rollback_error is not None:
                raise DatabaseMigrationError(
                    f"数据库迁移 {migration['from_version']}→{migration['target_version']} 失败；"
                    f"迁移前备份 {backup_id} 保留，但自动回滚失败，启动已停止。"
                ) from rollback_error
            raise DatabaseMigrationError(
                f"数据库迁移 {migration['from_version']}→{migration['target_version']} 失败；"
                f"已从迁移前备份 {backup_id} 恢复，启动已停止。"
            ) from exc
        raise
    await seed_system_batches()


def _auto_migrate(connection):
    """对比模型定义与实际表结构，用 ALTER TABLE ADD COLUMN 补全缺失列"""
    import json
    from sqlalchemy import inspect as sa_inspect, text
    inspector = sa_inspect(connection)
    for table in Base.metadata.sorted_tables:
        if not inspector.has_table(table.name):
            continue
        existing_cols = {c["name"] for c in inspector.get_columns(table.name)}
        for col in table.columns:
            if col.name not in existing_cols:
                col_type = col.type.compile(connection.dialect)
                col_type_upper = col_type.upper()
                default_clause = ""
                if col.default is not None:
                    val = col.default.arg
                    if callable(val):
                        try:
                            val = val()
                        except Exception:
                            val = None
                    if isinstance(val, str):
                        escaped = val.replace("'", "''")
                        default_clause = f" DEFAULT '{escaped}'"
                    elif isinstance(val, bool):
                        default_clause = f" DEFAULT {1 if val else 0}"
                    elif isinstance(val, (int, float)):
                        default_clause = f" DEFAULT {val}"
                    elif isinstance(val, (list, dict)):
                        default_clause = f" DEFAULT '{json.dumps(val, ensure_ascii=False)}'"
                nullable = "" if col.nullable else " NOT NULL"
                if nullable and not default_clause:
                    if "CHAR" in col_type_upper or "TEXT" in col_type_upper:
                        default_clause = " DEFAULT ''"
                    elif "JSON" in col_type_upper:
                        default_clause = " DEFAULT '{}'"
                    else:
                        default_clause = " DEFAULT 0"
                ddl = f'ALTER TABLE "{table.name}" ADD COLUMN "{col.name}" {col_type}{nullable}{default_clause}'
                connection.execute(text(ddl))
    if inspector.has_table("operation_audit_logs"):
        connection.execute(
            text(
                'CREATE UNIQUE INDEX IF NOT EXISTS "ux_operation_audit_idempotency_key" '
                'ON "operation_audit_logs" ("idempotency_key")'
            )
        )
    if inspector.has_table("application_stage_events"):
        connection.execute(
            text(
                'CREATE UNIQUE INDEX IF NOT EXISTS "ux_application_stage_events_signal_id" '
                'ON "application_stage_events" ("signal_id")'
            )
        )


def _sqlite_path_for_url(database_url: str) -> Path | None:
    """Return a file-backed SQLite path; external databases are out of scope."""

    from sqlalchemy.engine import make_url

    url = make_url(database_url)
    if not url.drivername.startswith("sqlite") or not url.database or url.database == ":memory:":
        return None
    path = Path(url.database)
    if not path.is_absolute():
        path = Path.cwd() / path
    return path.resolve()


def _read_sqlite_user_version(database_path: Path) -> int:
    try:
        connection = sqlite3.connect(str(database_path), timeout=30)
        try:
            return int(connection.execute("PRAGMA user_version").fetchone()[0])
        finally:
            connection.close()
    except sqlite3.Error as exc:
        raise DatabaseMigrationError(f"无法读取 SQLite schema version: {exc}") from exc


def schema_migration_status(database_url: str | None = None) -> dict[str, Any]:
    """Return a read-only version status for Doctor and release diagnostics."""

    url = database_url or settings.database_url
    database_path = _sqlite_path_for_url(url)
    if database_path is None:
        return {
            "status": "not_applicable",
            "database_exists": False,
            "current_version": None,
            "target_version": CURRENT_SCHEMA_VERSION,
            "migration_required": False,
        }
    if not database_path.is_file():
        return {
            "status": "ready",
            "database_exists": False,
            "current_version": 0,
            "target_version": CURRENT_SCHEMA_VERSION,
            "migration_required": False,
        }
    try:
        current_version = _read_sqlite_user_version(database_path)
    except DatabaseMigrationError as exc:
        return {
            "status": "failed",
            "database_exists": True,
            "current_version": None,
            "target_version": CURRENT_SCHEMA_VERSION,
            "migration_required": True,
            "error": safe_error_message(exc),
        }
    if current_version > CURRENT_SCHEMA_VERSION:
        status = "failed"
    elif current_version < CURRENT_SCHEMA_VERSION:
        status = "pending"
    else:
        status = "ready"
    return {
        "status": status,
        "database_exists": True,
        "current_version": current_version,
        "target_version": CURRENT_SCHEMA_VERSION,
        "migration_required": current_version < CURRENT_SCHEMA_VERSION,
    }


async def prepare_schema_migration(
    database_url: str | None = None,
    *,
    backend_dir: Path | None = None,
) -> dict[str, Any]:
    """Create a verified pre-migration backup before opening the ORM engine."""

    url = database_url or settings.database_url
    database_path = _sqlite_path_for_url(url)
    if database_path is None or not database_path.is_file():
        return {
            "required": False,
            "from_version": 0,
            "target_version": CURRENT_SCHEMA_VERSION,
        }
    current_version = _read_sqlite_user_version(database_path)
    if current_version > CURRENT_SCHEMA_VERSION:
        raise DatabaseMigrationError(
            f"SQLite schema version {current_version} 高于当前支持的 {CURRENT_SCHEMA_VERSION}。"
        )
    if current_version == CURRENT_SCHEMA_VERSION:
        return {
            "required": False,
            "from_version": current_version,
            "target_version": CURRENT_SCHEMA_VERSION,
        }

    from app.services.data_safety import _runtime_layout, create_backup

    backup = await asyncio.to_thread(
        create_backup,
        _runtime_layout(
            database_url=url,
            backend_dir=backend_dir or runtime_backend_dir(),
        ),
        reason="pre_migration",
    )
    return {
        "required": True,
        "from_version": current_version,
        "target_version": CURRENT_SCHEMA_VERSION,
        "backup_id": backup["backup_id"],
    }


def _schema_smoke_check(connection) -> None:  # noqa: ANN001
    """Verify the migrated schema before its version marker is committed."""

    integrity_rows = [str(row[0]) for row in connection.exec_driver_sql("PRAGMA integrity_check")]
    if integrity_rows != ["ok"]:
        raise DatabaseMigrationError(
            f"迁移后的 SQLite integrity_check 未通过: {integrity_rows}"
        )
    foreign_key_rows = list(connection.exec_driver_sql("PRAGMA foreign_key_check"))
    if foreign_key_rows:
        raise DatabaseMigrationError(
            f"迁移后的 SQLite foreign_key_check 未通过: {foreign_key_rows[:5]}"
        )
    from sqlalchemy import inspect as sa_inspect

    inspector = sa_inspect(connection)
    missing = [
        table.name
        for table in Base.metadata.sorted_tables
        if not inspector.has_table(table.name)
    ]
    if missing:
        raise DatabaseMigrationError(f"迁移后的 schema 缺少表: {missing[:10]}")


def _migrate_schema_v1(connection) -> None:  # noqa: ANN001
    """Baseline the existing create-all schema and its idempotency index."""

    _auto_migrate(connection)


def _migrate_schema_v2(connection) -> None:  # noqa: ANN001
    """Normalize the historical triage values as a transactional migration."""

    from sqlalchemy import text

    connection.execute(
        text("UPDATE jobs SET triage_status = 'picked' WHERE triage_status = 'screened'")
    )
    connection.execute(
        text("UPDATE jobs SET triage_status = 'inbox' WHERE triage_status = 'unscreened'")
    )
    connection.execute(
        text("UPDATE pools SET scope = 'picked' WHERE scope = 'screened'")
    )
    connection.execute(
        text("UPDATE pools SET scope = 'inbox' WHERE scope = 'unscreened'")
    )


def _migrate_schema_v3(connection) -> None:  # noqa: ANN001
    """Add the signal_id uniqueness guard on application_stage_events."""

    from sqlalchemy import text

    connection.execute(
        text(
            'CREATE UNIQUE INDEX IF NOT EXISTS "ux_application_stage_events_signal_id" '
            'ON "application_stage_events" ("signal_id")'
        )
    )


def _migrate_schema_v4(connection) -> None:  # noqa: ANN001
    """Add interview_notifications.acknowledged_at via additive auto-migration."""

    _auto_migrate(connection)


def _migrate_schema_v5(connection) -> None:  # noqa: ANN001
    """Allow resume_optimization_proposals.research_run_id to be NULL.

    Career Director proposals are built from the verified Profile and the job
    JD only; they legitimately have no research run.  SQLite cannot relax a
    NOT NULL constraint in place, so the table is rebuilt transactionally.
    """

    from sqlalchemy import inspect as sa_inspect, text
    from sqlalchemy.schema import CreateIndex, CreateTable

    inspector = sa_inspect(connection)
    if not inspector.has_table("resume_optimization_proposals"):
        return
    columns = {
        column["name"]: column
        for column in inspector.get_columns("resume_optimization_proposals")
    }
    if columns.get("research_run_id", {}).get("nullable"):
        return

    source = Base.metadata.tables["resume_optimization_proposals"]
    clone_metadata = MetaData()
    for foreign_key in source.foreign_keys:
        referred_table = foreign_key.column.table
        if referred_table.key not in clone_metadata.tables:
            referred_table.to_metadata(clone_metadata)
    rebuilt = source.to_metadata(clone_metadata, name="resume_optimization_proposals_v5")
    connection.execute(text(str(CreateTable(rebuilt).compile(connection)).strip()))
    column_names = ", ".join(f'"{column.name}"' for column in source.columns)
    connection.execute(
        text(
            f'INSERT INTO "resume_optimization_proposals_v5" ({column_names}) '
            f'SELECT {column_names} FROM "resume_optimization_proposals"'
        )
    )
    connection.execute(text('DROP TABLE "resume_optimization_proposals"'))
    connection.execute(
        text(
            'ALTER TABLE "resume_optimization_proposals_v5" '
            'RENAME TO "resume_optimization_proposals"'
        )
    )
    for index in source.indexes:
        connection.execute(
            text(str(CreateIndex(index, if_not_exists=True).compile(connection)).strip())
        )


def _migrate_schema_v6(connection) -> None:  # noqa: ANN001
    """Proposal v2 was removed; old tables, if present, are left untouched."""

    del connection


def _preserve_prototype_decision_history(connection) -> None:
    """Preserve the incompatible prototype v6 table; never import its grants."""
    from sqlalchemy import inspect, text

    inspector = inspect(connection)
    if not inspector.has_table("proposal_plans"):
        return
    columns = {column["name"] for column in inspector.get_columns("proposal_plans")}
    if "id" in columns and "snapshot_json" in columns:
        return
    if not {"plan_id", "immutable_json"}.issubset(columns):
        raise DatabaseMigrationError("proposal_plans 的旧列结构无法识别，未覆盖历史数据。")
    if inspector.has_table("legacy_decision_proposal_plans"):
        raise DatabaseMigrationError("旧计划归档表已存在，未覆盖任一版本的数据。")
    connection.execute(text('ALTER TABLE "proposal_plans" RENAME TO "legacy_decision_proposal_plans"'))


def _migrate_schema_v7(connection) -> None:
    _preserve_prototype_decision_history(connection)
    _migrate_schema_v6(connection)


def drop_legacy_template_schema(database_path: Path | None) -> None:
    """v8: drop resumes.template_id and the removed template tables.

    resumes is referenced by many ON DELETE CASCADE children, and SQLite's
    DROP TABLE runs an implicit DELETE that would cascade into them.  The
    rebuild therefore uses its own connection with foreign_keys=OFF (the
    pragma is a no-op inside the ORM transaction), per SQLite's documented
    12-step ALTER TABLE procedure.
    """

    if database_path is None or not database_path.is_file():
        return
    from sqlalchemy.dialects import sqlite as sqlite_dialect
    from sqlalchemy.schema import CreateIndex, CreateTable

    from app.models import models as _models  # noqa: F401

    conn = sqlite3.connect(database_path, isolation_level=None)
    try:
        conn.execute("PRAGMA foreign_keys=OFF")
        conn.execute("BEGIN IMMEDIATE")
        columns = [row[1] for row in conn.execute('PRAGMA table_info("resumes")')]
        if "template_id" in columns:
            dialect = sqlite_dialect.dialect()
            source = Base.metadata.tables["resumes"]
            clone_metadata = MetaData()
            for foreign_key in source.foreign_keys:
                referred = foreign_key.column.table
                if referred.key not in clone_metadata.tables:
                    referred.to_metadata(clone_metadata)
            rebuilt = source.to_metadata(clone_metadata, name="resumes_v8")
            conn.execute(str(CreateTable(rebuilt).compile(dialect=dialect)))
            shared = ", ".join(f'"{c.name}"' for c in source.columns if c.name in columns)
            conn.execute(f'INSERT INTO "resumes_v8" ({shared}) SELECT {shared} FROM "resumes"')
            conn.execute('DROP TABLE "resumes"')
            conn.execute('ALTER TABLE "resumes_v8" RENAME TO "resumes"')
            for index in source.indexes:
                conn.execute(str(CreateIndex(index, if_not_exists=True).compile(dialect=dialect)))
        for table in LEGACY_TEMPLATE_TABLES:
            conn.execute(f'DROP TABLE IF EXISTS "{table}"')
        broken = conn.execute("PRAGMA foreign_key_check").fetchall()
        if broken:
            raise DatabaseMigrationError(f"v8 迁移后外键检查未通过: {broken[:5]}")
        conn.execute("COMMIT")
    except BaseException:
        if conn.in_transaction:
            conn.execute("ROLLBACK")
        raise
    finally:
        conn.close()


def _migrate_schema_v8(connection) -> None:  # noqa: ANN001
    """Done by drop_legacy_template_schema before the ORM transaction."""

    del connection


SCHEMA_MIGRATIONS: dict[int, Callable[[Any], None]] = {
    1: _migrate_schema_v1,
    2: _migrate_schema_v2,
    3: _migrate_schema_v3,
    4: _migrate_schema_v4,
    5: _migrate_schema_v5,
    6: _migrate_schema_v6,
    7: _migrate_schema_v7,
    8: _migrate_schema_v8,
}


def run_schema_migrations(connection) -> dict[str, int]:  # noqa: ANN001
    """Apply each missing SQLite migration in the caller's transaction."""

    from sqlalchemy import text

    current_version = int(connection.execute(text("PRAGMA user_version")).scalar_one())
    if current_version > CURRENT_SCHEMA_VERSION:
        raise DatabaseMigrationError(
            f"SQLite schema version {current_version} 高于当前支持的 {CURRENT_SCHEMA_VERSION}。"
        )
    for version in range(current_version + 1, CURRENT_SCHEMA_VERSION + 1):
        migration = SCHEMA_MIGRATIONS.get(version)
        if migration is None:
            raise DatabaseMigrationError(f"缺少 schema migration v{version}。")
        try:
            migration(connection)
        except DatabaseMigrationError:
            raise
        except Exception as exc:
            raise DatabaseMigrationError(f"schema migration v{version} 执行失败。") from exc
        _schema_smoke_check(connection)
        connection.execute(text(f"PRAGMA user_version = {version}"))
    _schema_smoke_check(connection)
    return {
        "from_version": current_version,
        "to_version": CURRENT_SCHEMA_VERSION,
    }


async def seed_system_batches():
    """确保历史数据的默认批次存在，便于 Inbox 按批次分区展示"""
    from app.models.models import Batch
    from sqlalchemy import select

    async with async_session() as session:
        existing = (
            await session.execute(select(Batch).where(Batch.id == "legacy-import"))
        ).scalar_one_or_none()
        if not existing:
            session.add(
                Batch(
                    id="legacy-import",
                    source="legacy",
                    keywords=["historical"],
                    location="",
                    total_fetched=0,
                )
            )
            await session.commit()
