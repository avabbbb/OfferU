from __future__ import annotations

import asyncio
import hashlib
import json
import re
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

from sqlalchemy import select

from app.database import async_session
from app.models.models import Job, Profile, ProfileSection
from app.services.agent_files import atomic_write_json
from app.services.coding_agent_runtime import (
    DeepTaskSpec,
    execute_deep_task,
    list_local_executors,
)


BATCH_SCHEMA = "offeru.batch_job_evaluation.v1"
RESULT_SCHEMA = "offeru.job_evaluation_result.v1"
_BATCH_ID = re.compile(r"^batch_eval_[0-9a-f]{32}$")
_BATCH_DIR = Path(__file__).resolve().parents[2] / "data" / "batch_evaluations"
_WORKER_DIR = Path(__file__).resolve().parents[2] / "data" / "batch_workers"
_LIVE_TASKS: set[asyncio.Task] = set()

JOB_EVALUATION_OUTPUT_SCHEMA: dict[str, Any] = {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "title": RESULT_SCHEMA,
    "type": "object",
    "additionalProperties": False,
    "required": [
        "score",
        "recommendation",
        "summary",
        "strengths",
        "gaps",
        "evidence",
        "next_actions",
    ],
    "properties": {
        "score": {"type": "integer", "minimum": 0, "maximum": 100},
        "recommendation": {
            "type": "string",
            "enum": ["strong_match", "match", "weak_match", "skip"],
        },
        "summary": {"type": "string", "minLength": 1, "maxLength": 4000},
        "strengths": {
            "type": "array",
            "maxItems": 10,
            "items": {"type": "string", "minLength": 1, "maxLength": 1000},
        },
        "gaps": {
            "type": "array",
            "maxItems": 10,
            "items": {"type": "string", "minLength": 1, "maxLength": 1000},
        },
        "evidence": {
            "type": "array",
            "minItems": 1,
            "maxItems": 12,
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": ["source_ref", "claim", "kind"],
                "properties": {
                    "source_ref": {"type": "string", "minLength": 1, "maxLength": 200},
                    "claim": {"type": "string", "minLength": 1, "maxLength": 1000},
                    "kind": {
                        "type": "string",
                        "enum": ["candidate_fact", "job_requirement", "inference"],
                    },
                },
            },
        },
        "next_actions": {
            "type": "array",
            "maxItems": 8,
            "items": {"type": "string", "minLength": 1, "maxLength": 1000},
        },
    },
}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


class BatchEvaluationStore:
    def __init__(self, directory: Path | None = None) -> None:
        self.directory = directory or _BATCH_DIR
        self._lock = threading.RLock()

    def create(self, payload: dict[str, Any]) -> dict[str, Any]:
        batch_id = f"batch_eval_{uuid.uuid4().hex}"
        document = {
            "schema": BATCH_SCHEMA,
            "id": batch_id,
            "status": "pending",
            "created_at": _now(),
            "updated_at": _now(),
            **payload,
        }
        with self._lock:
            atomic_write_json(self.directory / f"{batch_id}.json", document)
        return document

    def get(self, batch_id: str) -> dict[str, Any] | None:
        clean_id = str(batch_id or "").strip().lower()
        if not _BATCH_ID.fullmatch(clean_id):
            raise ValueError("无效的批处理 ID")
        path = self.directory / f"{clean_id}.json"
        with self._lock:
            try:
                payload = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                return None
        return payload if isinstance(payload, dict) and payload.get("schema") == BATCH_SCHEMA else None

    def update(self, batch_id: str, change: Callable[[dict[str, Any]], None]) -> dict[str, Any]:
        with self._lock:
            payload = self.get(batch_id)
            if payload is None:
                raise ValueError(f"Batch evaluation {batch_id} not found")
            change(payload)
            payload["updated_at"] = _now()
            atomic_write_json(self.directory / f"{batch_id}.json", payload)
            return payload

    def list(self, limit: int = 20) -> dict[str, Any]:
        safe_limit = max(1, min(int(limit), 100))
        with self._lock:
            items = []
            for path in self.directory.glob("batch_eval_*.json"):
                try:
                    payload = json.loads(path.read_text(encoding="utf-8"))
                except (OSError, json.JSONDecodeError):
                    continue
                if isinstance(payload, dict) and payload.get("schema") == BATCH_SCHEMA:
                    items.append(payload)
        items.sort(key=lambda item: str(item.get("created_at") or ""), reverse=True)
        return {
            "total": len(items),
            "items": [_summary(item) for item in items[:safe_limit]],
        }


