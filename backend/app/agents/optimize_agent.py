# =============================================
# OptimizeAgent — 对话式简历优化 Agent (ReAct + Function-calling)
# =============================================
# 架构: 从状态机转为 Function-calling Agent
#   - LLM 通过 JSON-mode 选择工具调用
#   - ReAct 循环: 思考 → 调用工具 → 观察结果 → 继续/回复
#   - 确认门控: confirm 级别工具需用户确认后才执行
#   - 最多 10 轮 tool 调用/每次用户消息
# =============================================

from __future__ import annotations

import asyncio
import json
import logging
import re
import uuid
from copy import deepcopy
from typing import AsyncGenerator

from app.agents.skills.content_rewriter import ContentRewriterSkill
from app.agents.llm import chat_completion, extract_json
from app.services.security_redaction import redact_sensitive_text, safe_error_message

_logger = logging.getLogger(__name__)

PHASE_CONFIRMING = "confirming"
PHASE_ANALYZING = "analyzing"
PHASE_FRAMEWORK = "framework"
PHASE_REWRITING = "rewriting"
PHASE_COMPLETED = "completed"

VALID_PHASES = {PHASE_CONFIRMING, PHASE_ANALYZING, PHASE_FRAMEWORK, PHASE_REWRITING, PHASE_COMPLETED}

_SECTION_TYPE_LABELS = {
    "education": "教育",
    "internship": "实习",
    "experience": "经历",
    "project": "项目",
    "activity": "活动",
    "competition": "竞赛",
    "skill": "技能",
    "certificate": "证书",
    "honor": "荣誉",
    "language": "语言",
    "general": "通用",
    "custom": "自定义",
    "other": "其他",
    "custom:c_internship": "实习",
    "custom:c_awards": "获奖",
    "custom:c_personal": "个人经历",
    "custom:c_generic": "自定义",
}


def _section_type_label(section_type: str) -> str:
    label = _SECTION_TYPE_LABELS.get(section_type)
    if label:
        return label
    if section_type.startswith("custom:c_"):
        return section_type.split(":c_", 1)[-1].replace("_", " ").title()
    return section_type


# ---- TOOL_REGISTRY ----

TOOL_REGISTRY: dict[str, dict] = {
    "analyze_jd": {
        "description": "解析目标岗位 JD，提取关键技能、要求和软素质",
        "parameters": {},
        "risk_level": "read",
    },
    "match_resume": {
        "description": "匹配简历与 JD，输出匹配度报告（已匹配/缺失技能、各段评分）",
        "parameters": {},
        "risk_level": "read",
    },
    "propose_framework": {
        "description": "提出简历框架方案：选用哪些档案条目、怎么组织章节结构",
        "parameters": {},
        "risk_level": "read",
    },
    "rewrite_section": {
        "description": "改写指定 section，输出结构化 JSON + HTML 描述（含 diff）",
        "parameters": {
            "section_index": "要改写的 section 索引（从 0 开始的整数）",
            "extra_instruction": "额外改写指令，如用户反馈（可选字符串）",
        },
        "risk_level": "read",
    },
    "confirm_section": {
        "description": "确认当前 section 改写，保存到 session（需用户确认）",
        "parameters": {
            "section_index": "要确认的 section 索引（整数）",
        },
        "risk_level": "confirm",
    },
    "review_section": {
        "description": "回顾/修改已确认的 section，根据用户反馈重新改写",
        "parameters": {
            "section_index": "要回顾的 section 索引（整数）",
            "feedback": "用户的修改意见（字符串）",
        },
        "risk_level": "read",
    },
    "rollback": {
        "description": "回退到指定阶段（需用户确认，会清除该阶段之后的数据）",
        "parameters": {
            "target_phase": "目标阶段名称（analyzing/framework/rewriting 之一）",
            "reason": "回退理由（字符串）",
        },
        "risk_level": "confirm",
    },
    "switch_job": {
        "description": "切换目标岗位。当用户想要更换目标岗位时使用。需要提供新的岗位ID。",
        "parameters": {"new_job_ids": "list[int] — 新的目标岗位ID列表"},
        "risk_level": "confirm",
    },
    "list_available_jobs": {
        "description": "列出用户可选的岗位，返回岗位ID、公司名、职位名等信息",
        "parameters": {},
        "risk_level": "read",
    },
    "prepare_resume_optimization": {
        "description": "将所有已确认内容通过 Operation Registry 保存为可审核提案；不会创建正式简历",
        "parameters": {"research_run_id": "指定已完成岗位调研 run_id（可选）"},
        "risk_level": "confirm",
    },
    "get_resume_optimization": {
        "description": "读取当前会话提案的原文、候选稿、逐项 diff、事实门和证据",
        "parameters": {},
        "risk_level": "read",
    },
    "start_job_research": {
        "description": "通过 Operation Registry 启动当前岗位的公开网页证据化调研",
        "parameters": {"runtime_id": "本地 coding agent runtime，默认 codex"},
        "risk_level": "confirm",
    },
    "get_job_research": {
        "description": "读取当前岗位调研状态、证据、结论和缺口",
        "parameters": {},
        "risk_level": "read",
    },
    "review_resume_optimization": {
        "description": "明确接受或拒绝当前提案；只有接受通过事实门的提案才创建正式简历",
        "parameters": {
            "action": "accept 或 reject",
            "note": "审核备注（可选）",
        },
        "risk_level": "confirm",
    },
}


def _build_tools_description() -> str:
    lines = []
    for name, info in TOOL_REGISTRY.items():
        params = info["parameters"]
        risk = info["risk_level"]
        param_str = ", ".join(f"{k}: {v}" for k, v in params.items()) if params else "无参数"
        risk_label = "【需确认】" if risk == "confirm" else ""
        lines.append(f"- {name}({param_str}): {info['description']} {risk_label}")
    return "\n".join(lines)


# ---- System Prompt ----

_SYSTEM_PROMPT_TEMPLATE = """你是一位资深校招简历优化顾问。你通过对话与候选人交互，使用工具完成简历优化。

## 当前状态
- 阶段: {phase}
- 目标岗位: {job_titles}
- 已确认 sections: {confirmed_sections_summary}
- 待处理 sections: {pending_sections_summary}
- 当前岗位调研: {research_run_id}
- 当前简历提案: {resume_optimization_proposal_id}
- 当前待确认操作: {pending_action_summary}

## 可用工具
{tools_description}

## 工具使用规则
1. 每次只调用一个工具，观察结果后再决定下一步
2. 改写 section 时，输出结构化 JSON，description 用 HTML 格式
3. 需要用户确认的操作（confirm_section, rollback, start_job_research, prepare_resume_optimization, review_resume_optimization）先向用户说明意图，等用户确认后再调用
4. 如果用户反馈不满意，调用 rewrite_section 并传入 extra_instruction
5. 如果用户想修改已确认的 section，调用 review_section
6. 如果用户想回退到更早的阶段，调用 rollback
7. 准备提案前必须有 completed 岗位调研；先调用 get_job_research 复用该岗位最近完成的调研，查不到时再调用 start_job_research，随后继续用 get_job_research 查看状态
8. 所有 section 确认且调研完成后，调用 prepare_resume_optimization；再用 get_resume_optimization 展示 diff 和事实门；只有用户明确接受或拒绝后才调用 review_resume_optimization
9. 如果工具返回错误，向用户说明问题并建议解决方案，不要反复调用同一工具
10. 如果连续两个工具返回错误，直接回复用户说明情况，建议重新开始会话
11. 不要在同一个section上反复调用rewrite_section，如果改写结果不满意，向用户确认是否需要调整方向

## 改写质量规则（CRITICAL）
1. 绝不编造经历、技能、数据、成果 — 如果原文没有证据，不要强行关联
2. 关键词必须融入上下文，而非堆砌 — 例如"奖学金"和"逻辑分析能力"没有因果关系，不要强行关联
3. 每条描述应是一个微型工作故事：情境→行动→结果，而非关键词列表
4. 如果某个 JD 要求在当前经历中找不到自然关联，宁可跳过也不要强行注入
5. 保留原文的限定词和自然表达，不要全部改成"完美"的 AI 语言
6. 如果缺少量化数据，保留有证据的原始措辞并指出能力缺口；不要编造数字，也不要写占位符

## 输出格式
返回 JSON：
- 调用工具: {{"action": "tool_call", "tool": "工具名", "args": {{参数字典}}}}
- 直接回复: {{"action": "reply", "message": "回复内容"}}

## 对话规则
- 使用中文回复，保持专业但友好的语气
- 不要要求候选人手动粘贴 JD 或简历内容，系统已自动加载
- 不要使用连续星号作为装饰线
- 使用 Markdown 格式时确保语法正确"""

