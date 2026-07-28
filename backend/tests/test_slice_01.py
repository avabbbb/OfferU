"""OfferU Slice-01 纵向切片验收测试（T1-T8）。

覆盖范围：
- P0-01 ProfileSection.tier 字段读写
- P0-02 import_jd Operation（JD 导入 + md5 去重）
- P0-04 validate_fact_gate Operation（只读事实门）
- P0-05 ResumeVersion 快照（直接测 create_version_snapshot）
- P0-06 create_application_attempt Operation（一行一次投递尝试）
- 全链路 OperationAuditLog 落盘 + 错误优雅返回

注意：不调用 generate_resume（依赖 LLM），T3/T4/T5 用直接调用 + 只读 Operation 验收。
"""

from __future__ import annotations

import asyncio
import os
import sys
import unittest
from pathlib import Path
from typing import Any

BACKEND_DIR = Path(__file__).resolve().parents[1]
os.chdir(BACKEND_DIR)
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from sqlalchemy import func, select
from sqlalchemy.orm import selectinload

from app.database import async_session, init_db
from app.models.models import (
    ApplicationAttempt,
    Job,
    OperationAuditLog,
    Profile,
    ProfileSection,
    Resume,
    ResumeSection,
    ResumeVersion,
)
from app.ops import OPERATIONS, execute_operation


import secrets

_RUN_SALT = secrets.token_hex(8)


def _uniq(label: str) -> str:
    return f"{label}-{_RUN_SALT}"


