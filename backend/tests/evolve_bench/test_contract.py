from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO_ROOT))

from backend.scripts.evolve_bench.contract import (
    BenchmarkCase,
    DatasetManifest,
    TrialResult,
    brier_score,
    build_not_run_report,
    cross_provider_robustness,
    gain_transfer_ratio,
    load_cases,
    negative_transfer_rate,
    pass_at_1,
    pass_power_k,
    profile_auc_minus,
    profile_auc_plus,
    redact_text,
    retention_rate,
    safety_gate,
    spearman_correlation,
    validate_report,
    validate_public_cases,
    vague_goal_gap,
    weighted_overall_score,
)


CASE_FILE = Path(__file__).resolve().parents[2] / "scripts" / "evolve_bench" / "cases" / "dev.jsonl"


def test_public_dev_catalog_has_thirty_cases_and_deterministic_graders() -> None:
    cases = load_cases(CASE_FILE, expected_split="dev")

    assert len(cases) == 30
    assert not validate_public_cases(cases)
    assert len({case.case_id for case in cases}) == 30


def test_hidden_case_cannot_expose_prompt() -> None:
    with pytest.raises(ValueError, match="hidden cases cannot expose public_prompt"):
        BenchmarkCase(
            case_id="EVOLVE-GOAL-999",
            area="goal_execution",
            split="hidden",
            title="hidden",
            goal="hidden goal",
            fixture_id="hidden",
            grader_ids=("independent.grader",),
            public_prompt="secret prompt",
        )


def test_status_and_stability_metrics_are_independent_of_total_score() -> None:
    trials = {"a": ["PASS", "PASS", "PASS"], "b": ["PASS", "FAIL", "PASS"], "c": ["FAIL", "PASS", "PASS"]}

    assert pass_at_1(trials) == pytest.approx(2 / 3)
    assert pass_power_k(trials, 3) == pytest.approx(1 / 3)
    assert profile_auc_plus([70, 80, 65, 90]) == pytest.approx(30)
    assert profile_auc_minus([70, 80, 65, 90]) == pytest.approx(5)
    assert retention_rate([True, True, False], [True, False, True]) == pytest.approx(0.5)
    assert negative_transfer_rate([True, True, False], [True, False, True]) == pytest.approx(0.5)
    assert gain_transfer_ratio(10, 4) == pytest.approx(0.4)
    assert vague_goal_gap(95, 80) == pytest.approx(15)
    assert weighted_overall_score(
        {
            "goal_execution": 90,
            "career_truth": 95,
            "profile_learning": 80,
            "browser_execution": 85,
            "harness_generalization": 75,
            "efficiency": 70,
        }
    ) == pytest.approx(84.0)


def test_quality_metrics_and_safety_gate_are_deterministic() -> None:
    assert brier_score([0.9, 0.2, 0.6], [True, False, True]) == pytest.approx((0.1**2 + 0.2**2 + 0.4**2) / 3)
    assert spearman_correlation([1, 2, 3], [10, 20, 30]) == pytest.approx(1.0)
    assert cross_provider_robustness({"codex": 92, "claude": 88, "pi": 79}) == pytest.approx(79 / 92)
    assert safety_gate([]) == "PASS"
    assert safety_gate(["unauthorized mutation"]) == "FAIL"


def test_report_scaffold_is_explicitly_not_run_and_serializable() -> None:
    dataset = DatasetManifest(
        split="dev",
        dataset_hash="abc123",
        case_count=1,
        gold_access="public",
        source="fixture",
    )
    report = build_not_run_report(
        dataset=dataset,
        executor={"agent": "test", "model": "test"},
        environment={
            "commit": "abc",
            "dirty_files": [],
            "os": "test",
            "python": "3.12",
            "node": "not-probed",
            "offeru_cli": "not-probed",
            "harness": "test",
            "provider": "test",
            "provider_model": "test",
            "data_isolation": "not_proven",
        },
        limitations=["token=secret@example.com 13800138000"],
        case_ids=["EVOLVE-GOAL-001"],
    )

    assert report["safety"] == {"status": "NOT_RUN", "violations": [], "hard_gate": True}
    assert report["totals"]["not_run"] == 1
    assert report["cases"][0]["status"] == "NOT_RUN"
    assert "secret@example.com" not in json.dumps(report, ensure_ascii=False)
    assert "13800138000" not in json.dumps(report, ensure_ascii=False)

    assert not validate_report(report)


def test_report_validator_rejects_pass_without_evidence_or_safe_gate() -> None:
    report = {
        "report_schema": "offeru-evolve-bench-report/1.0",
        "suite_id": "offeru-evolve-bench-v1",
        "dataset": {"split": "dev"},
        "totals": {"pass": 1, "fail": 0, "blocked": 0, "not_run": 0, "invalid": 0},
        "cases": [
            {
                "case_id": "EVOLVE-SAFE-030",
                "status": "PASS",
                "trials": [],
            }
        ],
        "safety": {"status": "PASS", "violations": ["automatic submit"], "hard_gate": True},
    }

    errors = validate_report(report)
    assert any("lacks all-PASS trial evidence" in error for error in errors)
    assert any("lacks outcome evidence" in error for error in errors)
    assert any("safety violations require" in error for error in errors)


def test_redaction_covers_common_secrets_and_pii() -> None:
    redacted = redact_text(
        "Authorization: Bearer abc.def; api_key=sk-test_1234567890123456; "
        "owner=test@example.com phone=13800138000"
    )

    assert "abc.def" not in redacted
    assert "sk-test_1234567890123456" not in redacted
    assert "test@example.com" not in redacted
    assert "13800138000" not in redacted


def test_trial_result_rejects_unknown_status() -> None:
    with pytest.raises(ValueError, match="invalid trial status"):
        TrialResult(trial_id="t1", status="SUCCESS")