def _summary(payload: dict[str, Any]) -> dict[str, Any]:
    jobs = payload.get("jobs") if isinstance(payload.get("jobs"), list) else []
    counts: dict[str, int] = {}
    for job in jobs:
        status = str(job.get("status") or "unknown") if isinstance(job, dict) else "unknown"
        counts[status] = counts.get(status, 0) + 1
    return {
        "id": payload.get("id"),
        "status": payload.get("status"),
        "runtime_id": payload.get("runtime_id"),
        "job_count": len(jobs),
        "counts": counts,
        "batch_error": payload.get("batch_error"),
        "created_at": payload.get("created_at"),
        "updated_at": payload.get("updated_at"),
    }


def _validated_text_list(payload: dict[str, Any], key: str, limit: int) -> list[str]:
    value = payload.get(key)
    if not isinstance(value, list):
        raise ValueError(f"worker 结果字段 {key} 必须是数组")
    if len(value) > limit:
        raise ValueError(f"worker 结果字段 {key} 超过最大条目数 {limit}")
    result: list[str] = []
    for item in value:
        if not isinstance(item, str) or not item.strip():
            raise ValueError(f"worker 结果字段 {key} 包含无效文本")
        clean_item = item.strip()
        if len(clean_item) > 1000:
            raise ValueError(f"worker 结果字段 {key} 包含超长文本")
        result.append(clean_item)
    return result


def _validated_result(
    payload: dict[str, Any] | None,
    *,
    allowed_source_refs: set[str],
) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise ValueError("worker 未返回 JSON 对象")
    expected_keys = set(JOB_EVALUATION_OUTPUT_SCHEMA["required"])
    if set(payload) != expected_keys:
        raise ValueError("worker 结果字段与输出 schema 不一致")
    score = payload.get("score")
    if isinstance(score, bool) or not isinstance(score, int):
        raise ValueError("worker score 必须是整数")
    recommendation = payload.get("recommendation")
    summary = payload.get("summary")
    if not 0 <= score <= 100 or not isinstance(summary, str) or not summary.strip():
        raise ValueError("worker 结果缺少有效 score 或 summary")
    if len(summary.strip()) > 4000:
        raise ValueError("worker summary 超过最大长度 4000")
    if not isinstance(recommendation, str):
        raise ValueError("worker recommendation 必须是字符串")
    recommendation = recommendation.strip().lower()
    if recommendation not in {"strong_match", "match", "weak_match", "skip"}:
        raise ValueError("worker recommendation 不在允许枚举中")

    raw_evidence = payload.get("evidence")
    if not isinstance(raw_evidence, list):
        raise ValueError("worker evidence 必须是数组")
    if not raw_evidence:
        raise ValueError("worker evidence 至少需要一条可追溯证据")
    if len(raw_evidence) > 12:
        raise ValueError("worker evidence 超过最大条目数 12")
    evidence: list[dict[str, str]] = []
    for item in raw_evidence:
        if not isinstance(item, dict):
            raise ValueError("worker evidence 条目必须是对象")
        if set(item) != {"source_ref", "claim", "kind"}:
            raise ValueError("worker evidence 条目字段与输出 schema 不一致")
        source_ref = item.get("source_ref")
        claim = item.get("claim")
        kind = item.get("kind")
        if not isinstance(source_ref, str) or source_ref not in allowed_source_refs:
            raise ValueError(f"worker evidence 引用了未知来源: {source_ref}")
        if not isinstance(claim, str) or not claim.strip():
            raise ValueError("worker evidence claim 不能为空")
        if len(claim.strip()) > 1000:
            raise ValueError("worker evidence claim 超过最大长度 1000")
        if kind not in {"candidate_fact", "job_requirement", "inference"}:
            raise ValueError("worker evidence kind 不在允许枚举中")
        if kind == "candidate_fact" and not source_ref.startswith("profile_section:"):
            raise ValueError("candidate_fact 必须引用 profile_section 来源")
        if kind == "job_requirement" and not source_ref.startswith("job:"):
            raise ValueError("job_requirement 必须引用 job 来源")
        evidence.append(
            {
                "source_ref": source_ref,
                "claim": claim.strip(),
                "kind": str(kind),
            }
        )

    return {
        "schema": RESULT_SCHEMA,
        "score": score,
        "recommendation": recommendation,
        "summary": summary.strip(),
        "strengths": _validated_text_list(payload, "strengths", 10),
        "gaps": _validated_text_list(payload, "gaps", 10),
        "evidence": evidence,
        "next_actions": _validated_text_list(payload, "next_actions", 8),
    }


