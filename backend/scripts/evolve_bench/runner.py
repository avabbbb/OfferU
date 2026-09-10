"""Offline OfferU-EvolveBench catalog and report scaffold runner.

The runner intentionally does not start a model, browser, backend, or mail
provider.  It validates the public task catalog and creates a NOT_RUN report
under the configured non-system-drive artifact root.  A future live runner
must add real trajectory and outcome evidence before changing a case status.
"""

from __future__ import annotations

import argparse
import json
import platform
import subprocess
import sys
from pathlib import Path
from typing import Any

from .contract import (
    SUITE_ID,
    SUITE_VERSION,
    DatasetManifest,
    build_not_run_report,
    canonical_json,
    load_cases,
    resolve_artifact_root,
    sha256_json,
    validate_report,
    validate_public_cases,
)


ROOT = Path(__file__).resolve().parents[3]
CASE_ROOT = Path(__file__).resolve().parent / "cases"
DEV_CASES = CASE_ROOT / "dev.jsonl"
FEEDBACK_MANIFEST = CASE_ROOT / "feedback.manifest.json"
HIDDEN_MANIFEST = CASE_ROOT / "hidden.manifest.json"


def _git(*args: str) -> str:
    try:
        result = subprocess.run(
            ["git", *args],
            cwd=ROOT,
            check=False,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
        )
    except OSError:
        return "unavailable"
    return result.stdout.strip() if result.returncode == 0 else "unavailable"


def _dev_manifest() -> DatasetManifest:
    cases = load_cases(DEV_CASES, expected_split="dev")
    errors = validate_public_cases(cases)
    if errors:
        raise ValueError("; ".join(errors))
    return DatasetManifest(
        split="dev",
        dataset_hash=sha256_json([case.to_public_dict() for case in cases]),
        case_count=len(cases),
        gold_access="public",
        source=str(DEV_CASES.relative_to(ROOT)),
        planned_counts={"agent_tasks": len(cases)},
    )


def _private_manifest(path: Path, split: str) -> DatasetManifest:
    value = json.loads(path.read_text(encoding="utf-8"))
    if value.get("split") != split:
        raise ValueError(f"{path}: split must be {split!r}")
    return DatasetManifest(
        split=split,
        dataset_hash=str(value["dataset_hash"]),
        case_count=int(value["case_count"]),
        gold_access="runner_only",
        source=str(path.relative_to(ROOT)),
        planned_counts={str(key): int(item) for key, item in value.get("planned_counts", {}).items()},
    )


def dataset_manifest(split: str) -> DatasetManifest:
    if split == "dev":
        return _dev_manifest()
    if split == "feedback":
        return _private_manifest(FEEDBACK_MANIFEST, split)
    if split == "hidden":
        return _private_manifest(HIDDEN_MANIFEST, split)
    return DatasetManifest(
        split="regression",
        dataset_hash="not-created",
        case_count=0,
        gold_access="runner_only",
        source="external regression registry",
    )


def public_manifest() -> dict[str, Any]:
    dev = _dev_manifest()
    feedback = _private_manifest(FEEDBACK_MANIFEST, "feedback")
    hidden = _private_manifest(HIDDEN_MANIFEST, "hidden")
    return {
        "suite_id": SUITE_ID,
        "suite_version": SUITE_VERSION,
        "report_schema": "offeru-evolve-bench-report/1.0",
        "allocation": {"dev": 0.30, "feedback": 0.20, "hidden": 0.50},
        "public_catalog": {"dev": dev.to_dict()},
        "runner_only_catalog": {
            "feedback": feedback.to_dict(),
            "hidden": hidden.to_dict(),
        },
        "planned_assets": {
            "agent_tasks": 30,
            "resume_gold": 1,
            "email_gold_messages": 100,
            "jd_snapshots": 20,
            "application_forms": 18,
            "profile_checkpoints": 4,
            "safety_cases": 20,
        },
        "areas": [
            "goal_execution",
            "career_truth",
            "email_events",
            "jd_capture",
            "smart_fill",
            "profile_longitudinal",
            "self_judging",
            "harness_generalization",
            "safety",
        ],
    }


