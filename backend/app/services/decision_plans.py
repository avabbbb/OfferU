# =============================================
# OfferU - Proposal v2 决策计划域服务（schema v6）
# =============================================
# 分层边界（见 proposal-v2 contract）：
#   Domain（本模块）负责计划的创建/封存/查询、组级决策记录、
#     拒绝级联阻断与 plan/group 状态收敛；
#   Execution 负责组级原子 claim、节点顺序执行、回执持久化与恢复
#     （对本模块的 ORM 行做条件更新，并复用 canonical_digest /
#      compute_plan_status / node_idempotency_key）；
#   Agent 负责 run 绑定与 HTTP 路由。
#
# 摘要规则：所有 JSON 哈希使用 canonical JSON —— UTF-8、排序键、
# 分隔符 (",", ":")、禁止 NaN/Infinity，SHA-256 hex。
# =============================================

from __future__ import annotations

import hashlib
import json
import re
import uuid
from datetime import datetime, timezone
from typing import Any, Iterable, Mapping, Optional

from fastapi.encoders import jsonable_encoder
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from app.database import async_session
from app.models.models import (
    AgentRunRecord,
    ConfirmationDecision,
    DecisionGroup,
    OperationNode,
    ProposalPlan,
)
from app.services.security_redaction import redact_secret_value

# ---------------------------------------------------------------------------
# 状态常量（与 contract 字面量一致；Execution 直接复用）
# ---------------------------------------------------------------------------

PLAN_STATUS_DRAFT = "draft"
PLAN_STATUS_PENDING = "pending"
PLAN_STATUS_EXECUTING = "executing"
PLAN_STATUS_COMPLETED = "completed"
PLAN_STATUS_PARTIALLY_COMPLETED = "partially_completed"
PLAN_STATUS_FAILED = "failed"
PLAN_STATUS_NEEDS_RECONCILIATION = "needs_reconciliation"
PLAN_STATUS_REJECTED = "rejected"
PLAN_STATUS_SUPERSEDED = "superseded"

# 终态：组/计划不再接受决策；needs_reconciliation 不是终态（非终态恢复态）。
PLAN_TERMINAL_STATUSES = frozenset(
    {
        PLAN_STATUS_COMPLETED,
        PLAN_STATUS_PARTIALLY_COMPLETED,
        PLAN_STATUS_FAILED,
        PLAN_STATUS_REJECTED,
        PLAN_STATUS_SUPERSEDED,
    }
)
PLAN_NONTERMINAL_STATUSES = frozenset(
    {
        PLAN_STATUS_DRAFT,
        PLAN_STATUS_PENDING,
        PLAN_STATUS_EXECUTING,
        PLAN_STATUS_NEEDS_RECONCILIATION,
    }
)

GROUP_STATUS_PENDING = "pending"
GROUP_STATUS_APPROVED = "approved"
GROUP_STATUS_REJECTED = "rejected"
GROUP_STATUS_BLOCKED = "blocked"
GROUP_STATUS_EXECUTING = "executing"
GROUP_STATUS_COMPLETED = "completed"
GROUP_STATUS_FAILED = "failed"
GROUP_STATUS_NEEDS_RECONCILIATION = "needs_reconciliation"
GROUP_STATUS_STALE = "stale"

GROUP_TERMINAL_STATUSES = frozenset(
    {
        GROUP_STATUS_REJECTED,
        GROUP_STATUS_BLOCKED,
        GROUP_STATUS_COMPLETED,
        GROUP_STATUS_FAILED,
        GROUP_STATUS_STALE,
    }
)
GROUP_ACTIONABLE_STATUSES = frozenset(
    {
        GROUP_STATUS_PENDING,
        GROUP_STATUS_APPROVED,
        GROUP_STATUS_EXECUTING,
    }
)

NODE_STATUS_PENDING = "pending"
NODE_STATUS_AUTHORIZED = "authorized"
NODE_STATUS_BLOCKED = "blocked"
NODE_STATUS_EXECUTING = "executing"
NODE_STATUS_COMPLETED = "completed"
NODE_STATUS_FAILED = "failed"
NODE_STATUS_UNCERTAIN = "uncertain"
NODE_STATUS_REJECTED = "rejected"
NODE_STATUS_STALE = "stale"

NODE_TERMINAL_STATUSES = frozenset(
    {
        NODE_STATUS_BLOCKED,
        NODE_STATUS_COMPLETED,
        NODE_STATUS_FAILED,
        NODE_STATUS_UNCERTAIN,
        NODE_STATUS_REJECTED,
        NODE_STATUS_STALE,
    }
)

RISK_LEVELS = frozenset({"L1", "L2", "L3"})

DECISION_APPROVE = "approve"
DECISION_REJECT = "reject"
_DECISIONS = frozenset({DECISION_APPROVE, DECISION_REJECT})


