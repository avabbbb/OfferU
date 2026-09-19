from __future__ import annotations

import json
import re
from typing import Any

_METRIC_PATTERNS = (
    re.compile(r"\b\d+(?:\.\d+)?\s?%", re.I),
    re.compile(r"\b[$€£¥￥]\s?\d[\d,.]*(?:\s?[kmb]|万|亿)?", re.I),
    re.compile(r"\b\d+(?:\.\d+)?\s?x\b", re.I),
    re.compile(r"\b\d[\d,.]*\+?\s?(?:users|customers|clients|employees|engineers|teams|companies|hours|days|weeks|months|years|minutes|seconds|requests|tokens|documents|workflows|pipelines|agents|interviews|applications|offers|reports|cvs|resumes)\b", re.I),
    re.compile(r"\d[\d,.]*\+?\s?(?:人|位用户|名用户|客户|员工|工程师|团队|公司|小时|天|周|个月|年|分钟|秒|次请求|份文档|个流程|条流水线|个智能体|场面试|次申请|份录用|份报告|份简历)"),
    re.compile(r"(?:人民币\s*)?\d+(?:\.\d+)?\s?(?:万|亿)(?:元)?"),
)

_EVIDENCE_FIELD_KEYS = {
    "company",
    "school",
    "issuer",
    "organization",
    "name",
    "position",
    "role",
    "degree",
    "major",
    "scoreOrLevel",
    "awardName",
    "startDate",
    "endDate",
    "awardedAt",
    "date",
}

_PROPER_NOUN = re.compile(r"[A-Za-z][A-Za-z0-9]*(?:[.+#][A-Za-z0-9]+)*")

# Sentence-initial words and resume verbs are capitalized by convention, not
# because they name an entity. Keep this list small: it is better to flag a
# real claim than to silently pass an invented one.
_CLAIM_STOPWORDS = {
    "the", "a", "an", "and", "or", "of", "to", "in", "for", "on", "at", "by",
    "with", "from", "as", "is", "are", "was", "were", "be", "been", "being",
    "we", "i", "our", "my", "their", "its", "his", "her", "this", "that",
    "these", "those", "it",
    "built", "led", "designed", "developed", "improved", "created",
    "launched", "managed", "delivered", "drove", "owned", "worked",
    "responsible", "using", "used", "including", "reduced", "increased",
    "supported", "jan", "feb", "mar", "apr", "may", "jun", "jul", "aug",
    "sep", "oct", "nov", "dec",
}


def named_entity_claims(value: Any) -> set[str]:
    """Extract proper-noun claims (orgs, products, technologies) from free text.

    Catches ALLCAPS acronyms (AWS, NLP), internally-capitalized or suffixed
    tech names (GraphQL, gRPC, Node.js, C++, K8s), and TitleCase words that
    appear mid-sentence (Google, Kubernetes). Common words capitalized only
    because they start a sentence are skipped via _CLAIM_STOPWORDS plus a
    sentence-boundary check.
    """
    text = _plain(value)
    claims: set[str] = set()
    for match in _PROPER_NOUN.finditer(text):
        word = match.group(0)
        if len(word) < 2:
            continue
        if word.lower().strip(".") in _CLAIM_STOPWORDS:
            continue
        if word.isupper():
            claims.add(word)
            continue
        if any(ch.isupper() for ch in word[1:]) or any(ch in ".+#" for ch in word):
            claims.add(word)
            continue
        if word[0].isupper():
            prefix = text[: match.start()].rstrip()
            if prefix and prefix[-1] not in ".!?\n•·:;":
                claims.add(word)
    return claims


def _free_text_fields(value: Any) -> list[str]:
    """Collect free-text `description` leaves from generated rows.

    Only `description` fields are scanned: they are the free-form rewrite
    surface where an LLM can invent unquantified responsibilities and claims.
    """
    texts: list[str] = []
    if isinstance(value, dict):
        for key, item in value.items():
            if key == "description" and isinstance(item, str) and item.strip():
                texts.append(item)
            else:
                texts.extend(_free_text_fields(item))
    elif isinstance(value, list):
        for item in value:
            texts.extend(_free_text_fields(item))
    return texts



