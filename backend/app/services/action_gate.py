"""ActionGate: the single place an Agent write goes through.

* reads and ordinary writes run directly; every write lands on the timeline
  (``agent_actions``) with the rows it touched (services/change_capture.py),
  so any of them can be undone;
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
from app.services.change_capture import capture, changed_since, current_rows, restore, to_undo
from app.services.operation_tiers import LOCAL_FILE_READS, needs_confirmation
from app.run_options import current_run_options

PENDING_MESSAGE = "这一步不可撤销，已放进待确认列表请用户确认；不用等，先继续做别的。"
ASK_MODE_MESSAGE = "用户选了询问模式，这一步已放进待确认列表请用户确认；不用等，先继续做别的。"


def _view(row: AgentAction) -> dict[str, Any]:
    return {
        "id": row.id,
        "run_id": row.run_id,
        "operation": row.operation,
        "args": row.args_json or {},
        "summary": row.summary,
        "status": row.status,
        "result": row.result_json or {},
        "undoable": bool((row.undo_json or {}).get("changes")) and row.status == "done",
        "not_undoable_reason": (row.result_json or {}).get("not_undoable", ""),
        "created_at": row.created_at.isoformat() if row.created_at else None,
        "decided_at": row.decided_at.isoformat() if row.decided_at else None,
    }


def _brief(result: dict[str, Any]) -> dict[str, Any]:
    return {"ok": bool(result.get("ok")), "errors": list(result.get("errors") or [])[:3]}


async def _record(**fields: Any) -> AgentAction:
    async with async_session() as db:
        row = AgentAction(id="act_" + uuid.uuid4().hex[:24], **fields)
        db.add(row)
        await db.commit()
        await db.refresh(row)
        return row


async def _approved_before(name: str, inputs: dict[str, Any]) -> bool:
    """The user already allowed exactly this read (the Agent retries after the OK)."""
    async with async_session() as db:
        rows = (await db.execute(select(AgentAction.args_json).where(
            AgentAction.operation == name, AgentAction.status == "done"))).scalars().all()
    return any((row or {}) == inputs for row in rows)


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

    reads_file = name in LOCAL_FILE_READS
    irreversible = needs_confirmation(name, op.tier, inputs)
    if irreversible or current_run_options().approval_mode == "ask":
        if reads_file and await _approved_before(name, inputs):
            with confirmed_action(name):
                return await execute_operation(name, inputs, surface=surface)
        preview = await execute_operation(name, inputs, dry_run=True, surface=surface)
        if not preview.get("ok"):
            return preview
        row = await _record(run_id=run_id, operation=name, args_json=inputs,
                            summary=summary, status="pending", delivered=False)
        return {
            "ok": True,
            "operation": name,
            "outputs": {"executed": False, "pending_action": _view(row),
                        "message": PENDING_MESSAGE if irreversible else ASK_MODE_MESSAGE},
            "warnings": [],
            "errors": [],
        }

    # External Agents call through the CLI without a Run; their writes still land
    # on the timeline so the user can undo them. Other run-less callers and reads don't.
    if reads_file or (not run_id and surface != "cli"):
        return await execute_operation(name, inputs, surface=surface)
    with capture() as cap:
        result = await execute_operation(name, inputs, surface=surface)
    if result.get("ok"):
        changes = to_undo(cap)
        undo = {"changes": changes, "after": await current_rows(changes)} if changes and not cap.lossy else {}
        brief = {**_brief(result), **({"not_undoable": cap.lossy} if cap.lossy else {})}
        await _record(run_id=run_id, operation=name, args_json=inputs, summary=summary,
                      status="done", result_json=brief, undo_json=undo)
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


async def undo_preview(action_id: str) -> dict[str, Any]:
    """Was the target changed after the Agent's write? Then undo also overwrites those edits."""
    async with async_session() as db:
        row = await _load(db, action_id)
        if row.status != "done" or not row.undo_json:
            raise ValueError("这条操作不能撤销。")
        undo = dict(row.undo_json)
    changed = await changed_since(undo["changes"], undo["after"])
    return {
        "changed_after": changed,
        "message": "Agent 改完之后这里又被改过。撤销会恢复到 Agent 改之前，之后的修改也会一起被盖掉。" if changed else "",
    }


async def undo_action(action_id: str) -> dict[str, Any]:
    async with async_session() as db:
        row = await _load(db, action_id)
        if row.status != "done" or not row.undo_json:
            raise ValueError("这条操作不能撤销。")
        changes = list((row.undo_json or {}).get("changes") or [])
    await restore(changes)
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
                 + ("，用同样的参数再调用一次即可读到内容" if row.status == "done" and row.operation in LOCAL_FILE_READS else "")
                 + (f" 错误：{'; '.join(row.result_json.get('errors') or [])}" if row.status == "failed" else "")
                 for row in rows]
        for row in rows:
            row.delivered = True
        await db.commit()
    return ("自上一轮以来用户对你的操作做了这些决定：\n" + "\n".join(lines)) if lines else ""
