"""
Real Agent Executor for OfferU E2E eval.

Launches a real Agent session (OMP/Claude Code/Codex) and lets the model
decide which OfferU CLI operations to call. This is the true Agent-native eval.

Unlike scripted_cli_executor.py which hardcodes the operation sequence,
this executor:
1. Gives the Agent a natural language task
2. Lets it discover Skills via `manifest`
3. Lets it select and call Operations via `run`
4. Captures all model-issued tool calls for verification

Usage:
    python -m scripts.live_eval.agent_executor --case PR01 --model swe-2
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

BACKEND_DIR = Path(__file__).resolve().parents[2]
EVAL_DIR = Path(r"H:\tmp\offeru\private-eval")
RUN_DIR = Path(r"H:\tmp\offeru\live-eval-runs\agent")


def _build_agent_prompt(case: dict[str, Any]) -> str:
    """Build the prompt for the Agent."""
    user_turns = case.get("user_turns", [])
    task = user_turns[0] if user_turns else "No task specified"
    
    return f"""You are an AI assistant helping with a job application task.

## Task
{task}

## Environment
- Working directory: {BACKEND_DIR}
- Database: {EVAL_DIR}/eval.db
- Frontend: http://127.0.0.1:7410
- Backend: http://127.0.0.1:8766

## Available Tools
You have access to a `bash` tool. Use it to run OfferU CLI commands:

```bash
python -m app.cli doctor --pretty          # Check system health
python -m app.cli manifest --pretty          # List available skills
python -m app.cli manifest --skill <id> --pretty  # Show skill details
python -m app.cli ops --pretty               # List all operations
python -m app.cli schema <op> --pretty       # Show operation schema
python -m app.cli run <op> --args '{{"key":"val"}}'  # Run operation
python -m app.cli confirm <run_id>           # Confirm proposal
```

## Rules
1. Discover skills first via `manifest`
2. Read operation schemas before calling
3. For mutations, check if confirmation required
4. Report what you did and the result

