from types import SimpleNamespace

from app.agent.types import AssistantMessage, TextContent, Usage, UserMessage
from app.services.embedded_agent_worker import CONTEXT_RESERVE_TOKENS, CONTEXT_WINDOW_TOKENS, context_usage


def test_reported_usage_wins():
    message = AssistantMessage(content=[TextContent(text="ok")], usage=Usage(input_tokens=1200, output_tokens=80))
    usage = context_usage({"message": message, "context": SimpleNamespace(messages=[])})
    assert usage == {"used": 1280, "window": CONTEXT_WINDOW_TOKENS,
                     "compact_at": CONTEXT_WINDOW_TOKENS - CONTEXT_RESERVE_TOKENS, "estimated": False}


def test_estimates_when_gateway_returns_no_usage():
    message = AssistantMessage(content=[TextContent(text="ok")], usage=Usage(estimated=True))
    context = SimpleNamespace(messages=[UserMessage(content=[TextContent(text="帮我评估这个岗位" * 50)])])
    usage = context_usage({"message": message, "context": context})
    assert usage["estimated"] is True
    assert usage["used"] > 0
    assert not any("token" in key for key in usage)
