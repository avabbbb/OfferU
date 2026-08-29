# =============================================
# Optimize 路由 — Profile 驱动的单岗位简历优化提案工作区
# =============================================
# POST /api/optimize/generate
# 输入：job_ids + mode
# 输出：SSE progress/result/error/done（result 为待审核提案，不创建正式简历）
# =============================================

from __future__ import annotations

import json
import logging
import re
from collections import Counter, defaultdict
from typing import Iterable, Literal

import jieba
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.models.models import Job, Profile, ProfileSection

router = APIRouter()
_logger = logging.getLogger(__name__)

STOPWORDS = {
    "and",
    "the",
    "for",
    "with",
    "you",
    "your",
    "that",
    "this",
    "have",
    "from",
    "will",
    "are",
    "was",
    "our",
    "职位",
    "岗位",
    "负责",
    "要求",
    "能力",
    "熟悉",
    "相关",
    "以上",
    "优先",
    "具备",
}

SECTION_TYPE_MAP = {
    "education": "education",
    "experience": "experience",
    "internship": "experience",
    "custom:c_internship": "experience",
    "project": "project",
    "activity": "custom",
    "competition": "custom",
    "skill": "skill",
    "certificate": "skill",
    "language": "skill",
    "honor": "custom",
    "general": "custom",
    "custom": "custom",
    "custom:c_awards": "custom",
    "custom:c_personal": "custom",
    "custom:c_generic": "custom",
}

SECTION_TITLE_MAP = {
    "education": "教育经历",
    "experience": "实践经历",
    "project": "项目经历",
    "skill": "技能清单",
    "custom": "补充亮点",
}

MAX_OPTIMIZE_JOB_COUNT = 20


class OptimizeGenerateRequest(BaseModel):
    job_ids: list[int] = Field(..., min_length=1, max_length=200)
    mode: Literal["per_job", "combined"] = "per_job"
    reference_resume_id: int | None = None


def _ordered_unique_ids(ids: list[int]) -> list[int]:
    seen: set[int] = set()
    ordered: list[int] = []
    for item in ids:
        if item in seen:
            continue
        seen.add(item)
        ordered.append(item)
    return ordered


def _to_tokens(text: str) -> list[str]:
    text = (text or "").lower()
    # 英文/数字词组（保持完整，如 "aigc", "comfyui"）
    en_words = re.findall(r"[a-zA-Z][a-zA-Z0-9]*", text)
    # 中文：jieba 分词
    cn_text = re.sub(r"[a-zA-Z0-9]+", " ", text)  # 去英文后分词
    cn_words = [w for w in jieba.cut(cn_text) if len(w) >= 2]
    words = en_words + cn_words
    return [w for w in words if w not in STOPWORDS]


def _bullet_text(section: ProfileSection) -> str:
    payload = section.content_json or {}
    if isinstance(payload, dict):
        bullet = payload.get("bullet")
        if isinstance(bullet, str) and bullet.strip():
            return bullet.strip()
    return section.title or ""


def _looks_like_corrupt_placeholder_text(text: str) -> bool:
    compact = re.sub(r"\s+", "", text or "")
    if not compact:
        return False
    placeholder_count = compact.count("?") + compact.count("�")
    return placeholder_count >= 3 and placeholder_count / max(len(compact), 1) >= 0.3


def _section_search_text(section: ProfileSection) -> str:
    payload = section.content_json or {}
    try:
        payload_text = json.dumps(payload, ensure_ascii=False)
    except Exception:
        payload_text = str(payload)
    return f"{section.title or ''} {_bullet_text(section)} {payload_text}"


def _rank_profile_sections(sections: list[ProfileSection], jd_text: str, limit: int = 12) -> list[tuple[ProfileSection, int]]:
    """
    使用 jieba 分词的关键词匹配（旧版本，保留作为 fallback）
    """
    jd_tokens = set(_to_tokens(jd_text))
    scored: list[tuple[ProfileSection, int, float]] = []

    for section in sections:
        text = f"{section.title} {_bullet_text(section)}"
        overlap = len(jd_tokens.intersection(set(_to_tokens(text))))
        scored.append((section, overlap, float(section.confidence or 0.0)))

    scored.sort(key=lambda item: (item[1], item[2]), reverse=True)
    picked = scored[:limit] if scored else []

    if picked and picked[0][1] <= 0:
        # JD 与档案几乎无词面重叠时，退化为按置信度挑选
        scored.sort(key=lambda item: item[2], reverse=True)
        picked = scored[:limit]

    return [(section, overlap) for section, overlap, _ in picked]


