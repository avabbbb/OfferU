"""Agent Bridge stdio server (Slice 1).

Persistent bidirectional JSONL loop over stdin/stdout. Wire rules from
docs/architecture/agent-bridge-protocol.md:

- one JSON object per line; stdout carries responses and server events only;
- diagnostics go to stderr and never echo request payloads;
- every request before `hello` is rejected; Run-bound messages require a
  successful `run.attach`;
- the single-writer lease gates event append, operation invoke, and finish.

Slice 1 scope: hello, pairing (bootstrap token), run.attach, lease renew,
context/skill snapshot, operation.list/schema/invoke (read-only),
proposal.get, event.append/follow, run.finish. No mutations, no MCP.
"""

from __future__ import annotations

import asyncio
import json
import sys
from typing import Any, TextIO

from app.services.agent_bridge.errors import BridgeProtocolError
from app.services.agent_bridge.event_stream import (
    append_standard_event,
    follow_events,
)
from app.services.agent_bridge.operation_gateway import (
    confirm_proposal,
    granted_operations,
    invoke_operation,
    invoke_workspace_delegate,
    load_proposal_state,
)
from app.services.agent_bridge.protocol import (
    BRIDGE_VERSION,
    PROTOCOL_VERSION,
    RUN_REQUIRED_MESSAGE_TYPES,
    error_response,
    parse_request_line,
    success_response,
    validate_request,
)
from app.services.agent_bridge.run_coordinator import (
    LeaseLostError,
    RunCoordinator,
    consume_bootstrap_token,
)
from app.services.artifact_workspace import (
    ArtifactWorkspaceManager,
    WorkspaceError,
)

MAX_LINE_BYTES = 1 << 20
OUTPUT_QUEUE_LIMIT = 256


