"""EXT-JOB-002：批量岗位导入 Operation 验收测试。

覆盖：
- import_job_batch 创建岗位（execute_operation 包装、envelope、inbox 状态）
- 重复 hash_key 幂等（重复同步不创建重复 Job）
- 同 batch_id 重放不重复创建批次/计数
- 严格输入校验（extra 字段、缺失必填、空 title）
- Operation audit 落盘且 surface=browser_extension_ui
- detect_campus 自动校招判定
"""

from __future__ import annotations

import asyncio
import itertools
import os
import secrets
import sys
import unittest
from pathlib import Path
from typing import Any

BACKEND_DIR = Path(__file__).resolve().parents[1]
os.chdir(BACKEND_DIR)
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from sqlalchemy import func, select

from app.database import async_session, init_db
from app.models.models import Batch, Job, OperationAuditLog
from app.ops import execute_operation

_RUN_SALT = secrets.token_hex(8)
_ITEM_SEQUENCE = itertools.count(1)


def _uniq(label: str) -> str:
    return f"{label}-{_RUN_SALT}"


def _item(**overrides: Any) -> dict[str, Any]:
    sequence = next(_ITEM_SEQUENCE)
    base = {
        "title": f"{_uniq('导入岗位')}-{sequence}",
        "company": f"{_uniq('导入公司')}-{sequence}",
        "location": "北京",
        "url": "https://example.invalid/jobs/1",
        "apply_url": "",
        "source": "browser_extension",
        "raw_description": "岗位职责：负责测试导入服务。任职要求：Python。",
        "posted_at": None,
        "batch_id": None,
        "hash_key": f"{_uniq('hash')}-{sequence}",
        "summary": "",
        "keywords": [],
        "salary_min": None,
        "salary_max": None,
        "salary_text": "",
        "education": "",
        "experience": "",
        "job_type": "",
        "company_size": "",
        "company_industry": "",
        "company_logo": "",
        "is_campus": False,
    }
    base.update(overrides)
    return base


