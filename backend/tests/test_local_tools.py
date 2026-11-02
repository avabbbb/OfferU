"""内置 Agent 的本机文件 / 网页搜索工具：find_files、web_search。"""

import os

import pytest

from app.core import tools


def test_find_files_lists_docs_newest_first(tmp_path):
    (tmp_path / "sub").mkdir()
    old = tmp_path / "旧简历.txt"
    old.write_text("李四 字节跳动", encoding="utf-8")
    (tmp_path / "简历2024.md").write_text("# 李四", encoding="utf-8")
    (tmp_path / "photo.png").write_bytes(b"x")
    (tmp_path / "sub" / "deep.txt").write_text("x", encoding="utf-8")
    os.utime(old, (1_000_000, 1_000_000))

    out = tools.find_files(str(tmp_path))
    assert [i["name"] for i in out["items"]] == ["简历2024.md", "旧简历.txt"]
    assert out["dirs"] == ["sub"] and "scanned" not in out
    assert "deep.txt" in [i["name"] for i in tools.find_files(str(tmp_path), recursive=True)["items"]]
    assert [i["name"] for i in tools.find_files(str(tmp_path), pattern="*简历*")["items"]] == ["简历2024.md", "旧简历.txt"]
    with pytest.raises(ValueError):
        tools.find_files("relative/dir")
    with pytest.raises(ValueError):
        tools.find_files(str(tmp_path / "missing"))


def test_find_files_query_matches_name_or_text(tmp_path):
    (tmp_path / "a.txt").write_text("实习经历\n字节跳动 后端开发", encoding="utf-8")
    (tmp_path / "b.md").write_text("购物清单", encoding="utf-8")
    (tmp_path / "简历.md").write_text("李四", encoding="utf-8")
    (tmp_path / "sub").mkdir()
    (tmp_path / "sub" / "c.txt").write_text("字节跳动 前端", encoding="utf-8")

    out = tools.find_files(str(tmp_path), query="字节跳动 后端")
    assert [h["name"] for h in out["items"]] == ["a.txt"]
    assert "字节跳动" in out["items"][0]["snippet"] and out["scanned"] == 4
    assert [h["name"] for h in tools.find_files(str(tmp_path), query="简历")["items"]] == ["简历.md"]
    assert {h["name"] for h in tools.find_files(str(tmp_path), query="字节跳动")["items"]} == {"a.txt", "c.txt"}


def test_web_search_needs_provider(monkeypatch):
    from app.config import get_settings
    from app.services import web_search as service

    async def fake(query, limit=8, allow_optional_ddgs=True):
        return [{"title": "t", "url": "https://example.com", "snippet": "s", "engine": "tavily"}]

    settings = get_settings()
    for key in ("bocha_api_key", "tavily_api_key", "serper_api_key"):
        monkeypatch.setattr(settings, key, "")
    monkeypatch.setattr(service, "_ddgs_available", lambda: False)
    monkeypatch.setattr(service, "web_search", fake)
    with pytest.raises(ValueError, match="没配搜索服务"):
        tools.web_search("x")
    monkeypatch.setattr(settings, "tavily_api_key", "k")
    assert tools.web_search("x")["items"][0]["url"] == "https://example.com"
    assert {"find_files", "web_search"} <= set(tools.TOOLS)
    assert not {"list_files", "grep_files"} & set(tools.TOOLS)
