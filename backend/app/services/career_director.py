"""Strict contracts and read-only Career State projection for Career Director."""

from __future__ import annotations

import json
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator
from sqlalchemy import func, select, update

from app.database import async_session
from app.models.models import Profile, ProfileSection, ProfileTargetRole
from app.services.security_redaction import redact_sensitive_text

CareerTrack = Literal["campus", "experienced"]
CareerSubstage = Literal[
    "internship",
    "fresh_graduate",
    "early_career",
    "experienced_ic",
    "manager",
    "executive",
    "career_switch",
]
CareerConfidence = Literal["high", "medium", "low"]
AutonomyLevel = Literal["L0", "L1", "L2", "L3"]


class _StrictContract(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)


class CareerStageAssessment(_StrictContract):
    track: CareerTrack
    substage: CareerSubstage
    confidence: CareerConfidence
    basis: list[str] = Field(min_length=1, max_length=8)

    @model_validator(mode="after")
    def validate_track(self) -> "CareerStageAssessment":
        campus_substages = {"internship", "fresh_graduate"}
        experienced_substages = {"early_career", "experienced_ic", "manager", "executive"}
        if self.substage in campus_substages and self.track != "campus":
            raise ValueError("internship/fresh_graduate must use campus track")
        if self.substage in experienced_substages and self.track != "experienced":
            raise ValueError("experienced substages must use experienced track")
        return self


class CareerStageCorrection(_StrictContract):
    contract_schema: Literal["offeru.career_stage_correction.v1"] = Field(
        default="offeru.career_stage_correction.v1", alias="schema"
    )
    track: CareerTrack
    substage: CareerSubstage

    @model_validator(mode="after")
    def validate_track(self) -> "CareerStageCorrection":
        CareerStageAssessment(
            track=self.track,
            substage=self.substage,
            confidence="high",
            basis=["user-confirmed"],
        )
        return self


class CareerProfileCoverage(_StrictContract):
    strong_evidence: list[str] = Field(default_factory=list, max_length=30)
    weak_evidence: list[str] = Field(default_factory=list, max_length=30)
    missing_evidence: list[str] = Field(default_factory=list, max_length=20)
    unknowns: list[str] = Field(default_factory=list, max_length=20)
    underexpressed_strengths: list[str] = Field(default_factory=list, max_length=20)


class CareerIdentity(_StrictContract):
    career_stage: CareerStageAssessment | None = None
    career_stage_source: Literal["user_confirmed"] | None = None
    experience_years: float | None = Field(default=None, ge=0, le=80)
    current_role: str | None = Field(default=None, max_length=200)
    employment_state: str | None = Field(default=None, max_length=120)


class CareerGoals(_StrictContract):
    primary_roles: list[str] = Field(default_factory=list, max_length=20)
    secondary_roles: list[str] = Field(default_factory=list, max_length=20)
    locations: list[str] = Field(default_factory=list, max_length=20)
    compensation: str | None = Field(default=None, max_length=160)
    timing: str | None = Field(default=None, max_length=160)


class CareerSnapshot(_StrictContract):
    contract_schema: Literal["offeru.career_snapshot.v1"] = Field(
        default="offeru.career_snapshot.v1", alias="schema"
    )
    profile_id: int | None = None
    identity: CareerIdentity
    goals: CareerGoals
    profile_coverage: CareerProfileCoverage


class CareerPriority(_StrictContract):
    priority: str = Field(min_length=1, max_length=240)
    why_now: str = Field(min_length=1, max_length=500)
    evidence_refs: list[str] = Field(default_factory=list, max_length=12)
    deadline: str | None = Field(default=None, max_length=80)
    confidence: CareerConfidence


class CareerActionTarget(_StrictContract):
    kind: Literal["profile", "job", "application", "interview", "follow_up"]
    id: str = Field(min_length=1, max_length=160, pattern=r"^[A-Za-z0-9_.:-]{1,160}$")


