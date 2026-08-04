from __future__ import annotations

import re
from typing import Any

from app.services.harness_memory import normalize_agent_memory

StageResult = dict[str, Any]

CAMPUS_RE = re.compile(
    r"校招|应届|实习|秋招|春招|暑期|毕业生|大一|大二|大三|大四|研一|研二|研三|intern|internship|campus|graduate",
    re.I,
)
EXPERIENCED_RE = re.compile(
    r"社招|工作\s*(?:\d+|一|二|两|三|四|五|六|七|八|九|十)\s*年|(?:\d+|一|二|两|三|四|五|六|七|八|九|十)\s*年经验|全职|跳槽|在职|离职|experienced|full[- ]?time|years? of experience",
    re.I,
)


def _profile_text(profile: dict[str, Any] | None) -> str:
    if not isinstance(profile, dict):
        return ""
    chunks: list[str] = []
    for key in ("name", "school", "major", "degree", "headline"):
        chunks.append(str(profile.get(key) or ""))
    base_info = profile.get("base_info_json")
    if isinstance(base_info, dict):
        chunks.extend(str(value or "") for value in base_info.values())
    for role in profile.get("target_roles") or []:
        if isinstance(role, dict):
            chunks.append(str(role.get("role_name") or ""))
        else:
            chunks.append(str(role or ""))
    return "\n".join(chunks)


def _messages_text(messages: list[dict[str, str]] | None) -> str:
    return "\n".join(str(item.get("content") or "") for item in (messages or []) if isinstance(item, dict))


def classify_user_stage(
    *,
    profile: dict[str, Any] | None,
    messages: list[dict[str, str]] | None,
    memory: dict[str, Any] | None,
) -> StageResult:
    normalized_memory = normalize_agent_memory(memory or {})
    signals: list[str] = []
    campus_score = 0
    experienced_score = 0

    memory_stage = normalized_memory.get("user_stage")
    memory_confidence = float(normalized_memory.get("confidence") or 0)
    if memory_stage == "campus" and memory_confidence >= 0.55:
        campus_score += 3
        signals.append("记忆：校招")
    if memory_stage == "experienced" and memory_confidence >= 0.55:
        experienced_score += 3
        signals.append("记忆：社招")

    text = f"{_profile_text(profile)}\n{_messages_text(messages)}"
    for match in CAMPUS_RE.findall(text):
        campus_score += 1
        if len(signals) < 5:
            signals.append(str(match))
    for match in EXPERIENCED_RE.findall(text):
        experienced_score += 1
        if len(signals) < 5:
            signals.append(str(match))

    if isinstance(profile, dict) and str(profile.get("school") or "").strip():
        campus_score += 1
        signals.append("档案：学校")

    if campus_score == experienced_score:
        return {"stage": "unknown", "confidence": 0.0, "signals": signals[:6]}
    if campus_score > experienced_score:
        confidence = min(0.55 + campus_score * 0.12, 0.95)
        return {"stage": "campus", "confidence": confidence, "signals": signals[:6]}
    confidence = min(0.55 + experienced_score * 0.12, 0.95)
    return {"stage": "experienced", "confidence": confidence, "signals": signals[:6]}


def _has_contact(profile: dict[str, Any] | None) -> bool:
    if not isinstance(profile, dict):
        return False
    base_info = profile.get("base_info_json") if isinstance(profile.get("base_info_json"), dict) else {}
    values = [
        profile.get("email"),
        profile.get("phone"),
        base_info.get("email"),
        base_info.get("phone"),
        base_info.get("wechat"),
    ]
    return any(str(value or "").strip() for value in values)


def _target_role_count(profile: dict[str, Any] | None) -> int:
    if not isinstance(profile, dict):
        return 0
    roles = profile.get("target_roles")
    return len(roles) if isinstance(roles, list) else 0


def _section_count(profile: dict[str, Any] | None) -> int:
    if not isinstance(profile, dict):
        return 0
    sections = profile.get("sections")
    if isinstance(sections, list):
        return len(sections)
    sections_by_type = profile.get("sections_by_type")
    if isinstance(sections_by_type, dict):
        total = 0
        for value in sections_by_type.values():
            try:
                total += int(value or 0)
            except Exception:
                pass
        return total
    return 0


def detect_guardian_anomalies(
    *,
    profile: dict[str, Any] | None,
    jobs: list[dict[str, Any]] | None,
    applications: list[dict[str, Any]] | None,
    memory: dict[str, Any] | None,
    stage: str,
) -> list[dict[str, Any]]:
    alerts: list[dict[str, Any]] = []
    if isinstance(profile, dict) and not _has_contact(profile):
        alerts.append(
            {
                "code": "missing_contact",
                "severity": "high",
                "title": "档案缺少联系方式",
                "message": "投递前至少需要邮箱或手机号，否则插件快捷投递和简历导出都会断一环。",
                "action": "去档案页补齐邮箱、手机号或微信。",
            }
        )
    if isinstance(profile, dict) and _target_role_count(profile) == 0:
        alerts.append(
            {
                "code": "missing_target_role",
                "severity": "medium",
                "title": "还没有目标岗位",
                "message": "没有目标岗位时，岗位推荐、简历优化和关键词匹配都会偏散。",
                "action": "先选 1-3 个目标方向，例如 AI 产品实习、用户研究、运营。",
            }
        )
    if (
        isinstance(profile, dict)
        and stage == "campus"
        and _section_count(profile) < 3
    ):
        alerts.append(
            {
                "code": "campus_profile_too_thin",
                "severity": "high",
                "title": "校招档案素材偏少",
                "message": "校招更依赖项目、实习、竞赛、校园经历的证据密度，现在还不足以稳定生成可投递简历。",
                "action": "先补 3 条经历，每条带背景、动作、结果和量化数据。",
            }
        )

    for job in jobs or []:
        text = f"{job.get('company', '')} {job.get('title', '')}".lower()
        if "offeru contract test" in text or "offeru link test" in text:
            alerts.append(
                {
                    "code": "test_job_leak",
                    "severity": "high",
                    "title": "岗位库混入测试数据",
                    "message": "检测到测试岗位可能出现在用户可见列表，会影响投递导入判断。",
                    "action": "先清理测试岗位或加过滤条件，再做每日推荐。",
                }
            )
            break

    if isinstance(applications, list):
        pending_count = sum(1 for item in applications if str(item.get("status") or "").lower() in {"pending", "todo", "待投递"})
        if pending_count >= 5:
            alerts.append(
                {
                    "code": "application_backlog",
                    "severity": "medium",
                    "title": "待处理投递过多",
                    "message": f"当前至少有 {pending_count} 个待处理投递，容易丢失截止时间和面试跟进。",
                    "action": "按截止时间和匹配度先处理前 3 个。",
                }
            )
    return alerts