# ---------------------------------------------------------------------------
# 错误类型（fail closed：一律显式拒绝，不静默降级）
# ---------------------------------------------------------------------------

class DecisionPlanError(ValueError):
    """决策计划输入/状态非法。"""


class DecisionPlanNotFoundError(DecisionPlanError, LookupError):
    """plan / group / run 不存在。"""


class DecisionConflictError(DecisionPlanError):
    """决策重放冲突、摘要不匹配或状态已终态。"""


# ---------------------------------------------------------------------------
# canonical digest（Execution 的 _validate_authorization 复算同一字节流）
# ---------------------------------------------------------------------------

def canonical_json(value: Any) -> str:
    """Canonical JSON：UTF-8、排序键、(",",":") 分隔、拒绝 NaN/Infinity。"""
    try:
        encoded = jsonable_encoder(value)
        return json.dumps(
            encoded,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
            allow_nan=False,
        )
    except (TypeError, ValueError) as exc:
        raise DecisionPlanError(f"值无法 canonical JSON 序列化: {exc}") from exc


def canonical_digest(value: Any) -> str:
    """sha256 hex of canonical_json(value)。"""
    return hashlib.sha256(canonical_json(value).encode("utf-8")).hexdigest()


def node_idempotency_key(node_id: str, args_digest: str) -> str:
    """Contract 固定格式：decision-node:<node_id>:<args_digest>。"""
    return f"decision-node:{node_id}:{args_digest}"


def _new_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex}"


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _iso(value: Any) -> Optional[str]:
    if value is None:
        return None
    if isinstance(value, datetime):
        return value.isoformat()
    return str(value)


# ---------------------------------------------------------------------------
# 输入校验
# ---------------------------------------------------------------------------

# 动态输出引用：本 wave 不支持节点间输出引用；含引用形态的字符串/键一律拒绝。
_DYNAMIC_REF_VALUE = re.compile(r"^\s*(\$\{?\s*nodes?\s*[.\[]|\{\{\s*nodes?\s*[.[])", re.IGNORECASE)
_DYNAMIC_REF_KEYS = frozenset(
    {
        "node_ref",
        "from_node",
        "node_output",
        "output_ref",
        "output_from",
        "depends_on_node",
        "node_id_ref",
    }
)


def _reject_dynamic_refs(value: Any, *, path: str) -> None:
    if isinstance(value, Mapping):
        for key, item in value.items():
            if str(key).strip() in _DYNAMIC_REF_KEYS:
                raise DecisionPlanError(
                    f"{path} 含节点输出引用键 {key!r}；本 wave 不支持动态输出引用"
                )
            _reject_dynamic_refs(item, path=f"{path}.{key}")
    elif isinstance(value, (list, tuple)):
        for index, item in enumerate(value):
            _reject_dynamic_refs(item, path=f"{path}[{index}]")
    elif isinstance(value, str) and _DYNAMIC_REF_VALUE.match(value):
        raise DecisionPlanError(
            f"{path} 含节点输出引用 {value[:60]!r}；本 wave 不支持动态输出引用"
        )


def _clean_str(value: Any, *, field: str, allow_empty: bool = False) -> str:
    text = str(value or "").strip()
    if not allow_empty and not text:
        raise DecisionPlanError(f"{field} 不能为空")
    return text


def _normalize_nodes(raw_nodes: Any, *, group_index: int) -> list[dict[str, Any]]:
    from app.ops import OPERATIONS  # 延迟导入避免 app.ops <-> services 循环

    if not isinstance(raw_nodes, (list, tuple)) or not raw_nodes:
        raise DecisionPlanError(f"groups[{group_index}].nodes 必须是非空列表")
    normalized: list[dict[str, Any]] = []
    for node_index, raw in enumerate(raw_nodes):
        path = f"groups[{group_index}].nodes[{node_index}]"
        if not isinstance(raw, Mapping):
            raise DecisionPlanError(f"{path} 必须是对象")
        operation = _clean_str(raw.get("operation"), field=f"{path}.operation")
        registered = OPERATIONS.get(operation)
        if registered is None:
            raise DecisionPlanError(f"{path}.operation 未注册: {operation}")
        raw_args = raw.get("args")
        if raw_args is None:
            args: dict[str, Any] = {}
        elif isinstance(raw_args, Mapping):
            args = dict(raw_args)
        else:
            raise DecisionPlanError(f"{path}.args 必须是对象")
        raw_target = raw.get("target")
        if raw_target is None:
            target: dict[str, Any] = {}
        elif isinstance(raw_target, Mapping):
            target = dict(raw_target)
        else:
            raise DecisionPlanError(f"{path}.target 必须是对象")
        _reject_dynamic_refs(args, path=f"{path}.args")
        _reject_dynamic_refs(target, path=f"{path}.target")
        normalized.append(
            {
                "operation": operation,
                "operation_version": str(registered.version or ""),
                "args": jsonable_encoder(args),
                "target": jsonable_encoder(target),
                "summary": str(raw.get("summary") or "").strip(),
            }
        )
    return normalized


