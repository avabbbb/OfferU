"""Career Director question answers → reviewable memory evidence.

The Career Director asks bounded questions inside a completed CareerTask
result (discovery ``briefing.questions`` or job ``resume_preparation.questions``).
A user answer is never Career Truth: it is recorded as a source-linked
LearningObservation plus a pending verified_fact MemoryProposal, and only the
existing ``review_memory_proposal`` inbox path can promote it.  When such a
proposal is accepted, this module emits one idempotent bounded follow-up event
(JOB_SAVED reprepare for job-scoped answers, PROFILE_BASELINE_REQUIRED for
discovery answers) so preparation is regenerated for exactly the affected
scope; rejected/deferred proposals emit nothing.
"""

from __future__ import annotations

import hashlib
from typing import Any, Optional

from sqlalchemy import select

from app.database import async_session
from app.models.models import (
    CareerSource,
    CareerTask,
    EvidenceLink,
    Job,
    LearningObservation,
    MemoryProposal,
    Profile,
    ResumeOptimizationProposal,
)
from app.services.security_redaction import redact_sensitive_text, safe_error_message


QUESTION_SOURCE_TYPE = "career_question_answer"
QUESTION_OBSERVATION_TYPE = "career_answer_candidate"
MAX_QUESTIONS = 3
ANSWER_MAX_LENGTH = 5000


def _clean_text(value: Any, field: str, *, limit: int, required: bool = False) -> str:
    if value is None:
        if required:
            raise ValueError(f"{field} 不能为空")
        return ""
    if not isinstance(value, str):
        value = str(value)
    clean = redact_sensitive_text(value.strip(), max_length=limit).strip()
    if required and not clean:
        raise ValueError(f"{field} 不能为空")
    return clean


def _clean_question_index(value: Any) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0 or value >= MAX_QUESTIONS:
        raise ValueError("question_index 必须是 0–2 的整数")
    return int(value)


def _positive_int_or_none(value: Any) -> int | None:
    try:
        number = int(value)
    except (TypeError, ValueError):
        return None
    return number if number > 0 else None


def _int_id_list(value: Any) -> list[int]:
    if not isinstance(value, list):
        return []
    ids: list[int] = []
    for item in value[:30]:
        number = _positive_int_or_none(item)
        if number is not None and number not in ids:
            ids.append(number)
    return ids


async def _load_task(task_id: str) -> CareerTask:
    async with async_session() as db:
        row = await db.get(CareerTask, str(task_id or "").strip())
    if row is None:
        raise ValueError(f"CareerTask {task_id} 不存在")
    return row


def _task_result(task: CareerTask) -> dict[str, Any]:
    return task.result_json if isinstance(task.result_json, dict) else {}


def _task_input(task: CareerTask) -> dict[str, Any]:
    return task.input_json if isinstance(task.input_json, dict) else {}


def _task_job_id(task: CareerTask) -> int | None:
    payload = _task_input(task)
    for value in (
        payload.get("job_id"),
        task.target_id if task.target_type == "job" else None,
    ):
        job_id = _positive_int_or_none(value)
        if job_id is not None:
            return job_id
    briefing = _task_result(task).get("briefing")
    assessment = briefing.get("job_assessment") if isinstance(briefing, dict) else None
    if isinstance(assessment, dict):
        return _positive_int_or_none(assessment.get("job_id"))
    return None


def _task_profile_id(task: CareerTask) -> int | None:
    payload = _task_input(task)
    for value in (
        payload.get("profile_id"),
        task.target_id if task.target_type == "profile" else None,
    ):
        profile_id = _positive_int_or_none(value)
        if profile_id is not None:
            return profile_id
    return None


def _task_event_type(task: CareerTask) -> str:
    return str(_task_input(task).get("event_type") or "").strip().upper()


