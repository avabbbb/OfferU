"""Shared, route-independent helpers for resume tailoring.

The legacy optimize HTTP route used to own these helpers while Agent and
domain services imported them back from the route module.  Keeping the
deterministic shaping and fact-gate helpers here preserves one implementation
for all callers and keeps the web layer at the edge of the dependency graph.
"""

from __future__ import annotations

import json
import logging
import re
from collections import Counter, defaultdict
from typing import Any, Iterable

from app.models.models import ProfileSection
from app.services.resume_fact_gates import validate_resume_fact_gates
from app.services.security_redaction import redact_sensitive_text, safe_error_message


_logger = logging.getLogger(__name__)


STOPWORDS = {
    "and", "the", "for", "with", "you", "your", "that", "this", "have",
    "from", "will", "are", "was", "our", "职位", "岗位", "负责", "要求",
    "能力", "熟悉", "相关", "以上", "优先", "具备",
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
    import jieba

    text = (text or "").lower()
    en_words = re.findall(r"[a-zA-Z][a-zA-Z0-9]*", text)
    cn_text = re.sub(r"[a-zA-Z0-9]+", " ", text)
    cn_words = [word for word in jieba.cut(cn_text) if len(word) >= 2]
    return [word for word in en_words + cn_words if word not in STOPWORDS]


def _bullet_text(section: ProfileSection) -> str:
    payload = section.content_json or {}
    if isinstance(payload, dict):
        bullet = payload.get("bullet")
        if isinstance(bullet, str) and bullet.strip():
            return bullet.strip()
    return section.title or ""


def _section_search_text(section: ProfileSection) -> str:
    payload = section.content_json or {}
    try:
        payload_text = json.dumps(payload, ensure_ascii=False)
    except Exception:
        payload_text = str(payload)
    return f"{section.title or ''} {_bullet_text(section)} {payload_text}"


def _looks_like_corrupt_placeholder_text(text: str) -> bool:
    compact = re.sub(r"\s+", "", text or "")
    if not compact:
        return False
    placeholder_count = compact.count("?") + compact.count("�")
    return placeholder_count >= 3 and placeholder_count / max(len(compact), 1) >= 0.3


def _rank_profile_sections(
    sections: list[ProfileSection],
    jd_text: str,
    limit: int = 12,
) -> list[tuple[ProfileSection, int]]:
    jd_tokens = set(_to_tokens(jd_text))
    scored: list[tuple[ProfileSection, int, float]] = []
    for section in sections:
        text = f"{section.title} {_bullet_text(section)}"
        overlap = len(jd_tokens.intersection(set(_to_tokens(text))))
        scored.append((section, overlap, float(section.confidence or 0.0)))
    scored.sort(key=lambda item: (item[1], item[2]), reverse=True)
    picked = scored[:limit] if scored else []
    if picked and picked[0][1] <= 0:
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
    """Rank sections with semantic search, falling back to deterministic matching."""

    try:
        from app.services.semantic_search import get_semantic_search

        semantic = get_semantic_search()
        results = await semantic.search_relevant_sections(
            jd_text=jd_text,
            profile_id=profile_id,
            limit=limit * 2,
            score_threshold=0.3,
        )
        semantic_scores = {item["section_id"]: item["score"] for item in results}
        keyword_scores: dict[int, float] = {}
        if use_hybrid:
            jd_tokens = set(_to_tokens(jd_text))
            for section in sections:
                text = f"{section.title} {_bullet_text(section)}"
                overlap = len(jd_tokens.intersection(set(_to_tokens(text))))
                keyword_scores[section.id] = overlap / max(len(jd_tokens), 1)

        scored: list[tuple[ProfileSection, int, float]] = []
        for section in sections:
            if section.id not in semantic_scores:
                continue
            semantic_score = semantic_scores[section.id]
            keyword_score = keyword_scores.get(section.id, 0.0) if use_hybrid else 0.0
            final_score = semantic_score * 0.7 + keyword_score * 0.3
            final_score *= section.confidence or 0.8
            scored.append((section, int(final_score * 100), final_score))
        scored.sort(key=lambda item: item[2], reverse=True)
        return [(section, score) for section, score, _ in scored[:limit]]
    except Exception as exc:
        _logger.error(
            "[Semantic Search Failed] %s, fallback to jieba",
            redact_sensitive_text(exc, max_length=500),
        )
        return _rank_profile_sections(sections, jd_text, limit)


_SECTION_TOKEN_BUDGET = 60000


async def _select_sections_structured(
    sections: list[ProfileSection],
    jd_text: str,
    profile_id: int,
    limit: int = 12,
) -> list[tuple[ProfileSection, int]]:
    """Select relevant sections using the structured LLM path with safe fallback."""

    from app.agents.llm import chat_completion, extract_json

    lines: list[str] = []
    for section in sections:
        section_type = (section.section_type or "general").lower()
        lines.append(
            f"[{section.id}] [{section_type}] {section.title or ''}: {_bullet_text(section)}"
        )
    combined = "\n".join(lines)
    if len(combined) > _SECTION_TOKEN_BUDGET:
        _logger.info(
            "[SectionSelector] %d 字符超预算，fallback Vector DB",
            len(combined),
        )
        return await _rank_profile_sections_semantic(sections, jd_text, profile_id, limit)

    system_prompt = """你是一名资深校招简历顾问。从用户全部经历条目中选出与目标岗位最相关的条目。

选择规则:
1. 仔细阅读 JD，理解岗位核心能力需求
2. 对每个条目打相关度分数 (0-100)
3. 只返回 score >= 30 的条目，最多 limit 个
4. 按 score 降序排列

输出严格 JSON:
{"selected": [{"id": 条目ID, "score": 分数, "reason": "简短理由"}]}"""
    user_prompt = (
        f"目标岗位描述:\n{jd_text[:6000]}\n\n"
        f"用户经历条目:\n{combined}\n\n请选出最相关的 {limit} 个条目。"
    )

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

        by_id = {section.id: section for section in sections}
        ranked: list[tuple[ProfileSection, int]] = []
        for item in result.get("selected", []):
            if not isinstance(item, dict):
                continue
            try:
                section_id = int(item.get("id"))
            except (TypeError, ValueError):
                continue
            try:
                score = int(item.get("score", 0))
            except (TypeError, ValueError):
                score = 0
            section = by_id.get(section_id)
            if section and score >= 30:
                ranked.append((section, score))
        if not ranked:
            raise RuntimeError("LLM 未选出任何条目")
        ranked.sort(key=lambda item: item[1], reverse=True)
        _logger.info("[SectionSelector] 结构化匹配 %d/%d", len(ranked), len(sections))
        return ranked[:limit]
    except Exception as exc:
        _logger.warning(
            "[SectionSelector] 失败: %s，fallback jieba",
            redact_sensitive_text(exc, max_length=500),
        )
        return _rank_profile_sections(sections, jd_text, limit)


def _keywords_from_bullets(texts: Iterable[str], limit: int = 10) -> list[str]:
    words: list[str] = []
    for text in texts:
        words.extend(_to_tokens(text))
    return [token for token, _ in Counter(words).most_common(limit)] if words else []


def _missing_keywords(job_text: str, used_texts: Iterable[str], limit: int = 8) -> list[str]:
    job_counter = Counter(_to_tokens(job_text))
    used = set(_to_tokens(" ".join(used_texts)))
    return [token for token, _ in job_counter.most_common() if token not in used][:limit]


def _build_resume_sections(selected: list[ProfileSection]) -> list[dict]:
    grouped: dict[str, list[dict]] = defaultdict(list)
    grouped_source_ids: dict[str, list[int]] = defaultdict(list)

    for section in selected:
        mapped = SECTION_TYPE_MAP.get((section.section_type or "general").lower(), "custom")
        bullet = _bullet_text(section)
        grouped_source_ids[mapped].append(section.id)
        payload = section.content_json or {}
        normalized = payload.get("normalized") if isinstance(payload, dict) else {}
        if not isinstance(normalized, dict):
            normalized = {}

        if mapped == "education":
            grouped[mapped].append({
                "school": normalized.get("school") or section.title or "教育经历",
                "degree": normalized.get("degree", ""),
                "major": normalized.get("major", ""),
                "description": normalized.get("description") or bullet,
            })
        elif mapped == "experience":
            grouped[mapped].append({
                "company": normalized.get("company") or section.title or "实践经历",
                "position": normalized.get("position", ""),
                "description": normalized.get("description") or bullet,
            })
        elif mapped == "project":
            grouped[mapped].append({
                "name": normalized.get("name") or section.title or "项目经历",
                "role": normalized.get("role", ""),
                "description": normalized.get("description") or bullet,
            })
        elif mapped == "skill":
            items = (normalized.get("items") if isinstance(normalized, dict) else None) or []
            if not items:
                items = _keywords_from_bullets([bullet], limit=8)
            if not items:
                items = [bullet] if bullet else []
            grouped[mapped].append({"category": section.title or "核心技能", "items": items})
        else:
            grouped[mapped].append({
                "subtitle": section.title or "补充亮点",
                "description": bullet,
            })

    rows: list[dict] = []
    for index, section_type in enumerate(("education", "experience", "project", "skill", "custom")):
        content = grouped.get(section_type)
        if not content:
            continue
        rows.append({
            "section_type": section_type,
            "title": SECTION_TITLE_MAP[section_type],
            "sort_order": index,
            "visible": True,
            "content_json": content,
            "source_section_ids": grouped_source_ids.get(section_type, []),
        })
    return rows


_RESUME_JSON_DESC_LIMIT = 300


def _safe_str(value: object) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return value.strip()
    return str(value).strip()


def _rows_to_resume_json(rows: list[dict]) -> str:
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
                entry.update({key: item.get(key, "") for key in ("school", "degree", "major")})
                desc = _safe_str(item.get("description"))
                if desc:
                    entry["desc"] = desc[:_RESUME_JSON_DESC_LIMIT]
            elif section_type == "experience":
                entry.update({key: item.get(key, "") for key in ("company", "position")})
                desc = _safe_str(item.get("description"))
                if desc:
                    entry["desc"] = desc[:_RESUME_JSON_DESC_LIMIT]
            elif section_type == "project":
                entry.update({key: item.get(key, "") for key in ("name", "role")})
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
                parts.append(f"- {item.get('school', '')} | {item.get('degree', '')} | {item.get('major', '')}")
                if item.get("description"):
                    parts.append(f"  {item['description']}")
            elif section_type == "experience":
                parts.append(f"- {item.get('company', '')} | {item.get('position', '')}")
                if item.get("description"):
                    parts.append(f"  {item['description']}")
            elif section_type == "project":
                parts.append(f"- {item.get('name', '')} | {item.get('role', '')}")
                if item.get("description"):
                    parts.append(f"  {item['description']}")
            elif section_type == "skill":
                items = item.get("items", [])
                if isinstance(items, list):
                    parts.append(f"- {item.get('category', '')}: {', '.join(str(value) for value in items)}")
            else:
                if item.get("subtitle"):
                    parts.append(f"- {item['subtitle']}")
                if item.get("description"):
                    parts.append(f"  {item['description']}")
        parts.append("")
    return "\n".join(parts)


def _desc_key_for_section_type(section_type: str) -> str | None:
    return "description" if section_type in ("education", "experience", "project", "custom") else None


def _label_for_item(section_type: str, item: dict) -> str:
    if section_type == "education":
        return item.get("school", "")
    if section_type == "experience":
        return item.get("company", "")
    if section_type == "project":
        return item.get("name", "")
    return item.get("subtitle", "")


def _apply_skill_suggestion(item: dict, original: str, suggested: str) -> dict | None:
    items = item.get("items", [])
    if not isinstance(items, list):
        return None
    new_items = [suggested if isinstance(value, str) and value == original else value for value in items]
    if new_items != items:
        new_item = dict(item)
        new_item["items"] = new_items
        return new_item
    category = item.get("category")
    if isinstance(category, str) and original in category:
        new_item = dict(item)
        new_item["category"] = category.replace(original, suggested, 1)
        return new_item
    return None


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
                if not isinstance(item, dict) or matched:
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
                if desc_key and isinstance(item.get(desc_key), str) and original in item[desc_key]:
                    new_item = dict(item)
                    new_item[desc_key] = item[desc_key].replace(original, suggested, 1)
                    new_content.append(new_item)
                    matched = True
                    continue
                new_content.append(item)
            row["content_json"] = new_content
    return result


def _apply_reorder_to_rows(rows: list[dict], reorder_result: dict) -> list[dict]:
    suggested_order = reorder_result.get("suggested_order", [])
    if not isinstance(suggested_order, list) or not suggested_order:
        return rows
    title_to_row = {row.get("title", ""): row for row in rows if row.get("title", "")}
    reordered = [dict(title_to_row.pop(title)) for title in suggested_order if title in title_to_row]
    reordered.extend(dict(row) for row in title_to_row.values())
    for index, row in enumerate(reordered):
        row["sort_order"] = index
    return reordered


def _fact_gates_validate(rows: list[dict], source_sections: list[ProfileSection]) -> dict:
    """Run the deterministic gate shared by all resume proposal surfaces."""

    try:
        return validate_resume_fact_gates(rows, source_sections)
    except Exception as exc:
        return {"status": "error", "error": safe_error_message(exc)}


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
    """Rewrite assembled resume sections, preserving the original rows on failure."""

    from app.agents.llm import chat_completion, extract_json

    compact_sections = [
        {
            "section_type": row["section_type"],
            "title": row["title"],
            "content_json": row["content_json"],
        }
        for row in rows
    ]
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
        _logger.warning(
            "LLM rewrite failed, using original rows: %s",
            redact_sensitive_text(exc, max_length=500),
        )
        return rows, False

    parsed = extract_json(raw or "")
    if not isinstance(parsed, dict):
        _logger.warning("LLM rewrite returned non-dict, using original rows")
        return rows, False
    rewritten = parsed.get("sections")
    if not isinstance(rewritten, list) or not rewritten:
        return rows, False

    result: list[dict] = []
    for index, row in enumerate(rows):
        new_row = dict(row)
        if index < len(rewritten) and isinstance(rewritten[index], dict):
            llm_content = rewritten[index].get("content_json")
            if isinstance(llm_content, list) and llm_content:
                new_row["content_json"] = llm_content
        result.append(new_row)
    return result, True


async def _skills_pipeline_rewrite(
    rows: list[dict],
    jd_text: str,
    research_context: dict[str, Any] | None = None,
) -> tuple[list[dict], bool, dict]:
    """Run the existing skill pipeline and retain a deterministic fallback."""

    from app.agents.skills import SkillPipeline

    pipeline_result: dict = {}
    resume_text = _rows_to_resume_json(rows)
    if not resume_text.strip() or not jd_text.strip():
        return rows, False, pipeline_result

    try:
        pipeline_result = await SkillPipeline().run(
            resume_text=resume_text,
            resume_data=None,
            jd_text=jd_text,
            research_context=research_context,
        )
    except Exception as exc:
        _logger.warning(
            "SkillPipeline.run failed: %s",
            redact_sensitive_text(exc, max_length=500),
        )
        pipeline_result = {"pipeline_error": {"error": safe_error_message(exc)}}

    rewrite_applied = False
    content_rewrite = pipeline_result.get("content_rewrite", {})
    if isinstance(content_rewrite, dict) and "suggestions" in content_rewrite:
        suggestions = content_rewrite.get("suggestions", [])
        if suggestions:
            rows = _apply_suggestions_to_rows(rows, suggestions)
            rewrite_applied = True

    section_reorder = pipeline_result.get("section_reorder", {})
    if isinstance(section_reorder, dict) and "suggested_order" in section_reorder:
        if section_reorder.get("current_order", []) != section_reorder.get("suggested_order", []):
            rows = _apply_reorder_to_rows(rows, section_reorder)

    if not rewrite_applied:
        rows, fallback_applied = await _llm_rewrite_sections(rows, jd_text)
        if fallback_applied:
            rewrite_applied = True
            pipeline_result["fallback_to_simple_rewrite"] = True

    return rows, rewrite_applied, pipeline_result


__all__ = [
    "_apply_reorder_to_rows",
    "_apply_suggestions_to_rows",
    "_build_resume_sections",
    "_bullet_text",
    "_fact_gates_validate",
    "_looks_like_corrupt_placeholder_text",
    "_missing_keywords",
    "_ordered_unique_ids",
    "_rank_profile_sections",
    "_rows_to_resume_json",
    "_rows_to_resume_text",
    "_section_search_text",
    "_select_sections_structured",
    "_skills_pipeline_rewrite",
    "_to_tokens",
]