class CareerAction(_StrictContract):
    objective: str = Field(min_length=1, max_length=300)
    why_now: str = Field(min_length=1, max_length=500)
    skill: str = Field(default="", max_length=120)
    suggested_operations: list[str] = Field(default_factory=list, max_length=8)
    target_ref: CareerActionTarget | None = None
    autonomy_level: AutonomyLevel
    expected_outcome: str = Field(min_length=1, max_length=400)
    requires_user: bool
    dedupe_key: str = Field(min_length=1, max_length=180, pattern=r"^[A-Za-z0-9_.:-]{1,180}$")

    @model_validator(mode="after")
    def protected_actions_need_user(self) -> "CareerAction":
        if self.autonomy_level in {"L2", "L3"} and not self.requires_user:
            raise ValueError("L2/L3 Career Director actions must require the user")
        return self


class CareerQuestion(_StrictContract):
    question: str = Field(min_length=1, max_length=500)
    why_needed: str = Field(min_length=1, max_length=400)
    unlocks: str = Field(min_length=1, max_length=400)
    optional: bool = True


class JobEvidenceAlignment(_StrictContract):
    requirement: str = Field(min_length=1, max_length=260)
    evidence_ref: str = Field(min_length=1, max_length=180)
    match: Literal["strong", "partial", "missing"]
    rationale: str = Field(min_length=1, max_length=400)


class JobEvidenceGap(_StrictContract):
    requirement: str = Field(min_length=1, max_length=260)
    why_missing: str = Field(min_length=1, max_length=400)
    evidence_to_seek: str = Field(min_length=1, max_length=400)


class CareerCapabilityNeed(_StrictContract):
    relevance: Literal["needed", "useful", "not_now"]
    rationale: str = Field(min_length=1, max_length=400)


class JobAssessmentPlan(_StrictContract):
    job_id: int = Field(gt=0)
    fit: Literal["strong_match", "plausible_match", "stretch", "weak_match", "insufficient_evidence"]
    fit_rationale: str = Field(min_length=1, max_length=700)
    application_priority: Literal["high", "normal", "low", "hold"]
    evidence_alignment: list[JobEvidenceAlignment] = Field(default_factory=list, max_length=8)
    evidence_gaps: list[JobEvidenceGap] = Field(default_factory=list, max_length=8)
    role_intelligence: CareerCapabilityNeed
    resume_prep: CareerCapabilityNeed
    interview_prep: CareerCapabilityNeed
    recommended_operations: list[
        Literal[
            "build_role_benchmark",
            "prepare_resume_optimization",
            "prepare_role_interview_focus",
            "create_application_packet",
        ]
    ] = Field(default_factory=list, max_length=4)


class CareerBriefing(_StrictContract):
    contract_schema: Literal["offeru.career_briefing.v1"] = Field(
        default="offeru.career_briefing.v1", alias="schema"
    )
    career_stage: CareerStageAssessment
    strategy_pack: Literal["campus_search.v1", "experienced_search.v1"]
    situation_summary: str = Field(min_length=1, max_length=1200)
    profile_coverage: CareerProfileCoverage
    job_assessment: JobAssessmentPlan | None = None
    priorities: list[CareerPriority] = Field(default_factory=list, max_length=3)
    actions: list[CareerAction] = Field(default_factory=list, max_length=3)
    questions: list[CareerQuestion] = Field(default_factory=list, max_length=3)
    risks: list[str] = Field(default_factory=list, max_length=8)
    opportunities: list[str] = Field(default_factory=list, max_length=8)

    @model_validator(mode="after")
    def strategy_matches_track(self) -> "CareerBriefing":
        expected = (
            "campus_search.v1"
            if self.career_stage.track == "campus"
            else "experienced_search.v1"
        )
        if self.strategy_pack != expected:
            raise ValueError("strategy_pack must match the assessed career track")
        return self


def _safe_text(value: Any, *, limit: int = 360) -> str:
    if value is None:
        return ""
    return redact_sensitive_text(str(value).strip(), max_length=limit).strip()


def _archive_section(base_info: dict[str, Any], key: str, child: str) -> dict[str, Any]:
    archive = base_info.get("personal_archive")
    if not isinstance(archive, dict):
        return {}
    parent = archive.get(key)
    if not isinstance(parent, dict):
        return {}
    value = parent.get(child)
    return value if isinstance(value, dict) else {}