async def _rank_profile_sections_semantic(
    sections: list[ProfileSection],
    jd_text: str,
    profile_id: int,
    limit: int = 12,
    use_hybrid: bool = True,
) -> list[tuple[ProfileSection, int]]:
    """
    使用 Vector DB 的语义搜索（新版本，2026 年标准）

    参数:
      sections: 待排序的 Profile Sections
      jd_text: 岗位描述文本
      profile_id: Profile ID（用于过滤）
      limit: 返回数量
      use_hybrid: 是否混合关键词匹配（提升精度）

    返回: [(ProfileSection, score), ...]（score 范围 0-100）
    """
    try:
        from app.services.semantic_search import get_semantic_search
        semantic = get_semantic_search()

        # 1. 语义搜索（Vector DB）
        results = await semantic.search_relevant_sections(
            jd_text=jd_text,
            profile_id=profile_id,
            limit=limit * 2,  # 先召回 2 倍数量
            score_threshold=0.3,  # 相关度 > 0.3
        )

        # 2. 构建 section_id → score 映射
        semantic_scores = {r['section_id']: r['score'] for r in results}

        # 3. 如果启用混合模式，结合关键词匹配
        if use_hybrid:
            keyword_scores = {}
            jd_tokens = set(_to_tokens(jd_text))
            for section in sections:
                text = f"{section.title} {_bullet_text(section)}"
                overlap = len(jd_tokens.intersection(set(_to_tokens(text))))
                keyword_scores[section.id] = overlap / max(len(jd_tokens), 1)  # 归一化到 0-1

        # 4. 混合打分并排序
        scored = []
        for section in sections:
            if section.id not in semantic_scores:
                continue  # 语义搜索没召回，直接跳过

            # 混合权重：语义搜索 70%，关键词匹配 30%
            semantic_score = semantic_scores[section.id]
            keyword_score = keyword_scores.get(section.id, 0.0) if use_hybrid else 0.0
            final_score = semantic_score * 0.7 + keyword_score * 0.3

            # 置信度加权（低置信度的条目降权）
            confidence_weight = section.confidence or 0.8
            final_score *= confidence_weight

            scored.append((section, int(final_score * 100), final_score))

        # 5. 排序并返回 top-K
        scored.sort(key=lambda item: item[2], reverse=True)
        return [(section, score) for section, score, _ in scored[:limit]]

    except Exception as e:
        _logger.error(f"[Semantic Search Failed] {e}, fallback to jieba")
        # Fallback 到 jieba 分词
        return _rank_profile_sections(sections, jd_text, limit)


# sections 文本超过此字符数则 fallback 到 Vector DB（约 90k token）
_SECTION_TOKEN_BUDGET = 60000


async def _select_sections_structured(
    sections: list[ProfileSection],
    jd_text: str,
    profile_id: int,
    limit: int = 12,
) -> list[tuple[ProfileSection, int]]:
    """
    结构化数据匹配 — 所有 ProfileSections 直接喂 LLM 选择（2026 方案）
    替代 Vector DB 语义召回；超 token 预算时 fallback 到 Vector DB。
    """
    from app.agents.llm import chat_completion, extract_json

    lines: list[str] = []
    for s in sections:
        stype = (s.section_type or "general").lower()
        bullet = _bullet_text(s)
        lines.append(f"[{s.id}] [{stype}] {s.title or ''}: {bullet}")
    combined = "\n".join(lines)

    if len(combined) > _SECTION_TOKEN_BUDGET:
        _logger.info("[SectionSelector] %d 字符超预算，fallback Vector DB", len(combined))
        return await _rank_profile_sections_semantic(sections, jd_text, profile_id, limit)

    system_prompt = """你是一名资深校招简历顾问。从用户全部经历条目中选出与目标岗位最相关的条目。

选择规则:
1. 仔细阅读 JD，理解岗位核心能力需求
2. 对每个条目打相关度分数 (0-100)
3. 只返回 score >= 30 的条目，最多 limit 个
4. 按 score 降序排列

输出严格 JSON:
{"selected": [{"id": 条目ID, "score": 分数, "reason": "简短理由"}]}"""

    user_prompt = f"目标岗位描述:\n{jd_text[:6000]}\n\n用户经历条目:\n{combined}\n\n请选出最相关的 {limit} 个条目。"

    try:
        raw = await chat_completion(
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ],
            temperature=0.1,
            json_mode=True,
            max_tokens=2048,
            tier="fast",
        )
        if not raw:
            raise RuntimeError("LLM 返回空")

        result = extract_json(raw)
        if not result or "selected" not in result:
            raise RuntimeError("LLM 返回格式异常")

        id_to_section = {s.id: s for s in sections}
        ranked: list[tuple[ProfileSection, int]] = []
        for item in result.get("selected", []):
            raw_id = item.get("id")
            try:
                sid = int(raw_id)
            except (TypeError, ValueError):
                continue
            score = int(item.get("score", 0))
            section = id_to_section.get(sid)
            if section and score >= 30:
                ranked.append((section, score))

        if not ranked:
            raise RuntimeError("LLM 未选出任何条目")

        ranked.sort(key=lambda x: x[1], reverse=True)
        _logger.info("[SectionSelector] 结构化匹配 %d/%d", len(ranked), len(sections))
        return ranked[:limit]

    except Exception as e:
        _logger.warning("[SectionSelector] 失败: %s，fallback jieba", e)
        return _rank_profile_sections(sections, jd_text, limit)


