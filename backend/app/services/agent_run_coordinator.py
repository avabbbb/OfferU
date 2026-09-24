from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Awaitable, Callable

from sqlalchemy import update

from app.database import async_session
from app.models.models import AgentRunRecord
from app.services.agent_run_state import (
    load_agent_run,
    pending_actions_for_run,
    safe_result_preview,
    save_agent_run,
)
from app.services.security_redaction import safe_error_message

ToolRunner = Callable[[str, dict[str, Any]], Awaitable[Any]]

_WAITING_CONFIRMATION = "waiting_confirmation"
_EXECUTING = "executing"

# 本进程正在执行中的步骤（run_id, step_id）。用于区分「另一个并发确认
# 正在活着执行该步骤」（跳过、等待其写回最终状态）和「执行者已崩溃的
# 残留 executing」（标 uncertain、拒绝自动重放）。
_INFLIGHT_STEPS: set[tuple[str, str]] = set()


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


async def _claim_step_for_execution(
    *,
    run_id: str,
    step_index: int,
    expected_steps: list[Any],
    updated_steps: list[Any],
    run_status: str,
) -> bool:
    """Atomically transition one ``waiting_confirmation`` step to ``executing``.

    The single conditional UPDATE is the execution lease: two concurrent
    confirmations of the same step cannot both execute it, because after
    the first claim commits the loser's WHERE clause no longer matches and
    its UPDATE reports 0 rows. Comparing the complete steps snapshot also
    prevents concurrent decisions for sibling actions from erasing one another.
    """
    async with async_session() as db:
        result = await db.execute(
            update(AgentRunRecord)
            .where(AgentRunRecord.run_id == run_id)
            .where(AgentRunRecord.steps_json == expected_steps)
            .where(
                AgentRunRecord.steps_json[step_index]["status"]
                .as_string()
                == _WAITING_CONFIRMATION
            )
            .values(steps_json=updated_steps, status=run_status)
        )
        claimed = int(result.rowcount or 0) == 1
        await db.commit()
        return claimed


def _replay_owned_steps(
    run: dict[str, Any],
    owned_steps: dict[str, dict[str, Any]],
) -> list[Any]:
    """Replace same-id steps in the freshly loaded run with this request's own."""
    steps: list[Any] = []
    for step in run.get("steps") or []:
        if isinstance(step, dict):
            owned = owned_steps.get(str(step.get("id") or ""))
            if owned is not None:
                steps.append(owned)
                continue
        steps.append(step)
    run["steps"] = steps
    return steps


