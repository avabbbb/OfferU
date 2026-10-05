"""Durable Plan receipt delivery back to the Run that requested the work."""
from __future__ import annotations

import asyncio
import inspect
import json
import uuid
from collections.abc import Awaitable, Callable, Mapping
from typing import Any

from app.services.security_redaction import redact_secret_value

_DELIVERY_LOCKS: dict[str, asyncio.Lock] = {}
_INFLIGHT_DELIVERIES: dict[str, asyncio.Task[Any]] = {}
_CONTINUATION_LEASE_SECONDS = 60
_CONTINUATION_HEARTBEAT_SECONDS = 15
ResumeAgent = Callable[..., Awaitable[dict[str, Any]] | dict[str, Any]]


class ContinuationBusy(RuntimeError):
    """The original Run still has a live turn; let it finish before resume."""


async def _renew_claim_until_stopped(
    continuation_id: str,
    claim_id: str,
    stop: asyncio.Event,
    lost: asyncio.Event,
) -> None:
    from app.services.proposal_plan_store import renew_continuation_claim

    while not stop.is_set():
        try:
            await asyncio.wait_for(stop.wait(), timeout=_CONTINUATION_HEARTBEAT_SECONDS)
            return
        except asyncio.TimeoutError:
            try:
                renewed = await renew_continuation_claim(
                    continuation_id,
                    claim_id=claim_id,
                    lease_seconds=_CONTINUATION_LEASE_SECONDS,
                )
            except Exception:
                renewed = False
            if not renewed:
                # The callback may still be alive. Mark the fencing token lost,
                # but never cancel a same-Run model turn that could be active.
                lost.set()
                return


def _node_receipt(node: Mapping[str, Any]) -> tuple[str, Mapping[str, Any]]:
    value = node.get("receipt")
    receipt = value if isinstance(value, Mapping) else {}
    receipt_id = str(
        node.get("receipt_id")
        or node.get("receipt_ref")
        or receipt.get("id")
        or (value if isinstance(value, str) else "")
    )
    return receipt_id, receipt


def continuation_view(value: Mapping[str, Any]) -> dict[str, Any]:
    """Expose continuation tracking without leaking lease or claim material."""

    return {
        "id": str(value.get("id") or ""),
        "group_id": str(value.get("group_id") or ""),
        "run_id": str(value.get("run_id") or ""),
        "status": str(value.get("status") or ""),
        "receipt_ids": list(value.get("receipt_ids") or []),
        "error": str(value.get("error") or ""),
    }


def _continuation_record(value: Any, fallback: Mapping[str, Any]) -> dict[str, Any]:
    if isinstance(value, Mapping):
        nested = value.get("continuation")
        if isinstance(nested, Mapping):
            return dict(nested)
        return dict(value)
    return dict(fallback)


def plan_review_view(plan: Mapping[str, Any], *, continuations: list[Mapping[str, Any]] | None = None) -> dict[str, Any]:
    """Project the exact review display while hiding stored args and snapshots."""

    result = {key: value for key, value in plan.items() if key not in {"snapshot", "snapshot_json"}}
    result["continuations"] = [
        continuation_view(item)
        for item in (continuations or [])
        if str(item.get("group_id") or "") in {
            str(group.get("id") or "") for group in plan.get("groups") or []
        }
    ]
    groups: list[dict[str, Any]] = []
    for source_group in plan.get("groups") or []:
        group = {key: value for key, value in source_group.items() if key not in {"snapshot", "snapshot_json"}}
        nodes: list[dict[str, Any]] = []
        for source_node in source_group.get("nodes") or []:
            node = {key: value for key, value in source_node.items() if key not in {
                "args", "snapshot", "snapshot_json", "input_schema", "schema_digest",
            }}
            node["redactedArgs"] = redact_secret_value(
                source_node.get("args") or {},
                max_length=2_000_000,
            )
            nodes.append(node)
        group["nodes"] = nodes
        groups.append(group)
    result["groups"] = groups
    return result


