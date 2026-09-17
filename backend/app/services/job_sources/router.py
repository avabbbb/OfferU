"""JobSourceRouter — 多源聚合、去重、provenance 保留。

关键语义：单个源失败 ≠ 0 岗位。`source_errors` 与 `source_statuses`
必须把失败/不可用状态透传给调用方，绝不静默吞掉。
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from typing import Any

from .protocol import (
    JobObservation,
    JobSearchQuery,
    JobSource,
    JobSourceStatus,
)


@dataclass
class JobSearchResult:
    """聚合搜索结果；调用方必须检查 source_errors 区分 '没搜到' 与 '源挂了'。"""
    observations: list[JobObservation] = field(default_factory=list)
    source_statuses: dict[str, JobSourceStatus] = field(default_factory=dict)
    source_errors: dict[str, str] = field(default_factory=dict)
    source_counts: dict[str, int] = field(default_factory=dict)  # 去重前每源条数

    @property
    def ok(self) -> bool:
        """至少一个源成功返回（即便 0 条也算该源成功）。"""
        return bool(self.source_counts)


class JobSourceRouter:
    """按注册顺序聚合多个 JobSource，跨源按 dedupe_key 去重。"""

    def __init__(self) -> None:
        self._sources: dict[str, JobSource] = {}

    def register(self, source: JobSource) -> None:
        self._sources[source.source_id] = source

    def unregister(self, source_id: str) -> None:
        self._sources.pop(source_id, None)

    def sources(self) -> list[JobSource]:
        return list(self._sources.values())

    async def statuses(self) -> dict[str, JobSourceStatus]:
        """并发收集全部源的可用性；单个 status() 失败记为 UNAVAILABLE。"""
        out: dict[str, JobSourceStatus] = {}
        async def _one(src: JobSource) -> None:
            try:
                out[src.source_id] = await src.status()
            except Exception:
                out[src.source_id] = "UNAVAILABLE"
        await asyncio.gather(*(_one(s) for s in self._sources.values()))
        return out

    async def search_all(
        self,
        query: JobSearchQuery,
        *,
        only: list[str] | None = None,
        timeout_per_source: float = 30.0,
    ) -> JobSearchResult:
        """并发搜全部 READY/EXPERIMENTAL 源；按 dedupe_key 去重，保留 provenance。

        `only` 限制参与搜索的 source_id 白名单（默认全部）。
        """
        result = JobSearchResult()
        candidates = [
            s for s in self._sources.values()
            if only is None or s.source_id in only
        ]
        if not candidates:
            return result

        # 先探测可用性 —— AUTH_REQUIRED/UNAVAILABLE 的源直接跳过 search，
        # 但状态仍写入 source_statuses，调用方可见。
        statuses = await self.statuses()
        result.source_statuses = statuses

        searchable = [
            s for s in candidates
            if statuses.get(s.source_id) in ("READY", "EXPERIMENTAL", "DEGRADED")
        ]
        for s in candidates:
            if s not in searchable:
                result.source_errors.setdefault(
                    s.source_id, f"not searchable: {statuses.get(s.source_id)}"
                )

        async def _search(src: JobSource) -> tuple[str, list[JobObservation] | None, str]:
            try:
                obs = await asyncio.wait_for(src.search(query), timeout=timeout_per_source)
                return src.source_id, obs, ""
            except Exception as exc:  # noqa: BLE001 — 错误透传进 source_errors
                return src.source_id, None, f"{type(exc).__name__}: {exc}"

        gathered = await asyncio.gather(*(_search(s) for s in searchable))
        seen: set[str] = set()
        for source_id, obs, err in gathered:
            if obs is None:
                result.source_errors[source_id] = err
                continue
            result.source_counts[source_id] = len(obs)
            for o in obs:
                key = o.dedupe_key()
                if key in seen:
                    continue
                seen.add(key)
                result.observations.append(o)
        return result


# 全局单例：进程内共享注册表，路由层/Agent 共用。
job_source_router = JobSourceRouter()
