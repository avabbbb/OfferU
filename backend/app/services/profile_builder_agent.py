from __future__ import annotations

import json
import re
from typing import Any, Awaitable, Callable

from app.services.profile_schema import (
    canonicalize_profile_section_payload,
    is_valid_profile_section_type,
    normalize_section_type_alias,
)

VALID_AGENT_ACTIONS = {"ask_user", "propose_patch", "apply_patch", "generate_resume", "finish"}
PROFILE_AGENT_MAX_LOOP_STEPS = 3

FIELD_LABELS = {
    "target_role": "目标岗位",
    "target_city": "目标城市",
    "resume": "已有简历",
    "contact_info": "联系方式",
    "core_experience": "核心经历",
    "impact_metrics": "量化成果",
    "skills": "技能关键词",
}


def _as_str(value: Any) -> str:
    if value is None:
        return ""
    return str(value).strip()


def _as_text(value: Any) -> str:
    if isinstance(value, str):
        return value
    try:
        return json.dumps(value, ensure_ascii=False)
    except Exception:
        return str(value)


def _as_list(value: Any) -> list[str]:
    if value is None:
        return []
    if isinstance(value, list):
        return [_as_str(item) for item in value if _as_str(item)]
    text = _as_str(value)
    if not text:
        return []
    return [item.strip() for item in re.split(r"[,，、\n]", text) if item.strip()]


def _clamp_confidence(value: Any) -> float:
    try:
        number = float(value)
    except Exception:
        number = 0.7
    return min(max(number, 0.0), 1.0)


def _has_metric(text: str) -> bool:
    return bool(re.search(r"\d|%|％|万|千|百|kpi|KPI|增长|提升|降低|转化|排名|top", text or ""))


def _normalize_section_type(section_type: str) -> tuple[str, str | None]:
    normalized = normalize_section_type_alias(section_type or "custom")
    category_label: str | None = None
    if normalized in {"general", "activity", "competition", "award", "honor"}:
        normalized = "custom"
        category_label = "补充亮点"
    if not is_valid_profile_section_type(normalized):
        normalized = "custom"
        category_label = "补充亮点"
    return normalized, category_label


def normalize_profile_agent_section(raw_section: dict[str, Any]) -> dict[str, Any]:
    section_type, category_label = _normalize_section_type(_as_str(raw_section.get("section_type")))
    title = _as_str(raw_section.get("title"))[:220] or "待确认档案条目"
    content_json = raw_section.get("content_json")
    if not isinstance(content_json, dict):
        content_json = {"bullet": _as_str(raw_section.get("bullet") or raw_section.get("description"))}

    try:
        category_key, resolved_label, _, canonical_content_json = canonicalize_profile_section_payload(
            section_type=section_type,
            category_label=_as_str(raw_section.get("category_label")) or category_label,
            title=title,
            raw_content_json=content_json,
        )
    except ValueError:
        category_key, resolved_label, _, canonical_content_json = canonicalize_profile_section_payload(
            section_type="custom",
            category_label="补充亮点",
            title=title,
            raw_content_json=content_json,
        )

    return {
        "section_type": category_key,
        "category_label": resolved_label,
        "title": title,
        "content_json": canonical_content_json,
        "confidence": _clamp_confidence(raw_section.get("confidence", 0.7)),
    }


def normalize_profile_agent_patch(raw_patch: dict[str, Any] | None) -> dict[str, Any]:
    raw = raw_patch if isinstance(raw_patch, dict) else {}
    action = _as_str(raw.get("action")) or "ask_user"
    if action not in VALID_AGENT_ACTIONS:
        action = "ask_user"

    base_info_in = raw.get("base_info")
    base_info = {
        key: _as_str(value)
        for key, value in (base_info_in.items() if isinstance(base_info_in, dict) else [])
        if _as_str(value)
    }

    target_roles = _as_list(raw.get("target_roles"))[:5]
    raw_sections = raw.get("sections")
    sections = [
        normalize_profile_agent_section(item)
        for item in (raw_sections if isinstance(raw_sections, list) else [])
        if isinstance(item, dict)
    ][:12]

    assistant_message = _as_str(raw.get("assistant_message") or raw.get("message"))
    if not assistant_message:
        assistant_message = "我整理出了一些可写入档案的信息，请先确认。"

    return {
        "action": action,
        "assistant_message": assistant_message[:1000],
        "base_info": base_info,
        "target_roles": target_roles,
        "sections": sections,
        "next_question": _as_str(raw.get("next_question"))[:500],
        "confidence": _clamp_confidence(raw.get("confidence", 0.7)),
    }


