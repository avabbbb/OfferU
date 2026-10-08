from __future__ import annotations

import asyncio
import hashlib
import json
from dataclasses import dataclass
from typing import Any

from app.services.security_redaction import safe_error_message


SKILL_REGISTRY_VERSION = "2026-10-04.1"
CONFIRMATION_POLICY = "operation_registry"

# skill_id sentinel: request-level "let the router pick once"; never a registered Skill.
AUTO_SKILL_ID = "auto"

# Auto routing MUST NEVER land on integration/privileged Skills; they stay
# reachable only through explicit slash commands or explicit skill_id.
_NON_ROUTABLE_SKILL_IDS = frozenset(
    {"connection_bootstrap", "connection_probe", "career_director"}
)
# One bounded classification call per new Run; independent of per-request
# llm_timeout so a slow provider cannot silently stall routing forever.
SKILL_ROUTER_TIMEOUT_SECONDS = 30.0
_ROUTER_CONTEXT_MESSAGES = 6
_ROUTER_MESSAGE_CHARS = 400


def tool_contract_snapshot() -> dict[str, Any]:
    """Shared wire metadata; adapters reuse Registry schemas and execution."""
    from app.services.agent_integration import pending_connection_challenges

    return {
        "version": "offeru.tool-contract.v1",
        "schema_authority": "operation_registry",
        "truth_authority": "career_runtime",
        "approval_authority": "independent_user",
        "mutation_path": "execute_or_propose_operation",
        "bootstrap_skill": "connection_bootstrap",
        "bootstrap_operations": ["get_current_view"],
        "default_skill_id": AUTO_SKILL_ID,
        "skill_registry_version": SKILL_REGISTRY_VERSION,
        "connection_verification": pending_connection_challenges(),
        "interaction_authority": "active_host_native_input",
    }


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
        allowed_tools=frozenset(tools) | (
            frozenset({"prepare_proposal_plan", "get_proposal_plan", "list_proposal_plans"})
            if status == "native" and id not in {"connection_bootstrap", "connection_probe", "discovery"}
            else frozenset()
        ) | (frozenset({"review_resume_proposal_items"}) if id == "tailor_resume" else frozenset()),
        featured=featured,
        order=order,
        missing_capabilities=missing,
        aliases=aliases,
    )


