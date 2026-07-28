from __future__ import annotations

import json
import re
import threading
import uuid
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from app.services.agent_files import atomic_write_json


FOLLOW_UP_SCHEMA = "offeru.follow_up_event.v1"
APPLICATION_TYPES = frozenset({"application", "application_record"})
CHANNELS = frozenset({"email", "linkedin", "phone", "wechat", "other"})
_EVENT_ID = re.compile(r"^followup_[0-9a-f]{32}$")
_DEFAULT_DIR = Path(__file__).resolve().parents[2] / "data" / "follow_ups"


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _as_date(value: Any) -> date | None:
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    text = str(value or "").strip()
    if not text:
        return None
    try:
        return datetime.fromisoformat(text.replace("Z", "+00:00")).date()
    except ValueError:
        try:
            return date.fromisoformat(text[:10])
        except ValueError:
            return None


class FollowUpStore:
    """Append immutable, user-confirmed follow-up events as atomic files."""

    def __init__(self, directory: Path | None = None) -> None:
        self.directory = directory or _DEFAULT_DIR
        self._lock = threading.RLock()

    def list(
        self,
        *,
        application_type: str | None = None,
        application_id: int | None = None,
        limit: int = 500,
    ) -> list[dict[str, Any]]:
        if application_type and application_type not in APPLICATION_TYPES:
            raise ValueError(f"不支持的投递记录类型: {application_type}")
        safe_limit = max(1, min(int(limit), 2000))
        with self._lock:
            items = [item for path in self.directory.glob("followup_*.json") if (item := self._read(path))]
        filtered = [
            item
            for item in items
            if (not application_type or item.get("application_type") == application_type)
            and (application_id is None or item.get("application_id") == application_id)
        ]
        return sorted(filtered, key=lambda item: str(item.get("sent_at") or ""), reverse=True)[:safe_limit]

    def record(
        self,
        *,
        application_type: str,
        application_id: int,
        channel: str,
        contact: str = "",
        notes: str = "",
        sent_at: str | None = None,
    ) -> dict[str, Any]:
        clean_type = str(application_type or "").strip()
        clean_channel = str(channel or "").strip().lower()
        if clean_type not in APPLICATION_TYPES:
            raise ValueError(f"不支持的投递记录类型: {clean_type}")
        if clean_channel not in CHANNELS:
            raise ValueError(f"不支持的跟进渠道: {clean_channel}")
        sent_date = _as_date(sent_at)
        if sent_at and sent_date is None:
            raise ValueError("sent_at 必须是有效的 ISO 日期")
        sent_date = sent_date or datetime.now(timezone.utc).date()
        event_id = f"followup_{uuid.uuid4().hex}"
        payload = {
            "schema": FOLLOW_UP_SCHEMA,
            "id": event_id,
            "application_type": clean_type,
            "application_id": int(application_id),
            "channel": clean_channel,
            "contact": str(contact or "").strip()[:300],
            "notes": str(notes or "").strip()[:2000],
            "sent_at": sent_date.isoformat(),
            "created_at": _utc_now(),
        }
        with self._lock:
            atomic_write_json(self.directory / f"{event_id}.json", payload)
        return payload

    @staticmethod
    def _read(path: Path) -> dict[str, Any] | None:
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return None
        if not isinstance(payload, dict) or payload.get("schema") != FOLLOW_UP_SCHEMA:
            return None
        return payload


def build_follow_up_dashboard(
    applications: list[dict[str, Any]],
    events: list[dict[str, Any]],
    *,
    today: date | None = None,
) -> dict[str, Any]:
    analysis_date = today or datetime.now(timezone.utc).date()
    by_application: dict[tuple[str, int], list[dict[str, Any]]] = {}
    for event in events:
        key = (str(event.get("application_type") or ""), int(event.get("application_id") or 0))
        by_application.setdefault(key, []).append(event)

    rows: list[dict[str, Any]] = []
    for application in applications:
        application_type = str(application.get("application_type") or "")
        application_id = int(application.get("application_id") or 0)
        status = str(application.get("status") or "").strip()
        normalized = status.lower()
        is_applied = normalized in {"submitted", "applied", "已投递"}
        is_responded = normalized in {"responded", "need_action", "已回复", "待处理"}
        is_interview = normalized in {"interview", "interviewing", "面试", "面试中"}
        if not (is_applied or is_responded or is_interview):
            continue

        history = sorted(
            by_application.get((application_type, application_id), []),
            key=lambda item: str(item.get("sent_at") or ""),
        )
        follow_up_count = len(history)
        explicit_next = _as_date(application.get("follow_up_date"))
        applied_at = _as_date(application.get("applied_at")) or _as_date(application.get("created_at")) or analysis_date
        last_sent = _as_date(history[-1].get("sent_at")) if history else None
        first_interval = 7 if is_applied else 1
        subsequent_interval = 7 if is_applied else 3
        next_date = explicit_next or (
            (last_sent + timedelta(days=subsequent_interval))
            if last_sent
            else (applied_at + timedelta(days=first_interval))
        )
        days_until = (next_date - analysis_date).days
        if is_applied and follow_up_count >= 2:
            urgency = "cold"
        elif is_responded and days_until <= 0:
            urgency = "urgent"
        elif days_until <= 0:
            urgency = "overdue"
        else:
            urgency = "waiting"
        rows.append(
            {
                **application,
                "days_since_application": max(0, (analysis_date - applied_at).days),
                "follow_up_count": follow_up_count,
                "last_follow_up_at": last_sent.isoformat() if last_sent else None,
                "next_follow_up_date": next_date.isoformat(),
                "days_until_follow_up": days_until,
                "urgency": urgency,
                "last_follow_up": history[-1] if history else None,
            }
        )

    rank = {"urgent": 0, "overdue": 1, "waiting": 2, "cold": 3}
    rows.sort(key=lambda item: (rank.get(str(item.get("urgency")), 9), item.get("next_follow_up_date") or ""))
    counts = {name: sum(1 for item in rows if item.get("urgency") == name) for name in rank}
    return {
        "metadata": {
            "analysis_date": analysis_date.isoformat(),
            "total_tracked": len(applications),
            "actionable_count": len(rows),
            **counts,
        },
        "entries": rows,
        "cadence_config": {
            "applied_first_days": 7,
            "applied_subsequent_days": 7,
            "responded_first_days": 1,
            "interview_first_days": 1,
            "responded_or_interview_subsequent_days": 3,
            "applied_max_attempts": 2,
        },
    }


follow_up_store = FollowUpStore()