def _career_section_summary(section: ProfileSection) -> str:
    content = section.content_json if isinstance(section.content_json, dict) else {}
    normalized = content.get("normalized") if isinstance(content.get("normalized"), dict) else {}
    text = content.get("bullet") or content.get("description")
    if not text:
        text = "；".join(
            str(value)
            for value in normalized.values()
            if isinstance(value, (str, int, float)) and str(value).strip()
        )
    title = _safe_text(section.title, limit=120)
    summary = _safe_text(text, limit=260)
    display = " — ".join(part for part in (title, summary) if part)
    return f"profile-section:{section.id} {display}"[:420]


def _confirmed_stage(base_info: dict[str, Any]) -> CareerStageAssessment | None:
    raw = base_info.get("career_stage_correction")
    if raw is None:
        return None
    correction = CareerStageCorrection.model_validate(raw)
    return CareerStageAssessment(
        track=correction.track,
        substage=correction.substage,
        confidence="high",
        basis=["user-confirmed"],
    )


def _make_snapshot(
    *,
    profile_id: int | None,
    base_info: dict[str, Any],
    roles: list[ProfileTargetRole],
    sections: list[ProfileSection],
) -> CareerSnapshot:
    preferences = _archive_section(base_info, "applicationArchive", "jobPreference")
    campus = _archive_section(base_info, "applicationArchive", "campusFields")
    primary = [
        _safe_text(role.role_name, limit=120)
        for role in roles
        if role.fit == "primary" and str(role.role_name or "").strip()
    ]
    secondary = [
        _safe_text(role.role_name, limit=120)
        for role in roles
        if role.fit != "primary" and str(role.role_name or "").strip()
    ]
    raw_locations = preferences.get("expectedCities") or base_info.get("target_locations") or []
    locations = (
        [_safe_text(item, limit=100) for item in raw_locations if str(item).strip()]
        if isinstance(raw_locations, list)
        else [_safe_text(raw_locations, limit=100)]
        if str(raw_locations or "").strip()
        else []
    )
    strong: list[str] = []
    weak: list[str] = []
    has_education = False
    has_work_or_project = False
    for section in sections:
        section_type = str(section.section_type or "").casefold()
        has_education |= section_type == "education"
        has_work_or_project |= section_type in {"experience", "project"}
        summary = _career_section_summary(section)
        if not summary:
            continue
        if section.tier == "verified_fact" and float(section.confidence or 0) >= 0.75:
            strong.append(summary)
        elif section.tier != "preference":
            weak.append(summary)

    missing: list[str] = []
    unknowns: list[str] = []
    if not primary and not secondary:
        missing.append("目标岗位方向")
        unknowns.append("想优先尝试哪些岗位方向")
    if not has_education:
        unknowns.append("教育经历与毕业时间")
    if not has_work_or_project:
        missing.append("可验证的工作或项目经历")
    if not _confirmed_stage(base_info):
        unknowns.append("当前职业阶段尚未确认")

    state = _safe_text(
        preferences.get("currentJobSearchStatus")
        or base_info.get("employment_state"),
        limit=120,
    )
    compensation = _safe_text(
        preferences.get("expectedSalary") or base_info.get("expected_salary"),
        limit=160,
    )
    timing = _safe_text(
        preferences.get("availableStartDate")
        or base_info.get("target_timing")
        or campus.get("graduationDate"),
        limit=160,
    )
    return CareerSnapshot(
        profile_id=profile_id,
        identity=CareerIdentity(
            career_stage=_confirmed_stage(base_info),
            career_stage_source="user_confirmed" if _confirmed_stage(base_info) else None,
            experience_years=(
                float(base_info["experience_years"])
                if isinstance(base_info.get("experience_years"), (int, float))
                and not isinstance(base_info.get("experience_years"), bool)
                and float(base_info["experience_years"]) >= 0
                else None
            ),
            current_role=_safe_text(base_info.get("current_role"), limit=200) or None,
            employment_state=state or None,
        ),
        goals=CareerGoals(
            primary_roles=primary,
            secondary_roles=secondary,
            locations=locations,
            compensation=compensation or None,
            timing=timing or None,
        ),
        profile_coverage=CareerProfileCoverage(
            strong_evidence=strong[:30],
            weak_evidence=weak[:30],
            missing_evidence=missing,
            unknowns=unknowns,
            underexpressed_strengths=[],
        ),
    )