_SKILLS = (
    _skill("discovery", "技能中心", "system", "native", "解释 OfferU 能做什么，并选择下一条最短路径。", "general", ("get_profile",), featured=True, order=10, aliases=("help", "menu")),
    _skill("connection_bootstrap", "连接 OfferU", "system", "native", "首次连接时只读当前 OfferU 页面，不读取职业档案或修改业务状态。", "skill_assistant", ("get_current_view",), featured=False, order=14, aliases=("current_view", "connect_offeru")),
    _skill("career_director", "职业总监", "system", "native", "在明确 AutomationEvent 下读取最小 Career State，生成有界、可审核的主动职业判断；只读，不直接修改 Career Truth。", "career_director", ("get_career_snapshot", "get_daily_career_context", "get_job_assessment_context", "get_interview_career_context"), featured=False, order=12, aliases=("director", "职业总监")),
    _skill("connection_probe", "连接验证", "system", "native", "仅用于 OfferU 发起的短时本机 Agent 集成验证；读取一次非敏感 nonce，不读取职业档案。", "skill_assistant", ("get_agent_connection_nonce",), featured=False, order=15, aliases=("verify_connection",)),
    _skill("pre_application_decision", "投前决策闭环", "pipeline", "native", "围绕一个真实岗位检查职业证据和调研，生成可复核投前决策；只有使用者确认投或有条件投后才生成简历提案。", "pre_application_workflow", ("get_profile", "list_jobs", "get_job", "get_pre_application_state", "prepare_pre_application_decision", "review_pre_application_decision", "start_job_research", "resume_job_research", "cancel_job_research", "review_job_research", "prepare_resume_optimization"), featured=True, order=20, aliases=("pre_application", "投前决策", "投前")),
    _skill("evaluate_job", "岗位评估", "jobs", "native", "基于档案与真实岗位内容做证据化匹配；粘贴的 JD 文本先经确认导入为 canonical Job 再评估。", "skill_assistant", ("get_profile", "list_jobs", "get_job", "import_jd", "list_career_artifacts", "save_career_artifact", "triage_job"), featured=True, order=30, aliases=("job", "岗位匹配")),
    _skill("compare_jobs", "岗位对比", "jobs", "native", "用统一维度比较多个岗位并给出有门槛的优先级。", "skill_assistant", ("get_profile", "list_jobs", "get_job", "batch_triage"), featured=True, order=40, aliases=("jobs", "岗位对比")),
    _skill("scan_jobs", "岗位发现", "jobs", "partial", "检查本地岗位库并形成可审核的筛选建议。", "job_workflow", ("get_profile", "list_pools", "list_jobs", "job_stats", "batch_triage"), featured=True, order=50, missing=("岗位抓取 Operation", "浏览器岗位存活检查"), aliases=("scan", "岗位扫描")),
    _skill("batch_evaluate", "批量评估", "jobs", "native", "用隔离的本地 coding-agent workers 并行评估岗位，并持久化断点与报告。", "skill_assistant", ("get_profile", "list_profile_evidence", "list_jobs", "get_job", "list_coding_agents", "list_batch_job_evaluations", "get_batch_job_evaluation", "start_batch_job_evaluation", "resume_batch_job_evaluation", "batch_triage"), featured=False, order=60, aliases=("batch", "批量")),
    _skill("tailor_resume", "定制简历", "documents", "native", "由当前 Agent 联网、询问定位与结构，再从已验证档案提交岗位化草稿；按语义分组提交决策计划，独立审核后采用。", "resume_workflow", ("get_profile", "inspect_resume_document", "list_jobs", "get_job", "list_resumes", "get_resume", "list_job_research_runs", "get_job_research", "start_job_research", "resume_job_research", "cancel_job_research", "review_job_research", "list_resume_optimizations", "get_resume_optimization", "prepare_resume_optimization", "review_resume_optimization", "get_resume_preparation_context", "persist_external_resume_proposal", "get_resume_workspace", "ensure_resume_workspace", "propose_resume_decision_plan"), featured=True, order=70, aliases=("resume", "简历", "定制简历")),
    _skill("resume_export", "简历排版与导出", "documents", "native", "读取简历和当前版本，提交版式、照片与校徽修改提案，确认后按编辑器同一排版导出 PDF；不改写正文。", "skill_assistant", ("list_resumes", "get_resume", "update_resume_design", "export_resume_pdf"), featured=False, order=80, aliases=("pdf", "export", "排版", "简历排版")),
    _skill("cover_letter", "求职信", "documents", "native", "基于真实岗位和简历生成并持久化可审阅求职信。", "skill_assistant", ("get_profile", "list_jobs", "get_job", "list_resumes", "get_resume", "list_career_artifacts", "get_career_artifact", "generate_cover_letter", "save_career_artifact"), featured=False, order=90, aliases=("cover", "求职信")),
    _skill("application_email", "申请邮件", "documents", "native", "生成并持久化正式申请邮件草稿，永不发送。", "skill_assistant", ("get_profile", "list_jobs", "get_job", "list_resumes", "get_resume", "get_application_workspace", "list_career_artifacts", "get_career_artifact", "save_career_artifact"), featured=False, order=100, aliases=("email", "申请邮件")),
    _skill("application_assistant", "投递助手", "applications", "partial", "起草投递材料、预演站外动作并登记待办；外部写入永远停在 OfferU Proposal/HITL。", "skill_assistant", ("get_profile", "list_jobs", "get_job", "get_pre_application_state", "list_resumes", "get_resume", "list_applications", "get_application_workspace", "preview_application_action", "list_application_action_connectors", "list_career_artifacts", "get_career_artifact", "generate_cover_letter", "save_career_artifact", "create_application", "update_application_record"), featured=True, order=110, missing=("ApplicationActionConnector 外部执行器",), aliases=("apply", "投递")),
    _skill("tracker", "投递追踪", "applications", "native", "以当前投递工作区和追加式事件时间线为事实源，汇总状态、遗漏与下一步。", "skill_assistant", ("list_applications", "get_application_workspace", "list_application_records", "list_application_events", "analyze_application_patterns", "list_follow_up_cadence", "update_application_status", "update_application_record"), featured=True, order=120, aliases=("tracker", "投递管理")),
    _skill("follow_up", "跟进节奏", "applications", "native", "按确定性节奏计算到期跟进，生成草稿；只有确认已发送后才记账。", "skill_assistant", ("get_profile", "list_applications", "get_application_workspace", "list_application_events", "list_application_progress_candidates", "get_application_progress_candidate", "get_application_progress_overview", "list_follow_up_cadence", "list_calendar_events", "email_connection_status", "list_email_accounts", "list_email_sync_runs", "get_email_sync_run", "list_career_artifacts", "get_career_artifact", "save_career_artifact", "record_follow_up", "review_application_progress", "update_application_status", "update_application_record", "sync_email_notifications", "revoke_email_account"), featured=True, order=130, aliases=("followup", "follow_up", "跟进")),
    _skill("reply_watch", "回复识别", "applications", "native", "用 Gmail historyId 或 IMAP UID 增量同步邮箱，把消息保存为候选进展；只有使用者确认后才追加投递阶段事件。", "skill_assistant", ("list_applications", "get_application_workspace", "list_application_events", "list_application_progress_candidates", "get_application_progress_candidate", "get_application_progress_overview", "email_connection_status", "list_email_accounts", "list_email_sync_runs", "get_email_sync_run", "list_career_artifacts", "get_career_artifact", "save_career_artifact", "review_application_progress", "sync_email_notifications", "revoke_email_account"), featured=False, order=140, aliases=("reply", "回复识别")),
    _skill("company_research", "公司与岗位调研", "research", "native", "以公开网页及使用者授权的本地只读浏览证据维护公司与岗位双档案，区分已引用、双来源印证、单一信号和未知，并只提炼匿名简历表达模式。", "skill_assistant", ("list_jobs", "get_job", "list_coding_agents", "list_job_research_runs", "get_job_research", "start_job_research", "resume_job_research", "cancel_job_research", "review_job_research", "list_hosted_executor_sessions", "get_hosted_executor_session", "list_authorized_research_sessions", "get_authorized_research_session", "start_authorized_research_session", "activate_authorized_research_read_only", "capture_authorized_research_page", "complete_authorized_research_session", "cancel_authorized_research_session"), featured=False, order=150, aliases=("deep", "research", "公司研究", "岗位调研")),
    _skill("role_intelligence", "岗位情报", "research", "native", "从目标 JD 收集并标准化同类岗位，使用确定性去重、cohort 和统计生成可回溯的市场基准与岗位 Delta；专项训练只读取已完成的 Delta 与 Career Evidence Gap。", "skill_assistant", ("get_profile", "list_profile_evidence", "get_job", "build_role_benchmark", "refresh_role_benchmark", "get_role_benchmark", "list_role_delta_signals", "prepare_role_interview_focus", "list_capability_plugins", "list_plugin_capabilities", "invoke_plugin_capability"), featured=True, order=155, aliases=("role", "role_intel", "benchmark", "岗位情报", "岗位基准")),
    _skill("contact_outreach", "联系人外联", "research", "partial", "识别合适联系人角色并起草短消息，不虚构联系人。", "skill_assistant", ("get_profile", "list_jobs", "get_job"), featured=False, order=160, missing=("联系人搜索与来源验证",), aliases=("contact", "联系人")),
    _skill("profile_onboarding", "档案访谈", "profile", "native", "渐进发现职业证据缺口；学习信号先进入记忆收件箱，来源校验通过并确认后才写入。", "skill_assistant", ("get_profile", "inspect_resume_document", "list_profile_evidence", "list_learning_observations", "list_memory_inbox", "create_memory_proposal", "review_memory_proposal"), featured=True, order=170, aliases=("profile", "档案")),
    _skill("add_profile_evidence", "补充职业证据", "profile", "native", "把项目、经历、技能或证书整理为来源可验证、可去重的档案条目。", "skill_assistant", ("get_profile", "list_profile_evidence", "add_profile_evidence"), featured=False, order=180, aliases=("add", "补充经历")),
    _skill("memory_inbox", "记忆收件箱", "profile", "native", "查看职业学习观察和模型变更提案；接受、拒绝、稍后或撤销，只有确认接受后才写入档案。", "skill_assistant", ("get_profile", "list_profile_evidence", "list_learning_observations", "list_memory_inbox", "create_memory_proposal", "consolidate_memory_observations", "review_memory_proposal", "invalidate_memory_source"), featured=True, order=185, aliases=("memory", "记忆", "记忆收件箱")),
    _skill("work_source_sync", "工作源同步", "profile", "native", "只读取使用者显式登记的本地工作源；每次模型读取单独授权，变化只进入学习观察和记忆收件箱。", "skill_assistant", ("get_profile", "list_work_sources", "get_work_source", "register_work_source", "start_work_source_sync", "list_work_source_sync_runs", "get_work_source_sync_run", "resume_work_source_sync", "consolidate_memory_observations", "list_learning_observations", "list_memory_inbox", "review_memory_proposal", "invalidate_work_source"), featured=False, order=187, aliases=("work", "工作源", "工作同步")),
    _skill("interview_prep", "面试准备", "interview", "native", "基于岗位、档案、题库和日程生成并保存准备方案（含按面试时间排优先级的分时冲刺计划）。", "skill_assistant", ("get_profile", "list_jobs", "get_job", "list_calendar_events", "list_interview_questions", "list_career_artifacts", "get_career_artifact", "save_career_artifact"), featured=True, order=190, aliases=("interview", "面试准备", "plan", "面试计划", "冲刺计划")),
    _skill("interview_practice", "模拟面试", "interview", "native", "确认模型和数据类别后一次一题练习；Role Intelligence 专项训练只根据确定性 Focus Plan 提问，内容按固定版本 Skill 引用原文评分，浏览器派生表达事件只作独立统计。", "skill_assistant", ("get_profile", "list_jobs", "get_job", "list_interview_questions", "get_ai_interview_runtime", "list_interview_scoring_skills", "get_interview_scoring_skill", "list_ai_interviews", "get_ai_interview", "prepare_role_interview_focus", "create_ai_interview", "submit_ai_interview_answer", "ingest_interview_behavior_events", "restart_ai_interview", "delete_ai_interview"), featured=True, order=200, aliases=("practice", "模拟面试", "ai面试")),
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
    _skill("agent_inbox", "持续任务箱", "system", "native", "查看主 Agent Run、CareerTask、coding-agent 批处理和中断状态。", "skill_assistant", ("list_agent_runs", "list_career_tasks", "get_career_task", "list_career_task_events", "get_career_task_result", "list_agent_provider_health", "list_batch_job_evaluations", "get_batch_job_evaluation", "resume_batch_job_evaluation"), featured=False, order=290, aliases=("inbox", "agent_inbox")),
    _skill("automation_inbox", "自动化任务箱", "system", "native", "读取事件驱动的后台任务与 Automation Inbox；自动化结果仍是候选或提案，不静默改写 Career Truth。", "skill_assistant", ("list_automation_events", "list_automation_inbox", "list_automation_rules", "get_career_task", "list_career_task_events", "get_career_task_result", "resolve_automation_inbox_item"), featured=False, order=295, aliases=("automation", "自动化", "自动化任务箱")),
)


