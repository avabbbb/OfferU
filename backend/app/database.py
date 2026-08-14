# =============================================
# OfferU - 数据库引擎
# =============================================
# 异步 SQLAlchemy 引擎配置
# 支持 SQLite（开发）和 PostgreSQL（生产）
# =============================================

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy import event
from sqlalchemy.orm import DeclarativeBase

from app.config import get_settings

settings = get_settings()

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


async def init_db():
    """创建所有表（首次启动时调用）+ 自动补全缺失列"""
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
        await conn.run_sync(_auto_migrate)
    await seed_templates()
    # HTML 简历工作室（studio 路由）使用的 HtmlResumeTemplate 种子；
    # 此前从未被调用，模板表恒空导致 studio 页面无模板可选。
    from app.services.template_seeder import seed_templates as seed_html_templates

    async with async_session() as session:
        await seed_html_templates(session)
    await seed_system_batches()
    await migrate_triage_status()


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


async def migrate_triage_status():
    """将旧的 triage_status 值（screened/unscreened）归一化为 picked/inbox"""
    import logging
    from sqlalchemy import text

    logger = logging.getLogger(__name__)

    try:
        async with async_session() as session:
            need_migrate = (
                await session.execute(
                    text(
                        "SELECT COUNT(*) FROM jobs WHERE triage_status IN ('screened','unscreened')"
                        " UNION ALL "
                        "SELECT COUNT(*) FROM pools WHERE scope IN ('screened','unscreened')"
                    )
                )
            ).all()
            if all(row[0] == 0 for row in need_migrate):
                return

            await session.execute(
                text("UPDATE jobs SET triage_status = 'picked' WHERE triage_status = 'screened'")
            )
            await session.execute(
                text("UPDATE jobs SET triage_status = 'inbox' WHERE triage_status = 'unscreened'")
            )
            await session.execute(
                text("UPDATE pools SET scope = 'picked' WHERE scope = 'screened'")
            )
            await session.execute(
                text("UPDATE pools SET scope = 'inbox' WHERE scope = 'unscreened'")
            )
            await session.commit()
            logger.info("migrate_triage_status: normalized legacy screened/unscreened values")
    except Exception as exc:
        logger.error("migrate_triage_status failed: %s", exc)
