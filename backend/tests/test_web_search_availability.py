import asyncio
import logging

from app.services import web_search as w


class _NoKeys:
    search_provider = "auto"
    bocha_api_key = ""
    tavily_api_key = ""
    serper_api_key = ""


def test_no_provider_is_reported_unavailable_not_empty(monkeypatch, caplog):
    monkeypatch.setattr(w, "get_settings", lambda: _NoKeys())
    monkeypatch.setattr(w, "_ddgs_available", lambda: False)
    with caplog.at_level(logging.WARNING):
        out = asyncio.run(w.web_search_preview(query="AI Agent 产品经理"))
    assert out["results"] == [] and out["available"] is False
    assert out["configured_providers"] == []
    assert "no search provider configured" in caplog.text


def test_ddgs_only_listed_when_installed(monkeypatch):
    monkeypatch.setattr(w, "get_settings", lambda: _NoKeys())
    monkeypatch.setattr(w, "_ddgs_available", lambda: True)

    async def fake(query, limit):
        return [{"title": "t", "url": "https://example.com/job", "snippet": "", "source": "ddgs"}]

    monkeypatch.setattr(w, "_search_ddgs", fake)
    out = asyncio.run(w.web_search_preview(query="q"))
    assert out["configured_providers"] == ["ddgs"] and out["available"] is True and len(out["results"]) == 1