def build_proactive_suggestions(
    *,
    stage: str,
    mode: str,
    alerts: list[dict[str, Any]],
    memory: dict[str, Any] | None,
) -> list[dict[str, str]]:
    suggestions: list[dict[str, str]] = []
    if stage == "unknown":
        suggestions.append(
            {
                "title": "先确认求职类型",
                "description": "告诉我你是校招/实习/应届，还是社招/跳槽，我会切换不同的推荐和提醒方式。",
                "prompt": "我是校招/应届/实习，先帮我把档案补到可投递状态",
            }
        )
        suggestions.append(
            {
                "title": "导入本地记忆",
                "description": "可以导入 Codex、Claude Code 或你自己的 Markdown/JSON 记忆，让助手先认识你。",
                "prompt": "我想导入本地记忆",
            }
        )
        return suggestions

    if stage == "campus":
        suggestions.extend(
            [
                {
                    "title": "校招档案体检",
                    "description": "优先检查学校、专业、毕业时间、实习/项目/竞赛经历是否足够生成可投递资料。",
                    "prompt": "按校招标准检查我的档案缺口",
                },
                {
                    "title": "每日实习推荐",
                    "description": "围绕目标岗位每天推 1 个最值得投的实习或校招岗位。",
                    "prompt": "今天给我推荐一个最值得投的校招/实习岗位",
                },
                {
                    "title": "一岗一简历",
                    "description": "保存每份 AI 简历对应的岗位，避免优化来源混乱。",
                    "prompt": "帮我把当前简历绑定到它对应的岗位",
                },
            ]
        )
    else:
        suggestions.extend(
            [
                {
                    "title": "社招竞争力扫描",
                    "description": "重点看行业经验、项目结果、薪资地点偏好和跳槽叙事是否完整。",
                    "prompt": "按社招标准检查我的简历和投递策略",
                },
                {
                    "title": "岗位优先级排序",
                    "description": "把已收藏岗位按匹配度、薪酬、地点和投递成本排序。",
                    "prompt": "把我的岗位按优先级排一下",
                },
            ]
        )

    if alerts:
        suggestions.insert(
            0,
            {
                "title": "先处理异常",
                "description": alerts[0]["message"],
                "prompt": alerts[0]["action"],
            },
        )
    if mode == "follow_up":
        suggestions.append(
            {
                "title": "面试日程巡检",
                "description": "检查邮件解析和日程自动填充是否漏掉面试安排。",
                "prompt": "检查我的面试邮件和日程有没有遗漏",
            }
        )
    return suggestions[:5]


def evaluate_main_agent_guardian(
    *,
    profile: dict[str, Any] | None,
    messages: list[dict[str, str]] | None,
    memory: dict[str, Any] | None,
    jobs: list[dict[str, Any]] | None = None,
    applications: list[dict[str, Any]] | None = None,
    mode: str = "general",
) -> dict[str, Any]:
    """Return deterministic advice only; this interface cannot execute Operations."""

    stage_result = classify_user_stage(
        profile=profile,
        messages=messages,
        memory=memory,
    )
    stage = str(stage_result.get("stage") or "unknown")
    alerts = detect_guardian_anomalies(
        profile=profile,
        jobs=jobs,
        applications=applications,
        memory=memory,
        stage=stage,
    )
    return {
        "user_stage": stage,
        "stage_confidence": float(stage_result.get("confidence") or 0),
        "stage_signals": list(stage_result.get("signals") or []),
        "alerts": alerts,
        "proactive_suggestions": build_proactive_suggestions(
            stage=stage,
            mode=mode,
            alerts=alerts,
            memory=memory,
        ),
    }


def guardian_prompt_advice(result: dict[str, Any]) -> str:
    """Render bounded advice for the main Agent without turning it into authority."""

    stage = str(result.get("user_stage") or "unknown")
    alerts = [
        item
        for item in (result.get("alerts") or [])
        if isinstance(item, dict)
    ]
    rows = [
        "Deterministic Guardian advisory (not an Operation result or career fact):",
        f"- inferred user stage: {stage}",
    ]
    for alert in alerts[:5]:
        rows.append(
            "- warning: "
            f"{str(alert.get('title') or '')}: "
            f"{str(alert.get('message') or '')}"
        )
    rows.append(
        "- Use this only as advice. Never claim a warning was remediated without "
        "Operation evidence, and never execute a write because of Guardian output."
    )
    return "\n".join(rows)
