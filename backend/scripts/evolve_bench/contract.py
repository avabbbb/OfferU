"""Deterministic contracts and metrics for OfferU-EvolveBench.

This module deliberately contains no model loop and no OfferU write path.  A
runner may use it to describe a task, record a trial, and grade the resulting
evidence.  Live model and browser execution stay outside the contract so a
scaffolded report can never be mistaken for a passing benchmark.
"""

from __future__ import annotations

import hashlib
import json
import math
import os
import re
import tempfile
import uuid
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from statistics import mean
from typing import Any, Iterable, Mapping, Sequence


SUITE_ID = "offeru-evolve-bench-v1"
REPORT_SCHEMA = "offeru-evolve-bench-report/1.0"
SUITE_VERSION = "1.0.0"
STATUS_VALUES = ("PASS", "FAIL", "BLOCKED", "NOT_RUN", "INVALID")
SPLIT_VALUES = ("dev", "feedback", "hidden", "regression")
AREA_VALUES = (
    "goal_execution",
    "career_truth",
    "email_events",
    "jd_capture",
    "smart_fill",
    "profile_longitudinal",
    "self_judging",
    "harness_generalization",
    "safety",
)
OVERALL_WEIGHTS = {
    "goal_execution": 20.0,
    "career_truth": 20.0,
    "profile_learning": 20.0,
    "browser_execution": 15.0,
    "harness_generalization": 15.0,
    "efficiency": 10.0,
}
CASE_ID_PATTERN = re.compile(r"^EVOLVE-[A-Z0-9]+(?:-[A-Z0-9]+)*-[0-9]{3}$")


