from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock

import pytest

from app.services.agent_bridge.codex_adapter import CodexMainLoopAdapter


class _EofStdout:
    async def readline(self) -> bytes:
        return b""


class _ExitedProcess:
    returncode = 23
    stdout = _EofStdout()

    async def wait(self) -> int:
        return self.returncode


def test_native_process_eof_fails_pending_requests_without_protocol_timeout() -> None:
    async def flow() -> None:
        adapter = CodexMainLoopAdapter(executable="test-only")
        adapter.process = _ExitedProcess()  # type: ignore[assignment]
        pending = asyncio.get_running_loop().create_future()
        adapter._pending[1] = pending

        await adapter._reader()

        assert adapter._reader_exit_error is not None
        assert "exited before completing" in str(adapter._reader_exit_error)
        with pytest.raises(RuntimeError, match="exited before completing"):
            await pending

    asyncio.run(flow())


def test_bridge_turn_checks_provider_auth_before_discovering_business_tools() -> None:
    async def flow() -> None:
        adapter = CodexMainLoopAdapter(executable="test-only")
        adapter.read_account = AsyncMock(
            return_value={"account": None, "requiresOpenaiAuth": True}
        )  # type: ignore[method-assign]
        adapter.create_thread = AsyncMock()  # type: ignore[method-assign]

        with pytest.raises(RuntimeError, match="authentication required"):
            await adapter.run_turn(
                prompt="probe",
                cwd="H:/tmp/offeru/bridge-auth-test",
                tool_descriptions=[],
            )
        adapter.create_thread.assert_not_awaited()

    asyncio.run(flow())