def _normalize_question(
    raw: Any,
    *,
    scope: str,
    job_id: int | None,
    resume_proposal_id: str,
) -> dict[str, Any] | None:
    if not isinstance(raw, dict):
        return None
    question = _clean_text(raw.get("question"), "question", limit=500, required=True)
    why_needed = _clean_text(
        raw.get("why_needed") or raw.get("why"),
        "why_needed",
        limit=400,
        required=True,
    )
    return {
        "question": question,
        "why_needed": why_needed,
        "unlocks": _clean_text(raw.get("unlocks"), "unlocks", limit=400),
        "optional": bool(raw.get("optional", True)),
        "scope": scope,
        "job_id": job_id if scope == "resume_preparation" else None,
        "resume_proposal_id": (
            resume_proposal_id if scope == "resume_preparation" else ""
        ),
        "requirement": _clean_text(raw.get("requirement"), "requirement", limit=260),
        "source_section_ids": _int_id_list(raw.get("source_section_ids")),
    }


def _collect_questions(task: CareerTask) -> list[dict[str, Any]]:
    """Flatten briefing.questions and resume_preparation.questions, max 1–3.

    Indices stay stable for answer submission/idempotency: they follow the
    emitted order, resume_preparation questions first for job tasks, then
    briefing questions.
    """

    result = _task_result(task)
    briefing = result.get("briefing") if isinstance(result.get("briefing"), dict) else {}
    job_id = _task_job_id(task)

    def _proposal_id_of(prep: Any) -> str:
        if not isinstance(prep, dict):
            return ""
        for key in ("proposal_id", "resume_proposal_id"):
            value = _clean_text(prep.get(key), "proposal_id", limit=80)
            if value:
                return value
        proposal = prep.get("proposal") if isinstance(prep.get("proposal"), dict) else None
        if proposal:
            return _clean_text(proposal.get("proposal_id"), "proposal_id", limit=80)
        return ""

    questions: list[dict[str, Any]] = []
    prep_candidates = [
        result.get("resume_preparation"),
        briefing.get("resume_preparation"),
    ]
    for prep in prep_candidates:
        if not isinstance(prep, dict):
            continue
        resume_proposal_id = _proposal_id_of(prep)
        for raw in prep.get("questions") or []:
            item = _normalize_question(
                raw,
                scope="resume_preparation",
                job_id=job_id,
                resume_proposal_id=resume_proposal_id,
            )
            if item is not None and len(questions) < MAX_QUESTIONS:
                questions.append(item)
        if questions:
            break

    if len(questions) < MAX_QUESTIONS:
        for raw in briefing.get("questions") or []:
            item = _normalize_question(
                raw,
                scope="discovery",
                job_id=job_id,
                resume_proposal_id="",
            )
            if item is not None and len(questions) < MAX_QUESTIONS:
                questions.append(item)

    for index, item in enumerate(questions):
        item["question_index"] = index
    return questions


def _question_external_id(task_id: str, question_index: int) -> str:
    return f"career-question:{task_id}:{question_index}"


