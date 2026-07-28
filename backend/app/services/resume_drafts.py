from __future__ import annotations

import hashlib
import json
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from app.services.agent_files import atomic_write_json

DRAFT_SCHEMA_VERSION = "offeru.resume_draft.v1"
DRAFT_DIR = Path(__file__).resolve().parents[2] / "data" / "resume_drafts"


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def save_resume_draft(
    *,
    resume_id: int,
    profile_id: int,
    jd_text: str,
    summary: str,
    sections: list[dict[str, Any]],
    fact_gates: dict[str, Any],
) -> dict[str, Any]:
    """Persist the generated preview before it is exposed or applied."""
    created_at = _now_iso()
    draft_id = f"draft_{uuid.uuid4().hex[:16]}"
    payload = {
        "schema_version": DRAFT_SCHEMA_VERSION,
        "id": draft_id,
        "status": "pending_review",
        "resume_id": int(resume_id),
        "profile_id": int(profile_id),
        "jd_sha256": hashlib.sha256(jd_text.encode("utf-8")).hexdigest(),
        "jd_text": jd_text,
        "generated": {"summary": summary, "sections": sections},
        "fact_gates": fact_gates,
        "created_at": created_at,
        "updated_at": created_at,
    }
    atomic_write_json(DRAFT_DIR / f"{draft_id}.json", payload)
    return payload


def load_resume_draft(draft_id: str) -> dict[str, Any] | None:
    normalized = str(draft_id or "").strip()
    if not normalized.startswith("draft_") or not normalized[6:].isalnum():
        return None
    path = DRAFT_DIR / f"{normalized}.json"
    if not path.exists():
        return None
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return None
    if not isinstance(payload, dict) or payload.get("schema_version") != DRAFT_SCHEMA_VERSION:
        return None
    return payload
