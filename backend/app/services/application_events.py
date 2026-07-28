from __future__ import annotations

import json
import threading
import uuid
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from app.services.agent_files import atomic_write_json


APPLICATION_EVENT_SCHEMA = "offeru.application_event.v1"
APPLICATION_TYPES = frozenset({"application", "application_record"})
EVENT_TYPES = frozenset({"created", "status_changed", "field_updated", "follow_up_sent"})
_DEFAULT_DIR = Path(__file__).resolve().parents[2] / "data" / "application_events"


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _json_value(value: Any) -> Any:
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, list):
        return [_json_value(item) for item in value[:100]]
    if isinstance(value, dict):
        return {str(key): _json_value(item) for key, item in list(value.items())[:100]}
    return str(value)


def normalize_application_status(value: Any) -> str:
    clean = str(value or "").strip().lower()
    aliases = {
        "pending": "pending",
        "draft": "pending",
        "待投递": "pending",
        "submitted": "applied",
        "applied": "applied",
        "已投递": "applied",
        "responded": "responded",
        "need_action": "responded",
        "已回复": "responded",
        "待处理": "responded",
        "interview": "interview",
        "interviewing": "interview",
        "面试": "interview",
        "面试中": "interview",
        "rejected": "rejected",
        "已拒绝": "rejected",
        "offer": "offer",
        "accepted": "offer",
        "已录用": "offer",
    }
    return aliases.get(clean, clean or "unknown")


class ApplicationEventStore:
    """Append-only application history shared by UI and Agent operations."""

    def __init__(self, directory: Path | None = None) -> None:
        self.directory = directory or _DEFAULT_DIR
        self._lock = threading.RLock()

    def record(
        self,
        *,
        application_type: str,
        application_id: int,
        event_type: str,
        source: str,
        field_key: str | None = None,
        previous_value: Any = None,
        value: Any = None,
        metadata: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        clean_type = str(application_type or "").strip()
        clean_event = str(event_type or "").strip()
        if clean_type not in APPLICATION_TYPES:
            raise ValueError(f"不支持的投递记录类型: {clean_type}")
        if clean_event not in EVENT_TYPES:
            raise ValueError(f"不支持的投递事件类型: {clean_event}")
        event_id = f"appevent_{uuid.uuid4().hex}"
        payload = {
            "schema": APPLICATION_EVENT_SCHEMA,
            "id": event_id,
            "application_type": clean_type,
            "application_id": int(application_id),
            "event_type": clean_event,
            "field_key": str(field_key or "").strip() or None,
            "previous_value": _json_value(previous_value),
            "value": _json_value(value),
            "previous_status": normalize_application_status(previous_value) if field_key == "status" and previous_value is not None else None,
            "status": normalize_application_status(value) if field_key == "status" else None,
            "source": str(source or "unknown").strip()[:100],
            "metadata": _json_value(metadata or {}),
            "created_at": _now(),
        }
        with self._lock:
            atomic_write_json(self.directory / f"{event_id}.json", payload)
        return payload

    def list(
        self,
        *,
        application_type: str | None = None,
        application_id: int | None = None,
        event_type: str | None = None,
        limit: int = 1000,
    ) -> list[dict[str, Any]]:
        if application_type and application_type not in APPLICATION_TYPES:
            raise ValueError(f"不支持的投递记录类型: {application_type}")
        if event_type and event_type not in EVENT_TYPES:
            raise ValueError(f"不支持的投递事件类型: {event_type}")
        safe_limit = max(1, min(int(limit), 5000))
        with self._lock:
            items = [item for path in self.directory.glob("appevent_*.json") if (item := self._read(path))]
        filtered = [
            item
            for item in items
            if (not application_type or item.get("application_type") == application_type)
            and (application_id is None or item.get("application_id") == int(application_id))
            and (not event_type or item.get("event_type") == event_type)
        ]
        return sorted(filtered, key=lambda item: str(item.get("created_at") or ""), reverse=True)[:safe_limit]

    @staticmethod
    def _read(path: Path) -> dict[str, Any] | None:
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return None
        if not isinstance(payload, dict) or payload.get("schema") != APPLICATION_EVENT_SCHEMA:
            return None
        return payload


def build_application_pattern_analysis(
    applications: list[dict[str, Any]],
    events: list[dict[str, Any]],
) -> dict[str, Any]:
    current_status = Counter(normalize_application_status(item.get("status")) for item in applications)
    entity_keys = {
        (str(item.get("application_type") or ""), int(item.get("application_id") or 0))
        for item in applications
    }
    events_by_entity: dict[tuple[str, int], list[dict[str, Any]]] = {}
    for event in events:
        key = (str(event.get("application_type") or ""), int(event.get("application_id") or 0))
        if key in entity_keys:
            events_by_entity.setdefault(key, []).append(event)

    reached: dict[str, set[tuple[str, int]]] = {name: set() for name in ("applied", "responded", "interview", "rejected", "offer")}
    transitions: Counter[str] = Counter()
    for key, history in events_by_entity.items():
        for event in sorted(history, key=lambda item: str(item.get("created_at") or "")):
            status = str(event.get("status") or "")
            previous = str(event.get("previous_status") or "")
            if status in reached:
                reached[status].add(key)
            if previous and status and previous != status:
                transitions[f"{previous}->{status}"] += 1
    for application in applications:
        key = (str(application.get("application_type") or ""), int(application.get("application_id") or 0))
        status = normalize_application_status(application.get("status"))
        if status in reached:
            reached[status].add(key)

    applied = len(reached["applied"] | reached["responded"] | reached["interview"] | reached["rejected"] | reached["offer"])
    interviewed = len(reached["interview"] | reached["offer"])
    offered = len(reached["offer"])
    coverage_count = len(events_by_entity)
    total = len(applications)
    return {
        "metadata": {
            "generated_at": _now(),
            "application_count": total,
            "event_count": sum(len(items) for items in events_by_entity.values()),
            "timeline_coverage_count": coverage_count,
            "timeline_coverage_rate": round(coverage_count / total, 4) if total else 0,
            "coverage_note": "事件时间线从本功能启用后开始累积；覆盖不足时，转化率仅供方向判断。",
        },
        "current_status_counts": dict(sorted(current_status.items())),
        "reached_stage_counts": {
            "applied": applied,
            "interview": interviewed,
            "offer": offered,
            "rejected": len(reached["rejected"]),
        },
        "conversion_rates": {
            "applied_to_interview": round(interviewed / applied, 4) if applied else None,
            "interview_to_offer": round(offered / interviewed, 4) if interviewed else None,
            "applied_to_offer": round(offered / applied, 4) if applied else None,
        },
        "status_transitions": dict(transitions.most_common()),
    }


application_event_store = ApplicationEventStore()