class BridgeSession:
    """State machine for one stdio Bridge connection."""

    def __init__(self) -> None:
        self.hello_done = False
        self.run_id: str | None = None
        self.lease_id: str | None = None
        self.context_version = 0
        self.coordinator = RunCoordinator()

    async def handle(self, request: Any) -> dict[str, Any]:
        if not isinstance(request, dict):
            request = request.model_dump(by_alias=True, exclude_none=True)
        message_type = str(request.get("type") or "")
        request_id = str(request.get("id") or "")
        payload = request.get("payload") if isinstance(request.get("payload"), dict) else {}

        if not self.hello_done:
            if message_type != "hello":
                raise BridgeProtocolError(
                    "schema_invalid",
                    "The first request must be hello",
                    details={"type": message_type},
                    request_id=request_id,
                )
            return self._hello(request_id, payload)

        if message_type == "hello":
            raise BridgeProtocolError(
                "schema_invalid",
                "hello is only valid before handshake completes",
                request_id=request_id,
            )

        if message_type == "pairing.request":
            return await self._pairing_request(request_id, payload)
        if message_type == "pairing.status":
            return success_response(
                request_id,
                {
                    "paired": self.run_id is not None,
                    "runId": self.run_id,
                },
            )

        if self.run_id is None:
            raise BridgeProtocolError(
                "pairing_required",
                "No Run is attached to this connection",
                request_id=request_id,
            )

        if message_type == "run.attach":
            return await self._attach(request_id, payload)
        if message_type == "run.lease.renew":
            return await self._renew_lease(request_id, payload)
        if message_type == "context.snapshot":
            return await self._context_snapshot(request_id, payload)
        if message_type == "skill.snapshot":
            return success_response(request_id, self._skill_snapshot())
        if message_type == "operation.list":
            return success_response(request_id, {"operations": granted_operations()})
        if message_type == "operation.schema":
            name = str(payload.get("operation") or "")
            schema = next(
                (item for item in granted_operations() if item.get("name") == name),
                None,
            )
            if schema is None:
                raise BridgeProtocolError(
                    "grant_denied",
                    "Operation is not granted for this Run",
                    {"operation": name},
                    request_id=request_id,
                )
            return success_response(request_id, {"schema": schema})
        if message_type == "operation.invoke":
            return await self._invoke(request_id, payload)
        if message_type == "proposal.get":
            return await self._proposal_get(request_id, payload)
        if message_type == "proposal.confirm":
            return await self._proposal_confirm(request_id, payload)
        if message_type == "workspace.resolve":
            return self._workspace_resolve(request_id, payload)
        if message_type == "workspace.context":
            return await self._workspace_context(request_id, payload)
        if message_type == "workspace.delegate":
            return await self._workspace_delegate(request_id, payload)
        if message_type == "event.append":
            return await self._event_append(request_id, payload)
        if message_type == "event.follow":
            return await self._event_follow(request_id, payload)
        if message_type == "run.finish":
            return await self._finish(request_id, payload)

        raise BridgeProtocolError(
            "schema_invalid",
            "Unhandled Agent Bridge request type",
            details={"type": message_type},
            request_id=request_id,
        )

    # ---- handlers ----

    def _hello(self, request_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        protocols = payload.get("protocols")
        if not isinstance(protocols, list) or PROTOCOL_VERSION not in protocols:
            raise BridgeProtocolError(
                "protocol_mismatch",
                "No common protocol version",
                details={
                    "requested": protocols,
                    "supported": [PROTOCOL_VERSION],
                },
                request_id=request_id,
            )
        self.hello_done = True
        return success_response(
            request_id,
            {
                "protocolVersion": PROTOCOL_VERSION,
                "bridgeVersion": BRIDGE_VERSION,
                "paired": False,
                "constraints": {
                    "runRequiredMessageTypes": list(RUN_REQUIRED_MESSAGE_TYPES),
                    "readOnly": True,
                },
            },
        )

    async def _pairing_request(
        self, request_id: str, payload: dict[str, Any]
    ) -> dict[str, Any]:
        token = str(payload.get("bootstrapToken") or "")
        redeemed = await consume_bootstrap_token(token)
        if redeemed is None:
            raise BridgeProtocolError(
                "pairing_required",
                "Bootstrap token is missing, unknown, or already consumed",
                request_id=request_id,
            )
        self.run_id = str(redeemed.get("runId") or "")
        return success_response(
            request_id,
            {
                "paired": True,
                "pairingId": redeemed.get("pairingId"),
                "runId": self.run_id,
                "attached": False,
            },
        )

    async def _attach(self, request_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        harness = payload.get("harness") if isinstance(payload.get("harness"), dict) else {}
        adapter = payload.get("adapter") if isinstance(payload.get("adapter"), dict) else {}
        try:
            result = await self.coordinator.attach(
                run_id=str(self.run_id),
                harness=harness,
                adapter=adapter,
                harness_session_id=str(payload.get("harnessSessionId") or ""),
                last_event_seq=int(payload.get("lastEventSeq") or 0),
            )
        except LookupError as exc:
            raise BridgeProtocolError(
                "run_not_found",
                str(exc),
                request_id=request_id,
            ) from exc
        except ValueError as exc:
            raise BridgeProtocolError(
                "run_not_found",
                str(exc),
                request_id=request_id,
            ) from exc
        self.lease_id = str(result["leaseId"])
        self.context_version = int(result["contextVersion"])
        # Slice 4: every attached Run gets a confined artifact workspace.
        workspace = ArtifactWorkspaceManager(str(self.run_id))
        try:
            manifest = workspace.verify()
        except WorkspaceError:
            manifest = workspace.create(owner="deepseek-harness")
        result["workspace"] = {
            "runId": self.run_id,
            "root": str(workspace.root / self.run_id),
            "manifest": manifest,
            "confined": True,
        }
        return success_response(request_id, result)

    async def _require_lease(self, request_id: str) -> None:
        try:
            await self.coordinator.assert_lease(
                run_id=str(self.run_id),
                lease_id=str(self.lease_id or ""),
            )
        except LeaseLostError as exc:
            raise BridgeProtocolError(
                "lease_lost",
                "The single-writer lease is held by another connection or expired",
                retryable=True,
                request_id=request_id,
            ) from exc

    async def _renew_lease(
        self, request_id: str, payload: dict[str, Any]
    ) -> dict[str, Any]:
        try:
            result = await self.coordinator.renew_lease(
                run_id=str(self.run_id),
                lease_id=str(payload.get("leaseId") or "") or None,
            )
        except LeaseLostError as exc:
            raise BridgeProtocolError(
                "lease_lost",
                str(exc),
                retryable=True,
                request_id=request_id,
            ) from exc
        self.lease_id = str(result["leaseId"])
        return success_response(request_id, result)

    def _workspace_resolve(
        self, request_id: str, payload: dict[str, Any]
    ) -> dict[str, Any]:
        """Resolve a path INSIDE the Run's confined workspace (Slice 4).

        The only path a Run's native tools may touch. Any traversal,
        absolute, or symlink/junction escape is rejected with a protocol
        error; the resolved absolute path is returned for tool cwd use.
        """
        workspace = ArtifactWorkspaceManager(str(self.run_id))
        try:
            relative = str(payload.get("relative") or "")
            resolved = workspace.resolve_inside(relative)
        except WorkspaceError as exc:
            raise BridgeProtocolError(
                "path_escape_blocked",
                str(exc),
                request_id=request_id,
            ) from exc
        return success_response(
            request_id,
            {
                "runId": self.run_id,
                "relative": relative,
                "resolved": str(resolved),
                "confined": True,
            },
        )

    async def _workspace_context(
        self, request_id: str, payload: dict[str, Any]
    ) -> dict[str, Any]:
        """Return the projected Run context (Job + confirmed profile facts)."""
        from app.services.context_projector import ContextProjector

        job_id = int(payload.get("jobId") or 0)
        workspace = ArtifactWorkspaceManager(str(self.run_id))
        try:
            workspace.verify()
            context = await ContextProjector(workspace).project(job_id=job_id)
        except (WorkspaceError, ValueError) as exc:
            raise BridgeProtocolError(
                "context_unavailable",
                str(exc),
                request_id=request_id,
            ) from exc
        return success_response(request_id, context)

    async def _workspace_delegate(
        self, request_id: str, payload: dict[str, Any]
    ) -> dict[str, Any]:
        """Queue a bounded workspace task through the Operation Registry."""
        runtime_id = str(payload.get("runtimeId") or "codex")
        prompt = str(payload.get("prompt") or "").strip()
        if not prompt:
            raise BridgeProtocolError(
                "schema_invalid",
                "workspace.delegate requires a non-empty prompt",
                request_id=request_id,
            )
        job_id = int(payload.get("jobId") or 0)
        timeout_seconds = int(payload.get("timeoutSeconds") or 240)
        web_search_mode = str(payload.get("webSearchMode") or "disabled")
        workspace = ArtifactWorkspaceManager(str(self.run_id))
        try:
            workspace.verify()
        except WorkspaceError as exc:
            raise BridgeProtocolError(
                "run_not_found",
                str(exc),
                request_id=request_id,
            ) from exc
        try:
            result = await invoke_workspace_delegate(
                arguments={
                    "run_id": str(self.run_id),
                    "job_id": job_id,
                    "runtime_id": runtime_id,
                    "prompt": prompt,
                    "timeout_seconds": max(1, min(timeout_seconds, 3600)),
                    "web_search_mode": web_search_mode,
                }
            )
        except ValueError as exc:
            raise BridgeProtocolError("context_unavailable", str(exc), request_id=request_id) from exc
        except RuntimeError as exc:
            raise BridgeProtocolError(
                "backpressure",
                str(exc),
                retryable=True,
                request_id=request_id,
            ) from exc
        if result.get("requiresConfirmation"):
            await append_standard_event(
                run_id=str(self.run_id),
                event_type="operation.proposal_pending",
                payload={
                    "operation": "delegate_career_task",
                    "proposalRunId": (result.get("proposal") or {}).get("runId"),
                    "surface": "bridge",
                },
            )
        return success_response(
            request_id,
            {
                "runId": self.run_id,
                "jobId": job_id,
                "queued": not bool(result.get("completed")),
                "workspace": str(workspace.workspace_dir),
                **result,
            },
        )

    async def _context_snapshot(
        self, request_id: str, payload: dict[str, Any]
    ) -> dict[str, Any]:
        requested = payload.get("contextVersion")
        if requested is not None and int(requested) != self.context_version:
            raise BridgeProtocolError(
                "context_stale",
                "Snapshot was requested against a stale context version",
                retryable=True,
                details={"current": self.context_version},
                request_id=request_id,
            )
        from app.services.agent_run_state import load_agent_run

        run = await load_agent_run(str(self.run_id))
        if run is None:
            raise BridgeProtocolError(
                "run_not_found",
                f"Agent Run {self.run_id} does not exist",
                request_id=request_id,
            )
        task = run.get("task_id") or ""
        return success_response(
            request_id,
            {
                "contextVersion": self.context_version,
                "task": {"taskId": task},
                "goal": str(run.get("goal") or ""),
                "skill": {
                    "id": str(run.get("skill_id") or ""),
                    "version": str(run.get("skill_version") or ""),
                },
                "grantedOperations": sorted(
                    item.get("name") for item in granted_operations()
                ),
            },
        )

    def _skill_snapshot(self) -> dict[str, Any]:
        from app.services.agent_skill_registry import registry_snapshot

        snapshot = registry_snapshot()
        skills = [
            skill
            for skill in snapshot.get("skills", [])
            if set(skill.get("allowed_tools") or []) & {op["name"] for op in granted_operations()}
        ]
        return {
            "skills": skills,
            "grantedOperations": sorted(op["name"] for op in granted_operations()),
        }

    async def _invoke(self, request_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        await self._require_lease(request_id)
        context_version = int(payload.get("contextVersion") or 0)
        if context_version != self.context_version:
            raise BridgeProtocolError(
                "context_stale",
                "Invoke used a stale context version; re-read context.snapshot",
                retryable=True,
                details={"current": self.context_version},
                request_id=request_id,
            )
        operation = str(payload.get("operation") or "")
        arguments = (
            payload.get("arguments") if isinstance(payload.get("arguments"), dict) else {}
        )
        idempotency_key = str(payload.get("idempotencyKey") or "")
        result = await invoke_operation(
            operation=operation,
            arguments=arguments,
        )
        result = dict(result)
        if result.get("requiresConfirmation"):
            await append_standard_event(
                run_id=str(self.run_id),
                event_type="operation.proposal_pending",
                payload={
                    "operation": operation,
                    "proposalRunId": (result.get("proposal") or {}).get("runId"),
                    "idempotencyKey": idempotency_key,
                    "surface": "bridge",
                },
            )
        else:
            await append_standard_event(
                run_id=str(self.run_id),
                event_type="operation.completed",
                payload={
                    "operation": operation,
                    "idempotencyKey": idempotency_key,
                    "surface": "bridge",
                },
            )
        return success_response(request_id, result)

    async def _proposal_get(
        self, request_id: str, payload: dict[str, Any]
    ) -> dict[str, Any]:
        proposal_run_id = str(payload.get("proposalId") or "")
        state = await load_proposal_state(run_id=proposal_run_id)
        return success_response(request_id, state)

    async def _proposal_confirm(
        self, request_id: str, payload: dict[str, Any]
    ) -> dict[str, Any]:
        # The single-writer lease does NOT gate confirmation: the approver is
        # the human in the OfferU overlay, a different principal from the
        # Bridge writer. Idempotency lives in confirm_operation_proposal.
        action_id = str(payload.get("actionId") or "")
        result = await confirm_proposal(
            run_id=str(payload.get("proposalId") or ""),
            action_id=action_id,
        )
        await append_standard_event(
            run_id=str(self.run_id),
            event_type="operation.confirmed",
            payload={
                "proposalRunId": str(payload.get("proposalId") or ""),
                "actionId": action_id,
                "surface": "bridge_overlay",
            },
        )
        return success_response(request_id, result)

    async def _event_append(
        self, request_id: str, payload: dict[str, Any]
    ) -> dict[str, Any]:
        await self._require_lease(request_id)
        row = await append_standard_event(
            run_id=str(self.run_id),
            event_type=str(payload.get("type") or ""),
            payload=payload.get("payload") if isinstance(payload.get("payload"), dict) else {},
            host_event_id=str(payload.get("hostEventId") or "") or None,
        )
        return success_response(
            request_id,
            {
                "seq": int(row.get("sequence") or 0),
                "deduplicated": bool(row.get("deduplicated")),
            },
        )

    async def _event_follow(
        self, request_id: str, payload: dict[str, Any]
    ) -> dict[str, Any]:
        result = await follow_events(
            run_id=str(self.run_id),
            after_seq=int(payload.get("afterSeq") or 0),
            limit=int(payload.get("limit") or 100),
        )
        return success_response(request_id, result)

    async def _finish(self, request_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        await self._require_lease(request_id)
        status = str(payload.get("status") or "")
        from app.services.agent_run_state import save_agent_run, load_agent_run

        run = await load_agent_run(str(self.run_id))
        if run is None:
            raise BridgeProtocolError(
                "run_not_found",
                f"Agent Run {self.run_id} does not exist",
                request_id=request_id,
            )
        run["status"] = status
        run["failure_reason"] = "" if status == "completed" else str(
            payload.get("summary") or status
        )
        saved = await save_agent_run(run)
        await self.coordinator.release_lease(
            run_id=str(self.run_id), lease_id=str(self.lease_id or "")
        )
        self.lease_id = None
        return success_response(
            request_id,
            {"status": saved.get("status"), "eventSequence": saved.get("event_sequence")},
        )


async def serve(
    *,
    reader: asyncio.StreamReader,
    writer: asyncio.StreamWriter,
    err: TextIO | None = None,
) -> None:
    """Run one Bridge session over an asyncio stream pair."""
    err = err or sys.stderr
    session = BridgeSession()
    queue: asyncio.Queue[bytes | None] = asyncio.Queue(maxsize=OUTPUT_QUEUE_LIMIT)

    async def pump_output() -> None:
        while True:
            line = await queue.get()
            if line is None:
                break
            writer.write(line)
            await writer.drain()

    pump = asyncio.create_task(pump_output())

    async def emit(payload: dict[str, Any]) -> None:
        line = json.dumps(payload, ensure_ascii=False, allow_nan=False).encode("utf-8") + b"\n"
        if len(line) > MAX_LINE_BYTES:
            line = json.dumps(
                error_response(None, BridgeProtocolError("internal_error", "Response too large")),
                ensure_ascii=False,
            ).encode("utf-8") + b"\n"
        try:
            queue.put_nowait(line)
        except asyncio.QueueFull:
            # Backpressure: drop nothing silently — fail closed with backpressure.
            queue.put_nowait(
                json.dumps(
                    error_response(
                        None,
                        BridgeProtocolError(
                            "backpressure",
                            "Output queue is full; reconnect from your last cursor",
                            retryable=True,
                        ),
                    )
                ).encode("utf-8")
                + b"\n"
            )

    try:
        while True:
            raw = await reader.readline()
            if not raw:
                break
            if len(raw) > MAX_LINE_BYTES:
                emit(error_response(None, BridgeProtocolError("schema_invalid", "Request line exceeds limit")))
                continue
            try:
                request = parse_request_line(raw)
                validated = validate_request(request.model_dump(by_alias=True, exclude_none=True))
                response = await session.handle(validated)
                emit(response)
            except BridgeProtocolError as error:
                emit(error.to_response())
            except Exception as exc:  # noqa: BLE001 - fail closed, never crash the loop
                print(f"bridge: internal error: {type(exc).__name__}", file=err)
                emit(error_response(None, BridgeProtocolError("internal_error", "Bridge internal error")))
    finally:
        await queue.put(None)
        await pump


async def serve_stdio() -> None:
    """Run one Bridge session over process stdin/stdout.

    Windows Proactor pipe transports are fragile for console handles, so the
    loop reads one line at a time in a worker thread and writes each response
    immediately. The wire contract is identical to `serve`: an adapter can
    send a request and block on its response before sending the next line.
    """

    loop = asyncio.get_running_loop()

    def read_line() -> str:
        return sys.stdin.readline()

    session = BridgeSession()
    out = sys.stdout
    while True:
        raw = await loop.run_in_executor(None, read_line)
        if not raw:
            break
        if not raw.strip():
            continue
        try:
            request = parse_request_line(raw)
            validated = validate_request(request.model_dump(by_alias=True, exclude_none=True))
            response = await session.handle(validated)
        except BridgeProtocolError as error:
            response = error.to_response()
        except Exception:  # noqa: BLE001 - fail closed per line
            response = error_response(
                None, BridgeProtocolError("internal_error", "Bridge internal error")
            )
        out.write(json.dumps(response, ensure_ascii=False, allow_nan=False) + "\n")
        out.flush()


__all__ = [
    "BridgeSession",
    "MAX_LINE_BYTES",
    "OUTPUT_QUEUE_LIMIT",
    "serve",
]