def _receipt_rows(continuation: Mapping[str, Any], plans: list[Mapping[str, Any]]) -> list[dict[str, Any]]:
    wanted = {str(item) for item in continuation.get("receipt_ids") or [] if str(item)}
    group_id = str(continuation.get("group_id") or "")
    rows: list[dict[str, Any]] = []
    for plan in plans:
        for group in plan.get("groups") or []:
            if str(group.get("id") or "") != group_id:
                continue
            for node in group.get("nodes") or []:
                receipt_id, receipt = _node_receipt(node)
                history = list(node.get("receipts") or [])
                if receipt_id and not any(str(item.get("id") or "") == receipt_id for item in history):
                    history.append({**receipt, "id": receipt_id})
                for item in history:
                    identity = str(item.get("id") or "")
                    if identity not in wanted or any(row["id"] == identity for row in rows):
                        continue
                    rows.append({"id": identity, "node_id": str(node.get("id") or ""),
                                 "operation": str(node.get("operation") or ""),
                                 "status": str(item.get("status") or node.get("status") or ""),
                                 "effect_state": str(item.get("effect_state") or node.get("effect_state") or ""),
                                 "result": item.get("result", node.get("result")),
                                 "audit_ref": item.get("audit_ref") or node.get("audit_ref")})
    if wanted and {str(item["id"]) for item in rows} != wanted:
        raise ValueError("Continuation receipts are not available from the durable Plan snapshot")
    return rows


def _delivery_id(continuation_id: str, receipt_ids: list[str]) -> str:
    from app.services.proposal_plan_builder import canonical_digest

    material = {"continuation_id": continuation_id, "receipt_ids": sorted(set(receipt_ids))}
    return "continuation_" + canonical_digest(material)[:32]


def _group_status(continuation: Mapping[str, Any], plans: list[Mapping[str, Any]]) -> str:
    group_id = str(continuation.get("group_id") or "")
    for plan in plans:
        for group in plan.get("groups") or []:
            if str(group.get("id") or "") == group_id:
                return str(group.get("status") or "")
    return ""


async def recover_continuation_outbox(*, run_id: str | None = None) -> dict[str, int]:
    """Recreate any missing outbox row from sealed terminal group receipts."""

    from app.services.proposal_plan_store import create_continuation, list_continuations, list_plans

    plans = await list_plans(run_id=run_id)
    known = await list_continuations(run_id=run_id)
    known_groups = {str(item.get("group_id") or "") for item in known}
    created = duplicates = 0
    recoverable = {"completed", "rejected", "paused", "blocked", "needs_reconciliation"}
    for plan in plans:
        plan_run_id = str(plan.get("run_id") or "")
        for group in plan.get("groups") or []:
            group_id = str(group.get("id") or "")
            if str(group.get("status") or "") not in recoverable or not group_id or group_id in known_groups:
                continue
            receipt_ids = []
            for node in group.get("nodes") or []:
                receipt_id, _ = _node_receipt(node)
                if receipt_id and receipt_id not in receipt_ids:
                    receipt_ids.append(receipt_id)
            row = await create_continuation({
                "id": f"continuation_{uuid.uuid4().hex}",
                "run_id": plan_run_id,
                "group_id": group_id,
                "receipt_ids": receipt_ids,
                "status": "pending",
                "error": str(group.get("error") or ""),
            })
            if isinstance(row, Mapping) and row.get("duplicate"):
                duplicates += 1
            else:
                created += 1
            known_groups.add(group_id)
    return {"created": created, "duplicates": duplicates}


def _continuation_message(
    run_id: str,
    continuation: Mapping[str, Any],
    receipts: list[dict[str, Any]],
    *,
    delivery_id: str,
) -> str:
    clean_receipts = redact_secret_value(receipts, max_length=2_000_000)
    body = json.dumps(clean_receipts, ensure_ascii=False, allow_nan=False, separators=(",", ":"))
    continuation_id = str(continuation.get("id") or "")
    return (
        f"[OfferU continuation checkpoint: {delivery_id}]\n"
        f"Outbox ID: {continuation_id}\n"
        f"These durable receipts belong to the existing Agent Run {run_id}. Read them as execution evidence, "
        "verify affected Career State through the Registry, and continue the original goal. Do not repeat an "
        "operation whose receipt shows a committed effect.\n"
        "Read list_proposal_plans for this Run before preparing more writes: remaining never-authorized groups may have a refreshed immutable revision that still needs human review. Do not duplicate pending intents.\n"
        f"Receipt IDs: {json.dumps(list(continuation.get('receipt_ids') or []), ensure_ascii=False)}\n"
        f"Receipts: {body}"
    )