class Slice01Tests(unittest.TestCase):

    def test_t1_import_jd_creates_job_with_raw_description(self) -> None:
        async def run() -> dict[str, Any]:
            await init_db()
            title = _uniq("T1岗位")
            company = _uniq("T1公司")
            jd_text = _uniq("T1 JD：负责后端服务开发，Python 5 years 经验。")
            result = await execute_operation(
                "import_jd",
                {
                    "title": title,
                    "company": company,
                    "jd_text": jd_text,
                    "source": "agent_import",
                    "batch_id": "slice01-test",
                },
                surface="slice01_test",
            )
            async with async_session() as db:
                job = (
                    await db.execute(
                        select(Job)
                        .where(Job.title == title)
                        .where(Job.company == company)
                    )
                ).scalar_one_or_none()
                raw_len = len(job.raw_description) if job else -1
                is_campus = bool(job.is_campus) if job else None
                triage = job.triage_status if job else None
            return {
                "ok": result["ok"],
                "duplicate": result["outputs"].get("duplicate"),
                "raw_len": raw_len,
                "is_campus": is_campus,
                "triage": triage,
            }

        payload = asyncio.run(run())

        self.assertTrue(payload["ok"])
        self.assertFalse(payload["duplicate"])
        self.assertGreater(payload["raw_len"], 0)
        self.assertIn(payload["triage"], {"inbox", "picked"})
        # is_campus 应为 bool（detect_campus 必须 deterministic 返回）
        self.assertIsInstance(payload["is_campus"], bool)

    def test_t1b_import_jd_dedups_identical_jd_text(self) -> None:
        async def run() -> tuple[dict, dict]:
            await init_db()
            title = _uniq("T1b岗位")
            company = _uniq("T1b公司")
            jd_text = _uniq("T1b JD：测试 md5 去重路径，Python 工程师 3 years 经验。")
            first = await execute_operation(
                "import_jd",
                {"title": title, "company": company, "jd_text": jd_text, "batch_id": "slice01-test"},
                surface="slice01_test",
            )
            second = await execute_operation(
                "import_jd",
                {"title": title, "company": company, "jd_text": jd_text, "batch_id": "slice01-test"},
                surface="slice01_test",
            )
            return first, second

        first, second = asyncio.run(run())

        self.assertTrue(first["ok"])
        self.assertFalse(first["outputs"]["duplicate"])
        self.assertTrue(second["ok"])
        self.assertTrue(second["outputs"]["duplicate"])
        self.assertEqual(first["outputs"]["id"], second["outputs"]["id"])

    def test_t2_add_profile_evidence_with_verified_fact_tier(self) -> None:
        async def run() -> dict[str, Any]:
            await init_db()
            title = _uniq("T2教育条目")
            source_text = (
                "本科-清华大学-计算机科学与技术 2020-2024 GPA 3.8 算法课程成绩A"
            )
            content_json = {
                "school": "清华大学",
                "degree": "本科",
                "major": "计算机科学与技术",
                "start_date": "2020",
                "end_date": "2024",
                "gpa": "3.8",
            }
            add = await execute_operation(
                "add_profile_evidence",
                {
                    "section_type": "education",
                    "title": title,
                    "content_json": content_json,
                    "source_text": source_text,
                    "tier": "VERIFIED_FACT",
                },
                surface="slice01_test",
            )
            listing = await execute_operation(
                "list_profile_evidence",
                {"section_type": "education", "limit": 500},
                surface="slice01_test",
            )
            matched = None
            for item in listing["outputs"].get("items", []):
                if item.get("title") == title:
                    matched = item
                    break
            return {
                "add_ok": add["ok"],
                "add_duplicate": add["outputs"].get("duplicate"),
                "matched_id": matched["id"] if matched else None,
                "matched_tier": matched["tier"] if matched else None,
            }

        payload = asyncio.run(run())

        self.assertTrue(payload["add_ok"], "add_profile_evidence 应当通过事实门并写入")
        self.assertFalse(payload["add_duplicate"], "首次写入不应为重复")
        self.assertIsNotNone(payload["matched_id"], "list_profile_evidence 应当能读回条目")
        self.assertEqual(payload["matched_tier"], "verified_fact", "tier=VERIFIED_FACT 应回一化为小写")

    def test_t2b_add_profile_evidence_blocks_unverified_fact_writes(self) -> None:
        async def run() -> dict[str, Any]:
            await init_db()
            title = _uniq("T2b伪造条目")
            source_text = "候选人提到的工作内容仅涉及 Java 后端开发。"
            content_json = {
                "school": "不存在大学",
                "degree": "硕士",
                "major": "火箭工程",
            }
            add = await execute_operation(
                "add_profile_evidence",
                {
                    "section_type": "education",
                    "title": title,
                    "content_json": content_json,
                    "source_text": source_text,
                    "tier": "verified_fact",
                },
                surface="slice01_test",
            )
            async with async_session() as db:
                rows = (
                    await db.execute(
                        select(ProfileSection).where(ProfileSection.title == title)
                    )
                ).scalars().all()
            return {
                "ok": add["ok"],
                "errors": add["errors"],
                "fact_gate_status": add["outputs"].get("fact_gate", {}).get("status") if isinstance(add["outputs"], dict) else None,
                "rows_in_db": len(rows),
            }

        payload = asyncio.run(run())

        self.assertFalse(payload["ok"], "无来源佐证时 execute_operation 应返回 ok=False")
        self.assertTrue(payload["errors"], "应携带错误说明")
        self.assertEqual(payload["fact_gate_status"], "blocked", "fact_gate 应判定为 blocked")
        self.assertEqual(payload["rows_in_db"], 0, "事实门未通过时不得写入 profile_sections")

    def test_t3_validate_fact_gate_readonly_passed(self) -> None:
        async def run() -> dict[str, Any]:
            await init_db()
            op = OPERATIONS["validate_fact_gate"]
            source_facts = "候选人是 Python 工程师，有 5 years 经验，公司字节跳动。"
            generated = {
                "company": "字节跳动",
                "section_text": "Python 工程师 5 years",
            }
            result = await execute_operation(
                "validate_fact_gate",
                {"source_facts": source_facts, "generated": generated},
                surface="slice01_test",
            )
            return {
                "ok": result["ok"],
                "status": result["outputs"].get("status"),
                "side_effects": list(op.side_effects),
            }

        payload = asyncio.run(run())

        self.assertTrue(payload["ok"])
        self.assertEqual(payload["status"], "passed")
        self.assertEqual(payload["side_effects"], ["read"], "P0-04 validate_fact_gate 必须只读")

    def test_t4_validate_fact_gate_blocked_and_no_resume_version_write(self) -> None:
        async def run() -> dict[str, Any]:
            await init_db()
            async with async_session() as db:
                before = (
                    await db.execute(select(func.count(ResumeVersion.id)))
                ).scalar_one()
            source_facts = "候选人会 Java 开发。"
            generated = {
                "company": "OpenAI",
                "section_text": "Python 工程师 5 years 在 OpenAI",
            }
            result = await execute_operation(
                "validate_fact_gate",
                {"source_facts": source_facts, "generated": generated},
                surface="slice01_test",
            )
            async with async_session() as db:
                after = (
                    await db.execute(select(func.count(ResumeVersion.id)))
                ).scalar_one()
            return {
                "ok": result["ok"],
                "status": result["outputs"].get("status"),
                "warnings_count": len(result["outputs"].get("warnings", [])),
                "before": before,
                "after": after,
            }

        payload = asyncio.run(run())

        self.assertTrue(payload["ok"], "validate_fact_gate 即便 blocked 也应正常返回 envelope")
        self.assertEqual(payload["status"], "blocked")
        self.assertGreater(payload["warnings_count"], 0)
        self.assertEqual(payload["after"], payload["before"], "只读 Operation 不得写入 ResumeVersion")

    def test_t5_create_version_snapshot_directly(self) -> None:
        from app.services.resume_versions import create_version_snapshot

        async def run() -> dict[str, Any]:
            await init_db()
            async with async_session() as db:
                resume = Resume(
                    user_name=_uniq("T5用户"),
                    title=_uniq("T5简历"),
                    summary="T5 测试摘要",
                )
                db.add(resume)
                await db.flush()
                resume_id = resume.id
                db.add_all(
                    [
                        ResumeSection(
                            resume_id=resume_id,
                            section_type="experience",
                            sort_order=0,
                            title="主经历",
                            content_json=[{"company": "测试公司", "position": "工程师"}],
                        ),
                        ResumeSection(
                            resume_id=resume_id,
                            section_type="skill",
                            sort_order=1,
                            title="核心技能",
                            content_json=[{"category": "通用", "items": ["Python", "SQL"]}],
                        ),
                    ]
                )
                await db.commit()

                resume = (
                    await db.execute(
                        select(Resume)
                        .options(selectinload(Resume.sections))
                        .where(Resume.id == resume_id)
                    )
                ).scalar_one()

                v1 = await create_version_snapshot(
                    db,
                    resume,
                    change_summary="T5 第一次快照",
                    created_by="slice01_test",
                )
                await db.commit()
                v1_number = v1.version_number
                v1_snapshot_sections = len(v1.content_snapshot.get("sections", []))
                v1_resume_id = v1.content_snapshot.get("resume", {}).get("id")

                v2 = await create_version_snapshot(
                    db,
                    resume,
                    change_summary="T5 第二次快照",
                    created_by="slice01_test",
                )
                await db.commit()
                v2_number = v2.version_number

                total_versions = (
                    await db.execute(
                        select(func.count(ResumeVersion.id)).where(
                            ResumeVersion.resume_id == resume_id
                        )
                    )
                ).scalar_one()
            return {
                "v1_number": v1_number,
                "v1_sections": v1_snapshot_sections,
                "v1_resume_id": v1_resume_id,
                "v2_number": v2_number,
                "total_versions": total_versions,
            }

        payload = asyncio.run(run())

        self.assertEqual(payload["v1_number"], 1, "首次快照版本号应为 1")
        self.assertEqual(payload["v1_sections"], 2, "快照应包含 Resume 关联的全部 sections")
        self.assertIsNotNone(payload["v1_resume_id"], "快照应携带 resume.id")
        self.assertEqual(payload["v2_number"], 2, "二次快照版本号应基于最高值递增")
        self.assertEqual(payload["total_versions"], 2, "ResumeVersion 表应留有两条记录")

    def test_t6_create_application_attempt_two_rows_for_same_job(self) -> None:
        async def run() -> dict[str, Any]:
            await init_db()
            title = _uniq("T6岗位")
            company = _uniq("T6公司")
            jd_text = _uniq("T6 JD：准备投递尝试一行一次投递测试。")
            jd_result = await execute_operation(
                "import_jd",
                {"title": title, "company": company, "jd_text": jd_text, "batch_id": "slice01-test"},
                surface="slice01_test",
            )
            job_id = jd_result["outputs"]["id"] if jd_result["ok"] else None

            first = await execute_operation(
                "create_application_attempt",
                {"job_id": job_id, "notes": "第一次尝试"},
                surface="slice01_test",
            )
            second = await execute_operation(
                "create_application_attempt",
                {"job_id": job_id, "notes": "第二次尝试"},
                surface="slice01_test",
            )
            async with async_session() as db:
                rows = (
                    await db.execute(
                        select(ApplicationAttempt)
                        .where(ApplicationAttempt.job_id == job_id)
                        .order_by(ApplicationAttempt.id.asc())
                    )
                ).scalars().all()
            return {
                "jd_ok": jd_result["ok"],
                "job_id": job_id,
                "first_ok": first["ok"],
                "second_ok": second["ok"],
                "first_id": first["outputs"].get("id"),
                "second_id": second["outputs"].get("id"),
                "first_status": first["outputs"].get("status"),
                "rows": len(rows),
                "distinct_ids": len({r.id for r in rows}),
            }

        payload = asyncio.run(run())

        self.assertTrue(payload["jd_ok"])
        self.assertIsNotNone(payload["job_id"])
        self.assertTrue(payload["first_ok"])
        self.assertTrue(payload["second_ok"])
        self.assertEqual(payload["first_status"], "prepared", "新建 attempt 状态应为 prepared")
        self.assertEqual(payload["rows"], 2, "ADR-0007 要求一行一次投递尝试")
        self.assertEqual(payload["distinct_ids"], 2, "两次调用应产生不同 id（无唯一约束）")
        self.assertNotEqual(payload["first_id"], payload["second_id"])

    def test_t7_operation_audit_log_covers_slice_operations(self) -> None:
        async def run() -> dict[str, Any]:
            await init_db()

            async with async_session() as db:
                before = (
                    await db.execute(select(func.count(OperationAuditLog.id)))
                ).scalar_one()

            title = _uniq("T7岗位")
            company = _uniq("T7公司")
            jd_text = _uniq("T7 JD：覆盖 OperationAuditLog 写入测试，5 years 经验。")
            await execute_operation(
                "import_jd",
                {"title": title, "company": company, "jd_text": jd_text, "batch_id": "slice01-test"},
                surface="slice01_test",
            )
            await execute_operation(
                "list_profile_evidence",
                {"limit": 5},
                surface="slice01_test",
            )
            await execute_operation(
                "validate_fact_gate",
                {"source_facts": "ABC 公司 5 years", "generated": {"company": "ABC", "text": "5 years"}},
                surface="slice01_test",
            )

            async with async_session() as db:
                rows = (
                    await db.execute(
                        select(OperationAuditLog)
                        .where(OperationAuditLog.surface == "slice01_test")
                        .order_by(OperationAuditLog.id.asc())
                    )
                ).scalars().all()
                after_total = (
                    await db.execute(select(func.count(OperationAuditLog.id)))
                ).scalar_one()
            seen_ops = {row.operation for row in rows}
            return {
                "after_total": after_total,
                "before": before,
                "seen_ops": seen_ops,
                "rows_in_test_scope": len(rows),
            }

        payload = asyncio.run(run())

        self.assertGreater(payload["after_total"], payload["before"], "执行 Operation 应写审计")
        self.assertGreaterEqual(payload["rows_in_test_scope"], 3, "本测试至少写入 3 条 slice01_test 审计")
        for op in {"import_jd", "list_profile_evidence", "validate_fact_gate"}:
            self.assertIn(op, payload["seen_ops"], f"审计日志缺操作 {op}")

    def test_t8_empty_db_returns_clear_error_envelopes(self) -> None:
        async def run() -> dict[str, Any]:
            await init_db()

            empty_jd = await execute_operation(
                "import_jd",
                {"title": "", "company": _uniq("T8公司"), "jd_text": "T8描述"},
                surface="slice01_test",
            )
            empty_evidence = await execute_operation(
                "add_profile_evidence",
                {
                    "section_type": "education",
                    "title": _uniq("T8条目"),
                    "content_json": {},
                    "source_text": "无效来源",
                },
                surface="slice01_test",
            )
            missing_job = await execute_operation(
                "create_application_attempt",
                {"job_id": 99999},
                surface="slice01_test",
            )
            return {
                "empty_jd_ok": empty_jd["ok"],
                "empty_jd_errors": empty_jd["errors"],
                "empty_evidence_ok": empty_evidence["ok"],
                "empty_evidence_errors": empty_evidence["errors"],
                "missing_job_ok": missing_job["ok"],
                "missing_job_errors": missing_job["errors"],
            }

        payload = asyncio.run(run())

        self.assertFalse(payload["empty_jd_ok"], "空 title 应拒绝并回传 ok=False")
        self.assertTrue(payload["empty_jd_errors"])
        self.assertFalse(payload["empty_evidence_ok"], "空 content_json 应拒绝")
        self.assertTrue(payload["empty_evidence_errors"])
        self.assertFalse(payload["missing_job_ok"], "不存在 job_id 应拒绝")
        self.assertTrue(payload["missing_job_errors"])
        for err in payload["missing_job_errors"]:
            self.assertIn("99999", err)


if __name__ == "__main__":
    unittest.main(verbosity=2)