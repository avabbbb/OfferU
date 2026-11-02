"""没配内置模型时，模型调用交给外置 Agent。"""

import asyncio

import pytest

from app.agents import agent_fallback, llm
from app.services import coding_agent_runtime


def _unconfigured(settings=None):
    raise ValueError("还没有配置模型服务，请先在设置里添加一个。")


def _fake_complete(calls):
    async def fake(messages, json_mode=False, cause=None, timeout_seconds=300):
        calls.append({"messages": messages, "json_mode": json_mode, "cause": str(cause)})
        return '{"ok": true}'
    return fake


def test_chat_completion_falls_back_to_external_agent(monkeypatch):
    calls = []
    monkeypatch.setattr(llm, "resolve_llm_client_config", _unconfigured)
    monkeypatch.setattr(agent_fallback, "enabled", lambda: True)
    monkeypatch.setattr(agent_fallback, "complete", _fake_complete(calls))

    out = asyncio.run(llm.chat_completion([{"role": "user", "content": "hi"}], json_mode=True))

    assert out == '{"ok": true}'
    assert calls[0]["json_mode"] is True and "没有配置模型服务" in calls[0]["cause"]


def test_stream_yields_whole_answer_once(monkeypatch):
    calls = []
    monkeypatch.setattr(llm, "resolve_llm_client_config", _unconfigured)
    monkeypatch.setattr(agent_fallback, "enabled", lambda: True)
    monkeypatch.setattr(agent_fallback, "complete", _fake_complete(calls))

    async def collect():
        return [piece async for piece in llm.chat_completion_stream([{"role": "user", "content": "hi"}])]

    assert asyncio.run(collect()) == ['{"ok": true}']


def test_fallback_off_keeps_original_error(monkeypatch):
    monkeypatch.setattr(llm, "resolve_llm_client_config", _unconfigured)
    monkeypatch.setattr(agent_fallback, "enabled", lambda: False)

    with pytest.raises(ValueError, match="没有配置模型服务"):
        asyncio.run(llm.chat_completion([{"role": "user", "content": "hi"}]))


def test_no_external_agent_reports_both_reasons(monkeypatch):
    async def none_available(preferred=None, requirements=None):
        raise ValueError("没有可用且契约兼容的 coding-agent runtime")

    monkeypatch.setattr(coding_agent_runtime, "select_local_executor", none_available)

    with pytest.raises(ValueError) as info:
        asyncio.run(agent_fallback.complete([{"role": "user", "content": "hi"}], cause=ValueError("没配模型")))
    assert "没配模型" in str(info.value) and "外置 Agent" in str(info.value)


def test_prompt_and_answer_shape():
    prompt = agent_fallback.build_prompt(
        [{"role": "system", "content": "只回 JSON"}, {"role": "user", "content": "简历"}], json_mode=True)
    assert "### system" in prompt and "### user" in prompt and "合法的 JSON" in prompt
    assert agent_fallback.answer_of({"structured": {"answer": "好"}, "text": "x"}) == "好"
    assert agent_fallback.answer_of({"structured": {}, "text": "原文"}) == "原文"


def test_unconfigured_counts_as_remote(monkeypatch):
    monkeypatch.setattr(llm, "resolve_llm_client_config", _unconfigured)
    assert agent_fallback.endpoint_is_local() is False
