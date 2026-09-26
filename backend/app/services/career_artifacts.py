from __future__ import annotations

import hashlib
import json
import re
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from app.runtime_paths import runtime_data_path
from app.services.agent_files import atomic_write_json


ARTIFACT_SCHEMA = "offeru.career_artifact.v1"
ARTIFACT_TYPES = frozenset(
    {
        "application_answers",
        "application_email",
        "company_research",
        "cover_letter",
        "follow_up_draft",
        "interview_debrief",
        "interview_prep",
        "interview_risk_review",
        "job_evaluation",
        "offer_review",
        "pattern_analysis",
        "reengagement_candidate",
        "reply_digest",
        "skill_gap",
    }
)
_ARTIFACT_ID = re.compile(r"^artifact_[0-9a-f]{32}$")
_STORE_LOCK = threading.RLock()
_MAX_IDEMPOTENCY_KEY_LENGTH = 200


def _normalize_idempotency_key(value: Any, *, allow_missing: bool = False) -> str:
    if value is None and allow_missing:
        return ""
    if not isinstance(value, str):
        raise ValueError("idempotency key 必须是字符串")
    clean_key = value.strip()
    if not clean_key and allow_missing:
        return ""
    if not clean_key:
        raise ValueError("idempotency key 不能为空")
    if len(clean_key) > _MAX_IDEMPOTENCY_KEY_LENGTH:
        raise ValueError("idempotency key 长度不能超过 200 个字符")
    return clean_key


def artifact_id_for_key(artifact_type: str, idempotency_key: str) -> str:
    """Return a stable ID scoped to an artifact type and this per-user store."""
    clean_type = str(artifact_type or "").strip()
    clean_key = _normalize_idempotency_key(idempotency_key)
    if clean_type not in ARTIFACT_TYPES:
        raise ValueError(f"不支持的材料类型: {clean_type}")
    digest = hashlib.sha256(f"{clean_type}\0{clean_key}".encode("utf-8")).hexdigest()
    return f"artifact_{digest[:32]}"

_DEFAULT_DIR = runtime_data_path("artifacts")


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


