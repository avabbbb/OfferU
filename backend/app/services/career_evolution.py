"""Deterministic Profile snapshots and longitudinal deltas.

Profile entries are the current projection of the Career Memory ledger.  This
module compares two projections without asking an LLM to rewrite history, so a
T0/T1/T2 acceptance run can explain exactly what changed and why.
"""

from __future__ import annotations

import hashlib
import json
from collections import Counter
from datetime import datetime, timezone
from typing import Any, Iterable


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _canonical(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _entry_slot(entry: dict[str, Any]) -> tuple[str, str]:
    return (
        str(entry.get("section_type") or "").strip().lower(),
        str(entry.get("title") or "").strip().casefold(),
    )


def _entry_content_key(entry: dict[str, Any]) -> str:
    return _canonical(
        {
            "section_type": str(entry.get("section_type") or "").strip().lower(),
            "title": str(entry.get("title") or "").strip(),
            "content_json": entry.get("content_json") or {},
            "tier": entry.get("tier") or "verified_fact",
        }
    )


def _public_entry(entry: dict[str, Any]) -> dict[str, Any]:
    return {
        key: entry.get(key)
        for key in (
            "id",
            "section_type",
            "title",
            "content_json",
            "tier",
            "source_count",
            "source_status",
            "status",
            "superseded_by_id",
        )
        if key in entry
    }


def _observation_stage(content: Any) -> tuple[str, str]:
    """Read canonical or email-derived application stages from an observation."""

    if not isinstance(content, dict):
        return "", ""
    classification = content.get("classification")
    classification = classification if isinstance(classification, dict) else {}
    stage = str(
        content.get("stage")
        or content.get("suggested_stage")
        or classification.get("suggested_stage")
        or ""
    ).strip().lower()
    previous_stage = str(
        content.get("previous_stage")
        or classification.get("previous_stage")
        or ""
    ).strip().lower()
    return stage, previous_stage


def _timeline(observations: Iterable[dict[str, Any]], proposals: Iterable[dict[str, Any]]) -> list[dict[str, Any]]:
    """Group evidence and ledger changes by observed calendar day.

    A day is intentionally used instead of a process-run id: Gmail history,
    Resume import and interview observations can arrive through different
    transports while still needing one chronological audit surface.
    """

    buckets: dict[str, dict[str, Any]] = {}
    for item in observations:
        if not isinstance(item, dict):
            continue
        observed_at = str(item.get("observed_at") or "").strip()
        period = observed_at[:10] if len(observed_at) >= 10 else "unknown"
        bucket = buckets.setdefault(
            period,
            {
                "period": period,
                "first_observed_at": observed_at,
                "last_observed_at": observed_at,
                "observation_count": 0,
                "proposal_count": 0,
                "accepted_count": 0,
                "rejected_count": 0,
                "source_types": set(),
                "observation_types": set(),
            },
        )
        bucket["observation_count"] += 1
        source = item.get("source")
        source_type = source.get("source_type") if isinstance(source, dict) else None
        if source_type:
            bucket["source_types"].add(str(source_type))
        if item.get("observation_type"):
            bucket["observation_types"].add(str(item["observation_type"]))
        if observed_at and (
            not bucket["first_observed_at"] or observed_at < bucket["first_observed_at"]
        ):
            bucket["first_observed_at"] = observed_at
        if observed_at > str(bucket["last_observed_at"] or ""):
            bucket["last_observed_at"] = observed_at

    for proposal in proposals:
        if not isinstance(proposal, dict):
            continue
        created_at = str(proposal.get("created_at") or "").strip()
        period = created_at[:10] if len(created_at) >= 10 else "unknown"
        bucket = buckets.setdefault(
            period,
            {
                "period": period,
                "first_observed_at": created_at,
                "last_observed_at": created_at,
                "observation_count": 0,
                "proposal_count": 0,
                "accepted_count": 0,
                "rejected_count": 0,
                "source_types": set(),
                "observation_types": set(),
            },
        )
        bucket["proposal_count"] += 1
        if proposal.get("status") == "accepted":
            bucket["accepted_count"] += 1
        if proposal.get("status") in {"rejected", "revoked", "invalidated"}:
            bucket["rejected_count"] += 1

    result: list[dict[str, Any]] = []
    for period, bucket in sorted(buckets.items(), reverse=True):
        result.append(
            {
                **bucket,
                "source_types": sorted(bucket["source_types"]),
                "observation_types": sorted(bucket["observation_types"]),
            }
        )
    return result


def capture_profile_snapshot(model: dict[str, Any], *, label: str = "current") -> dict[str, Any]:
    """Normalize a derived career model into a comparable immutable snapshot."""

    if not isinstance(model, dict):
        raise ValueError("career model 必须是对象")
    entries = [
        _public_entry(item)
        for item in model.get("entries") or []
        if isinstance(item, dict) and str(item.get("status") or "active") == "active"
    ]
    entries.sort(key=lambda item: (_entry_slot(item), _entry_content_key(item)))
    payload = {
        "profile_id": model.get("profile_id"),
        "entries": entries,
        "entry_count": len(entries),
    }
    snapshot_hash = hashlib.sha256(_canonical(payload).encode("utf-8")).hexdigest()
    return {
        "schema": "offeru.profile_snapshot.v1",
        "label": str(label or "current").strip()[:80] or "current",
        "captured_at": _now(),
        "snapshot_hash": snapshot_hash,
        **payload,
    }


def compare_profile_snapshots(
    before: dict[str, Any],
    after: dict[str, Any],
    *,
    rejected: Iterable[dict[str, Any]] | None = None,
    hypotheses: Iterable[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Return an auditable delta between two Profile projections.

    Matching is by section and title first, then by canonical content.  A
    changed value in an existing slot is reported as a conflict instead of
    silently replacing the old truth.
    """

    before_items = [item for item in before.get("entries") or [] if isinstance(item, dict)]
    after_items = [item for item in after.get("entries") or [] if isinstance(item, dict)]
    before_by_key = {_entry_content_key(item): item for item in before_items}
    after_by_key = {_entry_content_key(item): item for item in after_items}
    before_by_slot: dict[tuple[str, str], list[dict[str, Any]]] = {}
    after_by_slot: dict[tuple[str, str], list[dict[str, Any]]] = {}
    for item in before_items:
        before_by_slot.setdefault(_entry_slot(item), []).append(item)
    for item in after_items:
        after_by_slot.setdefault(_entry_slot(item), []).append(item)

    added = [
        _public_entry(item)
        for key, item in after_by_key.items()
        if key not in before_by_key
        and _entry_slot(item) not in before_by_slot
    ]
    removed = [
        _public_entry(item)
        for key, item in before_by_key.items()
        if key not in after_by_key
        and _entry_slot(item) not in after_by_slot
    ]
    strengthened: list[dict[str, Any]] = []
    conflicts: list[dict[str, Any]] = []
    for slot, before_slot_items in before_by_slot.items():
        after_slot_items = after_by_slot.get(slot) or []
        if not after_slot_items:
            continue
        before_item = before_slot_items[0]
        after_item = next(
            (item for item in after_slot_items if _entry_content_key(item) == _entry_content_key(before_item)),
            after_slot_items[0],
        )
        if _entry_content_key(before_item) != _entry_content_key(after_item):
            conflicts.append(
                {
                    "slot": {"section_type": slot[0], "title": slot[1]},
                    "before": _public_entry(before_item),
                    "after": _public_entry(after_item),
                    "reason": "same_profile_slot_changed_requires_review",
                }
            )
        elif int(after_item.get("source_count") or 0) > int(before_item.get("source_count") or 0):
            strengthened.append(
                {
                    "entry": _public_entry(after_item),
                    "previous_source_count": int(before_item.get("source_count") or 0),
                    "source_count": int(after_item.get("source_count") or 0),
                }
            )

    rejected_items = [
        dict(item)
        for item in (rejected or [])
        if isinstance(item, dict)
    ]
    hypothesis_items = [
        dict(item)
        for item in (hypotheses or [])
        if isinstance(item, dict)
    ]
    return {
        "schema": "offeru.profile_evolution_delta.v1",
        "before": {
            "label": before.get("label") or "before",
            "snapshot_hash": before.get("snapshot_hash") or "",
            "entry_count": len(before_items),
        },
        "after": {
            "label": after.get("label") or "after",
            "snapshot_hash": after.get("snapshot_hash") or "",
            "entry_count": len(after_items),
        },
        "added_facts": added,
        "strengthened_facts": strengthened,
        "conflicts": conflicts,
        "replaced_facts": removed,
        "rejected_observations": rejected_items,
        "potential_hypotheses": hypothesis_items,
        "counts": {
            "added_facts": len(added),
            "strengthened_facts": len(strengthened),
            "conflicts": len(conflicts),
            "replaced_facts": len(removed),
            "rejected_observations": len(rejected_items),
            "potential_hypotheses": len(hypothesis_items),
        },
    }


async def get_profile_evolution_report(*, limit: int = 200) -> dict[str, Any]:
    """Build a current, read-only evolution report from the Career ledger."""

    from app.services.career_memory import (
        derive_career_model,
        list_career_ledger,
        list_learning_observations,
    )

    model = await derive_career_model()
    current = capture_profile_snapshot(model, label="current")
    ledger = await list_career_ledger(status="all", limit=max(1, min(int(limit), 500)))
    observations = await list_learning_observations(status="all", limit=max(1, min(int(limit), 500)))
    proposal_items = [item for item in ledger.get("entries") or [] if isinstance(item, dict)]
    observation_items = [item for item in observations.get("items") or [] if isinstance(item, dict)]
    rejected = [item for item in proposal_items if item.get("status") in {"rejected", "revoked", "invalidated"}]
    hypotheses = [
        item
        for item in proposal_items
        if item.get("target_tier") == "career_hypothesis"
        and item.get("status") in {"pending", "deferred", "accepted"}
    ]
    source_counts = Counter(str(item.get("source", {}).get("source_type") or "unknown") for item in observation_items)
    observation_type_counts = Counter(str(item.get("observation_type") or "unknown") for item in observation_items)
    application_changes = []
    for item in observation_items:
        stage, previous_stage = _observation_stage(item.get("content"))
        if not stage or stage == "unknown":
            continue
        source = item.get("source") if isinstance(item.get("source"), dict) else {}
        application_changes.append(
            {
                "observation_id": item.get("id"),
                "source_type": source.get("source_type"),
                "stage": stage,
                "previous_stage": previous_stage or None,
                "observation_type": item.get("observation_type"),
                "confirmed": item.get("observation_type") == "application_stage_confirmed",
                "candidate_id": item.get("content", {}).get("candidate_id")
                if isinstance(item.get("content"), dict)
                else None,
                "observed_at": item.get("observed_at"),
            }
        )
    return {
        "schema": "offeru.profile_evolution_report.v1",
        "generated_at": _now(),
        "current_snapshot": current,
        "ledger": {
            "total": len(proposal_items),
            "pending": sum(item.get("status") == "pending" for item in proposal_items),
            "accepted": sum(item.get("status") == "accepted" for item in proposal_items),
            "rejected": len(rejected),
        },
        "new_facts": [item for item in proposal_items if item.get("status") == "accepted"],
        "strengthened_facts": [
            item
            for item in proposal_items
            if item.get("before") and item.get("after") and item.get("status") in {"pending", "accepted"}
        ],
        "conflicts": [
            item
            for item in proposal_items
            if item.get("before") and item.get("after") and item.get("before") != item.get("after")
        ],
        "replaced_facts": [item for item in proposal_items if item.get("supersedes_proposal_id")],
        "rejected_observations": rejected,
        "potential_hypotheses": hypotheses,
        "application_status_changes": application_changes,
        "timeline": _timeline(observation_items, proposal_items),
        "observation_counts": {
            "by_source": dict(source_counts),
            "by_type": dict(observation_type_counts),
        },
        "evidence_coverage": {
            "active_profile_entries": len(current.get("entries") or []),
            "entries_with_sources": sum(bool(item.get("source_count")) for item in current.get("entries") or []),
            "source_traceability_ratio": (
                sum(bool(item.get("source_count")) for item in current.get("entries") or [])
                / len(current.get("entries") or [])
                if current.get("entries")
                else 1.0
            ),
        },
    }


__all__ = [
    "capture_profile_snapshot",
    "compare_profile_snapshots",
    "get_profile_evolution_report",
]