async def _record_continuation_acceptance(
    run_id: str,
    continuation: Mapping[str, Any],
    *,
    delivery_id: str,
    receiver: str,
) -> dict[str, Any]:
    from app.services.agent_run_state import append_agent_run_event, list_agent_run_events, load_agent_run

    run = await load_agent_run(run_id)
    if run is None:
        raise ValueError("Agent Run does not exist")
    after = max(0, int(run.get("event_sequence") or 0) - 1000)
    events = await list_agent_run_events(run_id, after_sequence=after, limit=1000)
    continuation_id = str(continuation.get("id") or "")
    already_recorded = any(
        event.get("type") == "continuation.accepted"
        and isinstance(event.get("payload"), Mapping)
        and event["payload"].get("continuation_id") == continuation_id
        and event["payload"].get("delivery_id") == delivery_id
        for event in events
    )
    if not already_recorded:
        await append_agent_run_event(
            run_id,
            event_type="continuation.accepted",
            payload={
                "continuation_id": continuation_id,
                "delivery_id": delivery_id,
                "group_id": str(continuation.get("group_id") or ""),
                "receipt_ids": list(continuation.get("receipt_ids") or []),
                "receiver": receiver,
            },
        )
    return await load_agent_run(run_id) or run


async def _deliver_ui_projection(
    run: dict[str, Any],
    continuation: Mapping[str, Any],
    *,
    delivery_id: str,
) -> dict[str, Any]:
    run_id = str(run.get("id") or "")
    accepted_run = await _record_continuation_acceptance(
        run_id,
        continuation,
        delivery_id=delivery_id,
        receiver="ui_result_projection",
    )
    return {"ok": True, "run": accepted_run, "receiver": "ui_result_projection"}


async def _process_claimed_continuation(
    run: dict[str, Any],
    continuation: dict[str, Any],
    plans: list[Mapping[str, Any]],
    *,
    claim_id: str,
    embedded: bool,
    ui_only_run: bool,
    resume_agent: ResumeAgent | None,
) -> dict[str, Any]:
    from app.services.proposal_plan_store import finish_continuation

    continuation_id = str(continuation.get("id") or "")
    stop_heartbeat = asyncio.Event()
    claim_lost = asyncio.Event()
    heartbeat = asyncio.create_task(
        _renew_claim_until_stopped(continuation_id, claim_id, stop_heartbeat, claim_lost),
        name=f"offeru-proposal-continuation-lease-{continuation_id}",
    )
    current = dict(continuation)
    accepted = False
    try:
        raw_claimed_ids = current.get("claimed_receipt_ids")
        if not isinstance(raw_claimed_ids, list):
            raw_claimed_ids = current.get("receipt_ids") or []
        claimed_ids = [str(item) for item in raw_claimed_ids if str(item)]
        current["receipt_ids"] = claimed_ids
        delivery_id = _delivery_id(continuation_id, claimed_ids)
        receipts = _receipt_rows(current, plans)
        if resume_agent is None and ui_only_run:
            outcome = await _deliver_ui_projection(run, current, delivery_id=delivery_id)
        elif resume_agent is None and embedded:
            outcome = await _deliver_embedded(run, current, receipts, delivery_id=delivery_id)
        elif resume_agent is not None:
            outcome = resume_agent(
                run=run,
                continuation=current,
                receipts=receipts,
                delivery_id=delivery_id,
            )
            if inspect.isawaitable(outcome):
                outcome = await outcome
        else:
            return {"state": "pending", "continuation": current}

        if not isinstance(outcome, dict) or outcome.get("ok") is False:
            errors = outcome.get("errors") if isinstance(outcome, dict) else None
            message = "; ".join(str(item) for item in errors or []) or "Original Run did not accept continuation"
            if claim_lost.is_set():
                return {"state": "pending", "continuation": current}
            finished = await finish_continuation(
                continuation_id,
                claim_id=claim_id,
                status="failed",
                error=message,
            )
            row = _continuation_record(finished, {**current, "status": "failed", "error": message})
            return {"state": "failed", "continuation": row}

        receiver = str(outcome.get("receiver") or ("python_agent_session" if embedded else "test_callback"))
        accepted_run = await _record_continuation_acceptance(
            str(run.get("id") or ""),
            current,
            delivery_id=delivery_id,
            receiver=receiver,
        )
        accepted = True
        if claim_lost.is_set():
            return {"state": "pending", "continuation": current, "run": accepted_run}
        finished = await finish_continuation(
            continuation_id,
            claim_id=claim_id,
            status="delivered",
        )
        row = _continuation_record(finished, {**current, "status": "pending"})
        return {
            "state": "delivered" if row.get("status") == "delivered" else "pending",
            "continuation": row,
            "run": accepted_run,
        }
    except ContinuationBusy as exc:
        if claim_lost.is_set():
            return {"state": "pending", "continuation": current}
        finished = await finish_continuation(
            continuation_id,
            claim_id=claim_id,
            status="failed",
            error=str(exc),
        )
        return {
            "state": "failed",
            "continuation": _continuation_record(finished, {**current, "status": "failed", "error": str(exc)}),
        }
    except Exception as exc:
        # Once a session/event checkpoint was accepted, keep the outbox retryable
        # if acknowledgement failed; the delivery_id makes replay idempotent.
        if accepted or claim_lost.is_set():
            return {"state": "pending", "continuation": current}
        finished = await finish_continuation(
            continuation_id,
            claim_id=claim_id,
            status="failed",
            error=str(exc),
        )
        return {
            "state": "failed",
            "continuation": _continuation_record(finished, {**current, "status": "failed", "error": str(exc)}),
        }
    finally:
        stop_heartbeat.set()
        await asyncio.gather(heartbeat, return_exceptions=True)


