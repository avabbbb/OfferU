"""Resume proposal → DecisionPlan composition (Proposal v2).

This module turns an already-persisted, workspace-bound
``ResumeOptimizationProposal`` into one ``ProposalPlan`` whose
``DecisionGroup``s are *semantic* review units chosen by the active Agent.
Each group authorizes exactly one atomic ``review_resume_proposal_items``
call — never one node per bullet — so the user approves a coherent set of
displayed section changes and the existing domain operation applies them
with its fact gates, stale checks and audit intact.

Authority boundaries kept:
- run binding comes from the trusted host execution context
  (``app.ops.current_operation_run_id``), never from model arguments;
- ``create_decision_plan`` (Domain) owns plan/group/node persistence, digests
  and the dependency DAG;
- ``review_resume_proposal_items`` (existing Registry Operation) owns
  per-item adoption, fact-gate ``blocked`` enforcement and freshness checks.
This module only validates the resume-side contract and composes the plan.
"""

from __future__ import annotations

import json
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import selectinload

from app.database import async_session
from app.models.models import (
    Job,
    Resume,
    ResumeOptimizationProposal,
)
from app.services.resume_workspace import workspace_content_hash


# Registry Operation each group executes atomically.  Changing this name is a
# contract change: node args/target material is sealed into group digests.
ADOPTION_OPERATION = "review_resume_proposal_items"
ADOPTION_ACTION = "accept"

# One proposal should map to a handful of semantic groups (3–7 typical); the
# ceiling guards against a model generating a per-bullet approval queue.
MAX_GROUPS = 32
_MAX_TITLE = 120
_MAX_SUMMARY = 400
_MAX_CHANGE_ID = 120
# review_resume_proposal_items accepts 1..200 change ids per call.
_MAX_CHANGE_IDS_PER_GROUP = 200

# Plan-level grouping never covers proposal entries the user already reviewed
# (item_reviews_json) or any non-adoption proposal state; these statuses mean
# the proposal can no longer yield an honest adoption plan.
_TERMINAL_PROPOSAL_STATUSES = frozenset({"stale", "accepted", "rejected", "superseded"})
_BLOCKED_STATUSES = frozenset({"blocked"})
_KNOWN_CHANGE_TYPES = frozenset({"added", "removed", "modified", "reordered"})


def _text(value: Any, field: str, limit: int) -> str:
    if value is None:
        return ""
    if not isinstance(value, str):
        raise ValueError(f"{field} 必须是字符串")
    value = value.strip()
    if len(value) > limit:
        raise ValueError(f"{field} 长度不能超过 {limit}")
    return value


