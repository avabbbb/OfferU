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
from sqlalchemy import event
from sqlalchemy.orm import DeclarativeBase

from app.config import get_settings

settings = get_settings()

CURRENT_SCHEMA_VERSION = 2


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

    migration = await prepare_schema_migration(
        database_url=settings.database_url,
        backend_dir=backend_dir,
    )
    try:
        async with engine.begin() as conn:
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
                        backend_dir=backend_dir or Path(__file__).resolve().parents[1],
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
    await seed_templates()
    # HTML 简历工作室（studio 路由）使用的 HtmlResumeTemplate 种子；
    # 此前从未被调用，模板表恒空导致 studio 页面无模板可选。
    from app.services.template_seeder import seed_templates as seed_html_templates

    async with async_session() as session:
        await seed_html_templates(session)
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
                        default_clause = f" DEFAULT '{val}'"
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
                        default_clause = " DEFAULT '[]'"
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
            "error": str(exc),
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
            backend_dir=backend_dir or Path(__file__).resolve().parents[1],
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


SCHEMA_MIGRATIONS: dict[int, Callable[[Any], None]] = {
    1: _migrate_schema_v1,
    2: _migrate_schema_v2,
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


# =============================================
# 内置模板种子数据
# =============================================
# 首次启动时自动插入 4 套内置模板，
# 每套模板包含主题配色、字号/间距 CSS 变量。
# 通过检查 is_builtin + name 去重，避免重复插入。
# =============================================

BUILTIN_TEMPLATES = [
    {
        "name": "经典蓝",
        "thumbnail_url": "",
        "css_variables": {
            "primaryColor": "#2563eb",
            "accentColor": "#1e40af",
            "bodySize": "13",
            "headingSize": "16",
            "lineHeight": "1.5",
            "pageMargin": "2.2",
            "sectionGap": "14",
            "fontFamily": "Inter, 'Noto Sans SC', sans-serif",
        },
        "is_builtin": True,
    },
    {
        "name": "现代灰",
        "thumbnail_url": "",
        "css_variables": {
            "primaryColor": "#374151",
            "accentColor": "#6b7280",
            "bodySize": "12.5",
            "headingSize": "15",
            "lineHeight": "1.45",
            "pageMargin": "2.0",
            "sectionGap": "12",
            "fontFamily": "'Source Sans Pro', 'Noto Sans SC', sans-serif",
        },
        "is_builtin": True,
    },
    {
        "name": "优雅紫",
        "thumbnail_url": "",
        "css_variables": {
            "primaryColor": "#7c3aed",
            "accentColor": "#5b21b6",
            "bodySize": "13",
            "headingSize": "16",
            "lineHeight": "1.55",
            "pageMargin": "2.4",
            "sectionGap": "16",
            "fontFamily": "'Playfair Display', 'Noto Serif SC', serif",
        },
        "is_builtin": True,
    },
    {
        "name": "清新绿",
        "thumbnail_url": "",
        "css_variables": {
            "primaryColor": "#059669",
            "accentColor": "#047857",
            "bodySize": "13",
            "headingSize": "15.5",
            "lineHeight": "1.5",
            "pageMargin": "2.0",
            "sectionGap": "14",
            "fontFamily": "'Nunito', 'Noto Sans SC', sans-serif",
        },
        "is_builtin": True,
    },
]


async def seed_templates():
    """如果内置模板不存在则插入"""
    from app.models.models import ResumeTemplate
    from sqlalchemy import select

    async with async_session() as session:
        result = await session.execute(
            select(ResumeTemplate).where(ResumeTemplate.is_builtin == True)
        )
        existing = {t.name for t in result.scalars().all()}

        for tpl in BUILTIN_TEMPLATES:
            if tpl["name"] not in existing:
                session.add(ResumeTemplate(**tpl))

        await session.commit()


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