class JobIngestTests(unittest.TestCase):
    maxDiff = None

    def test_t1_import_job_batch_creates_jobs(self) -> None:
        async def run() -> dict[str, Any]:
            await init_db()
            batch_id = _uniq("batch-t1")
            result = await execute_operation(
                "import_job_batch",
                {
                    "jobs": [_item(), _item()],
                    "source": "browser_extension",
                    "batch_id": batch_id,
                    "keywords": ["python"],
                    "location": "北京",
                },
                surface="browser_extension_ui",
            )
            self.assertTrue(result.get("ok"), result)
            outputs = result["outputs"]
            self.assertEqual(outputs["created"], 2)
            self.assertEqual(outputs["skipped"], 0)
            self.assertEqual(outputs["batch_id"], batch_id)
            self.assertEqual(len(outputs["created_hash_keys"]), 2)

            async with async_session() as db:
                job_count = (
                    await db.execute(
                        select(func.count()).select_from(Job).where(Job.batch_id == batch_id)
                    )
                ).scalar_one()
                triage = (
                    await db.execute(
                        select(Job.triage_status).where(Job.batch_id == batch_id).limit(1)
                    )
                ).scalar_one()
                batch = (
                    await db.execute(select(Batch).where(Batch.id == batch_id))
                ).scalar_one_or_none()
            return {"job_count": job_count, "triage": triage, "batch": batch is not None}

        payload = asyncio.run(run())
        self.assertEqual(payload["job_count"], 2)
        self.assertEqual(payload["triage"], "inbox")
        self.assertTrue(payload["batch"])

    def test_t2_duplicate_hash_key_is_idempotent(self) -> None:
        async def run() -> dict[str, Any]:
            await init_db()
            item = _item()
            first = await execute_operation(
                "import_job_batch",
                {"jobs": [item], "batch_id": _uniq("batch-t2a")},
                surface="browser_extension_ui",
            )
            second = await execute_operation(
                "import_job_batch",
                {"jobs": [item], "batch_id": _uniq("batch-t2b")},
                surface="browser_extension_ui",
            )
            async with async_session() as db:
                count = (
                    await db.execute(
                        select(func.count()).select_from(Job).where(Job.hash_key == item["hash_key"])
                    )
                ).scalar_one()
            return {
                "first_created": first["outputs"]["created"],
                "second_created": second["outputs"]["created"],
                "second_skipped": second["outputs"]["skipped"],
                "stored_count": count,
            }

        payload = asyncio.run(run())
        self.assertEqual(payload["first_created"], 1)
        self.assertEqual(payload["second_created"], 0)
        self.assertEqual(payload["second_skipped"], 1)
        self.assertEqual(payload["stored_count"], 1)

    def test_t3_same_batch_id_replay_creates_single_batch(self) -> None:
        async def run() -> dict[str, Any]:
            await init_db()
            batch_id = _uniq("batch-t3")
            first = await execute_operation(
                "import_job_batch",
                {"jobs": [_item()], "batch_id": batch_id},
                surface="browser_extension_ui",
            )
            second = await execute_operation(
                "import_job_batch",
                {"jobs": [_item()], "batch_id": batch_id},
                surface="browser_extension_ui",
            )
            async with async_session() as db:
                batch_count = (
                    await db.execute(select(func.count()).select_from(Batch).where(Batch.id == batch_id))
                ).scalar_one()
                total_fetched = (
                    await db.execute(select(Batch.total_fetched).where(Batch.id == batch_id))
                ).scalar_one()
            return {
                "first_created": first["outputs"]["created"],
                "second_created": second["outputs"]["created"],
                "batch_count": batch_count,
                "total_fetched": total_fetched,
            }

        payload = asyncio.run(run())
        self.assertEqual(payload["first_created"], 1)
        self.assertEqual(payload["second_created"], 1)
        self.assertEqual(payload["batch_count"], 1)
        self.assertEqual(payload["total_fetched"], 2)

    def test_t4_strict_input_validation(self) -> None:
        async def run() -> list[dict[str, Any]]:
            await init_db()
            results: list[dict[str, Any]] = []
            # extra 字段拒绝
            extra = await execute_operation(
                "import_job_batch",
                {"jobs": [_item(transformCode="evil")], "batch_id": _uniq("batch-t4a")},
                surface="browser_extension_ui",
            )
            results.append({"case": "extra", "ok": extra.get("ok"), "err": "; ".join(extra.get("errors") or [])})
            # 空 title 拒绝
            empty_title = await execute_operation(
                "import_job_batch",
                {"jobs": [_item(title="   ")], "batch_id": _uniq("batch-t4b")},
                surface="browser_extension_ui",
            )
            results.append({"case": "empty-title", "ok": empty_title.get("ok"), "err": "; ".join(empty_title.get("errors") or [])})
            # 空 jobs 拒绝
            no_jobs = await execute_operation(
                "import_job_batch",
                {"jobs": [], "batch_id": _uniq("batch-t4c")},
                surface="browser_extension_ui",
            )
            results.append({"case": "no-jobs", "ok": no_jobs.get("ok"), "err": "; ".join(no_jobs.get("errors") or [])})
            return results

        results = asyncio.run(run())
        for case in results:
            self.assertFalse(case["ok"], case)
            self.assertNotEqual(case["err"], "")

    def test_t5_operation_audit_records_browser_extension_surface(self) -> None:
        async def run() -> dict[str, Any]:
            await init_db()
            batch_id = _uniq("batch-t5")
            await execute_operation(
                "import_job_batch",
                {"jobs": [_item()], "batch_id": batch_id},
                surface="browser_extension_ui",
            )
            async with async_session() as db:
                row = (
                    await db.execute(
                        select(OperationAuditLog)
                        .where(OperationAuditLog.operation == "import_job_batch")
                        .order_by(OperationAuditLog.id.desc())
                        .limit(1)
                    )
                ).scalar_one_or_none()
            if row is None:
                return {"found": False}
            return {
                "found": True,
                "surface": row.surface,
                "operation": row.operation,
                "input_has_batch": batch_id in str(row.inputs_json or ""),
                "has_outputs": bool(row.outputs_json),
            }

        payload = asyncio.run(run())
        self.assertTrue(payload["found"])
        self.assertEqual(payload["surface"], "browser_extension_ui")
        self.assertEqual(payload["operation"], "import_job_batch")
        self.assertTrue(payload["input_has_batch"])
        self.assertTrue(payload["has_outputs"])

    def test_t6_campus_detection_runs_per_item(self) -> None:
        async def run() -> dict[str, Any]:
            await init_db()
            campus = await execute_operation(
                "import_job_batch",
                {
                    "jobs": [
                        _item(title="2026 校招 Java 开发工程师", experience="在校/应届", is_campus=False),
                    ],
                    "batch_id": _uniq("batch-t6"),
                },
                surface="browser_extension_ui",
            )
            self.assertTrue(campus.get("ok"), campus)
            created_key = campus["outputs"]["created_hash_keys"][0]
            async with async_session() as db:
                is_campus = (
                    await db.execute(select(Job.is_campus).where(Job.hash_key == created_key))
                ).scalar_one()
            return {"is_campus": is_campus}

        payload = asyncio.run(run())
        self.assertTrue(payload["is_campus"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