def utc_now() -> str:
    return datetime.now(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def sha256_json(value: Any) -> str:
    return hashlib.sha256(canonical_json(value).encode("utf-8")).hexdigest()


@dataclass(frozen=True)
class BenchmarkCase:
    """Public task metadata.  Hidden cases must never be serialized here."""

    case_id: str
    area: str
    split: str
    title: str
    goal: str
    fixture_id: str
    input_mode: str = "vague"
    trials_required: int = 1
    grader_ids: tuple[str, ...] = ()
    safety_hard_gate: bool = True
    tags: tuple[str, ...] = ()
    public_prompt: str | None = None

    def __post_init__(self) -> None:
        errors: list[str] = []
        if not CASE_ID_PATTERN.fullmatch(self.case_id):
            errors.append(f"invalid case_id: {self.case_id!r}")
        if self.area not in AREA_VALUES:
            errors.append(f"invalid area: {self.area!r}")
        if self.split not in SPLIT_VALUES:
            errors.append(f"invalid split: {self.split!r}")
        if not self.title.strip() or not self.goal.strip():
            errors.append("title and goal are required")
        if self.trials_required not in (1, 3, 5):
            errors.append("trials_required must be 1, 3, or 5")
        if self.split == "hidden" and self.public_prompt:
            errors.append("hidden cases cannot expose public_prompt")
        if errors:
            raise ValueError("; ".join(errors))

    @classmethod
    def from_dict(cls, value: Mapping[str, Any]) -> "BenchmarkCase":
        return cls(
            case_id=str(value["case_id"]),
            area=str(value["area"]),
            split=str(value["split"]),
            title=str(value["title"]),
            goal=str(value["goal"]),
            fixture_id=str(value["fixture_id"]),
            input_mode=str(value.get("input_mode") or "vague"),
            trials_required=int(value.get("trials_required", 1)),
            grader_ids=tuple(str(item) for item in value.get("grader_ids", ())),
            safety_hard_gate=bool(value.get("safety_hard_gate", True)),
            tags=tuple(str(item) for item in value.get("tags", ())),
            public_prompt=(
                str(value["public_prompt"])
                if value.get("public_prompt") is not None
                else None
            ),
        )

    def to_public_dict(self) -> dict[str, Any]:
        result = {
            "case_id": self.case_id,
            "area": self.area,
            "split": self.split,
            "title": self.title,
            "goal": self.goal,
            "fixture_id": self.fixture_id,
            "input_mode": self.input_mode,
            "trials_required": self.trials_required,
            "grader_ids": list(self.grader_ids),
            "safety_hard_gate": self.safety_hard_gate,
            "tags": list(self.tags),
        }
        if self.public_prompt is not None:
            result["public_prompt"] = self.public_prompt
        return result


@dataclass(frozen=True)
class TrialResult:
    trial_id: str
    status: str
    duration_ms: int | None = None
    trajectory_evidence: tuple[str, ...] = ()
    outcome_evidence: tuple[str, ...] = ()
    failed_assertions: tuple[str, ...] = ()
    safety_violations: tuple[str, ...] = ()
    tool_calls: int | None = None
    llm_calls: int | None = None
    tokens: int | None = None
    manual_corrections: int | None = None

    def __post_init__(self) -> None:
        if self.status not in STATUS_VALUES:
            raise ValueError(f"invalid trial status: {self.status!r}")
        if self.duration_ms is not None and self.duration_ms < 0:
            raise ValueError("duration_ms must be non-negative")

    def to_dict(self) -> dict[str, Any]:
        return {
            "trial_id": self.trial_id,
            "status": self.status,
            "duration_ms": self.duration_ms,
            "trajectory_evidence": list(self.trajectory_evidence),
            "outcome_evidence": list(self.outcome_evidence),
            "failed_assertions": list(self.failed_assertions),
            "safety_violations": list(self.safety_violations),
            "tool_calls": self.tool_calls,
            "llm_calls": self.llm_calls,
            "tokens": self.tokens,
            "manual_corrections": self.manual_corrections,
        }


@dataclass(frozen=True)
class CaseResult:
    case: BenchmarkCase
    trials: tuple[TrialResult, ...] = ()
    status: str = "NOT_RUN"

    def __post_init__(self) -> None:
        if self.status not in STATUS_VALUES:
            raise ValueError(f"invalid case status: {self.status!r}")
        if len(self.trials) > self.case.trials_required:
            raise ValueError("trial count exceeds case requirement")

    def to_dict(self) -> dict[str, Any]:
        return {
            "case_id": self.case.case_id,
            "area": self.case.area,
            "split": self.case.split,
            "status": self.status,
            "trials_required": self.case.trials_required,
            "trials_passed": sum(item.status == "PASS" for item in self.trials),
            "trials": [item.to_dict() for item in self.trials],
        }


@dataclass(frozen=True)
class DatasetManifest:
    """Counts and hashes are public; hidden prompts and gold labels are not."""

    split: str
    dataset_hash: str
    case_count: int
    gold_access: str
    source: str
    planned_counts: Mapping[str, int] = field(default_factory=dict)

    def __post_init__(self) -> None:
        if self.split not in SPLIT_VALUES:
            raise ValueError(f"invalid dataset split: {self.split!r}")
        if self.gold_access not in ("public", "runner_only"):
            raise ValueError("gold_access must be public or runner_only")
        if self.case_count < 0:
            raise ValueError("case_count must be non-negative")

    def to_dict(self) -> dict[str, Any]:
        return {
            "split": self.split,
            "dataset_hash": self.dataset_hash,
            "case_count": self.case_count,
            "gold_access": self.gold_access,
            "source": self.source,
            "planned_counts": dict(self.planned_counts),
        }


def load_cases(path: str | os.PathLike[str], *, expected_split: str | None = None) -> list[BenchmarkCase]:
    """Load public JSONL case metadata and reject duplicate or mixed splits."""

    cases: list[BenchmarkCase] = []
    seen: set[str] = set()
    file_path = Path(path)
    with file_path.open("r", encoding="utf-8") as handle:
        for line_number, raw_line in enumerate(handle, start=1):
            line = raw_line.strip()
            if not line or line.startswith("#"):
                continue
            try:
                value = json.loads(line)
                case = BenchmarkCase.from_dict(value)
            except (KeyError, TypeError, ValueError, json.JSONDecodeError) as exc:
                raise ValueError(f"{file_path}:{line_number}: invalid case: {exc}") from exc
            if case.case_id in seen:
                raise ValueError(f"{file_path}:{line_number}: duplicate case_id {case.case_id}")
            if expected_split is not None and case.split != expected_split:
                raise ValueError(
                    f"{file_path}:{line_number}: expected split {expected_split!r}, got {case.split!r}"
                )
            seen.add(case.case_id)
            cases.append(case)
    return cases


def validate_public_cases(cases: Iterable[BenchmarkCase]) -> list[str]:
    """Return contract violations instead of silently accepting bad fixtures."""

    errors: list[str] = []
    seen: set[str] = set()
    for case in cases:
        if case.case_id in seen:
            errors.append(f"duplicate case_id: {case.case_id}")
        seen.add(case.case_id)
        if case.split == "hidden" and case.public_prompt:
            errors.append(f"hidden case exposes prompt: {case.case_id}")
        if case.split == "feedback" and case.public_prompt:
            errors.append(f"feedback case exposes prompt: {case.case_id}")
        if not case.grader_ids:
            errors.append(f"case has no deterministic grader: {case.case_id}")
        if case.safety_hard_gate is not True:
            errors.append(f"case disabled safety hard gate: {case.case_id}")
    return errors


def status_totals(results: Iterable[CaseResult]) -> dict[str, int]:
    totals = {status.lower(): 0 for status in STATUS_VALUES}
    for result in results:
        totals[result.status.lower()] += 1
    return totals


def pass_at_1(trials_by_case: Mapping[str, Sequence[str]]) -> float | None:
    """Fraction of cases whose first independent trial passed."""

    eligible = [values for values in trials_by_case.values() if values]
    if not eligible:
        return None
    return mean(values[0] == "PASS" for values in eligible)


def pass_power_k(trials_by_case: Mapping[str, Sequence[str]], k: int) -> float | None:
    """Fraction of cases with at least *k* trials where all first *k* pass."""

    if k <= 0:
        raise ValueError("k must be positive")
    eligible = [values for values in trials_by_case.values() if len(values) >= k]
    if not eligible:
        return None
    return mean(all(value == "PASS" for value in values[:k]) for values in eligible)


def profile_auc_plus(scores: Sequence[float]) -> float | None:
    """Discrete positive gain above T0, preserving the S³Gym-style baseline."""

    if len(scores) < 2:
        return None
    baseline = scores[0]
    return float(sum(max(0.0, score - baseline) for score in scores[1:]))


def profile_auc_minus(scores: Sequence[float]) -> float | None:
    if len(scores) < 2:
        return None
    baseline = scores[0]
    return float(sum(max(0.0, baseline - score) for score in scores[1:]))


def retention_rate(baseline: Sequence[bool], final: Sequence[bool]) -> float | None:
    eligible = [after for before, after in zip(baseline, final) if before]
    if not eligible:
        return None
    return mean(eligible)


def negative_transfer_rate(baseline: Sequence[bool], final: Sequence[bool]) -> float | None:
    eligible = [after for before, after in zip(baseline, final) if before]
    if not eligible:
        return None
    return mean(not after for after in eligible)


def gain_transfer_ratio(dev_gain: float, hidden_gain: float) -> float | None:
    if dev_gain <= 0:
        return None
    return hidden_gain / dev_gain


def vague_goal_gap(explicit_score: float, vague_score: float) -> float:
    return explicit_score - vague_score


def weighted_overall_score(scores: Mapping[str, float]) -> float | None:
    """Return the six-part score only when every weighted suite is present."""

    if any(key not in scores for key in OVERALL_WEIGHTS):
        return None
    if any(value < 0 or value > 100 for value in scores.values()):
        raise ValueError("suite scores must be between 0 and 100")
    return sum(scores[key] * weight for key, weight in OVERALL_WEIGHTS.items()) / 100.0


def brier_score(confidences: Sequence[float], truths: Sequence[bool]) -> float | None:
    if not confidences or len(confidences) != len(truths):
        return None
    if any(value < 0 or value > 1 for value in confidences):
        raise ValueError("confidence values must be between 0 and 1")
    return mean((confidence - float(truth)) ** 2 for confidence, truth in zip(confidences, truths))


def _rankdata(values: Sequence[float]) -> list[float]:
    indexed = sorted(enumerate(values), key=lambda item: item[1])
    ranks = [0.0] * len(values)
    index = 0
    while index < len(indexed):
        end = index + 1
        while end < len(indexed) and indexed[end][1] == indexed[index][1]:
            end += 1
        rank = (index + end - 1) / 2 + 1
        for offset in range(index, end):
            ranks[indexed[offset][0]] = rank
        index = end
    return ranks


def spearman_correlation(predicted: Sequence[float], actual: Sequence[float]) -> float | None:
    if len(predicted) != len(actual) or len(predicted) < 2:
        return None
    predicted_ranks = _rankdata(predicted)
    actual_ranks = _rankdata(actual)
    mean_predicted = mean(predicted_ranks)
    mean_actual = mean(actual_ranks)
    numerator = sum(
        (left - mean_predicted) * (right - mean_actual)
        for left, right in zip(predicted_ranks, actual_ranks)
    )
    left_sum = sum((value - mean_predicted) ** 2 for value in predicted_ranks)
    right_sum = sum((value - mean_actual) ** 2 for value in actual_ranks)
    denominator = math.sqrt(left_sum * right_sum)
    return None if denominator == 0 else numerator / denominator


def cross_provider_robustness(scores: Mapping[str, float]) -> float | None:
    values = [value for value in scores.values() if math.isfinite(value)]
    if not values or max(values) <= 0:
        return None
    return min(values) / max(values)


def safety_gate(violations: Iterable[str]) -> str:
    return "FAIL" if any(str(item).strip() for item in violations) else "PASS"


def validate_report(report: Mapping[str, Any]) -> list[str]:
    """Validate the invariants that make a benchmark report trustworthy."""

    errors: list[str] = []
    if report.get("report_schema") != REPORT_SCHEMA:
        errors.append("report_schema does not identify OfferU-EvolveBench")
    if report.get("suite_id") != SUITE_ID:
        errors.append("suite_id does not identify OfferU-EvolveBench")
    dataset = report.get("dataset")
    if not isinstance(dataset, Mapping) or dataset.get("split") not in SPLIT_VALUES:
        errors.append("dataset split is missing or invalid")

    cases = report.get("cases")
    if not isinstance(cases, Sequence) or isinstance(cases, (str, bytes)):
        errors.append("cases must be an array")
        cases = []
    seen: set[str] = set()
    computed = {status.lower(): 0 for status in STATUS_VALUES}
    for index, case in enumerate(cases):
        if not isinstance(case, Mapping):
            errors.append(f"cases[{index}] must be an object")
            continue
        case_id = str(case.get("case_id") or "")
        if not CASE_ID_PATTERN.fullmatch(case_id):
            errors.append(f"cases[{index}] has invalid case_id")
        if case_id in seen:
            errors.append(f"duplicate case_id in report: {case_id}")
        seen.add(case_id)
        status = case.get("status")
        if status not in STATUS_VALUES:
            errors.append(f"cases[{index}] has invalid status")
            continue
        computed[str(status).lower()] += 1
        trials = case.get("trials")
        if not isinstance(trials, Sequence) or isinstance(trials, (str, bytes)):
            errors.append(f"cases[{index}].trials must be an array")
            trials = []
        if status == "PASS":
            if not trials or any(
                not isinstance(trial, Mapping) or trial.get("status") != "PASS"
                for trial in trials
            ):
                errors.append(f"PASS case {case_id} lacks all-PASS trial evidence")
            if not any(
                isinstance(trial, Mapping) and trial.get("outcome_evidence")
                for trial in trials
            ):
                errors.append(f"PASS case {case_id} lacks outcome evidence")

    totals = report.get("totals")
    if isinstance(totals, Mapping):
        for key, value in computed.items():
            if totals.get(key) != value:
                errors.append(f"totals.{key} does not match case statuses")
    else:
        errors.append("totals must be an object")

    safety = report.get("safety")
    if not isinstance(safety, Mapping):
        errors.append("safety must be an object")
    else:
        violations = safety.get("violations")
        if not isinstance(violations, Sequence) or isinstance(violations, (str, bytes)):
            errors.append("safety.violations must be an array")
        elif any(str(item).strip() for item in violations) and safety.get("status") != "FAIL":
            errors.append("safety violations require a FAIL hard-gate status")
        if safety.get("hard_gate") is not True:
            errors.append("safety hard_gate must remain true")
    return errors


_SECRET_PATTERNS = (
    (re.compile(r"(?i)(bearer\s+)[A-Za-z0-9._~+/=-]+"), r"\1[REDACTED_TOKEN]"),
    (re.compile(r"(?i)((?:api[_ -]?key|token|password|cookie|secret)\s*[:=]\s*)[^\s,;]+"), r"\1[REDACTED]"),
    (re.compile(r"\bsk-[A-Za-z0-9_-]{16,}\b"), "[REDACTED_KEY]"),
    (re.compile(r"\b(?:ghp|github_pat)_[A-Za-z0-9_]{20,}\b"), "[REDACTED_KEY]"),
    (re.compile(r"\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b"), "[REDACTED_EMAIL]"),
    (re.compile(r"(?<!\d)(?:\+?86[- ]?)?1[3-9]\d{9}(?!\d)"), "[REDACTED_PHONE]"),
)


def redact_text(value: str, *, max_length: int = 2000) -> str:
    result = str(value)
    for pattern, replacement in _SECRET_PATTERNS:
        result = pattern.sub(replacement, result)
    if len(result) > max_length:
        result = result[:max_length].rstrip() + "…"
    return result


def resolve_artifact_root(root: str | os.PathLike[str] | None = None) -> Path:
    """Resolve benchmark artifacts without silently falling back to C:."""

    configured = str(root or os.environ.get("OFFERU_EVOLVEBENCH_ROOT") or "").strip()
    if configured:
        candidate = Path(configured).expanduser()
    elif os.name == "nt" and Path(r"H:\tmp").exists():
        candidate = Path(r"H:\tmp") / "offeru" / "evolve-bench"
    else:
        runner_root = str(os.environ.get("RUNNER_TEMP") or "").strip()
        candidate = Path(runner_root) if runner_root else Path(tempfile.gettempdir())
        candidate = candidate / "offeru" / "evolve-bench"
    candidate = candidate.resolve()
    if (
        os.name == "nt"
        and candidate.drive.upper() == "C:"
        and os.environ.get("OFFERU_ALLOW_C_TEST_TEMP") != "1"
    ):
        raise RuntimeError(
            "OfferU-EvolveBench refuses C: artifacts; set OFFERU_EVOLVEBENCH_ROOT "
            "to a non-system drive such as H:\\tmp\\offeru\\evolve-bench"
        )
    candidate.mkdir(parents=True, exist_ok=True)
    return candidate


def build_not_run_report(
    *,
    dataset: DatasetManifest,
    executor: Mapping[str, str],
    environment: Mapping[str, Any],
    limitations: Sequence[str],
    case_ids: Sequence[str] = (),
    run_id: str | None = None,
) -> dict[str, Any]:
    """Create an honest report scaffold; it never claims an unexecuted pass."""

    now = utc_now()
    cases = [
        {
            "case_id": case_id,
            "status": "NOT_RUN",
            "trials_required": None,
            "trials_passed": 0,
            "trials": [],
        }
        for case_id in case_ids
    ]
    return {
        "report_schema": REPORT_SCHEMA,
        "suite_id": SUITE_ID,
        "suite_version": SUITE_VERSION,
        "run_id": run_id or f"evolve-{uuid.uuid4().hex[:16]}",
        "run_kind": dataset.split,
        "started_at": now,
        "finished_at": now,
        "executor": dict(executor),
        "environment": dict(environment),
        "dataset": dataset.to_dict(),
        "totals": {"pass": 0, "fail": 0, "blocked": 0, "not_run": len(cases), "invalid": 0},
        "metrics": {
            "overall_score": None,
            "pass_at_1": None,
            "pass_power_3": None,
            "pass_power_5": None,
            "profile_auc_plus": None,
            "profile_auc_minus": None,
            "retention_rate": None,
            "negative_transfer_rate": None,
            "gain_transfer_ratio": None,
            "brier_score": None,
            "judge_improvement_spearman": None,
            "cross_provider_robustness": None,
            "tokens": None,
            "tool_calls": None,
            "latency_p50_ms": None,
            "latency_p95_ms": None,
            "manual_corrections": None,
        },
        "safety": {"status": "NOT_RUN", "violations": [], "hard_gate": True},
        "cases": cases,
        "limitations": [redact_text(item) for item in limitations],
        "recommended_decision": "run-more-evals",
    }


__all__ = [
    "AREA_VALUES",
    "BenchmarkCase",
    "CaseResult",
    "DatasetManifest",
    "REPORT_SCHEMA",
    "STATUS_VALUES",
    "SUITE_ID",
    "SUITE_VERSION",
    "TrialResult",
    "brier_score",
    "build_not_run_report",
    "canonical_json",
    "cross_provider_robustness",
    "gain_transfer_ratio",
    "load_cases",
    "negative_transfer_rate",
    "pass_at_1",
    "pass_power_k",
    "profile_auc_minus",
    "profile_auc_plus",
    "redact_text",
    "resolve_artifact_root",
    "retention_rate",
    "safety_gate",
    "sha256_json",
    "spearman_correlation",
    "status_totals",
    "utc_now",
    "validate_report",
    "validate_public_cases",
    "vague_goal_gap",
    "weighted_overall_score",
]
