from __future__ import annotations

from pathlib import Path
from typing import Any, Awaitable, Callable

from app.agents.llm import resolve_llm_client_config, resolve_model_for_tier
from app.config import Settings, get_settings
from app.ops import OPERATIONS, execute_operation
from app.services.career_memory import record_conversation_observation
from app.services.agent_run_state import (
    append_agent_run_event,
    create_agent_run,
    list_agent_run_events,
    load_agent_run,
    pending_actions_for_run,
    propose_agent_run_action,
    safe_result_preview,
    save_agent_run,
)
from app.services.agent_skill_registry import AgentSkill, resolve_run_skill, resolve_skill
from app.services.main_agent_guardian import (
    evaluate_main_agent_guardian,
    guardian_prompt_advice,
)
from app.services.operation_projection import confirm_operation_proposal
from app.services.pi_agent_worker import (
    PROTOCOL_VERSION,
    PiAgentWorkerClient,
    get_pi_agent_worker,
)


_EVENT_TYPES = {
    "message.delta": "message.delta",
    "run.started": "runtime.session_started",
    "run.aborted": "runtime.aborted",
    "run.disposed": "runtime.disposed",
    "runtime.fatal": "runtime.failed",
    "pi.agent_start": "runtime.agent_started",
    "pi.agent_end": "runtime.agent_completed",
    "pi.agent_settled": "runtime.agent_settled",
    "pi.turn_start": "runtime.turn_started",
    "pi.turn_end": "runtime.turn_completed",
    "pi.tool_execution_start": "runtime.tool_started",
    "pi.tool_execution_end": "runtime.tool_completed",
    "pi.compaction_start": "runtime.compaction_started",
    "pi.compaction_end": "runtime.compaction_completed",
    "pi.auto_retry_start": "runtime.retry_started",
    "pi.auto_retry_end": "runtime.retry_completed",
}
_SESSION_DIRECTORY = Path(__file__).resolve().parents[2] / "data" / "pi_sessions"
StreamListener = Callable[[dict[str, Any]], Awaitable[None]]


def resolve_pi_provider_config(
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
        "runtime": "pi_sdk_worker",
        "protocol_version": PROTOCOL_VERSION,
        "provider": resolved["provider"],
        "model": model,
        "source": resolved["source"],
    }
    return private, public


def _skill_snapshot(skill: AgentSkill) -> dict[str, Any]:
    snapshot = skill.summary()
    snapshot["confirmation_required_operations"] = sorted(
        name
        for name in skill.allowed_tools
        if name in OPERATIONS and OPERATIONS[name].is_mutation
    )
    return snapshot


def _allowed_operations(skill: AgentSkill) -> list[dict[str, Any]]:
    allowed = [
        OPERATIONS[name].schema()
        for name in sorted(skill.allowed_tools)
        if name in OPERATIONS
    ]
    if not allowed:
        raise ValueError(f"Skill {skill.id} 没有可投影到 Pi 的 Operation。")
    return allowed


def _system_prompt(skill: AgentSkill) -> str:
    return (
        "You are OfferU's built-in task Agent. "
        "Python owns task state, domain facts, confirmation, idempotency and audit. "
        "Treat Operation results as the only source of truth and state unknowns plainly. "
        "A mutation result with executed=false is only a proposal; ask the user to confirm it. "
        f"Active Skill: {skill.name} ({skill.id}, version {skill.version}). "
        f"Skill purpose: {skill.description}"
    )


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


def _operation_outputs(result: dict[str, Any]) -> Any:
    if not isinstance(result, dict) or not result.get("ok"):
        return None
    return result.get("outputs")