def _keywords_from_bullets(texts: Iterable[str], limit: int = 10) -> list[str]:
    words: list[str] = []
    for text in texts:
        words.extend(_to_tokens(text))
    if not words:
        return []
    counter = Counter(words)
    return [token for token, _ in counter.most_common(limit)]


def _missing_keywords(job_text: str, used_texts: Iterable[str], limit: int = 8) -> list[str]:
    job_counter = Counter(_to_tokens(job_text))
    used = set(_to_tokens(" ".join(used_texts)))
    missing = [token for token, _ in job_counter.most_common() if token not in used]
    return missing[:limit]


def _build_resume_sections(selected: list[ProfileSection]) -> list[dict]:
    grouped: dict[str, list[dict]] = defaultdict(list)
    grouped_source_ids: dict[str, list[int]] = defaultdict(list)

    for section in selected:
        mapped = SECTION_TYPE_MAP.get((section.section_type or "general").lower(), "custom")
        bullet = _bullet_text(section)
        grouped_source_ids[mapped].append(section.id)

        if mapped == "education":
            payload = section.content_json or {}
            normalized = payload.get("normalized") if isinstance(payload, dict) else {}
            if not isinstance(normalized, dict):
                normalized = {}
            grouped[mapped].append(
                {
                    "school": normalized.get("school") or section.title or "教育经历",
                    "degree": normalized.get("degree", ""),
                    "major": normalized.get("major", ""),
                    "description": normalized.get("description") or bullet,
                }
            )
            continue

        if mapped == "experience":
            payload = section.content_json or {}
            normalized = payload.get("normalized") if isinstance(payload, dict) else {}
            if not isinstance(normalized, dict):
                normalized = {}
            grouped[mapped].append(
                {
                    "company": normalized.get("company") or section.title or "实践经历",
                    "position": normalized.get("position", ""),
                    "description": normalized.get("description") or bullet,
                }
            )
            continue

        if mapped == "project":
            payload = section.content_json or {}
            normalized = payload.get("normalized") if isinstance(payload, dict) else {}
            if not isinstance(normalized, dict):
                normalized = {}
            grouped[mapped].append(
                {
                    "name": normalized.get("name") or section.title or "项目经历",
                    "role": normalized.get("role", ""),
                    "description": normalized.get("description") or bullet,
                }
            )
            continue

        if mapped == "skill":
            # 优先使用 normalized.items（保持完整技能名如 "Cursor Vibe Coding"）
            payload = section.content_json or {}
            normalized = payload.get("normalized") if isinstance(payload, dict) else None
            items = (normalized.get("items") if isinstance(normalized, dict) else None) or []
            if not items:
                items = _keywords_from_bullets([bullet], limit=8)
            if not items:
                items = [bullet] if bullet else []
            grouped[mapped].append(
                {
                    "category": section.title or "核心技能",
                    "items": items,
                }
            )
            continue

        grouped[mapped].append(
            {
                "subtitle": section.title or "补充亮点",
                "description": bullet,
            }
        )

    ordered_types = ["education", "experience", "project", "skill", "custom"]
    rows: list[dict] = []
    for index, section_type in enumerate(ordered_types):
        content = grouped.get(section_type)
        if not content:
            continue
        rows.append(
            {
                "section_type": section_type,
                "title": SECTION_TITLE_MAP[section_type],
                "sort_order": index,
                "visible": True,
                "content_json": content,
                "source_section_ids": grouped_source_ids.get(section_type, []),
            }
        )
    return rows