async def _latest_answer_state(task_id: str) -> dict[int, dict[str, Any]]:
    """Map question_index → latest observation + its latest memory proposal."""

    async with async_session() as db:
        rows = (
            await db.execute(
                select(LearningObservation, CareerSource)
                .join(CareerSource, CareerSource.id == LearningObservation.source_id)
                .where(CareerSource.source_type == QUESTION_SOURCE_TYPE)
                .where(LearningObservation.status == "active")
                .order_by(LearningObservation.id.asc())
            )
        ).all()
        prefix = f"career-question:{task_id}:"
        latest: dict[int, tuple[LearningObservation, CareerSource]] = {}
        for observation, source in rows:
            if not str(source.external_id or "").startswith(prefix):
                continue
            meta = source.metadata_json if isinstance(source.metadata_json, dict) else {}
            index = _positive_int_or_none(meta.get("question_index"))
            if index is None:
                try:
                    index = int(str(source.external_id).rsplit(":", 1)[-1])
                except (TypeError, ValueError):
                    continue
            if index < 0 or index >= MAX_QUESTIONS:
                continue
            latest[index] = (observation, source)
        observation_ids = [o.id for o, _ in latest.values()]
        links: list[EvidenceLink] = []
        if observation_ids:
            links = list(
                (
                    await db.execute(
                        select(EvidenceLink)
                        .where(EvidenceLink.target_type == "memory_proposal")
                        .where(EvidenceLink.observation_id.in_(observation_ids))
                        .where(EvidenceLink.relation == "supports")
                        .order_by(EvidenceLink.id.asc())
                    )
                )
                .scalars()
                .all()
            )
        proposals: dict[int, MemoryProposal] = {}
        proposal_ids = [int(link.target_id) for link in links]
        if proposal_ids:
            for proposal in (
                await db.execute(
                    select(MemoryProposal).where(MemoryProposal.id.in_(proposal_ids))
                )
            ).scalars().all():
                proposals[proposal.id] = proposal
    latest_link: dict[int, int] = {}
    for link in links:
        latest_link[int(link.observation_id)] = int(link.target_id)
    state: dict[int, dict[str, Any]] = {}
    for index, (observation, source) in latest.items():
        proposal = proposals.get(latest_link.get(observation.id, -1))
        content = observation.content_json if isinstance(observation.content_json, dict) else {}
        state[index] = {
            "status": proposal.status if proposal is not None else "pending",
            "observation_id": observation.id,
            "proposal_id": proposal.id if proposal is not None else None,
            "answer": str(content.get("answer") or ""),
            "answered_at": str(observation.observed_at),
            "reviewed_at": str(proposal.reviewed_at) if proposal is not None and proposal.reviewed_at else None,
        }
    return state


async def get_career_questions(task_id: str) -> dict[str, Any]:
    """List the Director's questions for one task with persisted answer state.

    Only a real persisted CareerTask is accepted; a task without a validated
    result returns an empty list rather than invented questions.
    """

    task = await _load_task(task_id)
    questions = _collect_questions(task)
    answers = await _latest_answer_state(str(task.task_id))
    items: list[dict[str, Any]] = []
    for question in questions:
        item = {
            "question_index": question["question_index"],
            "question": question["question"],
            "why_needed": question["why_needed"],
            "unlocks": question["unlocks"],
            "optional": question["optional"],
            "scope": question["scope"],
            "requirement": question["requirement"],
            "source_section_ids": question["source_section_ids"],
            "job_id": question["job_id"],
            "resume_proposal_id": question["resume_proposal_id"],
            "answer": answers.get(question["question_index"]),
        }
        items.append(item)
    return {
        "task_id": str(task.task_id),
        "task_status": str(task.status),
        "questions": items,
    }


async def _resolve_default_profile_id() -> int | None:
    async with async_session() as db:
        row = (
            await db.execute(select(Profile).where(Profile.is_default == True))  # noqa: E712
        ).scalar_one_or_none()
    return int(row.id) if row is not None else None


async def _validate_resume_proposal_binding(
    *,
    task: CareerTask,
    question: dict[str, Any],
    proposal_id: str,
) -> str:
    """Ensure a submitted resume proposal belongs to this task's job scope."""

    clean_proposal_id = _clean_text(proposal_id, "proposal_id", limit=80)
    if not clean_proposal_id:
        return ""
    job_id = _task_job_id(task)
    if job_id is None:
        raise ValueError("该问题没有岗位上下文，不能绑定岗位简历提案")
    async with async_session() as db:
        proposal = await db.get(ResumeOptimizationProposal, clean_proposal_id)
        job_exists = await db.get(Job, int(job_id))
    if proposal is None or int(proposal.job_id) != int(job_id):
        raise ValueError("proposal_id 与该任务的岗位提案不匹配")
    if job_exists is None:
        raise ValueError("该任务的目标岗位不存在")
    declared = str(question.get("resume_proposal_id") or "")
    if declared and declared != clean_proposal_id:
        raise ValueError("proposal_id 与该问题绑定的简历提案不一致")
    return clean_proposal_id