def profile_agent_patch_has_updates(patch: dict[str, Any]) -> bool:
    return bool(patch.get("base_info") or patch.get("target_roles") or patch.get("sections"))


def guard_profile_agent_patch(
    raw_patch: dict[str, Any] | None,
    *,
    state: dict[str, Any],
    user_message: str = "",
) -> dict[str, Any]:
    patch = normalize_profile_agent_patch(raw_patch)
    guardrails: list[str] = []
    missing_fields = list(state.get("missing_fields") or [])
    target_role = _as_str((state.get("goal") or {}).get("target_role"))

    if patch["action"] == "apply_patch":
        patch["action"] = "propose_patch"
        guardrails.append("blocked_auto_apply")

    if patch["action"] == "generate_resume":
        guardrails.append("deferred_resume_generation")
        if profile_agent_patch_has_updates(patch):
            patch["action"] = "propose_patch"
        elif missing_fields:
            patch["action"] = "ask_user"
            patch["base_info"] = {}
            patch["target_roles"] = []
            patch["sections"] = []
            patch["next_question"] = patch.get("next_question") or build_next_question(missing_fields, target_role)
            patch["assistant_message"] = (
                "生成投递简历前，我需要先把你的档案补齐一点。"
                f"{patch['next_question']}"
            )
        else:
            patch["action"] = "finish"
            patch["assistant_message"] = (
                patch.get("assistant_message")
                or "档案信息已经足够，可以进入 AI 简历定制流程。"
            )

    if profile_agent_patch_has_updates(patch) and patch["action"] != "finish":
        patch["action"] = "propose_patch"
        stop_reason = "needs_user_confirmation"
    elif patch["action"] == "finish":
        stop_reason = "finished"
    else:
        patch["action"] = "ask_user"
        stop_reason = "needs_more_input"
        if not patch.get("next_question"):
            patch["next_question"] = build_next_question(missing_fields, target_role)
        if patch.get("next_question") and patch["next_question"] not in patch["assistant_message"]:
            patch["assistant_message"] = patch["next_question"]

    return {
        "patch": patch,
        "stop_reason": stop_reason,
        "guardrails": guardrails,
        "observed": {
            "missing_fields": missing_fields,
            "user_message_length": len(user_message or ""),
            "has_profile_updates": profile_agent_patch_has_updates(patch),
        },
    }


async def run_profile_agent_loop(
    *,
    state: dict[str, Any],
    messages_json: list[Any],
    user_message: str,
    generate_patch: Callable[[dict[str, Any], list[Any], str], Awaitable[dict[str, Any] | None]],
    max_steps: int = PROFILE_AGENT_MAX_LOOP_STEPS,
) -> dict[str, Any]:
    trace: list[dict[str, Any]] = []
    bounded_steps = min(max(int(max_steps or 1), 1), PROFILE_AGENT_MAX_LOOP_STEPS)
    final_decision: dict[str, Any] | None = None

    for step in range(1, bounded_steps + 1):
        trace.append(
            {
                "phase": "observe",
                "step": step,
                "missing_fields": list(state.get("missing_fields") or []),
                "message_count": len(messages_json or []),
                "user_message_length": len(user_message or ""),
            }
        )

        try:
            raw_patch = await generate_patch(state, messages_json, user_message)
            error = ""
        except Exception as exc:
            raw_patch = None
            error = exc.__class__.__name__

        trace.append(
            {
                "phase": "reason",
                "step": step,
                "raw_action": raw_patch.get("action") if isinstance(raw_patch, dict) else "",
                "error": error,
            }
        )

        final_decision = guard_profile_agent_patch(raw_patch, state=state, user_message=user_message)
        trace.append(
            {
                "phase": "guard",
                "step": step,
                "action": final_decision["patch"]["action"],
                "stop_reason": final_decision["stop_reason"],
                "guardrails": final_decision["guardrails"],
                "has_profile_updates": final_decision["observed"]["has_profile_updates"],
            }
        )

        break

    if final_decision is None:
        final_decision = guard_profile_agent_patch(None, state=state, user_message=user_message)

    return {
        "patch": final_decision["patch"],
        "stop_reason": final_decision["stop_reason"],
        "trace": trace,
    }