_ANTI_MECHANICAL_INJECTION_RULES = """
## 反机械关键词注入规则
- 关键词映射而非注入：先列出 JD 关键词，逐个映射到简历中的证据
- 有证据的：自然融入描述
- 无证据的：标注为"缺失"，建议用户补充，不要强行注入
- 单条 bullet 中出现 3+ 个 JD 关键词时，检查是否过于机械
- 不要建立虚假因果关系（如"奖学金→逻辑分析能力"）
- 段落结构不要过于对称（AI 生成特征）
"""


def _build_system_prompt(session: OptimizeSession) -> str:
    job_titles = _get_job_titles(session)
    confirmed_summary = _summarize_confirmed_sections(session)
    pending_summary = _summarize_pending_sections(session)
    pending_action_summary = ""
    if session.pending_action:
        pa = session.pending_action
        pending_action_summary = f"等待用户确认: {pa.get('tool', '')}({json.dumps(pa.get('args', {}), ensure_ascii=False)})"

    return _SYSTEM_PROMPT_TEMPLATE.format(
        phase=session.phase,
        job_titles=job_titles,
        confirmed_sections_summary=confirmed_summary,
        pending_sections_summary=pending_summary,
        research_run_id=session.research_run_id or "尚未启动",
        resume_optimization_proposal_id=(
            session.resume_optimization_proposal_id or "尚未准备"
        ),
        pending_action_summary=pending_action_summary,
        tools_description=_build_tools_description(),
    ) + _ANTI_MECHANICAL_INJECTION_RULES


def _get_job_titles(session: OptimizeSession) -> str:
    if session.job_titles:
        return "、".join(session.job_titles)
    if not session.job_ids:
        return "未设置"
    return f"岗位 ID: {', '.join(str(jid) for jid in session.job_ids)}"


def _summarize_confirmed_sections(session: OptimizeSession) -> str:
    if not session.confirmed_sections:
        return "无"
    parts = []
    for idx_str, content in session.confirmed_sections.items():
        if isinstance(content, dict):
            title = content.get("section_title", f"Section {idx_str}")
        else:
            title = f"Section {idx_str}"
        parts.append(title)
    return "、".join(parts) if parts else "无"


def _summarize_pending_sections(session: OptimizeSession) -> str:
    if not session.rows:
        return "无（需先分析）"
    confirmed_indices = set(session.confirmed_sections.keys())
    pending = []
    for i, row in enumerate(session.rows):
        if str(i) not in confirmed_indices:
            pending.append(f"{i}: {row.get('title', '未命名')}")
    return "、".join(pending) if pending else "全部已确认"


# ---- OptimizeSession ----

class OptimizeSession:
    def __init__(
        self,
        session_id: str | None = None,
        job_ids: list[int] | None = None,
        mode: str = "per_job",
        profile_id: int | None = None,
        reference_resume_id: int | None = None,
    ):
        self.session_id = session_id or f"opt_{uuid.uuid4().hex[:12]}"
        self.job_ids = job_ids or []
        self.mode = mode
        self.profile_id = profile_id
        self.reference_resume_id = reference_resume_id
        self.phase = PHASE_CONFIRMING
        self.messages: list[dict] = []
        self.jd_analysis: dict = {}
        self.match_analysis: dict = {}
        self.reorder_result: dict = {}
        self.framework: dict = {}
        self.rows: list[dict] = []
        self.current_section_index: int = 0
        self.resume_id: int | None = None
        self.resume_optimization_proposal_id: str | None = None
        self.research_run_id: str | None = None
        self.interview_experiences: list[dict] = []
        self.raw_jd: str = ""
        self.job_titles: list[str] = []
        # New fields for Function-calling Agent
        self.pending_action: dict | None = None
        self.confirmed_sections: dict = {}  # section_index (str) → content_json
        self.original_rows: dict = {}  # section_index (str) → original content_json before first rewrite
        self._source_sections_cache: list | None = None  # 源档案条目缓存（内存态）


_sessions: dict[str, OptimizeSession] = {}


def _get_session(session_id: str) -> OptimizeSession | None:
    return _sessions.get(session_id)


def _save_session(session: OptimizeSession) -> None:
    _sessions[session.session_id] = session


async def _load_session_from_db(session_id: str, db) -> OptimizeSession | None:
    from app.models.models import OptimizeSession as OptimizeSessionModel
    from sqlalchemy import select

    result = await db.execute(
        select(OptimizeSessionModel).where(OptimizeSessionModel.session_id == session_id)
    )
    row = result.scalar_one_or_none()
    if not row:
        return None

    session = OptimizeSession(
        session_id=row.session_id,
        job_ids=row.job_ids or [],
        mode=row.mode or "per_job",
        profile_id=row.profile_id,
        reference_resume_id=row.reference_resume_id,
    )
    session.phase = row.phase or PHASE_CONFIRMING
    session.messages = row.messages_json or []
    session.jd_analysis = row.jd_analysis_json or {}
    session.match_analysis = row.match_analysis_json or {}
    session.reorder_result = row.reorder_json or {}
    session.framework = row.framework_json or {}
    session.rows = row.rows_json or []
    session.current_section_index = row.current_section_index or 0
    session.resume_id = row.resume_id
    session.resume_optimization_proposal_id = row.resume_optimization_proposal_id
    session.research_run_id = row.research_run_id
    session.interview_experiences = row.interview_experiences_json or []
    session.raw_jd = row.raw_jd_json or ""
    session.job_titles = row.job_titles_json or []
    # Load new fields from dedicated columns
    session.confirmed_sections = row.confirmed_sections_json or {}
    session.original_rows = row.original_rows_json or {}
    session.pending_action = row.pending_action_json or None

    _save_session(session)
    return session


