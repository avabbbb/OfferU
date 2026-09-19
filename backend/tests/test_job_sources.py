"""JobSource V1 不变量测试：归一化、去重、失败≠空、provenance、BOSS 只读边界。"""

from __future__ import annotations

import unittest
from datetime import datetime, timezone

from app.services.job_sources.normalize import (
    observation_to_ingest_item,
    observations_to_ingest,
)
from app.services.job_sources.protocol import (
    JobObservation,
    JobSearchQuery,
    JobSourceCapabilities,
    compute_raw_hash,
)
from app.services.job_sources.router import JobSourceRouter


def _obs(source: str = "boss", ext_id: str = "j1", title: str = "AI Agent 产品经理",
         company: str = "Acme", url: str = "https://x/j1") -> JobObservation:
    return JobObservation(
        source=source,
        external_job_id=ext_id,
        source_url=url,
        title=title,
        company=company,
        description="desc",
        location="深圳",
        salary="20-40K",
        experience="3-5年",
        education="本科",
        captured_at=datetime.now(timezone.utc),
        raw_hash=compute_raw_hash({"t": title, "c": company}),
        metadata={"welfare": ["双休"]},
    )


class _FakeSource:
    """可控假源：返回预置观测或抛异常。"""

    def __init__(self, source_id: str, status: str = "READY",
                 results: list[JobObservation] | None = None,
                 error: Exception | None = None):
        self.source_id = source_id
        self._status = status
        self._results = results or []
        self._error = error

    async def status(self):
        return self._status

    async def capabilities(self):
        return JobSourceCapabilities(search=True, detail=True)

    async def search(self, query: JobSearchQuery):
        if self._error:
            raise self._error
        return self._results

    async def get(self, external_job_id: str):
        return self._results[0] if self._results else None


class JobSourceProtocolTests(unittest.TestCase):
    def test_dedupe_key_prefers_external_id(self):
        a = _obs(ext_id="42")
        b = _obs(ext_id="42", title="不同标题")
        self.assertEqual(a.dedupe_key(), "ext:boss:42")
        self.assertEqual(a.dedupe_key(), b.dedupe_key())

    def test_dedupe_key_falls_back_to_content(self):
        a = _obs(ext_id="")
        b = _obs(ext_id="")
        self.assertEqual(a.dedupe_key(), b.dedupe_key())
        c = _obs(ext_id="", company="OtherCo")
        self.assertNotEqual(a.dedupe_key(), c.dedupe_key())

    def test_dedupe_key_scoped_by_source(self):
        """不同源同样的 external_job_id 不得去重到一起（manual:42 vs web:42）。"""
        a = _obs(source="manual", ext_id="42")
        b = _obs(source="web", ext_id="42")
        self.assertNotEqual(a.dedupe_key(), b.dedupe_key())
        c = _obs(source="manual", ext_id="42")
        self.assertEqual(a.dedupe_key(), c.dedupe_key())


