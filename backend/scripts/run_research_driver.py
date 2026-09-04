"""Driver: start a FRESH job-research run (new prompt) and await completion.

The research runs the local claude agent with live WebSearch/WebFetch and a
bounded research prompt. This script keeps the event loop alive so the
background task finishes instead of dying with a short-lived CLI process.
"""
import asyncio
import json
import sys
from pathlib import Path

_BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(_BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(_BACKEND_DIR))

from sqlalchemy import select

from app.database import async_session
from app.models.models import JobResearchRun
from app.services import job_research
from app.services.job_research import start_job_research
from app.services.security_redaction import safe_error_message

JOB_ID = 6
RUNTIME_ID = "claude"


async def main() -> None:
    print("STEP: starting fresh research run", flush=True)
    summary = await start_job_research(job_id=JOB_ID, runtime_id=RUNTIME_ID)
    print("START=" + json.dumps(summary, ensure_ascii=False)[:500], flush=True)
    research_run_id = summary.get("run_id") or ""
    if not research_run_id:
        print("NO_RUN_ID", flush=True)
        return
    print("RESEARCH_RUN_ID=" + str(research_run_id), flush=True)

    live = job_research._LIVE_TASKS.get(research_run_id)
    if live is not None:
        print("AWAITING live research task...", flush=True)
        try:
            await asyncio.wait_for(live, timeout=1860)
            print("TASK_DONE", flush=True)
        except asyncio.TimeoutError:
            print("TASK_TIMEOUT", flush=True)
        except Exception as exc:  # noqa: BLE001
            print("TASK_EXC=" + safe_error_message(exc), flush=True)
    else:
        print("NO_LIVE_TASK", flush=True)

    for _ in range(380):
        async with async_session() as db:
            row = (
                await db.execute(
                    select(JobResearchRun).where(JobResearchRun.run_id == research_run_id)
                )
            ).scalar_one_or_none()
            if row is None:
                print("RUN_NOT_FOUND", flush=True)
                return
            if row.status in {"completed", "failed", "cancelled", "interrupted"}:
                result_json = row.result_json if isinstance(row.result_json, dict) else {}
                findings = result_json.get("findings") or []
                sources = result_json.get("sources") or []
                gaps = result_json.get("gaps") or []
                print(
                    "RUN_FINAL run_id=" + str(research_run_id)
                    + " status=" + str(row.status)
                    + " findings=" + str(len(findings))
                    + " sources=" + str(len(sources))
                    + " gaps=" + str(len(gaps))
                    + " review=" + str(row.review_status)
                    + " error=" + (row.error or "")[:400],
                    flush=True,
                )
                return
        await asyncio.sleep(5)
    print("RUN_POLL_EXHAUSTED", flush=True)


if __name__ == "__main__":
    asyncio.run(main())