def _directory_skills() -> tuple[AgentSkill, ...]:
    """延迟加载用户目录技能（backend/skills/<name>/SKILL.md），避免循环 import。"""
    from app.services.directory_skills import scan_directory_skills

    return tuple(scan_directory_skills())


def _plugin_skills() -> tuple[AgentSkill, ...]:
    """Load skills from installed capability plugins without importing them at startup."""
    try:
        from app.services.capability_plugins import plugin_skill_catalog

        return tuple(plugin_skill_catalog())
    except Exception:
        return ()


def catalog() -> list[dict[str, Any]]:
    skills = [*_SKILLS, *_directory_skills(), *_plugin_skills()]
    return [skill.summary() for skill in sorted(skills, key=lambda item: (item.order, item.id))]


def agent_operation_names(*, featured_only: bool = False) -> set[str]:
    """Return Operations intentionally exposed through Agent Skills.

    The Operation Registry is the governed execution/control plane and includes
    UI-only, migration, diagnostic and compatibility Operations.  It is not the
    same thing as the model-facing Tool surface.

    This helper is the single projection boundary used by CLI discovery:
    - all Skill allowlists -> complete Agent Tool surface;
    - featured Skills only -> default compact discovery surface.
    """

    names: set[str] = set()
    for skill in catalog():
        if featured_only and not bool(skill.get("featured")):
            continue
        names.update(str(name) for name in skill.get("allowed_tools") or [] if str(name))
    return names


