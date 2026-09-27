from __future__ import annotations

import asyncio
import sys
from pathlib import Path
from unittest.mock import AsyncMock

import pytest

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from app.services.pi_agent_worker import (  # noqa: E402
    PROTOCOL_VERSION,
    PiAgentWorkerClient,
    PiAgentWorkerError,
)


def test_pi_worker_probe_reports_kernel_features() -> None:
    async def flow() -> dict:
        client = PiAgentWorkerClient(node_path="node", worker_path=Path("worker.mjs"))
        client._ensure_started = AsyncMock()  # type: ignore[method-assign]
        client._command = AsyncMock(  # type: ignore[method-assign]
            return_value={
                "protocol_version": PROTOCOL_VERSION,
                "kernel": "pi",
                "features": {
                    "persistent_sessions": True,
                    "compaction": True,
                    "steer": True,
                    "follow_up": True,
                },
            }
        )
        return await client.probe()

    result = asyncio.run(flow())
    assert result["kernel"] == "pi"
    assert result["features"]["steer"] is True
    assert result["features"]["follow_up"] is True
    assert result["features"]["compaction"] is True


def test_pi_worker_session_controls_forward_to_worker_protocol() -> None:
    async def flow() -> list[tuple[tuple, dict]]:
        client = PiAgentWorkerClient(node_path="node", worker_path=Path("worker.mjs"))
        client._active_run_id = "run_controls"
        client._command = AsyncMock(  # type: ignore[method-assign]
            side_effect=[
                {"run_id": "run_controls", "disposition": "queued"},
                {"run_id": "run_controls", "disposition": "queued"},
                {"run_id": "run_controls", "compacted": True},
            ]
        )
        await client.steer_run("run_controls", "change direction")
        await client.follow_up_run("run_controls", "also summarize")
        await client.compact_run("run_controls", "preserve career decisions")
        return list(client._command.await_args_list)

    calls = asyncio.run(flow())
    assert calls[0].args == ("run.steer",)
    assert calls[0].kwargs["message"] == "change direction"
    assert calls[1].args == ("run.follow_up",)
    assert calls[1].kwargs["message"] == "also summarize"
    assert calls[2].args == ("run.compact",)
    assert calls[2].kwargs["instructions"] == "preserve career decisions"


def test_pi_worker_session_controls_fail_closed_for_wrong_run_or_empty_input() -> None:
    async def wrong_run() -> None:
        client = PiAgentWorkerClient(node_path="node", worker_path=Path("worker.mjs"))
        client._active_run_id = "run_one"
        with pytest.raises(PiAgentWorkerError):
            await client.steer_run("run_two", "change")

    async def empty_message() -> None:
        client = PiAgentWorkerClient(node_path="node", worker_path=Path("worker.mjs"))
        client._active_run_id = "run_one"
        with pytest.raises(PiAgentWorkerError):
            await client.follow_up_run("run_one", "   ")

    asyncio.run(wrong_run())
    asyncio.run(empty_message())
