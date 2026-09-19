"""JobObservation → JobIngestItem 归一化桥接。

把任意平台的归一化观测转成既有 `import_job_batch` 的输入，
复用 hash_key 幂等去重 + JOB_SAVED 自动化事件管道，不重复造入库逻辑。
"""

from __future__ import annotations

import hashlib
import re
from typing import Any, Optional

from .protocol import JobObservation

_SALARY_RANGE = re.compile(r"(\d+)\s*[-~]\s*(\d+)\s*[kK]")


def _parse_salary(salary_text: str) -> tuple[Optional[int], Optional[int]]:
    """从 '15-25K·13薪' 类文本提取月薪上下限（元）。解析不出返回 (None, None)。"""
    m = _SALARY_RANGE.search(salary_text or "")
    if not m:
        return None, None
    low, high = int(m.group(1)) * 1000, int(m.group(2)) * 1000
    return (low, high) if low <= high else (high, low)


def _job_hash_key(obs: JobObservation) -> str:
    """生成入库幂等键：有 external_id 用平台键，否则用内容哈希。"""
    if obs.external_job_id:
        # adapter 已按 "{source}:{id}" 命名空间（如 manual:42）则不重复加前缀。
        if obs.external_job_id.startswith(f"{obs.source}:"):
            return obs.external_job_id
        return f"{obs.source}:{obs.external_job_id}"
    basis = f"{obs.source}|{obs.source_url}|{obs.title}|{obs.company}"
    return f"{obs.source}:{hashlib.sha256(basis.encode()).hexdigest()[:32]}"


def observation_to_ingest_item(
    obs: JobObservation,
    *,
    batch_id: Optional[str] = None,
) -> dict[str, Any]:
    """JobObservation → JobIngestItem 兼容 dict（job_ingest.py 会再做校验）。"""
    salary_min, salary_max = _parse_salary(obs.salary)
    return {
        "title": obs.title.strip(),
        "company": obs.company.strip(),
        "location": obs.location.strip(),
        "url": obs.source_url.strip(),
        "apply_url": obs.source_url.strip(),
        "source": obs.source,
        "raw_description": obs.description.strip(),
        # 真实发布日期只认源数据；未知则 None，绝不拿 captured_at 冒充。
        # 采集时间留在 obs.captured_at / metadata["captured_at_age_seconds"]，
        # 不进 ingest item（JobIngestItem extra=forbid）。
        "posted_at": obs.posted_at,
        "batch_id": batch_id,
        "hash_key": _job_hash_key(obs),
        "summary": "",
        "keywords": [],
        "salary_min": salary_min,
        "salary_max": salary_max,
        "salary_text": obs.salary.strip(),
        "education": obs.education.strip(),
        "experience": obs.experience.strip(),
        "job_type": str(obs.metadata.get("job_type") or ""),
        "company_size": str(obs.metadata.get("company_size") or ""),
        "company_industry": str(obs.metadata.get("company_industry") or ""),
        "company_logo": "",
        "is_campus": bool(obs.metadata.get("is_campus", False)),
    }


def observations_to_ingest(
    observations: list[JobObservation],
    *,
    batch_id: Optional[str] = None,
) -> list[dict[str, Any]]:
    """批量转换；跳过缺 title/company 的无效观测。"""
    return [
        observation_to_ingest_item(o, batch_id=batch_id)
        for o in observations
        if o.title.strip() and o.company.strip()
    ]