async def _prepare_guardian_advice(
    *,
    skill: AgentSkill,
    conversation_id: str,
    message: str,
    context_messages: list[dict[str, str]] | None,
) -> tuple[dict[str, Any], dict[str, Any] | None]:
    """Host fixed Guardian inputs; the Guardian itself has no Operation access."""

    profile: dict[str, Any] | None = None
    jobs: list[dict[str, Any]] | None = None
    applications: list[dict[str, Any]] | None = None

    if "get_profile" in skill.allowed_tools:
        value = _operation_outputs(
            await execute_operation("get_profile", {}, surface="guardian")
        )
        profile = value if isinstance(value, dict) else None
    if "list_jobs" in skill.allowed_tools:
        value = _operation_outputs(
            await execute_operation(
                "list_jobs",
                {"page": 1, "page_size": 20},
                surface="guardian",
            )
        )
        raw_jobs = (
            value.get("items") or value.get("jobs") or []
            if isinstance(value, dict)
            else value
        )
        jobs = [
            item for item in (raw_jobs or []) if isinstance(item, dict)
        ]
    if "list_applications" in skill.allowed_tools:
        value = _operation_outputs(
            await execute_operation(
                "list_applications",
                {"page": 1, "page_size": 20},
                surface="guardian",
            )
        )
        raw_applications = (
            value.get("items") or value.get("applications") or []
            if isinstance(value, dict)
            else value
        )
        applications = [
            item
            for item in (raw_applications or [])
            if isinstance(item, dict)
        ]

    messages = [
        *(context_messages or []),
        {"role": "user", "content": message},
    ]
    guardian = evaluate_main_agent_guardian(
        profile=profile,
        messages=messages,
        memory=None,
        jobs=jobs,
        applications=applications,
        mode=skill.mode,
    )
    observation: dict[str, Any] | None = None
    if conversation_id and message:
        try:
            observation = await record_conversation_observation(
                conversation_id=conversation_id,
                turn_index=(
                    sum(
                        1
                        for item in messages
                        if item.get("role") == "user"
                    )
                ),
                user_message=message,
                user_stage=str(guardian.get("user_stage") or "unknown"),
            )
        except Exception as exc:
            observation = {
                "recorded": False,
                "error": str(exc)[:500],
            }
    return guardian, observation


async def _fail_run(run_id: str, error: Exception) -> dict[str, Any]:
    run = await load_agent_run(run_id)
    if run is None:
        raise error
    run["status"] = "failed"
    run["failure_reason"] = str(error)[:1000]
    return await save_agent_run(
        run,
        event_type="runtime.failed",
        event_payload={"error": str(error)[:1000]},
    )


