"""End-to-end Codex -> OfferU Bridge conformance runner.

The runner drives the same protocol messages as an external Harness and keeps
all business reads behind the Operation Registry.
"""

from __future__ import annotations

import json
import secrets
import asyncio
import contextlib
import os
from pathlib import Path
from typing import Any

from app.ops import get_operation_schema, list_operations
from app.services.agent_bridge.codex_adapter import CodexMainLoopAdapter, _resolve_codex_binary
from app.services.agent_bridge.errors import BridgeProtocolError
from app.services.agent_bridge.run_coordinator import (
    LEASE_TTL_SECONDS,
    create_bridge_pairing,
)
from app.services.agent_bridge.server import BridgeSession
from app.services.agent_run_state import create_agent_run
from app.services.agent_skill_registry import registry_snapshot
from app.services.security_redaction import redact_sensitive_value, safe_error_message


_DISCOVERY_TOOLS = {
    "offeru_doctor",
    "offeru_manifest",
    "offeru_agent_playbook",
    "offeru_operation_list",
    "offeru_operation_schema",
}
_BUSINESS_TO_OPERATIONS = {
    "offeru_get_profile": "get_profile",
    "offeru_get_current_view": "get_current_view",
    "offeru_get_pre_application_state": "get_pre_application_state",
    "offeru_get_job": "get_job",
    "offeru_list_jobs": "list_jobs",
    "offeru_list_resumes": "list_resumes",
    "offeru_list_profile_evidence": "list_profile_evidence",
    "offeru_list_application_progress_candidates": "list_application_progress_candidates",
    "offeru_list_learning_observations": "list_learning_observations",
    "offeru_list_memory_inbox": "list_memory_inbox",
    "offeru_get_profile_evolution_report": "get_profile_evolution_report",
    "offeru_list_email_accounts": "list_email_accounts",
    "offeru_list_email_sync_runs": "list_email_sync_runs",
}

# A populated Career context is more than a Profile snapshot. Keep this set
# explicit so a green Bridge conformance run proves that the external Agent
# can discover and read the source/evolution surfaces it is expected to use.
# These are all Registry reads; no mutation is granted by this runner.
_REQUIRED_CONTEXT_READS = frozenset(
    {
        "get_profile",
        "list_resumes",
        "list_jobs",
        "list_learning_observations",
        "list_memory_inbox",
        "get_profile_evolution_report",
        "list_email_accounts",
        "list_email_sync_runs",
    }
)

# A real Profile can contain a long observation/evolution history.  The
# conformance turn must read every Career surface, while keeping each tool
# response bounded enough for a single model context.  These caps apply only
# to this read-only probe; the underlying Registry operation limits remain
# unchanged for product callers.
_CONFORMANCE_READ_LIMITS = {
    "list_application_progress_candidates": 50,
    "list_profile_evidence": 50,
    "list_learning_observations": 25,
    "list_memory_inbox": 25,
    "get_profile_evolution_report": 25,
    "list_email_accounts": 25,
    "list_email_sync_runs": 25,
}


def _bridge_cwd(run_id: str) -> Path:
    """Create the isolated Bridge cwd on the configured non-system drive."""

    configured = str(os.environ.get("OFFERU_TEST_TEMP_ROOT") or "").strip()
    if configured:
        root = Path(configured).expanduser()
    elif os.name == "nt":
        root = Path(r"H:\tmp")
    else:
        root = Path("/tmp")
    cwd = root / "offeru" / "bridge-conformance" / run_id
    cwd.mkdir(parents=True, exist_ok=True)
    return cwd


def _request(message_type: str, payload: dict[str, Any], sequence: int) -> dict[str, Any]:
    return {
        "v": 1,
        "id": f"conformance-{sequence}",
        "type": message_type,
        "payload": payload,
    }


def _tool_descriptions() -> list[str]:
    return [
        "offeru_doctor() — read OfferU health and local control-plane readiness",
        "offeru_manifest() — read the OfferU control manifest",
        "offeru_agent_playbook() — read the external-agent operating contract",
        "offeru_operation_list() — discover granted atomic operations",
        "offeru_operation_schema(operation) — inspect one discovered operation schema",
        "offeru_get_profile() — read the current Career Profile",
        "offeru_get_current_view() — read the UI selected object and route",
        "offeru_get_pre_application_state(job_id) — read pre-application state",
        "offeru_get_job(job_id) — read one saved job",
        "offeru_list_jobs() — read saved jobs",
        "offeru_list_resumes() — read saved resumes",
        "offeru_list_profile_evidence() — read source-linked profile evidence",
        "offeru_list_application_progress_candidates() — read pending email progress candidates",
        "offeru_list_learning_observations() — read career observations",
        "offeru_list_memory_inbox() — read pending profile candidates",
        "offeru_get_profile_evolution_report() — read the deterministic Profile evolution report",
        "offeru_list_email_accounts() — read connected email account metadata",
        "offeru_list_email_sync_runs() — read email sync status",
    ]