async def _persist_session(session: OptimizeSession, db) -> None:
    from app.models.models import OptimizeSession as OptimizeSessionModel
    from sqlalchemy import select

    result = await db.execute(
        select(OptimizeSessionModel).where(OptimizeSessionModel.session_id == session.session_id)
    )
    row = result.scalar_one_or_none()

    if row:
        row.phase = session.phase
        row.job_ids = session.job_ids
        row.mode = session.mode
        row.profile_id = session.profile_id
        row.messages_json = session.messages
        row.jd_analysis_json = session.jd_analysis
        row.match_analysis_json = session.match_analysis
        row.reorder_json = session.reorder_result
        row.framework_json = session.framework
        row.rows_json = session.rows
        row.current_section_index = session.current_section_index
        row.reference_resume_id = session.reference_resume_id
        row.resume_id = session.resume_id
        row.resume_optimization_proposal_id = session.resume_optimization_proposal_id
        row.research_run_id = session.research_run_id
        row.interview_experiences_json = session.interview_experiences
        row.raw_jd_json = session.raw_jd
        row.job_titles_json = session.job_titles or None
        row.confirmed_sections_json = session.confirmed_sections or None
        row.original_rows_json = session.original_rows or None
        row.pending_action_json = session.pending_action or None
    else:
        row = OptimizeSessionModel(
            session_id=session.session_id,
            profile_id=session.profile_id,
            phase=session.phase,
            job_ids=session.job_ids,
            mode=session.mode,
            messages_json=session.messages,
            jd_analysis_json=session.jd_analysis,
            match_analysis_json=session.match_analysis,
            reorder_json=session.reorder_result,
            framework_json=session.framework,
            rows_json=session.rows,
            current_section_index=session.current_section_index,
            reference_resume_id=session.reference_resume_id,
            resume_id=session.resume_id,
            resume_optimization_proposal_id=session.resume_optimization_proposal_id,
            research_run_id=session.research_run_id,
            interview_experiences_json=session.interview_experiences,
            raw_jd_json=session.raw_jd,
            job_titles_json=session.job_titles or None,
            confirmed_sections_json=session.confirmed_sections or None,
            original_rows_json=session.original_rows or None,
            pending_action_json=session.pending_action or None,
        )
        db.add(row)

    await db.commit()


async def list_sessions_from_db(db) -> list[dict]:
    from app.models.models import OptimizeSession as OptimizeSessionModel
    from sqlalchemy import select

    result = await db.execute(
        select(OptimizeSessionModel).order_by(OptimizeSessionModel.updated_at.desc()).limit(50)
    )
    rows = result.scalars().all()
    return [
        {
            "session_id": r.session_id,
            "phase": r.phase,
            "job_ids": r.job_ids or [],
            "mode": r.mode,
            "created_at": r.created_at.isoformat() if r.created_at else "",
            "updated_at": r.updated_at.isoformat() if r.updated_at else "",
            "resume_id": r.resume_id,
            "reference_resume_id": r.reference_resume_id,
            "resume_optimization_proposal_id": r.resume_optimization_proposal_id,
            "research_run_id": r.research_run_id,
        }
        for r in rows
    ]


async def get_session_detail(session_id: str, db) -> dict | None:
    """获取完整会话详情，包含对话历史"""
    from app.models.models import OptimizeSession as OptimizeSessionModel
    from sqlalchemy import select

    result = await db.execute(
        select(OptimizeSessionModel).where(OptimizeSessionModel.session_id == session_id)
    )
    row = result.scalar_one_or_none()
    if not row:
        return None

    return {
        "session_id": row.session_id,
        "phase": row.phase,
        "job_ids": row.job_ids or [],
        "mode": row.mode,
        "messages": row.messages_json or [],
        "created_at": row.created_at.isoformat() if row.created_at else "",
        "updated_at": row.updated_at.isoformat() if row.updated_at else "",
        "resume_id": row.resume_id,
        "reference_resume_id": row.reference_resume_id,
        "resume_optimization_proposal_id": row.resume_optimization_proposal_id,
        "research_run_id": row.research_run_id,
        "pending_action": row.pending_action_json or None,
    }


async def delete_session(session_id: str, db) -> bool:
    """删除指定会话"""
    from app.models.models import OptimizeSession as OptimizeSessionModel
    from sqlalchemy import select, delete

    result = await db.execute(
        select(OptimizeSessionModel).where(OptimizeSessionModel.session_id == session_id)
    )
    row = result.scalar_one_or_none()
    if not row:
        return False

    await db.execute(
        delete(OptimizeSessionModel).where(OptimizeSessionModel.session_id == session_id)
    )
    await db.commit()

    # Also remove from in-memory cache
    _sessions.pop(session_id, None)
    return True


async def _get_session_profile(session: OptimizeSession, db) -> object | None:
    from app.models.models import Profile
    from sqlalchemy import select

    if session.profile_id:
        result = await db.execute(select(Profile).where(Profile.id == session.profile_id))
        return result.scalar_one_or_none()
    result = await db.execute(
        select(Profile).order_by(Profile.is_default.desc(), Profile.updated_at.desc())
    )
    return result.scalars().first()


async def _get_source_sections(session: OptimizeSession, db) -> list:
    """加载源档案条目（带 session 级缓存，避免每次改写都查库）"""
    if session._source_sections_cache is not None:
        return session._source_sections_cache
    from app.models.models import ProfileSection
    from sqlalchemy import select

    profile = await _get_session_profile(session, db)
    if not profile:
        session._source_sections_cache = []
        return []
    result = await db.execute(
        select(ProfileSection)
        .where(ProfileSection.profile_id == profile.id)
        .where(ProfileSection.status == "active")
        .order_by(ProfileSection.sort_order.asc())
    )
    sections = list(result.scalars().all())
    session._source_sections_cache = sections
    return sections


# ---- Tool Implementations ----

async def _tool_analyze_jd(session: OptimizeSession, args: dict, db) -> dict:
    """解析 JD 要求"""
    if session.jd_analysis and "error" not in session.jd_analysis:
        return {"result": session.jd_analysis, "cached": True}

    if not session.raw_jd:
        return {"error": "JD 数据未加载，这可能是会话初始化问题。请告诉用户需要重新开始优化会话来加载岗位数据。"}

    from app.agents.skills.jd_analyzer import JDAnalyzerSkill
    skill = JDAnalyzerSkill()
    result = await skill.execute({"jd_text": session.raw_jd})
    if result and "error" not in result:
        session.jd_analysis = result
        session.phase = PHASE_ANALYZING
    return result


async def _tool_match_resume(session: OptimizeSession, args: dict, db) -> dict:
    """匹配简历与 JD"""
    if session.match_analysis and "error" not in session.match_analysis:
        return {"result": session.match_analysis, "cached": True}

    if not session.raw_jd:
        return {"error": "JD 数据未加载，这可能是会话初始化问题。请告诉用户需要重新开始优化会话来加载岗位数据。"}
    if not session.rows:
        return {"error": "简历数据为空，请先确认岗位并完成分析"}

    from app.routes.optimize import _rows_to_resume_json
    resume_text = _rows_to_resume_json(session.rows)

    from app.agents.skills.resume_matcher import ResumeMatcherSkill
    skill = ResumeMatcherSkill()
    result = await skill.execute({
        "resume_text": resume_text,
        "jd_text": session.raw_jd,
        "jd_analysis": session.jd_analysis,
    })
    if result and "error" not in result:
        session.match_analysis = result
    return result


async def _tool_propose_framework(session: OptimizeSession, args: dict, db) -> dict:
    """提出简历框架"""
    if not session.rows:
        return {"error": "简历数据为空，请先完成分析"}

    framework_info = []
    for idx, row in enumerate(session.rows):
        title = row.get("title", "")
        section_type = row.get("section_type", "")
        content_json = row.get("content_json", [])
        items_desc = []
        if isinstance(content_json, list):
            for item in content_json:
                if not isinstance(item, dict):
                    continue
                if section_type == "education":
                    items_desc.append(item.get("school", ""))
                elif section_type in ("experience",):
                    items_desc.append(item.get("company", ""))
                elif section_type == "project":
                    items_desc.append(item.get("name", ""))
                elif section_type == "skill":
                    items_desc.append(item.get("category", ""))
                else:
                    items_desc.append(item.get("subtitle", ""))
        items_str = "、".join(i for i in items_desc if i)
        framework_info.append({
            "index": idx,
            "title": title,
            "section_type": section_type,
            "items": items_str,
        })

    reorder_reason = ""
    if isinstance(session.reorder_result, dict) and session.reorder_result.get("reason"):
        reorder_reason = session.reorder_result["reason"]

    session.phase = PHASE_FRAMEWORK
    return {
        "framework": framework_info,
        "reorder_reason": reorder_reason,
    }