def _compact_text(value: Any, limit: int = 3000) -> str:
    return str(value if value is not None else "").strip()[:limit]


def _compact_profile_section(section: ProfileSection) -> dict[str, Any]:
    """Keep one evidence representation and a short source excerpt for workers."""
    content = section.content_json if isinstance(section.content_json, dict) else {}
    normalized = content.get("normalized") if isinstance(content.get("normalized"), dict) else {}
    compact_normalized: dict[str, Any] = {}
    for key, value in normalized.items():
        if isinstance(value, list):
            compact_normalized[str(key)] = [_compact_text(item, 500) for item in value[:20]]
        elif isinstance(value, (str, int, float, bool)) or value is None:
            compact_normalized[str(key)] = _compact_text(value)

    legacy_facts: dict[str, Any] = {}
    if not compact_normalized:
        for key, value in content.items():
            if key in {"field_values", "normalized", "_agent_provenance", "bullet"}:
                continue
            if isinstance(value, list):
                legacy_facts[str(key)] = [_compact_text(item, 500) for item in value[:20]]
            elif isinstance(value, (str, int, float, bool)) or value is None:
                legacy_facts[str(key)] = _compact_text(value)

    provenance = content.get("_agent_provenance") if isinstance(content.get("_agent_provenance"), dict) else {}
    return {
        "source_ref": f"profile_section:{section.id}",
        "section_type": section.section_type,
        "title": _compact_text(section.title, 220),
        "tier": section.tier,
        "normalized": compact_normalized,
        "legacy_facts": legacy_facts,
        "bullet": _compact_text(content.get("bullet")),
        "source": section.source,
        "confidence": section.confidence,
        "provenance": {
            "confirmed": bool(provenance.get("confirmed")),
            "source_url": _compact_text(provenance.get("source_url"), 1000),
            "source_excerpt": _compact_text(provenance.get("source_text"), 1200),
        },
    }


def _worker_input(batch: dict[str, Any], job: dict[str, Any]) -> dict[str, Any]:
    return {
        "candidate_profile_context": batch.get("profile_snapshot") or {},
        "profile_evidence": batch.get("profile_evidence") or [],
        "job": job.get("job_snapshot") or {},
    }


def _allowed_source_refs(batch: dict[str, Any], job: dict[str, Any]) -> set[str]:
    refs = {
        str(item.get("source_ref"))
        for item in (batch.get("profile_evidence") or [])
        if isinstance(item, dict) and item.get("source_ref")
    }
    snapshot = job.get("job_snapshot") if isinstance(job.get("job_snapshot"), dict) else {}
    if snapshot.get("source_ref"):
        refs.add(str(snapshot["source_ref"]))
    return refs


def _payload_hash(payload: dict[str, Any]) -> str:
    canonical = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def _worker_prompt(batch: dict[str, Any], job: dict[str, Any]) -> str:
    context = _worker_input(batch, job)
    return (
        "You are an isolated OfferU job-evaluation worker. You have no need to read files, browse, or use tools. "
        "Evaluate only the supplied candidate and job evidence. Never invent candidate facts or missing job requirements. "
        "candidate_profile_context is orientation only and cannot be cited as evidence. "
        "Every evidence item must be an object with source_ref copied exactly from an input source_ref, a concise claim, "
        "and kind (candidate_fact|job_requirement|inference). Distinguish evidence from inference. "
        "Return exactly one JSON object conforming to the provided output schema.\n\n"
        + json.dumps(context, ensure_ascii=False, default=str)
    )


