from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any, Awaitable, Callable

from app.agents.llm import resolve_llm_client_config, resolve_model_for_tier
from app.config import Settings, get_settings
from app.core import agent as core_agent
from app.services.agent_run_state import (
    answer_agent_input_request,
    append_agent_run_event,
    consume_agent_input_request,
    create_agent_input_request,
    create_agent_run,
    expire_pending_agent_input_requests,
    list_agent_run_events,
    list_pending_agent_input_requests,
    load_agent_run,
    save_agent_run,
)
from app.services.action_gate import list_actions, take_decisions_for_agent
from app.services.embedded_agent_worker import (
    PROTOCOL_VERSION,
    EmbeddedAgentConcurrencyError,
    EmbeddedAgentWorker,
    EmbeddedAgentWorkerError,
    ensure_embedded_agent_capacity,
    find_embedded_agent_worker,
    get_embedded_agent_worker,
    release_embedded_agent_worker,
)
from app.services.security_redaction import safe_error_message
from app.runtime_paths import runtime_data_path


_EVENT_TYPES = {
    "tool.started": "runtime.tool_started",
    "tool.progress": "runtime.tool_progress",
    "tool.completed": "runtime.tool_completed",
    "kernel.agent_start": "runtime.agent_started",
    "kernel.agent_end": "runtime.agent_settled",
    "kernel.turn_start": "runtime.turn_started",
    "kernel.turn_end": "runtime.turn_completed",
    "kernel.compaction_start": "runtime.compaction_started",
    "kernel.compaction_end": "runtime.compaction_completed",
    "message.delta": "message.delta",
    "run.started": "runtime.session_started",
    "run.aborted": "runtime.aborted",
    "run.disposed": "runtime.disposed",
    "runtime.fatal": "runtime.failed",
}
_SESSION_DIRECTORY = runtime_data_path("python_agent_sessions")
StreamListener = Callable[[dict[str, Any]], Awaitable[None]]
_CONTINUATION_LOCKS: dict[str, asyncio.Lock] = {}

def resolve_embedded_provider_config(
    settings: Settings | None = None,
) -> tuple[dict[str, Any], dict[str, Any]]:
    """Resolve the active OpenAI-compatible provider without persisting its key.

    BYOK 统一解析（见 app/agents/llm.resolve_llm_client_config）：
    provider 可自由配置，base_url / api_key / model 来自激活配置；
    provider_id 不参与行为分支。
    """
    config = settings or get_settings()
    resolved = resolve_llm_client_config(config)
    model = resolve_model_for_tier("standard", config)

    private = {
        "name": resolved["provider"],
        "model": model,
        "base_url": resolved["base_url"],
        "api_key": resolved["api_key"],
    }
    public = {
        "runtime": "python_agent",
        "provider_id": "embedded",
        "protocol_version": PROTOCOL_VERSION,
        "provider": resolved["provider"],
        "model": model,
        "source": resolved["source"],
    }
    return private, public

_SKILL_ID = "offeru"  # 内置助手只有一套 core 工具，不再按 Skill 路由


def _system_prompt() -> str:
    return core_agent.system_prompt() + "\n缺少只有用户能定的偏好或取舍时，用 request_user_input 问一句。"


def _prompt_with_context(
    goal: str,
    context_messages: list[dict[str, str]] | None,
) -> str:
    rows: list[str] = []
    for item in (context_messages or [])[-12:]:
        role = str(item.get("role") or "").strip()
        content = str(item.get("content") or "").strip()
        if role not in {"user", "assistant"} or not content:
            continue
        rows.append(f"{role}: {content[:2000]}")
    if not rows:
        return goal
    context = "\n".join(rows)
    return (
        "Prior task conversation (context only; Operation results remain the source "
        f"of truth):\n{context[:10_000]}\n\nCurrent user request:\n{goal}"
    )


def _finish_trace(trace_obj, run, terminal_state, stop_reason, turns=None, error=""):
    """把本次 Run 的终态、模型、实际轮数写进 trace 文件（隔离目录，见 core.trace）。"""
    runtime = (run or {}).get("llm_runtime") or {}
    trace_obj.update(model=str(runtime.get("model") or ""),
                     provider=str(runtime.get("provider") or runtime.get("service_name") or ""),
                     steps_used=turns)
    trace_obj.finish(terminal_state, stop_reason=stop_reason, error=error)