def _normalize_groups(groups: Any) -> list[dict[str, Any]]:
    if not isinstance(groups, (list, tuple)) or not groups:
        raise DecisionPlanError("groups 必须是非空列表")
    normalized: list[dict[str, Any]] = []
    for index, raw in enumerate(groups):
        path = f"groups[{index}]"
        if not isinstance(raw, Mapping):
            raise DecisionPlanError(f"{path} 必须是对象")
        title = _clean_str(raw.get("title"), field=f"{path}.title")
        summary = str(raw.get("summary") or "").strip()
        risk_level = _clean_str(
            raw.get("risk_level") or "L2", field=f"{path}.risk_level"
        ).upper()
        if risk_level not in RISK_LEVELS:
            raise DecisionPlanError(
                f"{path}.risk_level 必须是 L1/L2/L3，收到 {risk_level!r}"
            )
        raw_deps = raw.get("dependency_indices")
        if raw_deps is None:
            dependency_indices: list[int] = []
        elif isinstance(raw_deps, (list, tuple)):
            dependency_indices = []
            for dep in raw_deps:
                if isinstance(dep, bool) or not isinstance(dep, int):
                    raise DecisionPlanError(
                        f"{path}.dependency_indices 必须是整数索引列表"
                    )
                if dep < 0 or dep >= index:
                    raise DecisionPlanError(
                        f"{path}.dependency_indices 只能引用当前组之前的组: {dep}"
                    )
                if dep not in dependency_indices:
                    dependency_indices.append(dep)
        else:
            raise DecisionPlanError(f"{path}.dependency_indices 必须是整数索引列表")
        raw_display = raw.get("display")
        if raw_display is None:
            display: dict[str, Any] = {}
        elif isinstance(raw_display, Mapping):
            display = dict(raw_display)
        else:
            raise DecisionPlanError(f"{path}.display 必须是对象")
        nodes = _normalize_nodes(raw.get("nodes"), group_index=index)
        normalized.append(
            {
                "title": title,
                "summary": summary,
                "risk_level": risk_level,
                "dependency_indices": dependency_indices,
                "display": jsonable_encoder(display),
                "nodes": nodes,
            }
        )
    return normalized


# ---------------------------------------------------------------------------
# plan 状态收敛（Execution finalize 与 Domain reject 共用同一规则）
# ---------------------------------------------------------------------------

def compute_plan_status(group_statuses: Iterable[str]) -> str:
    """由组状态推导计划状态；无组时 fail closed 返回 failed。"""
    statuses = [str(status) for status in group_statuses]
    if not statuses:
        return PLAN_STATUS_FAILED
    actionable = {
        GROUP_STATUS_PENDING,
        GROUP_STATUS_APPROVED,
        GROUP_STATUS_EXECUTING,
    }
    if any(status in actionable for status in statuses):
        started = any(
            status not in {GROUP_STATUS_PENDING, GROUP_STATUS_APPROVED}
            for status in statuses
        )
        return PLAN_STATUS_EXECUTING if started else PLAN_STATUS_PENDING
    if GROUP_STATUS_NEEDS_RECONCILIATION in statuses:
        return PLAN_STATUS_NEEDS_RECONCILIATION
    if all(status == GROUP_STATUS_COMPLETED for status in statuses):
        return PLAN_STATUS_COMPLETED
    if all(
        status in {GROUP_STATUS_REJECTED, GROUP_STATUS_BLOCKED, GROUP_STATUS_STALE}
        for status in statuses
    ):
        return PLAN_STATUS_REJECTED
    if GROUP_STATUS_COMPLETED in statuses:
        return PLAN_STATUS_PARTIALLY_COMPLETED
    return PLAN_STATUS_FAILED


# ---------------------------------------------------------------------------
# public view（Main 裁定：输出规范化显示键，不带 _json 后缀）
# ---------------------------------------------------------------------------

def _node_summaries(plan: ProposalPlan) -> dict[str, str]:
    material = plan.immutable_json if isinstance(plan.immutable_json, Mapping) else {}
    summaries: dict[str, str] = {}
    for group in material.get("groups") or []:
        for node in (group or {}).get("nodes") or []:
            node_id = str((node or {}).get("node_id") or "")
            if node_id:
                summaries[node_id] = str((node or {}).get("summary") or "")
    return summaries