async def submit_career_answer(
    task_id: str,
    question_index: int,
    answer: str,
    proposal_id: Optional[str] = None,
) -> dict[str, Any]:
    """Persist one user answer as an observation + pending memory proposal.

    Re-submitting the identical answer replays to the same observation and
    proposal (``duplicate: true``); a different answer becomes a new evidence
    revision under the same CareerSource, never a silent overwrite.
    """

    task = await _load_task(task_id)
    if task.status != "completed":
        raise ValueError("只有已完成任务的问题才能回答")
    index = _clean_question_index(question_index)
    questions = _collect_questions(task)
    if index >= len(questions):
        raise ValueError("question_index 超出当前问题范围")
    question = questions[index]
    clean_answer = _clean_text(answer, "answer", limit=ANSWER_MAX_LENGTH, required=True)
    resume_proposal_id = await _validate_resume_proposal_binding(
        task=task,
        question=question,
        proposal_id=str(proposal_id or ""),
    )
    job_id = question["job_id"]
    if job_id is None:
        job_id = _task_job_id(task)
    profile_id = _task_profile_id(task)
    if profile_id is None:
        profile_id = await _resolve_default_profile_id()
    task_key = str(task.task_id)
    external_id = _question_external_id(task_key, index)
    affected = list(question["source_section_ids"])
    answer_hash = hashlib.sha256(clean_answer.encode("utf-8")).hexdigest()

    from app.ops import execute_operation

    observation_result = await execute_operation(
        "record_learning_observation",
        {
            "source_type": QUESTION_SOURCE_TYPE,
            "source_external_id": external_id,
            "source_title": "OfferU 职业问答",
            "source_locator": f"career-question:{task_key}#q{index}",
            "source_metadata": {
                "kind": "career_question_answer",
                "task_id": task_key,
                "question_index": index,
                "job_id": job_id,
                "profile_id": profile_id,
                "resume_proposal_id": resume_proposal_id or question.get("resume_proposal_id") or "",
                "affected_source_section_ids": affected,
                "event_type": _task_event_type(task),
            },
            "observation_type": QUESTION_OBSERVATION_TYPE,
            "content": {
                "question": question["question"],
                "why_needed": question["why_needed"],
                "requirement": question["requirement"],
                "scope": question["scope"],
                "answer": clean_answer,
                "source_excerpt": clean_answer,
                "task_id": task_key,
                "question_index": index,
                "job_id": job_id,
                "resume_proposal_id": resume_proposal_id or question.get("resume_proposal_id") or "",
                "affected_source_section_ids": affected,
            },
            "idempotency_key": f"{external_id}:{answer_hash}",
        },
        surface="career_questions",
    )
    if not observation_result.get("ok") or not isinstance(observation_result.get("outputs"), dict):
        errors = observation_result.get("errors") or ["回答无法保存为学习观察"]
        raise RuntimeError(str(errors[0]))
    observation = observation_result["outputs"]

    requirement_note = (
        f"；关联岗位要求：{question['requirement'][:160]}"
        if question.get("requirement")
        else ""
    )
    proposal_result = await execute_operation(
        "create_memory_proposal",
        {
            "observation_id": int(observation.get("id") or 0),
            "target_tier": "verified_fact",
            "section_type": "custom:c_generic",
            "title": _clean_text(question["question"], "title", limit=80) or "职业问答回答",
            "after": {
                "category_label": "职业问答",
                "description": clean_answer,
                "bullet": clean_answer,
            },
            "reason": (
                f"来自 Career Director 问题“{question['question'][:160]}”的用户回答"
                f"{requirement_note}；经记忆收件箱审核确认前不会写入 Profile。"
            )[:4000],
            "impact": [
                "接受后进入岗位分析、简历提案和面试准备的证据池",
                "与该问题关联的岗位准备范围会按原提案边界重新准备",
            ],
        },
        surface="career_questions",
    )
    if not proposal_result.get("ok") or not isinstance(proposal_result.get("outputs"), dict):
        errors = proposal_result.get("errors") or ["回答无法生成记忆提案"]
        raise RuntimeError(str(errors[0]))
    proposal = proposal_result["outputs"]

    return {
        "task_id": task_key,
        "question_index": index,
        "scope": question["scope"],
        "job_id": job_id,
        "resume_proposal_id": resume_proposal_id or question.get("resume_proposal_id") or "",
        "observation_id": int(observation.get("id") or 0),
        "proposal_id": proposal.get("id"),
        "status": str(proposal.get("status") or "pending"),
        "duplicate": bool(observation.get("duplicate")),
        "answered_at": str(observation.get("observed_at") or ""),
    }


