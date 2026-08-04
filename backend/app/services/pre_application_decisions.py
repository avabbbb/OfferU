from __future__ import annotations

import hashlib
import json
import re
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

from sqlalchemy import select

from app.agents.llm import chat_completion, extract_json, get_llm_runtime_info
from app.database import async_session
from app.models.models import (
    Job,
    JobResearchRun,
    Profile,
    ProfileSection,
    ResearchEvidenceSnapshot,
    ResearchFinding,
    ResumeOptimizationProposal,
)
from app.services.agent_files import atomic_write_json


DECISION_SCHEMA = "offeru.pre_application_decision.v1"
RECOMMENDATIONS = frozenset({"go", "conditional_go", "no_go", "insufficient_evidence"})
FINAL_DECISIONS = RECOMMENDATIONS
_DECISION_ID = re.compile(r"^pre_app_[0-9a-f]{32}$")
_DEFAULT_DIR = Path(__file__).resolve().parents[2] / "data" / "pre_application_decisions"

DECISION_OUTPUT_SCHEMA: dict[str, Any] = {
    "required": (
        "recommendation",
        "rationale",
        "strengths",
        "gaps",
        "conditions",
        "missing_evidence",
        "evidence",
    ),
    "recommendations": sorted(RECOMMENDATIONS),
    "evidence_kinds": (
        "candidate_fact",
        "job_requirement",
        "research_fact",
        "inference",
    ),
}


def extract_requested_job_id(message: str) -> int | None:
    for pattern in (
        r"(?:job|岗位|职位|jd)\s*#?\s*(\d+)",
        r"#\s*(\d+)",
    ):
        match = re.search(pattern, message or "", re.I)
        if match:
            return int(match.group(1))
    return None


def extract_recent_job_id(
    messages: list[dict[str, str]],
    limit: int = 8,
) -> int | None:
    for message in reversed((messages or [])[-limit:]):
        job_id = extract_requested_job_id(
            str(message.get("content") or "")
        )
        if job_id is not None:
            return job_id
    return None