def public_plan_view(plan: Any) -> dict[str, Any]:
    """返回展示安全的计划视图；args/target/display 已脱敏，无 *_json 键。"""
    if isinstance(plan, ProposalPlan):
        groups = sorted(
            (plan.groups or []),
            key=lambda item: (item.sequence, item.group_id),
        )
        summaries = _node_summaries(plan)
        return {
            "plan_id": plan.plan_id,
            "run_id": plan.run_id,
            "revision": plan.revision,
            "title": plan.title,
            "purpose": plan.purpose,
            "status": plan.status,
            "plan_digest": plan.plan_digest,
            "supersedes_plan_id": plan.supersedes_plan_id,
            "created_at": _iso(plan.created_at),
            "updated_at": _iso(plan.updated_at),
            "sealed_at": _iso(plan.sealed_at),
            "groups": [
                _public_group_view(group, summaries=summaries)
                for group in groups
            ],
        }
    if isinstance(plan, Mapping):
        return {
            "plan_id": plan.get("plan_id"),
            "run_id": plan.get("run_id"),
            "revision": plan.get("revision"),
            "title": plan.get("title") or "",
            "purpose": plan.get("purpose") or "",
            "status": plan.get("status") or "",
            "plan_digest": plan.get("plan_digest") or "",
            "supersedes_plan_id": plan.get("supersedes_plan_id"),
            "created_at": _iso(plan.get("created_at")),
            "updated_at": _iso(plan.get("updated_at")),
            "sealed_at": _iso(plan.get("sealed_at")),
            "groups": [
                _public_group_view(group, summaries={})
                for group in plan.get("groups") or []
            ],
        }
    raise DecisionPlanError(f"public_plan_view 需要 ProposalPlan 或 dict，收到 {type(plan)!r}")


def _public_group_view(group: Any, *, summaries: Mapping[str, str]) -> dict[str, Any]:
    if isinstance(group, DecisionGroup):
        nodes = sorted(
            (group.nodes or []),
            key=lambda item: (item.sequence, item.node_id),
        )
        return {
            "group_id": group.group_id,
            "sequence": group.sequence,
            "title": group.title,
            "summary": group.summary,
            "risk_level": group.risk_level,
            "status": group.status,
            "group_digest": group.group_digest,
            "dependency_group_ids": list(group.dependency_group_ids_json or []),
            "display": redact_secret_value(group.display_json or {}),
            "nodes": [
                _public_node_view(node, summary=summaries.get(node.node_id, ""))
                for node in nodes
            ],
        }
    if isinstance(group, Mapping):
        return {
            "group_id": group.get("group_id"),
            "sequence": group.get("sequence"),
            "title": group.get("title") or "",
            "summary": group.get("summary") or "",
            "risk_level": group.get("risk_level") or "",
            "status": group.get("status") or "",
            "group_digest": group.get("group_digest") or "",
            "dependency_group_ids": list(
                group.get("dependency_group_ids")
                or group.get("dependency_group_ids_json")
                or []
            ),
            "display": redact_secret_value(group.get("display") or {}),
            "nodes": [
                _public_node_view(node, summary="")
                for node in group.get("nodes") or []
            ],
        }
    raise DecisionPlanError(f"无法渲染 decision group: {type(group)!r}")


def _public_node_view(node: Any, *, summary: str) -> dict[str, Any]:
    if isinstance(node, OperationNode):
        return {
            "node_id": node.node_id,
            "sequence": node.sequence,
            "operation": node.operation,
            "operation_version": node.operation_version,
            "args": redact_secret_value(node.args_json or {}),
            "args_digest": node.args_digest,
            "target": redact_secret_value(node.target_json or {}),
            "target_digest": node.target_digest,
            "idempotency_key": node.idempotency_key,
            "status": node.status,
            "attempt_count": node.attempt_count,
            "summary": summary,
            "started_at": _iso(node.started_at),
            "completed_at": _iso(node.completed_at),
        }
    if isinstance(node, Mapping):
        return {
            "node_id": node.get("node_id"),
            "sequence": node.get("sequence"),
            "operation": node.get("operation") or "",
            "operation_version": node.get("operation_version") or "",
            "args": redact_secret_value(node.get("args") or {}),
            "args_digest": node.get("args_digest") or "",
            "target": redact_secret_value(node.get("target") or {}),
            "target_digest": node.get("target_digest") or "",
            "idempotency_key": node.get("idempotency_key") or "",
            "status": node.get("status") or "",
            "attempt_count": int(node.get("attempt_count") or 0),
            "summary": str(node.get("summary") or ""),
            "started_at": _iso(node.get("started_at")),
            "completed_at": _iso(node.get("completed_at")),
        }
    raise DecisionPlanError(f"无法渲染 operation node: {type(node)!r}")


# ---------------------------------------------------------------------------
# 内部加载
# ---------------------------------------------------------------------------

async def _load_plan(db: Any, plan_id: str) -> Optional[ProposalPlan]:
    return await db.get(ProposalPlan, str(plan_id or ""))