def registry_snapshot(operation_schemas: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    skills = catalog()
    if operation_schemas is not None:
        available = {str(operation.get("name") or "") for operation in operation_schemas}
        # 内置技能引用未注册 Operation = 开发错误，直接暴露；
        # 目录技能（用户配置）声明了未注册工具则宽容过滤，不阻塞启动。
        builtin_ids = {skill.id for skill in _SKILLS}
        invalid = {
            skill["id"]: sorted(set(skill["allowed_tools"]) - available)
            for skill in skills
            if skill["id"] in builtin_ids and set(skill["allowed_tools"]) - available
        }
        if invalid:
            raise ValueError(f"Skill Registry 引用了未注册 Operation: {invalid}")
        skills = [
            {
                **skill,
                "allowed_tools": sorted(
                    set(skill["allowed_tools"]).intersection(available)
                ),
            }
            for skill in skills
        ]
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


def skill_tool_catalog(operation_schemas: list[dict[str, Any]], skill_id: str = "") -> dict[str, Any]:
    """Host-neutral compact discovery; selecting a Skill expands its allowlist."""
    snapshot = registry_snapshot(operation_schemas)
    skill = resolve_skill(skill_id) if skill_id else None
    if skill_id and skill is None:
        raise ValueError(f"未知技能: {skill_id}")
    selected = [item for item in snapshot["skills"] if not skill or item["id"] == skill.id]
    names = set(skill.allowed_tools) if skill else set()
    return {
        "tool_contract": tool_contract_snapshot(),
        "operations": [item for item in operation_schemas if item["name"] in names],
        "skill_registry": {
            "version": snapshot["version"], "sha256": snapshot["sha256"],
            "skills": selected if skill else [{
                key: value for key, value in item.items()
                if key not in {"allowed_tools", "confirmation_required_operations", "risk_notes"}
            } for item in selected],
        },
    }


def resolve_skill(value: str | None) -> AgentSkill | None:
    normalized = str(value or "").strip().lower().lstrip("/").replace("-", "_")
    if not normalized:
        return None
    if normalized == "offeru":
        normalized = "discovery"
    for skill in (*_SKILLS, *_directory_skills(), *_plugin_skills()):
        if normalized == skill.id or normalized in skill.aliases:
            return skill
    return None


def run_allowed_tools(run: dict[str, Any] | None) -> frozenset[str]:
    """The Run's tool scope: its frozen Skill snapshot, else the Registry Skill.

    A Run normally freezes ``skill_snapshot.allowed_tools`` when it starts.
    Older or externally created Runs can carry only ``skill_id`` with an empty
    snapshot; refusing every Plan for them left the user with no way forward.
    The Registry is the authority for a Skill's scope, so the persisted
    ``skill_id`` resolves the same allowlist the Run would have frozen. A Run
    with neither stays empty (callers still deny it).
    """
    if not isinstance(run, dict):
        return frozenset()
    snapshot = run.get("skill_snapshot") if isinstance(run.get("skill_snapshot"), dict) else {}
    frozen = frozenset(str(name) for name in (snapshot.get("allowed_tools") or []) if str(name))
    if frozen:
        return frozen
    skill = resolve_skill(str(run.get("skill_id") or snapshot.get("id") or ""))
    return frozenset(skill.allowed_tools) if skill is not None else frozenset()


def resolve_slash_skill(user_message: str | None) -> AgentSkill | None:
    command = str(user_message or "").strip().split(maxsplit=1)[0]
    return resolve_skill(command) if command.startswith("/") else None


class SkillRoutingError(ValueError):
    """Auto Skill routing failed; surfaced instead of silently picking a Skill."""


@dataclass(frozen=True)
class SkillRouting:
    """How a Run's Skill was chosen; recorded once and frozen with the Run.

    The frozen provenance is exactly ``via``/``requested``/``reason``. The
    canonical Career State the router saw is prompt input only; it must never
    leak into persisted Run provenance or the display Skill summary.
    """

    via: str  # "explicit" | "slash" | "auto"
    requested: str = ""
    reason: str = ""

    def provenance(self) -> dict[str, Any]:
        return {"via": self.via, "requested": self.requested, "reason": self.reason}


def _is_routable_skill(skill: AgentSkill) -> bool:
    """Auto routing may only land on user-facing business Skills.

    Integration probes and the autonomous Career Director stay explicit-only,
    and plugin Skills are never auto-selected because their tool surface is an
    arbitrary plugin capability, not a governed Operation allowlist.
    """
    return skill.id not in _NON_ROUTABLE_SKILL_IDS and skill.group != "plugin"


def _routable_skills() -> list[AgentSkill]:
    from app.ops import OPERATIONS

    return [
        skill
        for skill in (*_SKILLS, *_directory_skills(), *_plugin_skills())
        if _is_routable_skill(skill)
        and any(name in OPERATIONS for name in skill.allowed_tools)
    ]


def _auto_requested(value: str | None) -> bool:
    return (
        str(value or "").strip().lower().lstrip("/").replace("-", "_")
        == AUTO_SKILL_ID
    )


def resolve_declared_skill(
    user_message: str | None,
    selected_skill_id: str | None,
) -> tuple[AgentSkill, SkillRouting] | None:
    """Resolve the explicitly declared Skill without model routing.

    Slash commands win over a UI skill_id, matching the historical contract;
    unknown declared ids raise instead of falling back. Returns None when the
    request is (or defaults to) auto routing.
    """
    goal = str(user_message or "").strip()
    command = goal.split(maxsplit=1)[0] if goal else ""
    requested = str(selected_skill_id or "").strip()
    if command.startswith("/"):
        skill = resolve_skill(command)
        if skill is None:
            raise ValueError(f"未知技能: {command}")
        return skill, SkillRouting(via="slash", requested=command)
    if _auto_requested(requested) or not requested:
        return None
    skill = resolve_skill(requested)
    if skill is None:
        raise ValueError(f"未知技能: {requested}")
    return skill, SkillRouting(via="explicit", requested=requested)


def _router_transcript(
    user_message: str,
    context_messages: list[dict[str, str]] | None,
) -> str:
    """Build a bounded, desensitized routing transcript from untrusted text."""
    from app.agents.desensitize import desensitize

    rows: list[str] = []
    for item in (context_messages or [])[-_ROUTER_CONTEXT_MESSAGES:]:
        role = str(item.get("role") or "").strip()
        content = str(item.get("content") or "").strip()
        if role not in {"user", "assistant"} or not content:
            continue
        masked, _ = desensitize(content[:_ROUTER_MESSAGE_CHARS])
        rows.append(f"{role}: {masked}")
    masked_goal, _ = desensitize(str(user_message or "").strip()[:2000])
    rows.append(f"current user: {masked_goal}")
    return "\n".join(rows)


async def _auto_route_skill(
    *,
    user_message: str,
    context_messages: list[dict[str, str]] | None,
    requested: str,
    routing_context: dict[str, Any] | None = None,
) -> tuple[AgentSkill, SkillRouting]:
    """Classify one routable Skill through the canonical configured LLM.

    Any failure (timeout, provider/model error, non-JSON or unknown/privileged
    reply) raises SkillRoutingError before business execution; routing never
    silently degrades to a fixed Skill.
    """
    from app.agents.llm import chat_completion, extract_json

    candidates = _routable_skills()
    if not candidates:
        raise SkillRoutingError("Skill 自动路由没有可用候选；请显式选择技能。")
    catalog_rows = "\n".join(
        f'- "{skill.id}": {skill.description}' for skill in candidates
    )
    try:
        raw = await asyncio.wait_for(
            chat_completion(
                messages=[
                    {
                        "role": "system",
                        "content": (
                            "You route one user request to exactly one OfferU Skill. "
                            "Pick the skill whose purpose best matches the goal; "
                            'respond with JSON only: {"skill_id":"<id>","reason":"<short>"} '
                            "using an id copied verbatim from this list:\n"
                            + catalog_rows
                        ),
                    },
                    {"role": "user", "content": _router_transcript(user_message, context_messages)
                     + "\nCanonical current Career State:\n" + json.dumps(routing_context or {}, ensure_ascii=False)},
                ],
                temperature=0.0,
                json_mode=True,
                max_tokens=200,
            ),
            timeout=SKILL_ROUTER_TIMEOUT_SECONDS,
        )
    except asyncio.TimeoutError:
        raise SkillRoutingError(
            f"Skill 自动路由超时（{int(SKILL_ROUTER_TIMEOUT_SECONDS)}s），请显式选择技能后重试。"
        )
    except Exception as exc:
        raise SkillRoutingError(
            f"Skill 自动路由失败：{safe_error_message(exc)}"
        ) from exc
    if not raw:
        raise SkillRoutingError("Skill 自动路由无响应（LLM 未返回结果）；请显式选择技能后重试。")
    parsed = extract_json(raw)
    selected_id = str(parsed.get("skill_id") or "").strip() if isinstance(parsed, dict) else ""
    resolved = resolve_skill(selected_id) if selected_id else None
    if resolved is None or resolved.id not in {skill.id for skill in candidates}:
        raise SkillRoutingError(
            f"Skill 自动路由返回了无效技能（{selected_id or '空响应'}）；请显式选择技能后重试。"
        )
    reason = str(parsed.get("reason") or "") if isinstance(parsed, dict) else ""
    return resolved, SkillRouting(
        via="auto",
        requested=requested or AUTO_SKILL_ID,
        reason=reason[:300],
    )


async def resolve_run_skill(
    user_message: str | None,
    selected_skill_id: str | None,
    context_messages: list[dict[str, str]] | None = None,
    *,
    routing_context: dict[str, Any] | None = None,
) -> tuple[AgentSkill, SkillRouting]:
    """Resolve the Skill for one new Run: declared inputs first, auto routing second.

    - Explicit skill_id and slash commands resolve deterministically; unknown
      ids raise ValueError and never fall back.
    - skill_id="auto" (or empty) runs exactly one bounded classification through
      the canonical configured LLM and may only return a routable Skill.
    """
    declared = resolve_declared_skill(user_message, selected_skill_id)
    if declared is not None:
        return declared
    return await _auto_route_skill(
        user_message=str(user_message or "").strip(),
        context_messages=context_messages,
        requested=str(selected_skill_id or "").strip(),
        routing_context=routing_context,
    )