_REWRITE_SYSTEM_PROMPT = """你是一位资深 HR 顾问。请根据目标岗位 JD，改写候选人的简历各模块内容，使其更匹配岗位要求。

## 规则
1. **保留所有事实和数字**，严禁编造经历或虚构数据
2. **STAR 改写**：用 Situation-Task-Action-Result 结构优化描述
3. **关键词注入**：将 JD 中的关键技能词自然融入描述（不要生硬堆砌）
4. **量化优化**：只能保留候选人原始证据中已有的数字；不得新增数字、占位符或暗示性量化
5. **教育经历**：一般不改写，原样保留
6. **技能清单**：可根据 JD 调整顺序，将 JD 匹配的技能排前面

## 输入
你会收到 JSON 格式的 resume_sections 和 jd_text。

## 输出
返回严格 JSON，格式同 resume_sections，但 content_json 中的描述文本已改写：
{"sections": [同输入结构，description/bullet 已优化]}"""


async def _llm_rewrite_sections(rows: list[dict], jd_text: str) -> tuple[list[dict], bool]:
    """调 LLM 对已组装的简历 sections 做 JD 定制化改写。
    返回 (rows, rewrite_applied: bool)。失败时 rewrite_applied=False。"""
    from app.agents.llm import chat_completion, extract_json

    # 构建紧凑的输入（只传必要信息，控制 token）
    compact_sections = []
    for row in rows:
        compact_sections.append({
            "section_type": row["section_type"],
            "title": row["title"],
            "content_json": row["content_json"],
        })

    user_content = json.dumps(
        {"resume_sections": compact_sections, "jd_text": jd_text[:4000]},
        ensure_ascii=False,
    )

    try:
        raw = await chat_completion(
            messages=[
                {"role": "system", "content": _REWRITE_SYSTEM_PROMPT},
                {"role": "user", "content": user_content},
            ],
            temperature=0.3,
            json_mode=True,
            max_tokens=4096,
            tier="standard",
        )
    except Exception as exc:
        _logger.warning("LLM rewrite failed, using original rows: %s", exc)
        return rows, False

    parsed = extract_json(raw or "")
    if not isinstance(parsed, dict):
        _logger.warning("LLM rewrite returned non-dict, using original rows")
        return rows, False

    rewritten = parsed.get("sections")
    if not isinstance(rewritten, list) or len(rewritten) == 0:
        return rows, False

    # 合并：用 LLM 返回的 content_json 替换原 rows
    result = []
    for idx, row in enumerate(rows):
        new_row = dict(row)
        if idx < len(rewritten) and isinstance(rewritten[idx], dict):
            llm_content = rewritten[idx].get("content_json")
            if isinstance(llm_content, list) and len(llm_content) > 0:
                new_row["content_json"] = llm_content
        result.append(new_row)
    return result, True


_RESUME_JSON_DESC_LIMIT = 300


def _safe_str(value: object) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return value.strip()
    return str(value).strip()


def _rows_to_resume_json(rows: list[dict]) -> str:
    """将 rows 转为紧凑的结构化 JSON，供 LLM 消费。
    比 _rows_to_resume_text 省 40-60% token，且 LLM 解析更准确。
    """
    compact: dict[str, list[dict]] = {}
    for row in rows:
        section_type = row.get("section_type", "custom")
        content_json = row.get("content_json")
        if not isinstance(content_json, list):
            continue
        items: list[dict] = []
        for item in content_json:
            if not isinstance(item, dict):
                continue
            entry: dict[str, object] = {}
            if section_type == "education":
                entry["school"] = item.get("school", "")
                entry["degree"] = item.get("degree", "")
                entry["major"] = item.get("major", "")
                desc = _safe_str(item.get("description"))
                if desc:
                    entry["desc"] = desc[:_RESUME_JSON_DESC_LIMIT]
            elif section_type == "experience":
                entry["company"] = item.get("company", "")
                entry["position"] = item.get("position", "")
                desc = _safe_str(item.get("description"))
                if desc:
                    entry["desc"] = desc[:_RESUME_JSON_DESC_LIMIT]
            elif section_type == "project":
                entry["name"] = item.get("name", "")
                entry["role"] = item.get("role", "")
                desc = _safe_str(item.get("description"))
                if desc:
                    entry["desc"] = desc[:_RESUME_JSON_DESC_LIMIT]
            elif section_type == "skill":
                entry["category"] = item.get("category", "")
                entry["items"] = item.get("items", [])
            else:
                subtitle = _safe_str(item.get("subtitle"))
                if subtitle:
                    entry["subtitle"] = subtitle
                desc = _safe_str(item.get("description"))
                if desc:
                    entry["desc"] = desc[:_RESUME_JSON_DESC_LIMIT]
            if entry:
                items.append(entry)
        if items:
            compact[section_type] = items
    return json.dumps(compact, ensure_ascii=False)