def build_missing_fields(
    *,
    resume_text: str,
    target_role: str,
    target_city: str,
    extracted_base_info: dict[str, Any],
    resume_candidates: list[dict[str, Any]],
) -> list[str]:
    missing: list[str] = []
    joined = " ".join(
        [
            resume_text or "",
            _as_text(extracted_base_info),
            _as_text(resume_candidates),
        ]
    )
    candidate_types = {normalize_section_type_alias(_as_str(item.get("section_type"))) for item in resume_candidates}

    if not target_role and not _as_str(extracted_base_info.get("job_intention")):
        missing.append("target_role")
    if not target_city and not _as_str(extracted_base_info.get("current_city")):
        missing.append("target_city")
    if not resume_text and not resume_candidates:
        missing.append("resume")
    if not any(_as_str(extracted_base_info.get(key)) for key in ("phone", "email")):
        missing.append("contact_info")
    if not ({"experience", "internship", "project"} & candidate_types):
        missing.append("core_experience")
    if not _has_metric(joined):
        missing.append("impact_metrics")
    if "skill" not in candidate_types and not re.search(r"技能|工具|Python|SQL|Excel|Figma|Axure|AI|LLM", joined, re.I):
        missing.append("skills")

    return missing


def build_next_question(missing_fields: list[str], target_role: str = "") -> str:
    first = missing_fields[0] if missing_fields else ""
    role_hint = f"为了更贴近「{target_role}」方向，" if target_role else ""
    if first == "target_role":
        return "你这次最想找什么岗位方向？先说一个大概就行，比如 AI 产品经理、增长运营、后端开发；如果还不确定，也可以说你更喜欢分析、表达、组织还是做产品。"
    if first == "target_city":
        return "你主要想投哪些城市？如果可以远程或多城市，也可以一起告诉我。"
    if first == "resume":
        return "你可以上传现有简历，或者先把最核心的 2-3 段经历粘给我。每段不用完整，写清「做了什么 + 结果」就够。"
    if first == "contact_info":
        return "档案里还缺联系方式，你方便补充手机号或邮箱吗？"
    if first == "core_experience":
        return f"{role_hint}你可以任选一段最像样的经历，用「背景-动作-结果」说三句：当时要解决什么问题、你具体负责什么、最后有什么结果。"
    if first == "impact_metrics":
        return f"{role_hint}刚才这些经历里，有没有任何能作为 proof point 的数字？比如人数、金额、增长比例、节省时间、覆盖范围、排名；不确定也可以估一个范围，并说明是估计。"
    if first == "skills":
        return f"{role_hint}你希望简历突出哪些技能、工具或业务关键词？可以按「工具 / 方法 / 行业词」各说几个。"
    return "我已经有一版档案素材了。你还想补充哪段经历，或者要我先写入档案？"


