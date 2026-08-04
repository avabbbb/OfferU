from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from typing import Any


SKILL_REGISTRY_VERSION = "2026-07-30.2"
CONFIRMATION_POLICY = "operation_registry"


@dataclass(frozen=True)
class AgentSkill:
    id: str
    name: str
    group: str
    status: str
    description: str
    mode: str
    allowed_tools: frozenset[str]
    featured: bool
    order: int
    version: str = SKILL_REGISTRY_VERSION
    missing_capabilities: tuple[str, ...] = ()
    aliases: tuple[str, ...] = ()

    def summary(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "name": self.name,
            "group": self.group,
            "status": self.status,
            "description": self.description,
            "mode": self.mode,
            "version": self.version,
            "allowed_tools": sorted(self.allowed_tools),
            "featured": self.featured,
            "order": self.order,
            "missing_capabilities": list(self.missing_capabilities),
            "aliases": list(self.aliases),
            "confirmation_policy": CONFIRMATION_POLICY,
        }


def _skill(
    id: str,
    name: str,
    group: str,
    status: str,
    description: str,
    mode: str,
    tools: tuple[str, ...],
    *,
    featured: bool,
    order: int,
    missing: tuple[str, ...] = (),
    aliases: tuple[str, ...] = (),
) -> AgentSkill:
    return AgentSkill(
        id=id,
        name=name,
        group=group,
        status=status,
        description=description,
        mode=mode,
        allowed_tools=frozenset(tools),
        featured=featured,
        order=order,
        missing_capabilities=missing,
        aliases=aliases,
    )


