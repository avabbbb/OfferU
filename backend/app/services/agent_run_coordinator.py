from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Awaitable, Callable

from app.services.agent_run_state import pending_actions_for_run, safe_result_preview, save_agent_run
from app.services.security_redaction import safe_error_message

ToolRunner = Callable[[str, dict[str, Any]], Awaitable[Any]]


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


class AgentRunCoordinator:
    """Durable boundary between a confirmed plan and business side effects.

    Each step is checkpointed before and after execution. If the process dies
    while a step is ``executing``, the next confirmation marks it uncertain and
    refuses automatic replay instead of risking a duplicate write.
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

        for step in run.get("steps") or []:
            if not isinstance(step, dict) or str(step.get("id") or "") not in confirmed:
                continue
            if step.get("status") == "executing":
                uncertain = True
                message = (
                    "该动作上次在执行中断开，副作用是否完成无法确认；"
                    "为防止重复写入，系统没有自动重放。请先核对业务数据。"
                )
                step["status"] = "uncertain"
                step["error"] = message
                calls.append(self._call(step, {"error": message, "idempotency_key": step.get("idempotency_key")}))
                run["status"] = "needs_reconciliation"
                await save_agent_run(
                    run,
                    event_type="operation.failed",
                    event_payload={
                        "action_id": step.get("id"),
                        "operation": step.get("tool"),
                        "status": "uncertain",
                        "error": message,
                    },
                )
                break
            if step.get("status") != "waiting_confirmation":
                continue

            run["status"] = "executing"
            step["status"] = "executing"
            step["attempts"] = int(step.get("attempts") or 0) + 1
            step["started_at"] = _now_iso()
            step["error"] = None
            await save_agent_run(
                run,
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
            await save_agent_run(
                run,
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

        statuses = {str(step.get("status") or "") for step in run.get("steps") or [] if isinstance(step, dict)}
        if uncertain or "uncertain" in statuses:
            run["status"] = "needs_reconciliation"
        elif "failed" in statuses:
            run["status"] = "failed"
        elif statuses and statuses.issubset({"completed"}):
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

    @staticmethod
    def _call(step: dict[str, Any], result: Any) -> dict[str, Any]:
        return {
            "tool": str(step.get("tool") or ""),
            "args": step.get("args") if isinstance(step.get("args"), dict) else {},
            "result": result,
            "action_id": str(step.get("id") or ""),
        }
