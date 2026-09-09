"""Real local-agent capability probes and conformance reports.

The runtime registry is deliberately declarative: a provider can advertise a
capability without having proved it on this machine.  This module keeps those
two facts separate and exposes a small, repeatable probe surface for the CLI,
the Operation Registry, and the runtime status UI.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import os
import secrets
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

from app.services import coding_agent_runtime as runtime
from app.services.agent_provider_health import (
    get_provider_health,
    list_provider_health,
    record_provider_health,
)
from app.services.security_redaction import redact_sensitive_text

CAPABILITY_STATES = frozenset(
    {
        "SUPPORTED",
        "VERIFIED",
        "UNSUPPORTED",
        "NOT_VERIFIED",
        "BLOCKED_AUTH",
        "UNAVAILABLE",
        "ERROR",
    }
)

_LIVE_PROBES: dict[str, dict[str, Any]] = {}
_PROBE_LOCK = asyncio.Lock()


def _probe_event_count(probe: Any) -> int:
    """Read the protocol event count from either current or legacy snapshots."""

    if not isinstance(probe, dict):
        return 0
    direct = probe.get("event_count")
    if direct is not None:
        try:
            return max(0, int(direct))
        except (TypeError, ValueError):
            return 0
    trace = probe.get("trace")
    if isinstance(trace, dict):
        try:
            return max(0, int(trace.get("event_count") or 0))
        except (TypeError, ValueError):
            return 0
    return 0


def _parse_lifecycle_message(value: Any) -> dict[str, Any] | None:
    """Parse the exact JSON object returned by a lifecycle probe turn."""

    if not isinstance(value, str):
        return None
    try:
        parsed = json.loads(value.strip())
    except (TypeError, ValueError):
        return None
    return parsed if isinstance(parsed, dict) else None


def _probe_cwd(provider_id: str, task_id: str) -> Path:
    """Return an isolated probe cwd on the configured non-system drive.

    Live probes can create sizeable CLI logs and caches.  Keep them outside the
    repository and honour the test/runtime override so a workstation never
    silently falls back to the system drive.
    """

    configured = str(os.environ.get("OFFERU_TEST_TEMP_ROOT") or "").strip()
    if configured:
        root = Path(configured).expanduser()
    elif os.name == "nt":
        root = Path(r"H:\tmp")
    else:
        root = Path("/tmp")
    cwd = root / "offeru" / "agent-conformance" / provider_id / task_id
    cwd.mkdir(parents=True, exist_ok=True)
    return cwd


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _state(
    *,
    declared: bool,
    verified: bool = False,
    available: bool = True,
    blocked_auth: bool = False,
    error: bool = False,
) -> str:
    if error:
        return "ERROR"
    if not available:
        return "UNAVAILABLE"
    if blocked_auth:
        return "BLOCKED_AUTH"
    if verified:
        return "VERIFIED"
    return "SUPPORTED" if declared else "UNSUPPORTED"


def _check_snapshot(provider_id: str) -> dict[str, Any]:
    # Import lazily to keep the existing connection module free of a cycle.
    from app.services import agent_connection

    return dict(agent_connection._CHECKS.get(provider_id) or {})


def _failure_text(value: Any) -> str:
    return redact_sensitive_text(str(value or ""), max_length=500)


def _is_auth_failure(value: Any) -> bool:
    """Recognise provider authentication failures without hiding other errors."""

    message = str(value or "").casefold()
    return any(
        marker in message
        for marker in (
            "401",
            "unauthorized",
            "invalid_api_key",
            "failed to authenticate",
            "authentication failed",
            "authentication required",
            "auth required",
            "login required",
        )
    )


def _base_report(item: dict[str, Any], health: dict[str, Any]) -> dict[str, Any]:
    provider_id = str(item.get("id") or "")
    definition = runtime.RUNTIME_DEFINITIONS.get(provider_id, {})
    declaration = definition.get("capabilities_decl") or {}
    check = _check_snapshot(provider_id)
    installed = bool(item.get("executable_path"))
    compatible = bool(item.get("contract_compatible"))
    health_status = str(health.get("status") or "").lower()
    auth_value = check.get("authenticated")
    if auth_value is None:
        auth_value = health.get("authenticated")
    auth_blocked = health_status in {"auth_required", "blocked"} or auth_value is False
    connection_verified = check.get("status") == "ready" and compatible
    failure_reason = health.get("last_error") or check.get("error") or ""
    if not installed:
        failure_reason = f"{definition.get('name', provider_id)} 未在本机发现"
    elif not compatible and not failure_reason:
        failure_reason = "本地执行器未满足当前 Operation Registry 契约"

    report = {
        "provider_id": provider_id,
        "name": str(item.get("name") or definition.get("name") or provider_id),
        "installed": _state(available=installed, declared=True, verified=installed),
        "binary_path": str(item.get("executable_path") or ""),
        "version": redact_sensitive_text(str(item.get("version") or ""), max_length=160),
        "native_auth_detected": (
            "VERIFIED"
            if auth_value is True
            else "BLOCKED_AUTH"
            if auth_blocked
            else "NOT_VERIFIED"
        ),
        "connection_verified": _state(
            available=installed,
            declared=compatible,
            verified=connection_verified,
            blocked_auth=auth_blocked,
            error=installed and not compatible,
        ),
        "live_model_verified": "NOT_VERIFIED",
        "structured_output_verified": "NOT_VERIFIED",
        "streaming_verified": "NOT_VERIFIED",
        "resume_verified": _state(
            available=installed,
            declared=bool(declaration.get("supports_resume")),
        ),
        "cancel_verified": _state(
            available=installed,
            declared=bool(declaration.get("supports_cancel")),
        ),
        "cwd_isolation_verified": _state(
            available=installed,
            declared=bool(definition.get("isolation")),
        ),
        "web_search_verified": _state(
            available=installed,
            declared=bool(declaration.get("supports_live_web_search")),
        ),
        "last_probe_at": check.get("checked_at") or item.get("checked_at"),
        "failure_reason": _failure_text(failure_reason),
        "declarations": {
            "schema_mode": str(declaration.get("schema_mode") or "unknown"),
            "supports_resume": bool(declaration.get("supports_resume")),
            "supports_cancel": bool(declaration.get("supports_cancel")),
            "supports_live_web_search": bool(
                declaration.get("supports_live_web_search")
            ),
        },
    }
    persisted = health.get("capabilities") if isinstance(health.get("capabilities"), dict) else {}
    conformance = persisted.get("conformance") if isinstance(persisted.get("conformance"), dict) else {}
    if (
        conformance.get("binary_path") == report["binary_path"]
        and conformance.get("version") == report["version"]
    ):
        for field in (
            "native_auth_detected",
            "connection_verified",
            "live_model_verified",
            "structured_output_verified",
            "resume_verified",
            "cancel_verified",
            "cwd_isolation_verified",
            "web_search_verified",
            "last_probe_at",
            "failure_reason",
        ):
            if field in conformance:
                report[field] = conformance[field]
        if isinstance(conformance.get("live_probe"), dict):
            report["live_probe"] = conformance["live_probe"]
            # A historical snapshot may predate event-count evidence. Keep
            # its model/JSON result, but do not promote streaming to VERIFIED
            # until a probe records at least one protocol event.
            if _probe_event_count(conformance["live_probe"]) > 0:
                report["streaming_verified"] = conformance.get(
                    "streaming_verified", report["streaming_verified"]
                )
            else:
                report["streaming_verified"] = "NOT_VERIFIED"
        lifecycle = conformance.get("lifecycle_probe")
        if isinstance(lifecycle, dict):
            report["lifecycle_probe"] = lifecycle
            for capability in ("resume", "cancel"):
                evidence = lifecycle.get(capability)
                current_state = report.get(f"{capability}_verified")
                if (
                    isinstance(evidence, dict)
                    and evidence.get("verified") is True
                    and current_state not in {"ERROR", "BLOCKED_AUTH", "UNAVAILABLE"}
                ):
                    report[f"{capability}_verified"] = "VERIFIED"
    return report


async def _persist_probe_report(
    *,
    provider_id: str,
    item: dict[str, Any],
    report: dict[str, Any],
    live_probe: dict[str, Any] | None = None,
    lifecycle_probe: dict[str, Any] | None = None,
    error: str = "",
) -> None:
    """Persist bounded conformance state in the provider diagnostic boundary."""

    existing = await get_provider_health(provider_id)
    existing_capabilities = (
        existing.get("capabilities")
        if isinstance(existing.get("capabilities"), dict)
        else {}
    )
    existing_conformance = (
        existing_capabilities.get("conformance")
        if isinstance(existing_capabilities.get("conformance"), dict)
        else {}
    )
    same_executable = (
        existing_conformance.get("binary_path") == str(item.get("executable_path") or "")
        and existing_conformance.get("version")
        == str(item.get("version") or "")[:160]
    )
    conformance: dict[str, Any] = (
        dict(existing_conformance) if same_executable else {}
    )
    conformance.update(
        {
            field: report.get(field)
            for field in (
                "native_auth_detected",
                "connection_verified",
                "live_model_verified",
                "structured_output_verified",
                "streaming_verified",
                "resume_verified",
                "cancel_verified",
                "cwd_isolation_verified",
                "web_search_verified",
                "last_probe_at",
                "failure_reason",
            )
        }
    )
    conformance.update(
        {
            "binary_path": str(item.get("executable_path") or ""),
            "version": str(item.get("version") or "")[:160],
        }
    )
    if live_probe is not None:
        conformance["live_probe"] = live_probe
    if lifecycle_probe is not None:
        conformance["lifecycle_probe"] = lifecycle_probe
    protocol_version = str(
        (live_probe or {}).get("trace", {}).get("protocol")
        or existing.get("protocol_version")
        or ""
    )[:80]

    await record_provider_health(
        provider_id,
        available=bool(item.get("executable_path")),
        authenticated=(
            True
            if report.get("native_auth_detected") == "VERIFIED"
            else False
            if report.get("native_auth_detected") == "BLOCKED_AUTH"
            else None
        ),
        blocked=report.get("native_auth_detected") == "BLOCKED_AUTH",
        version=str(item.get("version") or "")[:160],
        auth_mode="native_probe",
        protocol_version=protocol_version,
        capabilities={"conformance": conformance},
        error=error,
    )


async def _run_live_probe(provider_id: str, item: dict[str, Any]) -> dict[str, Any]:
    """Run a nonce-bound, schema-bound model task in an isolated cwd."""

    if provider_id not in runtime.RUNTIME_DEFINITIONS:
        raise ValueError("未知的本地 Agent")
    if not item.get("available") or not item.get("contract_compatible"):
        raise RuntimeError("本地 Agent 未安装或契约不兼容")
    nonce = f"offeru-{secrets.token_hex(12)}"
    task_id = f"cap_{secrets.token_hex(12)}"
    cwd = _probe_cwd(provider_id, task_id)
    schema = {
        "type": "object",
        "properties": {
            "nonce": {"type": "string", "const": nonce},
            "summary": {
                "type": "string",
                "const": "OfferU local agent live test",
            },
        },
        "required": ["nonce", "summary"],
        "additionalProperties": False,
    }
    result = await runtime.execute_deep_task(
        runtime.DeepTaskSpec(
            runtime_id=provider_id,
            prompt=(
                "Return only JSON with the exact schema. This is a live OfferU "
                f"conformance probe. Use this nonce exactly: {nonce}."
            ),
            cwd=cwd,
            output_schema=schema,
            timeout_seconds=300,
            task_type="agent_conformance",
            task_id=task_id,
            capability_grant={
                "offeru_operations": [],
                "data_scope": {},
                "filesystem": "task_cwd_read_only",
            },
        )
    )
    structured = result.get("structured") if isinstance(result, dict) else None
    if not isinstance(structured, dict):
        raise RuntimeError("live probe 未返回结构化 JSON 对象")
    if structured.get("nonce") != nonce or structured.get("summary") != "OfferU local agent live test":
        raise RuntimeError("live probe 返回值未通过随机 nonce 校验")
    trace = result.get("trace") if isinstance(result.get("trace"), dict) else {}
    event_count = int(trace.get("event_count") or 0)
    return {
        "verified": True,
        "binary_path": str(item.get("executable_path") or ""),
        "version": str(item.get("version") or "")[:160],
        "nonce": nonce,
        "task_id": task_id,
        "completed_at": _now(),
        "runtime_version": result.get("runtime_version"),
        "trace": {
            "protocol": trace.get("protocol"),
            "sandbox": trace.get("sandbox"),
            "schema_enforced": bool(trace.get("schema_enforced")),
            "event_count": event_count,
            "hosted_session_id": trace.get("hosted_session_id"),
            "external_session_id": trace.get("external_session_id"),
            "external_turn_id": trace.get("external_turn_id"),
            "elapsed_ms": trace.get("elapsed_ms"),
        },
    }


async def _run_codex_lifecycle_probe(item: dict[str, Any]) -> dict[str, Any]:
    """Verify Codex thread resume and turn interruption on the real adapter."""

    if not item.get("available") or not item.get("contract_compatible"):
        raise RuntimeError("Codex 未安装或契约不兼容")
    from app.services.agent_bridge.codex_adapter import (
        CodexMainLoopAdapter,
        _resolve_codex_binary,
    )

    executable = _resolve_codex_binary()
    root = _probe_cwd("codex", f"lifecycle_{secrets.token_hex(8)}")
    report: dict[str, Any] = {
        "verified": False,
        "binary_path": str(item.get("executable_path") or ""),
        "version": str(item.get("version") or "")[:160],
        "cwd": str(root),
        "resume": {"verified": False},
        "cancel": {"verified": False},
    }

    adapter = CodexMainLoopAdapter(executable=executable)
    try:
        await adapter.start()
        first = await asyncio.wait_for(
            adapter.run_turn(
                prompt=(
                    'Return exactly this JSON object and no tools: '
                    '{"resume_probe":"first"}.'
                ),
                cwd=str(root),
                tool_descriptions=[],
            ),
            timeout=300,
        )
        first_thread = adapter.thread_id
        first_turn = adapter.turn_id
        second = await asyncio.wait_for(
            adapter.resume_turn(
                prompt=(
                    'This is the resumed turn. Return exactly this JSON object '
                    'and no tools: {"resume_probe":"second"}.'
                ),
                cwd=str(root),
            ),
            timeout=300,
        )
        second_thread = adapter.thread_id
        second_turn = adapter.turn_id
        first_payload = _parse_lifecycle_message(first.get("finalMessage"))
        second_payload = _parse_lifecycle_message(second.get("finalMessage"))
        resume_verified = bool(
            first_thread
            and second_thread
            and first_thread == second_thread
            and first_turn
            and second_turn
            and first_turn != second_turn
            and first_payload == {"resume_probe": "first"}
            and second_payload == {"resume_probe": "second"}
        )
        report["resume"] = {
            "verified": resume_verified,
            "same_thread": first_thread == second_thread,
            "first_thread_id": first_thread,
            "second_thread_id": second_thread,
            "first_turn_id": first_turn,
            "second_turn_id": second_turn,
            "events": len(adapter.events()),
        }
    except Exception as exc:
        report["resume"] = {
            "verified": False,
            "failure_reason": _failure_text(exc),
        }
    finally:
        await adapter.close()

    cancel_adapter = CodexMainLoopAdapter(executable=executable)
    cancel_task: asyncio.Task[dict[str, Any]] | None = None
    try:
        await cancel_adapter.start()
        cancel_task = asyncio.create_task(
            cancel_adapter.run_turn(
                prompt=(
                    "Keep this turn running and do not return an answer yet. "
                    f"This is a cancellation probe with nonce {secrets.token_hex(8)}."
                ),
                cwd=str(root),
                tool_descriptions=[],
            )
        )
        deadline = asyncio.get_running_loop().time() + 20
        while not cancel_adapter.turn_id and asyncio.get_running_loop().time() < deadline:
            await asyncio.sleep(0.1)
        await asyncio.sleep(0.5)
        cancel_result = await cancel_adapter.cancel()
        cancelled_turn: dict[str, Any] | None = None
        task_error = ""
        try:
            cancelled_turn = await asyncio.wait_for(cancel_task, timeout=30)
        except asyncio.CancelledError:
            task_error = "cancelled_task"
        except Exception as exc:
            task_error = _failure_text(exc)
        completed_status = str(
            ((cancelled_turn or {}).get("completed") or {}).get("status") or ""
        )
        cancel_verified = bool(
            cancel_result.get("cancelled")
            and cancel_adapter.turn_id
            and completed_status != "completed"
        )
        report["cancel"] = {
            "verified": cancel_verified,
            "accepted": bool(cancel_result.get("cancelled")),
            "turn_id": cancel_adapter.turn_id,
            "completed_status": completed_status,
            "task_error": task_error,
            "events": len(cancel_adapter.events()),
        }
    except Exception as exc:
        report["cancel"] = {
            "verified": False,
            "failure_reason": _failure_text(exc),
        }
    finally:
        if cancel_task is not None and not cancel_task.done():
            cancel_task.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await cancel_task
        await cancel_adapter.close()

    report["verified"] = bool(
        report["resume"].get("verified") and report["cancel"].get("verified")
    )
    return report


async def get_local_agent_capability_matrix(
    *,
    provider_ids: Iterable[str] | None = None,
    live_provider: str | None = None,
    lifecycle_provider: str | None = None,
    refresh: bool = False,
) -> dict[str, Any]:
    """Return the provider-neutral capability matrix.

    ``live_provider`` is intentionally explicit. A normal status refresh only
    performs cheap version/help checks; a caller must opt into a real model
    turn for one provider.
    """

    selected = {
        str(item).strip().lower()
        for item in (provider_ids or runtime.RUNTIME_DEFINITIONS)
        if str(item).strip()
    }
    unknown = selected - set(runtime.RUNTIME_DEFINITIONS)
    if unknown:
        raise ValueError(f"未知的本地 Agent: {', '.join(sorted(unknown))}")
    if live_provider:
        live_provider = str(live_provider).strip().lower()
        if live_provider not in selected:
            selected.add(live_provider)
        if live_provider not in runtime.RUNTIME_DEFINITIONS:
            raise ValueError(f"未知的本地 Agent: {live_provider}")
    if lifecycle_provider:
        lifecycle_provider = str(lifecycle_provider).strip().lower()
        if lifecycle_provider not in selected:
            selected.add(lifecycle_provider)
        if lifecycle_provider not in runtime.RUNTIME_DEFINITIONS:
            raise ValueError(f"未知的本地 Agent: {lifecycle_provider}")

    detected = await runtime.list_local_executors(refresh=refresh)
    health_payload = await list_provider_health()
    health_by_id = {
        str(item.get("provider_id") or ""): item
        for item in health_payload.get("providers") or []
        if isinstance(item, dict)
    }
    reports: list[dict[str, Any]] = []
    for item in detected.get("items") or []:
        provider_id = str(item.get("id") or "")
        if provider_id not in selected:
            continue
        report = _base_report(item, health_by_id.get(provider_id, {}))
        prior = _LIVE_PROBES.get(provider_id)
        prior_matches = bool(
            prior
            and prior.get("verified")
            and prior.get("binary_path") == item.get("executable_path")
            and prior.get("version") == item.get("version")
        )
        if prior_matches:
            report.update(
                {
                    "native_auth_detected": "VERIFIED",
                    "connection_verified": "VERIFIED",
                    "live_model_verified": "VERIFIED",
                    "structured_output_verified": "VERIFIED",
                    "streaming_verified": (
                        "VERIFIED"
                        if _probe_event_count(prior) > 0
                        else "NOT_VERIFIED"
                    ),
                    "cwd_isolation_verified": "VERIFIED",
                    "last_probe_at": prior.get("completed_at") or report["last_probe_at"],
                    "live_probe": prior,
                    "failure_reason": "",
                }
            )
        if live_provider == provider_id:
            try:
                async with _PROBE_LOCK:
                    live = await _run_live_probe(provider_id, item)
                    _LIVE_PROBES[provider_id] = live
                report.update(
                    {
                        "native_auth_detected": "VERIFIED",
                        "connection_verified": "VERIFIED",
                        "live_model_verified": "VERIFIED",
                        "structured_output_verified": "VERIFIED",
                        "streaming_verified": (
                            "VERIFIED"
                            if int(live.get("trace", {}).get("event_count") or 0) > 0
                            else "NOT_VERIFIED"
                        ),
                        "cwd_isolation_verified": "VERIFIED",
                        "last_probe_at": live["completed_at"],
                        "live_probe": live,
                        "failure_reason": "",
                    }
                )
                await _persist_probe_report(
                    provider_id=provider_id,
                    item=item,
                    report=report,
                    live_probe=live,
                )
            except Exception as exc:  # probe status is data, not a hidden failure
                _LIVE_PROBES.pop(provider_id, None)
                auth_failure = _is_auth_failure(exc)
                failure_state = "BLOCKED_AUTH" if auth_failure else "ERROR"
                report["native_auth_detected"] = (
                    "BLOCKED_AUTH" if auth_failure else report["native_auth_detected"]
                )
                report["connection_verified"] = (
                    "BLOCKED_AUTH" if auth_failure else report["connection_verified"]
                )
                report["live_model_verified"] = failure_state
                report["structured_output_verified"] = failure_state
                report["last_probe_at"] = _now()
                report["failure_reason"] = _failure_text(exc)
                _LIVE_PROBES.pop(provider_id, None)
                try:
                    await _persist_probe_report(
                        provider_id=provider_id,
                        item=item,
                        report=report,
                        error=report["failure_reason"],
                    )
                except Exception:
                    # A diagnostic snapshot must never turn the original
                    # provider failure into a false success or a new crash.
                    pass
        if lifecycle_provider == provider_id:
            try:
                if provider_id != "codex":
                    raise RuntimeError(
                        "当前 lifecycle probe 仅实现 Codex App Server；其他 Agent 保留声明状态"
                    )
                async with _PROBE_LOCK:
                    lifecycle = await _run_codex_lifecycle_probe(item)
                report["lifecycle_probe"] = lifecycle
                for capability in ("resume", "cancel"):
                    evidence = lifecycle.get(capability)
                    if isinstance(evidence, dict) and evidence.get("verified") is True:
                        report[f"{capability}_verified"] = "VERIFIED"
                    else:
                        report[f"{capability}_verified"] = "ERROR"
                if not lifecycle.get("verified"):
                    report["failure_reason"] = _failure_text(
                        "Codex lifecycle probe did not verify both resume and cancel"
                    )
                await _persist_probe_report(
                    provider_id=provider_id,
                    item=item,
                    report=report,
                    lifecycle_probe=lifecycle,
                )
            except Exception as exc:
                auth_failure = _is_auth_failure(exc)
                failure_state = "BLOCKED_AUTH" if auth_failure else "ERROR"
                lifecycle_failure = {
                    "verified": False,
                    "binary_path": str(item.get("executable_path") or ""),
                    "version": str(item.get("version") or "")[:160],
                    "resume": {"verified": False},
                    "cancel": {"verified": False},
                    "failure_reason": _failure_text(exc),
                }
                report["resume_verified"] = failure_state
                report["cancel_verified"] = failure_state
                report["last_probe_at"] = _now()
                report["failure_reason"] = lifecycle_failure["failure_reason"]
                report["lifecycle_probe"] = lifecycle_failure
                try:
                    await _persist_probe_report(
                        provider_id=provider_id,
                        item=item,
                        report=report,
                        lifecycle_probe=lifecycle_failure,
                        error=report["failure_reason"],
                    )
                except Exception:
                    pass
        reports.append(report)
    reports.sort(key=lambda item: item["provider_id"])
    return {
        "schema": "offeru.local_agent_capability_report.v1",
        "checked_at": _now(),
        "live_provider": live_provider or "",
        "items": reports,
        "summary": {
            "providers": len(reports),
            "installed": sum(item["installed"] == "VERIFIED" for item in reports),
            "live_model_verified": sum(
                item["live_model_verified"] == "VERIFIED" for item in reports
            ),
        },
    }


async def get_local_agent_capability_report(
    provider_id: str,
    *,
    live: bool = False,
    lifecycle: bool = False,
    refresh: bool = False,
) -> dict[str, Any]:
    provider = str(provider_id or "").strip().lower()
    if not provider:
        raise ValueError("provider_id 不能为空")
    matrix = await get_local_agent_capability_matrix(
        provider_ids=[provider],
        live_provider=provider if live else None,
        lifecycle_provider=provider if lifecycle else None,
        refresh=refresh,
    )
    return matrix["items"][0] if matrix["items"] else {
        "provider_id": provider,
        "installed": "UNAVAILABLE",
        "failure_reason": "未发现本地执行器",
    }


__all__ = [
    "CAPABILITY_STATES",
    "get_local_agent_capability_matrix",
    "get_local_agent_capability_report",
]