_SKILLS = (
    _skill("discovery", "技能中心", "system", "native", "解释 OfferU 能做什么，并选择下一条最短路径。", "general", ("get_profile",), featured=True, order=10, aliases=("help", "menu")),
    _skill("pre_application_decision", "投前决策闭环", "pipeline", "native", "围绕一个真实岗位检查职业证据和调研，生成可复核投前决策；只有使用者确认投或有条件投后才生成简历提案。", "pre_application_workflow", ("get_profile", "list_jobs", "get_job", "get_pre_application_state", "prepare_pre_application_decision", "review_pre_application_decision", "start_job_research", "resume_job_research", "cancel_job_research", "review_job_research", "prepare_resume_optimization"), featured=True, order=20, aliases=("pre_application", "投前决策", "投前")),
    _skill("evaluate_job", "岗位评估", "jobs", "native", "基于档案与真实岗位内容做证据化匹配。", "skill_assistant", ("get_profile", "list_jobs", "get_job", "list_career_artifacts", "save_career_artifact", "triage_job"), featured=True, order=30, aliases=("job", "岗位匹配")),
    _skill("compare_jobs", "岗位对比", "jobs", "native", "用统一维度比较多个岗位并给出有门槛的优先级。", "skill_assistant", ("get_profile", "list_jobs", "get_job", "batch_triage"), featured=True, order=40, aliases=("jobs", "岗位对比")),
    _skill("scan_jobs", "岗位发现", "jobs", "partial", "检查本地岗位库并形成可审核的筛选建议。", "job_workflow", ("get_profile", "list_pools", "list_jobs", "job_stats", "batch_triage"), featured=True, order=50, missing=("岗位抓取 Operation", "浏览器岗位存活检查"), aliases=("scan", "岗位扫描")),
    _skill("batch_evaluate", "批量评估", "jobs", "native", "用隔离的本地 coding-agent workers 并行评估岗位，并持久化断点与报告。", "skill_assistant", ("get_profile", "list_profile_evidence", "list_jobs", "get_job", "list_coding_agents", "list_batch_job_evaluations", "get_batch_job_evaluation", "start_batch_job_evaluation", "resume_batch_job_evaluation", "batch_triage"), featured=False, order=60, aliases=("batch", "批量")),
    _skill("tailor_resume", "定制简历", "documents", "native", "先读取岗位调研证据，再从已验证档案事实生成逐项 diff；只有明确接受才创建正式简历。", "resume_workflow", ("get_profile", "inspect_resume_document", "list_jobs", "get_job", "list_resumes", "get_resume", "list_job_research_runs", "get_job_research", "start_job_research", "resume_job_research", "cancel_job_research", "review_job_research", "list_resume_optimizations", "get_resume_optimization", "prepare_resume_optimization", "review_resume_optimization"), featured=True, order=70, aliases=("resume", "简历", "定制简历")),
    _skill("resume_export", "简历导出", "documents", "native", "检查当前简历并原子导出 ATS 友好的 PDF。", "skill_assistant", ("list_resumes", "get_resume", "export_resume_pdf"), featured=False, order=80, aliases=("pdf", "export")),
    _skill("cover_letter", "求职信", "documents", "native", "基于真实岗位和简历生成并持久化可审阅求职信。", "skill_assistant", ("get_profile", "list_jobs", "get_job", "list_resumes", "get_resume", "list_career_artifacts", "get_career_artifact", "generate_cover_letter", "save_career_artifact"), featured=False, order=90, aliases=("cover", "求职信")),
    _skill("application_email", "申请邮件", "documents", "native", "生成并持久化正式申请邮件草稿，永不发送。", "skill_assistant", ("get_profile", "list_jobs", "get_job", "list_resumes", "get_resume", "get_application_workspace", "list_career_artifacts", "get_career_artifact", "save_career_artifact"), featured=False, order=100, aliases=("email", "申请邮件")),
    _skill("application_assistant", "投递助手", "applications", "partial", "起草投递材料并登记待办，永不自动提交站外申请。", "skill_assistant", ("get_profile", "list_jobs", "get_job", "list_resumes", "get_resume", "list_applications", "get_application_workspace", "list_career_artifacts", "get_career_artifact", "generate_cover_letter", "save_career_artifact", "create_application", "update_application_record"), featured=True, order=110, missing=("浏览器表单识别与填充",), aliases=("apply", "投递")),
    _skill("tracker", "投递追踪", "applications", "native", "以当前投递工作区和追加式事件时间线为事实源，汇总状态、遗漏与下一步。", "skill_assistant", ("list_applications", "get_application_workspace", "list_application_records", "list_application_events", "analyze_application_patterns", "list_follow_up_cadence", "update_application_status", "update_application_record"), featured=True, order=120, aliases=("tracker", "投递管理")),
    _skill("follow_up", "跟进节奏", "applications", "native", "按确定性节奏计算到期跟进，生成草稿；只有确认已发送后才记账。", "skill_assistant", ("get_profile", "list_applications", "get_application_workspace", "list_application_events", "list_application_progress_candidates", "get_application_progress_candidate", "get_application_progress_overview", "list_follow_up_cadence", "list_calendar_events", "email_connection_status", "list_email_accounts", "list_email_sync_runs", "get_email_sync_run", "list_career_artifacts", "get_career_artifact", "save_career_artifact", "record_follow_up", "review_application_progress", "update_application_status", "update_application_record", "sync_email_notifications", "revoke_email_account"), featured=True, order=130, aliases=("followup", "follow_up", "跟进")),
    _skill("reply_watch", "回复识别", "applications", "native", "用 Gmail historyId 或 IMAP UID 增量同步邮箱，把消息保存为候选进展；只有使用者确认后才追加投递阶段事件。", "skill_assistant", ("list_applications", "get_application_workspace", "list_application_events", "list_application_progress_candidates", "get_application_progress_candidate", "get_application_progress_overview", "email_connection_status", "list_email_accounts", "list_email_sync_runs", "get_email_sync_run", "list_career_artifacts", "get_career_artifact", "save_career_artifact", "review_application_progress", "sync_email_notifications", "revoke_email_account"), featured=False, order=140, aliases=("reply", "回复识别")),
    _skill("company_research", "公司与岗位调研", "research", "native", "以公开网页及使用者授权的本地只读浏览证据维护公司与岗位双档案，区分已引用、双来源印证、单一信号和未知，并只提炼匿名简历表达模式。", "skill_assistant", ("list_jobs", "get_job", "list_coding_agents", "list_job_research_runs", "get_job_research", "start_job_research", "resume_job_research", "cancel_job_research", "review_job_research", "list_hosted_executor_sessions", "get_hosted_executor_session", "list_authorized_research_sessions", "get_authorized_research_session", "start_authorized_research_session", "activate_authorized_research_read_only", "capture_authorized_research_page", "complete_authorized_research_session", "cancel_authorized_research_session"), featured=False, order=150, aliases=("deep", "research", "公司研究", "岗位调研")),
    _skill("contact_outreach", "联系人外联", "research", "partial", "识别合适联系人角色并起草短消息，不虚构联系人。", "skill_assistant", ("get_profile", "list_jobs", "get_job"), featured=False, order=160, missing=("联系人搜索与来源验证",), aliases=("contact", "联系人")),
    _skill("profile_onboarding", "档案访谈", "profile", "native", "渐进发现职业证据缺口；学习信号先进入记忆收件箱，来源校验通过并确认后才写入。", "skill_assistant", ("get_profile", "inspect_resume_document", "list_profile_evidence", "list_learning_observations", "list_memory_inbox", "create_memory_proposal", "review_memory_proposal"), featured=True, order=170, aliases=("profile", "档案")),
    _skill("add_profile_evidence", "补充职业证据", "profile", "native", "把项目、经历、技能或证书整理为来源可验证、可去重的档案条目。", "skill_assistant", ("get_profile", "list_profile_evidence", "add_profile_evidence"), featured=False, order=180, aliases=("add", "补充经历")),
    _skill("memory_inbox", "记忆收件箱", "profile", "native", "查看职业学习观察和模型变更提案；接受、拒绝、稍后或撤销，只有确认接受后才写入档案。", "skill_assistant", ("get_profile", "list_profile_evidence", "list_learning_observations", "list_memory_inbox", "create_memory_proposal", "consolidate_memory_observations", "review_memory_proposal", "invalidate_memory_source"), featured=True, order=185, aliases=("memory", "记忆", "记忆收件箱")),
    _skill("work_source_sync", "工作源同步", "profile", "native", "只读取使用者显式登记的本地工作源；每次模型读取单独授权，变化只进入学习观察和记忆收件箱。", "skill_assistant", ("get_profile", "list_work_sources", "get_work_source", "register_work_source", "start_work_source_sync", "list_work_source_sync_runs", "get_work_source_sync_run", "resume_work_source_sync", "consolidate_memory_observations", "list_learning_observations", "list_memory_inbox", "review_memory_proposal", "invalidate_work_source"), featured=False, order=187, aliases=("work", "工作源", "工作同步")),
    _skill("interview_prep", "面试准备", "interview", "native", "基于岗位、档案、题库和日程生成并保存准备方案。", "skill_assistant", ("get_profile", "list_jobs", "get_job", "list_calendar_events", "list_interview_questions", "list_career_artifacts", "get_career_artifact", "save_career_artifact"), featured=True, order=190, aliases=("interview", "面试准备")),
    _skill("interview_plan", "面试冲刺计划", "interview", "native", "根据面试时间和题库生成并保存有优先级的分时准备计划。", "skill_assistant", ("get_profile", "list_jobs", "get_job", "list_calendar_events", "list_interview_questions", "list_career_artifacts", "get_career_artifact", "save_career_artifact"), featured=False, order=195, aliases=("plan", "面试计划")),
    _skill("interview_practice", "模拟面试", "interview", "native", "确认模型和数据类别后一次一题练习；内容按固定版本 Skill 引用原文评分，浏览器派生表达事件只作独立统计。", "skill_assistant", ("get_profile", "list_jobs", "get_job", "list_interview_questions", "get_ai_interview_runtime", "list_interview_scoring_skills", "get_interview_scoring_skill", "list_ai_interviews", "get_ai_interview", "create_ai_interview", "submit_ai_interview_answer", "ingest_interview_behavior_events", "restart_ai_interview", "delete_ai_interview"), featured=True, order=200, aliases=("practice", "模拟面试", "ai面试")),
    _skill("interview_scoring", "面试评分设计", "interview", "native", "创建受 schema 约束的版本化内容评分规则；只允许声明维度、权重、证据门和提示，禁止任意代码与表达行为总分。", "skill_assistant", ("list_interview_scoring_skills", "get_interview_scoring_skill", "create_interview_scoring_skill"), featured=False, order=205, aliases=("rubric", "评分skill", "面试评分")),
    _skill("interview_debrief", "面试复盘", "interview", "native", "持久化真实面试复盘，并在确认后更新投递事实源。", "skill_assistant", ("get_profile", "list_applications", "get_application_workspace", "list_application_events", "list_career_artifacts", "get_career_artifact", "save_career_artifact", "update_application_status", "update_application_record"), featured=False, order=210, aliases=("debrief", "面试复盘")),
    _skill("interview_risk_review", "面试风险审查", "interview", "partial", "识别公司与招聘流程红旗，生成并保存验证问题。", "skill_assistant", ("list_jobs", "get_job", "get_application_workspace", "list_career_artifacts", "get_career_artifact", "save_career_artifact"), featured=False, order=215, missing=("实时雇主口碑研究",), aliases=("redflag", "面试红旗")),
    _skill("pattern_analysis", "求职漏斗分析", "development", "native", "基于追加式状态事件计算拒绝、面试和 Offer 转化，并明确报告历史覆盖率。", "skill_assistant", ("get_profile", "list_jobs", "list_applications", "get_application_workspace", "list_application_events", "analyze_application_patterns", "list_career_artifacts", "get_career_artifact", "save_career_artifact", "job_stats"), featured=False, order=220, aliases=("patterns", "漏斗分析")),
    _skill("title_discovery", "职业方向探索", "development", "native", "从已验证能力推导相邻岗位和进入路径。", "career_exploration", ("get_profile", "list_jobs"), featured=True, order=230, aliases=("titles", "职业探索")),
    _skill("skill_gap", "技能差距", "development", "native", "只对照真实岗位要求与档案证据，排序并保存高复用缺口。", "skill_assistant", ("get_profile", "list_jobs", "get_job", "list_career_artifacts", "get_career_artifact", "save_career_artifact"), featured=False, order=240, aliases=("upskill", "技能差距")),
    _skill("training_review", "课程评估", "development", "native", "判断课程或证书是否值得投入。", "skill_assistant", ("get_profile", "list_jobs"), featured=False, order=250, aliases=("training", "课程")),
    _skill("project_review", "项目评估", "development", "native", "评估作品集项目能否补足目标岗位证据。", "skill_assistant", ("get_profile", "list_jobs"), featured=False, order=260, aliases=("project", "项目评估")),
    _skill("market_calibration", "市场校准", "development", "partial", "根据求职阶段、地区和岗位类型校准策略。", "skill_assistant", ("get_profile", "list_jobs", "job_stats"), featured=False, order=270, missing=("实时市场与政策数据",), aliases=("market", "市场校准")),
    _skill("offer_review", "Offer 阅读", "offer", "partial", "逐条阅读 Offer/合同，保存风险报告并生成律师与雇主问题清单。", "skill_assistant", ("get_profile", "list_applications", "get_application_workspace", "list_career_artifacts", "get_career_artifact", "save_career_artifact"), featured=False, order=280, missing=("法律结论",), aliases=("offer", "合同")),
    _skill("agent_inbox", "持续任务箱", "system", "native", "查看主 Agent Run、coding-agent 批处理和中断状态。", "skill_assistant", ("list_agent_runs", "list_batch_job_evaluations", "get_batch_job_evaluation", "resume_batch_job_evaluation"), featured=False, order=290, aliases=("inbox", "agent_inbox")),
)