async def _fail_run(run_id: str, error: Exception) -> dict[str, Any]:
    run = await load_agent_run(run_id)
    if run is None:
        raise error
    # A pending Ask can never outlive its turn: expire it so restart recovery
    # never leaves an answerable-looking request on a dead run.
    try:
        await expire_pending_agent_input_requests(
            run_id, reason="run_failed"
        )
    except Exception:
        pass
    run["status"] = "failed"
    run["llm_runtime"] = {**(run.get("llm_runtime") or {}), "status": "failed"}
    run["failure_reason"] = safe_error_message(error)
    return await save_agent_run(
        run,
        event_type="runtime.failed",
        event_payload={"error": safe_error_message(error)},
    )


async def start_embedded_agent_run(
    *,
    message: str,
    skill_id: str = "",  # 旧参数，已不使用
    conversation_id: str = "",
    task_id: str = "",
    context_messages: list[dict[str, str]] | None = None,
    worker: EmbeddedAgentWorker | None = None,
    provider_config: dict[str, Any] | None = None,
    provider_metadata: dict[str, Any] | None = None,
    resume_run_id: str = "",
    requested_run_id: str = "",
    stream_listener: StreamListener | None = None,
    continuation: bool = False,
) -> dict[str, Any]:
    goal = str(message or "").strip()
    if not goal and not resume_run_id:
        raise ValueError("Agent Run 需要非空消息。")
    if worker is None:
        try:
            ensure_embedded_agent_capacity()
        except EmbeddedAgentConcurrencyError as exc:
            raise ValueError(str(exc)) from exc
    resume_session_file = ""
    if resume_run_id:
        run = await load_agent_run(resume_run_id)
        if run is None:
            raise ValueError(f"Agent Run {resume_run_id} 不存在。")
        if (run.get("llm_runtime") or {}).get("runtime") != "python_agent":
            raise ValueError("旧 Pi 会话已保留为历史，不能由新内核自动重放；请开启新的任务。")
        continuation_statuses = {"completed", "interrupted", "failed"}
        allowed_resume_statuses = continuation_statuses if continuation else {"interrupted"}
        if run.get("status") not in allowed_resume_statuses:
            raise ValueError(
                f"Agent Run {resume_run_id} 不能恢复（status={run.get('status')}）。"
            )
        goal = goal or str(run.get("goal") or "").strip()
        resume_session_file = str(
            (run.get("llm_runtime") or {}).get("session_file") or ""
        ).strip()
    else:
        run = await create_agent_run(
            conversation_id=conversation_id,
            task_id=task_id,
            goal=goal,
            mode="core",
            skill_id=_SKILL_ID,
            skill_version="core",
            skill_snapshot={"id": _SKILL_ID, "name": "OfferU"},
            actions=[],
            exit_criteria=[
                "the user goal is answered from tool results",
                "every irreversible write is either confirmed by the user or visibly waiting",
            ],
            llm_runtime={
                "runtime": "python_agent",
                "provider_id": "embedded",
                "protocol_version": PROTOCOL_VERSION,
                "stream_protocol": "cursor_v1",
                "status": "configuring",
            },
            run_id=requested_run_id,
        )
    run_id = run["id"]
    from app.core import trace as run_trace
    from app.core.agent import step_budget
    from app.run_options import current_run_options

    tr = run_trace.start(run_id, journey_id=current_run_options().journey_id,
                         meta={"conversation_id": str(run.get("conversation_id") or conversation_id),
                               "continuation": bool(resume_run_id)})
    tr.update(prompt_version=run_trace.text_version(_system_prompt()), skill_version="core",
              step_budget=step_budget())
    if worker is not None:
        active_worker = worker
    else:
        try:
            active_worker = await get_embedded_agent_worker(run_id)
        except EmbeddedAgentConcurrencyError as exc:
            if not resume_run_id:
                await _fail_run(run_id, exc)
            raise ValueError(str(exc)) from exc
    expected_session_file = (
        resume_session_file
        or str(_SESSION_DIRECTORY / f"{run_id}.json")
    )

    async def publish(
        event_type: str,
        payload: dict[str, Any],
        *,
        sequence: int | None = None,
        event_id: str = "",
        timestamp: str = "",
        durable: bool = False,
    ) -> None:
        if stream_listener is None:
            return
        event = {
            "run_id": run_id,
            "type": event_type,
            "payload": payload,
            "durable": durable,
        }
        if sequence is not None:
            event["sequence"] = sequence
        if event_id:
            event["event_id"] = event_id
        if timestamp:
            event["timestamp"] = timestamp
        await stream_listener(event)

    async def publish_persisted(event: dict[str, Any]) -> None:
        await publish(
            str(event.get("type") or "runtime.event"),
            (
                event.get("payload")
                if isinstance(event.get("payload"), dict)
                else {}
            ),
            sequence=int(event.get("sequence") or 0),
            event_id=str(event.get("event_id") or ""),
            timestamp=str(event.get("timestamp") or ""),
            durable=True,
        )

    async def persist_and_publish(
        event_type: str,
        payload: dict[str, Any],
    ) -> dict[str, Any]:
        event = await append_agent_run_event(
            run_id,
            event_type=event_type,
            payload=payload,
        )
        await publish_persisted(event)
        return event

    delta_buffer: list[dict[str, Any]] = []
    next_delta_index = 0

    async def flush_delta_buffer() -> None:
        if not delta_buffer:
            return
        parts = [dict(item) for item in delta_buffer]
        delta = "".join(str(item.get("delta") or "") for item in parts)
        delta_buffer.clear()
        event = await append_agent_run_event(
            run_id,
            event_type="message.delta",
            payload={
                "delta": delta,
                "parts": parts,
                "delta_index_start": int(parts[0]["delta_index"]),
                "delta_index_end": int(parts[-1]["delta_index"]),
                "runtime": "python_agent",
                "provider_id": "embedded",
            },
        )
        await publish(
            "stream.cursor",
            {
                "cursor_for": "message.delta",
                "delta_index_end": int(parts[-1]["delta_index"]),
            },
            sequence=int(event["sequence"]),
        )

    try:
        await publish(
            "run.created",
            {
                "task_id": run["task_id"],
                "skill_id": _SKILL_ID,
                "status": run["status"],
            },
        )
        if not resume_run_id:
            for seed_event in await list_agent_run_events(run_id):
                await publish_persisted(seed_event)
        if resume_run_id and not resume_session_file:
            raise ValueError("Run 没有可恢复的 Python Agent Session 文件。")
        if resume_run_id and worker is None and not Path(resume_session_file).is_file():
            raise ValueError("Run 的 Python Agent Session 文件不存在，不能确定性恢复。")
        if provider_config is None:
            provider_config, resolved_metadata = resolve_embedded_provider_config()
        else:
            resolved_metadata = provider_metadata or {
                "runtime": "python_agent",
                "provider_id": "embedded",
                "protocol_version": PROTOCOL_VERSION,
                "provider": str(provider_config.get("name") or "test"),
                "model": str(provider_config.get("model") or ""),
                "source": "injected",
            }
        run["llm_runtime"] = {
            **(run.get("llm_runtime") or {}),
            **resolved_metadata,
            "status": "resuming" if resume_run_id else "starting",
            "session_file": expected_session_file,
        }
        run["status"] = "executing"
        run = await save_agent_run(
            run,
            event_type="recovery.started" if resume_run_id else "",
            event_payload=(
                {"session_file": resume_session_file}
                if resume_run_id
                else None
            ),
        )
        await publish(
            "runtime.resuming" if resume_run_id else "runtime.starting",
            {
                "provider": resolved_metadata.get("provider"),
                "model": resolved_metadata.get("model"),
            },
        )

        async def on_event(message_record: dict[str, Any]) -> None:
            nonlocal next_delta_index
            source_type = str(message_record.get("event") or "")
            event_type = _EVENT_TYPES.get(source_type)
            if event_type is None:
                return
            payload = (
                message_record.get("payload")
                if isinstance(message_record.get("payload"), dict)
                else {}
            )
            if source_type == "message.delta":
                delta = str(payload.get("delta") or "")
                if delta:
                    delta_part = {
                        "delta_index": next_delta_index,
                        "delta": delta,
                    }
                    next_delta_index += 1
                    delta_buffer.append(delta_part)
                    await publish(
                        "message.delta",
                        {
                            **delta_part,
                            "runtime": "python_agent",
                "provider_id": "embedded",
                        },
                    )
                    if sum(
                        len(str(item.get("delta") or ""))
                        for item in delta_buffer
                    ) >= 512:
                        await flush_delta_buffer()
                return
            await flush_delta_buffer()
            await persist_and_publish(
                event_type,
                {
                    **payload,
                    "runtime": "python_agent",
                "provider_id": "embedded",
                    "source_event": source_type,
                },
            )

        # Ask is a durable interaction record; the post-turn resolver reloads it.
        turn_state: dict[str, Any] = {"input_request": None}

        async def _request_user_input(args: dict[str, Any]) -> dict[str, Any]:
            """Built-in Ask: persist one AgentInputRequest, pause the turn.

            Ask is collaboration about preferences/strategy — it writes no
            Career data and authorizes no mutation. Persisting the request
            first means a crash still leaves the question visible.
            """

            arguments = args if isinstance(args, dict) else {}
            try:
                request = await create_agent_input_request(
                    run_id,
                    question=str(arguments.get("question") or ""),
                    reason=str(arguments.get("reason") or ""),
                    options=[
                        item
                        for item in (arguments.get("options") or [])
                        if isinstance(item, dict)
                    ],
                    allow_free_text=bool(arguments.get("allow_free_text", True)),
                    selection_mode=str(arguments.get("selection_mode") or "single"),
                    min_selections=arguments.get("min_selections") or 0,
                    max_selections=arguments.get("max_selections") or 0,
                    allow_skip=bool(arguments.get("allow_skip", True)),
                )
            except Exception as exc:
                return {"ok": False, "errors": [safe_error_message(exc)]}
            turn_state["input_request"] = request
            await persist_and_publish(
                "input.required",
                {"request": request, "run_id": run_id},
            )
            input_run = await load_agent_run(run_id)
            if input_run is not None:
                await publish(
                    "stream.cursor",
                    {"cursor_for": "input.required"},
                    sequence=int(input_run.get("event_sequence") or 0),
                )
            return {
                "ok": True,
                "terminate": True,
                "input_request": request,
                "message": "提问已持久化；本轮结束，用户回答后会作为新一轮继续。",
            }

        host_tools = [
            {
                "name": "request_user_input",
                "description": (
                    "向用户提出一个结构化问题（Ask）。仅当缺少的用户偏好或取舍"
                    "决定无法从现有数据推断时使用；绝不能用来请求批准受保护"
                    "变更或代替用户做决定。调用后本轮立即结束。"
                    "互斥选项用 selection_mode=single（默认）；只有可同时成立的"
                    "选项才用 multiple。最可能的选项标 recommended=true。"
                ),
                "input_schema": {
                    "type": "object",
                    "properties": {
                        "question": {"type": "string", "minLength": 1},
                        "reason": {"type": "string"},
                        "options": {
                            "type": "array",
                            "items": {
                                "type": "object",
                                "properties": {
                                    "option_id": {"type": "string"},
                                    "label": {"type": "string"},
                                    "description": {"type": "string"},
                                    "recommended": {"type": "boolean"},
                                },
                                "required": ["option_id", "label"],
                                "additionalProperties": False,
                            },
                        },
                        "allow_free_text": {"type": "boolean"},
                        "selection_mode": {
                            "type": "string",
                            "enum": ["single", "multiple"],
                        },
                        "min_selections": {"type": "integer", "minimum": 0},
                        "max_selections": {"type": "integer", "minimum": 0},
                        "allow_skip": {"type": "boolean"},
                    },
                    "required": ["question"],
                    "additionalProperties": False,
                },
                "execute": _request_user_input,
            }
        ]

        session = await active_worker.start_run(
            run_id=run_id,
            system_prompt=_system_prompt(),
            provider=provider_config,
            tools=core_agent.loop_tools(),
            event_listener=on_event,
            session_directory=str(_SESSION_DIRECTORY),
            session_file=resume_session_file,
            host_tools=host_tools,
        )
        current = await load_agent_run(run_id)
        assert current is not None
        current["llm_runtime"] = {
            **(current.get("llm_runtime") or {}),
            **resolved_metadata,
            "status": "active",
            "session_id": str(session.get("session_id") or ""),
            "sdk_version": str(session.get("sdk_version") or ""),
            "session_file": str(
                session.get("session_file") or expected_session_file
            ),
            "active_tools": list(session.get("active_tools") or []),
        }
        await save_agent_run(current)

        prompt_message = (
            "Resume this interrupted OfferU Agent Run from the persisted Python Agent "
            f"Session. Do not claim interrupted work completed. Original goal:\n{goal}"
            if resume_run_id and not continuation
            else _prompt_with_context(goal, context_messages)
        )
        decisions = await take_decisions_for_agent(
            run_id, str(run.get("conversation_id") or "")
        )
        prompt_message = "\n\n".join(
            part for part in (decisions, prompt_message) if part
        )
        response = await active_worker.prompt(
            run_id=run_id,
            message=prompt_message,
        )
        await flush_delta_buffer()
        assistant_message = str(response.get("assistant_message") or "").strip()
        stop_reason = str(response.get("stop_reason") or "stop")
        if stop_reason == "hard_loop_limit" and not assistant_message:
            assistant_message = (
                f"步数预算用完（{step_budget()} 轮工具），任务只完成了一部分；"
                "已做的改动在「最近改动」里，可以说「继续」接着做。"
            )
        current = await load_agent_run(run_id)
        assert current is not None
        pending_actions = await list_actions(run_id=run_id, status="pending")
        # Reload durable Ask state rather than trusting the in-memory turn flag.
        input_request = turn_state.get("input_request")
        if input_request is None:
            pending_requests = await list_pending_agent_input_requests(run_id)
            input_request = pending_requests[0] if pending_requests else None
        if not assistant_message and not pending_actions and input_request is None:
            raise RuntimeError(
                "主 Agent 未返回任何回复；请检查 LLM API Key / 模型 / Base URL 配置是否有效。"
            )
        # The Run never parks: queued confirmations and open questions are
        # answered later as a new turn on the same session.
        current["final_result"] = {
            **dict(current.get("final_result") or {}),
            "assistant_message": assistant_message,
            "pending_action_count": len(pending_actions),
            "requires_input": input_request is not None,
            "input_request": input_request,
            "turn_finished": False,
        }
        # 助手常在回复里直接发问（不走 Ask 工具）：最后一段以问号结尾也算在等用户。
        tail = assistant_message.rstrip().rsplit("\n", 1)[-1]
        asked_user = tail.rstrip(" \u3002.").endswith(("\uff1f", "?"))
        if stop_reason == "stop" and asked_user and input_request is None and not pending_actions:
            stop_reason = "asked_user"
        terminal_state = (
            "partial" if stop_reason == "hard_loop_limit"
            else "waiting_user" if input_request is not None or pending_actions or asked_user
            else "completed"
        )
        current["final_result"]["terminal_state"] = terminal_state
        current["final_result"]["stop_reason"] = stop_reason
        current["status"] = "completed"
        current = await save_agent_run(current)
        _finish_trace(tr, current, terminal_state, stop_reason, response.get("turns"))
        if input_request is not None:
            await publish("run.waiting_input", {"input_request": input_request})
        await publish("run.completed", {"status": "completed"})
        await active_worker.dispose_run(run_id)
        current = await load_agent_run(run_id) or current
        await persist_and_publish("run.turn_finished", {"status": current["status"]})
        current = await load_agent_run(run_id) or current
        current["final_result"] = {
            **(current.get("final_result") or {}),
            "turn_finished": True,
        }
        current = await save_agent_run(current)

        return {
            "ok": True,
            "run": current,
            "assistant_message": assistant_message,
            "pending_actions": pending_actions,
            "input_request": input_request,
        }
    except Exception as exc:
        await flush_delta_buffer()
        if active_worker.active_run_id == run_id:
            try:
                await active_worker.dispose_run(run_id)
            except Exception:
                pass
        cancelled = await load_agent_run(run_id)
        if cancelled is not None and cancelled.get("status") == "cancelled":
            _finish_trace(tr, cancelled, "cancelled", "aborted")
            if (cancelled.get("final_result") or {}).get("turn_finished") is not True:
                await persist_and_publish(
                    "run.turn_finished",
                    {"status": "cancelled"},
                )
                cancelled = await load_agent_run(run_id) or cancelled
                cancelled["final_result"] = {
                    **(cancelled.get("final_result") or {}),
                    "turn_finished": True,
                }
                cancelled = await save_agent_run(cancelled)
            return {
                "ok": False,
                "run": cancelled,
                "assistant_message": str(
                    (cancelled.get("final_result") or {}).get(
                        "assistant_message"
                    )
                    or ""
                ),
                "pending_actions": [],
                "errors": ["Run 已由使用者取消。"],
            }
        failed = await _fail_run(run_id, exc)
        failed["final_result"] = {**(failed.get("final_result") or {}), "terminal_state": "failed", "stop_reason": "error"}
        _finish_trace(tr, failed, "failed", "error", error=safe_error_message(exc))
        failed["final_result"] = {
            **(failed.get("final_result") or {}),
            "turn_finished": False,
        }
        failed = await save_agent_run(failed)
        await publish(
            "run.failed",
            {"status": "failed", "error": safe_error_message(exc)},
        )
        await persist_and_publish(
            "run.turn_finished",
            {"status": "failed"},
        )
        failed = await load_agent_run(run_id) or failed
        failed["final_result"] = {
            **(failed.get("final_result") or {}),
            "turn_finished": True,
        }
        failed = await save_agent_run(failed)
        return {
            "ok": False,
            "run": failed,
            "assistant_message": "",
            "pending_actions": [],
            "errors": [safe_error_message(exc)],
        }
    finally:
        # CancelledError (client disconnect) bypasses except Exception;
        # never leave a pooled worker holding a dead Run or a reserved slot.
        if active_worker.active_run_id == run_id:
            try:
                await active_worker.dispose_run(run_id)
            except Exception:
                pass
        release_embedded_agent_worker(run_id, active_worker)


