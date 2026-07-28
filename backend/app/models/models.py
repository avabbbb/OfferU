# =============================================
# OfferU - 数据库模型定义
# =============================================
# 核心表：jobs, resumes, resume_sections, resume_templates,
#         interview_notifications, calendar_events, applications
# 使用 SQLAlchemy 2.0 Mapped 声明式语法
# =============================================

from datetime import datetime
from typing import Optional

from sqlalchemy import (
    JSON,
    Boolean,
    DateTime,
    Float,
    Integer,
    String,
    Text,
    ForeignKey,
    UniqueConstraint,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base


class Job(Base):
    """岗位表：存储从各平台爬取的岗位信息"""
    __tablename__ = "jobs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    # ---- 岗位基本信息 ----
    title: Mapped[str] = mapped_column(String(500), index=True)
    company: Mapped[str] = mapped_column(String(300), index=True)
    location: Mapped[str] = mapped_column(String(300), default="")
    url: Mapped[str] = mapped_column(Text, default="")
    apply_url: Mapped[str] = mapped_column(Text, default="")
    source: Mapped[str] = mapped_column(String(50), index=True, default="linkedin")
    raw_description: Mapped[str] = mapped_column(Text, default="")
    posted_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)

    # ---- 岗位详情（校招场景关键字段） ----
    salary_min: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)  # 月薪下限（元）
    salary_max: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)  # 月薪上限（元）
    salary_text: Mapped[str] = mapped_column(String(100), default="")  # 原始薪资文本，如 "15-25K·13薪"
    education: Mapped[str] = mapped_column(String(50), default="")  # 学历要求，如 "本科" "硕士"
    experience: Mapped[str] = mapped_column(String(100), default="")  # 经验要求，如 "1-3年" "应届"
    job_type: Mapped[str] = mapped_column(String(50), default="")  # 岗位类型，如 "全职" "实习" "校招"
    company_size: Mapped[str] = mapped_column(String(100), default="")  # 公司规模，如 "100-499人"
    company_industry: Mapped[str] = mapped_column(String(200), default="")  # 行业，如 "游戏" "AI"
    company_logo: Mapped[str] = mapped_column(Text, default="")  # 公司 Logo URL
    is_campus: Mapped[bool] = mapped_column(Boolean, default=False)  # 是否校招岗位

    # ---- AI 分析输出 ----
    summary: Mapped[str] = mapped_column(Text, default="")
    keywords: Mapped[Optional[list]] = mapped_column(JSON, default=list)

    # ---- Inbox 分拣与池分组 ----
    triage_status: Mapped[str] = mapped_column(String(20), default="inbox", index=True)
    pool_id: Mapped[Optional[int]] = mapped_column(
        Integer,
        ForeignKey("pools.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )
    # 采集批次 ID；历史数据统一回填为 legacy-import
    batch_id: Mapped[str] = mapped_column(String(64), default="legacy-import", index=True)

    # ---- 元数据 ----
    hash_key: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())

    pool: Mapped[Optional["Pool"]] = relationship(back_populates="jobs")


class ResearchDossier(Base):
    """公司或岗位研究档案；结论必须能够回溯到一次研究运行。"""

    __tablename__ = "research_dossiers"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    dossier_key: Mapped[str] = mapped_column(String(80), unique=True, index=True)
    dossier_type: Mapped[str] = mapped_column(String(20), index=True)
    company_name: Mapped[str] = mapped_column(String(300), index=True)
    job_id: Mapped[Optional[int]] = mapped_column(
        Integer, ForeignKey("jobs.id", ondelete="CASCADE"), nullable=True, index=True
    )
    parent_dossier_id: Mapped[Optional[int]] = mapped_column(
        Integer, ForeignKey("research_dossiers.id", ondelete="SET NULL"), nullable=True
    )
    status: Mapped[str] = mapped_column(String(24), default="active", index=True)
    latest_run_id: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    summary_json: Mapped[dict] = mapped_column(JSON, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), onupdate=func.now()
    )


class JobResearchRun(Base):
    """单岗位证据化研究运行；公开网失败后由显式 resume 继续。"""

    __tablename__ = "job_research_runs"

    run_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    job_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("jobs.id", ondelete="CASCADE"), index=True
    )
    company_dossier_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("research_dossiers.id", ondelete="CASCADE"), index=True
    )
    role_dossier_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("research_dossiers.id", ondelete="CASCADE"), index=True
    )
    runtime_id: Mapped[str] = mapped_column(String(40), default="codex")
    runtime_version: Mapped[str] = mapped_column(String(120), default="")
    status: Mapped[str] = mapped_column(String(24), default="pending", index=True)
    review_status: Mapped[str] = mapped_column(String(24), default="pending")
    result_json: Mapped[dict] = mapped_column(JSON, default=dict)
    report_markdown: Mapped[str] = mapped_column(Text, default="")
    trace_json: Mapped[dict] = mapped_column(JSON, default=dict)
    error: Mapped[str] = mapped_column(Text, default="")
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), onupdate=func.now()
    )
    started_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    completed_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)


class ResearchEvidenceSnapshot(Base):
    """研究运行保存的最小来源快照，不保存页面、登录状态或完整简历。"""

    __tablename__ = "research_evidence_snapshots"
    __table_args__ = (
        UniqueConstraint("run_id", "source_ref", name="uq_research_evidence_run_ref"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    run_id: Mapped[str] = mapped_column(
        String(64), ForeignKey("job_research_runs.run_id", ondelete="CASCADE"), index=True
    )
    dossier_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("research_dossiers.id", ondelete="CASCADE"), index=True
    )
    source_ref: Mapped[str] = mapped_column(String(80))
    url: Mapped[str] = mapped_column(Text)
    title: Mapped[str] = mapped_column(String(500), default="")
    publisher: Mapped[str] = mapped_column(String(300), default="")
    source_class: Mapped[str] = mapped_column(String(40), index=True)
    published_at: Mapped[Optional[str]] = mapped_column(String(80), nullable=True)
    retrieved_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    excerpt: Mapped[str] = mapped_column(Text, default="")
    content_hash: Mapped[str] = mapped_column(String(64), index=True)


class ResearchFinding(Base):
    """带证据等级的研究结论；source_refs_json 必须引用同一运行的快照。"""

    __tablename__ = "research_findings"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    run_id: Mapped[str] = mapped_column(
        String(64), ForeignKey("job_research_runs.run_id", ondelete="CASCADE"), index=True
    )
    dossier_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("research_dossiers.id", ondelete="CASCADE"), index=True
    )
    finding_type: Mapped[str] = mapped_column(String(40), index=True)
    statement: Mapped[str] = mapped_column(Text)
    details_json: Mapped[dict] = mapped_column(JSON, default=dict)
    source_refs_json: Mapped[list] = mapped_column(JSON, default=list)
    evidence_level: Mapped[str] = mapped_column(String(24), index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())