def _rows_to_resume_text(rows: list[dict]) -> str:
    parts: list[str] = []
    for row in rows:
        title = row.get("title", "")
        section_type = row.get("section_type", "")
        content_json = row.get("content_json", [])
        parts.append(f"## {title}")
        if not isinstance(content_json, list):
            continue
        for item in content_json:
            if not isinstance(item, dict):
                continue
            if section_type == "education":
                parts.append(
                    f"- {item.get('school', '')} | {item.get('degree', '')} | {item.get('major', '')}"
                )
                desc = item.get("description", "")
                if desc:
                    parts.append(f"  {desc}")
            elif section_type in ("experience",):
                parts.append(
                    f"- {item.get('company', '')} | {item.get('position', '')}"
                )
                desc = item.get("description", "")
                if desc:
                    parts.append(f"  {desc}")
            elif section_type == "project":
                parts.append(
                    f"- {item.get('name', '')} | {item.get('role', '')}"
                )
                desc = item.get("description", "")
                if desc:
                    parts.append(f"  {desc}")
            elif section_type == "skill":
                category = item.get("category", "")
                items = item.get("items", [])
                if isinstance(items, list):
                    parts.append(f"- {category}: {', '.join(str(i) for i in items)}")
            else:
                subtitle = item.get("subtitle", "")
                desc = item.get("description", "")
                if subtitle:
                    parts.append(f"- {subtitle}")
                if desc:
                    parts.append(f"  {desc}")
        parts.append("")
    return "\n".join(parts)


def _apply_suggestions_to_rows(rows: list[dict], suggestions: list[dict]) -> list[dict]:
    if not suggestions:
        return rows
    result = [dict(row) for row in rows]
    for suggestion in suggestions:
        if not isinstance(suggestion, dict):
            continue
        section_title = suggestion.get("section_title", "")
        item_label = suggestion.get("item_label", "")
        original = suggestion.get("original", "")
        suggested = suggestion.get("suggested", "")
        if not suggested or not original:
            continue
        matched = False
        for row in result:
            if row.get("title") != section_title:
                continue
            content_json = row.get("content_json", [])
            if not isinstance(content_json, list):
                continue
            new_content = []
            for item in content_json:
                if not isinstance(item, dict):
                    new_content.append(item)
                    continue
                if matched:
                    new_content.append(item)
                    continue
                section_type = row.get("section_type", "")
                if section_type == "skill":
                    new_item = _apply_skill_suggestion(item, original, suggested)
                    if new_item is not None:
                        new_content.append(new_item)
                        matched = True
                        continue
                    new_content.append(item)
                    continue
                desc_key = _desc_key_for_section_type(section_type)
                label = _label_for_item(section_type, item)
                if item_label and label != item_label:
                    new_content.append(item)
                    continue
                if desc_key and isinstance(item.get(desc_key), str):
                    old_desc = item[desc_key]
                    if original in old_desc:
                        new_item = dict(item)
                        new_item[desc_key] = old_desc.replace(original, suggested, 1)
                        new_content.append(new_item)
                        matched = True
                        continue
                new_content.append(item)
            row["content_json"] = new_content
    return result


def _desc_key_for_section_type(section_type: str) -> str | None:
    if section_type in ("education", "experience", "project", "custom"):
        return "description"
    return None


def _label_for_item(section_type: str, item: dict) -> str:
    if section_type == "education":
        return item.get("school", "")
    if section_type in ("experience",):
        return item.get("company", "")
    if section_type == "project":
        return item.get("name", "")
    return item.get("subtitle", "")


def _apply_skill_suggestion(item: dict, original: str, suggested: str) -> dict | None:
    items = item.get("items", [])
    if not isinstance(items, list):
        return None
    new_items = []
    changed = False
    for skill_item in items:
        if isinstance(skill_item, str) and skill_item == original:
            new_items.append(suggested)
            changed = True
        else:
            new_items.append(skill_item)
    if not changed:
        if isinstance(item.get("category"), str) and original in item["category"]:
            new_item = dict(item)
            new_item["category"] = item["category"].replace(original, suggested, 1)
            return new_item
        return None
    new_item = dict(item)
    new_item["items"] = new_items
    return new_item


def _apply_reorder_to_rows(rows: list[dict], reorder_result: dict) -> list[dict]:
    suggested_order = reorder_result.get("suggested_order", [])
    if not suggested_order or not isinstance(suggested_order, list):
        return rows
    title_to_row = {}
    for row in rows:
        title = row.get("title", "")
        if title:
            title_to_row[title] = row
    reordered = []
    for title in suggested_order:
        if title in title_to_row:
            reordered.append(dict(title_to_row.pop(title)))
    for title, row in title_to_row.items():
        reordered.append(dict(row))
    for idx, row in enumerate(reordered):
        row["sort_order"] = idx
    return reordered


