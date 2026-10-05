from __future__ import annotations

import inspect
import logging
from typing import Any, Mapping

from app.agent.types import TextContent, ToolResultMessage
def canonical_tool_signature(name: str, args: Mapping[str, Any]) -> str:
    from app.services.proposal_plan_builder import canonical_digest

    return canonical_digest({"operation": name, "args": dict(args)})

_logger = logging.getLogger(__name__)


class ProposalHook:
    def __init__(
        self,
        *,
        event_sink: Any = None,
        failure_fuse: int = 3,
        pending_proposals: list[dict[str, Any]] | None = None,
    ) -> None:
        self.event_sink = event_sink
        self.failure_fuse = int(failure_fuse or 3)
        self.pending_by_signature: dict[str, str] = {}
        self.failure_count_by_signature: dict[str, int] = {}
        self.proposals: list[dict[str, Any]] = list(pending_proposals or [])
        self.plan_id = ""
        for proposal in self.proposals:
            plan = proposal.get("plan") if isinstance(proposal.get("plan"), Mapping) else proposal
            if isinstance(plan, Mapping) and plan.get("status") == "replaced":
                continue
            proposal_id = str(proposal.get("proposal_id") or proposal.get("id") or "")
            if isinstance(plan, Mapping) and isinstance(plan.get("groups"), list):
                for group in plan.get("groups") or []:
                    if not isinstance(group, Mapping) or group.get("status") not in {"pending", "approved", "executing", "paused", "stale"}:
                        continue
                    for node in group.get("nodes") or []:
                        if isinstance(node, Mapping) and node.get("operation") and isinstance(node.get("args"), Mapping):
                            signature = canonical_tool_signature(str(node["operation"]), node["args"])
                            self.pending_by_signature[signature] = proposal_id or str(plan.get("id") or "")
            else:
                for signature in _signatures_from_pending_proposal(proposal):
                    if signature and proposal_id:
                        self.pending_by_signature[signature] = proposal_id
            if isinstance(plan, Mapping) and any(
                group.get("status") in {"pending", "approved", "executing", "stale"}
                for group in plan.get("groups") or []
                if isinstance(group, Mapping)
            ):
                self.plan_id = str(plan.get("id") or proposal_id)

    async def before_tool_call(self, payload: Mapping[str, Any]) -> dict[str, Any] | None:
        tool_call = payload.get("tool_call")
        tool_name = str(getattr(tool_call, "name", "") or payload.get("tool_name") or "")
        if _batch_contains_plan_stage(payload):
            return {
                "block": True,
                "reason": "prepare_proposal_plan must be the only tool call in its assistant batch; retry the Plan operation alone before any further operation.",
            }
        if self.plan_id and tool_name == "prepare_proposal_plan":
            return {
                "block": True,
                "reason": "A Proposal Plan is awaiting independent review; do not stage another Plan until its receipts return.",
            }
        if self.plan_id:
            from app.ops import OPERATIONS

            operation = OPERATIONS.get(tool_name)
            if operation is not None and operation.requires_confirmation:
                return {
                    "block": True,
                    "reason": "A Proposal Plan is awaiting independent review; protected writes must wait for its receipts.",
                }
        signature = _signature_from_payload(payload)
        proposal_id = self.pending_by_signature.get(signature)
        if proposal_id:
            return {
                "block": True,
                "reason": "已存在相同工具调用的 pending proposal id=%s，请不要重复创建，直接等待用户确认。" % proposal_id,
            }
        if self.failure_count_by_signature.get(signature, 0) >= self.failure_fuse:
            return {
                "block": True,
                "reason": "已熔断，请停止重试相同工具调用；请换一种查询条件、缩小范围或向用户追问。",
            }
        if tool_name == "prepare_proposal_plan":
            args = payload.get("args")
            intents = args.get("intents") if isinstance(args, Mapping) else None
            duplicates = [
                self.pending_by_signature[canonical_tool_signature(str(item.get("operation") or ""), item.get("args") or {})]
                for item in intents or []
                if isinstance(item, Mapping)
                and canonical_tool_signature(str(item.get("operation") or ""), item.get("args") or {}) in self.pending_by_signature
            ]
            if duplicates:
                return {
                    "block": True,
                    "reason": "One or more exact Registry intents already belong to pending Plan(s): " + ", ".join(sorted(set(duplicates))),
                }
        return None

    async def after_tool_call(self, payload: Mapping[str, Any]) -> dict[str, Any] | None:
        result = payload.get("result")
        signature = _signature_from_payload(payload)
        is_error = bool(payload.get("is_error"))
        if isinstance(result, ToolResultMessage):
            is_error = is_error or result.is_error
        if is_error:
            self.failure_count_by_signature[signature] = self.failure_count_by_signature.get(signature, 0) + 1
            return None
        self.failure_count_by_signature.pop(signature, None)

        plan = _plan_from_result(result) if _is_plan_result(result) else None
        if plan is not None and not _plan_has_pending_review(plan):
            return None
        if plan is not None:
            plan_id = str(plan.get("id") or plan.get("plan_id") or "")
            if not plan_id:
                details = _details_from_result(result)
                details["status"] = "proposal_error"
                details["error"] = {"code": "missing_plan_id", "message": "Plan 创建失败：缺少 plan_id"}
                return {
                    "content": [TextContent(text="Plan 创建失败：缺少 plan_id。请停止重复提交并重新读取当前 Plan 状态。")],
                    "details": details,
                    "is_error": True,
                    "terminate": True,
                }
            self.plan_id = plan_id
            self.pending_by_signature[signature] = plan_id
            self._remember_plan_intents(plan, plan_id)
            self.proposals.append({"id": plan_id, "plan": plan})
            event = {
                "type": "proposal.plan_ready",
                "plan_id": plan_id,
                "plan_digest": plan.get("digest"),
                "groups": [
                    {"id": group.get("id"), "title": group.get("title"), "summary": group.get("summary")}
                    for group in plan.get("groups") or []
                ],
            }
            await self._emit(event)
            details = _details_from_result(result)
            details.update({"status": "proposal_plan_ready", "plan_id": plan_id, "plan": plan})
            return {
                "content": [TextContent(text=f"Plan {plan_id} 已封存并提交独立审核；请等待用户决定及执行回执。")],
                "details": details,
                "is_error": False,
                "terminate": True,
            }

        proposal = _proposal_from_result(result)
        if proposal is None:
            return None
        proposal_id = str(proposal.get("proposal_id") or proposal.get("id") or "")
        if not proposal_id:
            details = _details_from_result(result)
            details["status"] = "proposal_error"
            details["error"] = {"code": "missing_proposal_id", "message": "proposal 创建失败：缺少 proposal_id"}
            return {
                "content": [TextContent(text="proposal 创建失败：缺少 proposal_id。请停止重试相同参数，并重新收集必要信息。")],
                "details": details,
                "is_error": True,
            }
        self.pending_by_signature[signature] = proposal_id
        self.proposals.append(proposal)

        event = {
            "type": "proposal",
            "proposal_id": proposal_id,
            "risk": proposal.get("risk") or proposal.get("risk_level"),
            "summary": proposal.get("summary") or "",
            "affected_records": proposal.get("affected_records") or [],
            "proposal": proposal,
        }
        await self._emit(event)

        details = _details_from_result(result)
        details.update(
            {
                "status": "proposal_required",
                "proposal_id": proposal_id,
                "proposal": proposal,
                "risk": event["risk"],
                "summary": event["summary"],
                "affected_records": event["affected_records"],
            }
        )
        return {
            "content": [TextContent(text="已创建 proposal id=%s，等待用户确认。" % proposal_id)],
            "details": details,
            "is_error": False,
            "terminate": bool(getattr(result, "terminate", False)),
        }

    def _remember_plan_intents(self, plan: Mapping[str, Any], plan_id: str) -> None:
        for group in plan.get("groups") or []:
            for node in group.get("nodes") or []:
                operation = str(node.get("operation") or "")
                args = node.get("args")
                if operation and isinstance(args, Mapping):
                    self.pending_by_signature[canonical_tool_signature(operation, args)] = plan_id

    async def _emit(self, event: dict[str, Any]) -> None:
        if self.event_sink is None:
            return
        try:
            value = self.event_sink(event)
            if inspect.isawaitable(value):
                await value
        except Exception:
            _logger.exception("Proposal event sink failed")