class CareerArtifactStore:
    """Own validation and atomic persistence for durable career documents."""

    def __init__(self, directory: Path | None = None) -> None:
        self.directory = directory or _DEFAULT_DIR
        # Share a process lock across instances so concurrent retries using
        # separate handles for one runtime data directory cannot replace one
        # another's idempotent artifact.
        self._lock = _STORE_LOCK

    @staticmethod
    def _idempotency_key(metadata: dict[str, Any] | None) -> str:
        source = metadata if isinstance(metadata, dict) else {}
        return _normalize_idempotency_key(
            source.get("idempotency_key"), allow_missing=True
        )

    def find_by_idempotency_key(
        self, artifact_type: str, idempotency_key: str
    ) -> dict[str, Any] | None:
        """Look up an artifact inside this store, scoped to its type and key."""
        clean_type = str(artifact_type or "").strip()
        clean_key = _normalize_idempotency_key(idempotency_key)
        artifact_id = artifact_id_for_key(clean_type, clean_key)
        with self._lock:
            existing = self._read(self.directory / f"{artifact_id}.json")
        if existing is None:
            return None
        if (
            existing.get("id") != artifact_id
            or existing.get("artifact_type") != clean_type
            or self._idempotency_key(existing.get("metadata")) != clean_key
        ):
            raise ValueError("idempotency key collision in this artifact type")
        return existing

    def list(
        self,
        *,
        artifact_type: str | None = None,
        related_job_id: int | None = None,
        related_application_id: int | None = None,
        related_application_record_id: int | None = None,
        limit: int = 20,
    ) -> dict[str, Any]:
        if artifact_type and artifact_type not in ARTIFACT_TYPES:
            raise ValueError(f"不支持的材料类型: {artifact_type}")
        safe_limit = max(1, min(int(limit), 100))
        with self._lock:
            items = [item for path in self.directory.glob("artifact_*.json") if (item := self._read(path))]

        def matches(item: dict[str, Any]) -> bool:
            return (
                (not artifact_type or item.get("artifact_type") == artifact_type)
                and (related_job_id is None or item.get("related_job_id") == related_job_id)
                and (related_application_id is None or item.get("related_application_id") == related_application_id)
                and (
                    related_application_record_id is None
                    or item.get("related_application_record_id") == related_application_record_id
                )
            )

        matched = sorted(
            (item for item in items if matches(item)),
            key=lambda item: str(item.get("created_at") or ""),
            reverse=True,
        )
        return {
            "total": len(matched),
            "items": [self._summary(item) for item in matched[:safe_limit]],
            "artifact_types": sorted(ARTIFACT_TYPES),
        }

    def get(self, artifact_id: str) -> dict[str, Any] | None:
        clean_id = self._validate_id(artifact_id)
        with self._lock:
            return self._read(self.directory / f"{clean_id}.json")

    def export_all(self) -> dict[str, Any]:
        """Return full local artifact documents for the user data export."""
        with self._lock:
            items = [item for path in self.directory.glob("artifact_*.json") if (item := self._read(path))]
        items.sort(key=lambda item: str(item.get("created_at") or ""))
        return {"total": len(items), "items": items}

    def delete_for_scope(
        self,
        *,
        job_ids: set[int] | None = None,
        application_ids: set[int] | None = None,
    ) -> dict[str, int]:
        """Delete only artifacts explicitly linked to a reset data scope."""

        clean_job_ids = {int(value) for value in (job_ids or set())}
        clean_application_ids = {int(value) for value in (application_ids or set())}
        deleted = 0
        with self._lock:
            for path in self.directory.glob("artifact_*.json"):
                item = self._read(path)
                if not item:
                    continue
                related_job_id = item.get("related_job_id")
                related_application_id = item.get("related_application_id")
                try:
                    job_matches = related_job_id is not None and int(related_job_id) in clean_job_ids
                except (TypeError, ValueError):
                    job_matches = False
                try:
                    application_matches = (
                        related_application_id is not None
                        and int(related_application_id) in clean_application_ids
                    )
                except (TypeError, ValueError):
                    application_matches = False
                if not (
                    job_matches
                    or application_matches
                ):
                    continue
                path.unlink(missing_ok=True)
                deleted += 1
        return {"deleted": deleted}

    def save(
        self,
        *,
        artifact_type: str,
        title: str,
        content_markdown: str,
        related_job_id: int | None = None,
        related_application_id: int | None = None,
        related_application_record_id: int | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        clean_type = str(artifact_type or "").strip()
        clean_title = str(title or "").strip()
        clean_content = str(content_markdown or "").strip()
        if clean_type not in ARTIFACT_TYPES:
            raise ValueError(f"不支持的材料类型: {clean_type}")
        if not 1 <= len(clean_title) <= 200:
            raise ValueError("材料标题长度必须为 1-200 个字符")
        if not 1 <= len(clean_content) <= 80_000:
            raise ValueError("材料正文长度必须为 1-80000 个字符")
        if metadata is not None and not isinstance(metadata, dict):
            raise ValueError("metadata 必须是对象")

        idempotency_key = self._idempotency_key(metadata)
        with self._lock:
            if idempotency_key:
                artifact_id = artifact_id_for_key(clean_type, idempotency_key)
                existing = self._read(self.directory / f"{artifact_id}.json")
                if existing is not None:
                    if (
                        existing.get("id") != artifact_id
                        or existing.get("artifact_type") != clean_type
                        or self._idempotency_key(existing.get("metadata")) != idempotency_key
                    ):
                        raise ValueError("idempotency key collision in this artifact type")
                    if any(
                        existing.get(field) != value
                        for field, value in (
                            ("title", clean_title),
                            ("content_markdown", clean_content),
                            ("related_job_id", related_job_id),
                            ("related_application_id", related_application_id),
                            ("related_application_record_id", related_application_record_id),
                        )
                    ):
                        raise ValueError("idempotency key conflicts with existing artifact content")
                    # Replay of an idempotent save: keep the persisted artifact
                    # (user review state, created_at) instead of overwriting.
                    return existing
            else:
                artifact_id = f"artifact_{uuid.uuid4().hex}"
            payload = {
                "schema": ARTIFACT_SCHEMA,
                "id": artifact_id,
                "artifact_type": clean_type,
                "title": clean_title,
                "content_markdown": clean_content,
                "related_job_id": related_job_id,
                "related_application_id": related_application_id,
                "related_application_record_id": related_application_record_id,
                "metadata": metadata or {},
                "created_at": _utc_now(),
            }
            atomic_write_json(self.directory / f"{artifact_id}.json", payload)
        return payload

    def record_practice_answer(
        self,
        artifact_id: str,
        *,
        question_index: int,
        question: str,
        answer: str,
    ) -> dict[str, Any] | None:
        """Persist one practice answer inside artifact metadata.

        The artifact content_markdown is never rewritten; answers live under
        ``metadata.practice.answers`` so delivery views stay stable.  The write
        is idempotent per question: a replayed identical answer returns the
        existing record with ``changed=False``.
        """
        clean_id = self._validate_id(artifact_id)
        index = int(question_index)
        clean_answer = str(answer or "").strip()
        if index < 0 or not clean_answer:
            raise ValueError("question_index/answer 无效")
        with self._lock:
            path = self.directory / f"{clean_id}.json"
            item = self._read(path)
            if item is None:
                return None
            metadata = item.get("metadata")
            if not isinstance(metadata, dict):
                metadata = {}
                item["metadata"] = metadata
            practice = metadata.get("practice")
            if not isinstance(practice, dict):
                practice = {}
                metadata["practice"] = practice
            answers = practice.get("answers")
            if not isinstance(answers, dict):
                answers = {}
                practice["answers"] = answers

            plan = metadata.get("practice_plan")
            total = 0
            if isinstance(plan, dict) and isinstance(plan.get("questions"), list):
                total = len(plan["questions"])

            now = _utc_now()
            key = str(index)
            existing = answers.get(key) if isinstance(answers.get(key), dict) else None
            changed = True
            if existing is not None and str(existing.get("answer") or "") == clean_answer:
                record = dict(existing)
                record.setdefault("attempts", 1)
                changed = False
            else:
                record = {
                    "question_index": index,
                    "question": str(question or "")[:500],
                    "answer": clean_answer,
                    "attempts": int(existing.get("attempts") or 0) + 1
                    if existing is not None
                    else 1,
                    "first_recorded_at": str(
                        existing.get("first_recorded_at") or now
                    )
                    if existing is not None
                    else now,
                    "updated_at": now,
                }
                answers[key] = record
            answered = len(answers)
            practice["answered"] = answered
            practice["total"] = total
            practice["completed"] = bool(total) and answered >= total
            if changed:
                practice["last_answered_at"] = now
                atomic_write_json(path, item)
            return {"answer": record, "practice": practice, "changed": changed}

    @staticmethod
    def _validate_id(artifact_id: str) -> str:
        clean_id = str(artifact_id or "").strip().lower()
        if not _ARTIFACT_ID.fullmatch(clean_id):
            raise ValueError("无效的材料 ID")
        return clean_id

    @staticmethod
    def _read(path: Path) -> dict[str, Any] | None:
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return None
        if not isinstance(payload, dict) or payload.get("schema") != ARTIFACT_SCHEMA:
            return None
        return payload

    @staticmethod
    def _summary(item: dict[str, Any]) -> dict[str, Any]:
        content = str(item.get("content_markdown") or "")
        return {
            "id": item.get("id"),
            "artifact_type": item.get("artifact_type"),
            "title": item.get("title"),
            "preview": content[:800],
            "related_job_id": item.get("related_job_id"),
            "related_application_id": item.get("related_application_id"),
            "related_application_record_id": item.get("related_application_record_id"),
            "metadata": item.get("metadata") or {},
            "created_at": item.get("created_at"),
        }


career_artifact_store = CareerArtifactStore()
