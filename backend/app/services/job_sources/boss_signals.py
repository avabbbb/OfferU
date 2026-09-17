"""BOSS 投递记录 → ExternalProgressSignal 桥接。

BOSS adapter 读出投递状态后，归一化为 `ingest_application_signal` 的
channel="boss" 信号，走既有 candidate → 用户确认 → stage event 管道。
平台状态是证据，OfferU Career Event 才是事实跃迁。
"""

from __future__ import annotations

from typing import Any

from app.services.application_progress import ingest_application_signal

# BOSS 投递状态 → OfferU stage_hint 的保守映射。
# 不确定的状态一律映射为 "unknown"，交给规则/LLM 分类与用户确认。
_BOSS_STAGE_HINT: dict[str, str] = {
    "已投递": "applied",
    "已查看": "applied",          # 简历被查看，仍是 applied 阶段的佐证
    "感兴趣": "interview_1",      # 招聘方主动表达兴趣 → 面试前信号
    "邀面试": "interview_1",
    "面试": "interview_1",
    "不合适": "rejected",
    "已拒绝": "rejected",
    "offer": "offer",
    "已录用": "offer",
}


async def ingest_boss_application_record(
    *,
    account_ref: str,
    record: dict[str, Any],
) -> dict[str, Any]:
    """把一条 BOSS 投递记录归一化为 ExternalProgressSignal + candidate。

    `record` 是 adapter 读出的平台投递项；字段名按 boss-agent-cli schema
    做防御性读取，缺字段退化为 unknown 而不是抛错。
    """
    ext_id = str(
        record.get("application_id")
        or record.get("geek_apply_id")
        or record.get("job_id")
        or record.get("security_id")
        or ""
    )
    boss_status = str(record.get("status") or record.get("state") or "").strip()
    job_title = str(record.get("job_title") or record.get("title") or "").strip()
    company = str(record.get("company") or record.get("brand_name") or "").strip()
    occurred = str(record.get("updated_at") or record.get("applied_at") or record.get("time") or "")

    subject = f"{company} {job_title} 投递进展".strip()
    body = (
        f"BOSS 平台投递记录：{company} / {job_title}\n"
        f"平台状态：{boss_status}\n"
        f"原始记录 ID：{ext_id}"
    ).strip()
    stage_hint = _BOSS_STAGE_HINT.get(boss_status, "unknown")

    return await ingest_application_signal(
        channel="boss",
        account_ref=account_ref,
        external_message_id=ext_id or f"boss-{company}-{job_title}",
        sender="BOSS Zhipin",
        subject=subject,
        body=body,
        external_thread_id=str(record.get("thread_id") or record.get("chat_id") or ""),
        received_at=occurred,
        stage_hint=stage_hint,
    )