def _signature_from_payload(payload: Mapping[str, Any]) -> str:
    tool_call = payload.get("tool_call")
    tool_name = str(getattr(tool_call, "name", "") or payload.get("tool_name") or "")
    args = payload.get("args")
    if args is None and tool_call is not None:
        args = getattr(tool_call, "arguments", {}) or {}
    return canonical_tool_signature(tool_name, args if isinstance(args, Mapping) else {})


def _batch_contains_plan_stage(payload: Mapping[str, Any]) -> bool:
    message = payload.get("assistant_message")
    blocks = getattr(message, "content", ())
    calls = [block for block in blocks if getattr(block, "type", "") == "toolCall"]
    return len(calls) > 1 and any(getattr(block, "name", "") == "prepare_proposal_plan" for block in calls)


def _plan_from_result(result: Any) -> dict[str, Any] | None:
    details = _details_from_result(result)
    outputs = details.get("outputs")
    if not isinstance(outputs, Mapping):
        return None
    plan = outputs.get("plan")
    if isinstance(plan, Mapping):
        return dict(plan)
    if outputs.get("plan_id"):
        return {"id": outputs.get("plan_id"), "digest": outputs.get("plan_digest"), "groups": outputs.get("groups") or []}
    return None


def _is_plan_result(result: Any) -> bool:
    outputs = _details_from_result(result).get("outputs")
    return (
        isinstance(outputs, Mapping)
        and outputs.get("executed") is False
        and outputs.get("requires_confirmation") is True
        and bool(outputs.get("plan_id") or outputs.get("plan"))
    )


