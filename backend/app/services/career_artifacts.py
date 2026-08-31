from __future__ import annotations

import json
import re
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

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
        "reply_digest",
        "skill_gap",
    }
)
_ARTIFACT_ID = re.compile(r"^artifact_[0-9a-f]{32}$")
_DEFAULT_DIR = Path(__file__).resolve().parents[2] / "data" / "artifacts"


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


class CareerArtifactStore:
    """Own validation and atomic persistence for durable career documents."""

    def __init__(self, directory: Path | None = None) -> None:
        self.directory = directory or _DEFAULT_DIR
        self._lock = threading.RLock()

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
        with self._lock:
            atomic_write_json(self.directory / f"{artifact_id}.json", payload)
        return payload

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