async def _tool_rewrite_section(session: OptimizeSession, args: dict, db) -> dict:
    """改写指定 section"""
    section_index = args.get("section_index")
    extra_instruction = args.get("extra_instruction", "")

    if section_index is None:
        return {"error": "缺少 section_index 参数"}
    section_index = int(section_index)

    if section_index < 0 or section_index >= len(session.rows):
        return {"error": f"section_index {section_index} 超出范围（共 {len(session.rows)} 个 section）"}

    row = session.rows[section_index]
    section_title = row.get("title", "")
    section_type = row.get("section_type", "")
    section_content = _row_to_text(row)

    context = {
        "jd_text": session.raw_jd,
        "jd_analysis": session.jd_analysis,
        "match_analysis": session.match_analysis,
    }

    if session.interview_experiences:
        questions = []
        for exp in session.interview_experiences:
            for q in exp.get("questions", []):
                if isinstance(q, dict):
                    questions.append(q)
        if questions:
            context["interview_questions"] = questions

    try:
        rewriter = ContentRewriterSkill()
        result = await rewriter.execute_single_section(
            context=context,
            section_title=section_title,
            section_type=section_type,
            section_content=section_content,
            extra_instruction=extra_instruction,
        )
    except Exception as exc:
        _logger.warning("Section rewrite failed: %s", redact_sensitive_text(exc, max_length=500))
        return {"error": safe_error_message(exc)}

    if isinstance(result, dict) and "error" not in result:
        session.phase = PHASE_REWRITING
        session.current_section_index = section_index
        session.resume_id = None
        session.resume_optimization_proposal_id = None

        # Apply suggestions to session.rows in-place so confirm_section saves rewritten data
        suggestions = result.get("suggestions", [])
        if suggestions:
            from app.routes.optimize import _apply_suggestions_to_rows
            # Save original content before first rewrite (for rollback)
            idx_key = str(section_index)
            if idx_key not in session.original_rows:
                session.original_rows[idx_key] = list(session.rows[section_index].get("content_json", []))
            # Build a single-section rows list to apply suggestions
            single_row = [dict(session.rows[section_index])]
            # Ensure section_title in each suggestion matches for _apply_suggestions_to_rows
            for sug in suggestions:
                if isinstance(sug, dict) and not sug.get("section_title"):
                    sug["section_title"] = section_title

            # ── Humanizer: 去除 AI 痕迹（改写后立即执行，纯规则零成本） ──
            try:
                from app.agents.skills.humanizer import HumanizerSkill
                humanizer = HumanizerSkill()
                humanizer_stats = await humanizer.execute({"content_rewrite": result})
                result["humanizer"] = humanizer_stats
                # 重建 suggestions 引用已被 humanizer 原地修改
                suggestions = result.get("suggestions", [])
            except Exception as exc:
                _logger.warning("Humanizer failed: %s", redact_sensitive_text(exc, max_length=500))
                result["humanizer"] = {"applied": False, "error": safe_error_message(exc)}

            rewritten = _apply_suggestions_to_rows(single_row, suggestions)
            if rewritten and isinstance(rewritten[0].get("content_json"), list):
                session.rows[section_index]["content_json"] = rewritten[0]["content_json"]

            # ── FactGates: 确定性事实验证（校验数字/机构名是否捏造） ──
            try:
                from app.routes.optimize import _fact_gates_validate
                source_sections = await _get_source_sections(session, db) if db is not None else []
                gate_result = _fact_gates_validate(
                    [session.rows[section_index]], source_sections
                )
                result["fact_gates"] = gate_result
            except Exception as exc:
                _logger.warning("FactGates validate failed: %s", redact_sensitive_text(exc, max_length=500))
                result["fact_gates"] = {"error": safe_error_message(exc)}

    return result


async def _tool_confirm_section(session: OptimizeSession, args: dict, db) -> dict:
    """确认 section 改写，保存到 session"""
    section_index = args.get("section_index")
    if section_index is None:
        return {"error": "缺少 section_index 参数"}
    section_index = int(section_index)

    if section_index < 0 or section_index >= len(session.rows):
        return {"error": f"section_index {section_index} 超出范围"}

    row = session.rows[section_index]
    section_title = row.get("title", "")

    # Save confirmed section content
    session.confirmed_sections[str(section_index)] = {
        "section_title": section_title,
        "section_type": row.get("section_type", ""),
        "content_json": row.get("content_json", []),
    }

    # Check if all sections are confirmed
    all_confirmed = all(
        str(i) in session.confirmed_sections for i in range(len(session.rows))
    )

    if all_confirmed:
        session.phase = PHASE_COMPLETED

    return {
        "confirmed": True,
        "section_index": section_index,
        "section_title": section_title,
        "all_confirmed": all_confirmed,
    }


async def _tool_review_section(session: OptimizeSession, args: dict, db) -> dict:
    """回顾/修改已确认的 section"""
    section_index = args.get("section_index")
    feedback = args.get("feedback", "")

    if section_index is None:
        return {"error": "缺少 section_index 参数"}
    section_index = int(section_index)

    if str(section_index) not in session.confirmed_sections:
        return {"error": f"Section {section_index} 尚未确认，无法回顾"}

    # Remove from confirmed and re-rewrite
    del session.confirmed_sections[str(section_index)]
    session.phase = PHASE_REWRITING

    # Re-rewrite with feedback
    return await _tool_rewrite_section(session, {
        "section_index": section_index,
        "extra_instruction": f"用户反馈：{feedback}" if feedback else "",
    }, db)


async def _tool_rollback(session: OptimizeSession, args: dict, db) -> dict:
    """回退到指定阶段"""
    target_phase = args.get("target_phase", "")
    reason = args.get("reason", "")

    if target_phase not in {"analyzing", "framework", "rewriting"}:
        return {"error": f"不支持回退到阶段: {target_phase}，可选: analyzing, framework, rewriting"}

    session.phase = target_phase
    session.resume_id = None
    session.resume_optimization_proposal_id = None

    # Clear data based on target phase
    if target_phase == "analyzing":
        session.framework = {}
        session.rows = []
        session.confirmed_sections = {}
        session.original_rows = {}
        session.reorder_result = {}
        session.match_analysis = {}
    elif target_phase == "framework":
        session.confirmed_sections = {}
        # Restore original content so rows reflect pre-rewrite state
        for idx_key, original_content in session.original_rows.items():
            idx = int(idx_key)
            if 0 <= idx < len(session.rows):
                session.rows[idx]["content_json"] = original_content
        session.original_rows = {}
    elif target_phase == "rewriting":
        session.confirmed_sections = {}
        # Keep rewritten content and original_rows intact —
        # user wants to re-review rewrites, not start over from original content

    return {
        "rolled_back_to": target_phase,
        "reason": reason,
    }