def _plan_has_pending_review(plan: Mapping[str, Any]) -> bool:
    return any(
        isinstance(group, Mapping)
        and group.get("status") in {"pending", "approved", "executing", "stale"}
        for group in plan.get("groups") or []
    )


def _details_from_result(result: Any) -> dict[str, Any]:
    if isinstance(result, ToolResultMessage) and isinstance(result.details, Mapping):
        return dict(result.details)
    if isinstance(result, Mapping):
        return dict(result)
    return {}


def _proposal_from_result(result: Any) -> dict[str, Any] | None:
    details = _details_from_result(result)
    status = str(details.get("status") or "")
    proposal = details.get("proposal")
    if status != "proposal_required" and not isinstance(proposal, Mapping) and not details.get("proposal_id"):
        return None
    if isinstance(proposal, Mapping):
        safe = dict(proposal)
    else:
        safe = {}
    if details.get("proposal_id") and not safe.get("proposal_id"):
        safe["proposal_id"] = details.get("proposal_id")
    for key in ("risk", "risk_level", "summary", "affected_records"):
        if key in details and key not in safe:
            safe[key] = details[key]
    return safe


def _decision_plan_from_result(result: Any) -> dict[str, Any] | None:
    details = _details_from_result(result)
    plan = details.get("decision_plan")
    if not isinstance(plan, Mapping):
        outputs = details.get("outputs")
        plan = outputs.get("decision_plan") if isinstance(outputs, Mapping) else None
    if not isinstance(plan, Mapping) or not plan.get("plan_id"):
        return None
    return dict(plan)


def _signatures_from_pending_proposal(proposal: Mapping[str, Any]) -> list[str]:
    tool_name = str(proposal.get("tool_name") or "")
    if tool_name == "confirm_plan_group":
        signatures: list[str] = []
        for operation in proposal.get("operations") or []:
            if not isinstance(operation, Mapping):
                continue
            operation_tool = str(operation.get("tool_name") or "")
            if operation_tool:
                signatures.append(canonical_tool_signature(operation_tool, _tool_args_from_locked_payload(operation_tool, operation)))
        return signatures
    plan = proposal.get("plan") if isinstance(proposal.get("plan"), Mapping) else proposal
    if isinstance(plan, Mapping) and isinstance(plan.get("groups"), list):
        signatures = []
        for group in plan.get("groups") or []:
            for node in group.get("nodes") or []:
                if isinstance(node, Mapping) and node.get("operation") and isinstance(node.get("args"), Mapping):
                    signatures.append(canonical_tool_signature(str(node["operation"]), node["args"]))
        return signatures
    locked_payload = proposal.get("locked_payload")
    if not isinstance(locked_payload, Mapping):
        return []
    return [canonical_tool_signature(tool_name, _tool_args_from_locked_payload(tool_name, locked_payload))]


def _signature_from_pending_proposal(proposal: Mapping[str, Any]) -> str:
    signatures = _signatures_from_pending_proposal(proposal)
    return signatures[0] if signatures else ""


def _tool_args_from_locked_payload(tool_name: str, locked_payload: Mapping[str, Any]) -> dict[str, Any]:
    if tool_name == "create_record":
        data = dict(locked_payload.get("data") or {}) if isinstance(locked_payload.get("data"), Mapping) else {}
        data.pop("hash_key", None)
        return {"model": locked_payload.get("model"), "data": data}
    if tool_name == "patch_record":
        return {
            "model": locked_payload.get("model"),
            "record_id": locked_payload.get("record_id"),
            "updates": locked_payload.get("updates") or {},
            "patch_mode": locked_payload.get("patch_mode"),
        }
    if tool_name == "delete_or_archive_record":
        return {
            "model": locked_payload.get("model"),
            "record_id": locked_payload.get("record_id"),
            "operation": locked_payload.get("operation_type") or locked_payload.get("operation"),
        }
    if tool_name == "invoke_action":
        return {"action": locked_payload.get("action"), "input": locked_payload.get("input") or {}}
    return {key: value for key, value in locked_payload.items() if key not in {"tool_name", "operation_type", "expected_version_or_hash", "expected_versions"}}