async def _nonterminal_plans(db: Any, run_id: str) -> list[ProposalPlan]:
    result = await db.execute(
        select(ProposalPlan).where(
            ProposalPlan.run_id == run_id,
            ProposalPlan.status.in_(sorted(PLAN_NONTERMINAL_STATUSES)),
        )
    )
    return list(result.scalars().all())


async def _next_revision(db: Any, run_id: str) -> int:
    result = await db.execute(
        select(ProposalPlan.revision)
        .where(ProposalPlan.run_id == run_id)
        .order_by(ProposalPlan.revision.desc())
        .limit(1)
    )
    latest = result.scalar_one_or_none()
    return int(latest or 0) + 1


# ---------------------------------------------------------------------------
# 创建
# ---------------------------------------------------------------------------

async def create_decision_plan(
    *,
    run_id: str,
    title: str,
    purpose: str,
    groups: Any,
    supersedes_plan_id: Optional[str] = None,
) -> dict[str, Any]:
    """创建并封存一个决策计划；同一 run 同时只允许一个非终态计划。

    - run_id 必须绑定到已持久化的 AgentRun（由宿主/调用方保证可信绑定）。
    - 校验注册 Operation、依赖 DAG（仅允许更早的组）、风险等级、非空组，
      以及禁止节点间动态输出引用。
    - supersedes_plan_id 会把同 run 的既有非终态计划标记为 superseded，
      其未开始的组/节点转为 stale。
    """
    clean_run_id = _clean_str(run_id, field="run_id")
    clean_title = _clean_str(title, field="title")
    clean_purpose = str(purpose or "").strip()
    normalized_groups = _normalize_groups(groups)

    async with async_session() as db:
        run = await db.get(AgentRunRecord, clean_run_id)
        if run is None:
            raise DecisionPlanNotFoundError(f"agent run 不存在: {clean_run_id}")

        superseded_plan: Optional[ProposalPlan] = None
        if supersedes_plan_id is not None:
            superseded_plan = await _load_plan(db, str(supersedes_plan_id))
            if superseded_plan is None:
                raise DecisionPlanNotFoundError(
                    f"supersedes_plan_id 不存在: {supersedes_plan_id}"
                )
            if superseded_plan.run_id != clean_run_id:
                raise DecisionPlanError(
                    "supersedes_plan_id 必须属于同一个 run"
                )
            if superseded_plan.status in PLAN_TERMINAL_STATUSES:
                raise DecisionConflictError(
                    f"计划 {superseded_plan.plan_id} 已是终态 {superseded_plan.status}，"
                    "不能 supersede"
                )
            superseded_plan.status = PLAN_STATUS_SUPERSEDED

            superseded_plan.updated_at = _utcnow()
            for group in superseded_plan.groups or []:
                if group.status in {
                    GROUP_STATUS_PENDING,
                    GROUP_STATUS_APPROVED,
                }:
                    group.status = GROUP_STATUS_STALE
                    for node in group.nodes or []:
                        if node.status in {
                            NODE_STATUS_PENDING,
                            NODE_STATUS_AUTHORIZED,
                        }:
                            node.status = NODE_STATUS_STALE

        others = [
            plan
            for plan in await _nonterminal_plans(db, clean_run_id)
            if superseded_plan is None or plan.plan_id != superseded_plan.plan_id
        ]
        if others:
            raise DecisionConflictError(
                f"run {clean_run_id} 已有非终态计划 "
                f"{[plan.plan_id for plan in others]}；需 supersede 或先推进到终态"
            )

        revision = await _next_revision(db, clean_run_id)
        plan_id = _new_id("plan")
        sealed_at = _utcnow()

        group_materials: list[dict[str, Any]] = []
        group_ids: list[str] = []
        plan_rows: list[tuple[DecisionGroup, list[OperationNode]]] = []

        for index, spec in enumerate(normalized_groups):
            group_id = _new_id("group")
            group_ids.append(group_id)
            dependency_group_ids = [
                group_ids[dep] for dep in spec["dependency_indices"]
            ]
            node_materials: list[dict[str, Any]] = []
            node_rows: list[OperationNode] = []
            for node_index, node_spec in enumerate(spec["nodes"]):
                node_id = _new_id("node")
                args = node_spec["args"]
                target = node_spec["target"]
                args_digest = canonical_digest(args)
                target_digest = canonical_digest(target)
                idempotency_key = node_idempotency_key(node_id, args_digest)
                node_material = {
                    "node_id": node_id,
                    "sequence": node_index,
                    "operation": node_spec["operation"],
                    "operation_version": node_spec["operation_version"],
                    "args": args,
                    "target": target,
                    "summary": node_spec["summary"],
                    "idempotency_key": idempotency_key,
                }
                node_materials.append(node_material)
                node_rows.append(
                    OperationNode(
                        node_id=node_id,
                        plan_id=plan_id,
                        group_id=group_id,
                        sequence=node_index,
                        operation=node_spec["operation"],
                        operation_version=node_spec["operation_version"],
                        args_json=args,
                        args_digest=args_digest,
                        target_json=target,
                        target_digest=target_digest,
                        idempotency_key=idempotency_key,
                        status=NODE_STATUS_PENDING,
                    )
                )
            group_material = {
                "group_id": group_id,
                "sequence": index,
                "title": spec["title"],
                "summary": spec["summary"],
                "risk_level": spec["risk_level"],
                "dependency_group_ids": dependency_group_ids,
                "display": spec["display"],
                "nodes": node_materials,
            }
            group_materials.append(group_material)
            plan_rows.append(
                (
                    DecisionGroup(
                        group_id=group_id,
                        plan_id=plan_id,
                        sequence=index,
                        title=spec["title"],
                        summary=spec["summary"],
                        risk_level=spec["risk_level"],
                        status=GROUP_STATUS_PENDING,
                        dependency_group_ids_json=dependency_group_ids,
                        display_json=spec["display"],
                        group_digest=canonical_digest(group_material),
                    ),
                    node_rows,
                )
            )

        immutable_json = {
            "plan_id": plan_id,
            "run_id": clean_run_id,
            "revision": revision,
            "title": clean_title,
            "purpose": clean_purpose,
            "supersedes_plan_id": (
                str(supersedes_plan_id) if supersedes_plan_id else None
            ),
            "groups": group_materials,
        }
        plan = ProposalPlan(
            plan_id=plan_id,
            run_id=clean_run_id,
            revision=revision,
            title=clean_title,
            purpose=clean_purpose,
            status=PLAN_STATUS_PENDING,
            immutable_json=immutable_json,
            plan_digest=canonical_digest(immutable_json),
            supersedes_plan_id=(
                str(supersedes_plan_id) if supersedes_plan_id else None
            ),
            sealed_at=sealed_at,
        )
        db.add(plan)
        for group_row, node_rows in plan_rows:
            db.add(group_row)
            for node_row in node_rows:
                db.add(node_row)
        # db.add() never SELECTs: assign the collections so public_plan_view
        # reads in-memory objects without triggering lazy IO.
        for group_row, node_rows in plan_rows:
            group_row.nodes = list(node_rows)
        plan.groups = [group_row for group_row, _ in plan_rows]
        try:
            await db.commit()
        except IntegrityError as exc:
            await db.rollback()
            raise DecisionConflictError(
                "并发计划创建冲突；同一 run 同时只允许一个非终态计划"
            ) from exc
        return public_plan_view(plan)


