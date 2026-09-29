from __future__ import annotations

import uuid
from collections.abc import Callable
from typing import Any


def install_synthetic_pi_run_provider(
    monkeypatch: Any,
    low_level_factory: Callable[..., Any],
) -> list[Any]:
    """Adapt existing synthetic Agent turns to the current Pi Run contract.

    Career Director tests must never launch the developer's real embedded
    runtime. The low-level fake still exercises its Registry reads; only the
    Pi/Main Agent boundary and durable-run event projection are synthesized.
    """

    import app.services.agent_run_state as agent_run_state
    import app.services.agent_runtime as agent_runtime
    import app.services.pi_agent_host as pi_agent_host
    import app.ops as ops

    run_events: dict[str, list[dict[str, Any]]] = {}
    providers: list[Any] = []

    async def on_operation(name: str, arguments: dict[str, Any] | None = None) -> dict[str, Any]:
        result = await ops.execute_operation(
            name,
            arguments if isinstance(arguments, dict) else {},
            surface="career_director",
            audit=True,
        )
        if not isinstance(result, dict) or not result.get("ok"):
            errors = result.get("errors") if isinstance(result, dict) else None
            raise RuntimeError("; ".join(str(item) for item in errors or []) or name)
        outputs = result.get("outputs")
        return outputs if isinstance(outputs, dict) else {}

    class SyntheticPiRunProvider:
        async def status(self) -> dict[str, Any]:
            return {"provider_id": "pi", "available": True, "status": "ready"}

        async def start_run(self, **kwargs: Any) -> dict[str, Any]:
            provider = low_level_factory(
                "pi",
                on_operation=on_operation,
            )
            providers.append(provider)
            await provider.start()
            await provider.create_thread(cwd="", tool_descriptions=[])
            legacy_result = await provider.start_turn(
                prompt=str(kwargs.get("message") or ""),
                cwd="",
            )
            legacy_events = await provider.events()
            events = legacy_events.get("events") if isinstance(legacy_events, dict) else []
            names: list[str] = []
            for event in events if isinstance(events, list) else []:
                if not isinstance(event, dict) or event.get("method") != "item/tool/call":
                    continue
                params = event.get("params") if isinstance(event.get("params"), dict) else {}
                operation = str(params.get("tool") or "").strip()
                if operation:
                    names.append(operation)

            completed = legacy_result.get("completed") if isinstance(legacy_result, dict) else None
            turn = completed.get("turn") if isinstance(completed, dict) else None
            items = turn.get("items") if isinstance(turn, dict) else []
            assistant_message = ""
            for item in reversed(items if isinstance(items, list) else []):
                if (
                    isinstance(item, dict)
                    and item.get("type") == "agentMessage"
                    and isinstance(item.get("text"), str)
                ):
                    assistant_message = item["text"].strip()
                    break
            run_id = f"synthetic-pi-{uuid.uuid4().hex}"
            run_events[run_id] = [
                {"type": "operation.completed", "payload": {"operation": name}}
                for name in names
            ]
            return {
                "run": {
                    "id": run_id,
                    "llm_runtime": {"session_id": str(kwargs.get("conversation_id") or "")},
                },
                "assistant_message": assistant_message,
                "conversation_id": str(kwargs.get("conversation_id") or ""),
            }

    async def list_synthetic_run_events(run_id: str, **_kwargs: Any) -> list[dict[str, Any]]:
        return list(run_events.get(str(run_id), []))

    monkeypatch.setattr(
        agent_runtime,
        "get_agent_run_provider",
        lambda _provider_id="pi": SyntheticPiRunProvider(),
    )
    monkeypatch.setattr(agent_run_state, "list_agent_run_events", list_synthetic_run_events)
    monkeypatch.setattr(
        pi_agent_host,
        "resolve_pi_provider_config",
        lambda: {"name": "synthetic", "model": "synthetic", "api_key": "test-only"},
    )
    return providers
