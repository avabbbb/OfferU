"""docs/02 D-1 / D-2: a Run waiting on the user never holds the Agent hostage.

* A Run that reaches ``waiting_confirmation`` parks: it releases the single
  embedded worker so the user can start another turn, while its session file
  and plan stay durable for the later approval continuation.
* A mid-run user message is steered into the live Run, or reported as
  ``not_running`` so the client sends it as a normal follow-up turn.
"""
from __future__ import annotations

import asyncio
import os
import sys
import unittest
from pathlib import Path
from typing import Any

BACKEND_DIR = Path(__file__).resolve().parents[1]
os.chdir(BACKEND_DIR)
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))
TESTS_DIR = Path(__file__).resolve().parent
if str(TESTS_DIR) not in sys.path:
    sys.path.insert(0, str(TESTS_DIR))

from app.database import init_db
from app.services.agent_run_state import create_agent_run, list_agent_run_events, load_agent_run
from app.services.embedded_agent_host import start_embedded_agent_run, steer_embedded_agent_run
from test_embedded_agent_host import FakeEmbeddedWorker

PROVIDER = {"name": "fixture", "model": "fixture"}
METADATA = {"runtime": "python_agent", "provider_id": "embedded"}


class SteerableWorker:
    def __init__(self, run_id: str, *, prompt_active: bool) -> None:
        self.active_run_id = run_id
        self.prompt_active = prompt_active
        self.steered: list[str] = []

    async def steer_run(self, run_id: str, message: str) -> dict[str, Any]:
        assert run_id == self.active_run_id
        self.steered.append(message)
        return {"run_id": run_id, "disposition": "queued"}


class AgentNeverLocksTests(unittest.TestCase):
    def test_waiting_confirmation_parks_the_worker_but_keeps_the_run(self) -> None:
        worker = FakeEmbeddedWorker()

        async def run() -> tuple[dict[str, Any], str | None, dict[str, Any] | None]:
            await init_db()
            from app.database import async_session
            from app.models.models import Job
            async with async_session() as db:
                if await db.get(Job, 74291) is None:
                    db.add(Job(id=74291, title="Synthetic recovery role", company="Fixture",
                               raw_description="Public synthetic JD", hash_key="host-recovery-job"))
                    await db.commit()
            started = await start_embedded_agent_run(
                message="帮我调研这个岗位",
                skill_id="company_research",
                conversation_id="never-locks-park",
                worker=worker,
                provider_config=PROVIDER,
                provider_metadata=METADATA,
            )
            return started, worker.active_run_id, await load_agent_run(started["run"]["id"])

        started, active_run_id, stored = asyncio.run(run())
        self.assertTrue(started["ok"], started)
        self.assertEqual(stored["status"], "waiting_confirmation")
        # Parked: the single worker is free for the user's next turn...
        self.assertIsNone(active_run_id)
        # ...while the Run itself is neither cancelled nor approved.
        self.assertTrue(started["run"]["final_result"]["requires_confirmation"])

    def test_steer_reaches_only_a_live_prompt(self) -> None:
        async def run() -> tuple[dict[str, Any], dict[str, Any], list[str], list[str]]:
            await init_db()
            record = await create_agent_run(conversation_id="never-locks-steer", goal="steer fixture", mode="skill", skill_id="discovery", actions=[])
            run_id = record["id"]
            live = SteerableWorker(run_id, prompt_active=True)
            steered = await steer_embedded_agent_run(run_id, "  换成只看上海的岗位  ", worker=live)
            idle = SteerableWorker(run_id, prompt_active=False)
            not_running = await steer_embedded_agent_run(run_id, "这条应作为新一轮", worker=idle)
            events = [event["type"] for event in await list_agent_run_events(run_id)]
            return steered, not_running, live.steered + idle.steered, events

        steered, not_running, delivered, events = asyncio.run(run())
        self.assertEqual(steered["disposition"], "steered")
        self.assertEqual(not_running["disposition"], "not_running")
        self.assertEqual(delivered, ["换成只看上海的岗位"])
        self.assertEqual(events.count("input.steered"), 1)

    def test_empty_steer_is_rejected(self) -> None:
        with self.assertRaises(ValueError):
            asyncio.run(steer_embedded_agent_run("run_0000000000000000", "   "))


if __name__ == "__main__":
    unittest.main()