async def create_single_operation_plan(
    *,
    run_id: str,
    operation: str,
    args: Any,
    summary: str,
    target: Any = None,
) -> dict[str, Any]:
    """为通用受保护变更生成单组单节点计划（Registry dry-run 由调用方负责）。"""
    from app.ops import OPERATIONS

    clean_operation = _clean_str(operation, field="operation")
    registered = OPERATIONS.get(clean_operation)
    if registered is None:
        raise DecisionPlanError(f"operation 未注册: {clean_operation}")
    clean_summary = _clean_str(summary, field="summary")
    risk_level = "L3" if registered.is_mutation else "L1"
    return await create_decision_plan(
        run_id=run_id,
        title=clean_summary,
        purpose=f"单个受保护操作: {clean_operation}",
        groups=[
            {
                "title": clean_summary,
                "summary": clean_summary,
                "risk_level": risk_level,
                "dependency_indices": [],
                "display": {"kind": "single_operation"},
                "nodes": [
                    {
                        "operation": clean_operation,
                        "args": args,
                        "target": target,
                        "summary": clean_summary,
                    }
                ],
            }
        ],
    )


# ---------------------------------------------------------------------------
# 查询
# ---------------------------------------------------------------------------

async def get_decision_plan(plan_id: str) -> dict[str, Any]:
    """按 plan_id 返回展示安全视图；不存在则抛 DecisionPlanNotFoundError。"""
    async with async_session() as db:
        plan = await _load_plan(db, plan_id)
        if plan is None:
            raise DecisionPlanNotFoundError(f"decision plan 不存在: {plan_id}")
        return public_plan_view(plan)


async def get_active_decision_plan(run_id: str) -> Optional[dict[str, Any]]:
    """返回 run 当前唯一的非终态计划；多于一个视为数据损坏，fail closed。"""
    clean_run_id = _clean_str(run_id, field="run_id")
    async with async_session() as db:
        plans = await _nonterminal_plans(db, clean_run_id)
        if not plans:
            return None
        plans.sort(key=lambda item: item.revision)
        if len(plans) > 1:
            raise DecisionConflictError(
                f"run {clean_run_id} 存在多个非终态计划: "
                f"{[plan.plan_id for plan in plans]}"
            )
        return public_plan_view(plans[-1])