class AgentRunCoordinator:
    """Durable boundary between a confirmed plan and business side effects.

    Each step is claimed through an atomic conditional UPDATE
    (``waiting_confirmation`` -> ``executing``) before its tool runs, so a
    duplicate concurrent confirmation can never execute the same step twice.
    The step is checkpointed again after execution. If the process dies
    while a step is ``executing``, the next confirmation marks it uncertain
    and refuses automatic replay instead of risking a duplicate write.
    """

    async def execute_confirmed(
        self,
        *,
        run: dict[str, Any],
        confirmed_action_ids: list[str],
        tool_runner: ToolRunner,
    ) -> dict[str, Any]:
        confirmed = {str(item) for item in confirmed_action_ids if str(item)}
        calls: list[dict[str, Any]] = []
        uncertain = False
        run_id = str(run.get("id") or "")
        # Steps whose execution lease this request won. Every durable write
        # starts from the latest DB state and replays only these owned
        # steps, so concurrent confirmations of *other* steps are never
        # clobbered by a stale full-run overwrite.
        owned_steps: dict[str, dict[str, Any]] = {}

        step_ids = [
            str(step.get("id") or "")
            for step in (run.get("steps") or [])
            if isinstance(step, dict) and str(step.get("id") or "") in confirmed
        ]

        for step_id in step_ids:
            # Re-read the latest persisted state before touching each step,
            # instead of trusting the caller's possibly stale snapshot.
            latest = await load_agent_run(run_id) if run_id else None
            if latest is not None:
                run = latest
            steps = [
                dict(step) if isinstance(step, dict) else step
                for step in (run.get("steps") or [])
            ]
            for step in steps:
                if not isinstance(step, dict):
                    continue
                owned = owned_steps.get(str(step.get("id") or ""))
                if owned is not None:
                    step.clear()
                    step.update(owned)
            run["steps"] = steps

            index = next(
                (
                    i
                    for i, step in enumerate(steps)
                    if isinstance(step, dict) and str(step.get("id") or "") == step_id
                ),
                None,
            )
            if index is None:
                continue
            step = steps[index]
            status = str(step.get("status") or "")

            if status == _EXECUTING:
                if (run_id, step_id) in _INFLIGHT_STEPS:
                    # 另一个并发确认正在本进程执行该步骤：既不重复执行，
                    # 也不误标 uncertain；执行方完成后会写回最终状态。
                    continue
                uncertain = True
                message = (
                    "该动作上次在执行中断开，副作用是否完成无法确认；"
                    "为防止重复写入，系统没有自动重放。请先核对业务数据。"
                )
                step["status"] = "uncertain"
                step["error"] = message
                calls.append(self._call(step, {"error": message, "idempotency_key": step.get("idempotency_key")}))
                owned_steps[str(step.get("id") or "")] = step
                run = await self._merge_and_save(
                    run,
                    run_id=run_id,
                    owned_steps=owned_steps,
                    status="needs_reconciliation",
                    event_type="operation.failed",
                    event_payload={
                        "action_id": step.get("id"),
                        "operation": step.get("tool"),
                        "status": "uncertain",
                        "error": message,
                    },
                )
                break

            if status != _WAITING_CONFIRMATION:
                continue

            expected_steps = [dict(item) if isinstance(item, dict) else item for item in steps]
            step["status"] = _EXECUTING
            step["attempts"] = int(step.get("attempts") or 0) + 1
            step["started_at"] = _now_iso()
            step["error"] = None
            claimed = run_id != "" and await _claim_step_for_execution(
                run_id=run_id,
                step_index=index,
                expected_steps=expected_steps,
                updated_steps=steps,
                run_status=_EXECUTING,
            )
            if not claimed:
                # Another concurrent confirmation already claimed this step
                # (0 rows updated); skip it and never duplicate its side
                # effects.
                continue

            owned_steps[str(step.get("id") or "")] = step
            inflight_key = (run_id, str(step.get("id") or ""))
            _INFLIGHT_STEPS.add(inflight_key)
            try:
                run = await self._merge_and_save(
                    run,
                    run_id=run_id,
                    owned_steps=owned_steps,
                    status=_EXECUTING,
                    event_type="operation.started",
                    event_payload={
                        "action_id": step.get("id"),
                        "operation": step.get("tool"),
                        "idempotency_key": step.get("idempotency_key"),
                    },
                )

                args = step.get("args") if isinstance(step.get("args"), dict) else {}
                try:
                    from app.ops import confirmed_operation

                    with confirmed_operation(
                        operation=str(step.get("tool") or ""),
                        run_id=str(run.get("id") or ""),
                        action_id=str(step.get("id") or ""),
                        idempotency_key=str(step.get("idempotency_key") or ""),
                    ):
                        result = await tool_runner(str(step.get("tool") or ""), args)
                except Exception as exc:
                    result = {"error": safe_error_message(exc)}
                has_error = isinstance(result, dict) and bool(result.get("error"))
                step["status"] = "failed" if has_error else "completed"
                step["completed_at"] = _now_iso()
                step["result"] = safe_result_preview(result)
                step["error"] = str(result.get("error"))[:500] if has_error else None
                calls.append(self._call(step, result))
                run = await self._merge_and_save(
                    run,
                    run_id=run_id,
                    owned_steps=owned_steps,
                    status=_EXECUTING,
                    event_type=(
                        "operation.failed" if has_error else "operation.completed"
                    ),
                    event_payload={
                        "action_id": step.get("id"),
                        "operation": step.get("tool"),
                        "result": safe_result_preview(result),
                        "error": step.get("error"),
                    },
                )
                if has_error:
                    break
            finally:
                _INFLIGHT_STEPS.discard(inflight_key)

        latest = await load_agent_run(run_id) if run_id else None
        if latest is not None:
            run = latest
        steps = _replay_owned_steps(run, owned_steps)
        statuses = {
            str(step.get("status") or "")
            for step in steps
            if isinstance(step, dict)
        }
        if uncertain or "uncertain" in statuses:
            run["status"] = "needs_reconciliation"
        elif "failed" in statuses:
            run["status"] = "failed"
        elif statuses and statuses.issubset({"completed", "rejected"}):
            run["status"] = "completed"
        elif "waiting_confirmation" in statuses:
            run["status"] = "waiting_confirmation"
        else:
            run["status"] = "executing"
        run = await save_agent_run(run)
        return {
            "run": run,
            "tool_calls": calls,
            "pending_actions": pending_actions_for_run(run),
            "uncertain": uncertain,
        }

    async def _merge_and_save(
        self,
        run: dict[str, Any],
        *,
        run_id: str,
        owned_steps: dict[str, dict[str, Any]],
        status: str = "",
        event_type: str = "",
        event_payload: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        """Persist starting from the latest DB row, replaying only owned steps.

        Writing the whole local snapshot back would erase states committed
        concurrently for other steps, so each save re-reads the row first.
        """
        latest = await load_agent_run(run_id) if run_id else None
        if latest is not None:
            run = latest
        _replay_owned_steps(run, owned_steps)
        if status:
            run["status"] = status
        return await save_agent_run(
            run,
            event_type=event_type,
            event_payload=event_payload,
        )

    @staticmethod
    def _call(step: dict[str, Any], result: Any) -> dict[str, Any]:
        return {
            "tool": str(step.get("tool") or ""),
            "args": step.get("args") if isinstance(step.get("args"), dict) else {},
            "result": result,
            "action_id": str(step.get("id") or ""),
        }