def _plain(value: Any) -> str:
    text = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False, default=str)
    text = re.sub(r"(?is)<script\b[^>]*>.*?</script\b[^>]*>", " ", text)
    text = re.sub(r"(?is)<style\b[^>]*>.*?</style\b[^>]*>", " ", text)
    return re.sub(r"<[^>]+>", " ", text)


def _compact(value: Any) -> str:
    """去空白与标点后的紧凑文本，用于回声比较。"""
    return re.sub(
        r"[\s，。、,.!！?？;；:：\"'‘’“”（）()【】\[\]·\-—]+",
        "",
        _plain(value),
    )


def _is_self_echo_source(source_facts: Any, claims: list[str]) -> bool:
    """检测来源是否为声明自身的回声（无独立可验证出处）。

    当 source 文本去掉全部声明后几乎没有剩余内容，说明来源没有
    独立信息量（典型：Agent 把用户陈述原文当来源传回）。
    """
    compact_source = _compact(source_facts)
    if not compact_source:
        return True
    # 来源过短（<16 字符）说明没有独立信息量（典型：Agent 把用户陈述
    # 原文回传），直接视为回声，不能作为 verified_fact 的来源。
    if len(compact_source) < 16:
        return True
    remainder = compact_source
    for claim in sorted(claims, key=len, reverse=True):
        compact_claim = _compact(claim)
        if compact_claim:
            remainder = remainder.replace(compact_claim, "", 1)
    return len(remainder) < 8


def metric_claims(value: Any) -> set[str]:
    text = _plain(value).lower()
    return {
        re.sub(r"[,\s]+", " ", match.group(0)).strip()
        for pattern in _METRIC_PATTERNS
        for match in pattern.finditer(text)
    }


def _normalized_claim(value: str) -> str:
    return re.sub(r"\s+", "", value.casefold().replace(".", "-").replace("/", "-"))


def _structured_claims(value: Any, *, parent_key: str = "") -> set[str]:
    claims: set[str] = set()
    if isinstance(value, dict):
        for key, item in value.items():
            if key in _EVIDENCE_FIELD_KEYS and isinstance(item, str) and item.strip():
                claims.add(item.strip())
            claims.update(_structured_claims(item, parent_key=key))
    elif isinstance(value, list):
        if parent_key == "items":
            claims.update(str(item).strip() for item in value if isinstance(item, str) and item.strip())
        else:
            for item in value:
                claims.update(_structured_claims(item, parent_key=parent_key))
    return claims


def validate_generated_content(source_facts: Any, generated: Any) -> dict[str, Any]:
    allowed = metric_claims(source_facts)
    checked = metric_claims(generated)
    unsupported = sorted(checked - allowed)
    normalized_source = _normalized_claim(_plain(source_facts))
    structured = sorted(_structured_claims(generated))
    unsupported_facts = [
        claim for claim in structured
        if _normalized_claim(claim) not in normalized_source
    ]
    warnings = [
        {"issue": "unverified_metric", "detail": f"生成内容出现来源中不存在的量化信息: {claim}"}
        for claim in unsupported
    ] + [
        {"issue": "unverified_fact", "detail": f"生成内容出现来源中不存在的结构化事实: {claim}"}
        for claim in unsupported_facts
    ]
    # 自回声来源：source 去掉全部声明后几乎没有剩余内容，说明来源只是声明的回声，
    # 没有独立可验证出处（典型：Agent 把用户陈述原文当来源传回）。
    if not warnings:
        echo_claims = list(structured)
        if isinstance(generated, dict):
            for key in ("bullet", "description", "title"):
                value = generated.get(key)
                if isinstance(value, str) and value.strip():
                    echo_claims.append(value.strip())
        if _is_self_echo_source(source_facts, echo_claims):
            warnings.append(
                {
                    "issue": "echo_source",
                    "detail": "来源只是声明自身的回声，缺少独立可验证出处；请提供真实来源材料或走记忆收件箱提案",
                }
            )
    return {
        "status": "blocked" if warnings else "passed",
        "requires_user_confirmation": bool(warnings),
        "checked_metrics": sorted(checked),
        "unsupported_metrics": unsupported,
        "checked_structured_facts": structured,
        "unsupported_structured_facts": unsupported_facts,
        "warnings": warnings,
        "warnings_count": len(warnings),
    }