Start by checking system health and listing available skills."""


def _check_agent_available() -> dict[str, Any]:
    """Check if any Agent runtime is available."""
    # Check for Claude Code
    try:
        proc = subprocess.run(
            ["claude", "--version"],
            capture_output=True,
            text=True,
            timeout=10,
        )
        if proc.returncode == 0:
            return {"available": True, "provider": "claude", "version": proc.stdout.strip()}
    except Exception:
        pass
    
    # Check for Codex
    try:
        proc = subprocess.run(
            ["codex", "--version"],
            capture_output=True,
            text=True,
            timeout=10,
        )
        if proc.returncode == 0:
            return {"available": True, "provider": "codex", "version": proc.stdout.strip()}
    except Exception:
        pass
    
    # Check for OMP
    try:
        proc = subprocess.run(
            ["omp", "--version"],
            capture_output=True,
            text=True,
            timeout=10,
        )
        if proc.returncode == 0:
            return {"available": True, "provider": "omp", "version": proc.stdout.strip()}
    except Exception:
        pass
    
    return {"available": False, "error": "No Agent runtime found"}


def _run_agent_session(case: dict[str, Any], model: str, timeout: int) -> dict[str, Any]:
    """Run a real Agent session."""
    
    # Check Agent availability
    agent_status = _check_agent_available()
    if not agent_status["available"]:
        return {
            "ok": False,
            "error": "No Agent runtime available",
            "details": agent_status,
            "fallback": "Use scripted_cli_executor.py for deterministic testing",
        }
    
    provider = agent_status["provider"]
    
    # Build prompt
    prompt = _build_agent_prompt(case)
    
    # Create run directory
    run_id = f"agent_{case['case_id']}_{int(time.time())}"
    run_dir = RUN_DIR / run_id
    run_dir.mkdir(parents=True, exist_ok=True)
    
    # Write prompt
    prompt_file = run_dir / "prompt.txt"
    prompt_file.write_text(prompt, encoding="utf-8")
    
    # Launch Agent session based on provider
    if provider == "claude":
        result = _run_claude_session(prompt, model, timeout, run_dir)
    elif provider == "codex":
        result = _run_codex_session(prompt, model, timeout, run_dir)
    elif provider == "omp":
        result = _run_omp_session(prompt, model, timeout, run_dir)
    else:
        result = {"ok": False, "error": f"Unknown provider: {provider}"}
    
    result["run_id"] = run_id
    result["case_id"] = case["case_id"]
    result["provider"] = provider
    
    # Save trace
    trace_file = run_dir / "trace.json"
    trace_file.write_text(json.dumps(result, indent=2, ensure_ascii=False), encoding="utf-8")
    
    return result


def _run_claude_session(prompt: str, model: str, timeout: int, run_dir: Path) -> dict[str, Any]:
    """Run a Claude Code session."""
    env = os.environ.copy()
    env["DATABASE_URL"] = f"sqlite+aiosqlite:///{EVAL_DIR}/eval.db"
    env["PYTHONIOENCODING"] = "utf-8"
    env["PYTHONPATH"] = str(BACKEND_DIR)
    
    proc = subprocess.run(
        ["claude", "--print", "--verbose", "--output-format", "stream-json", "--model", model, prompt],
        capture_output=True,
        text=True,
        timeout=timeout,
        env=env,
        cwd=str(BACKEND_DIR),
    )
    
    return {
        "ok": proc.returncode == 0,
        "stdout": proc.stdout[:5000],
        "stderr": proc.stderr[:2000],
        "returncode": proc.returncode,
    }


def _run_codex_session(prompt: str, model: str, timeout: int, run_dir: Path) -> dict[str, Any]:
    """Run a Codex session."""
    env = os.environ.copy()
    env["DATABASE_URL"] = f"sqlite+aiosqlite:///{EVAL_DIR}/eval.db"
    env["PYTHONIOENCODING"] = "utf-8"
    env["PYTHONPATH"] = str(BACKEND_DIR)
    
    proc = subprocess.run(
        ["codex", "exec", "--model", model, prompt],
        capture_output=True,
        text=True,
        timeout=timeout,
        env=env,
        cwd=str(BACKEND_DIR),
    )
    
    return {
        "ok": proc.returncode == 0,
        "stdout": proc.stdout[:5000],
        "stderr": proc.stderr[:2000],
        "returncode": proc.returncode,
    }


def _run_omp_session(prompt: str, model: str, timeout: int, run_dir: Path) -> dict[str, Any]:
    """Run an OMP session."""
    env = os.environ.copy()
    env["DATABASE_URL"] = f"sqlite+aiosqlite:///{EVAL_DIR}/eval.db"
    env["PYTHONIOENCODING"] = "utf-8"
    env["PYTHONPATH"] = str(BACKEND_DIR)
    
    proc = subprocess.run(
        ["omp", "exec", "--model", model, prompt],
        capture_output=True,
        text=True,
        timeout=timeout,
        env=env,
        cwd=str(BACKEND_DIR),
    )
    
    return {
        "ok": proc.returncode == 0,
        "stdout": proc.stdout[:5000],
        "stderr": proc.stderr[:2000],
        "returncode": proc.returncode,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Real Agent executor for live eval")
    parser.add_argument("--case", required=True, help="Eval case ID")
    parser.add_argument("--model", default="swe-2", help="Model to use")
    parser.add_argument("--timeout", type=int, default=300, help="Timeout in seconds")
    parser.add_argument("--cases-file", default=str(EVAL_DIR / "private_resume_opt_6.json"))
    args = parser.parse_args()
    
    # Load case
    cases_file = Path(args.cases_file)
    if not cases_file.exists():
        print(json.dumps({"ok": False, "error": f"Cases file not found: {cases_file}"}))
        return 1
    
    cases = json.loads(cases_file.read_text(encoding="utf-8"))
    case = next((c for c in cases["cases"] if c["case_id"] == args.case), None)
    if not case:
        print(json.dumps({"ok": False, "error": f"Case not found: {args.case}"}))
        return 1
    
    # Run Agent session
    result = _run_agent_session(case, args.model, args.timeout)
    print(json.dumps(result, indent=2, ensure_ascii=False))
    return 0 if result.get("ok") else 1


if __name__ == "__main__":
    sys.exit(main())
