# =============================================
# Web Search — 岗位调研的后端检索兜底链
# =============================================
# 主路径永远是 CLI runtime 的 live web search（codex/claude/gemini）。
# 本模块只在没有 live-capable runtime 时启用（"后端检索模式"），
# provider 兜底链：bocha（博查，国内）→ tavily → serper → ddgs（免 key 尽力而为）。
#
# 红线：
# - 反爬/需登录站点（小红书/脉脉/牛客/BOSS）绝不直接抓取，
#   fetch_readable 命中黑名单直接拒绝并引导 authorized_research 授权浏览切片。
# - 全部 provider 走 httpx 纯 HTTP 调用，不引第三方 SDK。
# =============================================

from __future__ import annotations

import asyncio
import ipaddress
import logging
import re
import socket
from typing import Any, Optional, TypedDict
from urllib.parse import urljoin, urlparse

import httpx

from app.config import get_settings
from app.services.security_redaction import redact_sensitive_text, safe_error_message

_logger = logging.getLogger(__name__)

_TIMEOUT = 20.0
_MAX_REDIRECTS = 3
_REDIRECT_STATUSES = {301, 302, 303, 307, 308}

# 反爬/需登录平台域名黑名单 → 必须走 authorized_research 授权浏览
RESTRICTED_DOMAINS = (
    "xiaohongshu.com",
    "xhslink.com",
    "maimai.cn",
    "nowcoder.com",
    "zhipin.com",
)


class SearchResult(TypedDict):
    title: str
    url: str
    snippet: str
    engine: str


def _is_restricted(url: str) -> bool:
    try:
        host = (urlparse(url).hostname or "").lower()
    except ValueError:
        return True
    return any(host == domain or host.endswith("." + domain) for domain in RESTRICTED_DOMAINS)


def _is_public_http_url(url: str) -> bool:
    try:
        parsed = urlparse(url)
    except ValueError:
        return False
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        return False
    if parsed.username or parsed.password:
        return False
    host = parsed.hostname.lower()
    if host in {"localhost"} or host.endswith(".local"):
        return False
    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        return True
    return not (
        address.is_private
        or address.is_loopback
        or address.is_link_local
        or address.is_reserved
    )


async def _assert_public_destination(url: str) -> None:
    """Reject private DNS answers before opening a public research URL."""

    if not _is_public_http_url(url):
        raise ValueError("仅支持公开 HTTP(S) URL")
    parsed = urlparse(url)
    host = parsed.hostname
    if not host:
        raise ValueError("URL 缺少主机名")
    try:
        port = parsed.port or (443 if parsed.scheme.lower() == "https" else 80)
    except ValueError as exc:
        raise ValueError("URL 端口无效") from exc
    try:
        addresses = await asyncio.to_thread(
            socket.getaddrinfo,
            host,
            port,
            type=socket.SOCK_STREAM,
        )
    except OSError as exc:
        raise ValueError("目标域名无法解析") from exc
    if not addresses:
        raise ValueError("目标域名没有可用地址")
    for address in addresses:
        raw_ip = address[4][0]
        try:
            ip = ipaddress.ip_address(raw_ip)
        except ValueError as exc:
            raise ValueError("目标域名解析到了无效地址") from exc
        if not ip.is_global:
            raise ValueError("目标域名解析到了非公网地址")


def _http_client(**kwargs: Any) -> httpx.AsyncClient:
    """Use direct, non-redirecting HTTP for the public research boundary."""

    return httpx.AsyncClient(
        timeout=_TIMEOUT,
        follow_redirects=False,
        trust_env=False,
        **kwargs,
    )


def _clean_result(
    title: Any, url: Any, snippet: Any, engine: str
) -> Optional[SearchResult]:
    clean_url = str(url or "").strip()
    if not clean_url or not _is_public_http_url(clean_url):
        return None
    return {
        "title": str(title or "").strip()[:300],
        "url": clean_url[:2000],
        "snippet": str(snippet or "").strip()[:1000],
        "engine": engine,
    }


async def _search_bocha(query: str, limit: int, api_key: str) -> list[SearchResult]:
    """博查 AI Search（国内合规，覆盖百度系内容）。"""
    async with _http_client() as client:
        response = await client.post(
            "https://api.bochaai.com/v1/web-search",
            headers={"Authorization": f"Bearer {api_key}"},
            json={"query": query, "count": limit, "summary": True},
        )
        response.raise_for_status()
        payload = response.json()
    items = (((payload or {}).get("data") or {}).get("webPages") or {}).get("value") or []
    results = []
    for item in items[:limit]:
        result = _clean_result(
            item.get("name"), item.get("url"), item.get("summary") or item.get("snippet"), "bocha"
        )
        if result:
            results.append(result)
    return results


async def _search_tavily(query: str, limit: int, api_key: str) -> list[SearchResult]:
    async with _http_client() as client:
        response = await client.post(
            "https://api.tavily.com/search",
            json={"api_key": api_key, "query": query, "max_results": limit},
        )
        response.raise_for_status()
        payload = response.json()
    results = []
    for item in (payload or {}).get("results", [])[:limit]:
        result = _clean_result(item.get("title"), item.get("url"), item.get("content"), "tavily")
        if result:
            results.append(result)
    return results


async def _search_serper(query: str, limit: int, api_key: str) -> list[SearchResult]:
    async with _http_client() as client:
        response = await client.post(
            "https://google.serper.dev/search",
            headers={"X-API-KEY": api_key},
            json={"q": query, "num": limit},
        )
        response.raise_for_status()
        payload = response.json()
    results = []
    for item in (payload or {}).get("organic", [])[:limit]:
        result = _clean_result(item.get("title"), item.get("link"), item.get("snippet"), "serper")
        if result:
            results.append(result)
    return results


