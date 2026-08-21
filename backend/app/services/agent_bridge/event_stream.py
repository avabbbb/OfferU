"""Agent Bridge event stream (Slice 1).

Standard-event append and cursor follow on top of AgentRunEvent. Bridge
allocates `seq`; host event IDs are dedup metadata only.
"""

from __future__ import annotations

import json
from typing import Any

from app.services.agent_bridge.errors import BridgeProtocolError
from app.services.agent_bridge.protocol import ServerEvent
from app.services.agent_run_state import (
    append_agent_run_event,
    list_agent_run_events,
)


def _dedup_key(host_event_id: str | None, event_type: str) -> str:
    return f"{host_event_id or ''}|{event_type}"


async def append_standard_event(
    *,
    run_id: str,
    event_type: str,
    payload: dict[str, Any],
    host_event_id: str | None = None,
) -> dict[str, Any]:
    """Append one standard lifecycle event; dedups repeated host IDs."""
    if host_event_id:
        recent = await list_agent_run_events(
            run_id,
            after_sequence=max(0, int(payload.get("_sinceSeq") or 0)),
            limit=1000,
        )
        key = _dedup_key(host_event_id, event_type)
        for existing in recent:
            existing_payload = existing.get("payload") or {}
            if (
                str(existing_payload.get("hostEventId") or "") == host_event_id
                and str(existing.get("type") or "") == event_type
            ):
                return existing
    stored = await append_agent_run_event(
        run_id,
        event_type=event_type,
        payload={**payload, "hostEventId": host_event_id} if host_event_id else payload,
    )
    return stored


LEGACY_EVENT_TYPE_MAP: dict[str, str] = {
    # 既有 Pi/投影链路写入的历史事件名 → v1 标准事件。
    "run.started": "run.attached",
    "run.turn_finished": "agent.message.completed",
    "skill.selected": "control.followup",
    "operation.proposed": "operation.proposed",
    "operation.started": "operation.started",
    "operation.completed": "operation.completed",
    "operation.failed": "operation.failed",
    "message.delta": "agent.message.delta",
}


def to_server_event(row: dict[str, Any]) -> dict[str, Any]:
    """Render one persisted event row as a wire-format server event."""
    raw_type = str(row.get("type") or "")
    mapped = LEGACY_EVENT_TYPE_MAP.get(raw_type, raw_type)
    if mapped not in ServerEvent.model_fields["type"].annotation.__args__:
        mapped = "control.followup"
    event = ServerEvent(
        v=1,
        type=mapped,
        runId=str(row.get("run_id") or ""),
        seq=int(row.get("sequence") or 0),
        payload=row.get("payload") if isinstance(row.get("payload"), dict) else {},
    )
    return json.loads(event.model_dump_json(by_alias=True, exclude_none=True))


async def follow_events(
    *,
    run_id: str,
    after_seq: int = 0,
    limit: int = 100,
) -> dict[str, Any]:
    """Return events strictly after the cursor plus the next cursor."""
    rows = await list_agent_run_events(
        run_id,
        after_sequence=after_seq,
        limit=limit,
    )
    events = [to_server_event(row) for row in rows]
    next_cursor = int(events[-1]["seq"]) if events else int(after_seq)
    return {"events": events, "nextCursor": next_cursor}


__all__ = [
    "append_standard_event",
    "follow_events",
    "to_server_event",
]