class AuthorizedResearchSession(Base):
    """用户手动登录的临时浏览会话；不持久化 Cookie、密码或 storage state。"""

    __tablename__ = "authorized_research_sessions"

    session_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    job_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("jobs.id", ondelete="CASCADE"), index=True
    )
    base_run_id: Mapped[Optional[str]] = mapped_column(
        String(64),
        ForeignKey("job_research_runs.run_id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )
    completed_run_id: Mapped[Optional[str]] = mapped_column(
        String(64),
        ForeignKey("job_research_runs.run_id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )
    platform: Mapped[str] = mapped_column(String(40), index=True)
    initial_url: Mapped[str] = mapped_column(Text)
    status: Mapped[str] = mapped_column(String(24), default="starting", index=True)
    read_only_active: Mapped[bool] = mapped_column(Boolean, default=False)
    error: Mapped[str] = mapped_column(Text, default="")
    expires_at: Mapped[datetime] = mapped_column(DateTime, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), onupdate=func.now()
    )
    completed_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)


class AuthorizedResearchCapture(Base):
    """登录态页面上由用户选中的最小证据摘录；不保存页面、截图或身份状态。"""

    __tablename__ = "authorized_research_captures"
    __table_args__ = (
        UniqueConstraint(
            "session_id",
            "content_hash",
            name="uq_authorized_research_session_content",
        ),
    )

    capture_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    session_id: Mapped[str] = mapped_column(
        String(64),
        ForeignKey("authorized_research_sessions.session_id", ondelete="CASCADE"),
        index=True,
    )
    job_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("jobs.id", ondelete="CASCADE"), index=True
    )
    dossier_scope: Mapped[str] = mapped_column(String(20), index=True)
    url: Mapped[str] = mapped_column(Text)
    title: Mapped[str] = mapped_column(String(500), default="")
    publisher: Mapped[str] = mapped_column(String(300), default="")
    source_class: Mapped[str] = mapped_column(String(40), index=True)
    published_at: Mapped[Optional[str]] = mapped_column(String(80), nullable=True)
    excerpt: Mapped[str] = mapped_column(Text)
    content_hash: Mapped[str] = mapped_column(String(64), index=True)
    authorization_json: Mapped[dict] = mapped_column(JSON, default=dict)
    status: Mapped[str] = mapped_column(String(24), default="staged", index=True)
    captured_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())


class Pool(Base):
    """岗位池：用于在已筛选岗位中按主题做分组（前端语义为文件夹）"""

    __tablename__ = "pools"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    name: Mapped[str] = mapped_column(String(100), unique=True, index=True)
    description: Mapped[str] = mapped_column(Text, default="")
    color: Mapped[str] = mapped_column(String(20), default="#3B82F6")
    sort_order: Mapped[int] = mapped_column(Integer, default=0)
    scope: Mapped[str] = mapped_column(String(20), default="picked", index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), onupdate=func.now()
    )

    jobs: Mapped[list["Job"]] = relationship(back_populates="pool")


class Batch(Base):
    """采集批次：记录一次采集任务的上下文，用于 Inbox 分区"""

    __tablename__ = "batches"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    source: Mapped[str] = mapped_column(String(50), default="")
    keywords: Mapped[Optional[list]] = mapped_column(JSON, default=list)
    location: Mapped[str] = mapped_column(String(100), default="")
    max_results: Mapped[int] = mapped_column(Integer, default=0)
    job_count: Mapped[int] = mapped_column(Integer, default=0)
    status: Mapped[str] = mapped_column(String(20), default="completed")
    total_fetched: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())


class Profile(Base):
    """个人档案主表：承载基础信息与叙事字段"""

    __tablename__ = "profiles"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    name: Mapped[str] = mapped_column(String(120), default="默认档案")
    school: Mapped[str] = mapped_column(String(200), default="")
    major: Mapped[str] = mapped_column(String(200), default="")
    degree: Mapped[str] = mapped_column(String(50), default="")
    gpa: Mapped[str] = mapped_column(String(20), default="")
    email: Mapped[str] = mapped_column(String(200), default="")
    phone: Mapped[str] = mapped_column(String(50), default="")
    wechat: Mapped[str] = mapped_column(String(100), default="")
    headline: Mapped[str] = mapped_column(String(300), default="")
    exit_story: Mapped[str] = mapped_column(Text, default="")
    cross_cutting_advantage: Mapped[str] = mapped_column(Text, default="")
    base_info_json: Mapped[dict] = mapped_column(JSON, default=dict)
    is_default: Mapped[bool] = mapped_column(Boolean, default=True)
    onboarding_step: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), onupdate=func.now()
    )

    target_roles: Mapped[list["ProfileTargetRole"]] = relationship(
        back_populates="profile", cascade="all, delete-orphan"
    )
    sections: Mapped[list["ProfileSection"]] = relationship(
        back_populates="profile",
        cascade="all, delete-orphan",
        order_by="ProfileSection.sort_order",
    )
    chat_sessions: Mapped[list["ProfileChatSession"]] = relationship(
        back_populates="profile", cascade="all, delete-orphan"
    )


class ProfileTargetRole(Base):
    """目标岗位条目：支持 fit 分级"""

    __tablename__ = "profile_target_roles"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    profile_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("profiles.id", ondelete="CASCADE"), index=True
    )
    role_name: Mapped[str] = mapped_column(String(120), index=True)
    role_level: Mapped[str] = mapped_column(String(60), default="")
    fit: Mapped[str] = mapped_column(String(30), default="primary")
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())

    profile: Mapped["Profile"] = relationship(back_populates="target_roles")


class ProfileSection(Base):
    """档案条目：Bullet 级事实条目，支持来源与置信度"""

    __tablename__ = "profile_sections"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    profile_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("profiles.id", ondelete="CASCADE"), index=True
    )
    section_type: Mapped[str] = mapped_column(String(60), index=True)
    parent_id: Mapped[Optional[int]] = mapped_column(
        Integer, ForeignKey("profile_sections.id", ondelete="SET NULL"), nullable=True
    )
    title: Mapped[str] = mapped_column(String(220), default="")
    sort_order: Mapped[int] = mapped_column(Integer, default=0)
    content_json: Mapped[dict] = mapped_column(JSON, default=dict)
    source: Mapped[str] = mapped_column(String(30), default="manual")
    confidence: Mapped[float] = mapped_column(Float, default=1.0)
    tier: Mapped[Optional[str]] = mapped_column(String(32), nullable=True, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), onupdate=func.now()
    )

    profile: Mapped["Profile"] = relationship(back_populates="sections")


