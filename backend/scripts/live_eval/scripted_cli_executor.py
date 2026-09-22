"""Scripted CLI executor for deterministic eval — NOT an Agent.

This module reads eval case prompts and executes a fixed sequence of CLI
operations. It does NOT launch OMP/SWE-2, does NOT do LLM reasoning, and
does NOT let the model choose which operations to call.

Name history: this was originally called `omp_executor.py` which was
misleading — it suggested this was an OMP/SWE-2 Agent executor. It is not.
It is a deterministic script that calls `python -m app.cli` in a fixed order.

For real Agent E2E testing, use `agent_executor.py` (to be created) which
launches a real OMP session and lets the model decide which tools to call.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

BACKEND_DIR = Path(__file__).resolve().parents[2]


def _child_env(database_url: str) -> dict[str, str]:
    """Minimal env for child CLI processes (same whitelist as runner)."""
    keep = {
        "PATH", "SYSTEMROOT", "SYSTEMDRIVE", "WINDIR", "TEMP", "TMP",
        "USERPROFILE", "USERNAME", "HOMEDRIVE", "HOMEPATH",
        "PYTHONPATH", "PYTHONIOENCODING", "PYTHONUNBUFFERED",
        "OFFERU_DATA_DIR", "DATABASE_URL",
        "CODEBUDDY_CONFIG_DIR",
    }
    env = {k: v for k, v in os.environ.items() if k in keep}
    env["DATABASE_URL"] = database_url
    env["PYTHONIOENCODING"] = "utf-8"
    env["PYTHONUNBUFFERED"] = "1"
    return env


def _run_cli(db_url: str, args: list[str], timeout: int = 120) -> dict[str, Any]:
    """Run app.cli command and return parsed JSON result."""
    cmd = [sys.executable, "-m", "app.cli"] + args
    env = _child_env(db_url)
    try:
        proc = subprocess.run(
            cmd, capture_output=True, text=True, timeout=timeout,
            env=env, cwd=str(BACKEND_DIR),
        )
        stdout = proc.stdout or ""
        try:
            return json.loads(stdout)
        except json.JSONDecodeError:
            return {"ok": False, "raw": stdout[:500], "stderr": (proc.stderr or "")[:500]}
    except subprocess.TimeoutExpired:
        return {"ok": False, "error": f"timeout after {timeout}s"}
    except Exception as exc:
        return {"ok": False, "error": f"{type(exc).__name__}: {exc}"}


def _extract_operations(prompt: str) -> list[str]:
    """Parse the eval prompt to figure out which CLI operations to call."""
    ops = []
    if "get_current_view" in prompt or "\u5f53\u524d" in prompt:
        ops.append("get_current_view")
    if "get_profile" in prompt or "\u6863\u6848" in prompt:
        ops.append("get_profile")
    if "get_job" in prompt or "\u5c97\u4f4d" in prompt or "\u5de5\u4f5c" in prompt:
        ops.append("get_job")
    return ops


def _execute_eval_turn(prompt: str, eval_db: str, timeout: int) -> dict[str, Any]:
    """Execute one eval turn: run CLI operations and return result."""
    db_url = f"sqlite+aiosqlite:///{Path(eval_db).as_posix()}"
    tool_calls = []
    final_parts = []

    # Always start with get_current_view to establish context
    cv = _run_cli(db_url, ["run", "get_current_view", "--args", "{}"], timeout=30)
    tool_calls.append({"tool": "Bash", "input": "app.cli run get_current_view --args {}"})
    if cv.get("ok"):
        cv_out = cv.get("outputs", {})
        entity_id = cv_out.get("entity_id", "")
        entity_type = cv_out.get("entity_type", "")
        final_parts.append(f"Current view: {entity_type}={entity_id}")
    else:
        final_parts.append(f"get_current_view failed: {cv.get('error', 'unknown')}")

    # Get profile
    prof = _run_cli(db_url, ["run", "get_profile", "--args", "{}"], timeout=30)
    tool_calls.append({"tool": "Bash", "input": "app.cli run get_profile --args {}"})
    if prof.get("ok"):
        prof_out = prof.get("outputs", {})
        final_parts.append(f"Profile: {prof_out.get('name', 'unknown')} ({prof_out.get('headline', '')})")

    # Get job details if we have a job_id in current view
    if cv.get("ok") and cv.get("outputs", {}).get("entity_type") == "job":
        job_id = cv["outputs"]["entity_id"]
        job = _run_cli(db_url, ["run", "get_job", "--args", json.dumps({"job_id": int(job_id)})], timeout=30)
        tool_calls.append({"tool": "Bash", "input": f"app.cli run get_job --args {{\"job_id\": {job_id}}}"})
        if job.get("ok"):
            job_out = job.get("outputs", {})
            final_parts.append(f"Job: {job_out.get('title', '')} @ {job_out.get('company', '')}")
            final_parts.append(f"JD preview: {str(job_out.get('raw_description', ''))[:200]}")

    # For resume optimization cases, try prepare_resume_optimization
    if "\u7b80\u5386" in prompt or "resume" in prompt.lower():
        job_id = 1  # default to first job
        if cv.get("ok") and cv.get("outputs", {}).get("entity_id"):
            try:
                job_id = int(cv["outputs"]["entity_id"])
            except (ValueError, TypeError):
                pass
        prep = _run_cli(db_url, [
            "run", "prepare_resume_optimization",
            "--args", json.dumps({"job_id": job_id})
        ], timeout=120)
        tool_calls.append({"tool": "Bash", "input": f"app.cli run prepare_resume_optimization --args {{\"job_id\": {job_id}}}"})
        if prep.get("ok"):
            prep_out = prep.get("outputs", {})
            if prep_out.get("requires_confirmation"):
                prop = prep_out.get("proposal", {})
                final_parts.append(f"Proposal created: {prop.get('run_id', 'unknown')}")
                final_parts.append("Status: awaiting user confirmation")
            else:
                final_parts.append(f"Result: {json.dumps(prep_out, ensure_ascii=False)[:500]}")
        else:
            final_parts.append(f"prepare_resume_optimization failed: {prep.get('error', prep.get('raw', 'unknown'))}")

    return {
        "tool_calls": tool_calls,
        "final_text": "\n".join(final_parts),
        "is_error": False,
        "model": "omp-executor",
    }


async def watch_and_execute(watch_dir: Path, db_path: Path, timeout: int) -> None:
    """Watch for omp_request.json files and execute them."""
    processed: set[str] = set()
    print(f"[omp-executor] watching {watch_dir} for requests...")
    print(f"[omp-executor] eval_db: {db_path}")

    while True:
        for case_dir in sorted(watch_dir.iterdir()):
            if not case_dir.is_dir():
                continue
            req_path = case_dir / "omp_request.json"
            res_path = case_dir / "omp_result.json"
            if not req_path.is_file() or res_path.is_file():
                continue
            try:
                req = json.loads(req_path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                continue
            req_id = req.get("request_id", "")
            if req_id in processed:
                continue
            processed.add(req_id)

            prompt = req.get("prompt", "")
            eval_db = req.get("eval_db", str(db_path))
            req_timeout = req.get("timeout_seconds", timeout)
            round_num = req.get("round", 1)

            print(f"[omp-executor] executing {req_id} (round {round_num})")
            print(f"  prompt: {prompt[:100]}...")

            result = _execute_eval_turn(prompt, eval_db, req_timeout)
            result["request_id"] = req_id

            res_path.write_text(json.dumps(result, ensure_ascii=False), encoding="utf-8")
            print(f"[omp-executor] wrote result for {req_id}")

        await asyncio.sleep(1.0)


def main() -> int:
    parser = argparse.ArgumentParser(description="OMP executor for live eval")
    parser.add_argument("--watch-dir", required=True, help="Run directory to watch")
    parser.add_argument("--db", required=True, help="Eval database path")
    parser.add_argument("--timeout", type=int, default=300, help="Per-request timeout")
    args = parser.parse_args()

    return asyncio.run(watch_and_execute(
        Path(args.watch_dir), Path(args.db), args.timeout
    ))


if __name__ == "__main__":
    raise SystemExit(main())