async def _deliver_embedded(
    run: dict[str, Any],
    continuation: dict[str, Any],
    receipts: list[dict[str, Any]],
    *,
    delivery_id: str,
) -> dict[str, Any]:
    run_id = str(run.get("id") or "")
    message = _continuation_message(run_id, continuation, receipts, delivery_id=delivery_id)
    from app.services.embedded_agent_host import start_embedded_agent_run
    from app.services.embedded_agent_worker import get_embedded_agent_worker

    worker = get_embedded_agent_worker()
    await _wait_for_embedded_run_idle(run_id, worker)
    return await start_embedded_agent_run(
        message=message,
        skill_id=str(run.get("skill_id") or ""),
        conversation_id=str(run.get("conversation_id") or ""),
        task_id=str(run.get("task_id") or ""),
        resume_run_id=run_id,
        worker=worker,
        continuation=True,
        continuation_id=str(continuation.get("id") or ""),
        delivery_id=delivery_id,
    )


async def _wait_for_embedded_run_idle(run_id: str, worker: Any, *, timeout: float = 210) -> None:
    from app.services.agent_run_state import load_agent_run

    deadline = asyncio.get_running_loop().time() + timeout
    while True:
        active_run_id = str(worker.active_run_id or "")
        if active_run_id and active_run_id != run_id:
            raise ContinuationBusy("The embedded worker is serving a different live Run")
        if active_run_id == run_id and worker.prompt_active:
            pass
        else:
            run = await load_agent_run(run_id)
            if run is None:
                raise ContinuationBusy("The original Run disappeared before its continuation")
            if str(run.get("status") or "") not in {"planning", "executing"}:
                if worker.active_run_id == run_id:
                    await worker.dispose_run(run_id)
                return
        if asyncio.get_running_loop().time() >= deadline:
            raise ContinuationBusy("The original Run is still active; continuation remains retryable")
        await asyncio.sleep(0.15)