class WorkSource(Base):
    """使用者显式登记并授权只读同步的本地工作源。"""

    __tablename__ = "work_sources"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    source_key: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    name: Mapped[str] = mapped_column(String(220), default="")
    source_type: Mapped[str] = mapped_column(String(32), default="directory", index=True)
    root_path: Mapped[str] = mapped_column(Text)
    runtime_id: Mapped[str] = mapped_column(String(40), default="codex")
    include_patterns_json: Mapped[list] = mapped_column(JSON, default=list)
    exclude_patterns_json: Mapped[list] = mapped_column(JSON, default=list)
    checkpoint_json: Mapped[dict] = mapped_column(JSON, default=dict)
    status: Mapped[str] = mapped_column(String(24), default="active", index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), onupdate=func.now()
    )
    last_synced_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    invalidated_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)


class WorkSourceSyncRun(Base):
    """工作源变化摘要运行；结果只能形成学习观察和待确认记忆提案。"""

    __tablename__ = "work_source_sync_runs"

    run_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    work_source_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("work_sources.id", ondelete="CASCADE"), index=True
    )
    runtime_id: Mapped[str] = mapped_column(String(40), default="codex")
    runtime_version: Mapped[str] = mapped_column(String(120), default="")
    status: Mapped[str] = mapped_column(String(24), default="pending", index=True)
    checkpoint_before_json: Mapped[dict] = mapped_column(JSON, default=dict)
    checkpoint_after_json: Mapped[dict] = mapped_column(JSON, default=dict)
    result_json: Mapped[dict] = mapped_column(JSON, default=dict)
    trace_json: Mapped[dict] = mapped_column(JSON, default=dict)
    error: Mapped[str] = mapped_column(Text, default="")
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    observation_id: Mapped[Optional[int]] = mapped_column(
        Integer,
        ForeignKey("learning_observations.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), onupdate=func.now()
    )
    started_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    completed_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)


class EmailAccount(Base):
    """邮箱账号元数据；原始凭据只由 credential_ref 指向系统钥匙串。"""

    __tablename__ = "email_accounts"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    account_id: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    account_key: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    signal_account_ref: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    provider: Mapped[str] = mapped_column(String(24), index=True)
    email_address: Mapped[str] = mapped_column(String(320), default="", index=True)
    host: Mapped[str] = mapped_column(String(500), default="")
    port: Mapped[int] = mapped_column(Integer, default=0)
    auth_type: Mapped[str] = mapped_column(String(32), default="")
    scopes_json: Mapped[list] = mapped_column(JSON, default=list)
    credential_ref: Mapped[str] = mapped_column(String(160), default="")
    sync_cursor_json: Mapped[dict] = mapped_column(JSON, default=dict)
    sync_enabled: Mapped[bool] = mapped_column(default=True, index=True)
    status: Mapped[str] = mapped_column(String(24), default="active", index=True)
    last_error: Mapped[str] = mapped_column(Text, default="")
    last_synced_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), onupdate=func.now()
    )
    revoked_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)


class EmailSyncRun(Base):
    """一次持久化邮箱增量同步；游标只在所有消息幂等入库后推进。"""

    __tablename__ = "email_sync_runs"

    run_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    email_account_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("email_accounts.id", ondelete="CASCADE"), index=True
    )
    provider: Mapped[str] = mapped_column(String(24), index=True)
    status: Mapped[str] = mapped_column(String(24), default="pending", index=True)
    cursor_before_json: Mapped[dict] = mapped_column(JSON, default=dict)
    cursor_after_json: Mapped[dict] = mapped_column(JSON, default=dict)
    result_json: Mapped[dict] = mapped_column(JSON, default=dict)
    trace_json: Mapped[dict] = mapped_column(JSON, default=dict)
    error: Mapped[str] = mapped_column(Text, default="")
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), onupdate=func.now()
    )
    started_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    completed_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)


class CareerSource(Base):
    """职业模型来源：只保存可撤销来源的本地标识和最小元数据。"""

    __tablename__ = "career_sources"
    __table_args__ = (
        UniqueConstraint("source_type", "external_id", name="uq_career_source_identity"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    source_type: Mapped[str] = mapped_column(String(60), index=True)
    external_id: Mapped[str] = mapped_column(String(255))
    title: Mapped[str] = mapped_column(String(300), default="")
    locator: Mapped[str] = mapped_column(Text, default="")
    metadata_json: Mapped[dict] = mapped_column(JSON, default=dict)
    status: Mapped[str] = mapped_column(String(24), default="active", index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), onupdate=func.now()
    )
    invalidated_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)


class LearningObservation(Base):
    """模块即时记录的可追溯学习信号；它本身不是职业事实。"""

    __tablename__ = "learning_observations"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    source_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("career_sources.id", ondelete="CASCADE"), index=True
    )
    observation_type: Mapped[str] = mapped_column(String(80), index=True)
    content_json: Mapped[dict] = mapped_column(JSON, default=dict)
    content_hash: Mapped[str] = mapped_column(String(64), index=True)
    idempotency_key: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    status: Mapped[str] = mapped_column(String(24), default="active", index=True)
    observed_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(), index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    invalidated_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    # memory distiller 已处理标记（LLM 提炼 memory_candidates 后回填）
    distilled_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)


class MemoryProposal(Base):
    """记忆收件箱中的职业模型变更建议；审核前不得改写 Profile。"""

    __tablename__ = "memory_proposals"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    proposal_key: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    target_tier: Mapped[str] = mapped_column(String(32), index=True)
    section_type: Mapped[str] = mapped_column(String(60), index=True)
    title: Mapped[str] = mapped_column(String(220), default="")
    before_json: Mapped[dict] = mapped_column(JSON, default=dict)
    after_json: Mapped[dict] = mapped_column(JSON, default=dict)
    reason: Mapped[str] = mapped_column(Text, default="")
    impact_json: Mapped[list] = mapped_column(JSON, default=list)
    status: Mapped[str] = mapped_column(String(24), default="pending", index=True)
    applied_profile_section_id: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    review_note: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(), index=True)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), onupdate=func.now()
    )
    reviewed_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    invalidated_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)


class EvidenceLink(Base):
    """把学习观察连接到记忆提案或确认后的 Profile 条目。"""

    __tablename__ = "evidence_links"
    __table_args__ = (
        UniqueConstraint(
            "observation_id",
            "target_type",
            "target_id",
            "relation",
            name="uq_evidence_link_target",
        ),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    observation_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("learning_observations.id", ondelete="CASCADE"), index=True
    )
    target_type: Mapped[str] = mapped_column(String(40), index=True)
    target_id: Mapped[int] = mapped_column(Integer, index=True)
    relation: Mapped[str] = mapped_column(String(40), default="supports")
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    invalidated_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)