async def start_pi_agent_run(
    *,
    message: str,
    skill_id: str,
    conversation_id: str = "",
    task_id: str = "",
    context_messages: list[dict[str, str]] | None = None,
    worker: PiAgentWorkerClient | None = None,
    provider_config: dict[str, Any] | None = None,
    provider_metadata: dict[str, Any] | None = None,
    resume_run_id: str = "",
    requested_run_id: str = "",
    stream_listener: StreamListener | None = None,
) -> dict[str, Any]:
    goal = str(message or "").strip()
    if not goal and not resume_run_id:
        raise ValueError("Agent Run 需要非空消息。")
    resume_session_file = ""
    if resume_run_id:
        run = await load_agent_run(resume_run_id)
        if run is None:
            raise ValueError(f"Agent Run {resume_run_id} 不存在。")
        if run.get("status") != "interrupted":
            raise ValueError(
                f"Agent Run {resume_run_id} 不能恢复（status={run.get('status')}）。"
            )
        goal = goal or str(run.get("goal") or "").strip()
        skill = resolve_skill(str(run.get("skill_id") or ""))
        if skill is None or skill.version != str(run.get("skill_version") or ""):
            raise ValueError("Run 使用的 Skill 版本已不可用，拒绝隐式升级后恢复。")
        frozen_tools = set(
            (run.get("skill_snapshot") or {}).get("allowed_tools") or []
        )
        if frozen_tools != set(skill.allowed_tools):
            raise ValueError("Run 的冻结工具授权与当前 Skill 不一致，拒绝恢复。")
        resume_session_file = str(
            (run.get("llm_runtime") or {}).get("session_file") or ""
        ).strip()
    else:
        skill = resolve_run_skill(goal, skill_id)
        run = await create_agent_run(
            conversation_id=conversation_id,
            task_id=task_id,
            goal=goal,
            mode=skill.mode,
            skill_id=skill.id,
            skill_version=skill.version,
            skill_snapshot=_skill_snapshot(skill),
            actions=[],
            exit_criteria=[
                "the user goal is answered from Operation evidence",
                "every mutation is either confirmed exactly once or remains visibly proposed",
            ],
            llm_runtime={
                "runtime": "pi_sdk_worker",
                "protocol_version": PROTOCOL_VERSION,
                "stream_protocol": "cursor_v1",
                "status": "configuring",
            },
            run_id=requested_run_id,
        )
    allowed_operations = _allowed_operations(skill)
    run_id = run["id"]
    active_worker = worker or get_pi_agent_worker()
    expected_session_file = (
        resume_session_file
        or str(_SESSION_DIRECTORY / f"{run_id}.jsonl")
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
    guardian_result: dict[str, Any] = {
        "user_stage": "unknown",
        "stage_confidence": 0,
        "stage_signals": [],
        "alerts": [],
        "proactive_suggestions": [],
    }
    learning_observation: dict[str, Any] | None = None

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
                "runtime": "pi_sdk_worker",
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
                "skill_id": skill.id,
                "skill_version": skill.version,
                "status": run["status"],
            },
        )
        if not resume_run_id:
            for seed_event in await list_agent_run_events(run_id):
                await publish_persisted(seed_event)
        try:
            guardian_result, learning_observation = await _prepare_guardian_advice(
                skill=skill,
                conversation_id=str(run.get("conversation_id") or ""),
                message=goal,
                context_messages=context_messages,
            )
            await persist_and_publish(
                "guardian.advice",
                {
                    **guardian_result,
                    "learning_observation": learning_observation,
                },
            )
        except Exception as guardian_error:
            guardian_result = {
                **guardian_result,
                "alerts": [
                    {
                        "code": "guardian_unavailable",
                        "severity": "medium",
                        "title": "Guardian 本轮不可用",
                        "message": "确定性阶段与异常检查未完成。",
                        "action": "不要依据缺失的 Guardian 结果推断风险已解除。",
                    }
                ],
            }
            learning_observation = {
                "recorded": False,
                "error": str(guardian_error)[:500],
            }
            await persist_and_publish(
                "guardian.failed",
                {"error": str(guardian_error)[:500]},
            )
        if resume_run_id and not resume_session_file:
            raise ValueError("Run 没有可恢复的 Pi Session 文件。")
        if resume_run_id and worker is None and not Path(resume_session_file).is_file():
            raise ValueError("Run 的 Pi Session 文件不存在，不能确定性恢复。")
        if provider_config is None:
            provider_config, resolved_metadata = resolve_pi_provider_config()
        else:
            resolved_metadata = provider_metadata or {
                "runtime": "pi_sdk_worker",
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
                            "runtime": "pi_sdk_worker",
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
                    "runtime": "pi_sdk_worker",
                    "source_event": source_type,
                },
            )

        async def run_operation(
            operation_name: str,
            arguments: dict[str, Any],
        ) -> dict[str, Any]:
            if operation_name not in skill.allowed_tools:
                denied_payload = {
                    "operation": operation_name,
                    "reason": f"outside Skill {skill.id}",
                }
                await persist_and_publish("operation.denied", denied_payload)
                return {
                    "ok": False,
                    "operation": operation_name,
                    "errors": [
                        f"Operation {operation_name} is outside Skill {skill.id}"
                    ],
                }
            operation = OPERATIONS.get(operation_name)
            if operation is None:
                denied_payload = {
                    "operation": operation_name,
                    "reason": "unknown Operation",
                }
                await persist_and_publish("operation.denied", denied_payload)
                return {
                    "ok": False,
                    "operation": operation_name,
                    "errors": [f"未知操作: {operation_name}"],
                }
            inputs = arguments if isinstance(arguments, dict) else {}
            if operation.is_mutation:
                preview = await execute_operation(
                    operation_name,
                    inputs,
                    dry_run=True,
                    surface="pi",
                )
                if not preview.get("ok"):
                    failed_payload = {
                        "operation": operation_name,
                        "args": inputs,
                        "errors": preview.get("errors") or [],
                        "phase": "proposal_validation",
                    }
                    await persist_and_publish("operation.failed", failed_payload)
                    return preview
                step = await propose_agent_run_action(
                    run_id,
                    operation=operation_name,
                    # 持久化原始（未 redact）参数供 confirm 重放；preview 的
                    # inputs 已被 dry-run 审计替换为 sha256 占位，重放必失败。
                    args=inputs,
                    summary=operation.description,
                )
                await publish(
                    "operation.proposed",
                    {
                        "action_id": step["id"],
                        "operation": operation_name,
                        "args": step["args"],
                        "summary": step["summary"],
                        "idempotency_key": step["idempotency_key"],
                    },
                )
                proposal_run = await load_agent_run(run_id)
                if proposal_run is not None:
                    await publish(
                        "stream.cursor",
                        {"cursor_for": "operation.proposed"},
                        sequence=int(proposal_run.get("event_sequence") or 0),
                    )
                return {
                    **preview,
                    "outputs": {
                        "executed": False,
                        "requires_confirmation": True,
                        "proposal": {
                            "run_id": run_id,
                            "task_id": run["task_id"],
                            "action_id": step["id"],
                            "idempotency_key": step["idempotency_key"],
                            "operation": step["tool"],
                            "args": step["args"],
                            "status": step["status"],
                        },
                    },
                    "warnings": [
                        "副作用尚未执行；提案已写入当前 Agent Run，等待用户确认。"
                    ],
                }

            started_payload = {"operation": operation_name, "args": inputs}
            await persist_and_publish("operation.started", started_payload)
            result = await execute_operation(
                operation_name,
                inputs,
                surface="pi",
            )
            completed_type = (
                "operation.completed"
                if result.get("ok")
                else "operation.failed"
            )
            completed_payload = {
                "operation": operation_name,
                "args": inputs,
                "result": safe_result_preview(result),
            }
            await persist_and_publish(completed_type, completed_payload)
            return result

        session = await active_worker.start_run(
            run_id=run_id,
            system_prompt=_system_prompt(skill),
            provider=provider_config,
            allowed_operations=allowed_operations,
            operation_runner=run_operation,
            event_listener=on_event,
            session_directory=str(_SESSION_DIRECTORY),
            session_file=resume_session_file,
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
            "Resume this interrupted OfferU Agent Run from the persisted Pi "
            f"Session. Do not claim interrupted work completed. Original goal:\n{goal}"
            if resume_run_id
            else _prompt_with_context(goal, context_messages)
        )
        prompt_message = (
            f"{prompt_message}\n\n{guardian_prompt_advice(guardian_result)}"
        )
        response = await active_worker.prompt(run_id=run_id, message=prompt_message)
        await flush_delta_buffer()
        assistant_message = str(response.get("assistant_message") or "").strip()
        current = await load_agent_run(run_id)
        assert current is not None
        pending_actions = pending_actions_for_run(current)
        # 反静默降级：LLM 未返回任何回复且没有待确认动作时，不能当作成功完成。
        # 否则用户看到空白回复无法区分「正常但无输出」与「LLM 故障」。
        if not assistant_message and not pending_actions:
            raise RuntimeError(
                "主 Agent 未返回任何回复，也没有待确认动作；"
                "请检查 LLM API Key / 模型 / Base URL 配置是否有效。"
            )
        current["final_result"] = {
            "assistant_message": assistant_message,
            "requires_confirmation": bool(pending_actions),
            "active_skill": skill.summary(),
            "guardian": guardian_result,
            "learning_observation": learning_observation,
            "turn_finished": False,
        }
        if pending_actions:
            current["status"] = "waiting_confirmation"
            current = await save_agent_run(current)
            await publish(
                "run.waiting_confirmation",
                {"pending_actions": pending_actions},
            )
        else:
            current["status"] = "completed"
            current = await save_agent_run(current)
            await publish("run.completed", {"status": "completed"})
            await active_worker.dispose_run(run_id)
            current = await load_agent_run(run_id) or current
        await persist_and_publish(
            "guardian.reviewed",
            {
                "status": current["status"],
                "alert_count": len(guardian_result.get("alerts") or []),
                "pending_action_count": len(pending_actions),
                "learning_observation_recorded": bool(
                    (learning_observation or {}).get("recorded")
                ),
            },
        )
        await persist_and_publish(
            "run.turn_finished",
            {
                "status": current["status"],
                "requires_confirmation": bool(pending_actions),
            },
        )
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
            "active_skill": skill.summary(),
            "guardian": guardian_result,
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
            if (cancelled.get("final_result") or {}).get("turn_finished") is not True:
                await persist_and_publish(
                    "run.turn_finished",
                    {"status": "cancelled", "requires_confirmation": False},
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
                "active_skill": skill.summary(),
                "errors": ["Run 已由使用者取消。"],
            }
        failed = await _fail_run(run_id, exc)
        failed["final_result"] = {
            **(failed.get("final_result") or {}),
            "guardian": guardian_result,
            "learning_observation": learning_observation,
            "turn_finished": False,
        }
        failed = await save_agent_run(failed)
        await publish(
            "run.failed",
            {"status": "failed", "error": str(exc)[:1000]},
        )
        await persist_and_publish(
            "guardian.reviewed",
            {
                "status": "failed",
                "alert_count": len(guardian_result.get("alerts") or []),
                "pending_action_count": 0,
                "learning_observation_recorded": bool(
                    (learning_observation or {}).get("recorded")
                ),
            },
        )
        await persist_and_publish(
            "run.turn_finished",
            {"status": "failed", "requires_confirmation": False},
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
            "active_skill": skill.summary(),
            "guardian": guardian_result,
            "errors": [str(exc)[:1000]],
        }