async def run_codex_offeru_conformance(*, timeout_seconds: int = 420) -> dict[str, Any]:
    """Run one real Codex turn against an isolated Bridge Run."""

    run_id = f"run_{secrets.token_hex(8)}"
    task_id = f"conformance_{secrets.token_hex(8)}"
    run = await create_agent_run(
        conversation_id=f"offeru-conformance-{secrets.token_hex(8)}",
        goal="Codex real discovery and read-grounding conformance",
        mode="conformance",
        skill_id="offeru-operator",
        skill_version="conformance-v1",
        actions=[],
        exit_criteria=[
            "Codex discovers OfferU control capabilities",
            "career answers are grounded in Operation Registry reads",
            "no mutation operation is invoked",
        ],
        llm_runtime={"provider_id": "codex", "conformance": True},
        run_id=run_id,
    )
    pairing = await create_bridge_pairing(run_id=run_id)
    session = BridgeSession()
    calls: list[dict[str, Any]] = []
    forbidden: list[dict[str, Any]] = []
    unnecessary: list[dict[str, Any]] = []
    discovery_seen: list[str] = []
    operation_outputs: dict[str, Any] = {}
    request_sequence = 0

    async def bridge_request(message_type: str, payload: dict[str, Any]) -> dict[str, Any]:
        nonlocal request_sequence
        request_sequence += 1
        return await session.handle(_request(message_type, payload, request_sequence))

    hello = await bridge_request(
        "hello",
        {
            "adapter": {"name": "codex-app-server", "version": "conformance-v1"},
            "harness": {"name": "offeru-conformance", "version": "1"},
            "protocols": [1],
            "capabilities": {
                "sessionResume": True,
                "steer": False,
                "interrupt": True,
                "toolSuspendResume": True,
                "eventStream": True,
                "workspaceIsolation": "native_tools_disabled",
                "nativeClient": True,
            },
        },
    )
    await bridge_request("pairing.request", {"bootstrapToken": pairing["bootstrapToken"]})
    attached = await bridge_request(
        "run.attach",
        {
            "harness": {"name": "offeru-conformance", "version": "1"},
            "adapter": {"name": "codex-app-server", "version": "conformance-v1"},
            "harnessSessionId": task_id,
            "lastEventSeq": 0,
        },
    )
    context_version = int((attached.get("result") or {}).get("contextVersion") or 0)
    lease_id = str((attached.get("result") or {}).get("leaseId") or "")
    if not lease_id:
        raise RuntimeError("Bridge attach 未返回 leaseId")
    lease_errors: list[str] = []

    async def renew_lease_while_running() -> None:
        """Keep a long real-model turn inside the Bridge lease window."""

        interval = max(10, min(30, LEASE_TTL_SECONDS // 3))
        while True:
            await asyncio.sleep(interval)
            try:
                renewed = await bridge_request(
                    "run.lease.renew", {"leaseId": lease_id}
                )
                renewed_id = str((renewed.get("result") or {}).get("leaseId") or "")
                if renewed_id and renewed_id != lease_id:
                    lease_errors.append("Bridge lease id changed during renewal")
                    return
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # heartbeat failures are surfaced below
                lease_errors.append(safe_error_message(exc))
                return

    async def invoke_registry(operation: str, arguments: dict[str, Any]) -> dict[str, Any]:
        effective_arguments = dict(arguments)
        limit_cap = _CONFORMANCE_READ_LIMITS.get(operation)
        if limit_cap is not None:
            try:
                requested_limit = int(effective_arguments.get("limit", limit_cap))
            except (TypeError, ValueError):
                requested_limit = limit_cap
            effective_arguments["limit"] = max(1, min(requested_limit, limit_cap))
        result = await bridge_request(
            "operation.invoke",
            {
                "operation": operation,
                "arguments": effective_arguments,
                "idempotencyKey": f"{run_id}:{len(calls) + 1}",
                "contextVersion": context_version,
            },
        )
        value = (result.get("result") or {}).get("value")
        operation_outputs[operation] = value
        return result

    async def on_operation(name: str, arguments: dict[str, Any]) -> dict[str, Any]:
        clean_name = str(name or "").strip()
        clean_arguments = arguments if isinstance(arguments, dict) else {}
        calls.append(
            {"tool": clean_name, "arguments": redact_sensitive_value(clean_arguments)}
        )
        if clean_name in _DISCOVERY_TOOLS:
            discovery_seen.append(clean_name)
            if clean_name == "offeru_doctor":
                return {
                    "service": "OfferU",
                    "bridge": "paired",
                    "operation_registry": "available",
                    "operation_count": len(list_operations()),
                    "read_only_run": True,
                }
            if clean_name == "offeru_manifest":
                snapshot = registry_snapshot(list_operations())
                return {
                    "schema": snapshot.get("schema"),
                    "operation_count": len(list_operations()),
                    "skills": len(snapshot.get("skills") or []),
                    "control_plane": "Operation Registry",
                }
            if clean_name == "offeru_agent_playbook":
                result = await invoke_registry("agent_playbook", {"detail": "full"})
                return result.get("result") or {}
            if clean_name == "offeru_operation_list":
                result = await bridge_request("operation.list", {})
                return result.get("result") or {}
            operation = str(clean_arguments.get("operation") or "")
            result = await bridge_request("operation.schema", {"operation": operation})
            return result.get("result") or {}

        operation = _BUSINESS_TO_OPERATIONS.get(clean_name)
        if operation is None:
            forbidden.append({"tool": clean_name, "reason": "tool_not_granted"})
            raise BridgeProtocolError(
                "grant_denied",
                "Only the declared OfferU discovery and read tools are available",
                details={"operation": clean_name},
            )
        schema = get_operation_schema(operation)
        if not schema or schema.get("side_effects") != ["read"]:
            forbidden.append({"tool": clean_name, "reason": "operation_not_read_only"})
            raise BridgeProtocolError(
                "grant_denied",
                "Operation is not a read-only Registry grant",
                details={"operation": operation},
            )
        if operation in operation_outputs:
            unnecessary.append({"tool": clean_name, "reason": "duplicate_operation_read"})
            return {
                "already_read": True,
                "operation": operation,
                "message": "This read-only operation was already completed; use its first result.",
            }
        result = await invoke_registry(operation, clean_arguments)
        return result.get("result") or {}

    adapter: CodexMainLoopAdapter | None = None
    result: dict[str, Any] = {}
    failure = ""
    runtime_diagnostics: dict[str, Any] = {}
    try:
        adapter = CodexMainLoopAdapter(
            executable=_resolve_codex_binary(),
            turn_timeout=max(30, min(int(timeout_seconds) - 15, 900)),
        )
        adapter.on_operation = on_operation
        await adapter.start()
        prompt = """
You are running the OfferU real Bridge conformance task. Treat the host and its
available operations as unknown. First inspect the host's own health, manifest,
agent playbook, operation catalogue, and the schema for the read-only Profile
operation you discover. Decide which tools to call from the supplied tool
descriptions and their outputs; do not assume an operation name from this
prompt. Call each discovery tool at most once. Then read the current Profile
and the saved resumes, jobs, active application progress, linked Profile
evidence, learning observations, pending memory candidates, Profile evolution
report, connected email accounts, and email sync runs. Call each corresponding
read-only business tool exactly once, even when a surface is empty, and use a
small limit (no more than 25 items) for list-style reads. After those reads,
stop calling tools and return the JSON object. Use the actual Operation Registry
outputs as the only source for career facts. Never write, triage, confirm, send
email, or call a tool that is not granted. If data is absent, say it is unknown
or evidence is insufficient. Do not infer facts from this prompt.

Return exactly one JSON object with these keys:
{
  "profile_facts": [string],
  "resume_count": integer,
  "job_count": integer,
  "active_progress_count": integer,
  "weak_evidence": [string],
  "grounded_in_operations": [string]
}

Career questions: What career facts are in the current Profile? How many resumes
and jobs are present? Which application progress candidates are active? Which
profile evidence is weakest? How many learning observations and pending memory
candidates are present? What does the Profile evolution report say? What email
accounts and sync runs are visible, and are they read-only? List the Registry
operation names whose outputs you actually used in the answer.
"""
        lease_task = asyncio.create_task(renew_lease_while_running())
        try:
            await asyncio.wait_for(
                adapter.run_turn(
                    prompt=prompt,
                    cwd=str(_bridge_cwd(run_id)),
                    tool_descriptions=_tool_descriptions(),
                ),
                timeout=max(30, min(int(timeout_seconds), 900)),
            )
        finally:
            lease_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await lease_task
        if lease_errors:
            raise RuntimeError("Bridge lease renewal failed: " + "; ".join(lease_errors))
        raw_message = adapter._final_message or "".join(adapter._message_parts)
        try:
            parsed = json.loads(raw_message.strip())
        except json.JSONDecodeError:
            from app.agents.llm import extract_json

            parsed = extract_json(raw_message)
        if not isinstance(parsed, dict):
            raise ValueError("Codex Bridge conformance 未返回 JSON object")
        required = {
            "profile_facts",
            "resume_count",
            "job_count",
            "active_progress_count",
            "weak_evidence",
            "grounded_in_operations",
        }
        missing = required - set(parsed)
        if missing:
            raise ValueError(
                f"Codex Bridge conformance 缺少字段: {', '.join(sorted(missing))}"
            )
        result = redact_sensitive_value(parsed)
        if not isinstance(result, dict):
            raise ValueError("Codex Bridge conformance 输出无法安全序列化")
        seen_discovery = set(discovery_seen)
        missing_discovery = _DISCOVERY_TOOLS - seen_discovery
        if missing_discovery:
            raise ValueError(
                "Codex 未完成 OfferU 能力发现: "
                + ", ".join(sorted(missing_discovery))
            )
        business_call_names = [
            name for name in (item.get("tool") for item in calls)
            if name in _BUSINESS_TO_OPERATIONS
        ]
        if not business_call_names:
            raise ValueError("Codex 未调用任何 OfferU 业务只读 Operation")
        grounded_names = result.get("grounded_in_operations")
        used_operation_names = {
            _BUSINESS_TO_OPERATIONS.get(name) for name in business_call_names
        }
        if not isinstance(grounded_names, list) or not grounded_names:
            raise ValueError("Codex 未返回实际使用的 Operation 名称")
        if not all(str(name) in used_operation_names for name in grounded_names):
            raise ValueError("Codex 的职业回答未完全由实际 Operation 输出支撑")
        missing_context_reads = sorted(_REQUIRED_CONTEXT_READS - used_operation_names)
        if missing_context_reads:
            raise ValueError(
                "Codex 未读取完整 Career context: "
                + ", ".join(missing_context_reads)
            )
        if forbidden:
            raise ValueError("Codex 尝试调用未授予的工具")
        await bridge_request(
            "run.finish",
            {
                "status": "completed",
                "summary": "Codex discovered OfferU and completed read-grounded career conformance",
                "details": {"toolCalls": len(calls), "mutations": 0},
            },
        )
    except Exception as exc:
        failure = safe_error_message(exc)
        if adapter is not None:
            event_methods: dict[str, int] = {}
            for event in adapter.events():
                method = str(event.get("method") or "<response>")
                event_methods[method] = event_methods.get(method, 0) + 1
            runtime_diagnostics = {
                "event_count": len(adapter.events()),
                "event_methods": event_methods,
                "final_message_chars": len(adapter._final_message or ""),
                "streamed_message_chars": sum(
                    len(part) for part in adapter._message_parts
                ),
                "reader_error": safe_error_message(adapter._reader_exit_error)
                if adapter._reader_exit_error
                else "",
            }
        try:
            await bridge_request(
                "run.finish",
                {"status": "failed", "summary": "Codex Bridge conformance failed"},
            )
        except Exception:
            pass
    finally:
        if adapter is not None:
            await adapter.close()

    operation_names = [str(item.get("tool") or "") for item in calls]
    business_call_names = [name for name in operation_names if name in _BUSINESS_TO_OPERATIONS]
    grounded_names = result.get("grounded_in_operations") if isinstance(result, dict) else []
    used_operation_names = {
        _BUSINESS_TO_OPERATIONS.get(tool) for tool in business_call_names
    }
    grounded = isinstance(grounded_names, list) and all(
        str(name) in used_operation_names for name in grounded_names
    )
    missing_context_reads = sorted(_REQUIRED_CONTEXT_READS - used_operation_names)
    return {
        "schema": "offeru.codex_offeru_conformance.v1",
        "ok": not bool(failure)
        and all(name in discovery_seen for name in _DISCOVERY_TOOLS)
        and bool(business_call_names)
        and not missing_context_reads
        and not forbidden
        and grounded,
        "run_id": run_id,
        "task_id": task_id,
        "protocol": "codex-app-server-jsonl-v2",
        "handshake": {
            "hello": bool(hello.get("ok", True)),
            "paired": True,
            "attached": True,
            "context_version": context_version,
        },
        "discovery": {
            "required": sorted(_DISCOVERY_TOOLS),
            "seen": discovery_seen,
            "operation_list_discovered": "offeru_operation_list" in discovery_seen,
            "schema_discovered": "offeru_operation_schema" in discovery_seen,
        },
        "tool_calls": calls,
        "business_operations": sorted(
            {_BUSINESS_TO_OPERATIONS[name] for name in business_call_names}
        ),
        "required_context_reads": sorted(_REQUIRED_CONTEXT_READS),
        "missing_context_reads": missing_context_reads,
        "unnecessary_operations": unnecessary,
        "forbidden_operations": forbidden,
        "mutations": 0,
        "grounding_verified": grounded,
        "result": result,
        "operation_outputs": redact_sensitive_value(operation_outputs),
        "runtime_diagnostics": runtime_diagnostics,
        "failure_reason": failure,
    }


__all__ = ["run_codex_offeru_conformance"]