async def resume_embedded_agent_run(
    run_id: str,
    *,
    worker: EmbeddedAgentWorker | None = None,
    provider_config: dict[str, Any] | None = None,
    provider_metadata: dict[str, Any] | None = None,
) -> dict[str, Any]:
    run = await load_agent_run(run_id)
    if run is None:
        raise ValueError(f"Agent Run {run_id} 不存在。")
    return await start_embedded_agent_run(
        message=str(run.get("goal") or ""),
        conversation_id=str(run.get("conversation_id") or ""),
        task_id=str(run.get("task_id") or ""),
        worker=worker,
        provider_config=provider_config,
        provider_metadata=provider_metadata,
        resume_run_id=run_id,
    )


async def answer_agent_input(
    run_id: str,
    request_id: str,
    *,
    answer_id: str,
    selected_option_ids: list[str] | None = None,
    free_text: str = "",
    skipped: bool = False,
    worker: EmbeddedAgentWorker | None = None,
) -> dict[str, Any]:
    """Persist one Ask answer, then continue the same run exactly once.

    The answer is collaboration data, not authorization: it never touches a
    protected Operation. ``answer_id`` dedupes client retries; the persisted
    answer digest decides whether a replay is identical (returns stored
    state) or conflicting (fails closed). ``consumed_at`` bounds the run to a
    single continuation.
    """

    answer = {
        "answer_id": str(answer_id or "").strip(),
        "selected_option_ids": [
            str(item)
            for item in (selected_option_ids or [])
            if str(item or "").strip()
        ],
        "free_text": str(free_text or "")[:4000],
    }
    if skipped:
        answer["skipped"] = True
    stored = await answer_agent_input_request(
        run_id, request_id, answer=answer
    )
    if not stored.get("ok"):
        reason = stored.get("error")
        if reason == "invalid":
            errors = [str(item) for item in stored.get("errors") or []]
        elif reason == "not_found":
            errors = ["input request 不存在于该 Run。"]
        else:
            errors = ["input request 已有不同的回答；拒绝覆盖。"]
        result: dict[str, Any] = {
            "ok": False,
            "error_code": str(reason or "conflict"),
            "errors": errors,
        }
        if isinstance(stored.get("request"), dict):
            result["request"] = stored["request"]
        return result
    request = stored["request"]
    run = await load_agent_run(run_id)
    result = {
        "ok": True,
        "request": request,
        "duplicate": bool(stored.get("duplicate")),
        "run": run,
    }
    if stored.get("duplicate"):
        result["warnings"] = ["相同回答已持久化；没有重复续跑。"]
        return result
    await append_agent_run_event(
        run_id,
        event_type="input.answered",
        payload={"request_id": request_id, "answer_id": answer["answer_id"]},
    )

    if not await consume_agent_input_request(request_id):
        # Continuation already claimed by a racing caller; never start twice.
        result["run"] = await load_agent_run(run_id) or run
        result["warnings"] = ["该回答已触发过续跑；返回当前持久化状态。"]
        return result

    active_worker = worker or find_embedded_agent_worker(run_id)
    if active_worker is not None and active_worker.active_run_id == run_id:
        try:
            await active_worker.dispose_run(run_id)
        except Exception:
            pass
    answer_text = (
        "The user answered your earlier question (persisted answer, the only "
        "authoritative content). Continue the original goal; do not ask the "
        "same question again.\n"
        + (
            "The user skipped this question: proceed with the most reasonable "
            "default and state that assumption briefly.\n"
            if (request.get("answer") or answer).get("skipped")
            else ""
        )
        + json.dumps(
            {
                "question": request.get("question"),
                "answer": request.get("answer") or answer,
            },
            ensure_ascii=False,
            default=str,
        )
        + "\nOriginal goal:\n"
        + str((run or {}).get("goal") or "")
    )
    async with _CONTINUATION_LOCKS.setdefault(run_id, asyncio.Lock()):
        latest = await load_agent_run(run_id)
        if latest is None or latest.get("status") == "cancelled":
            result["run"] = latest or run
            result["warnings"] = ["Run 已取消；回答已持久化但未续跑。"]
            return result
        try:
            continued = await start_embedded_agent_run(
                message=answer_text,
                resume_run_id=run_id,
                worker=worker,
                continuation=True,
            )
        except Exception as exc:
            latest = await load_agent_run(run_id)
            if latest is not None:
                latest["status"] = "failed"
                latest["failure_reason"] = safe_error_message(exc)
                await save_agent_run(
                    latest,
                    event_type="runtime.failed",
                    event_payload={
                        "phase": "input_continuation",
                        "error": latest["failure_reason"],
                    },
                )
            continued = {
                "ok": False,
                "run": latest,
                "errors": [safe_error_message(exc)],
            }
    result["run"] = continued.get("run") or result["run"]
    result["continuation"] = continued
    if not continued.get("ok"):
        result["warnings"] = ["回答已持久化；Agent 续跑失败，请查看 Run 的失败原因。"]
    return result