async def deliver_continuations(
    run_id: str,
    *,
    resume_agent: ResumeAgent | None = None,
) -> dict[str, Any]:
    """Consume receipts through the original Agent Run, never a new reasoner.

    ``resume_agent`` is a narrow test seam. Production delivery resumes only
    the embedded Python session. External hosts keep their durable receipts
    pending for readback through that same host/session.
    """

    clean_run_id = str(run_id or "").strip()
    if not clean_run_id:
        raise ValueError("Continuation delivery requires the original Run id")
    lock = _DELIVERY_LOCKS.setdefault(clean_run_id, asyncio.Lock())
    async with lock:
        from app.services.agent_run_state import load_agent_run
        from app.services.proposal_plan_store import (
            claim_continuation,
            list_continuations,
            list_plans,
        )

        run = await load_agent_run(clean_run_id)
        if run is None:
            raise ValueError("Agent Run does not exist")
        await recover_continuation_outbox(run_id=clean_run_id)
        continuations = await list_continuations(run_id=clean_run_id)
        plans = await list_plans(run_id=clean_run_id)
        runtime = run.get("llm_runtime") if isinstance(run.get("llm_runtime"), dict) else {}
        external_host = bool(run.get("harness_name") or run.get("harness_session_id"))
        embedded = runtime.get("runtime") == "python_agent" and not external_host
        ui_only_run = runtime.get("runtime") == "none" and str(run.get("mode") or "") == "ui_operation_request" and not external_host
        delivered = failed = pending = 0
        results: list[dict[str, Any]] = []

        for row in continuations:
            status = str(row.get("status") or "")
            if status == "delivered":
                results.append(continuation_view(row))
                continue
            from app.services.agent_run_state import list_pending_agent_input_requests
            latest_input_run = await load_agent_run(clean_run_id)
            if latest_input_run is None:
                raise ValueError("The original Run disappeared before receipt delivery")
            if latest_input_run.get("status") in {"waiting_input", "waiting_user_input"} or await list_pending_agent_input_requests(clean_run_id):
                pending += 1
                results.append(continuation_view(row))
                continue
            if status == "delivering":
                pending += 1
                results.append(continuation_view(row))
                continue
            if _group_status(row, plans) not in {"completed", "paused", "needs_reconciliation", "rejected", "blocked"}:
                pending += 1
                results.append(continuation_view(row))
                continue
            if resume_agent is None and not embedded and not ui_only_run:
                pending += 1
                results.append(continuation_view(row))
                continue
            claim_id = f"claim_{uuid.uuid4().hex}"
            claimed = await claim_continuation(
                str(row.get("id") or ""),
                claim_id=claim_id,
                lease_seconds=_CONTINUATION_LEASE_SECONDS,
            )
            if claimed is None:
                pending += 1
                results.append(continuation_view(row))
                continue
            current = _continuation_record(claimed, row)
            try:
                continuation_id = str(current.get("id") or "")
                task = asyncio.create_task(
                    _process_claimed_continuation(
                        run,
                        current,
                        plans,
                        claim_id=claim_id,
                        embedded=embedded,
                        ui_only_run=ui_only_run,
                        resume_agent=resume_agent,
                    ),
                    name=f"offeru-proposal-continuation-{continuation_id}",
                )
                _INFLIGHT_DELIVERIES[continuation_id] = task
                task.add_done_callback(
                    lambda done, key=continuation_id: _INFLIGHT_DELIVERIES.pop(key, None)
                    if _INFLIGHT_DELIVERIES.get(key) is done
                    else None
                )
                processed = await asyncio.shield(task)
            except asyncio.CancelledError:
                # The claimed worker retains its own heartbeat and completes or
                # leaves a recoverable lease; client disconnect never cancels it.
                raise
            except Exception:
                pending += 1
                results.append(continuation_view(current))
                continue
            state = str(processed.get("state") or "pending")
            if state == "delivered":
                delivered += 1
            elif state == "failed":
                failed += 1
            else:
                pending += 1
            processed_row = processed.get("continuation")
            results.append(continuation_view(processed_row if isinstance(processed_row, Mapping) else current))
            latest = processed.get("run")
            if isinstance(latest, dict):
                run = latest

        latest_run = await load_agent_run(clean_run_id)
        return {
            "delivered": delivered,
            "failed": failed,
            "pending": pending,
            "continuations": results,
            "run": latest_run or run,
        }
