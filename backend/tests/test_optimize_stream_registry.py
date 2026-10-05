import unittest
from unittest.mock import AsyncMock, patch

from fastapi import HTTPException
from app.routes import optimize


class OptimizeStreamRegistryTests(unittest.IsolatedAsyncioTestCase):
    async def test_stream_preserves_events_from_the_audited_operation(self):
        events = ['data: {"event":"thinking"}\n\n', 'data: {"event":"assistant_message","content":"draft"}\n\n']
        body = optimize.OptimizeAgentChatRequest(session_id="session", message="prepare", action="reply")
        with patch.object(optimize, "_execute_agent_operation", AsyncMock(return_value={"events": events})) as operation:
            response = await optimize.optimize_agent_chat_stream(body)
            actual = [event async for event in response.body_iterator]
        operation.assert_awaited_once_with("stream_optimize_agent_session", body.model_dump())
        self.assertEqual(actual, events)
        self.assertEqual(response.media_type, "text/event-stream")

    async def test_registry_failure_does_not_emit_a_successful_stream(self):
        with patch.object(optimize, "_execute_agent_operation", AsyncMock(side_effect=HTTPException(400, "failed"))):
            with self.assertRaises(HTTPException):
                await optimize.optimize_agent_chat_stream(optimize.OptimizeAgentChatRequest(session_id="session", message="prepare"))
