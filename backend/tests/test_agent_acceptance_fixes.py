"""Agent 验收修复：/mcp 默认打开；fetch_page 读 ssl_verify、网络错误转 ValueError（400）；auto 不再调 LLM 路由。"""

import asyncio
import contextlib
import ssl
import urllib.error
import urllib.request
from types import SimpleNamespace

import pytest

from app.config import Settings
from app.core import tools

JD_URL = "https" + "://jobs.invalid/jd"
JD_HTML = "<title>后端实习</title><p>岗位职责</p>".encode("utf-8")


def _response():
    body = SimpleNamespace(
        headers=SimpleNamespace(get_content_charset=lambda: "utf-8"),
        read=lambda n: JD_HTML,
    )
    return contextlib.nullcontext(body)


def test_mcp_enabled_by_default():
    assert Settings.model_fields["offeru_enable_mcp"].default is True


def test_fetch_page_honors_ssl_verify(monkeypatch):
    seen = {}

    def fake_urlopen(request, timeout, context):
        seen["context"] = context
        return _response()

    monkeypatch.setattr(urllib.request, "urlopen", fake_urlopen)
    monkeypatch.setattr("app.config.get_settings", lambda: SimpleNamespace(ssl_verify=False))
    out = tools.fetch_page(JD_URL)
    assert out["title"] == "后端实习" and "岗位职责" in out["text"]
    assert isinstance(seen["context"], ssl.SSLContext)
    assert seen["context"].verify_mode == ssl.CERT_NONE

    monkeypatch.setattr("app.config.get_settings", lambda: SimpleNamespace(ssl_verify=True))
    tools.fetch_page(JD_URL)
    assert seen["context"] is None


@pytest.mark.parametrize("error", [
    urllib.error.URLError("CERTIFICATE_VERIFY_FAILED"),
    urllib.error.HTTPError(JD_URL, 403, "Forbidden", None, None),
    TimeoutError("timed out"),
])
def test_fetch_page_network_error_is_value_error(monkeypatch, error):
    def boom(request, timeout, context):
        raise error

    monkeypatch.setattr(urllib.request, "urlopen", boom)
    with pytest.raises(ValueError, match="打开网页失败"):
        tools.fetch_page(JD_URL)


def test_auto_skill_lands_on_default_without_llm(monkeypatch):
    from app.agents import llm
    from app.services import agent_skill_registry as registry

    async def no_llm(*args, **kwargs):
        raise AssertionError("auto 不应调用 LLM")

    monkeypatch.setattr(llm, "chat_completion", no_llm)
    for requested in ("auto", "", None):
        skill, routing = asyncio.run(registry.resolve_run_skill("帮我看看下一步", requested))
        assert skill.id == registry.DEFAULT_AUTO_SKILL_ID
        assert routing.via == "auto" and routing.reason == "default"

    skill, routing = asyncio.run(registry.resolve_run_skill("评估这个岗位", "evaluate_job"))
    assert skill.id == "evaluate_job" and routing.via == "explicit"