def _positive_id(value: Any, field: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        raise ValueError(f"{field} 必须是正整数")
    return value


def _active_run_id() -> str:
    """Authoritative AgentRun binding from the host execution context.

    The model can never supply or override ``run_id``; when the caller is not
    an embedded/host run execution the context is empty and planning fails
    closed instead of persisting an orphan plan.
    """
    from app.ops import current_operation_run_id

    run_id = str(current_operation_run_id() or "").strip()
    if not run_id:
        raise ValueError(
            "propose_resume_decision_plan 只能在被授权的 Agent Run 上下文中调用；"
            "缺少运行绑定时无法创建决策计划"
        )
    return run_id


def _json_display(value: Any, field: str) -> dict[str, Any]:
    if value is None:
        return {}
    if not isinstance(value, dict):
        raise ValueError(f"{field} 必须是对象")
    # Sealed into group_digest/display_json: must be canonical-JSON safe.
    try:
        json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{field} 必须是可 JSON 序列化的对象") from exc
    return value


def _dependency_indices(value: Any, index: int, group_count: int) -> list[int]:
    if value is None:
        return []
    if not isinstance(value, list):
        raise ValueError(f"groups[{index}].dependency_indices 必须是数组")
    indices: list[int] = []
    for item in value:
        if isinstance(item, bool) or not isinstance(item, int):
            raise ValueError(f"groups[{index}].dependency_indices 只能是整数下标")
        if item in indices:
            raise ValueError(f"groups[{index}].dependency_indices 存在重复下标")
        indices.append(item)
    for item in indices:
        # Contract: dependencies refer only to earlier groups in the same plan.
        if item < 0 or item >= index or item >= group_count:
            raise ValueError(
                f"groups[{index}].dependency_indices 只能引用本计划中更早的分组"
            )
    return indices


def _diff_index(diff_json: Any) -> dict[str, dict[str, Any]]:
    """Index the proposal's adoption diff by change_id.

    Only dict rows with a usable ``change_id`` and a recognized resume-adoption
    ``change_type`` are adoption changes; anything else is not reviewable
    through ``review_resume_proposal_items`` and is excluded from the index so
    referencing it fails closed as an unknown change.
    """
    index: dict[str, dict[str, Any]] = {}
    for item in diff_json if isinstance(diff_json, list) else []:
        if not isinstance(item, dict):
            continue
        change_id = str(item.get("change_id") or "").strip()
        change_type = str(item.get("change_type") or "").strip()
        if not change_id or change_type not in _KNOWN_CHANGE_TYPES:
            continue
        if not isinstance(item.get("before") or item.get("after"), dict):
            continue
        index[change_id] = item
    return index


def _reviewed_change_ids(item_reviews: Any) -> set[str]:
    reviewed: set[str] = set()
    for key, value in (item_reviews or {}).items() if isinstance(item_reviews, dict) else []:
        # Only an actual decision record counts; "…:pending_edit" gate flags
        # store edit confirmation state, not a reviewed action.
        if isinstance(value, dict) and str(value.get("action") or "") in {"accept", "reject"}:
            reviewed.add(str(key))
    return reviewed


def _target_evidence(proposal: ResumeOptimizationProposal, resume: Resume) -> dict[str, Any]:
    """Target revision evidence sealed into every node's target digest.

    ``review_resume_proposal_items`` re-checks ``workspace_snapshot_hash``
    (and JD/Profile hashes) at execution time; embedding the sealed snapshot
    here binds what the user saw and makes stale targets detectable from the
    plan itself.
    """
    return {
        "kind": "resume_workspace",
        "resume_id": resume.id,
        "proposal_id": proposal.proposal_id,
        "job_id": proposal.job_id,
        "workspace_revision": int(resume.workspace_revision or 0),
        "workspace_content_hash": workspace_content_hash(resume),
        "proposal_workspace_snapshot_hash": str(proposal.workspace_snapshot_hash or ""),
        "proposal_source_snapshot_hash": str(proposal.source_snapshot_hash or ""),
        "job_description_sha256": str(
            (proposal.strategy_json or {}).get("job_description_sha256") or ""
        ),
    }


def _validate_groups(
    groups: Any,
    *,
    diffs: dict[str, dict[str, Any]],
    reviewed: set[str],
) -> list[dict[str, Any]]:
    """Validate semantic group input and return normalized group specs.

    Enforces: non-empty unique-per-plan change ids that all exist in the
    proposal diff and are not already reviewed; earlier-only dependency DAG.
    """
    if not isinstance(groups, list) or not groups:
        raise ValueError("groups 必须是非空数组")
    if len(groups) > MAX_GROUPS:
        raise ValueError(f"groups 最多 {MAX_GROUPS} 个语义分组，请按主题合并改动")

    normalized: list[dict[str, Any]] = []
    assigned: dict[str, int] = {}
    for index, raw in enumerate(groups):
        field = f"groups[{index}]"
        if not isinstance(raw, dict):
            raise ValueError(f"{field} 必须是对象")
        title = _text(raw.get("title"), f"{field}.title", _MAX_TITLE)
        summary = _text(raw.get("summary"), f"{field}.summary", _MAX_SUMMARY)
        if not title or not summary:
            raise ValueError(f"{field} 需要 title 和 summary")
        change_ids_raw = raw.get("change_ids")
        if not isinstance(change_ids_raw, list) or not change_ids_raw:
            raise ValueError(f"{field}.change_ids 必须是非空数组")
        if len(change_ids_raw) > _MAX_CHANGE_IDS_PER_GROUP:
            raise ValueError(
                f"{field}.change_ids 最多 {_MAX_CHANGE_IDS_PER_GROUP} 个条目"
            )
        change_ids: list[str] = []
        for position, value in enumerate(change_ids_raw):
            change_id = _text(
                value, f"{field}.change_ids[{position}]", _MAX_CHANGE_ID
            )
            if not change_id:
                raise ValueError(f"{field}.change_ids[{position}] 不能为空")
            change_ids.append(change_id)
        if len(set(change_ids)) != len(change_ids):
            raise ValueError(f"{field}.change_ids 存在重复条目")
        for change_id in change_ids:
            if change_id in assigned:
                raise ValueError(
                    f"改动 {change_id} 已分配给 groups[{assigned[change_id]}]，"
                    "同一改动只能属于一个语义分组"
                )
            if change_id not in diffs:
                raise ValueError(f"改动 {change_id} 不存在于提案差异中，请重新生成计划")
            if change_id in reviewed:
                raise ValueError(f"改动 {change_id} 已有审核结果，不能再次计划")
            assigned[change_id] = index
        normalized.append(
            {
                "title": title,
                "summary": summary,
                "change_ids": change_ids,
                "dependency_indices": _dependency_indices(
                    raw.get("dependency_indices"), index, len(groups)
                ),
                "display": _json_display(raw.get("display"), f"{field}.display"),
            }
        )
    return normalized


async def propose_resume_decision_plan(
    *,
    proposal_id: str,
    resume_id: int,
    groups: Any,
) -> dict[str, Any]:
    """Validate the proposal/workspace binding and create one DecisionPlan.

    The active Agent groups the *pending* proposal changes into semantic
    review units (e.g. 定位摘要 / 核心经历 / 技能与项目).  Each unit executes
    once through the existing batch review Operation after independent user
    approval; nothing is adopted at proposal time.
    """
    clean_proposal_id = _text(proposal_id, "proposal_id", 80)
    if not clean_proposal_id:
        raise ValueError("proposal_id 不能为空")
    clean_resume_id = _positive_id(resume_id, "resume_id")

    async with async_session() as db:
        proposal = (
            await db.execute(
                select(ResumeOptimizationProposal).where(
                    ResumeOptimizationProposal.proposal_id == clean_proposal_id
                )
            )
        ).scalar_one_or_none()
        if proposal is None:
            raise ValueError("简历提案不存在")
        resume = (
            await db.execute(
                select(Resume)
                .where(Resume.id == clean_resume_id)
                .options(selectinload(Resume.sections))
            )
        ).scalar_one_or_none()
        if resume is None:
            raise ValueError(f"简历 #{clean_resume_id} 不存在")

        # Binding: the proposal must already be bound to this exact workspace
        # resume via ensure_resume_workspace; a mismatched job link is data
        # corruption and fails closed.
        if proposal.workspace_resume_id != resume.id:
            raise ValueError("该提案尚未绑定当前 Resume Workspace")
        if (
            resume.target_job_id is not None
            and int(resume.target_job_id) != int(proposal.job_id)
        ):
            raise ValueError("简历工作区与提案岗位不一致，请重新生成提案")

        if str(proposal.status) in _TERMINAL_PROPOSAL_STATUSES:
            raise ValueError(f"提案已处于终态 {proposal.status}，不能再生成决策计划")
        if str(proposal.status) in _BLOCKED_STATUSES:
            raise ValueError("提案已被事实门阻断，不能接受其中的改动")
        fact_gate_status = str((proposal.fact_gates_json or {}).get("status") or "")
        if fact_gate_status in _BLOCKED_STATUSES:
            raise ValueError("事实门处于 blocked，不能接受该建议")

        diffs = _diff_index(proposal.diff_json)
        reviewed = _reviewed_change_ids(proposal.item_reviews_json)
        pending_ids = [change_id for change_id in diffs if change_id not in reviewed]
        if not pending_ids:
            raise ValueError("提案没有待审核的改动，无需生成决策计划")

        normalized = _validate_groups(groups, diffs=diffs, reviewed=reviewed)
        job = await db.get(Job, proposal.job_id)
        target = _target_evidence(proposal, resume)

    # Build Domain group specs after the DB read: each semantic group carries
    # exactly one review_resume_proposal_items accept node — never one node
    # per bullet.
    plan_groups: list[dict[str, Any]] = []
    for spec in normalized:
        change_ids = spec["change_ids"]
        changes = [diffs[change_id] for change_id in change_ids]
        display = dict(spec["display"])
        display.update(
            {
                "kind": "resume_adoption_group",
                "proposal_id": clean_proposal_id,
                "resume_id": clean_resume_id,
                "change_ids": change_ids,
                "change_count": len(change_ids),
                "changes": changes,
            }
        )
        plan_groups.append(
            {
                "title": spec["title"],
                "summary": spec["summary"],
                # Resume adoption writes Career-Truth-visible content; per-item
                # review remains L2 regardless of the model's own grouping.
                "risk_level": "L2",
                "dependency_indices": spec["dependency_indices"],
                "display": display,
                "nodes": [
                    {
                        "operation": ADOPTION_OPERATION,
                        "args": {
                            "proposal_id": clean_proposal_id,
                            "resume_id": clean_resume_id,
                            "change_ids": change_ids,
                            "action": ADOPTION_ACTION,
                        },
                        "target": target,
                        "summary": (
                            f"采用 {spec['title']} 的 {len(change_ids)} 项已展示改动"
                        ),
                    }
                ],
            }
        )

    run_id = _active_run_id()
    from app.services.proposal_plan_preparation import prepare_proposal_plan

    label = ""
    if job is not None:
        label = " ".join(part for part in (job.company or "", job.title or "") if part).strip()
    title = f"{label or resume.title or '岗位定制'} 简历改动采纳计划"[:_MAX_TITLE]
    intents = []
    groups_v2 = []
    for index, group in enumerate(plan_groups):
        label = f"resume-group-{index}"
        node_labels = []
        for offset, node in enumerate(group["nodes"]):
            node_label = f"{label}-node-{offset}"
            intents.append({**node, "id": node_label})
            node_labels.append(node_label)
        groups_v2.append({
            "id": label, "title": group["title"], "summary": group["summary"],
            "display": group["display"], "node_ids": node_labels,
            "dependency_group_ids": [f"resume-group-{dependency}" for dependency in group["dependency_indices"]],
        })
    # The domain adapter preserves semantic grouping; only the v2 control
    # plane seals, authorizes and executes the exact Registry node set.
    return await prepare_proposal_plan(run_id=run_id, title=title, intents=intents, groups=groups_v2)
