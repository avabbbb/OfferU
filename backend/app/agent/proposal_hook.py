from __future__ import annotations

import inspect
import logging
from typing import Any, Mapping

from app.agent.types import TextContent, ToolResultMessage
import hashlib
import json


def canonical_tool_signature(name: str, args: Mapping[str, Any]) -> str:
    return hashlib.sha256(json.dumps([name, args], sort_keys=True, ensure_ascii=False, default=str).encode()).hexdigest()

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
        for proposal in self.proposals:
            proposal_id = str(proposal.get("proposal_id") or proposal.get("id") or "")
            for signature in _signatures_from_pending_proposal(proposal):
                if signature and proposal_id:
                    self.pending_by_signature[signature] = proposal_id

    async def before_tool_call(self, payload: Mapping[str, Any]) -> dict[str, Any] | None:
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