def build_initial_agent_state(
    *,
    resume_text: str,
    target_role: str = "",
    target_city: str = "",
    job_goal: str = "",
    extracted_base_info: dict[str, Any] | None = None,
    resume_candidates: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    base_info = extracted_base_info if isinstance(extracted_base_info, dict) else {}
    raw_candidates = resume_candidates if isinstance(resume_candidates, list) else []
    draft_sections = [
        normalize_profile_agent_section(item)
        for item in raw_candidates
        if isinstance(item, dict)
    ]
    missing_fields = build_missing_fields(
        resume_text=resume_text,
        target_role=target_role,
        target_city=target_city,
        extracted_base_info=base_info,
        resume_candidates=draft_sections,
    )
    return {
        "mode": "profile_builder",
        "status": "collecting",
        "goal": {
            "target_role": _as_str(target_role or base_info.get("job_intention")),
            "target_city": _as_str(target_city or base_info.get("current_city")),
            "job_goal": _as_str(job_goal),
        },
        "base_info": {key: value for key, value in base_info.items() if _as_str(value)},
        "draft_sections": draft_sections,
        "missing_fields": missing_fields,
        "missing_field_labels": [FIELD_LABELS.get(item, item) for item in missing_fields],
        "resume_text_length": len(resume_text or ""),
        "next_question": build_next_question(missing_fields, target_role or _as_str(base_info.get("job_intention"))),
    }


def build_profile_agent_system_prompt(state: dict[str, Any]) -> str:
    missing_labels = "、".join(state.get("missing_field_labels") or []) or "暂无明显缺口"
    return f"""你是 OfferU 的 AI 建档助手，也是一位求职职业教练。目标是通过受控 agent loop 帮用户把求职 Profile 建成可复用的单一事实源。

你可以自主追问，但每轮只能做一个清晰动作。你不能直接写库，只能提出 profile patch，等用户确认后由系统写入。

当前缺口：{missing_labels}

工作方法：
- 先建立 Career Ops 风格的单一事实源：基础身份、目标岗位、career story、proof points、求职偏好、避雷项。
- 不要急着提取条目。如果用户只给了很短素材，先判断它是否足够写进简历；不够时只问一个最关键追问。
- 追问优先级：目标岗位 -> 关键经历 -> STAR 背景/任务/动作/结果 -> proof points 数字/作品/反馈 -> 技能关键词 -> 偏好与限制。
- 用户不知道怎么说时，给 2-3 个可选回答角度，而不是只说“继续补充经历”。

你必须输出严格 JSON，不要输出 Markdown：
{{
  "action": "ask_user|propose_patch|finish",
  "assistant_message": "给用户看的自然语言回复",
  "base_info": {{"name": "", "phone": "", "email": "", "current_city": "", "job_intention": "", "summary": ""}},
  "target_roles": ["岗位1"],
  "sections": [
    {{
      "section_type": "education|experience|project|skill|certificate|custom",
      "title": "条目标题",
      "content_json": {{"bullet": "一行事实摘要，必须来自用户原话或简历"}},
      "confidence": 0.0
    }}
  ],
  "next_question": "如果还需要继续追问，写一个具体问题"
}}

规则：
1. 不编造公司、项目、数字、学校、岗位。
2. 如果用户给了可入库事实，action 用 propose_patch，并把事实放进 sections 或 base_info。
3. 如果信息不足，action 用 ask_user，只问一个最关键的问题。
4. 所有数字必须来自简历或用户消息。
5. 目标是能生成拿得出手的简历和投递材料，要围绕目标岗位追问项目职责、成果数据、技能关键词、作品证据和求职偏好。"""


async def generate_raw_turn_patch(
    state: dict[str, Any],
    messages_json: list[Any],
    user_message: str,
) -> dict[str, Any] | None:
    """Generate one untrusted profile patch for the guarded agent loop."""

    from app.agents.llm import chat_completion, extract_json

    recent = [
        item
        for item in messages_json[-12:]
        if isinstance(item, dict) and item.get("role") in {"user", "assistant"}
    ]
    user_payload = {
        "state": state,
        "recent_messages": recent,
        "latest_user_message": user_message,
    }
    try:
        llm_result = await chat_completion(
            messages=[
                {"role": "system", "content": build_profile_agent_system_prompt(state)},
                {"role": "user", "content": json.dumps(user_payload, ensure_ascii=False)},
            ],
            temperature=0.25,
            json_mode=True,
            max_tokens=1800,
            tier="standard",
        )
        parsed = extract_json(llm_result or "")
    except Exception:
        parsed = None

    if not isinstance(parsed, dict):
        clean_message = user_message.strip()
        parsed = {
            "action": "propose_patch" if len(clean_message) >= 8 else "ask_user",
            "assistant_message": "我先把你刚补充的内容整理成一条候选档案，你确认后我再写入。",
            "sections": [
                {
                    "section_type": "custom",
                    "title": "补充经历",
                    "content_json": {"description": clean_message, "bullet": clean_message},
                    "confidence": 0.55,
                }
            ] if len(clean_message) >= 8 else [],
            "next_question": state.get("next_question") or "你可以再补充一段具体经历吗？",
        }
    return parsed