async def _tool_switch_job(session: OptimizeSession, args: dict, db) -> dict:
    """切换目标岗位"""
    new_job_ids = args.get("new_job_ids")
    if not new_job_ids or not isinstance(new_job_ids, list):
        return {"error": "缺少 new_job_ids 参数，需提供新的岗位ID列表"}
    if len(set(new_job_ids)) != 1:
        return {"error": "当前提案流程一次只能切换到一个岗位"}

    if db is None:
        return {"error": "数据库连接不可用"}

    from app.models.models import Job
    from sqlalchemy import select

    jobs_result = await db.execute(select(Job).where(Job.id.in_(new_job_ids)))
    jobs = list(jobs_result.scalars().all())

    if not jobs:
        return {"error": f"未找到对应岗位，ID: {new_job_ids}"}

    # Update session
    session.job_ids = [j.id for j in jobs]
    session.job_titles = [" - ".join(part for part in [j.company, j.title] if part) for j in jobs]

    # Reload JD text
    jd_parts = []
    for j in jobs:
        jd_text = j.raw_description or ""
        if jd_text.strip():
            label = " - ".join(part for part in [j.company, j.title] if part)
            jd_parts.append(f"### {label}\n{jd_text[:3000]}")
    session.raw_jd = "\n\n---\n\n".join(jd_parts) if jd_parts else ""

    # Clear analysis results
    session.jd_analysis = {}
    session.match_analysis = {}
    session.framework = {}
    session.rows = []
    session.confirmed_sections = {}
    session.original_rows = {}
    session.resume_id = None
    session.resume_optimization_proposal_id = None
    session.research_run_id = None

    # Reset phase
    session.phase = PHASE_ANALYZING

    # Append system message to help LLM focus on new context
    new_titles = "、".join(session.job_titles) if session.job_titles else "新岗位"
    session.messages.append({
        "role": "system",
        "content": f"岗位已切换为：{new_titles}。之前的分析结果已失效，请重新开始分析。"
    })

    return {
        "switched": True,
        "new_job_titles": session.job_titles,
        "new_job_ids": session.job_ids,
    }


async def _tool_list_available_jobs(session: OptimizeSession, args: dict, db) -> dict:
    """列出用户可选的岗位"""
    if db is None:
        return {"error": "数据库连接不可用"}

    from app.models.models import Job
    from sqlalchemy import select

    # Get profile's picked jobs
    result = await db.execute(
        select(Job)
        .where(Job.triage_status == "picked")
        .order_by(Job.updated_at.desc())
        .limit(50)
    )
    jobs = list(result.scalars().all())

    if not jobs:
        return {
            "available_jobs": [],
            "current_job_ids": session.job_ids,
            "message": "当前没有已挑选的岗位。请先在岗位管理页面将心仪的岗位标记为'已挑选'状态，然后再回来切换岗位。",
        }

    job_list = []
    for j in jobs:
        job_list.append({
            "id": j.id,
            "company": j.company or "",
            "title": j.title or "",
            "location": j.location or "",
        })

    return {
        "available_jobs": job_list,
        "current_job_ids": session.job_ids,
    }


async def _registry_outputs(operation: str, args: dict) -> dict:
    from app.ops import execute_operation

    result = await execute_operation(
        operation,
        args,
        dry_run=False,
        surface="optimize_agent",
    )
    if not result.get("ok"):
        errors = result.get("errors") or [f"{operation} 执行失败"]
        return {"error": "；".join(str(item) for item in errors)}
    outputs = result.get("outputs")
    if not isinstance(outputs, dict):
        return {"error": f"{operation} 返回了无效结果"}
    return outputs


async def _tool_start_job_research(
    session: OptimizeSession,
    args: dict,
    db,
) -> dict:
    if len(session.job_ids) != 1:
        return {"error": "岗位调研一次只能对应一个岗位"}
    result = await _registry_outputs(
        "start_job_research",
        {
            "job_id": session.job_ids[0],
            "runtime_id": args.get("runtime_id") or "codex",
        },
    )
    if result.get("run_id"):
        session.research_run_id = str(result["run_id"])
    return result


async def _tool_get_job_research(
    session: OptimizeSession,
    args: dict,
    db,
) -> dict:
    if not session.research_run_id:
        if len(session.job_ids) != 1:
            return {"error": "岗位调研一次只能对应一个岗位"}
        listed = await _registry_outputs(
            "list_job_research_runs",
            {
                "job_id": session.job_ids[0],
                "status": "completed",
                "limit": 1,
            },
        )
        if listed.get("error"):
            return listed
        items = listed.get("items")
        if not isinstance(items, list) or not items:
            return {"error": "当前岗位没有可复用的已完成调研，请先启动岗位调研"}
        run_id = items[0].get("run_id") if isinstance(items[0], dict) else None
        if not run_id:
            return {"error": "岗位调研列表返回了无效结果"}
        session.research_run_id = str(run_id)
    return await _registry_outputs(
        "get_job_research",
        {"run_id": session.research_run_id},
    )


def _session_candidate_rows(
    session: OptimizeSession,
) -> tuple[list[dict], list[dict]]:
    proposed_rows: list[dict] = []
    original_rows: list[dict] = []
    for index, row in enumerate(session.rows):
        confirmed = session.confirmed_sections.get(str(index))
        if not isinstance(confirmed, dict):
            raise ValueError(f"第 {index + 1} 个 section 尚未确认")
        proposed = {
            "section_type": row.get("section_type", ""),
            "title": row.get("title", ""),
            "sort_order": row.get("sort_order", index),
            "visible": bool(row.get("visible", True)),
            "content_json": deepcopy(
                confirmed.get("content_json", row.get("content_json", []))
            ),
            "source_section_ids": deepcopy(row.get("source_section_ids") or []),
        }
        original = deepcopy(proposed)
        if str(index) in session.original_rows:
            original["content_json"] = deepcopy(session.original_rows[str(index)])
        proposed_rows.append(proposed)
        original_rows.append(original)
    return proposed_rows, original_rows


async def _tool_prepare_resume_optimization(
    session: OptimizeSession,
    args: dict,
    db,
) -> dict:
    """把逐段确认过的候选稿交给统一提案服务，不直接创建 Resume。"""
    if not session.confirmed_sections:
        return {"error": "没有已确认的 section，无法准备提案"}

    if not all(str(i) in session.confirmed_sections for i in range(len(session.rows))):
        return {"error": "还有 section 未确认，请先确认所有 section"}
    if len(session.job_ids) != 1:
        return {"error": "会话提案一次只能对应一个岗位；请切换到单岗位 per_job 模式"}
    try:
        proposed_rows, original_rows = _session_candidate_rows(session)
        result = await _registry_outputs(
            "prepare_resume_optimization",
            {
                "job_id": session.job_ids[0],
                "profile_id": session.profile_id,
                "reference_resume_id": session.reference_resume_id,
                "research_run_id": args.get("research_run_id") or session.research_run_id,
                "candidate_rows": proposed_rows,
                "candidate_original_rows": original_rows,
                "source_session_id": session.session_id,
            },
        )
        if "error" not in result:
            session.resume_optimization_proposal_id = result.get("proposal_id")
        return result
    except Exception as exc:
        _logger.warning(
            "Resume proposal preparation failed: %s",
            redact_sensitive_text(exc, max_length=500),
        )
        return {"error": f"简历提案准备失败: {safe_error_message(exc)}"}


async def _tool_get_resume_optimization(
    session: OptimizeSession,
    args: dict,
    db,
) -> dict:
    proposal_id = session.resume_optimization_proposal_id
    if not proposal_id:
        return {"error": "当前会话还没有简历优化提案"}
    return await _registry_outputs(
        "get_resume_optimization",
        {"proposal_id": proposal_id},
    )