class ProfileChatSession(Base):
    """档案对话会话：记录多轮消息与候选条目提取结果"""

    __tablename__ = "profile_chat_sessions"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    profile_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("profiles.id", ondelete="CASCADE"), index=True
    )
    topic: Mapped[str] = mapped_column(String(60), default="general")
    messages_json: Mapped[list] = mapped_column(JSON, default=list)
    extracted_bullets: Mapped[list] = mapped_column(JSON, default=list)
    extracted_bullets_count: Mapped[int] = mapped_column(Integer, default=0)
    status: Mapped[str] = mapped_column(String(20), default="active")
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), onupdate=func.now()
    )

    profile: Mapped["Profile"] = relationship(back_populates="chat_sessions")


class ResumeTemplate(Base):
    """
    简历模板表：存储内置和用户自定义的简历模板
    ─────────────────────────────────────────────
    模板通过 CSS 变量控制样式（主色调/字号/边距等），
    html_layout 使用 Jinja2 语法定义 A4 页面的 HTML 结构。
    前端预览时通过 css_variables 注入 CSS 自定义属性，
    后端 PDF 导出时同样将 css_variables 渲染进 HTML。
    """
    __tablename__ = "resume_templates"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    name: Mapped[str] = mapped_column(String(100))
    thumbnail_url: Mapped[str] = mapped_column(String(500), default="")
    # CSS 变量集合：{ primaryColor, accentColor, bodySize, headingSize, lineHeight, pageMargin, sectionGap, fontFamily }
    css_variables: Mapped[dict] = mapped_column(JSON, default=dict)
    # Jinja2 HTML 模板，渲染简历为 A4 页面
    html_layout: Mapped[str] = mapped_column(Text, default="")
    is_builtin: Mapped[bool] = mapped_column(default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())


class Resume(Base):
    """
    简历主表：存储简历元信息和全局设置
    ─────────────────────────────────────────────
    一个用户可拥有多份简历（不同语言/不同方向）。
    简历的具体内容段落存储在 ResumeSection 子表中，
    通过 resume_id FK 关联，删除简历时级联删除所有段落。
    style_config 存储用户对模板样式的覆盖（如修改字号/颜色），
    与模板的 css_variables 合并后生成最终样式。
    """
    __tablename__ = "resumes"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_name: Mapped[str] = mapped_column(String(200))
    title: Mapped[str] = mapped_column(String(300), default="未命名简历")
    photo_url: Mapped[str] = mapped_column(String(500), default="")
    # 个人简介 HTML（TipTap 富文本输出）
    summary: Mapped[str] = mapped_column(Text, default="")
    # 联系方式结构化数据：{ phone, email, linkedin, website, github, ... }
    contact_json: Mapped[dict] = mapped_column(JSON, default=dict)
    # 关联模板（可为空，使用系统默认）
    template_id: Mapped[Optional[int]] = mapped_column(
        Integer, ForeignKey("resume_templates.id"), nullable=True
    )
    # 用户对模板样式的覆盖：{ primaryColor, bodySize, lineHeight, ... }
    style_config: Mapped[dict] = mapped_column(JSON, default=dict)
    is_primary: Mapped[bool] = mapped_column(default=True)
    language: Mapped[str] = mapped_column(String(10), default="zh")
    source_mode: Mapped[str] = mapped_column(String(30), default="manual")
    source_job_ids: Mapped[Optional[list]] = mapped_column(JSON, default=list)
    source_profile_snapshot: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)
    source_profile_id: Mapped[Optional[int]] = mapped_column(
        Integer, ForeignKey("profiles.id", ondelete="SET NULL"), nullable=True, index=True
    )
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), onupdate=func.now()
    )

    # ORM 关系：简历包含的段落列表，按 sort_order 排序
    sections: Mapped[list["ResumeSection"]] = relationship(
        back_populates="resume", cascade="all, delete-orphan",
        order_by="ResumeSection.sort_order"
    )
    template: Mapped[Optional["ResumeTemplate"]] = relationship()


class ResumeSection(Base):
    """
    简历段落通用块表：每一段（教育/经历/技能/项目/自定义）是一条记录
    ─────────────────────────────────────────────
    采用通用块设计：section_type 区分类型，content_json 内部按类型存不同结构。
    这样新增段落类型（如"证书""荣誉"）不需要修改数据库表结构。

    content_json 按 section_type 的约定结构：
      education:   [{ school, degree, major, gpa, startDate, endDate, description }]
      experience:  [{ company, position, startDate, endDate, description }]
      skill:       [{ category, items: ["Python", "React", ...] }]
      project:     [{ name, role, url, startDate, endDate, description }]
      certificate: [{ name, issuer, date, url }]
      custom:      [{ subtitle, description }]

    description 字段存储 TipTap 输出的 HTML，支持富文本排版。
    """
    __tablename__ = "resume_sections"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    resume_id: Mapped[int] = mapped_column(Integer, ForeignKey("resumes.id", ondelete="CASCADE"))
    section_type: Mapped[str] = mapped_column(String(50))
    sort_order: Mapped[int] = mapped_column(Integer, default=0)
    title: Mapped[str] = mapped_column(String(200), default="")
    visible: Mapped[bool] = mapped_column(default=True)
    content_json: Mapped[list] = mapped_column(JSON, default=list)
    source_section_ids: Mapped[Optional[list]] = mapped_column(JSON, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), onupdate=func.now()
    )

    resume: Mapped["Resume"] = relationship(back_populates="sections")