def _environment(args: argparse.Namespace) -> dict[str, Any]:
    dirty = _git("status", "--porcelain=v1", "--untracked-files=all")
    return {
        "commit": _git("rev-parse", "HEAD"),
        "dirty_files": [line[3:] for line in dirty.splitlines() if len(line) >= 4],
        "os": platform.platform(),
        "python": sys.version.split()[0],
        "node": "not-probed",
        "offeru_cli": "not-probed",
        "harness": args.harness,
        "provider": args.provider,
        "provider_model": args.provider_model,
        "data_isolation": args.data_isolation,
    }


def command_manifest(_: argparse.Namespace) -> int:
    print(json.dumps(public_manifest(), ensure_ascii=False, indent=2))
    return 0


def command_validate(_: argparse.Namespace) -> int:
    errors: list[str] = []
    try:
        manifest = public_manifest()
        if manifest["public_catalog"]["dev"]["case_count"] != 30:
            errors.append("dev catalog must contain exactly 30 public Agent tasks")
        if manifest["runner_only_catalog"]["hidden"]["gold_access"] != "runner_only":
            errors.append("hidden catalog must remain runner_only")
    except (OSError, KeyError, TypeError, ValueError, json.JSONDecodeError) as exc:
        errors.append(str(exc))
    if errors:
        for error in errors:
            print(f"INVALID: {error}", file=sys.stderr)
        return 1
    print("OfferU-EvolveBench catalog valid")
    return 0


def command_validate_report(args: argparse.Namespace) -> int:
    report_path = Path(args.report).expanduser().resolve()
    try:
        report = json.loads(report_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        print(f"INVALID: cannot read report: {exc}", file=sys.stderr)
        return 1
    errors = validate_report(report)
    if errors:
        for error in errors:
            print(f"INVALID: {error}", file=sys.stderr)
        return 1
    print(f"OfferU-EvolveBench report valid: {report_path}")
    return 0


def command_scaffold(args: argparse.Namespace) -> int:
    dataset = dataset_manifest(args.split)
    case_ids: list[str] = []
    if args.split == "dev":
        case_ids = [case.case_id for case in load_cases(DEV_CASES, expected_split="dev")]
    report = build_not_run_report(
        dataset=dataset,
        executor={"agent": args.agent, "model": args.model},
        environment=_environment(args),
        limitations=[
            "This command validates the catalog only; no model, browser, backend, or mail provider was run.",
            "A NOT_RUN case cannot be counted as PASS and must be replaced by real trajectory and outcome evidence.",
            "Hidden prompts and gold labels stay outside the public repository and are referenced by dataset hash only.",
        ],
        case_ids=case_ids,
    )
    root = resolve_artifact_root(args.output_root)
    output = root / f"{report['run_id']}.json"
    output.write_text(canonical_json(report) + "\n", encoding="utf-8")
    print(output)
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="python -m backend.scripts.evolve_bench.runner")
    subparsers = parser.add_subparsers(dest="command", required=True)

    subparsers.add_parser("manifest", help="print public and runner-only catalog metadata")
    subparsers.add_parser("validate", help="validate public catalog and split boundaries")
    report = subparsers.add_parser("validate-report", help="validate a generated report's evidence invariants")
    report.add_argument("report", help="path to a JSON report")

    scaffold = subparsers.add_parser("scaffold", help="write an honest NOT_RUN report outside the repo")
    scaffold.add_argument("--split", choices=("dev", "feedback", "hidden", "regression"), default="dev")
    scaffold.add_argument("--output-root", help="artifact root; defaults to H:\\tmp\\offeru\\evolve-bench")
    scaffold.add_argument("--agent", default="not-run")
    scaffold.add_argument("--model", default="not-run")
    scaffold.add_argument("--harness", default="not-run")
    scaffold.add_argument("--provider", default="not-run")
    scaffold.add_argument("--provider-model", default="not-run")
    scaffold.add_argument("--data-isolation", choices=("proven", "not_proven"), default="not_proven")
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    if args.command == "manifest":
        return command_manifest(args)
    if args.command == "validate":
        return command_validate(args)
    if args.command == "validate-report":
        return command_validate_report(args)
    if args.command == "scaffold":
        return command_scaffold(args)
    parser.error("unknown command")
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
