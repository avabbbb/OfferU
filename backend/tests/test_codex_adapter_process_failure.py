from __future__ import annotations

import asyncio

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