async def _skills_pipeline_rewrite(
    rows: list[dict],
    jd_text: str,
    research_context: dict | None = None,
) -> tuple[list[dict], bool, dict]:
    from app.agents.skills import SkillPipeline

    pipeline_result: dict = {}

    resume_text = _rows_to_resume_json(rows)
    if not resume_text.strip() or not jd_text.strip():
        return rows, False, pipeline_result

    try:
        pipeline = SkillPipeline()
        pipeline_result = await pipeline.run(
            resume_text=resume_text,
            resume_data=None,
            jd_text=jd_text,
            research_context=research_context,
        )
    except Exception as exc:
        _logger.warning("SkillPipeline.run failed: %s", exc)
        pipeline_result = {
            "pipeline_error": {
                "error": str(exc)[:1000],
            }
        }

    rewrite_applied = False

    content_rewrite = pipeline_result.get("content_rewrite", {})
    if isinstance(content_rewrite, dict) and "suggestions" in content_rewrite:
        suggestions = content_rewrite.get("suggestions", [])
        if suggestions:
            rows = _apply_suggestions_to_rows(rows, suggestions)
            rewrite_applied = True

    section_reorder = pipeline_result.get("section_reorder", {})
    if isinstance(section_reorder, dict) and "suggested_order" in section_reorder:
        current_order = section_reorder.get("current_order", [])
        suggested_order = section_reorder.get("suggested_order", [])
        if current_order != suggested_order:
            rows = _apply_reorder_to_rows(rows, section_reorder)

    if not rewrite_applied:
        rows, fallback_applied = await _llm_rewrite_sections(rows, jd_text)
        if fallback_applied:
            rewrite_applied = True
            pipeline_result["fallback_to_simple_rewrite"] = True

    return rows, rewrite_applied, pipeline_result


# =============================================
# FactGates — 确定性事实验证器
# =============================================
# 代码级校验改写后的内容是否捏造了源数据中不存在的指标/公司名。
# 策略: 标记警告保留（不替换原文，只加 _gate_warnings 字段）。
# =============================================


def _extract_numbers(text: str) -> set[str]:
    """提取文本中的所有数字（百分比、纯数字、带量词数字）"""
    numbers: set[str] = set()
    for m in re.finditer(r'(\d+(?:\.\d+)?)\s*%?', text):
        numbers.add(m.group(1))
    return numbers


def _extract_source_orgs(sections: list[ProfileSection]) -> set[str]:
    """从源 ProfileSections 提取公司/学校/项目名"""
    orgs: set[str] = set()
    for s in sections:
        payload = s.content_json or {}
        if isinstance(payload, dict):
            normalized = payload.get("normalized")
            if isinstance(normalized, dict):
                for key in ("company", "school", "name", "organization"):
                    val = normalized.get(key)
                    if val and isinstance(val, str):
                        orgs.add(val.strip())
        if s.title:
            orgs.add(s.title.strip())
    return orgs


def _fact_gates_validate(
    rows: list[dict],
    source_sections: list[ProfileSection],
) -> dict:
    """Delegate all resume writes to the shared deterministic fact gate."""
    from app.services.resume_fact_gates import validate_resume_fact_gates

    return validate_resume_fact_gates(rows, source_sections)


def _profile_to_contact_json(profile: Profile) -> dict:
    # Delegated to shared service; kept for backward compatibility
    from app.services.resume_builder import _profile_to_contact_json as _impl
    return _impl(profile)


def _build_source_profile_snapshot(profile: Profile, selected: list[ProfileSection]) -> dict:
    # Delegated to shared service; kept for backward compatibility
    from app.services.resume_builder import _build_source_profile_snapshot as _impl
    return _impl(profile, selected)


def _sse(event: str, payload: dict) -> str:
    body = json.dumps(payload, ensure_ascii=False)
    return f"event: {event}\ndata: {body}\n\n"


async def _get_default_profile(db: AsyncSession) -> Profile:
    result = await db.execute(
        select(Profile).order_by(Profile.is_default.desc(), Profile.updated_at.desc())
    )
    profile = result.scalars().first()
    if not profile:
        raise HTTPException(status_code=400, detail="请先在 Profile 页面建立个人档案")
    return profile


async def _get_profile_sections(profile_id: int, db: AsyncSession) -> list[ProfileSection]:
    result = await db.execute(
        select(ProfileSection)
        .where(ProfileSection.profile_id == profile_id)
        .where(ProfileSection.tier == "verified_fact")
        .where(ProfileSection.status == "active")
        .order_by(ProfileSection.sort_order.asc(), ProfileSection.updated_at.desc())
    )
    sections = list(result.scalars().all())
    sections = [
        section for section in sections
        if not _looks_like_corrupt_placeholder_text(_section_search_text(section))
    ]
    if not sections:
        raise HTTPException(
            status_code=400,
            detail="没有 tier=verified_fact 的档案条目，请先确认至少 1 条职业事实",
        )
    return sections


