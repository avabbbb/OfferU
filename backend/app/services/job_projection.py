from __future__ import annotations

import re
from typing import Any, Optional

from sqlalchemy import select

from app.database import async_session
from app.models.models import Job
from app.services.career_memory import derive_career_model


_STOPWORDS = frozenset(
    {
        "以及",
        "负责",
        "我们",
        "岗位",
        "工作",
        "要求",
        "具备",
        "能够",
        "相关",
        "优先",
        "the",
        "and",
        "for",
        "with",
        "your",
        "you",
        "will",
        "are",
        "job",
        "role",
        "this",
        "that",
    }
)
_WORD_RE = re.compile(r"[a-z][a-z0-9]{2,29}")
_CJK_RE = re.compile(r"[\u4e00-\u9fff]{2,6}")


def _text_tokens(text: str) -> set[str]:
    """从一段文本提取相关性匹配 token：英文词 + 中文 4 字滑窗。"""
    tokens: set[str] = set()
    lower = text.lower()
    for match in _WORD_RE.finditer(lower):
        token = match.group(0)
        if token not in _STOPWORDS:
            tokens.add(token)
    for chunk in _CJK_RE.findall(text):
        if chunk in _STOPWORDS:
            continue
        width = min(4, len(chunk))
        for start in range(0, len(chunk) - width + 1):
            tokens.add(chunk[start : start + width])
    return tokens


def _entry_text(entry: Any) -> str:
    """拼接条目参与相关性匹配的文本（标题 + content_json 的全部字符串值）。"""
    title = entry.get("title") if isinstance(entry, dict) else getattr(entry, "title", "")
    content = (
        entry.get("content_json")
        if isinstance(entry, dict)
        else getattr(entry, "content_json", None)
    )
    parts: list[str] = [str(title or "")]
    if isinstance(content, dict):
        stack: list[Any] = [content]
        while stack:
            value = stack.pop()
            if isinstance(value, dict):
                stack.extend(value.values())
            elif isinstance(value, list):
                stack.extend(value)
            elif isinstance(value, str):
                parts.append(value)
    return "\n".join(parts)


def rank_entries_by_jd(jd_text: str, entries: list[dict[str, Any]]) -> dict[int, int]:
    """确定性岗位相关性打分：条目与 JD 文本的 token 共现数（不调用模型）。

    返回 {entry_id: relevance}；未命中条目返回 0。用于把投影的核心选择语义
    提供给同一事务内的下游读取，不修改长期职业模型。
    """
    jd_tokens = _text_tokens(jd_text)
    if not jd_tokens:
        return {int(entry["id"]): 0 for entry in entries}
    relevance: dict[int, int] = {}
    for entry in entries:
        entry_tokens = _text_tokens(_entry_text(entry))
        relevance[int(entry["id"])] = len(entry_tokens & jd_tokens)
    return relevance


def _jd_text(job: Job) -> str:
    """组装岗位相关性匹配文本：标题、摘要与原始 JD 描述。"""
    return " ".join(
        part
        for part in (
            job.title or "",
            job.summary or "",
            job.raw_description or "",
        )
        if part
    )


async def build_job_projection(
    *,
    job_id: int,
) -> dict[str, Any]:
    """面向一个具体岗位生成岗位职业投影（ADR-0048）。

    从当前职业模型（仅有效条目）中选择相关职业证据、偏好和已验证方向，
    组织成该岗位的临时视图；不修改长期职业模型。
    返回 entries 全部有效条目（带 relevance 与 selected），invalidated_entries 为失效审计。
    """
    async with async_session() as db:
        job = (
            await db.execute(select(Job).where(Job.id == job_id))
        ).scalar_one_or_none()
    if job is None:
        raise ValueError(f"Job #{job_id} not found")
    model = await derive_career_model()
    entries = list(model.get("entries") or [])
    jd_text = _jd_text(job)
    relevance = rank_entries_by_jd(jd_text, entries)
    selected_ids: set[int] = set()
    for entry in entries:
        entry_id = int(entry["id"])
        score = relevance.get(entry_id, 0)
        entry["relevance"] = score
        entry["selected"] = score > 0
        if score > 0:
            selected_ids.add(entry_id)
    ordered = sorted(
        entries,
        key=lambda item: (relevance.get(int(item["id"]), 0), int(item["id"])),
        reverse=True,
    )
    by_tier: dict[str, list[dict[str, Any]]] = {}
    for entry in ordered:
        tier = entry["tier"] or "verified_fact"
        by_tier.setdefault(tier, []).append(entry)
    return {
        "job_id": job.id,
        "job": {
            "id": job.id,
            "title": job.title,
            "company": job.company,
            "summary": job.summary,
            "keywords": job.keywords or [],
        },
        "derived_at": str(model.get("derived_at") or ""),
        "projection": by_tier,
        "entries": ordered,
        "selected_count": len(selected_ids),
        "invalidated_entries": list(model.get("invalidated_entries") or []),
    }


def reorder_sections_by_job_relevance(
    sections: list[Any],
    *,
    job_title: str,
    jd_text: str,
) -> None:
    """原地按岗位相关性排序 ProfileSection 列表（投影核心语义，不修改模型）。

    relevance 降序，同分按 sort_order 升序；JD 无可用 token 时不改变顺序。
    供下游在同一事务内消费，避免嵌套会话。
    """
    if not sections:
        return
    jd_tokens = _text_tokens(f"{job_title}\n{jd_text}")
    if not jd_tokens:
        return

    def _score(section: Any) -> int:
        return len(_text_tokens(_entry_text(section)) & jd_tokens)

    sections.sort(key=lambda item: (-_score(item), item.sort_order, item.id))