class JobSourceRouterTests(unittest.IsolatedAsyncioTestCase):
    async def test_dedupes_across_sources(self):
        """跨源同 external_job_id 不得误并；真正的同岗（无 ext id、同 title+company）仍去重。"""
        router = JobSourceRouter()
        router.register(_FakeSource("boss", results=[_obs(source="boss", ext_id="j1")]))
        router.register(_FakeSource("web", results=[_obs(source="web", ext_id="j1")]))
        result = await router.search_all(JobSearchQuery(keywords="agent"))
        self.assertEqual(len(result.observations), 2)
        self.assertEqual({o.source for o in result.observations}, {"boss", "web"})
        self.assertEqual(result.source_counts, {"boss": 1, "web": 1})

    async def test_dedupes_same_job_without_ext_id(self):
        """无 ext id 时按 title+company 文本哈希跨源去重，保留先到的 provenance。"""
        router = JobSourceRouter()
        router.register(_FakeSource("boss", results=[_obs(source="boss", ext_id="")]))
        router.register(_FakeSource("web", results=[_obs(source="web", ext_id="")]))
        result = await router.search_all(JobSearchQuery(keywords="agent"))
        self.assertEqual(len(result.observations), 1)
        self.assertEqual(result.observations[0].source, "boss")

    async def test_source_failure_is_not_empty_result(self):
        """一个源挂了，另一个源成功：失败必须可见且不影响成功源。"""
        router = JobSourceRouter()
        router.register(_FakeSource("boss", error=RuntimeError("平台风控")))
        router.register(_FakeSource("web", results=[_obs(source="web", ext_id="w1")]))
        result = await router.search_all(JobSearchQuery(keywords="agent"))
        self.assertEqual(len(result.observations), 1)
        self.assertEqual(result.observations[0].source, "web")
        self.assertIn("boss", result.source_errors)
        self.assertIn("平台风控", result.source_errors["boss"])
        self.assertTrue(result.ok)

    async def test_auth_required_source_skipped_but_visible(self):
        router = JobSourceRouter()
        router.register(_FakeSource("boss", status="AUTH_REQUIRED", results=[_obs()]))
        router.register(_FakeSource("web", results=[_obs(source="web", ext_id="w1")]))
        result = await router.search_all(JobSearchQuery(keywords="agent"))
        self.assertEqual(len(result.observations), 1)
        self.assertEqual(result.observations[0].source, "web")
        self.assertEqual(result.source_statuses["boss"], "AUTH_REQUIRED")
        self.assertIn("boss", result.source_errors)


class NormalizeTests(unittest.TestCase):
    def test_observation_to_ingest_item(self):
        item = observation_to_ingest_item(_obs(), batch_id="b1")
        self.assertEqual(item["source"], "boss")
        self.assertEqual(item["hash_key"], "boss:j1")
        self.assertEqual(item["salary_min"], 20000)
        self.assertEqual(item["salary_max"], 40000)
        self.assertEqual(item["salary_text"], "20-40K")
        self.assertEqual(item["batch_id"], "b1")

    def test_skips_invalid_observations(self):
        good = _obs()
        bad = _obs(title="", company="")
        items = observations_to_ingest([good, bad])
        self.assertEqual(len(items), 1)
        self.assertEqual(items[0]["title"], "AI Agent 产品经理")

    def test_posted_at_not_faked_from_capture_time(self):
        """源数据无发布日期时，posted_at 必须保持 None，不得用 captured_at 冒充。"""
        obs = _obs()  # posted_at 缺省 None
        item = observation_to_ingest_item(obs)
        self.assertIsNone(item["posted_at"])
        self.assertNotEqual(item["posted_at"], obs.captured_at.date().isoformat())

    def test_posted_at_passes_through_real_source_date(self):
        obs = JobObservation(
            source="boss", external_job_id="j9", source_url="https://x/j9",
            title="T", company="C", description="d", posted_at="2026-08-01",
        )
        item = observation_to_ingest_item(obs)
        self.assertEqual(item["posted_at"], "2026-08-01")


class BossAdapterBoundaryTests(unittest.IsolatedAsyncioTestCase):
    async def test_boss_adapter_is_experimental_and_read_only(self):
        """BOSS adapter capabilities 不含写操作。"""
        from app.services.job_sources.adapters.boss import BossJobSource

        src = BossJobSource()
        caps = await src.capabilities()
        self.assertTrue(caps.search)
        self.assertTrue(caps.detail)
        self.assertFalse(caps.application_records)  # V1 不启用
        self.assertFalse(caps.inbox)
        self.assertFalse(hasattr(src, "apply"))
        self.assertFalse(hasattr(src, "greet"))
        self.assertFalse(hasattr(src, "submit"))

    async def test_boss_adapter_maps_auth_required(self):
        """boss status 返回 AUTH_REQUIRED 时，adapter 报 AUTH_REQUIRED 而非崩溃。"""
        from unittest.mock import patch
        from app.services.job_sources.adapters import boss as boss_mod

        async def fake_run(*args, **kwargs):
            return {
                "ok": False,
                "error": {"code": "AUTH_REQUIRED", "message": "未登录",
                          "recoverable": True, "recovery_action": "boss login"},
            }

        with patch.object(boss_mod, "_run_boss", side_effect=fake_run):
            src = boss_mod.BossJobSource()
            self.assertEqual(await src.status(), "AUTH_REQUIRED")