def catalog() -> list[dict[str, Any]]:
    return [skill.summary() for skill in sorted(_SKILLS, key=lambda item: (item.order, item.id))]


def registry_snapshot(operation_schemas: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    skills = catalog()
    if operation_schemas is not None:
        available = {str(operation.get("name") or "") for operation in operation_schemas}
        invalid = {
            skill["id"]: sorted(set(skill["allowed_tools"]) - available)
            for skill in skills
            if set(skill["allowed_tools"]) - available
        }
        if invalid:
            raise ValueError(f"Skill Registry 引用了未注册 Operation: {invalid}")
        confirmed = {
            str(operation.get("name") or "")
            for operation in operation_schemas
            if operation.get("requires_confirmation")
        }
        for skill in skills:
            skill["confirmation_required_operations"] = sorted(
                confirmed.intersection(skill["allowed_tools"])
            )
    payload = {"version": SKILL_REGISTRY_VERSION, "skills": skills}
    canonical = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return {**payload, "sha256": hashlib.sha256(canonical.encode("utf-8")).hexdigest()}


def resolve_skill(value: str | None) -> AgentSkill | None:
    normalized = str(value or "").strip().lower().lstrip("/").replace("-", "_")
    if not normalized:
        return None
    if normalized == "offeru":
        normalized = "discovery"
    return next((skill for skill in _SKILLS if normalized == skill.id or normalized in skill.aliases), None)


def resolve_slash_skill(user_message: str | None) -> AgentSkill | None:
    command = str(user_message or "").strip().split(maxsplit=1)[0]
    return resolve_skill(command) if command.startswith("/") else None


def resolve_run_skill(user_message: str | None, selected_skill_id: str | None) -> AgentSkill:
    command = str(user_message or "").strip().split(maxsplit=1)[0]
    requested = command if command.startswith("/") else str(selected_skill_id or "")
    skill = resolve_skill(requested)
    if skill is None:
        raise ValueError(f"未知技能: {requested}")
    return skill


def fallback_skill(mode: str) -> AgentSkill:
    preferred = {
        "career_exploration": "title_discovery",
        "job_workflow": "scan_jobs",
        "resume_workflow": "tailor_resume",
        "application_tracking": "tracker",
        "follow_up": "follow_up",
    }.get(mode, "discovery")
    return resolve_skill(preferred) or _SKILLS[0]


async def select_skill(*, user_message: str, explicit_skill_id: str | None, fallback_mode: str) -> tuple[AgentSkill, str]:
    if explicit_skill_id:
        selected = resolve_skill(explicit_skill_id)
        if selected is None:
            raise ValueError(f"未知技能: {explicit_skill_id}")
        return selected, "explicit_ui_selection"

    selected = resolve_slash_skill(user_message)
    if selected is not None:
        return selected, "explicit_slash_command"

    visible = [skill for skill in _SKILLS if skill.featured]
    rows = "\n".join(f"- {skill.id}: {skill.description}" for skill in visible)
    try:
        from app.agents.llm import chat_completion, extract_json
        raw = await chat_completion(
            messages=[
                {"role": "system", "content": (
                    "Choose exactly one OfferU skill for the user's complete goal. "
                    "Return JSON only: {\"skill_id\":\"...\",\"reason\":\"...\"}. "
                    "Do not plan or execute tools.\n\n" + rows
                )},
                {"role": "user", "content": user_message[:2000]},
            ],
            temperature=0.0,
            json_mode=True,
            max_tokens=200,
            tier="fast",
        )
        parsed = extract_json(raw or "")
        selected = resolve_skill(parsed.get("skill_id") if isinstance(parsed, dict) else None)
        if selected is not None:
            return selected, str(parsed.get("reason") or "model_router")[:300]
    except Exception:
        pass
    return fallback_skill(fallback_mode), "deterministic_fallback"