class ResumeOptimizationProposal(Base):
    """研究驱动的一岗一版简历候选稿；审核前不得创建正式 Resume。"""

    __tablename__ = "resume_optimization_proposals"

    proposal_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    job_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("jobs.id", ondelete="CASCADE"), index=True
    )
    profile_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("profiles.id", ondelete="CASCADE"), index=True
    )
    research_run_id: Mapped[str] = mapped_column(
        String(64), ForeignKey("job_research_runs.run_id", ondelete="RESTRICT"), index=True
    )
    reference_resume_id: Mapped[Optional[int]] = mapped_column(
        Integer, ForeignKey("resumes.id", ondelete="SET NULL"), nullable=True, index=True
    )
    status: Mapped[str] = mapped_column(String(24), default="ready", index=True)
    source_section_ids_json: Mapped[list] = mapped_column(JSON, default=list)
    source_snapshot_hash: Mapped[str] = mapped_column(String(64), index=True)
    research_snapshot_hash: Mapped[str] = mapped_column(String(64), index=True)
    original_summary: Mapped[str] = mapped_column(Text, default="")
    proposed_summary: Mapped[str] = mapped_column(Text, default="")
    original_rows_json: Mapped[list] = mapped_column(JSON, default=list)
    proposed_rows_json: Mapped[list] = mapped_column(JSON, default=list)
    diff_json: Mapped[list] = mapped_column(JSON, default=list)
    strategy_json: Mapped[dict] = mapped_column(JSON, default=dict)
    presentation_json: Mapped[dict] = mapped_column(JSON, default=dict)
    fact_gates_json: Mapped[dict] = mapped_column(JSON, default=dict)
    trace_json: Mapped[dict] = mapped_column(JSON, default=dict)
    review_note: Mapped[str] = mapped_column(Text, default="")
    accepted_resume_id: Mapped[Optional[int]] = mapped_column(
        Integer, ForeignKey("resumes.id", ondelete="SET NULL"), nullable=True, index=True
    )
    accepted_resume_version_id: Mapped[Optional[int]] = mapped_column(
        Integer, ForeignKey("resume_versions.id", ondelete="SET NULL"), nullable=True, index=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), index=True
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), onupdate=func.now()
    )
    reviewed_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)


class InterviewNotification(Base):
    """面试通知表：从邮件中解析出的面试邀请"""
    __tablename__ = "interview_notifications"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    email_subject: Mapped[str] = mapped_column(String(500), default="")
    email_from: Mapped[str] = mapped_column(String(300), default="")
    email_body: Mapped[str] = mapped_column(Text, default="")
    company: Mapped[str] = mapped_column(String(300), default="")
    position: Mapped[str] = mapped_column(String(500), default="")
    category: Mapped[str] = mapped_column(String(50), default="unknown")  # 8种校招状态分类
    interview_time: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    location: Mapped[str] = mapped_column(String(500), default="")
    action_required: Mapped[str] = mapped_column(String(500), default="")  # 用户待办操作
    parsed_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())

    # 关联日历事件
    calendar_events: Mapped[list["CalendarEvent"]] = relationship(back_populates="notification")


class CalendarEvent(Base):
    """日程表：面试日程 + 自动同步事件"""
    __tablename__ = "calendar_events"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    title: Mapped[str] = mapped_column(String(500))
    description: Mapped[str] = mapped_column(Text, default="")
    event_type: Mapped[str] = mapped_column(String(50), default="interview")  # interview / deadline / other
    start_time: Mapped[datetime] = mapped_column(DateTime)
    end_time: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    location: Mapped[str] = mapped_column(String(500), default="")

    # 关联
    related_job_id: Mapped[Optional[int]] = mapped_column(
        Integer, ForeignKey("jobs.id"), nullable=True
    )
    related_notification_id: Mapped[Optional[int]] = mapped_column(
        Integer, ForeignKey("interview_notifications.id"), nullable=True
    )
    # 由进度信号 accept 自动创建时回链信号，防重复建事件
    related_signal_id: Mapped[Optional[int]] = mapped_column(
        Integer, ForeignKey("external_progress_signals.id"), nullable=True
    )
    notification: Mapped[Optional["InterviewNotification"]] = relationship(
        back_populates="calendar_events"
    )

    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())


class Application(Base):
    """投递记录表：跟踪自动/手动投递状态"""
    __tablename__ = "applications"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    job_id: Mapped[int] = mapped_column(Integer, ForeignKey("jobs.id"))
    status: Mapped[str] = mapped_column(
        String(50), default="pending"
    )  # pending / submitted / rejected / interview / offer
    cover_letter: Mapped[str] = mapped_column(Text, default="")
    apply_url: Mapped[str] = mapped_column(Text, default="")
    notes: Mapped[str] = mapped_column(Text, default="")
    submitted_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), onupdate=func.now()
    )


class ApplicationAttempt(Base):
    """一次投递尝试（ADR-0007：一行一次尝试）。独立于 Application 表，不污染总表。"""

    __tablename__ = "application_attempts"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    job_id: Mapped[int] = mapped_column(Integer, ForeignKey("jobs.id"), index=True)
    resume_id: Mapped[Optional[int]] = mapped_column(
        Integer, ForeignKey("resumes.id", ondelete="SET NULL"), nullable=True, index=True
    )
    resume_version_id: Mapped[Optional[int]] = mapped_column(
        Integer, ForeignKey("resume_versions.id", ondelete="SET NULL"), nullable=True, index=True
    )
    cover_letter: Mapped[str] = mapped_column(Text, default="")
    status: Mapped[str] = mapped_column(String(50), default="prepared", index=True)
    notes: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(), index=True)


class ExternalProgressSignal(Base):
    """邮箱、短信等授权渠道形成的最小进展证据快照。"""

    __tablename__ = "external_progress_signals"
    __table_args__ = (
        UniqueConstraint(
            "channel",
            "account_ref",
            "external_message_id",
            name="uq_external_progress_signal_message",
        ),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    signal_id: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    channel: Mapped[str] = mapped_column(String(24), index=True)
    account_ref: Mapped[str] = mapped_column(String(160), index=True)
    external_message_id: Mapped[str] = mapped_column(String(500))
    external_thread_id: Mapped[str] = mapped_column(String(500), default="", index=True)
    sender: Mapped[str] = mapped_column(String(500), default="")
    received_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True, index=True)
    subject: Mapped[str] = mapped_column(String(500), default="")
    snippet: Mapped[str] = mapped_column(Text, default="")
    body_sha256: Mapped[str] = mapped_column(String(64), index=True)
    classification_json: Mapped[dict] = mapped_column(JSON, default=dict)
    status: Mapped[str] = mapped_column(String(24), default="active", index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(), index=True)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), onupdate=func.now()
    )


class ApplicationProgressCandidate(Base):
    """外部信号提出的待确认投递关联与阶段变化。"""

    __tablename__ = "application_progress_candidates"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    candidate_id: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    signal_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("external_progress_signals.id", ondelete="CASCADE"),
        unique=True,
        index=True,
    )
    suggested_attempt_id: Mapped[Optional[int]] = mapped_column(
        Integer,
        ForeignKey("application_attempts.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )
    suggested_stage: Mapped[str] = mapped_column(String(40), default="unknown", index=True)
    match_state: Mapped[str] = mapped_column(String(24), default="unassigned", index=True)
    match_candidates_json: Mapped[list] = mapped_column(JSON, default=list)
    reasons_json: Mapped[list] = mapped_column(JSON, default=list)
    # LLM 辅助分类结果（规则分类永远保底；两者不一致时 review UI 双显）
    llm_stage: Mapped[str] = mapped_column(String(40), default="")
    llm_confidence: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    llm_extracted_json: Mapped[dict] = mapped_column(JSON, default=dict)
    status: Mapped[str] = mapped_column(String(24), default="pending", index=True)
    selected_attempt_id: Mapped[Optional[int]] = mapped_column(
        Integer,
        ForeignKey("application_attempts.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )
    selected_stage: Mapped[str] = mapped_column(String(40), default="")
    review_note: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(), index=True)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), onupdate=func.now()
    )
    reviewed_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)


