"""JobSource 协议：归一化岗位观测与数据源契约。

Role Intelligence / Career Truth 只消费 `JobObservation`，不感知平台。
平台细节（BOSS CLI、浏览器扩展、手工录入）都收敛到 `JobSource` 接口。
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Literal, Optional, Protocol, runtime_checkable

# 数据源可用性 —— 前端 Connections 页直接消费这些字面量。
JobSourceStatus = Literal[
    "READY",           # 可正常 search/get
    "AUTH_REQUIRED",   # 需要用户登录/授权（如 BOSS 浏览器会话）
    "DEGRADED",        # 部分能力可用（如只能 search 不能 get）
    "UNAVAILABLE",     # 当前不可用（网络/依赖缺失）
    "EXPERIMENTAL",    # 实验性 adapter（BOSS 永远至少是这个级别）
]

# 平台标识；新平台追加字面量即可，不建子类。
JobSourceId = str  # "manual" | "browser_capture" | "web" | "boss" | ...


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def compute_raw_hash(raw: Any) -> str:
    """对原始载荷算稳定 sha256，用于跨源/重放去重。"""
    if isinstance(raw, (dict, list)):
        import json
        payload = json.dumps(raw, sort_keys=True, ensure_ascii=False)
    else:
        payload = str(raw)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


@dataclass(frozen=True)
class JobObservation:
    """归一化岗位观测 —— Role Intelligence 的唯一输入。

    字段刻意最少：只保留产品消费所需。平台原始数据进 metadata/raw_hash，
    不在主字段暴露平台私有结构。
    """
    source: JobSourceId
    external_job_id: str          # adapter 命名空间内唯一 ID（如 "manual:42"）；无则 ""
    source_url: str               # 原始详情页 URL
    title: str
    company: str
    description: str
    location: str = ""
    salary: str = ""              # 原始薪资文本，如 "15-25K·13薪"
    experience: str = ""
    education: str = ""
    captured_at: datetime = field(default_factory=_utcnow)
    # 真实发布日期（ISO 字符串，仅源平台给出时设置）；缺省 None 表示未知，
    # 绝不回填 captured_at —— 采集时间不是岗位发布日期。
    posted_at: Optional[str] = None
    raw_hash: str = ""            # sha256(raw_payload)；空则由 normalize 补
    metadata: dict[str, Any] = field(default_factory=dict)

    def dedupe_key(self) -> str:
        """跨源去重键：优先 external_id（按 source 命名空间，杜绝跨源 PK 碰撞），
        退化为 title+company 归一化。"""
        if self.external_job_id:
            return f"ext:{self.source}:{self.external_job_id}"
        norm = f"{self.title.strip().lower()}|{self.company.strip().lower()}"
        return f"text:{hashlib.sha256(norm.encode()).hexdigest()[:24]}"

@dataclass(frozen=True)
class JobSourceCapabilities:
    """该 adapter 实际支持的能力。V1 只用 search/detail/records。"""
    search: bool = False
    detail: bool = False
    recommend: bool = False
    application_records: bool = False  # 读投递记录 → ExternalApplicationSignal
    inbox: bool = False                # 读收件箱元数据


@dataclass(frozen=True)
class JobSearchQuery:
    """通用岗位搜索请求 —— Agent 层只发这个，不碰平台语法。"""
    keywords: str
    location: str = ""
    limit: int = 20
    filters: dict[str, Any] = field(default_factory=dict)


@runtime_checkable
class JobSource(Protocol):
    """岗位数据源契约。adapter 实现这 4 个方法即可接入。"""
    source_id: JobSourceId

    async def status(self) -> JobSourceStatus:
        """报告当前可用性；EXPERIMENTAL 源即便可用也应带该标记（见 status_detail）。"""
        ...

    async def capabilities(self) -> JobSourceCapabilities:
        ...

    async def search(self, query: JobSearchQuery) -> list[JobObservation]:
        """搜索岗位；失败必须抛异常（由 router 记为 source_errors），不得静默返回 []。"""
        ...

    async def get(self, external_job_id: str) -> JobObservation | None:
        """取岗位详情；找不到返回 None，平台错误抛异常。"""
        ...
