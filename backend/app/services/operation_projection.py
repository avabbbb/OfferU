from __future__ import annotations

from typing import Any

from app.ops import OPERATIONS, execute_operation
from app.services.agent_run_coordinator import AgentRunCoordinator
from app.services.agent_run_state import (
    create_agent_run,
    load_agent_run,
)


async def execute_or_propose_operation(
    name: str,
    args: dict[str, Any] | None = None,
    *,
    surface: str,
    dry_run: bool = False,
    conversation_id: str = "",
) -> dict[str, Any]:
    """Execute a read or persist one confirmation proposal for a mutation."""

    operation = OPERATIONS.get(name)
    inputs = args or {}
    if operation is None or not operation.is_mutation or dry_run:
        return await execute_operation(
            name,
            inputs,
            dry_run=dry_run,
            surface=surface,
        )

    preview = await execute_operation(
        name,
        inputs,
        dry_run=True,
        surface=surface,
    )
    if not preview.get("ok"):
        return preview

    action_id = f"{name}:1"
    run = await create_agent_run(
        conversation_id=conversation_id,
        goal=f"Execute OfferU Operation {name}",
        mode="operation_projection",
        skill_id="operation_registry",
        actions=[
            {
                "id": action_id,
                "tool": name,
                "args": preview.get("inputs") or inputs,
                "summary": operation.description,
                "risk_level": "confirm",
                "requires_confirmation": True,
            }
        ],
        exit_criteria=[f"{name} completed exactly once or failed visibly"],
        llm_runtime={"runtime": "none", "reason": "deterministic_operation_proposal"},
    )
    step = run["steps"][0]
    return {
        **preview,
        "outputs": {
            "executed": False,
            "requires_confirmation": True,
            "proposal": {
                "run_id": run["id"],
                "task_id": run["task_id"],
                "action_id": step["id"],
                "idempotency_key": step["idempotency_key"],
                "operation": step["tool"],
                "args": step["args"],
                "status": step["status"],
            },
        },
        "warnings": [
            "副作用尚未执行；提案已持久化，必须通过独立确认调用执行。",
        ],
    }


async def confirm_operation_proposal(
    run_id: str,
    *,
    surface: str,
    action_id: str = "",
) -> dict[str, Any]:
    """Execute one persisted proposal through the Registry authorization boundary."""

    run = await load_agent_run(run_id)
    if run is None:
        return {"ok": False, "errors": [f"Agent Run {run_id} 不存在。"]}
    recoverable = [
        {
            "id": str(step.get("id") or ""),
            "tool": str(step.get("tool") or ""),
            "args": step.get("args") if isinstance(step.get("args"), dict) else {},
        }
        for step in (run.get("steps") or [])
        if isinstance(step, dict)
        and step.get("status") in {"waiting_confirmation", "executing"}
    ]
    selected = next(
        (
            item
            for item in recoverable
            if not action_id or str(item.get("id") or "") == action_id
        ),
        None,
    )
    if selected is None:
        if run.get("status") == "completed":
            return {
                "ok": True,
                "run": run,
                "tool_calls": [],
                "warnings": ["该提案已完成；没有重放副作用。"],
            }
        return {
            "ok": False,
            "run": run,
            "errors": ["没有找到匹配的待确认动作。"],
        }

    async def registry_runner(operation: str, inputs: dict[str, Any]) -> Any:
        result = await execute_operation(
            operation,
            inputs,
            surface=surface,
        )
        if result.get("ok"):
            return result
        return {
            "error": "; ".join(str(item) for item in result.get("errors") or [])
            or f"{operation} failed",
            "operation_result": result,
        }

    execution = await AgentRunCoordinator().execute_confirmed(
        run=run,
        confirmed_action_ids=[str(selected["id"])],
        tool_runner=registry_runner,
    )
    failed = any(
        isinstance(call.get("result"), dict) and call["result"].get("error")
        for call in execution["tool_calls"]
        if isinstance(call, dict)
    )
    return {
        "ok": not failed and execution["run"].get("status") == "completed",
        **execution,
        "errors": (
            [
                str(call["result"]["error"])
                for call in execution["tool_calls"]
                if isinstance(call, dict)
                and isinstance(call.get("result"), dict)
                and call["result"].get("error")
            ]
            if failed
            else []
        ),
    }