async def emit_answered_question_followup(
    *,
    proposal_id: int,
    source_metadata: dict[str, Any],
    observation_content: dict[str, Any],
    observation_id: int,
) -> dict[str, Any] | None:
    """Emit exactly one bounded event after a question answer is accepted.

    Job-scoped answers emit JOB_SAVED carrying replaces_proposal_id and
    affected_source_section_ids so the Career Director re-prepares only that
    job proposal/sections; discovery answers emit PROFILE_BASELINE_REQUIRED
    for a bounded re-discovery.  Both use a stable dedupe key derived from the
    accepted observation, so re-accepts and retries never duplicate the
    signal; reject/defer paths never call this hook.
    """

    meta = dict(source_metadata or {})
    content = dict(observation_content or {})
    if str(meta.get("kind") or "") != "career_question_answer":
        return None

    job_id = _positive_int_or_none(meta.get("job_id") or content.get("job_id"))
    profile_id = _positive_int_or_none(meta.get("profile_id") or content.get("profile_id"))
    task_id = str(meta.get("task_id") or content.get("task_id") or "")[:80]
    resume_proposal_id = str(
        meta.get("resume_proposal_id") or content.get("resume_proposal_id") or ""
    )[:80]
    affected = _int_id_list(
        meta.get("affected_source_section_ids")
        or content.get("affected_source_section_ids")
    )

    from app.ops import execute_operation

    if job_id is not None:
        payload: dict[str, Any] = {
            "job_id": job_id,
            "runtime_provider": "codex",
        }
        if profile_id is not None:
            payload["profile_id"] = profile_id
        if resume_proposal_id:
            payload["replaces_proposal_id"] = resume_proposal_id
        if affected:
            payload["affected_source_section_ids"] = affected
        payload["accepted_observation_id"] = int(observation_id)
        result = await execute_operation(
            "record_automation_event",
            {
                "event_type": "JOB_SAVED",
                "source": "career_answer_review",
                "target_type": "job",
                "target_id": str(job_id),
                "payload": payload,
                "dedupe_key": (
                    f"career-answer-reprepare:{task_id}:{int(observation_id)}:{int(proposal_id)}"
                )[:180],
            },
            surface="career_questions",
        )
    else:
        if profile_id is None:
            return {
                "emitted": False,
                "reason": "missing_profile_id",
                "event_type": "",
            }
        result = await execute_operation(
            "record_automation_event",
            {
                "event_type": "PROFILE_BASELINE_REQUIRED",
                "source": "career_answer_review",
                "target_type": "profile",
                "target_id": str(profile_id),
                "payload": {
                    "profile_id": profile_id,
                    "runtime_provider": "codex",
                    "accepted_observation_id": int(observation_id),
                },
                "dedupe_key": (
                    f"career-answer-rediscovery:{task_id}:{int(observation_id)}:{int(proposal_id)}"
                )[:180],
            },
            surface="career_questions",
        )
    outputs = result.get("outputs") if isinstance(result.get("outputs"), dict) else {}
    if not result.get("ok"):
        errors = result.get("errors") or ["follow-up event failed"]
        return {
            "emitted": False,
            "reason": safe_error_message(str(errors[0])),
            "event_type": "",
        }
    return {
        "emitted": True,
        "reused": bool(outputs.get("reused")),
        "event_id": str(outputs.get("event_id") or ""),
        "event_type": str(outputs.get("event_type") or ""),
    }


__all__ = [
    "get_career_questions",
    "submit_career_answer",
    "emit_answered_question_followup",
]
