"""Observe Registry-owned ORM effects; never manufacture a second executor.

Exact source images advance only by this task's committed ORM changes and a
matching canonical readback. Other tasks' edits cannot become an approved base.
Unsupported adapters and unobserved effects remain unknown, never no_effect.
"""
from __future__ import annotations

import copy
import asyncio
from datetime import date, datetime
from contextlib import asynccontextmanager
from contextvars import ContextVar
from typing import Any

from sqlalchemy import event, inspect
from sqlalchemy.orm import Session

from app.services import proposal_plan_sources as sources
from app.services.proposal_plan_builder import PlanValidationError, canonical_digest

_ACTIVE: ContextVar[Any] = ContextVar("offeru_node_source_observer", default=None)
# Only synchronous adapters whose business writes are entirely observed ORM
# transactions may prove no_effect. Background, SQL DML, filesystem and remote
# adapters need their own durable effect evidence; never infer it from `ok`.
_PURE_ORM_OPERATIONS = frozenset({"create_resume_section", "update_resume_section", "reorder_resume_sections", "update_resume_record", "create_resume_version_record", "review_resume_proposal_items", "review_resume_proposal_item", "triage_job", "update_job", "batch_triage", "batch_update_jobs", "update_profile", "create_target_role", "delete_target_role"})
_ROOTS = {"Job": "job", "Pool": "pool", "Profile": "profile", "Resume": "resume", "ResumeOptimizationProposal": "proposal"}
_CHILDREN = {"ProfileSection": ("profile", "sections", "profile_id"), "ProfileTargetRole": ("profile", "roles", "profile_id"),
             "ResumeSection": ("resume", "sections", "resume_id"), "ResumeVersion": ("resume", "versions", "resume_id")}
_CONTROL_TABLES = frozenset({"operation_audit_logs", "agent_runs", "agent_run_events", "job_search_tasks"})


def _binding(row: Any) -> tuple[str, str | None] | None:
    name = type(row).__name__
    if name in _ROOTS:
        identity = row.proposal_id if name == "ResumeOptimizationProposal" else row.id
        return f"{_ROOTS[name]}:{identity}", None
    if name in _CHILDREN:
        kind, collection, parent = _CHILDREN[name]
        return f"{kind}:{getattr(row, parent)}", collection
    return None