def extract_pre_application_final_decision(message: str) -> str | None:
    text = re.sub(r"\s+", "", str(message or "").strip().lower())
    if not text:
        return None
    if "有条件投" in text or "conditionalgo" in text:
        return "conditional_go"
    if any(
        token in text
        for token in (
            "证据不足",
            "信息不足",
            "先不决定",
            "insufficientevidence",
        )
    ):
        return "insufficient_evidence"
    if any(
        token in text
        for token in ("不投", "放弃这个岗位", "跳过这个岗位", "nogo")
    ):
        return "no_go"
    if text in {
        "投",
        "go",
        "确认投",
        "决定投",
        "我要投",
        "就投这个岗位",
    }:
        return "go"
    if any(
        token in text
        for token in ("确认要投", "决定要投", "我要投这个岗位")
    ):
        return "go"
    return None


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _canonical_hash(payload: Any) -> str:
    encoded = json.dumps(
        payload,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        default=str,
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _clean_job_id(value: Any) -> int:
    try:
        job_id = int(value)
    except (TypeError, ValueError) as exc:
        raise ValueError("job_id 必须是正整数") from exc
    if job_id <= 0:
        raise ValueError("job_id 必须是正整数")
    return job_id


def _clean_text(value: Any, field: str, limit: int) -> str:
    text = str(value or "").strip()
    if len(text) > limit:
        raise ValueError(f"{field} 超过最大长度 {limit}")
    return text


def _validated_text_list(payload: dict[str, Any], field: str, limit: int) -> list[str]:
    value = payload.get(field)
    if not isinstance(value, list) or len(value) > limit:
        raise ValueError(f"{field} 必须是最多 {limit} 项的数组")
    rows: list[str] = []
    for item in value:
        text = _clean_text(item, field, 1000)
        if not text:
            raise ValueError(f"{field} 不能包含空文本")
        rows.append(text)
    return rows


def _validated_decision(
    payload: dict[str, Any] | None,
    *,
    allowed_source_refs: set[str],
    profile_source_refs: set[str],
    job_source_ref: str,
) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise ValueError("投前决策未返回 JSON 对象")
    if set(payload) != set(DECISION_OUTPUT_SCHEMA["required"]):
        raise ValueError("投前决策字段与输出契约不一致")

    recommendation = _clean_text(payload.get("recommendation"), "recommendation", 40).lower()
    if recommendation not in RECOMMENDATIONS:
        raise ValueError("recommendation 不在允许枚举中")
    rationale = _clean_text(payload.get("rationale"), "rationale", 4000)
    if not rationale:
        raise ValueError("rationale 不能为空")

    strengths = _validated_text_list(payload, "strengths", 10)
    gaps = _validated_text_list(payload, "gaps", 10)
    conditions = _validated_text_list(payload, "conditions", 8)
    missing_evidence = _validated_text_list(payload, "missing_evidence", 8)
    if recommendation == "conditional_go" and not conditions:
        raise ValueError("有条件投必须列出至少一个条件")
    if recommendation == "insufficient_evidence" and not missing_evidence:
        raise ValueError("证据不足必须列出缺少的证据")

    raw_evidence = payload.get("evidence")
    if not isinstance(raw_evidence, list) or not 1 <= len(raw_evidence) <= 20:
        raise ValueError("evidence 必须包含 1-20 条证据")
    evidence: list[dict[str, Any]] = []
    for item in raw_evidence:
        if not isinstance(item, dict) or set(item) != {"source_refs", "claim", "kind"}:
            raise ValueError("evidence 条目字段与输出契约不一致")
        refs = item.get("source_refs")
        if not isinstance(refs, list) or not 1 <= len(refs) <= 6:
            raise ValueError("evidence.source_refs 必须包含 1-6 个来源")
        clean_refs = list(dict.fromkeys(_clean_text(ref, "source_ref", 200) for ref in refs))
        if any(not ref or ref not in allowed_source_refs for ref in clean_refs):
            raise ValueError("evidence 引用了未知来源")
        claim = _clean_text(item.get("claim"), "evidence.claim", 1000)
        kind = _clean_text(item.get("kind"), "evidence.kind", 40)
        if not claim or kind not in DECISION_OUTPUT_SCHEMA["evidence_kinds"]:
            raise ValueError("evidence 缺少有效 claim 或 kind")
        if kind == "candidate_fact" and any(ref not in profile_source_refs for ref in clean_refs):
            raise ValueError("candidate_fact 只能引用已确认职业证据")
        if kind == "job_requirement" and clean_refs != [job_source_ref]:
            raise ValueError("job_requirement 只能引用当前岗位")
        if kind == "research_fact" and any(
            ref in profile_source_refs or ref == job_source_ref for ref in clean_refs
        ):
            raise ValueError("research_fact 只能引用岗位调研来源")
        evidence.append({"source_refs": clean_refs, "claim": claim, "kind": kind})

    return {
        "recommendation": recommendation,
        "rationale": rationale,
        "strengths": strengths,
        "gaps": gaps,
        "conditions": conditions,
        "missing_evidence": missing_evidence,
        "evidence": evidence,
    }


class PreApplicationDecisionStore:
    """Own the append-audited lifecycle of reviewable pre-application decisions."""

    def __init__(self, directory: Path | None = None) -> None:
        self.directory = directory or _DEFAULT_DIR
        self._lock = threading.RLock()

    def create(self, payload: dict[str, Any]) -> dict[str, Any]:
        decision_id = f"pre_app_{uuid.uuid4().hex}"
        document = {
            "schema": DECISION_SCHEMA,
            "id": decision_id,
            "status": "ready_for_review",
            "final_decision": None,
            "review_note": "",
            "reviews": [],
            "created_at": _now(),
            "updated_at": _now(),
            "reviewed_at": None,
            **payload,
        }
        with self._lock:
            atomic_write_json(self.directory / f"{decision_id}.json", document)
        return document

    def get(self, decision_id: str) -> dict[str, Any] | None:
        clean_id = str(decision_id or "").strip().lower()
        if not _DECISION_ID.fullmatch(clean_id):
            raise ValueError("无效的投前决策 ID")
        with self._lock:
            return self._read(self.directory / f"{clean_id}.json")

    def latest(
        self,
        *,
        job_id: int,
        input_hash: str | None = None,
    ) -> dict[str, Any] | None:
        with self._lock:
            items = [
                item
                for path in self.directory.glob("pre_app_*.json")
                if (item := self._read(path))
                and item.get("job_id") == job_id
                and (input_hash is None or item.get("input_hash") == input_hash)
            ]
        return max(items, key=lambda item: str(item.get("created_at") or ""), default=None)

    def update(
        self,
        decision_id: str,
        change: Callable[[dict[str, Any]], None],
    ) -> dict[str, Any]:
        with self._lock:
            document = self.get(decision_id)
            if document is None:
                raise ValueError(f"投前决策 {decision_id} 不存在")
            change(document)
            document["updated_at"] = _now()
            atomic_write_json(self.directory / f"{decision_id}.json", document)
            return document

    @staticmethod
    def _read(path: Path) -> dict[str, Any] | None:
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return None
        if not isinstance(payload, dict) or payload.get("schema") != DECISION_SCHEMA:
            return None
        return payload


decision_store = PreApplicationDecisionStore()


def _profile_evidence(section: ProfileSection) -> dict[str, Any]:
    return {
        "source_ref": f"profile_section:{section.id}",
        "section_type": section.section_type,
        "title": section.title or "",
        "content": section.content_json or {},
        "source": section.source,
        "confidence": section.confidence,
        "tier": section.tier,
    }


def _job_snapshot(job: Job) -> dict[str, Any]:
    return {
        "source_ref": f"job:{job.id}",
        "id": job.id,
        "title": job.title,
        "company": job.company,
        "location": job.location,
        "salary_text": job.salary_text,
        "education": job.education,
        "experience": job.experience,
        "job_type": job.job_type,
        "company_industry": job.company_industry,
        "description": job.raw_description,
        "source": job.source,
        "url": job.url,
    }


async def _load_current_context(job_id: int) -> dict[str, Any]:
    async with async_session() as db:
        job = (
            await db.execute(select(Job).where(Job.id == job_id))
        ).scalar_one_or_none()
        if job is None:
            raise ValueError(f"岗位 #{job_id} 不存在")
        job_row = _job_snapshot(job)
        if not str(job.raw_description or "").strip():
            return {"stage": "needs_job_description", "job": job_row}

        profile = (
            await db.execute(
                select(Profile)
                .where(Profile.is_default == True)
                .order_by(Profile.updated_at.desc(), Profile.id.desc())
                .limit(1)
            )
        ).scalars().first()
        if profile is None:
            return {"stage": "needs_profile_evidence", "job": job_row}
        sections = list((
            await db.execute(
                select(ProfileSection)
                .where(ProfileSection.profile_id == profile.id)
                .where(ProfileSection.tier == "verified_fact")
                .order_by(ProfileSection.sort_order.asc(), ProfileSection.id.asc())
            )
        ).scalars().all())
        if not sections:
            return {
                "stage": "needs_profile_evidence",
                "job": job_row,
                "profile_id": profile.id,
            }

        latest_run = (
            await db.execute(
                select(JobResearchRun)
                .where(JobResearchRun.job_id == job_id)
                .order_by(JobResearchRun.created_at.desc(), JobResearchRun.run_id.desc())
                .limit(1)
            )
        ).scalars().first()
        if latest_run is None:
            return {
                "stage": "needs_research",
                "job": job_row,
                "profile_id": profile.id,
                "profile_evidence_count": len(sections),
            }
        if latest_run.status in {"pending", "running"}:
            return {
                "stage": "research_running",
                "job": job_row,
                "profile_id": profile.id,
                "profile_evidence_count": len(sections),
                "research_run": {
                    "run_id": latest_run.run_id,
                    "status": latest_run.status,
                    "attempts": latest_run.attempts,
                },
            }
        if latest_run.status != "completed":
            return {
                "stage": "research_failed",
                "job": job_row,
                "profile_id": profile.id,
                "profile_evidence_count": len(sections),
                "research_run": {
                    "run_id": latest_run.run_id,
                    "status": latest_run.status,
                    "error": latest_run.error or "",
                    "attempts": latest_run.attempts,
                },
            }
        if latest_run.review_status != "accepted":
            return {
                "stage": (
                    "research_rejected"
                    if latest_run.review_status == "rejected"
                    else "research_needs_review"
                ),
                "job": job_row,
                "profile_id": profile.id,
                "profile_evidence_count": len(sections),
                "research_run": {
                    "run_id": latest_run.run_id,
                    "status": latest_run.status,
                    "review_status": latest_run.review_status,
                    "review_note": latest_run.review_note or "",
                    "reviewed_at": (
                        str(latest_run.reviewed_at)
                        if latest_run.reviewed_at
                        else None
                    ),
                    "attempts": latest_run.attempts,
                },
            }

        sources = list((
            await db.execute(
                select(ResearchEvidenceSnapshot)
                .where(ResearchEvidenceSnapshot.run_id == latest_run.run_id)
                .order_by(ResearchEvidenceSnapshot.id.asc())
            )
        ).scalars().all())
        findings = list((
            await db.execute(
                select(ResearchFinding)
                .where(ResearchFinding.run_id == latest_run.run_id)
                .order_by(ResearchFinding.id.asc())
            )
        ).scalars().all())
        if not sources or not findings:
            return {
                "stage": "research_failed",
                "job": job_row,
                "profile_id": profile.id,
                "profile_evidence_count": len(sections),
                "research_run": {
                    "run_id": latest_run.run_id,
                    "status": "invalid",
                    "error": "调研已完成，但缺少可引用证据或结论",
                    "attempts": latest_run.attempts,
                },
            }

        source_refs = {item.source_ref for item in sources}
        finding_rows: list[dict[str, Any]] = []
        for item in findings:
            refs = list(item.source_refs_json or [])
            if not refs or any(ref not in source_refs for ref in refs):
                return {
                    "stage": "research_failed",
                    "job": job_row,
                    "profile_id": profile.id,
                    "profile_evidence_count": len(sections),
                    "research_run": {
                        "run_id": latest_run.run_id,
                        "status": "invalid",
                        "error": f"调研结论 #{item.id} 缺少有效来源",
                        "attempts": latest_run.attempts,
                    },
                }
            finding_rows.append(
                {
                    "id": item.id,
                    "finding_type": item.finding_type,
                    "statement": item.statement,
                    "details": item.details_json or {},
                    "source_refs": refs,
                    "evidence_level": item.evidence_level,
                }
            )

        profile_rows = [_profile_evidence(section) for section in sections]
        research_row = {
            "run_id": latest_run.run_id,
            "findings": finding_rows,
            "gaps": [
                str(item).strip()
                for item in ((latest_run.result_json or {}).get("gaps") or [])
                if str(item).strip()
            ],
        }
        decision_input = {
            "job": job_row,
            "profile_id": profile.id,
            "profile_evidence": profile_rows,
            "research": research_row,
        }
        latest_proposal = (
            await db.execute(
                select(ResumeOptimizationProposal)
                .where(ResumeOptimizationProposal.job_id == job_id)
                .where(ResumeOptimizationProposal.research_run_id == latest_run.run_id)
                .order_by(ResumeOptimizationProposal.created_at.desc())
                .limit(1)
            )
        ).scalars().first()
        return {
            "stage": "needs_decision",
            "job": job_row,
            "profile_id": profile.id,
            "profile_evidence_count": len(profile_rows),
            "research_run": {
                "run_id": latest_run.run_id,
                "status": latest_run.status,
                "finding_count": len(finding_rows),
                "source_count": len(sources),
            },
            "decision_input": decision_input,
            "input_hash": _canonical_hash(decision_input),
            "allowed_source_refs": {
                job_row["source_ref"],
                *(item["source_ref"] for item in profile_rows),
                *source_refs,
            },
            "profile_source_refs": {item["source_ref"] for item in profile_rows},
            "latest_resume_proposal": (
                {
                    "proposal_id": latest_proposal.proposal_id,
                    "status": latest_proposal.status,
                    "created_at": str(latest_proposal.created_at),
                }
                if latest_proposal is not None
                else None
            ),
        }


def _public_state(context: dict[str, Any]) -> dict[str, Any]:
    return {
        key: value
        for key, value in context.items()
        if key
        not in {
            "decision_input",
            "allowed_source_refs",
            "profile_source_refs",
            "latest_resume_proposal",
        }
    }


async def get_pre_application_state(job_id: int) -> dict[str, Any]:
    clean_job_id = _clean_job_id(job_id)
    context = await _load_current_context(clean_job_id)
    state = _public_state(context)
    if context["stage"] != "needs_decision":
        return state

    decision = decision_store.latest(
        job_id=clean_job_id,
        input_hash=str(context["input_hash"]),
    )
    if decision is None:
        stale = decision_store.latest(job_id=clean_job_id)
        if stale is not None:
            state["stale_decision_id"] = stale["id"]
        return state

    state["decision"] = decision
    if decision.get("status") != "reviewed":
        state["stage"] = "needs_decision_review"
        return state
    if decision.get("final_decision") == "no_go":
        state["stage"] = "completed_no_go"
        return state
    if decision.get("final_decision") == "insufficient_evidence":
        state["stage"] = "completed_insufficient_evidence"
        return state
    proposal = context.get("latest_resume_proposal")
    if proposal is not None:
        state["stage"] = "resume_proposal_ready"
        state["resume_proposal"] = proposal
        return state
    state["stage"] = "ready_for_resume_proposal"
    return state


async def prepare_pre_application_decision(
    job_id: int,
    research_run_id: str | None = None,
) -> dict[str, Any]:
    clean_job_id = _clean_job_id(job_id)
    context = await _load_current_context(clean_job_id)
    if context["stage"] != "needs_decision":
        raise ValueError(f"当前投前决策阶段为 {context['stage']}，不能生成决策")
    active_run_id = str((context.get("research_run") or {}).get("run_id") or "")
    clean_run_id = _clean_text(research_run_id, "research_run_id", 64)
    if clean_run_id and clean_run_id != active_run_id:
        raise ValueError("research_run_id 不是当前岗位最新完成的调研")

    existing = decision_store.latest(
        job_id=clean_job_id,
        input_hash=str(context["input_hash"]),
    )
    if existing is not None:
        return existing

    decision_input = context["decision_input"]
    raw = await chat_completion(
        messages=[
            {
                "role": "system",
                "content": (
                    "你是 OfferU 的投前决策分析器。只使用输入中的当前岗位、已确认职业证据和岗位调研结论。"
                    "不得把推断写成事实，不得补造候选人成果，不输出录用概率或统一匹配分。"
                    "recommendation 只能是 go、conditional_go、no_go、insufficient_evidence。"
                    "每条 evidence 必须包含 source_refs、claim、kind；source_refs 只能逐字使用输入中的 source_ref。"
                    "kind 只能是 candidate_fact、job_requirement、research_fact、inference。"
                    "返回且只返回 JSON，字段必须恰好为 recommendation、rationale、strengths、gaps、"
                    "conditions、missing_evidence、evidence。"
                ),
            },
            {
                "role": "user",
                "content": json.dumps(decision_input, ensure_ascii=False, default=str),
            },
        ],
        temperature=0.0,
        json_mode=True,
        max_tokens=2200,
        tier="standard",
    )
    detail = _validated_decision(
        extract_json(raw or ""),
        allowed_source_refs=set(context["allowed_source_refs"]),
        profile_source_refs=set(context["profile_source_refs"]),
        job_source_ref=str(context["job"]["source_ref"]),
    )

    current = await _load_current_context(clean_job_id)
    if current.get("input_hash") != context["input_hash"]:
        raise ValueError("生成期间岗位、职业证据或调研发生变化，请重新准备投前决策")
    existing = decision_store.latest(
        job_id=clean_job_id,
        input_hash=str(context["input_hash"]),
    )
    if existing is not None:
        return existing
    return decision_store.create(
        {
            "job_id": clean_job_id,
            "profile_id": context["profile_id"],
            "research_run_id": active_run_id,
            "input_hash": context["input_hash"],
            "agent_recommendation": detail["recommendation"],
            "decision": detail,
            "model_runtime": get_llm_runtime_info("standard"),
        }
    )


async def review_pre_application_decision(
    decision_id: str,
    final_decision: str,
    note: str = "",
) -> dict[str, Any]:
    decision = decision_store.get(decision_id)
    if decision is None:
        raise ValueError(f"投前决策 {decision_id} 不存在")
    clean_final = _clean_text(final_decision, "final_decision", 40).lower()
    if clean_final not in FINAL_DECISIONS:
        raise ValueError(
            "final_decision 只能是 go、conditional_go、no_go 或 insufficient_evidence"
        )
    clean_note = _clean_text(note, "note", 2000)
    if clean_final != decision.get("agent_recommendation") and not clean_note:
        raise ValueError("覆盖 Agent 建议时必须填写 note")

    context = await _load_current_context(_clean_job_id(decision.get("job_id")))
    if context.get("input_hash") != decision.get("input_hash"):
        raise ValueError("岗位、职业证据或调研已经变化，不能确认过期的投前决策")

    def record(document: dict[str, Any]) -> None:
        reviews = document.get("reviews")
        if not isinstance(reviews, list):
            reviews = []
            document["reviews"] = reviews
        if (
            document.get("status") == "reviewed"
            and document.get("final_decision") == clean_final
            and document.get("review_note") == clean_note
        ):
            return
        reviewed_at = _now()
        reviews.append(
            {
                "previous_final_decision": document.get("final_decision"),
                "final_decision": clean_final,
                "note": clean_note,
                "reviewed_at": reviewed_at,
            }
        )
        document["status"] = "reviewed"
        document["final_decision"] = clean_final
        document["review_note"] = clean_note
        document["reviewed_at"] = reviewed_at

    return decision_store.update(str(decision["id"]), record)