class ApplicationStageEvent(Base):
    """用户确认后追加的投递阶段事实；投递概览从事件派生。"""

    __tablename__ = "application_stage_events"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    event_id: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    candidate_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("application_progress_candidates.id", ondelete="RESTRICT"),
        unique=True,
        index=True,
    )
    signal_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("external_progress_signals.id", ondelete="RESTRICT"),
        index=True,
    )
    application_attempt_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("application_attempts.id", ondelete="CASCADE"),
        index=True,
    )
    previous_stage: Mapped[str] = mapped_column(String(40), default="prepared")
    stage: Mapped[str] = mapped_column(String(40), index=True)
    occurred_at: Mapped[datetime] = mapped_column(DateTime, index=True)
    source_channel: Mapped[str] = mapped_column(String(24), index=True)
    evidence_json: Mapped[dict] = mapped_column(JSON, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(), index=True)


class OperationAuditLog(Base):
    """统一操作审计日志：记录 UI/Agent/CLI/MCP 通过 action model 执行的动作。"""

    __tablename__ = "operation_audit_logs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    operation: Mapped[str] = mapped_column(String(120), index=True)
    operation_version: Mapped[str] = mapped_column(String(40), default="")
    surface: Mapped[str] = mapped_column(String(40), default="unknown", index=True)
    ok: Mapped[bool] = mapped_column(Boolean, default=False, index=True)
    dry_run: Mapped[bool] = mapped_column(Boolean, default=False, index=True)
    side_effects: Mapped[list] = mapped_column(JSON, default=list)
    inputs_json: Mapped[dict] = mapped_column(JSON, default=dict)
    outputs_json: Mapped[dict] = mapped_column(JSON, default=dict)
    warnings_json: Mapped[list] = mapped_column(JSON, default=list)
    errors_json: Mapped[list] = mapped_column(JSON, default=list)
    elapsed_ms: Mapped[float] = mapped_column(Float, default=0.0)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(), index=True)


class AgentWorkspaceState(Base):
    """Agent 与 UI 共享的当前工作区上下文。"""

    __tablename__ = "agent_workspace_states"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    scope: Mapped[str] = mapped_column(String(80), default="default", unique=True, index=True)
    route: Mapped[str] = mapped_column(String(300), default="")
    title: Mapped[str] = mapped_column(String(300), default="")
    entity_type: Mapped[str] = mapped_column(String(80), default="")
    entity_id: Mapped[str] = mapped_column(String(120), default="")
    selection_json: Mapped[dict] = mapped_column(JSON, default=dict)
    filters_json: Mapped[dict] = mapped_column(JSON, default=dict)
    context_json: Mapped[dict] = mapped_column(JSON, default=dict)
    version: Mapped[int] = mapped_column(Integer, default=1)
    updated_by: Mapped[str] = mapped_column(String(80), default="unknown")
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), onupdate=func.now(), index=True
    )


class ApplicationWorkspaceSettings(Base):
    """投递管理模块全局显示与行为设置"""
    __tablename__ = "application_workspace_settings"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    auto_row_height: Mapped[bool] = mapped_column(Boolean, default=True)
    auto_column_width: Mapped[bool] = mapped_column(Boolean, default=True)
    delete_subtable_sync_total_default: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), onupdate=func.now()
    )


class ApplicationTemplate(Base):
    """默认投递模板：用于初始化新子表与全量覆盖"""
    __tablename__ = "application_templates"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    schema_json: Mapped[list] = mapped_column(JSON, default=list)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), onupdate=func.now()
    )


class ApplicationTable(Base):
    """投递表容器：总表 + 子表"""
    __tablename__ = "application_tables"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    name: Mapped[str] = mapped_column(String(120), index=True)
    is_total: Mapped[bool] = mapped_column(Boolean, default=False, index=True)
    schema_json: Mapped[list] = mapped_column(JSON, default=list)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), onupdate=func.now()
    )

    table_records: Mapped[list["ApplicationTableRecord"]] = relationship(
        back_populates="table",
        cascade="all, delete-orphan",
    )


class ApplicationRecord(Base):
    """投递业务记录实体：总表与子表共享同一实体，保证值同步"""
    __tablename__ = "application_records"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    job_ref_id: Mapped[Optional[int]] = mapped_column(Integer, ForeignKey("jobs.id"), nullable=True, index=True)
    company_name: Mapped[str] = mapped_column(String(300), default="", index=True)
    job_title: Mapped[str] = mapped_column(String(500), default="", index=True)
    location: Mapped[str] = mapped_column(String(300), default="", index=True)
    job_link: Mapped[str] = mapped_column(Text, default="")
    source: Mapped[str] = mapped_column(String(120), default="")
    salary_text: Mapped[str] = mapped_column(String(120), default="")
    updated_at_value: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    custom_values: Mapped[dict] = mapped_column(JSON, default=dict)
    is_duplicate: Mapped[bool] = mapped_column(Boolean, default=False, index=True)
    duplicate_group: Mapped[str] = mapped_column(String(160), default="", index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), onupdate=func.now()
    )

    table_links: Mapped[list["ApplicationTableRecord"]] = relationship(
        back_populates="record",
        cascade="all, delete-orphan",
    )


