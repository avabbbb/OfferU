"""ActionGate: the single place an Agent write goes through.

* reads and ordinary writes run directly; every write lands on the timeline
  (``agent_actions``), resume writes get a snapshot so they can be undone;
* irreversible writes (operation_tiers.needs_confirmation) are queued as a
  ``pending`` action and the Agent is told to carry on. The Run never waits:
  the user confirms later, the action runs then, and the outcome is handed to
  the Agent on its next turn.

Human UI surfaces never come through here; a click is already a decision.
"""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import select

from app.database import async_session
from app.models.models import AgentAction, AgentRunRecord
from app.ops import OPERATIONS, confirmed_action, execute_operation
from app.services.operation_tiers import needs_confirmation

PENDING_MESSAGE = "这一步不可撤销，已放进待确认列表请用户确认；不用等，先继续做别的。"


def _view(row: AgentAction) -> dict[str, Any]:
    return {
        "id": row.id,
        "run_id": row.run_id,
        "operation": row.operation,
        "args": row.args_json or {},
        "summary": row.summary,
        "status": row.status,
        "result": row.result_json or {},
        "undoable": bool(row.undo_json) and row.status == "done",
        "created_at": row.created_at.isoformat() if row.created_at else None,
        "decided_at": row.decided_at.isoformat() if row.decided_at else None,
    }


def _brief(result: dict[str, Any]) -> dict[str, Any]:
    return {"ok": bool(result.get("ok")), "errors": list(result.get("errors") or [])[:3]}


async def _snapshot_resume(resume_id: int, summary: str) -> dict[str, Any]:
    from app.services.resume_route_operations import _get_resume
    from app.services.resume_versions import create_version_snapshot

    async with async_session() as db:
        resume = await _get_resume(db, resume_id, load_sections=True)
        version = await create_version_snapshot(
            db, resume, change_summary=f"Agent 改动前：{summary}"[:200], created_by="agent"
        )
        await db.commit()
        return {
            "operation": "restore_resume_version_record",
            "args": {"resume_id": resume_id, "version_id": int(version.id)},
        }


def _undo_after(name: str, result: dict[str, Any]) -> dict[str, Any]:
    outputs = result.get("outputs") if isinstance(result.get("outputs"), dict) else {}
    if name == "save_profile_resume_import" and outputs.get("session_id"):
        return {"operation": "undo_profile_resume_import", "args": {"session_id": int(outputs["session_id"])}}
    return {}


async def _record(**fields: Any) -> AgentAction:
    async with async_session() as db:
        row = AgentAction(id="act_" + uuid.uuid4().hex[:24], **fields)
        db.add(row)
        await db.commit()
        await db.refresh(row)
        return row


async def run_gated_operation(
    name: str,
    args: dict[str, Any] | None = None,
    *,
    surface: str,
    run_id: str = "",
    dry_run: bool = False,
) -> dict[str, Any]:
    inputs = args if isinstance(args, dict) else {}
    op = OPERATIONS.get(name)
    if op is None or dry_run or not op.is_mutation:
        return await execute_operation(name, inputs, dry_run=dry_run, surface=surface)
    summary = op.description or name

    if needs_confirmation(name, op.tier, inputs):
        preview = await execute_operation(name, inputs, dry_run=True, surface=surface)
        if not preview.get("ok"):
            return preview
        row = await _record(run_id=run_id, operation=name, args_json=inputs,
                            summary=summary, status="pending", delivered=False)
        return {
            "ok": True,
            "operation": name,
            "outputs": {"executed": False, "pending_action": _view(row), "message": PENDING_MESSAGE},
            "warnings": [],
            "errors": [],
        }

    if not run_id:  # a UI click or an unattached CLI call: no Agent timeline
        return await execute_operation(name, inputs, surface=surface)
    undo: dict[str, Any] = {}
    resume_id = inputs.get("resume_id")
    if op.group == "resume" and isinstance(resume_id, int) and resume_id > 0:
        undo = await _snapshot_resume(resume_id, summary)
    result = await execute_operation(name, inputs, surface=surface)
    if result.get("ok"):
        undo = _undo_after(name, result) or undo
        await _record(run_id=run_id, operation=name, args_json=inputs, summary=summary,
                      status="done", result_json=_brief(result), undo_json=undo)
    return result