async def list_pending_decision_plans(limit: int = 50) -> dict[str, Any]:
    """列出所有仍可能阻塞用户的非终态计划（pending/executing/needs_reconciliation）。"""
    bounded = max(1, min(int(limit or 50), 200))
    async with async_session() as db:
        result = await db.execute(
            select(ProposalPlan)
            .where(
                ProposalPlan.status.in_(
                    [
                        PLAN_STATUS_PENDING,
                        PLAN_STATUS_EXECUTING,
                        PLAN_STATUS_NEEDS_RECONCILIATION,
                    ]
                )
            )
            .order_by(ProposalPlan.created_at.desc())
            .limit(bounded)
        )
        plans = [public_plan_view(plan) for plan in result.scalars().all()]
    return {"plans": plans, "count": len(plans)}


# ---------------------------------------------------------------------------
# 组级决策记录（含拒绝级联）
# ---------------------------------------------------------------------------

def _decision_payload(
    *,
    decision_row: ConfirmationDecision,
    group_status: str,
    plan_status: str,
    replayed: bool,
    blocked_group_ids: list[str],
    blocked_node_ids: list[str],
) -> dict[str, Any]:
    return {
        "ok": True,
        "decision_id": decision_row.decision_id,
        "plan_id": decision_row.plan_id,
        "group_id": decision_row.group_id,
        "decision": decision_row.decision,
        "surface": decision_row.surface,
        "decided_at": _iso(decision_row.created_at),
        "group_status": group_status,
        "plan_status": plan_status,
        "replayed": replayed,
        "blocked_group_ids": blocked_group_ids,
        "blocked_node_ids": blocked_node_ids,
    }


def _collect_blocked_dependents(
    plan: ProposalPlan, seed_group_ids: set[str]
) -> tuple[list[DecisionGroup], list[OperationNode]]:
    """拒绝级联的纯计算部分：收集所有待启动的传递依赖组与节点，不做修改。

    只覆盖 pending/approved 的组与 pending/authorized 的节点；
    executing/completed/failed/needs_reconciliation/stale 一律不动（fail closed）。
    """
    blocked_ids = set(seed_group_ids)
    blocked_groups: list[DecisionGroup] = []
    blocked_nodes: list[OperationNode] = []
    changed = True
    while changed:
        changed = False
        for group in plan.groups or []:
            if group.group_id in blocked_ids:
                continue
            if group.status not in {GROUP_STATUS_PENDING, GROUP_STATUS_APPROVED}:
                continue
            deps = set(group.dependency_group_ids_json or [])
            if not deps & blocked_ids:
                continue
            blocked_ids.add(group.group_id)
            blocked_groups.append(group)
            for node in group.nodes or []:
                if node.status in {NODE_STATUS_PENDING, NODE_STATUS_AUTHORIZED}:
                    blocked_nodes.append(node)
            changed = True
    return blocked_groups, blocked_nodes


def _apply_blocked(
    blocked_groups: Iterable[DecisionGroup],
    blocked_nodes: Iterable[OperationNode],
) -> None:
    for group in blocked_groups:
        group.status = GROUP_STATUS_BLOCKED
    for node in blocked_nodes:
        node.status = NODE_STATUS_BLOCKED