class ApplicationTableRecord(Base):
    """投递表与记录关联：支持一条记录挂在多张表"""
    __tablename__ = "application_table_records"
    __table_args__ = (
        UniqueConstraint("table_id", "record_id", name="uq_application_table_record"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    table_id: Mapped[int] = mapped_column(Integer, ForeignKey("application_tables.id", ondelete="CASCADE"), index=True)
    record_id: Mapped[int] = mapped_column(Integer, ForeignKey("application_records.id", ondelete="CASCADE"), index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())

    table: Mapped["ApplicationTable"] = relationship(back_populates="table_records")
    record: Mapped["ApplicationRecord"] = relationship(back_populates="table_links")


# =============================================
# 面经模块 (PRD §8.5)
# =============================================

class InterviewExperience(Base):
    """收集到的面经原文"""
    __tablename__ = "interview_experiences"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    company: Mapped[str] = mapped_column(String(300), index=True)
    role: Mapped[str] = mapped_column(String(300), index=True)
    source_url: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    source_platform: Mapped[str] = mapped_column(String(50), default="manual")  # manual / niuke / zhihu
    raw_text: Mapped[str] = mapped_column(Text)
    interview_rounds: Mapped[Optional[str]] = mapped_column(Text, nullable=True)  # JSON: 面试轮次
    job_id: Mapped[Optional[int]] = mapped_column(Integer, ForeignKey("jobs.id"), nullable=True)
    collected_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())

    questions: Mapped[list["InterviewQuestion"]] = relationship(
        back_populates="experience", cascade="all, delete-orphan"
    )


class InterviewQuestion(Base):
    """从面经中提炼的结构化问题"""
    __tablename__ = "interview_questions"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    experience_id: Mapped[int] = mapped_column(Integer, ForeignKey("interview_experiences.id"))
    question_text: Mapped[str] = mapped_column(Text)
    round_type: Mapped[str] = mapped_column(String(50), default="department")  # hr / department / final
    category: Mapped[str] = mapped_column(String(50), default="behavioral")  # behavioral / technical / case / motivation
    difficulty: Mapped[int] = mapped_column(Integer, default=3)  # 1-5
    frequency: Mapped[int] = mapped_column(Integer, default=1)  # 出现次数
    suggested_answer: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    job_id: Mapped[Optional[int]] = mapped_column(Integer, ForeignKey("jobs.id"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())

    experience: Mapped["InterviewExperience"] = relationship(back_populates="questions")


class OptimizeSession(Base):
    """对话式简历优化会话"""
    __tablename__ = "optimize_sessions"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    session_id: Mapped[str] = mapped_column(String(60), unique=True, index=True)
    profile_id: Mapped[Optional[int]] = mapped_column(Integer, ForeignKey("profiles.id", ondelete="SET NULL"), nullable=True)
    phase: Mapped[str] = mapped_column(String(30), default="confirming")
    job_ids: Mapped[list] = mapped_column(JSON, default=list)
    mode: Mapped[str] = mapped_column(String(20), default="per_job")
    messages_json: Mapped[list] = mapped_column(JSON, default=list)
    jd_analysis_json: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)
    match_analysis_json: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)
    reorder_json: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)
    framework_json: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)
    rows_json: Mapped[Optional[list]] = mapped_column(JSON, nullable=True)
    current_section_index: Mapped[int] = mapped_column(Integer, default=0)
    reference_resume_id: Mapped[Optional[int]] = mapped_column(Integer, ForeignKey("resumes.id", ondelete="SET NULL"), nullable=True)
    resume_id: Mapped[Optional[int]] = mapped_column(Integer, ForeignKey("resumes.id", ondelete="SET NULL"), nullable=True)
    resume_optimization_proposal_id: Mapped[Optional[str]] = mapped_column(String(64), nullable=True, index=True)
    research_run_id: Mapped[Optional[str]] = mapped_column(String(64), nullable=True, index=True)
    interview_experiences_json: Mapped[Optional[list]] = mapped_column(JSON, nullable=True)
    raw_jd_json: Mapped[Optional[str]] = mapped_column(JSON, nullable=True)
    job_titles_json: Mapped[Optional[list]] = mapped_column(JSON, nullable=True)
    confirmed_sections_json: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)
    original_rows_json: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)
    pending_action_json: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(), onupdate=func.now())


class SmartFillMapCache(Base):
    """SmartFill 映射缓存：后端缓存域（SQLite 优先）"""
    __tablename__ = "smartfill_map_cache"
    __table_args__ = (
        UniqueConstraint("cache_key", name="uq_smartfill_map_cache_key"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    cache_key: Mapped[str] = mapped_column(String(128), index=True)
    adapter_id: Mapped[str] = mapped_column(String(50), default="unknown", index=True)
    model_signature: Mapped[str] = mapped_column(String(128), default="", index=True)
    mappings_json: Mapped[list] = mapped_column(JSON, default=list)
    channel: Mapped[str] = mapped_column(String(30), default="backend")
    fallback_used: Mapped[bool] = mapped_column(Boolean, default=False)
    expires_at: Mapped[datetime] = mapped_column(DateTime, index=True)
    run_id: Mapped[Optional[str]] = mapped_column(String(64), nullable=True, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), onupdate=func.now()
    )


class SmartFillRun(Base):
    """SmartFill 运行记录：run 级摘要"""
    __tablename__ = "smartfill_runs"
    __table_args__ = (
        UniqueConstraint("run_id", name="uq_smartfill_run_id"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    run_id: Mapped[str] = mapped_column(String(64), index=True)
    status: Mapped[str] = mapped_column(String(20), default="running", index=True)
    summary_json: Mapped[dict] = mapped_column(JSON, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), onupdate=func.now()
    )


class SmartFillRunLog(Base):
    """SmartFill 分层诊断日志：run/field/control 级结构化记录"""
    __tablename__ = "smartfill_run_logs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    run_id: Mapped[str] = mapped_column(String(64), ForeignKey("smartfill_runs.run_id"), index=True)
    stage: Mapped[str] = mapped_column(String(40), index=True)
    severity: Mapped[str] = mapped_column(String(20), default="info", index=True)
    scope: Mapped[str] = mapped_column(String(20), default="run", index=True)
    message: Mapped[str] = mapped_column(Text, default="")
    field_id: Mapped[str] = mapped_column(String(120), default="", index=True)
    payload_json: Mapped[dict] = mapped_column(JSON, default=dict)
    ts: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(), index=True)


# =============================================
# 简历版本管理 + 分享 + 面试练习
# =============================================

class ResumeVersion(Base):
    """简历版本快照：每次生成/修改前自动保存快照"""
    __tablename__ = "resume_versions"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    resume_id: Mapped[int] = mapped_column(Integer, ForeignKey("resumes.id", ondelete="CASCADE"), index=True)
    version_number: Mapped[int] = mapped_column(Integer, default=1)  # 1, 2, 3...
    # 完整快照：包含 Resume 和 ResumeSection 的完整 JSON
    content_snapshot: Mapped[dict] = mapped_column(JSON, default=dict)
    change_summary: Mapped[str] = mapped_column(String(500), default="")  # "基于腾讯-内容运营岗位生成"
    created_by: Mapped[str] = mapped_column(String(100), default="system")  # system / user / ai
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(), index=True)

    resume: Mapped["Resume"] = relationship("Resume", foreign_keys=[resume_id])