class SourceEffectGuard:
    def __init__(self, node: dict[str, Any], versions: dict[str, str]):
        self.node = node
        self.before_versions = versions
        self.images: dict[str, Any] = {}
        self.effects: list[dict[str, Any]] = []
        self.unbound_effects: list[dict[str, Any]] = []
        self.owned_new_refs: set[str] = set()
        self.transactions: dict[int, Any] = {}
        self.unobserved = False
        self.owner_task = asyncio.current_task()

    async def start(self) -> None:
        required = (await sources.capture_sources([self.node]))[0]["source_versions"]
        if not set(required).issubset(self.before_versions):
            raise PlanValidationError("Source snapshots are missing; display and review a new plan before execution")
        async with sources.async_session() as db:
            for reference, expected in self.before_versions.items():
                kind, _, identity = reference.partition(":")
                material = await sources._source(db, kind, identity)
                if canonical_digest(material) != expected:
                    raise PlanValidationError(f"Source {reference} changed before execution")
                self.images[reference] = material

    def before_flush(self, session: Session) -> None:
        candidates = [(row, "add") for row in session.new] + [(row, "update") for row in session.dirty] + [(row, "delete") for row in session.deleted]
        tracked, unbound = [], []
        for row, action in candidates:
            table = row.__table__.name
            if table in _CONTROL_TABLES or table.startswith("proposal_"):
                continue
            binding = _binding(row)
            if type(row).__name__ in _CHILDREN and action == "add" and binding is not None and not binding[0].endswith(":None") and binding[0] not in self.images and binding[0] not in self.owned_new_refs:
                raise PlanValidationError("New child row targets an existing source outside the reviewed snapshot")
            if self.node["operation"] == "ensure_resume_workspace" and type(row).__name__ == "Resume":
                refs = [f"job:{row.target_job_id}", f"profile:{row.source_profile_id}"]
                if row.source_resume_id is not None:
                    refs.append(f"resume:{row.source_resume_id}")
                if any(reference not in self.images for reference in refs):
                    raise PlanValidationError("Workspace creation uses a source outside the reviewed snapshot")
            if binding is not None and binding[0] not in self.images and binding[0] not in self.owned_new_refs and action != "add":
                raise PlanValidationError("The business transaction targets a source outside the reviewed snapshot")
            if binding is None or binding[0] not in self.images:
                self.unobserved = True
                unbound.append((row, action))
                continue
            reference, collection = binding
            if action != "add":
                before = sources._row(row)
                for column in row.__table__.columns:
                    if column.name not in before:
                        continue
                    history = inspect(row).attrs[column.key].history
                    if history.deleted:
                        old_value = history.deleted[0]
                        before[column.name] = old_value.isoformat() if isinstance(old_value, (date, datetime)) else copy.deepcopy(old_value)
                expected = self.images[reference]
                if collection:
                    expected = next((item for item in expected[collection] if item["id"] == before["id"]), None)
                else:
                    expected = {key: value for key, value in expected.items() if key in before}
                if expected is None or canonical_digest(before) != canonical_digest(expected):
                    raise PlanValidationError("Source row changed before the business transaction flush")
            tracked.append((row, action, reference, collection))
        if tracked or unbound:
            self.transactions.setdefault(id(session), {"before": copy.deepcopy(self.images), "owned_before": set(self.owned_new_refs), "effects": [], "unbound_effects": []})
            self.transactions[id(session)]["tracked"] = tracked
            self.transactions[id(session)]["unbound"] = unbound

    def after_flush(self, session: Session) -> None:
        transaction = self.transactions.get(id(session))
        if not transaction:
            return
        for row, action, reference, collection in transaction.pop("tracked", []):
            after = sources._row(row)
            image = self.images[reference]
            if collection:
                records = [item for item in image[collection] if item["id"] != after["id"]]
                if action != "delete":
                    records.append(after)
                image[collection] = sorted(records, key=lambda item: item["id"])
            elif action == "delete":
                self.unobserved = True
            else:
                image.update(after)
            transaction["effects"].append({"source": reference, "collection": collection, "action": action, "after": after})
        for row, action in transaction.pop("unbound", []):
            transaction["unbound_effects"].append({"model": type(row).__name__, "action": action, "after": sources._row(row)})
            if action == "add" and (binding := _binding(row)) is not None:
                self.owned_new_refs.add(binding[0])

    def commit(self, session: Session) -> None:
        transaction = self.transactions.pop(id(session), None)
        if transaction:
            self.effects.extend(transaction["effects"])
            self.unbound_effects.extend(transaction["unbound_effects"])

    def rollback(self, session: Session) -> None:
        transaction = self.transactions.pop(id(session), None)
        if transaction:
            self.images = transaction["before"]
            self.owned_new_refs = transaction["owned_before"]

    async def finish(self, result: dict[str, Any]) -> dict[str, Any]:
        expected_after = {reference: canonical_digest(image) for reference, image in self.images.items()}
        matched = True
        async with sources.async_session() as db:
            for reference, expected in expected_after.items():
                kind, _, identity = reference.partition(":")
                try:
                    material = await sources._source(db, kind, identity)
                except PlanValidationError:
                    matched = False
                    continue
                matched &= canonical_digest(material) == expected
        complete = matched and not self.unobserved and not self.transactions and self.node["operation"] in _PURE_ORM_OPERATIONS
        if complete:
            effect = "committed" if self.effects else "no_effect"
        else:
            effect = "partial" if self.effects else "unknown"
        # This witness is produced inside the trusted Registry invocation,
        # never read from a model-supplied result or an arbitrary exception.
        return {"effect_state": effect, "proven_no_effect": bool(complete and not self.effects),
                "source_evidence": {"before_versions": self.before_versions, "after_versions": expected_after,
                                    "effects": self.effects, "unbound_effects": self.unbound_effects,
                                    "bulk_dml": getattr(self, "bulk_dml", False),
                                    "verified": bool(matched), "complete": bool(complete)}}


def _before_flush(session: Session, _context: Any, _instances: Any) -> None:
    if (guard := _current_guard()) is not None:
        guard.before_flush(session)


def _after_flush(session: Session, _context: Any) -> None:
    if (guard := _current_guard()) is not None:
        guard.after_flush(session)


def _after_commit(session: Session) -> None:
    if (guard := _current_guard()) is not None:
        guard.commit(session)


def _after_rollback(session: Session) -> None:
    if (guard := _current_guard()) is not None:
        guard.rollback(session)


def _orm_execute(statement: Any) -> None:
    # Bulk DML bypasses before_flush; it cannot acquire an ORM-only witness.
    if (guard := _current_guard()) is not None and (statement.is_update or statement.is_delete or statement.is_insert):
        table = getattr(getattr(statement.statement, "table", None), "name", "")
        if table in _CONTROL_TABLES or table.startswith("proposal_"):
            return
        guard.unobserved = True
        guard.bulk_dml = True


def _current_guard() -> SourceEffectGuard | None:
    guard = _ACTIVE.get()
    try:
        return guard if guard is not None and guard.owner_task is asyncio.current_task() else None
    except RuntimeError:
        return None


event.listen(Session, "before_flush", _before_flush)
event.listen(Session, "after_flush_postexec", _after_flush)
event.listen(Session, "after_commit", _after_commit)
event.listen(Session, "after_rollback", _after_rollback)
event.listen(Session, "do_orm_execute", _orm_execute)


