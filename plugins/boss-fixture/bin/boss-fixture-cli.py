from __future__ import annotations

import json
import sys
from pathlib import Path


def _corpus() -> dict:
    root = Path(__file__).resolve().parents[3]
    path = root / "backend" / "tests" / "fixtures" / "role_intelligence_v0" / "corpus.json"
    return json.loads(path.read_text(encoding="utf-8"))


def _fail(message: str) -> int:
    print(message, file=sys.stderr)
    return 1


def main(argv: list[str]) -> int:
    if "--json" not in argv:
        return _fail("boss-fixture-cli requires --json")
    command = next((item for item in argv if item in {"search", "get", "jobs.search", "job.get"}), "")
    if command not in {"search", "get", "jobs.search", "job.get"}:
        return _fail("supported commands: jobs.search, job.get")
    try:
        payload = json.load(sys.stdin)
        if not isinstance(payload, dict):
            return _fail("stdin must be a JSON object")
        corpus = _corpus()
    except (OSError, json.JSONDecodeError) as exc:
        return _fail(f"fixture unavailable: {exc}")

    if command in {"search", "jobs.search"}:
        result = {
            "schema": "offeru.role_benchmark_candidate.v1",
            "target": corpus.get("target") or {},
            "comparators": corpus.get("comparators") or [],
            "gaps": corpus.get("gaps") or [],
        }
    else:
        requested = str(payload.get("source_ref") or payload.get("job_id") or "").strip()
        documents = [corpus.get("target") or {}, *(corpus.get("comparators") or [])]
        job = next(
            (
                item
                for item in documents
                if requested in {str(item.get("source_ref") or ""), str(item.get("job_id") or "")}
            ),
            None,
        )
        if job is None:
            return _fail("fixture job not found")
        result = {"schema": "offeru.job.v1", "job": job}
    print(json.dumps(result, ensure_ascii=False, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