class ResumeShare(Base):
    """简历公开分享：生成带密码保护的分享链接"""
    __tablename__ = "resume_shares"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    resume_id: Mapped[int] = mapped_column(Integer, ForeignKey("resumes.id", ondelete="CASCADE"), index=True)
    share_token: Mapped[str] = mapped_column(String(64), unique=True, index=True)  # 随机生成的 UUID
    password_hash: Mapped[Optional[str]] = mapped_column(String(128), nullable=True)  # bcrypt hash，可为空表示无密码
    expires_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True, index=True)  # 过期时间，可为空表示永久
    view_count: Mapped[int] = mapped_column(Integer, default=0)  # 访问次数统计
    last_viewed_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)  # 最后访问时间
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, index=True)  # 是否启用
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())

    resume: Mapped["Resume"] = relationship("Resume", foreign_keys=[resume_id])


class Interview(Base):
    """面试练习会话：AI 模拟面试"""
    __tablename__ = "interviews"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    title: Mapped[str] = mapped_column(String(300), default="未命名面试")
    # 目标公司和岗位信息
    target_company: Mapped[str] = mapped_column(String(300), default="")
    target_position: Mapped[str] = mapped_column(String(300), default="")
    target_job_id: Mapped[Optional[int]] = mapped_column(Integer, ForeignKey("jobs.id"), nullable=True, index=True)
    # 关联的简历和档案
    resume_id: Mapped[Optional[int]] = mapped_column(Integer, ForeignKey("resumes.id"), nullable=True, index=True)
    profile_id: Mapped[Optional[int]] = mapped_column(Integer, ForeignKey("profiles.id"), nullable=True, index=True)
    # 面试配置
    interview_type: Mapped[str] = mapped_column(String(50), default="behavioral")  # behavioral / technical / case / mixed
    difficulty: Mapped[str] = mapped_column(String(20), default="medium")  # easy / medium / hard
    scoring_skill_id: Mapped[str] = mapped_column(
        String(64), default="evidence-interview-score", index=True
    )
    scoring_skill_version: Mapped[int] = mapped_column(Integer, default=1)
    model_runtime_json: Mapped[dict] = mapped_column(JSON, default=dict)
    data_consent_json: Mapped[dict] = mapped_column(JSON, default=dict)
    # 面试状态
    status: Mapped[str] = mapped_column(String(20), default="active", index=True)  # active / completed / archived
    # AI 生成的面试问题列表
    questions_json: Mapped[list] = mapped_column(JSON, default=list)  # [{"question": "...", "answered": false}, ...]
    current_question_index: Mapped[int] = mapped_column(Integer, default=0)
    # 面试报告（完成后生成）
    report_json: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)  # 包含总体评分、各维度分析、改进建议
    behavior_summary_json: Mapped[dict] = mapped_column(JSON, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(), index=True)
    updated_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(), onupdate=func.now())
    completed_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)

    messages: Mapped[list["InterviewMessage"]] = relationship(
        back_populates="interview", cascade="all, delete-orphan", order_by="InterviewMessage.created_at"
    )


class InterviewMessage(Base):
    """面试对话消息：AI 提问和用户回答"""
    __tablename__ = "interview_messages"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    interview_id: Mapped[int] = mapped_column(Integer, ForeignKey("interviews.id", ondelete="CASCADE"), index=True)
    role: Mapped[str] = mapped_column(String(20))  # interviewer / candidate
    content: Mapped[str] = mapped_column(Text)
    question_index: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    # AI 对候选人回答的即时评估
    evaluation_json: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)  # {"score": 75, "strengths": [...], "improvements": [...]}
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(), index=True)

    interview: Mapped["Interview"] = relationship(back_populates="messages")


class InterviewScoringSkill(Base):
    """受 schema 约束的声明式内容评分 Skill；不执行任意代码。"""

    __tablename__ = "interview_scoring_skills"
    __table_args__ = (
        UniqueConstraint(
            "skill_id",
            "version",
            name="uq_interview_scoring_skill_version",
        ),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    skill_id: Mapped[str] = mapped_column(String(64), index=True)
    version: Mapped[int] = mapped_column(Integer)
    name: Mapped[str] = mapped_column(String(200))
    status: Mapped[str] = mapped_column(String(24), default="active", index=True)
    definition_json: Mapped[dict] = mapped_column(JSON)
    definition_hash: Mapped[str] = mapped_column(String(64), index=True)
    is_builtin: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), index=True
    )


class InterviewBehaviorEvent(Base):
    """浏览器本地视觉模型产生的派生表达行为事件；无视频、图像或 landmarks。"""

    __tablename__ = "interview_behavior_events"
    __table_args__ = (
        UniqueConstraint(
            "interview_id",
            "event_id",
            name="uq_interview_behavior_event",
        ),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    event_id: Mapped[str] = mapped_column(String(64), index=True)
    interview_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("interviews.id", ondelete="CASCADE"), index=True
    )
    event_type: Mapped[str] = mapped_column(String(60), index=True)
    started_ms: Mapped[int] = mapped_column(Integer)
    ended_ms: Mapped[int] = mapped_column(Integer)
    occurrence_count: Mapped[int] = mapped_column(Integer, default=1)
    duration_ms: Mapped[int] = mapped_column(Integer, default=0)
    confidence: Mapped[float] = mapped_column(Float)
    detector_id: Mapped[str] = mapped_column(String(80))
    detector_version: Mapped[str] = mapped_column(String(80))
    metadata_json: Mapped[dict] = mapped_column(JSON, default=dict)
    created_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), index=True
    )


class InterviewEvaluationRun(Base):
    """可复现的内容评价运行；表达行为汇总保持独立，不参与内容总分。"""

    __tablename__ = "interview_evaluation_runs"

    evaluation_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    idempotency_key: Mapped[str] = mapped_column(String(96), unique=True, index=True)
    interview_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("interviews.id", ondelete="CASCADE"), index=True
    )
    message_id: Mapped[Optional[int]] = mapped_column(
        Integer,
        ForeignKey("interview_messages.id", ondelete="CASCADE"),
        nullable=True,
        index=True,
    )
    scope: Mapped[str] = mapped_column(String(24), index=True)
    scoring_skill_id: Mapped[str] = mapped_column(String(64), index=True)
    scoring_skill_version: Mapped[int] = mapped_column(Integer)
    input_hash: Mapped[str] = mapped_column(String(64), index=True)
    status: Mapped[str] = mapped_column(String(24), default="running", index=True)
    content_result_json: Mapped[dict] = mapped_column(JSON, default=dict)
    delivery_result_json: Mapped[dict] = mapped_column(JSON, default=dict)
    runtime_json: Mapped[dict] = mapped_column(JSON, default=dict)
    error: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), index=True
    )
    completed_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
