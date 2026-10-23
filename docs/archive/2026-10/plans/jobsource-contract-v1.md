> 已归档（2026-10-21）：本文不再是当前权威，只用于考古。当前文档：04-module-job-workspace.md（位于 docs/）。本文是当时子代理施工契约，实际接口以 backend/app/services/job_sources/ 代码为准。

# JobSource V1 — 跨任务契约（冻结，子代理必须遵守）

## 核心协议（`backend/app/services/job_sources/protocol.py`）

```python
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Protocol

# 可用性枚举 —— 字符串字面量，前端直接消费
JobSourceStatus = Literal["READY", "AUTH_REQUIRED", "DEGRADED", "UNAVAILABLE", "EXPERIMENTAL"]

@dataclass(frozen=True)
class JobObservation:
    """归一化岗位观测。Role Intelligence 只认它，不认平台。"""
    source: str               # "manual" | "browser_capture" | "web" | "boss"
    external_job_id: str      # 平台原生 ID；无则 ""
    source_url: str           # 原始 URL
    title: str
    company: str
    description: str
    location: str = ""
    salary: str = ""          # 原始薪资文本，如 "15-25K·13薪"
    experience: str = ""
    education: str = ""
    captured_at: datetime = field(default_factory=datetime.utcnow)
    raw_hash: str = ""        # sha256(raw_payload)
    metadata: dict[str, Any] = field(default_factory=dict)

@dataclass(frozen=True)
class JobSourceCapabilities:
    search: bool = False
    detail: bool = False
    recommend: bool = False
    application_records: bool = False   # 读投递记录
    inbox: bool = False                 # 读收件箱元数据

class JobSource(Protocol):
    source_id: str                      # "manual" / "boss" / ...
    async def status(self) -> JobSourceStatus: ...
    async def capabilities(self) -> JobSourceCapabilities: ...
    async def search(self, query: JobSearchQuery) -> list[JobObservation]: ...
    async def get(self, external_job_id: str) -> JobObservation | None: ...

@dataclass(frozen=True)
class JobSearchQuery:
    keywords: str
    location: str = ""
    limit: int = 20
    filters: dict[str, Any] = field(default_factory=dict)
```

## 路由（`backend/app/services/job_sources/router.py`）

```python
class JobSourceRouter:
    def register(self, source: JobSource) -> None: ...
    async def search_all(self, query: JobSearchQuery) -> JobSearchResult: ...

@dataclass
class JobSearchResult:
    observations: list[JobObservation]
    source_statuses: dict[str, JobSourceStatus]   # source_id → status
    source_errors: dict[str, str]                  # source_id → error message
    # 失败 ≠ 空结果；调用方必须区分
```

## 信号抽象（复用既有表，不建新表）

`ExternalProgressSignal` 已通用：`channel`（"email"/"boss"/"calendar"/"manual"）、`account_ref`、`external_message_id`（= 平台侧事件/投递记录 ID）、`classification_json`（放 `signal_type`、`stage_hint`、`confidence`、`evidence`）。

**禁止**新建 `BossApplication`/`BossPipeline`。BOSS 投递记录 → `ExternalProgressSignal(channel="boss")` → 走既有 `ApplicationProgressCandidate` → 用户确认 → `ApplicationStageEvent`。

## 实体绑定

`Job.source` 已存在；新增可选列 `Job.external_id`（String(200), index）+ `ApplicationAttempt.external_id`。冲突 → `ApplicationProgressCandidate` 待审，**绝不**覆盖绑定。

## 文件归属（防并行冲突）

| Agent | 独占路径 |
|---|---|
| S1 Contract | `backend/app/services/job_sources/`（整个新目录）|
| S2 Manual/Web adapter | `backend/app/services/job_sources/adapters/`（子目录，与 S1 目录协调：S1 先建 `__init__.py`）|
| S3 BOSS research | `docs/research/boss-connector.md`（只写文档，不写代码）|
| S4 BOSS adapter | `backend/app/services/job_sources/adapters/boss.py` + `backend/app/services/job_sources/adapters/boss_cli.py` |
| S5 External signal | `backend/app/services/application_progress.py`（只加 channel 适配，不改主流程）|
| S6 Entity binding | `backend/app/models/models.py`（加列）+ `backend/app/services/job_sources/binding.py` |
| S7 Agent ops | `backend/app/ops.py` + `backend/app/services/agent_operations.py`（追加，不重写）|
| S8 Today/Connections API | `backend/app/routes/connections.py`（新文件）+ `backend/app/routes/jobs.py`（追加 search 端点）|
| S9 Frontend UX | `frontend/src/app/settings/connections/`（新目录）+ `frontend/src/lib/api.ts`（追加 `connectionsApi`）|
| S10 Tests | `backend/tests/test_job_sources.py`（新文件）+ `backend/tests/test_external_signals.py`（新文件）|

## 硬性约束（违反即返工）

- BOSS V1 = EXPERIMENTAL + LOCAL + USER_INITIATED + READ_ONLY。禁止 apply/greet/submit/contact。
- 前端永远不出现 `boss-cli`/`cookie`/`securityId`/端口/CLI 命令字样。
- 会话材料只进 `llm_secret_vault` 既有边界；不进 agent context/log/git。
- `source failure` ≠ `0 jobs found` —— 必须向上传递错误。
- 现有 email 进展管道行为不变（回归）。
- 不 commit；只改自己归属文件；不写 README/文档（除 S3 的研究文档）。
- 不跑全量测试/构建/lint —— 母 agent 收尾统一跑。