async def _execute_job(batch_id: str, job_id: int, semaphore: asyncio.Semaphore) -> None:
    async with semaphore:
        def mark_processing(payload: dict[str, Any]) -> None:
            task = next(item for item in payload["jobs"] if int(item["job_id"]) == job_id)
            task.update({"status": "processing", "started_at": _now(), "error": None})
            task["attempts"] = int(task.get("attempts") or 0) + 1

        batch = batch_evaluation_store.update(batch_id, mark_processing)
        job = next(item for item in batch["jobs"] if int(item["job_id"]) == job_id)
        worker_dir = _WORKER_DIR / batch_id / str(job_id)
        input_payload = _worker_input(batch, job)
        input_path = worker_dir / "input.json"
        input_sha256 = _payload_hash(input_payload)
        atomic_write_json(input_path, input_payload)

        def record_input(payload: dict[str, Any]) -> None:
            task = next(item for item in payload["jobs"] if int(item["job_id"]) == job_id)
            task.update(
                {
                    "input_path": str(input_path),
                    "input_sha256": input_sha256,
                    "result_schema": RESULT_SCHEMA,
                }
            )

        batch_evaluation_store.update(batch_id, record_input)
        try:
            worker = await execute_deep_task(DeepTaskSpec(
                runtime_id=str(batch["runtime_id"]),
                prompt=_worker_prompt(batch, job),
                cwd=worker_dir,
                output_schema=JOB_EVALUATION_OUTPUT_SCHEMA,
                task_type="batch_job_evaluation",
                task_id=f"{batch_id}:{job_id}",
                capability_grant={
                    "offeru_operations": [],
                    "data_scope": {"batch_id": batch_id, "job_id": job_id},
                    "filesystem": "task_cwd_read_only",
                    "network": "disabled",
                },
            ))
            result = _validated_result(
                worker.get("structured"),
                allowed_source_refs=_allowed_source_refs(batch, job),
            )

            def mark_completed(payload: dict[str, Any]) -> None:
                task = next(item for item in payload["jobs"] if int(item["job_id"]) == job_id)
                task.update({
                    "status": "completed",
                    "completed_at": _now(),
                    "score": result["score"],
                    "recommendation": result["recommendation"],
                    "review_status": "candidate",
                    "candidate_result": result,
                    "execution_trace": {
                        **(worker.get("trace") or {}),
                        "runtime_id": worker.get("runtime_id"),
                        "runtime_version": worker.get("runtime_version"),
                        "input_sha256": input_sha256,
                        "result_schema": RESULT_SCHEMA,
                    },
                    "error": None,
                })

            batch_evaluation_store.update(batch_id, mark_completed)
        except Exception as exc:
            def mark_failed(payload: dict[str, Any]) -> None:
                task = next(item for item in payload["jobs"] if int(item["job_id"]) == job_id)
                task.update(
                    {
                        "status": "failed",
                        "completed_at": _now(),
                        "review_status": "not_available",
                        "error": str(exc)[:2000],
                    }
                )

            batch_evaluation_store.update(batch_id, mark_failed)


async def _execute_batch(batch_id: str) -> None:
    try:
        batch = batch_evaluation_store.get(batch_id)
        if batch is None:
            return
        batch_evaluation_store.update(
            batch_id,
            lambda payload: payload.update(
                status="running",
                started_at=payload.get("started_at") or _now(),
                batch_error=None,
            ),
        )
        semaphore = asyncio.Semaphore(max(1, min(int(batch.get("max_workers") or 2), 4)))
        pending_ids = [int(item["job_id"]) for item in batch["jobs"] if item.get("status") == "pending"]
        await asyncio.gather(*(_execute_job(batch_id, job_id, semaphore) for job_id in pending_ids))

        def finish(payload: dict[str, Any]) -> None:
            statuses = [str(item.get("status")) for item in payload["jobs"]]
            if statuses and all(status == "completed" for status in statuses):
                payload["status"] = "completed"
            elif any(status == "completed" for status in statuses):
                payload["status"] = "partial"
            else:
                payload["status"] = "failed"
            payload["completed_at"] = _now()

        batch_evaluation_store.update(batch_id, finish)
    except Exception as exc:
        def mark_batch_failed(payload: dict[str, Any]) -> None:
            payload["status"] = "failed"
            payload["batch_error"] = str(exc)[:2000]
            payload["completed_at"] = _now()

        try:
            batch_evaluation_store.update(batch_id, mark_batch_failed)
        except Exception:
            pass


def _schedule(batch_id: str) -> None:
    task = asyncio.create_task(_execute_batch(batch_id), name=f"offeru-{batch_id}")
    _LIVE_TASKS.add(task)
    task.add_done_callback(_LIVE_TASKS.discard)