async def _search_ddgs(query: str, limit: int) -> list[SearchResult]:
    """ddgs 免 key 兜底（可选依赖；国内直连不稳定，尽力而为）。"""
    try:
        from ddgs import DDGS  # type: ignore[import-not-found]
    except ImportError:
        try:
            from duckduckgo_search import DDGS  # type: ignore[import-not-found]
        except ImportError:
            return []
    import asyncio

    def _run() -> list[SearchResult]:
        results: list[SearchResult] = []
        with DDGS() as ddgs:
            for item in ddgs.text(query, max_results=limit):
                result = _clean_result(
                    item.get("title"), item.get("href"), item.get("body"), "ddgs"
                )
                if result:
                    results.append(result)
        return results

    return await asyncio.to_thread(_run)


async def web_search(
    query: str,
    *,
    limit: int = 8,
    allow_optional_ddgs: bool = True,
) -> list[SearchResult]:
    """按兜底链依次尝试搜索 provider，返回首个非空结果。

    settings.search_provider 显式指定时只走该 provider；受控发布路径可关闭
    ddgs 这个无法证明代理/重定向边界的可选依赖。"""
    clean_query = str(query or "").strip()
    if not clean_query:
        raise ValueError("query 不能为空")
    safe_limit = max(1, min(int(limit), 20))
    settings = get_settings()
    provider = str(settings.search_provider or "auto").strip().lower()

    chain: list[tuple[str, Any]] = []
    if provider in {"auto", "bocha"} and settings.bocha_api_key:
        chain.append(("bocha", lambda: _search_bocha(clean_query, safe_limit, settings.bocha_api_key)))
    if provider in {"auto", "tavily"} and settings.tavily_api_key:
        chain.append(("tavily", lambda: _search_tavily(clean_query, safe_limit, settings.tavily_api_key)))
    if provider in {"auto", "serper"} and settings.serper_api_key:
        chain.append(("serper", lambda: _search_serper(clean_query, safe_limit, settings.serper_api_key)))
    if allow_optional_ddgs and provider in {"auto", "ddgs"}:
        chain.append(("ddgs", lambda: _search_ddgs(clean_query, safe_limit)))
    if provider not in {"auto", "bocha", "tavily", "serper", "ddgs"}:
        raise ValueError(f"未知 search_provider: {provider}")

    errors: list[str] = []
    for name, runner in chain:
        try:
            results = await runner()
        except Exception as exc:
            errors.append(f"{name}: {safe_error_message(exc, max_length=200)}")
            continue
        if results:
            return results
    if errors:
        _logger.warning(
            "web_search all providers failed: %s",
            redact_sensitive_text("; ".join(errors), max_length=1000),
        )
    return []


async def fetch_readable(url: str, *, max_chars: int = 20_000) -> str:
    """抓取公开网页并抽取正文文本；反爬域名与非公开 URL 直接拒绝。"""
    clean_url = str(url or "").strip()
    if not _is_public_http_url(clean_url):
        raise ValueError("仅支持公开 HTTP(S) URL")
    if _is_restricted(clean_url):
        raise ValueError(
            "该站点（小红书/脉脉/牛客/BOSS）需登录且受访问控制保护，"
            "请使用授权浏览切片（authorized_research）由用户登录后逐页确认采集"
        )
    current_url = clean_url
    async with _http_client(
        headers={"User-Agent": "Mozilla/5.0 (OfferU research; public pages only)"},
    ) as client:
        for redirect_count in range(_MAX_REDIRECTS + 1):
            await _assert_public_destination(current_url)
            if _is_restricted(current_url):
                raise ValueError("目标经重定向指向受限站点，已拒绝抓取")
            response = await client.get(current_url)
            if response.status_code not in _REDIRECT_STATUSES:
                break
            location = response.headers.get("location")
            response.close()
            if not location:
                raise ValueError("公开网页重定向缺少目标地址")
            if redirect_count >= _MAX_REDIRECTS:
                raise ValueError("公开网页重定向次数超过限制")
            next_url = urljoin(current_url, location)
            if not _is_public_http_url(next_url):
                raise ValueError("目标经重定向指向非公网地址，已拒绝抓取")
            current_url = next_url
        else:
            raise ValueError("公开网页重定向次数超过限制")

        response.raise_for_status()
        final_url = str(response.url)
        await _assert_public_destination(final_url)
        if _is_restricted(final_url):
            raise ValueError("目标经重定向指向受限站点，已拒绝抓取")
        html = response.text

    try:
        from bs4 import BeautifulSoup

        soup = BeautifulSoup(html, "html.parser")
        for tag in soup(["script", "style", "noscript", "iframe", "svg", "nav", "footer"]):
            tag.decompose()
        text = soup.get_text("\n")
    except Exception:
        text = re.sub(r"<[^>]+>", " ", html)
    text = re.sub(r"\n{3,}", "\n\n", re.sub(r"[ \t]{2,}", " ", text)).strip()
    return text[:max_chars]


async def web_search_preview(*, query: str, limit: int = 8) -> dict[str, Any]:
    """ops 调试入口：查看兜底链当前返回什么。"""
    results = await web_search(query, limit=limit)
    settings = get_settings()
    return {
        "query": query,
        "provider_setting": settings.search_provider,
        "configured_providers": [
            name
            for name, key in (
                ("bocha", settings.bocha_api_key),
                ("tavily", settings.tavily_api_key),
                ("serper", settings.serper_api_key),
            )
            if key
        ]
        + ["ddgs"],
        "results": results,
    }
