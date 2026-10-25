"""Embedded Agent Runs are isolated per run and may proceed concurrently."""
import asyncio

import pytest

from app.services.embedded_agent_worker import EmbeddedAgentWorkerError, EmbeddedAgentWorkerPool


def _run_id(ch):
    return "run_" + ch * 16


def _start(pool, run_id, directory):
    return pool.start_run(
        run_id=run_id, system_prompt="t", provider={}, allowed_operations=[],
        operation_runner=None, session_directory=str(directory),
    )


def test_independent_runs_are_active_together(tmp_path):
    async def scenario():
        pool = EmbeddedAgentWorkerPool(provider_factory=object, max_runs=3)
        a, b = _run_id("a"), _run_id("b")
        await asyncio.gather(_start(pool, a, tmp_path), _start(pool, b, tmp_path))
        assert pool.is_active(a) and pool.is_active(b)
        assert sorted(pool.active_run_ids) == [a, b]
        with pytest.raises(EmbeddedAgentWorkerError, match="already active"):
            await _start(pool, a, tmp_path)
        await pool.dispose_run(a)
        assert not pool.is_active(a) and pool.is_active(b)
        await pool.close()
        assert pool.active_run_ids == []

    asyncio.run(scenario())


def test_capacity_limit_is_explicit(tmp_path):
    async def scenario():
        pool = EmbeddedAgentWorkerPool(provider_factory=object, max_runs=1)
        first = _run_id("c")
        await _start(pool, first, tmp_path)
        with pytest.raises(EmbeddedAgentWorkerError, match="OFFERU_AGENT_MAX_CONCURRENT_RUNS"):
            await _start(pool, _run_id("d"), tmp_path)
        assert pool.active_run_ids == [first]
        await pool.close()

    asyncio.run(scenario())


def test_failed_start_releases_slot(tmp_path):
    async def scenario():
        pool = EmbeddedAgentWorkerPool(provider_factory=object, max_runs=1)
        with pytest.raises(EmbeddedAgentWorkerError):
            await _start(pool, "not-a-run-id", tmp_path)
        assert pool.active_run_ids == []

    asyncio.run(scenario())