async def _tool_review_resume_optimization(
    session: OptimizeSession,
    args: dict,
    db,
) -> dict:
    proposal_id = session.resume_optimization_proposal_id
    if not proposal_id:
        return {"error": "当前会话还没有简历优化提案"}
    action = str(args.get("action") or "").strip().lower()
    if action not in {"accept", "reject"}:
        return {"error": "action 只能是 accept 或 reject"}
    result = await _registry_outputs(
        "review_resume_optimization",
        {
            "proposal_id": proposal_id,
            "action": action,
            "note": args.get("note") or "",
        },
    )
    if result.get("status") == "accepted" and isinstance(
        result.get("accepted_resume_id"),
        int,
    ):
        session.resume_id = result["accepted_resume_id"]
        session.phase = PHASE_COMPLETED
    return result


# ---- Tool Dispatcher ----

_TOOL_HANDLERS = {
    "analyze_jd": _tool_analyze_jd,
    "match_resume": _tool_match_resume,
    "propose_framework": _tool_propose_framework,
    "rewrite_section": _tool_rewrite_section,
    "confirm_section": _tool_confirm_section,
    "review_section": _tool_review_section,
    "rollback": _tool_rollback,
    "switch_job": _tool_switch_job,
    "list_available_jobs": _tool_list_available_jobs,
    "start_job_research": _tool_start_job_research,
    "get_job_research": _tool_get_job_research,
    "prepare_resume_optimization": _tool_prepare_resume_optimization,
    "get_resume_optimization": _tool_get_resume_optimization,
    "review_resume_optimization": _tool_review_resume_optimization,
}


async def _execute_tool(session: OptimizeSession, tool_name: str, args: dict, db) -> dict:
    """执行工具调用"""
    handler = _TOOL_HANDLERS.get(tool_name)
    if not handler:
        return {"error": f"未知工具: {tool_name}"}
    try:
        return await handler(session, args, db)
    except Exception as exc:
        _logger.warning(
            "Tool %s execution failed: %s",
            tool_name,
            redact_sensitive_text(exc, max_length=500),
        )
        return {"error": safe_error_message(exc)}


def _build_action_summary(tool_name: str, args: dict) -> str:
    """生成人类可读的工具调用摘要"""
    if tool_name == "confirm_section":
        idx = args.get("section_index", "?")
        return f"确认第 {int(idx) + 1} 个模块的改写结果"
    if tool_name == "rollback":
        phase = args.get("target_phase", "?")
        reason = args.get("reason", "")
        return f"回退到「{phase}」阶段。原因：{reason}" if reason else f"回退到「{phase}」阶段"
    if tool_name == "prepare_resume_optimization":
        return "把全部已确认内容保存为可审核简历提案（不会创建正式简历）"
    if tool_name == "start_job_research":
        return "启动当前岗位的公开网页证据化调研"
    if tool_name == "review_resume_optimization":
        action = args.get("action", "")
        return "接受当前简历提案并创建正式简历" if action == "accept" else "拒绝当前简历提案"
    if tool_name == "switch_job":
        new_ids = args.get("new_job_ids", [])
        return f"切换目标岗位为 ID: {new_ids}"
    return f"执行 {tool_name}"


# ---- SSE Helpers ----

def _sse_event(event: str, data: dict) -> str:
    return f"data: {json.dumps({'event': event, **data}, ensure_ascii=False)}\n\n"


# ---- ReAct Loop ----