async def steer_embedded_agent_run(
    run_id: str,
    message: str,
    *,
    worker: EmbeddedAgentWorker | None = None,
) -> dict[str, Any]:
    """Inject a user message into a live Run at its next tool boundary.

    Steering is collaboration input, never authorization. When the Run is not
    executing a prompt right now (finished, parked or waiting on the user) the
    caller gets ``not_running`` and should start a follow-up turn instead.
    """

    text = str(message or "").strip()
    if not text:
        raise ValueError("引导消息不能为空。")
    run = await load_agent_run(run_id)
    if run is None:
        raise ValueError(f"Agent Run {run_id} 不存在。")
    active_worker = worker or find_embedded_agent_worker(run_id)
    if active_worker is None or active_worker.active_run_id != run_id or not active_worker.prompt_active:
        return {"ok": True, "disposition": "not_running", "run": run}
    try:
        await active_worker.steer_run(run_id, text[:4000])
    except EmbeddedAgentWorkerError:
        return {"ok": True, "disposition": "not_running", "run": run}
    await append_agent_run_event(
        run_id,
        event_type="input.steered",
        payload={"characters": len(text)},
    )
    return {"ok": True, "disposition": "steered", "run": run}


async def abort_embedded_agent_run(
    run_id: str,
    *,
    worker: EmbeddedAgentWorker | None = None,
) -> dict[str, Any]:
    run = await load_agent_run(run_id)
    if run is None:
        raise ValueError(f"Agent Run {run_id} 不存在。")
    if run.get("status") in {"completed", "failed", "cancelled"}:
        return {"ok": True, "run": run, "warnings": ["Run 已经结束。"]}

    active_worker = worker or find_embedded_agent_worker(run_id)
    if active_worker is not None and active_worker.active_run_id == run_id:
        await active_worker.abort_run(run_id)
        await active_worker.dispose_run(run_id)
    run = await load_agent_run(run_id) or run
    try:
        await expire_pending_agent_input_requests(run_id, reason="run_cancelled")
    except Exception:
        pass
    run["status"] = "cancelled"
    run["failure_reason"] = "cancelled_by_user"
    run["final_result"] = {
        **(run.get("final_result") or {}),
        "turn_finished": False,
    }
    run = await save_agent_run(run)
    await append_agent_run_event(
        run_id,
        event_type="run.turn_finished",
        payload={"status": "cancelled"},
    )
    run = await load_agent_run(run_id) or run
    run["final_result"] = {
        **(run.get("final_result") or {}),
        "turn_finished": True,
    }
    run = await save_agent_run(run)
    return {"ok": True, "run": run}