async def resume_pi_agent_run(
    run_id: str,
    *,
    worker: PiAgentWorkerClient | None = None,
    provider_config: dict[str, Any] | None = None,
    provider_metadata: dict[str, Any] | None = None,
) -> dict[str, Any]:
    run = await load_agent_run(run_id)
    if run is None:
        raise ValueError(f"Agent Run {run_id} 不存在。")
    return await start_pi_agent_run(
        message=str(run.get("goal") or ""),
        skill_id=str(run.get("skill_id") or ""),
        conversation_id=str(run.get("conversation_id") or ""),
        task_id=str(run.get("task_id") or ""),
        worker=worker,
        provider_config=provider_config,
        provider_metadata=provider_metadata,
        resume_run_id=run_id,
    )


async def confirm_pi_agent_action(
    run_id: str,
    *,
    action_id: str,
    worker: PiAgentWorkerClient | None = None,
) -> dict[str, Any]:
    current = await load_agent_run(run_id)
    selected = (
        next(
            (
                step
                for step in (current.get("steps") or [])
                if isinstance(step, dict)
                and step.get("status")
                in {"waiting_confirmation", "executing"}
                and (
                    not action_id
                    or str(step.get("id") or "") == action_id
                )
            ),
            None,
        )
        if current is not None
        else None
    )
    if current is not None and selected is not None:
        current["final_result"] = {
            **(current.get("final_result") or {}),
            "requires_confirmation": True,
            "turn_finished": False,
        }
        await save_agent_run(current)
    result = await confirm_operation_proposal(
        run_id,
        action_id=action_id,
        surface="pi",
    )
    active_worker = worker or get_pi_agent_worker()
    if active_worker.active_run_id == run_id:
        try:
            await active_worker.dispose_run(run_id)
            latest = await load_agent_run(run_id)
            if latest is not None:
                result["run"] = latest
        except Exception as exc:
            await append_agent_run_event(
                run_id,
                event_type="runtime.failed",
                payload={"error": str(exc)[:1000], "phase": "dispose_after_confirm"},
            )
            result.setdefault("warnings", []).append(
                "操作已处理，但 Pi Session 释放失败；Worker 会在下次启动时显式报错。"
            )
    run = result.get("run") if isinstance(result.get("run"), dict) else None
    if run is not None and run.get("status") in {
        "completed",
        "failed",
        "cancelled",
        "waiting_confirmation",
        "needs_reconciliation",
    }:
        final_result = run.get("final_result") or {}
        action_finished = bool(result.get("tool_calls"))
        requires_confirmation = (
            run.get("status") == "waiting_confirmation"
            and bool(pending_actions_for_run(run))
        )
        if (
            action_finished
            or final_result.get("turn_finished") is not True
            or final_result.get("requires_confirmation")
            is not requires_confirmation
        ):
            run["final_result"] = {
                **final_result,
                "requires_confirmation": requires_confirmation,
                "turn_finished": True,
            }
            result["run"] = await save_agent_run(
                run,
                event_type="run.turn_finished",
                event_payload={
                    "status": str(run.get("status") or ""),
                    "requires_confirmation": requires_confirmation,
                },
            )
    return result


async def abort_pi_agent_run(
    run_id: str,
    *,
    worker: PiAgentWorkerClient | None = None,
) -> dict[str, Any]:
    run = await load_agent_run(run_id)
    if run is None:
        raise ValueError(f"Agent Run {run_id} 不存在。")
    if run.get("status") in {"completed", "failed", "cancelled", "needs_reconciliation"}:
        return {"ok": True, "run": run, "warnings": ["Run 已经结束。"]}

    active_worker = worker or get_pi_agent_worker()
    if active_worker.active_run_id == run_id:
        await active_worker.abort_run(run_id)
        await active_worker.dispose_run(run_id)
    run = await load_agent_run(run_id) or run
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
        payload={"status": "cancelled", "requires_confirmation": False},
    )
    run = await load_agent_run(run_id) or run
    run["final_result"] = {
        **(run.get("final_result") or {}),
        "turn_finished": True,
    }
    run = await save_agent_run(run)
    return {"ok": True, "run": run}