@router.post("/generate")
async def optimize_generate(data: OptimizeGenerateRequest):
    """逐岗位准备可审核提案；此兼容入口不再创建正式 Resume。"""
    if data.mode == "combined":
        raise HTTPException(
            status_code=409,
            detail=(
                "综合多 JD 直写简历已停用。请逐岗位准备提案，分别核对证据、"
                "事实门和 diff 后再明确接受。"
            ),
        )

    effective_job_ids = _ordered_unique_ids(data.job_ids)
    if len(effective_job_ids) > MAX_OPTIMIZE_JOB_COUNT:
        raise HTTPException(
            status_code=400,
            detail=f"单次最多准备 {MAX_OPTIMIZE_JOB_COUNT} 个岗位提案，请分批操作",
        )

    async def _stream():
        from app.ops import execute_operation

        prepared = 0
        failed = 0
        proposal_ids: list[str] = []
        yield _sse("heartbeat", {})

        for index, job_id in enumerate(effective_job_ids, start=1):
            result = await execute_operation(
                "prepare_resume_optimization",
                {
                    "job_id": job_id,
                    "reference_resume_id": data.reference_resume_id,
                },
                dry_run=False,
                surface="optimize_generate",
            )
            outputs = result.get("outputs") if result.get("ok") else None
            if isinstance(outputs, dict) and outputs.get("proposal_id"):
                prepared += 1
                proposal_id = str(outputs["proposal_id"])
                proposal_ids.append(proposal_id)
                yield _sse(
                    "progress",
                    {
                        "index": index,
                        "total": len(effective_job_ids),
                        "job_id": job_id,
                        "job_title": outputs.get("job_title", ""),
                        "status": "prepared",
                    },
                )
                yield _sse(
                    "result",
                    {
                        "index": index,
                        "total": len(effective_job_ids),
                        "mode": "per_job",
                        "job_id": job_id,
                        "job_title": outputs.get("job_title", ""),
                        "company": outputs.get("company", ""),
                        "proposal_id": proposal_id,
                        "proposal_status": outputs.get("status", ""),
                        "fact_gate_status": outputs.get("fact_gate_status", ""),
                        "change_count": outputs.get("change_count", 0),
                        "reference_resume_id": outputs.get("reference_resume_id"),
                    },
                )
                continue

            failed += 1
            message = "；".join(str(item) for item in (result.get("errors") or []))
            yield _sse(
                "progress",
                {
                    "index": index,
                    "total": len(effective_job_ids),
                    "job_id": job_id,
                    "status": "failed",
                },
            )
            yield _sse(
                "error",
                {
                    "index": index,
                    "total": len(effective_job_ids),
                    "job_id": job_id,
                    "message": message or "岗位提案准备失败",
                },
            )

        yield _sse(
            "done",
            {
                "mode": "per_job",
                "total": len(effective_job_ids),
                "prepared": prepared,
                "failed": failed,
                "proposal_ids": proposal_ids,
            },
        )

    return StreamingResponse(
        _stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )


class ResumeProposalReviewRequest(BaseModel):
    action: Literal["accept", "reject"]
    note: str = Field(default="", max_length=2000)


@router.get("/proposals")
async def list_resume_proposals(
    job_id: int | None = None,
    status: str | None = None,
    limit: int = 20,
):
    """Expose proposal review through the same operation-controlled gateway as Agent UI."""
    return await _execute_agent_operation(
        "list_resume_optimizations",
        {"job_id": job_id, "status": status, "limit": limit},
    )


@router.get("/proposals/{proposal_id}")
async def get_resume_proposal(proposal_id: str):
    return await _execute_agent_operation(
        "get_resume_optimization",
        {"proposal_id": proposal_id},
    )


@router.post("/proposals/{proposal_id}/review")
async def review_resume_proposal(
    proposal_id: str,
    body: ResumeProposalReviewRequest,
):
    return await _execute_agent_operation(
        "review_resume_optimization",
        {
            "proposal_id": proposal_id,
            "action": body.action,
            "note": body.note,
        },
    )


# =============================================
# 对话式优化 API
# =============================================

from app.agents.optimize_agent import (
    list_sessions_from_db as _list_agent_sessions,
    get_session_detail as _get_session_detail,
)


class OptimizeAgentStartRequest(BaseModel):
    job_ids: list[int] = Field(..., min_length=1, max_length=200)
    mode: Literal["per_job", "combined"] = "per_job"
    profile_id: int | None = None
    reference_resume_id: int | None = None