async def list_actions(*, run_id: str = "", status: str = "", limit: int = 100) -> list[dict[str, Any]]:
    async with async_session() as db:
        query = select(AgentAction).order_by(AgentAction.created_at.desc()).limit(max(1, min(limit, 500)))
        if run_id:
            query = query.where(AgentAction.run_id == run_id)
        if status:
            query = query.where(AgentAction.status == status)
        rows = (await db.execute(query)).scalars().all()
        return [_view(row) for row in rows]


async def _load(db, action_id: str) -> AgentAction:  # noqa: ANN001
    row = await db.get(AgentAction, action_id)
    if row is None:
        raise ValueError("这条操作不存在。")
    return row


async def _finish(action_id: str, *, status: str, result: dict[str, Any] | None = None,
                  undelivered: bool = False) -> dict[str, Any]:
    async with async_session() as db:
        row = await _load(db, action_id)
        row.status = status
        if result is not None:
            row.result_json = _brief(result)
        row.decided_at = datetime.utcnow()
        if undelivered:
            row.delivered = False
        await db.commit()
        await db.refresh(row)
        return _view(row)


async def confirm_action(action_id: str) -> dict[str, Any]:
    async with async_session() as db:
        row = await _load(db, action_id)
        if row.status != "pending":
            raise ValueError("这条操作已经处理过了。")
        name, args = row.operation, dict(row.args_json or {})
    with confirmed_action(name):
        result = await execute_operation(name, args, surface="agent")
    action = await _finish(action_id, status="done" if result.get("ok") else "failed", result=result)
    return {"ok": bool(result.get("ok")), "action": action, "result": result}


async def reject_action(action_id: str) -> dict[str, Any]:
    async with async_session() as db:
        row = await _load(db, action_id)
        if row.status != "pending":
            raise ValueError("这条操作已经处理过了。")
    return {"ok": True, "action": await _finish(action_id, status="rejected")}


async def undo_action(action_id: str) -> dict[str, Any]:
    async with async_session() as db:
        row = await _load(db, action_id)
        if row.status != "done" or not row.undo_json:
            raise ValueError("这条操作不能撤销。")
        undo = dict(row.undo_json)
    result = await execute_operation(undo["operation"], undo["args"], surface="ui")
    if not result.get("ok"):
        return {"ok": False, "errors": result.get("errors") or ["撤销失败"]}
    return {"ok": True, "action": await _finish(action_id, status="undone", undelivered=True)}


async def take_decisions_for_agent(run_id: str, conversation_id: str = "") -> str:
    """User decisions the Agent has not heard about yet, as one note.

    A follow-up message usually starts a new Run in the same conversation, so
    decisions on any Run of that conversation are reported."""

    if not run_id:
        return ""
    async with async_session() as db:
        run_ids = select(AgentRunRecord.run_id).where(AgentRunRecord.conversation_id == conversation_id) \
            if conversation_id else select(AgentRunRecord.run_id).where(AgentRunRecord.run_id == run_id)
        rows = (await db.execute(
            select(AgentAction).where(
                (AgentAction.run_id == run_id) | AgentAction.run_id.in_(run_ids),
                AgentAction.delivered.is_(False),
                AgentAction.status != "pending",
            ).order_by(AgentAction.decided_at)
        )).scalars().all()
        labels = {"done": "已确认并执行", "failed": "已确认但执行失败", "rejected": "用户拒绝了",
                  "undone": "用户撤销了"}
        lines = [f"- {labels.get(row.status, row.status)}：{row.summary}（{row.operation}）"
                 + (f" 错误：{'; '.join(row.result_json.get('errors') or [])}" if row.status == "failed" else "")
                 for row in rows]
        for row in rows:
            row.delivered = True
        await db.commit()
    return ("自上一轮以来用户对你的操作做了这些决定：\n" + "\n".join(lines)) if lines else ""
