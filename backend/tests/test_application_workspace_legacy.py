"""回归测试：旧格式 schema 的投递表必须可读，不得触发 async 延迟加载 500。

背景：get_table_or_raise 曾把 _normalize_schema() 的结果回写给 ORM 对象，
旧格式 schema 的表会被标记 dirty，后续查询触发 autoflush，onupdate 列
（created_at/updated_at）被 expire，序列化时访问触发 MissingGreenlet → 500。
"""

from __future__ import annotations

import asyncio
from pathlib import Path
import sys
import tempfile
import unittest

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from app.database import Base
from app.models.models import ApplicationRecord, ApplicationTable, ApplicationTableRecord
from app.services.application_workspace import list_table_records

LEGACY_SCHEMA = [
    {"field_key": "custom_x", "label": "自定义字段"},
]


class LegacySchemaTableTests(unittest.TestCase):
    def test_list_table_records_with_legacy_schema_succeeds(self) -> None:
        async def run(database_path: Path) -> dict:
            engine = create_async_engine(f"sqlite+aiosqlite:///{database_path.as_posix()}")
            session = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
            try:
                async with engine.begin() as connection:
                    await connection.run_sync(Base.metadata.create_all)
                async with session() as db:
                    table = ApplicationTable(
                        name="旧格式表",
                        is_total=False,
                        schema_json=LEGACY_SCHEMA,
                    )
                    db.add(table)
                    await db.flush()
                    record = ApplicationRecord(company_name="旧表公司", job_title="旧表岗位")
                    db.add(record)
                    await db.flush()
                    db.add(
                        ApplicationTableRecord(
                            table_id=table.id,
                            record_id=record.id,
                        )
                    )
                    await db.commit()

                    payload = await list_table_records(db, table_id=table.id, keyword="")
                    return {
                        "records": len(payload["records"]),
                        "schema_keys": [
                            field["field_key"] for field in payload["table"]["schema"]
                        ],
                    }
            finally:
                await engine.dispose()

        with tempfile.TemporaryDirectory() as tmp:
            result = asyncio.run(run(Path(tmp) / "legacy.db"))

        self.assertEqual(result["records"], 1)
        # 输出 schema 必须仍是规范化格式（含 fixed 固定字段）
        self.assertIn("company_name", result["schema_keys"])
        self.assertIn("custom_x", result["schema_keys"])


if __name__ == "__main__":
    unittest.main()