class OptimizeAgentChatRequest(BaseModel):
    session_id: str
    message: str
    action: Literal["reply", "confirm", "reject", "adjust"] = "reply"
    feedback: str = ""


async def _execute_agent_operation(name: str, args: dict) -> dict:
    from app.ops import execute_operation

    result = await execute_operation(name, args, surface="optimize_api")
    if not result.get("ok"):
        detail = "；".join(str(item) for item in result.get("errors") or [])
        status = 404 if "不存在" in detail or "not found" in detail.lower() else 400
        raise HTTPException(status_code=status, detail=detail or "操作失败")
    outputs = result.get("outputs")
    if not isinstance(outputs, dict):
        raise HTTPException(status_code=502, detail="操作返回了无效结果")
    return outputs


@router.post("/agent/start")
async def optimize_agent_start(
    body: OptimizeAgentStartRequest,
):
    effective_job_ids = _ordered_unique_ids(body.job_ids)
    if body.mode != "per_job" or len(effective_job_ids) != 1:
        raise HTTPException(
            status_code=409,
            detail="对话式简历提案当前一次只支持一个岗位；综合多 JD 直写模式已停用。",
        )
    result = await _execute_agent_operation(
        "start_optimize_agent_session",
        {
            "job_ids": effective_job_ids,
            "mode": "per_job",
            "profile_id": body.profile_id,
            "reference_resume_id": body.reference_resume_id,
        },
    )
    return result


@router.post("/agent/chat")
async def optimize_agent_chat(
    body: OptimizeAgentChatRequest,
):
    return await _execute_agent_operation(
        "chat_optimize_agent_session",
        {
            "session_id": body.session_id,
            "message": body.message,
            "action": body.action,
            "feedback": body.feedback,
        },
    )


@router.post("/agent/chat/stream")
async def optimize_agent_chat_stream(
    body: OptimizeAgentChatRequest,
):
    result = await _execute_agent_operation(
        "stream_optimize_agent_session",
        {
            "session_id": body.session_id,
            "message": body.message,
            "action": body.action,
            "feedback": body.feedback,
        },
    )

    async def _stream():
        for event in result.get("events") or []:
            yield event

    return StreamingResponse(
        _stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )


@router.get("/agent/sessions")
async def optimize_agent_sessions(db: AsyncSession = Depends(get_db)):
    sessions = await _list_agent_sessions(db)
    # Batch query all job IDs at once instead of N+1 per session
    all_job_ids: list[int] = []
    for s in sessions:
        all_job_ids.extend(jid for jid in s.get("job_ids", []) if isinstance(jid, int))

    job_map: dict[int, Job] = {}
    if all_job_ids:
        unique_ids = list(set(all_job_ids))
        jobs_result = await db.execute(select(Job).where(Job.id.in_(unique_ids)))
        job_map = {j.id: j for j in jobs_result.scalars().all()}

    for s in sessions:
        job_ids = s.get("job_ids", [])
        if job_ids and not s.get("title"):
            try:
                jobs = [job_map[jid] for jid in job_ids[:3] if jid in job_map]
                if jobs:
                    titles = [
                        f"{j.company} - {j.title}" if j.company else j.title
                        for j in jobs
                    ]
                    s["title"] = "、".join(titles[:2])
                    if len(titles) > 2:
                        s["title"] += f" 等{len(titles)}个岗位"
                else:
                    s["title"] = f"优化会话 {s.get('session_id', '')[:8]}"
            except Exception:
                s["title"] = f"优化会话 {s.get('session_id', '')[:8]}"
        elif not s.get("title"):
            s["title"] = f"优化会话 {s.get('session_id', '')[:8]}"
        # Add status description
        phase = s.get("phase", "")
        status_map = {
            "confirming": "等待确认",
            "analyzing": "分析中",
            "framework": "框架设计",
            "rewriting": "改写中",
            "completed": "已完成",
        }
        s["status"] = status_map.get(phase, phase)
    return {"sessions": sessions}


@router.get("/agent/sessions/{session_id}")
async def optimize_agent_session_detail(
    session_id: str,
    db: AsyncSession = Depends(get_db),
):
    detail = await _get_session_detail(session_id, db)
    if not detail:
        raise HTTPException(status_code=404, detail="会话不存在")
    return detail


@router.delete("/agent/sessions/{session_id}")
async def optimize_agent_session_delete(
    session_id: str,
    db: AsyncSession = Depends(get_db),
):
    return await _execute_agent_operation(
        "delete_optimize_agent_session",
        {"session_id": session_id},
    )
