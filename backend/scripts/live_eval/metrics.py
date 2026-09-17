"""Deterministic aggregate metrics for Live Eval and SkillRoute runs."""

from __future__ import annotations

import math
from typing import Any


def _rate(values: list[bool]) -> float | None:
    return round(sum(values) / len(values), 4) if values else None


def _average(values: list[float]) -> float:
    return round(sum(values) / len(values), 4) if values else 0.0


def aggregate_metrics(results: list[dict[str, Any]]) -> dict[str, Any]:
    total = len(results)
    passed = sum(item.get("status") == "PASS" for item in results)
    provider_failures = sum(item.get("issue_type") == "provider_failure" for item in results)
    hard_gate_hits = sum(bool(item.get("hard_gate_violations")) for item in results)
    by_case: dict[str, list[bool]] = {}
    for item in results:
        by_case.setdefault(str(item.get("case_id") or ""), []).append(item.get("status") == "PASS")

    routing = [item.get("routing") for item in results if isinstance(item.get("routing"), dict)]
    top1 = [bool(item["top1_correct"]) for item in routing if item.get("top1_correct") is not None]
    recovery = [
        bool(item["recovery_correct"])
        for item in routing
        if item.get("recovery_correct") is not None
    ]
    latencies = sorted(float(item.get("elapsed_s") or 0.0) for item in results)
    p95 = latencies[max(0, math.ceil(len(latencies) * 0.95) - 1)] if latencies else 0.0
    all_pass = sum(1 for values in by_case.values() if values and all(values))
    top1_rate = _rate(top1)
    return {
        "pass_at_1": round(passed / total, 4) if total else 0.0,
        "pass_power_k": round(all_pass / len(by_case), 4) if by_case else 0.0,
        "provider_failure_rate": round(provider_failures / total, 4) if total else 0.0,
        "hard_gate_rate": round(hard_gate_hits / total, 4) if total else 0.0,
        "avg_latency_s": round(_average(latencies), 1),
        "p95_latency_s": round(p95, 1),
        "skill_top1_accuracy": top1_rate,
        "skill_top3_or_recovery_accuracy": _rate(recovery),
        "wrong_skill_rate": round(1.0 - top1_rate, 4) if top1_rate is not None else None,
        "avg_skill_expansions_per_task": _average([
            float(item.get("skill_expansion_count") or 0) for item in routing
        ]),
        "avg_schemas_loaded_per_task": _average([
            float(item.get("schema_load_count") or 0) for item in routing
        ]),
        "avg_operations_per_task": _average([
            float(item.get("operation_call_count") or 0) for item in routing
        ]),
        "full_registry_bootstrap_rate": _rate([
            bool(item.get("full_registry_bootstrap_used")) for item in routing
        ]),
    }


__all__ = ["aggregate_metrics"]