def validate_resume_fact_gates(
    rows: list[dict],
    source_sections: list[Any],
    *,
    strict_structured_facts: bool = False,
) -> dict[str, Any]:
    source_payload = []
    source_orgs: set[str] = set()
    source_ids: set[int] = set()
    for section in source_sections:
        if isinstance(section, dict):
            section_id = section.get("id")
            title = section.get("title") or ""
            payload = section.get("content_json") or section
        else:
            section_id = getattr(section, "id", None)
            title = getattr(section, "title", "") or ""
            payload = getattr(section, "content_json", {}) or {}
        if isinstance(section_id, int) and not isinstance(section_id, bool):
            source_ids.add(section_id)
        source_payload.append({"title": title, "content_json": payload})
        if title:
            source_orgs.add(str(title).strip())
        normalized = payload.get("normalized") if isinstance(payload, dict) else None
        if isinstance(normalized, dict):
            source_orgs.update(
                str(normalized[key]).strip()
                for key in ("company", "school", "name", "organization")
                if normalized.get(key)
            )

    result = validate_generated_content(source_payload, rows)
    # This row-level validator keeps its established contract: metrics plus
    # organization names. Draft validation uses the broader structured checks.
    warnings = [
        warning
        for warning in result["warnings"]
        if strict_structured_facts or warning.get("issue") != "unverified_fact"
    ]
    for placeholder in ("[待量化]", "【待量化】"):
        if placeholder in _plain(rows):
            warnings.append({
                "issue": "unverified_placeholder",
                "detail": f"生成内容包含不属于职业事实的量化占位符: {placeholder}",
            })
    source_text = _plain(source_payload).lower()
    for row_index, row in enumerate(rows):
        if not isinstance(row, dict):
            warnings.append({
                "row_index": row_index,
                "issue": "invalid_row",
                "detail": "生成段落必须是对象",
            })
            continue
        row_source_ids = row.get("source_section_ids")
        if not isinstance(row_source_ids, list) or not row_source_ids:
            warnings.append({
                "section_type": row.get("section_type", ""),
                "section_title": row.get("title", ""),
                "row_index": row_index,
                "issue": "missing_provenance",
                "detail": "生成段落缺少 source_section_ids，无法回溯到已验证档案事实",
            })
        else:
            invalid_ids = sorted({
                item for item in row_source_ids
                if isinstance(item, int) and item not in source_ids
            })
            invalid_values = [
                item for item in row_source_ids
                if isinstance(item, bool) or not isinstance(item, int)
            ]
            if invalid_ids or invalid_values:
                warnings.append({
                    "section_type": row.get("section_type", ""),
                    "section_title": row.get("title", ""),
                    "row_index": row_index,
                    "issue": "invalid_provenance",
                    "detail": (
                        "生成段落引用了不属于本次已验证档案快照的来源 ID: "
                        f"{invalid_ids + invalid_values}"
                    ),
                })
        if row.get("section_type") not in {"experience", "project"}:
            continue
        org_key = "company" if row.get("section_type") == "experience" else "name"
        for index, item in enumerate(row.get("content_json") or []):
            if not isinstance(item, dict):
                continue
            organization = str(item.get(org_key) or "").strip()
            if organization and organization not in source_orgs and organization.lower() not in source_text:
                warning = {
                    "section_type": row.get("section_type"),
                    "section_title": row.get("title", ""),
                    "item_index": index,
                    "issue": "unverified_org",
                    "detail": f"改写后出现源数据中不存在的名称: {organization}",
                }
                warnings.append(warning)
                item.setdefault("_gate_warnings", []).append(f"未验证名称: {organization}")

    # Free-text `description` fields are fact-gated separately from structured
    # fields: a rewrite may not introduce quantified claims (already covered
    # by unverified_metric on the whole payload) nor new proper-noun org/tech
    # claims absent from the verified source evidence. Matching is
    # deliberately conservative: a claim is supported if it appears anywhere
    # in the source text (case-insensitive substring), so only genuinely new
    # named entities are flagged.
    unsupported_named_claims: list[str] = []
    for row_index, row in enumerate(rows):
        if not isinstance(row, dict):
            continue
        for index, item in enumerate(row.get("content_json") or []):
            if not isinstance(item, dict):
                continue
            description = item.get("description")
            if not isinstance(description, str) or not description.strip():
                continue
            for claim in sorted(named_entity_claims(description)):
                if claim.lower() in source_text:
                    continue
                unsupported_named_claims.append(claim)
                warnings.append({
                    "section_type": row.get("section_type", ""),
                    "section_title": row.get("title", ""),
                    "row_index": row_index,
                    "item_index": index,
                    "issue": "unverified_named_claim",
                    "detail": f"描述中出现来源中不存在的名称/技术声明: {claim}",
                })
                item.setdefault("_gate_warnings", []).append(
                    f"未验证描述声明: {claim}"
                )

    for warning in warnings:
        if warning.get("issue") != "unverified_metric":
            continue
        for row in rows:
            for item in row.get("content_json") or []:
                if isinstance(item, dict):
                    item.setdefault("_gate_warnings", []).append(warning["detail"])
    blocking_warnings = [
        warning
        for warning in warnings
        if warning.get("issue") != "unverified_named_claim"
    ]
    result.update({
        "unsupported_named_claims": sorted(set(unsupported_named_claims)),
        # Fuzzy named-claim matches warn and require explicit confirmation but
        # do not hard-block: a false positive must not freeze the proposal.
        "status": "blocked" if blocking_warnings else "passed",
        "requires_user_confirmation": bool(warnings),
        "warnings": warnings,
        "warnings_count": len(warnings),
        "source_metrics_count": len(metric_claims(source_payload)),
        "source_orgs_count": len(source_orgs),
        "source_section_ids_count": len(source_ids),
    })
    return result

