"""Conformance runner: run protocol scenarios against the fake adapter.

Slice 0 scope: malformed input, unknown version, unknown message, and the
non-public `run.create` type must each produce a deterministic, fail-closed
protocol error. stdout carries exactly one JSON summary line; failure detail
goes to stderr.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

CONFORMANCE_DIR = Path(__file__).resolve().parent
REPO_ROOT = CONFORMANCE_DIR.parents[1]
BACKEND_DIR = REPO_ROOT / "backend"
for _path in (str(REPO_ROOT), str(BACKEND_DIR)):
    if _path not in sys.path:
        sys.path.insert(0, _path)

from integrations.conformance.adapters.fake_harness import FakeHarnessAdapter  # noqa: E402


def _load_scenarios() -> list[dict]:
    return json.loads((CONFORMANCE_DIR / "scenarios.json").read_text(encoding="utf-8"))["scenarios"]


def run_scenario(scenario: dict, adapter: FakeHarnessAdapter) -> list[str]:
    failures: list[str] = []
    fixture = CONFORMANCE_DIR / "fixtures" / scenario["fixture"]
    responses = adapter.run_transcript(fixture)
    for expectation in scenario["expect"]:
        index = expectation["line"]
        if index >= len(responses):
            failures.append(f"{scenario['id']}: no response for line {index}")
            continue
        response = responses[index]
        if response.get("ok") is not expectation["ok"]:
            failures.append(
                f"{scenario['id']}: line {index} ok={response.get('ok')} expected {expectation['ok']}"
            )
            continue
        if not expectation["ok"]:
            code = (response.get("error") or {}).get("code")
            if code != expectation.get("errorCode"):
                failures.append(
                    f"{scenario['id']}: line {index} error.code={code} expected {expectation.get('errorCode')}"
                )
        else:
            echoed = (response.get("result") or {}).get("echoedType")
            wanted = expectation.get("resultEchoedType")
            if wanted is not None and echoed != wanted:
                failures.append(
                    f"{scenario['id']}: line {index} result.echoedType={echoed} expected {wanted}"
                )
    return failures


def main() -> int:
    scenarios = _load_scenarios()
    all_failures: list[str] = []
    for scenario in scenarios:
        adapter = FakeHarnessAdapter()
        all_failures.extend(run_scenario(scenario, adapter))
    summary = {
        "ok": not all_failures,
        "scenarios": len(scenarios),
        "failures": len(all_failures),
    }
    for failure in all_failures:
        print(failure, file=sys.stderr)
    json.dump(summary, sys.stdout, ensure_ascii=False)
    sys.stdout.write("\n")
    return 0 if not all_failures else 1


if __name__ == "__main__":
    raise SystemExit(main())