async def build_career_snapshot() -> dict[str, Any]:
    """Read canonical Profile truth without creating or normalizing rows."""

    async with async_session() as db:
        profile = (
            await db.execute(
                select(Profile)
                .where(Profile.is_default.is_(True))
                .order_by(Profile.id.asc())
                .limit(1)
            )
        ).scalar_one_or_none()
        if profile is None:
            return _make_snapshot(
                profile_id=None,
                base_info={},
                roles=[],
                sections=[],
            ).model_dump(mode="json", by_alias=True)
        roles = (
            await db.execute(
                select(ProfileTargetRole)
                .where(ProfileTargetRole.profile_id == profile.id)
                .order_by(ProfileTargetRole.created_at.asc(), ProfileTargetRole.id.asc())
            )
        ).scalars().all()
        sections = (
            await db.execute(
                select(ProfileSection)
                .where(ProfileSection.profile_id == profile.id)
                .where(ProfileSection.status == "active")
                .order_by(ProfileSection.sort_order.asc(), ProfileSection.created_at.asc())
            )
        ).scalars().all()
        base_info = (
            profile.base_info_json
            if isinstance(profile.base_info_json, dict)
            else {}
        )
        return _make_snapshot(
            profile_id=profile.id,
            base_info=base_info,
            roles=roles,
            sections=sections,
        ).model_dump(mode="json", by_alias=True)


async def correct_career_stage(*, track: CareerTrack, substage: CareerSubstage) -> dict[str, Any]:
    """Persist an explicit user correction as a narrow atomic Profile JSON update."""

    correction = CareerStageCorrection(track=track, substage=substage)
    async with async_session() as db:
        profile_id = (
            await db.execute(
                select(Profile.id)
                .where(Profile.is_default.is_(True))
                .order_by(Profile.id.asc())
                .limit(1)
            )
        ).scalar_one_or_none()
        if profile_id is None:
            raise ValueError("先建立个人档案后才能确认职业方向")
        result = await db.execute(
            update(Profile)
            .where(Profile.id == profile_id)
            .values(
                base_info_json=func.json_set(
                    Profile.base_info_json,
                    "$.career_stage_correction",
                    func.json(json.dumps(correction.model_dump(mode="json", by_alias=True), ensure_ascii=False)),
                ),
                updated_at=func.now(),
            )
        )
        if result.rowcount != 1:
            raise ValueError("个人档案已变化，请刷新后重试")
        await db.commit()
    return {"changed": True, "snapshot": await build_career_snapshot()}


def parse_career_briefing_response(
    response: Any,
    *,
    confirmed_stage: CareerStageAssessment | None = None,
) -> dict[str, Any]:
    """Validate one model-issued CareerBriefing; never infer one in code."""

    if not isinstance(response, str) or not response.strip():
        raise ValueError("Career Director 没有返回结构化结果")
    try:
        payload = json.loads(response.strip())
    except json.JSONDecodeError as exc:
        raise ValueError("Career Director 输出必须是原始 JSON object") from exc
    if not isinstance(payload, dict):
        raise ValueError("Career Director 输出必须是 JSON object")
    briefing = CareerBriefing.model_validate(payload)
    if confirmed_stage is not None:
        strategy_pack = (
            "campus_search.v1"
            if confirmed_stage.track == "campus"
            else "experienced_search.v1"
        )
        briefing = briefing.model_copy(
            update={"career_stage": confirmed_stage, "strategy_pack": strategy_pack}
        )
    return briefing.model_dump(mode="json", by_alias=True)


CAREER_BRIEFING_SCHEMA: dict[str, Any] = CareerBriefing.model_json_schema(by_alias=True)