def validate_edited_text(source_sections: list[Any], edited_text: str) -> dict[str, Any]:
    """Fact-gate a user-edited text leaf against the verified source evidence.

    Used when Edit-then-Accept supplies `edited_text`: the user's override
    bypasses the generated content, so it must re-run the same claims check
    (metrics + named entities) against the section evidence the proposal was
    built from. Returns warnings only; the caller decides whether to require
    confirmation.
    """
    source_payload = []
    for section in source_sections:
        if isinstance(section, dict):
            payload = section.get("content_json") or section
            title = section.get("title") or ""
        else:
            payload = getattr(section, "content_json", {}) or {}
            title = getattr(section, "title", "") or ""
        source_payload.append({"title": title, "content_json": payload})
    source_text = _plain(source_payload).lower()

    warnings: list[dict[str, Any]] = []
    unsupported_metrics = sorted(metric_claims(edited_text) - metric_claims(source_payload))
    for claim in unsupported_metrics:
        warnings.append({
            "issue": "unverified_metric",
            "detail": f"编辑文本出现来源中不存在的量化信息: {claim}",
        })
    unsupported_named = sorted(
        claim
        for claim in named_entity_claims(edited_text)
        if claim.lower() not in source_text
    )
    for claim in unsupported_named:
        warnings.append({
            "issue": "unverified_named_claim",
            "detail": f"编辑文本出现来源中不存在的名称/技术声明: {claim}",
        })
    return {
        "status": "flagged" if warnings else "passed",
        "requires_user_confirmation": bool(warnings),
        "unsupported_metrics": unsupported_metrics,
        "unsupported_named_claims": unsupported_named,
        "warnings": warnings,
        "warnings_count": len(warnings),
    }