async def agent_turn_stream(
    session: OptimizeSession,
    user_message: str,
    db,
) -> AsyncGenerator[str, None]:
    """ReAct Agent 主循环 — SSE 流式输出"""
    session.messages.append({"role": "user", "content": user_message})

    # Check if there's a pending action to execute (user confirmed)
    if session.pending_action:
        pa = session.pending_action

        # 严格整句匹配：去除标点和首尾空白后，整句等于确认/拒绝词才算数。
        # 这样 "确认吗" "确认，但是想改改" 都不会误判为已确认。
        import unicodedata

        def _strip_punct(s: str) -> str:
            """去除中英文标点和多余空白"""
            out = []
            for ch in s:
                cat = unicodedata.category(ch)
                # P* = 标点；Z* = 分隔符（空格等）
                if cat.startswith("P") or cat.startswith("Z"):
                    continue
                out.append(ch)
            return "".join(out).strip()

        cleaned = _strip_punct(user_message.lower())

        # 确认词集合（允许前面带"我"/"那就"等口语前缀）
        _CONFIRM_PHRASES = {
            "确认", "确认了", "我确认", "我确认了", "确认确认",
            "同意", "我同意", "我同意了",
            "好的", "好的好的", "行", "可以", "没问题", "好",
            "对", "对的", "是", "是的", "嗯", "嗯嗯",
            "ok", "okay", "yes", "yeah", "y",
        }
        # 拒绝词集合
        _REJECT_PHRASES = {
            "取消", "不要", "拒绝", "算了", "否", "不想", "不行", "不要了",
            "不要了", "先不要", "先别", "别",
            "no", "cancel", "n",
        }

        is_confirmed = cleaned in _CONFIRM_PHRASES
        is_rejected = cleaned in _REJECT_PHRASES

        # If both match (理论上不会，但兜底), treat as NOT confirmed
        if is_confirmed and is_rejected:
            is_confirmed = False
            is_rejected = False

        if is_confirmed:
            session.pending_action = None
            # Execute the pending action
            tool_name = pa.get("tool", "")
            tool_args = pa.get("args", {})

            yield _sse_event("tool_call", {
                "tool": tool_name,
                "args": tool_args,
                "status": "executing",
            })

            result = await _execute_tool(session, tool_name, tool_args, db)

            yield _sse_event("tool_call", {
                "tool": tool_name,
                "args": tool_args,
                "status": "completed",
                "result_summary": json.dumps(result, ensure_ascii=False)[:500],
            })

            if (
                tool_name == "prepare_resume_optimization"
                and isinstance(result, dict)
                and result.get("proposal_id")
            ):
                yield _sse_event("resume_proposal_prepared", {
                    "proposal_id": result["proposal_id"],
                    "status": result.get("status", ""),
                    "fact_gate_status": result.get("fact_gate_status", ""),
                })

            if (
                tool_name == "review_resume_optimization"
                and isinstance(result, dict)
                and result.get("status") == "accepted"
                and isinstance(result.get("accepted_resume_id"), int)
            ):
                yield _sse_event("resume_generated", {
                    "resume_id": result["accepted_resume_id"],
                    "resume_title": "",
                })

            # Special handling for confirm_section
            if tool_name == "confirm_section" and isinstance(result, dict) and result.get("confirmed"):
                yield _sse_event("section_confirmed", {
                    "section_index": result.get("section_index"),
                    "section_title": result.get("section_title", ""),
                    "all_confirmed": result.get("all_confirmed", False),
                })

            # Append result to messages for context
            session.messages.append({
                "role": "assistant",
                "content": f"已执行 {tool_name}，结果：{json.dumps(result, ensure_ascii=False)[:1000]}",
            })

            if db is not None:
                await _persist_session(session, db)

            # Build a response message
            if isinstance(result, dict) and result.get("error"):
                reply_msg = f"操作失败：{result['error']}"
            elif tool_name == "prepare_resume_optimization":
                reply_msg = (
                    f"简历提案已准备：{result.get('proposal_id', '')}。"
                    "请先查看逐项差异和事实门，再明确接受或拒绝。"
                )
            elif tool_name == "start_job_research":
                reply_msg = (
                    f"岗位调研已启动：{result.get('run_id', '')}。"
                    "调研完成后，我会读取证据与结论，再准备简历提案。"
                )
            elif tool_name == "review_resume_optimization":
                if result.get("status") == "accepted":
                    reply_msg = f"✅ 提案已接受，正式简历 ID: {result.get('accepted_resume_id', '')}"
                else:
                    reply_msg = "已拒绝当前简历提案；未创建正式简历。"
            elif tool_name == "confirm_section":
                idx = result.get("section_index", 0)
                title = result.get("section_title", "")
                if result.get("all_confirmed"):
                    reply_msg = f"✅ 「{title}」已确认。所有模块都已确认完成！下一步可以准备可审核提案。"
                else:
                    # Find next unconfirmed section
                    next_idx = None
                    for i in range(len(session.rows)):
                        if str(i) not in session.confirmed_sections:
                            next_idx = i
                            break
                    if next_idx is not None:
                        next_title = session.rows[next_idx].get("title", "")
                        reply_msg = f"✅ 「{title}」已确认。下一个是「{next_title}」，我来改写。"
                    else:
                        reply_msg = f"✅ 「{title}」已确认。"
            elif tool_name == "rollback":
                reply_msg = f"已回退到「{result.get('rolled_back_to', '')}」阶段。"
            else:
                reply_msg = f"操作已完成。"

            msg_data: dict = {"content": reply_msg}
            if tool_name == "prepare_resume_optimization" and result.get("proposal_id"):
                msg_data["proposal_id"] = result["proposal_id"]
            if (
                tool_name == "review_resume_optimization"
                and isinstance(result.get("accepted_resume_id"), int)
            ):
                msg_data["resume_id"] = result["accepted_resume_id"]
            yield _sse_event("assistant_message", msg_data)
            yield _sse_event("phase", {"phase": session.phase, "session_id": session.session_id})

            session.messages.append({"role": "assistant", "content": reply_msg})
            if db is not None:
                await _persist_session(session, db)
            return
        elif is_rejected:
            # User explicitly rejected — clear pending action and return immediately
            session.pending_action = None
            yield _sse_event("assistant_message", {"content": "好的，已取消操作。请告诉我你想怎么做。"})
            session.messages.append({"role": "assistant", "content": "好的，已取消操作。请告诉我你想怎么做。"})
            if db is not None:
                await _persist_session(session, db)
            return
        else:
            # User did not explicitly confirm or reject — keep pending_action, let LLM continue conversation
            # to clarify or address the user's response
            pass

    # ReAct Loop
    max_rounds = 10
    consecutive_tool_errors = 0
    last_tool_name = None
    for round_idx in range(max_rounds):
        # 1. Build dynamic system prompt
        system_prompt = _build_system_prompt(session)

        # 2. Build messages for LLM (truncate to last 20)
        llm_messages = [{"role": "system", "content": system_prompt}]

        # Include system context messages
        for msg in session.messages:
            role = msg.get("role", "")
            content = msg.get("content", "")
            if role == "system" and content:
                llm_messages.append({"role": "system", "content": content})

        # Include recent conversation (last 20 user/assistant messages)
        recent = [
            m for m in session.messages
            if m.get("role") in ("user", "assistant") and m.get("content")
        ][-20:]
        llm_messages.extend(recent)

        # 3. Call LLM
        yield _sse_event("thinking", {"round": round_idx + 1})

        try:
            llm_response = await chat_completion(
                messages=llm_messages,
                temperature=0.3,
                json_mode=True,
                max_tokens=2048,
                tier="standard",
            )
        except Exception as exc:
            _logger.warning("LLM call failed: %s", safe_error_message(exc))
            yield _sse_event("error", {"message": "AI 暂时无法响应，请稍后重试"})
            return

        if not llm_response:
            yield _sse_event("error", {"message": "AI 暂时无法响应，请稍后重试"})
            return

        # 4. Parse LLM output
        parsed = extract_json(llm_response)
        if not parsed:
            # LLM returned non-JSON, treat as direct reply
            yield _sse_event("assistant_message", {"content": llm_response})
            session.messages.append({"role": "assistant", "content": llm_response})
            if db is not None:
                await _persist_session(session, db)
            return

        action = parsed.get("action")

        # 5. Direct reply
        if action == "reply" or action is None:
            message = parsed.get("message", llm_response)
            yield _sse_event("assistant_message", {"content": message})
            session.messages.append({"role": "assistant", "content": message})
            if db is not None:
                await _persist_session(session, db)
            return

        # 6. Tool call
        if action == "tool_call":
            tool_name = parsed.get("tool", "")
            tool_args = parsed.get("args", {})

            # Validate tool name
            if tool_name not in TOOL_REGISTRY:
                yield _sse_event("error", {"message": f"未知工具: {tool_name}"})
                session.messages.append({
                    "role": "user",
                    "content": f"系统提示：工具 {tool_name} 不存在，请选择有效工具。",
                })
                continue

            tool_info = TOOL_REGISTRY[tool_name]
            risk_level = tool_info["risk_level"]

            # 7. Confirm-level tools: save as pending_action, return confirm_request
            if risk_level == "confirm":
                summary = _build_action_summary(tool_name, tool_args)
                session.pending_action = {
                    "tool": tool_name,
                    "args": tool_args,
                    "summary": summary,
                }
                yield _sse_event("confirm_request", {
                    "tool": tool_name,
                    "args": tool_args,
                    "summary": summary,
                })
                session.messages.append({
                    "role": "assistant",
                    "content": summary,
                })
                if db is not None:
                    await _persist_session(session, db)
                return

            # 8. Read-level tools: execute immediately
            yield _sse_event("tool_call", {
                "tool": tool_name,
                "args": tool_args,
                "status": "executing",
            })

            result = await _execute_tool(session, tool_name, tool_args, db)

            yield _sse_event("tool_call", {
                "tool": tool_name,
                "args": tool_args,
                "status": "completed",
                "result_summary": json.dumps(result, ensure_ascii=False)[:500],
            })

            # Append tool result to messages, continue loop
            session.messages.append({
                "role": "system",
                "content": f"工具 {tool_name} 执行结果：{json.dumps(result, ensure_ascii=False)[:3000]}\n\n请根据工具结果决定下一步操作，或直接回复用户。",
            })

            # Detect repeated tool failures (same tool 3 errors in a row)
            tool_failed = isinstance(result, dict) and "error" in result
            if tool_failed:
                consecutive_tool_errors += 1
            else:
                consecutive_tool_errors = 0
            last_tool_name = tool_name
            if consecutive_tool_errors >= 3:
                yield _sse_event("assistant_message", {"content": f"工具 {tool_name} 连续 3 次执行失败，可能存在数据问题。请尝试换一种方式描述你的需求，或重新开始会话。"})
                session.messages.append({"role": "assistant", "content": f"工具 {tool_name} 连续 3 次执行失败，可能存在数据问题。请尝试换一种方式描述你的需求，或重新开始会话。"})
                if db is not None:
                    await _persist_session(session, db)
                return

            # Continue loop
            continue

        # Unknown action
        yield _sse_event("error", {"message": f"未知的 action 类型: {action}"})
        return

    # max_rounds exhausted
    yield _sse_event("assistant_message", {"content": "处理轮次过多，请继续描述你的需求。"})
    if db is not None:
        await _persist_session(session, db)


# ---- Backward Compatible API ----