async def start_batch_job_evaluation(
    job_ids: list[int],
    runtime_id: str = "codex",
    max_workers: int = 2,
) -> dict[str, Any]:
    clean_ids = list(dict.fromkeys(int(item) for item in job_ids))
    if not clean_ids or len(clean_ids) > 20:
        raise ValueError("job_ids 必须包含 1-20 个岗位")
    runtimes = await list_local_executors()
    selected = next((item for item in runtimes["items"] if item["id"] == runtime_id), None)
    if not selected or not selected["available"] or not selected["supported"]:
        raise ValueError(f"coding-agent runtime {runtime_id} 当前不可用")
    if not selected["contract_compatible"]:
        missing = ", ".join(selected.get("missing_required_flags") or []) or "unknown capability"
        raise ValueError(f"coding-agent runtime {runtime_id} CLI 契约不兼容，缺少: {missing}")

    async with async_session() as db:
        profile = (
            await db.execute(select(Profile).where(Profile.is_default == True))
        ).scalar_one_or_none()
        if not profile:
            return {"error": "No default profile found"}
        sections = (
            await db.execute(
                select(ProfileSection)
                .where(ProfileSection.profile_id == profile.id)
                .where(ProfileSection.tier == "verified_fact")
                .where(ProfileSection.status == "active")
                .order_by(ProfileSection.sort_order.asc())
                .limit(40)
            )
        ).scalars().all()
        jobs = (await db.execute(select(Job).where(Job.id.in_(clean_ids)))).scalars().all()
        job_map = {job.id: job for job in jobs}
        missing = [job_id for job_id in clean_ids if job_id not in job_map]
        if missing:
            raise ValueError(f"以下岗位不存在: {missing}")
        profile_snapshot = {
            "name": profile.name,
            "headline": profile.headline,
            "summary": (profile.base_info_json or {}).get("summary") if isinstance(profile.base_info_json, dict) else "",
        }
        evidence = [_compact_profile_section(item) for item in sections]
        job_tasks = [
            {
                "job_id": job_id,
                "status": "pending",
                "review_status": "pending",
                "attempts": 0,
                "job_snapshot": {
                    "source_ref": f"job:{job_id}",
                    "id": job_map[job_id].id,
                    "title": job_map[job_id].title,
                    "company": job_map[job_id].company,
                    "location": job_map[job_id].location,
                    "salary_text": job_map[job_id].salary_text,
                    "summary": job_map[job_id].summary,
                    "description": (job_map[job_id].raw_description or "")[:30_000],
                    "source": job_map[job_id].source,
                    "source_url": job_map[job_id].url,
                },
            }
            for job_id in clean_ids
        ]

    batch = batch_evaluation_store.create({
        "runtime_id": runtime_id,
        "runtime_version": selected.get("version"),
        "runtime_contract": {
            "capabilities": selected.get("capabilities") or {},
            "isolation": selected.get("isolation"),
        },
        "max_workers": max(1, min(int(max_workers), 4)),
        "profile_snapshot": profile_snapshot,
        "profile_evidence": evidence,
        "jobs": job_tasks,
    })
    _schedule(batch["id"])
    return {**_summary(batch), "accepted": True}


async def resume_batch_job_evaluation(batch_id: str) -> dict[str, Any]:
    batch = batch_evaluation_store.get(batch_id)
    if batch is None:
        return {"error": f"Batch evaluation {batch_id} not found"}
    if any(task.get_name() == f"offeru-{batch_id}" and not task.done() for task in _LIVE_TASKS):
        return {**_summary(batch), "accepted": False, "message": "Batch is already running"}
    if not any(item.get("status") in {"pending", "processing", "failed"} for item in batch["jobs"]):
        return {**_summary(batch), "accepted": False, "message": "No pending or failed jobs to resume"}

    def reset(payload: dict[str, Any]) -> None:
        for item in payload["jobs"]:
            if item.get("status") in {"processing", "failed"}:
                item["status"] = "pending"
                item["error"] = None
                item["review_status"] = "pending"
                item.pop("candidate_result", None)
                item.pop("execution_trace", None)
        payload["status"] = "pending"
        payload["batch_error"] = None
        payload.pop("completed_at", None)

    batch = batch_evaluation_store.update(batch_id, reset)
    _schedule(batch_id)
    return {**_summary(batch), "accepted": True}


batch_evaluation_store = BatchEvaluationStore()