async def record_group_decision(
    *,
    plan_id: str,
    group_id: str,
    decision_id: str,
    decision: str,
    plan_digest: str,
    group_digest: str,
    surface: str,
) -> dict[str, Any]:
    """记录一次组级批准/拒绝；decision_id 幂等，字段不一致的重放拒绝。

    - 校验 plan/group 存在且归属一致、双摘要与封存值匹配、计划未终态；
    - 相同 decision_id + 完全相同字段 → 返回已存结果（replayed=True）；
    - 相同 decision_id + 任一字段不同 → DecisionConflictError；
    - 一组只允许一个终态决策；
    - approve：组→approved、pending 节点→authorized；
    - reject：组→rejected、pending 节点→rejected，并阻断全部传递依赖。
    """
    clean_plan_id = _clean_str(plan_id, field="plan_id")
    clean_group_id = _clean_str(group_id, field="group_id")
    clean_decision_id = _clean_str(decision_id, field="decision_id")
    clean_decision = _clean_str(decision, field="decision").lower()
    if clean_decision not in _DECISIONS:
        raise DecisionPlanError(f"decision 必须是 approve/reject: {decision!r}")
    clean_plan_digest = _clean_str(plan_digest, field="plan_digest")
    clean_group_digest = _clean_str(group_digest, field="group_digest")
    clean_surface = str(surface or "unknown").strip() or "unknown"

    async with async_session() as db:
        stored = await db.get(ConfirmationDecision, clean_decision_id)
        if stored is not None:
            identical = (
                stored.plan_id == clean_plan_id
                and stored.group_id == clean_group_id
                and stored.decision == clean_decision
                and stored.plan_digest == clean_plan_digest
                and stored.group_digest == clean_group_digest
                and stored.surface == clean_surface
            )
            if not identical:
                raise DecisionConflictError(
                    f"decision_id {clean_decision_id} 重放字段不一致，已拒绝"
                )
            group = await db.get(DecisionGroup, stored.group_id)
            plan = await _load_plan(db, stored.plan_id)
            blocked_groups, blocked_nodes = (
                _collect_blocked_dependents(plan, {stored.group_id})
                if plan is not None
                else ([], [])
            )
            return _decision_payload(
                decision_row=stored,
                group_status=group.status if group is not None else "",
                plan_status=plan.status if plan is not None else "",
                replayed=True,
                blocked_group_ids=[item.group_id for item in blocked_groups],
                blocked_node_ids=[item.node_id for item in blocked_nodes],
            )

        plan = await _load_plan(db, clean_plan_id)
        if plan is None:
            raise DecisionPlanNotFoundError(f"decision plan 不存在: {clean_plan_id}")
        group = await db.get(DecisionGroup, clean_group_id)
        if group is None:
            raise DecisionPlanNotFoundError(
                f"decision group 不存在: {clean_group_id}"
            )
        if group.plan_id != clean_plan_id:
            raise DecisionConflictError(
                f"group {clean_group_id} 不属于 plan {clean_plan_id}"
            )
        if plan.status in PLAN_TERMINAL_STATUSES:
            raise DecisionConflictError(
                f"计划已是终态 {plan.status}，不能再记录决策"
            )
        if plan.status == PLAN_STATUS_NEEDS_RECONCILIATION:
            raise DecisionConflictError(
                "计划处于 needs_reconciliation，先完成恢复再决策"
            )
        if plan.plan_digest != clean_plan_digest:
            raise DecisionConflictError("plan_digest 与封存计划不匹配")
        if group.group_digest != clean_group_digest:
            raise DecisionConflictError("group_digest 与封存组不匹配")

        prior = await db.execute(
            select(ConfirmationDecision.decision_id).where(
                ConfirmationDecision.group_id == clean_group_id
            )
        )
        if prior.first() is not None:
            raise DecisionConflictError(
                f"group {clean_group_id} 已有终态决策"
            )
        if group.status != GROUP_STATUS_PENDING:
            raise DecisionConflictError(
                f"group {clean_group_id} 当前状态 {group.status} 不可决策"
            )

        decision_row = ConfirmationDecision(
            decision_id=clean_decision_id,
            plan_id=clean_plan_id,
            group_id=clean_group_id,
            decision=clean_decision,
            plan_digest=clean_plan_digest,
            group_digest=clean_group_digest,
            surface=clean_surface,
        )
        db.add(decision_row)

        blocked_groups: list[DecisionGroup] = []
        blocked_nodes: list[OperationNode] = []
        if clean_decision == DECISION_APPROVE:
            group.status = GROUP_STATUS_APPROVED
            for node in group.nodes or []:
                if node.status == NODE_STATUS_PENDING:
                    node.status = NODE_STATUS_AUTHORIZED
        else:
            group.status = GROUP_STATUS_REJECTED
            for node in group.nodes or []:
                if node.status == NODE_STATUS_PENDING:
                    node.status = NODE_STATUS_REJECTED
            blocked_groups, blocked_nodes = _collect_blocked_dependents(
                plan, {group.group_id}
            )
            _apply_blocked(blocked_groups, blocked_nodes)

        plan.status = compute_plan_status(
            [item.status for item in plan.groups or []]
        )
        plan.updated_at = _utcnow()
        try:
            await db.commit()
        except IntegrityError as exc:
            await db.rollback()
            raise DecisionConflictError(
                f"decision_id {clean_decision_id} 并发冲突"
            ) from exc
        return _decision_payload(
            decision_row=decision_row,
            group_status=group.status,
            plan_status=plan.status,
            replayed=False,
            blocked_group_ids=[item.group_id for item in blocked_groups],
            blocked_node_ids=[item.node_id for item in blocked_nodes],
        )


__all__ = [
    "DECISION_APPROVE",
    "DECISION_REJECT",
    "DecisionConflictError",
    "DecisionPlanError",
    "DecisionPlanNotFoundError",
    "GROUP_ACTIONABLE_STATUSES",
    "GROUP_TERMINAL_STATUSES",
    "NODE_TERMINAL_STATUSES",
    "PLAN_NONTERMINAL_STATUSES",
    "PLAN_TERMINAL_STATUSES",
    "RISK_LEVELS",
    "canonical_digest",
    "canonical_json",
    "compute_plan_status",
    "create_decision_plan",
    "create_single_operation_plan",
    "get_active_decision_plan",
    "get_decision_plan",
    "list_pending_decision_plans",
    "node_idempotency_key",
    "public_plan_view",
    "record_group_decision",
]