async def start_session(
    job_ids: list[int],
    mode: str = "per_job",
    profile_id: int | None = None,
    reference_resume_id: int | None = None,
    db=None,
) -> dict:
    session = OptimizeSession(
        job_ids=job_ids,
        mode=mode,
        profile_id=profile_id,
        reference_resume_id=reference_resume_id,
    )
    _save_session(session)

    job_titles: list[str] = []
    profile_summary = ""

    if db is not None:
        from app.models.models import Job, ProfileSection
        from sqlalchemy import select

        jobs_result = await db.execute(select(Job).where(Job.id.in_(job_ids)))
        jobs = list(jobs_result.scalars().all())
        job_titles = [" - ".join(part for part in [j.company, j.title] if part) for j in jobs]
        session.job_titles = job_titles

        jd_parts = []
        for j in jobs:
            jd_text = j.raw_description or ""
            if jd_text.strip():
                label = " - ".join(part for part in [j.company, j.title] if part)
                jd_parts.append(f"### {label}\n{jd_text[:3000]}")
        if jd_parts:
            session.raw_jd = "\n\n---\n\n".join(jd_parts)
            session.messages.append({
                "role": "system",
                "content": f"以下是候选人选择的目标岗位 JD：\n\n" + "\n\n---\n\n".join(jd_parts),
            })

        profile = await _get_session_profile(session, db)
        if profile:
            session.profile_id = profile.id
            sections_result = await db.execute(
                select(ProfileSection)
                .where(ProfileSection.profile_id == profile.id)
                .where(ProfileSection.status == "active")
                .order_by(ProfileSection.sort_order.asc())
            )
            sections = list(sections_result.scalars().all())
            type_counts: dict[str, int] = {}
            section_details: list[str] = []
            for s in sections:
                st = s.section_type or "other"
                type_counts[st] = type_counts.get(st, 0) + 1
                title = s.title or ""
                bullet = ""
                payload = s.content_json
                if isinstance(payload, dict):
                    bullet = payload.get("bullet", "")
                    if not bullet:
                        normalized = payload.get("normalized")
                        if isinstance(normalized, dict):
                            bullet = normalized.get("description", "")
                    if not bullet:
                        field_values = payload.get("field_values")
                        if isinstance(field_values, dict):
                            for v in field_values.values():
                                if isinstance(v, str) and len(v) > 5:
                                    bullet = v[:200]
                                    break
                if title:
                    detail = f"- [{_section_type_label(st)}] {title}"
                    if bullet:
                        detail += f"：{bullet[:150]}"
                    section_details.append(detail)
            parts = [f"{_section_type_label(k)}: {v} 条" for k, v in type_counts.items()]
            profile_summary = f"👤 你的档案：{len(sections)} 条经历条目（{'、'.join(parts)}）"

            if section_details:
                session.messages.append({
                    "role": "system",
                    "content": f"以下是候选人的档案条目摘要：\n\n{profile_summary}\n\n" + "\n".join(section_details[:30]),
                })

            # Build session.rows from profile sections so that
            # match_resume / rewrite_section / proposal preparation work immediately
            from app.routes.optimize import _rank_profile_sections, _build_resume_sections
            if sections and session.raw_jd:
                ranked = _rank_profile_sections(sections, session.raw_jd, limit=12)
                selected = [item[0] for item in ranked]
                session.rows = _build_resume_sections(selected)
            else:
                # No JD or no sections, use all sections without ranking
                session.rows = _build_resume_sections(sections)
        else:
            profile_summary = "⚠️ 未找到个人档案，请先在档案页创建"

    mode_label = "逐岗位输出" if mode == "per_job" else "合并输出"
    confirm_message = f"👋 我来帮你针对目标岗位优化简历。先确认一下：\n\n📋 生成方式：{mode_label}"

    if job_titles:
        confirm_message += f"\n\n🏢 目标岗位："
        for i, title in enumerate(job_titles, 1):
            confirm_message += f"\n{i}. {title}"

    if profile_summary:
        confirm_message += f"\n\n{profile_summary}"

    confirm_message += "\n\n确认无误就开始分析？"

    session.messages.append({"role": "assistant", "content": confirm_message})

    if db is not None:
        await _persist_session(session, db)

    return {
        "session_id": session.session_id,
        "phase": session.phase,
        "assistant_message": confirm_message,
    }


async def chat_turn(
    session_id: str,
    user_message: str,
    action: str = "reply",
    feedback: str = "",
    db=None,
) -> dict:
    """非流式版 — 收集所有 SSE 事件后返回最终结果"""
    session = _get_session(session_id)
    if not session and db is not None:
        session = await _load_session_from_db(session_id, db)
    if not session:
        return {"error": "会话不存在", "session_id": session_id}

    final_response = {}
    async for event_str in agent_turn_stream(session, user_message, db):
        # Parse SSE event
        if event_str.startswith("data: "):
            try:
                data = json.loads(event_str[6:].strip())
                event_type = data.get("event")
                if event_type == "assistant_message":
                    final_response["assistant_message"] = data.get("content", "")
                    if data.get("proposal_id"):
                        final_response["proposal_id"] = data.get("proposal_id")
                    if isinstance(data.get("resume_id"), int):
                        final_response["resume_id"] = data.get("resume_id")
                elif event_type == "phase":
                    final_response["phase"] = data.get("phase", session.phase)
                elif event_type == "error":
                    final_response["error"] = data.get("message", "")
                elif event_type == "confirm_request":
                    final_response["confirm_request"] = {
                        "tool": data.get("tool"),
                        "args": data.get("args"),
                        "summary": data.get("summary"),
                    }
                elif event_type == "resume_generated":
                    final_response["resume_id"] = data.get("resume_id")
                elif event_type == "resume_proposal_prepared":
                    final_response["proposal_id"] = data.get("proposal_id")
                    final_response["proposal_status"] = data.get("status", "")
                    final_response["fact_gate_status"] = data.get(
                        "fact_gate_status",
                        "",
                    )
                elif event_type == "section_confirmed":
                    final_response["section_confirmed"] = data
            except json.JSONDecodeError:
                pass

    # Note: assistant messages are already appended by agent_turn_stream, no need to re-append

    final_response["session_id"] = session.session_id
    if "phase" not in final_response:
        final_response["phase"] = session.phase
    return final_response


async def chat_turn_stream(
    session_id: str,
    user_message: str,
    action: str = "reply",
    feedback: str = "",
    db=None,
):
    """流式版 chat_turn — SSE 逐事件输出（向后兼容）"""
    session = _get_session(session_id)
    if not session and db is not None:
        session = await _load_session_from_db(session_id, db)
    if not session:
        yield f"data: {json.dumps({'event': 'error', 'message': '会话不存在', 'session_id': session_id})}\n\n"
        return

    # Handle legacy action parameter
    effective_message = user_message
    if action == "confirm" and session.pending_action:
        effective_message = "确认"
    elif action == "reject" and session.pending_action:
        effective_message = "取消"
    elif action == "adjust" and feedback:
        effective_message = feedback

    async for event_str in agent_turn_stream(session, effective_message, db):
        yield event_str


# ---- Utility Functions ----

def _row_to_text(row: dict) -> str:
    title = row.get("title", "")
    section_type = row.get("section_type", "")
    content_json = row.get("content_json", [])

    parts = [f"## {title}"]
    if not isinstance(content_json, list):
        return "\n".join(parts)

    for item in content_json:
        if not isinstance(item, dict):
            continue
        if section_type == "education":
            parts.append(f"- {item.get('school', '')} | {item.get('degree', '')} | {item.get('major', '')}")
            desc = item.get("description", "")
            if desc:
                parts.append(f"  {desc}")
        elif section_type in ("experience",):
            parts.append(f"- {item.get('company', '')} | {item.get('position', '')}")
            desc = item.get("description", "")
            if desc:
                parts.append(f"  {desc}")
        elif section_type == "project":
            parts.append(f"- {item.get('name', '')} | {item.get('role', '')}")
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

    return "\n".join(parts)
