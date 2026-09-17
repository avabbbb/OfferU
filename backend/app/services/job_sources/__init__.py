"""JobSource — 统一岗位数据源抽象（JobSource V1）。

OfferU Agent 不感知平台；所有外部岗位以 `JobObservation` 归一化观测进入，
经 `JobSourceRouter` 聚合/去重后，走既有 `import_job_batch` 幂等入库。
BOSS 等平台只是 adapter，不是领域模型。
"""

from .protocol import (
    JobObservation,
    JobSearchQuery,
    JobSource,
    JobSourceCapabilities,
    JobSourceStatus,
)
from .router import JobSearchResult, JobSourceRouter

__all__ = [
    "JobObservation",
    "JobSearchQuery",
    "JobSource",
    "JobSourceCapabilities",
    "JobSourceStatus",
    "JobSearchResult",
    "JobSourceRouter",
]