def group_source_overlay(plan: dict[str, Any], group: dict[str, Any], node: dict[str, Any]) -> dict[str, str]:
    """Use only persisted, complete witnesses from this sealed group's prefix.

    The Store/Registry caller must have verified the snapshot and receipt/audit
    binding. This function never accepts a caller-supplied hash as fresh state.
    """
    from app.services.proposal_plan_builder import verify_plan_snapshot
    verify_plan_snapshot(plan)
    overlay: dict[str, str] = {}
    for item in group["nodes"]:
        for reference, version in item.get("source_versions", {}).items():
            if reference in overlay and overlay[reference] != version:
                raise PlanValidationError("Group source versions disagree")
            overlay[reference] = version
    for previous in sorted(group["nodes"], key=lambda item: item["ordinal"]):
        if previous["id"] == node["id"]:
            return {reference: overlay[reference] for reference in node.get("source_versions", {})}
        if previous["status"] != "completed":
            raise PlanValidationError("Previous node is not durably completed")
        result = previous.get("result") or {}
        witness = result.get("source_evidence") or {}
        if not (witness.get("complete") and witness.get("verified") and (previous.get("receipt_id") or previous.get("receipt_ref"))):
            raise PlanValidationError("Previous effect lacks a complete, durable source witness")
        before = witness.get("before_versions") or {}
        if any(overlay.get(reference) != version for reference, version in before.items()):
            raise PlanValidationError("Previous receipt does not extend the authorized source chain")
        after = witness.get("after_versions") or {}
        if set(after) != set(before):
            raise PlanValidationError("Source witness changed its scope")
        overlay.update(after)
    raise PlanValidationError("Node is not in this group")


async def verified_group_source_overlay(plan: dict[str, Any], group: dict[str, Any], node: dict[str, Any]) -> dict[str, str]:
    """Validate the source chain against actual immutable receipts and audit."""
    overlay = group_source_overlay(plan, group, node)
    for previous in sorted(group["nodes"], key=lambda item: item["ordinal"]):
        if previous["id"] == node["id"]:
            break
        await verified_node_source_witness(previous)
    return overlay


async def verified_node_source_witness(previous: dict[str, Any]) -> dict[str, Any]:
    """Read trusted evidence for a committed node; never accept a caller hash."""
    from app.models.models import OperationAuditLog
    from app.services.proposal_plan_store import get_node_authorization
    binding = await get_node_authorization(previous["id"])
    stored = binding.get("node") or {}
    receipt = stored.get("receipt") or binding.get("receipt") or {}
    receipt_id = stored.get("receipt_id") or stored.get("receipt_ref")
    audit_ref = receipt.get("audit_ref") or stored.get("audit_ref")
    if stored.get("status") != "completed" or receipt.get("status") != "completed" or receipt.get("effect_state") != "committed" or receipt.get("id") != receipt_id or str(receipt.get("node_id") or "") != previous["id"]:
        raise PlanValidationError("Source prefix has no matching durable receipt")
    try:
        audit_id = int(str(audit_ref))
    except (TypeError, ValueError) as exc:
        raise PlanValidationError("Receipt has no canonical audit reference") from exc
    async with sources.async_session() as db:
        audit = await db.get(OperationAuditLog, audit_id)
        if audit is None or not audit.ok or audit.status != "completed" or audit.operation != previous["operation"] or audit.operation_version != previous["operation_version"]:
            raise PlanValidationError("Source prefix audit did not complete the authorized operation")
        attempt_id = str(receipt.get("attempt_id") or "")
        expected_keys = {previous["idempotency_key"]}
        if attempt_id:
            expected_keys.add(f"{previous['idempotency_key']}:attempt:{attempt_id}")
        if audit.idempotency_key not in expected_keys or f":{previous['id']}:" not in str(audit.confirmation_ref or ""):
            raise PlanValidationError("Audit does not bind this node's business effect")
    witness = (receipt.get("result") or {}).get("source_evidence") or {}
    if witness != (stored.get("result") or {}).get("source_evidence") or witness != (previous.get("result") or {}).get("source_evidence"):
        raise PlanValidationError("Node source witness differs from its immutable receipt")
    if not witness.get("complete") or not witness.get("verified"):
        raise PlanValidationError("Committed node has no complete source witness")
    return witness


@asynccontextmanager
async def observe_node_sources(node: dict[str, Any], *, expected_versions: dict[str, str] | None = None):
    guard = SourceEffectGuard(node, expected_versions if expected_versions is not None else node.get("source_versions") or {})
    await guard.start()
    token = _ACTIVE.set(guard)
    try:
        yield guard
    finally:
        _ACTIVE.reset(token)
