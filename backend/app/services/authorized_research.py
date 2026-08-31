from __future__ import annotations

import asyncio
import hashlib
import importlib.metadata
import re
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Optional
from urllib.parse import urlsplit, urlunsplit

from sqlalchemy import delete, select

from app.database import async_session
from app.models.models import (
    AuthorizedResearchCapture,
    AuthorizedResearchSession,
    Job,
    JobResearchRun,
)
from app.services.job_research import (
    _DOSSIER_SCOPES,
    _SOURCE_CLASSES,
    _host,
    persist_authorized_research_result,
)
from app.services.security_redaction import safe_error_message


_ACTIVE_STATUSES = {"starting", "authenticating", "read_only"}
_FINAL_STATUSES = {"completed", "cancelled", "failed", "expired"}
_SAFE_METHODS = {"GET", "HEAD", "OPTIONS"}
_PLATFORMS = {
    "xiaohongshu": {
        "label": "小红书",
        "domains": ("xiaohongshu.com",),
        "source_classes": ("public_community", "public_interview", "public_resume_guidance"),
    },
    "maimai": {
        "label": "脉脉",
        "domains": ("maimai.cn",),
        "source_classes": ("public_community", "public_interview"),
    },
    "niuke": {
        "label": "牛客",
        "domains": ("nowcoder.com",),
        "source_classes": ("public_community", "public_interview", "public_resume_guidance"),
    },
    "boss": {
        "label": "BOSS直聘",
        "domains": ("zhipin.com", "bosszhipin.com"),
        "source_classes": ("public_community", "public_interview", "other_public"),
    },
}
_EMAIL_PATTERN = re.compile(r"(?<![\w.+-])[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}")
_PHONE_PATTERN = re.compile(r"(?<!\d)(?:\+?86[- ]?)?1[3-9]\d(?:[- ]?\d){8}(?!\d)")


@dataclass
class _LiveBrowser:
    playwright: Any
    browser: Any
    context: Any
    page: Any


_LIVE_BROWSERS: dict[str, _LiveBrowser] = {}
_EXPIRY_TASKS: dict[str, asyncio.Task[Any]] = {}


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _clean_text(
    value: Any,
    field: str,
    limit: int,
    *,
    required: bool = False,
) -> str:
    if value is None:
        text = ""
    elif isinstance(value, str):
        text = " ".join(value.split())
    else:
        raise ValueError(f"{field} 必须是字符串")
    if required and not text:
        raise ValueError(f"{field} 不能为空")
    if len(text) > limit:
        raise ValueError(f"{field} 超过最大长度 {limit}")
    return text


def _platform_url(platform: str, url: str) -> tuple[str, str]:
    clean_platform = str(platform or "").strip().lower()
    if clean_platform not in _PLATFORMS:
        raise ValueError(
            "platform 仅支持 xiaohongshu、maimai、niuke、boss"
        )
    if not str(url or "").strip().lower().startswith("https://"):
        raise ValueError("授权浏览会话只允许 HTTPS 页面")
    hostname = _host(str(url).strip())
    domains = _PLATFORMS[clean_platform]["domains"]
    if not any(hostname == domain or hostname.endswith(f".{domain}") for domain in domains):
        raise ValueError(f"URL 不属于 {clean_platform} 的允许域名")
    parsed = urlsplit(str(url).strip())
    safe_url = urlunsplit((parsed.scheme, parsed.netloc, parsed.path or "/", "", ""))
    return clean_platform, safe_url


def _redact_personal_identifiers(value: str) -> str:
    value = _EMAIL_PATTERN.sub("[email redacted]", value)
    return _PHONE_PATTERN.sub("[phone redacted]", value)


def _session_summary(
    session: AuthorizedResearchSession,
    capture_count: int = 0,
) -> dict[str, Any]:
    return {
        "session_id": session.session_id,
        "job_id": session.job_id,
        "base_run_id": session.base_run_id,
        "completed_run_id": session.completed_run_id,
        "platform": session.platform,
        "platform_label": _PLATFORMS.get(session.platform, {}).get(
            "label", session.platform
        ),
        "initial_url": session.initial_url,
        "status": session.status,
        "read_only_active": bool(session.read_only_active),
        "capture_count": capture_count,
        "expires_at": str(session.expires_at),
        "created_at": str(session.created_at),
        "updated_at": str(session.updated_at),
        "completed_at": str(session.completed_at) if session.completed_at else None,
        "error": session.error or "",
        "privacy": {
            "credentials_stored": False,
            "cookies_stored": False,
            "storage_state_stored": False,
            "screenshots_stored": False,
            "capture_policy": "user_selected_excerpt_only",
        },
    }


def _capture_summary(
    capture: AuthorizedResearchCapture,
    *,
    include_excerpt: bool,
) -> dict[str, Any]:
    payload = {
        "capture_id": capture.capture_id,
        "session_id": capture.session_id,
        "job_id": capture.job_id,
        "dossier_scope": capture.dossier_scope,
        "url": capture.url,
        "title": capture.title,
        "publisher": capture.publisher,
        "source_class": capture.source_class,
        "published_at": capture.published_at,
        "content_hash": capture.content_hash,
        "status": capture.status,
        "captured_at": str(capture.captured_at),
    }
    if include_excerpt:
        payload["excerpt"] = capture.excerpt
        payload["authorization"] = capture.authorization_json or {}
    return payload


async def _close_live_browser(session_id: str) -> None:
    live = _LIVE_BROWSERS.pop(session_id, None)
    if live is None:
        return
    try:
        await live.context.close()
    except Exception:
        pass
    try:
        await live.browser.close()
    except Exception:
        pass
    try:
        await live.playwright.stop()
    except Exception:
        pass


async def _expire_session(session_id: str, expires_at: datetime) -> None:
    current_expiry = expires_at
    if current_expiry.tzinfo is None:
        current_expiry = current_expiry.replace(tzinfo=timezone.utc)
    delay = max(0.0, (current_expiry - _utc_now()).total_seconds())
    try:
        await asyncio.sleep(delay)
        await _close_live_browser(session_id)
        async with async_session() as db:
            session = (
                await db.execute(
                    select(AuthorizedResearchSession).where(
                        AuthorizedResearchSession.session_id == session_id
                    )
                )
            ).scalar_one_or_none()
            if session is not None and session.status in _ACTIVE_STATUSES:
                session.status = "expired"
                session.read_only_active = False
                session.error = "临时浏览会话已到期；登录状态已销毁，已选摘录仍可供使用者审阅"
                await db.commit()
    except asyncio.CancelledError:
        raise
    finally:
        if _EXPIRY_TASKS.get(session_id) is asyncio.current_task():
            _EXPIRY_TASKS.pop(session_id, None)


def _schedule_expiry(session_id: str, expires_at: datetime) -> None:
    previous = _EXPIRY_TASKS.pop(session_id, None)
    if previous is not None:
        previous.cancel()
    _EXPIRY_TASKS[session_id] = asyncio.create_task(
        _expire_session(session_id, expires_at),
        name=f"offeru-authorized-research-expiry-{session_id}",
    )


def _cancel_expiry(session_id: str) -> None:
    task = _EXPIRY_TASKS.pop(session_id, None)
    if task is not None:
        task.cancel()


async def recover_authorized_research_sessions() -> None:
    """应用重启后显式标记临时浏览器已丢失；不尝试恢复登录状态。"""

    async with async_session() as db:
        sessions = (
            await db.execute(
                select(AuthorizedResearchSession).where(
                    AuthorizedResearchSession.status.in_(_ACTIVE_STATUSES)
                )
            )
        ).scalars().all()
        for session in sessions:
            session.status = "interrupted"
            session.read_only_active = False
            session.error = "应用已重启；临时登录状态未保存，请重新开始授权浏览会话"
        if sessions:
            await db.commit()


async def stop_authorized_research_service() -> None:
    expiry_tasks = list(_EXPIRY_TASKS.values())
    for task in expiry_tasks:
        task.cancel()
    _EXPIRY_TASKS.clear()
    if expiry_tasks:
        await asyncio.gather(*expiry_tasks, return_exceptions=True)
    for session_id in list(_LIVE_BROWSERS):
        await _close_live_browser(session_id)
    await recover_authorized_research_sessions()


async def start_authorized_research_session(
    job_id: int,
    platform: str,
    initial_url: str,
    user_authorized: bool,
    base_run_id: Optional[str] = None,
    expires_minutes: int = 30,
) -> dict[str, Any]:
    if user_authorized is not True:
        raise ValueError("必须由使用者明确授权本次本地浏览会话")
    clean_platform, clean_url = _platform_url(platform, initial_url)
    safe_expiry = max(5, min(int(expires_minutes), 120))
    async with async_session() as db:
        job = (
            await db.execute(select(Job).where(Job.id == int(job_id)))
        ).scalar_one_or_none()
        if job is None:
            raise ValueError(f"job #{job_id} 不存在")
        active = (
            await db.execute(
                select(AuthorizedResearchSession).where(
                    AuthorizedResearchSession.job_id == job.id,
                    AuthorizedResearchSession.platform == clean_platform,
                    AuthorizedResearchSession.status.in_(_ACTIVE_STATUSES),
                )
            )
        ).scalars().first()
        if active is not None:
            return {
                **_session_summary(active),
                "accepted": False,
                "message": "该岗位与平台已有活动中的授权浏览会话",
            }
        base_run: Optional[JobResearchRun] = None
        if base_run_id:
            base_run = (
                await db.execute(
                    select(JobResearchRun).where(
                        JobResearchRun.run_id == str(base_run_id).strip(),
                        JobResearchRun.job_id == job.id,
                        JobResearchRun.status == "completed",
                        JobResearchRun.review_status.in_(("candidate", "accepted")),
                    )
                )
            ).scalar_one_or_none()
            if base_run is None:
                raise ValueError("base_run_id 必须是同一岗位已完成的调研运行")
        else:
            base_run = (
                await db.execute(
                    select(JobResearchRun)
                    .where(
                        JobResearchRun.job_id == job.id,
                        JobResearchRun.status == "completed",
                        JobResearchRun.review_status.in_(("candidate", "accepted")),
                    )
                    .order_by(JobResearchRun.completed_at.desc())
                )
            ).scalars().first()
        session = AuthorizedResearchSession(
            session_id=f"authorized_session_{uuid.uuid4().hex}",
            job_id=job.id,
            base_run_id=base_run.run_id if base_run else None,
            platform=clean_platform,
            initial_url=clean_url,
            status="starting",
            read_only_active=False,
            expires_at=_utc_now() + timedelta(minutes=safe_expiry),
        )
        db.add(session)
        await db.commit()

    try:
        from playwright.async_api import async_playwright

        playwright = await async_playwright().start()
        browser = await playwright.chromium.launch(headless=False)
        context = await browser.new_context(
            accept_downloads=False,
            service_workers="block",
        )
        page = await context.new_page()
        live = _LiveBrowser(
            playwright=playwright,
            browser=browser,
            context=context,
            page=page,
        )
        _LIVE_BROWSERS[session.session_id] = live
        await page.goto(clean_url, wait_until="domcontentloaded", timeout=45_000)
        _schedule_expiry(session.session_id, session.expires_at)
        async with async_session() as db:
            stored = (
                await db.execute(
                    select(AuthorizedResearchSession).where(
                        AuthorizedResearchSession.session_id == session.session_id
                    )
                )
            ).scalar_one()
            stored.status = "authenticating"
            await db.commit()
        return {
            **_session_summary(stored),
            "accepted": True,
            "next_step": (
                "请在弹出的临时浏览器中手动登录并打开目标页面；准备采集前调用 "
                "activate_authorized_research_read_only。"
            ),
        }
    except Exception as exc:
        await _close_live_browser(session.session_id)
        _cancel_expiry(session.session_id)
        async with async_session() as db:
            stored = (
                await db.execute(
                    select(AuthorizedResearchSession).where(
                        AuthorizedResearchSession.session_id == session.session_id
                    )
                )
            ).scalar_one_or_none()
            if stored is not None:
                stored.status = "failed"
                stored.error = safe_error_message(exc)
                stored.completed_at = _utc_now()
                await db.commit()
        raise


async def activate_authorized_research_read_only(
    session_id: str,
    user_confirmed_login_complete: bool,
) -> dict[str, Any]:
    if user_confirmed_login_complete is not True:
        raise ValueError("必须由使用者确认已完成手动登录")
    clean_session_id = _clean_text(
        session_id, "session_id", 64, required=True
    )
    live = _LIVE_BROWSERS.get(clean_session_id)
    if live is None:
        raise ValueError("临时浏览器不存在或已关闭；登录状态不会被恢复")
    snapshot = await get_authorized_research_session(clean_session_id)
    if snapshot.get("error"):
        raise ValueError("授权浏览会话不存在")
    if snapshot["status"] not in {"authenticating", "read_only"}:
        raise ValueError(f"当前会话状态不能进入只读采集: {snapshot['status']}")

    async def guard(route: Any, request: Any) -> None:
        if request.method.upper() in _SAFE_METHODS and request.resource_type != "websocket":
            await route.continue_()
        else:
            await route.abort("blockedbyclient")

    pages = [page for page in live.context.pages if not page.is_closed()]
    if not pages:
        raise ValueError("临时浏览器没有可切换到只读模式的页面")
    target_url = pages[-1].url
    _platform_url(snapshot["platform"], target_url)
    await live.context.route("**/*", guard)
    if hasattr(live.context, "route_web_socket"):
        async def block_socket(socket: Any) -> None:
            await socket.close()

        await live.context.route_web_socket("**/*", block_socket)
    for page in pages:
        await page.close(run_before_unload=False)
    live.page = await live.context.new_page()
    await live.page.goto(
        target_url,
        wait_until="domcontentloaded",
        timeout=45_000,
    )

    async with async_session() as db:
        session = (
            await db.execute(
                select(AuthorizedResearchSession).where(
                    AuthorizedResearchSession.session_id == clean_session_id
                )
            )
        ).scalar_one_or_none()
        if session is None:
            raise ValueError("授权浏览会话不存在")
        if session.status not in {"authenticating", "read_only"}:
            raise ValueError(f"当前会话状态不能进入只读采集: {session.status}")
        session.status = "read_only"
        session.read_only_active = True
        session.error = ""
        await db.commit()
        count = (
            await db.execute(
                select(AuthorizedResearchCapture).where(
                    AuthorizedResearchCapture.session_id == clean_session_id
                )
            )
        ).scalars().all()
    return {
        **_session_summary(session, len(count)),
        "next_step": "在页面中选中相关文字，再调用 capture_authorized_research_page。",
        "blocked_actions": [
            "POST/PUT/PATCH/DELETE 网络请求",
            "WebSocket",
            "下载",
            "后台 service worker",
        ],
    }


async def capture_authorized_research_page(
    session_id: str,
    dossier_scope: str,
    source_class: str,
    user_confirmed_capture: bool,
    publisher: str = "",
    published_at: Optional[str] = None,
    selected_text: str = "",
) -> dict[str, Any]:
    if user_confirmed_capture is not True:
        raise ValueError("必须由使用者逐页确认采集")
    clean_session_id = _clean_text(
        session_id, "session_id", 64, required=True
    )
    clean_scope = _clean_text(
        dossier_scope, "dossier_scope", 20, required=True
    )
    clean_source_class = _clean_text(
        source_class, "source_class", 40, required=True
    )
    if clean_scope not in _DOSSIER_SCOPES:
        raise ValueError("dossier_scope 必须是 company 或 role")
    if clean_source_class not in _SOURCE_CLASSES:
        raise ValueError("source_class 不在允许枚举中")
    live = _LIVE_BROWSERS.get(clean_session_id)
    if live is None:
        raise ValueError("临时浏览器不存在或已关闭")

    async with async_session() as db:
        session = (
            await db.execute(
                select(AuthorizedResearchSession).where(
                    AuthorizedResearchSession.session_id == clean_session_id
                )
            )
        ).scalar_one_or_none()
        if session is None or session.status != "read_only" or not session.read_only_active:
            raise ValueError("会话尚未进入只读采集状态")
        if clean_source_class not in _PLATFORMS[session.platform]["source_classes"]:
            raise ValueError("该登录态平台不能被标记为官方事实来源")

    pages = [page for page in live.context.pages if not page.is_closed()]
    if not pages:
        raise ValueError("临时浏览器没有可采集页面")
    page = pages[-1]
    clean_platform, page_url = _platform_url(session.platform, page.url)
    if clean_platform != session.platform:
        raise ValueError("当前页面不属于已授权平台")
    body_text = _clean_text(
        await page.locator("body").inner_text(timeout=10_000),
        "page.body",
        500_000,
        required=True,
    )
    chosen = _clean_text(selected_text, "selected_text", 10_000)
    if chosen:
        if chosen not in body_text:
            raise ValueError("selected_text 必须来自当前页面可见文字")
    else:
        chosen = _clean_text(
            await page.evaluate("() => window.getSelection()?.toString() || ''"),
            "browser_selection",
            10_000,
            required=True,
        )
        if chosen not in body_text:
            raise ValueError("浏览器选中文字与当前页面不一致")
    excerpt = _redact_personal_identifiers(chosen)[:1500].strip()
    if not excerpt:
        raise ValueError("选中内容经最小化处理后为空")
    title = _clean_text(await page.title(), "title", 500) or clean_platform
    clean_publisher = _clean_text(publisher, "publisher", 300) or _PLATFORMS[
        clean_platform
    ]["label"]
    clean_published_at = (
        _clean_text(published_at, "published_at", 80) or None
    )
    digest = hashlib.sha256(
        f"{page_url}\n{clean_scope}\n{clean_source_class}\n{excerpt}".encode("utf-8")
    ).hexdigest()

    async with async_session() as db:
        duplicate = (
            await db.execute(
                select(AuthorizedResearchCapture).where(
                    AuthorizedResearchCapture.session_id == clean_session_id,
                    AuthorizedResearchCapture.content_hash == digest,
                )
            )
        ).scalar_one_or_none()
        if duplicate is not None:
            return {
                **_capture_summary(duplicate, include_excerpt=True),
                "accepted": False,
                "message": "相同页面摘录已采集",
            }
        capture = AuthorizedResearchCapture(
            capture_id=f"research_capture_{uuid.uuid4().hex}",
            session_id=clean_session_id,
            job_id=session.job_id,
            dossier_scope=clean_scope,
            url=page_url,
            title=title,
            publisher=clean_publisher,
            source_class=clean_source_class,
            published_at=clean_published_at,
            excerpt=excerpt,
            content_hash=digest,
            authorization_json={
                "user_authorized_session": True,
                "user_confirmed_capture": True,
                "read_only_enforced": True,
                "login_state_persisted": False,
                "storage": "selected_excerpt_only",
            },
        )
        db.add(capture)
        await db.commit()
    return {
        **_capture_summary(capture, include_excerpt=True),
        "accepted": True,
    }


async def list_authorized_research_sessions(
    job_id: Optional[int] = None,
    status: Optional[str] = None,
    limit: int = 20,
) -> dict[str, Any]:
    safe_limit = max(1, min(int(limit), 100))
    query = select(AuthorizedResearchSession)
    if job_id is not None:
        query = query.where(AuthorizedResearchSession.job_id == int(job_id))
    if status:
        clean_status = _clean_text(status, "status", 24, required=True)
        if clean_status not in _ACTIVE_STATUSES | _FINAL_STATUSES | {"interrupted"}:
            raise ValueError("status 不在允许枚举中")
        query = query.where(AuthorizedResearchSession.status == clean_status)
    async with async_session() as db:
        sessions = (
            await db.execute(
                query.order_by(AuthorizedResearchSession.created_at.desc()).limit(
                    safe_limit
                )
            )
        ).scalars().all()
        counts: dict[str, int] = {}
        for session in sessions:
            captures = (
                await db.execute(
                    select(AuthorizedResearchCapture.capture_id).where(
                        AuthorizedResearchCapture.session_id == session.session_id
                    )
                )
            ).scalars().all()
            counts[session.session_id] = len(captures)
    return {
        "total": len(sessions),
        "items": [
            _session_summary(session, counts[session.session_id])
            for session in sessions
        ],
    }


async def get_authorized_research_session(
    session_id: str,
    include_excerpts: bool = False,
) -> dict[str, Any]:
    clean_session_id = _clean_text(
        session_id, "session_id", 64, required=True
    )
    async with async_session() as db:
        session = (
            await db.execute(
                select(AuthorizedResearchSession).where(
                    AuthorizedResearchSession.session_id == clean_session_id
                )
            )
        ).scalar_one_or_none()
        if session is None:
            return {"error": f"Authorized research session {clean_session_id} not found"}
        captures = (
            await db.execute(
                select(AuthorizedResearchCapture)
                .where(AuthorizedResearchCapture.session_id == clean_session_id)
                .order_by(AuthorizedResearchCapture.captured_at.asc())
            )
        ).scalars().all()
    return {
        **_session_summary(session, len(captures)),
        "captures": [
            _capture_summary(item, include_excerpt=bool(include_excerpts))
            for item in captures
        ],
    }


def _base_payload(run: Optional[JobResearchRun]) -> dict[str, Any]:
    if run is None:
        return {"sources": [], "findings": [], "gaps": []}
    result = run.result_json if isinstance(run.result_json, dict) else {}
    return {
        "sources": list(result.get("sources") or []),
        "findings": list(result.get("findings") or []),
        "gaps": list(result.get("gaps") or []),
    }


def _combined_payload(
    *,
    base: dict[str, Any],
    captures: list[AuthorizedResearchCapture],
    findings: list[dict[str, Any]],
    gaps: list[str],
) -> dict[str, Any]:
    sources: list[dict[str, Any]] = []
    merged_findings: list[dict[str, Any]] = []
    base_ref_map: dict[str, str] = {}
    for item in base["sources"]:
        new_ref = f"S{len(sources) + 1}"
        base_ref_map[str(item["source_ref"])] = new_ref
        sources.append(
            {
                "source_ref": new_ref,
                "dossier_scope": item["dossier_scope"],
                "url": item["url"],
                "title": item["title"],
                "publisher": item["publisher"],
                "source_class": item["source_class"],
                "published_at": item.get("published_at"),
                "excerpt": item["excerpt"],
            }
        )
    for item in base["findings"]:
        merged_findings.append(
            {
                "dossier_scope": item["dossier_scope"],
                "finding_type": item["finding_type"],
                "statement": item["statement"],
                "details": item["details"],
                "source_refs": [
                    base_ref_map[str(ref)] for ref in item["source_refs"]
                ],
            }
        )

    capture_map = {item.capture_id: item for item in captures}
    requested_capture_ids: list[str] = []
    for finding in findings:
        if not isinstance(finding, dict) or set(finding) != {
            "dossier_scope",
            "finding_type",
            "statement",
            "details",
            "capture_ids",
            "base_source_refs",
        }:
            raise ValueError("登录态 finding 字段必须严格匹配约定 schema")
        capture_ids = finding.get("capture_ids")
        if not isinstance(capture_ids, list) or not capture_ids:
            raise ValueError("登录态 finding 至少引用一个 capture_id")
        for capture_id in capture_ids:
            clean_id = _clean_text(
                capture_id, "capture_ids", 64, required=True
            )
            if clean_id not in capture_map:
                raise ValueError(f"finding 引用了未知 capture_id: {clean_id}")
            if clean_id not in requested_capture_ids:
                requested_capture_ids.append(clean_id)
        base_source_refs = finding.get("base_source_refs")
        if not isinstance(base_source_refs, list):
            raise ValueError("base_source_refs 必须是数组")
        for source_ref in base_source_refs:
            clean_ref = _clean_text(
                source_ref, "base_source_refs", 80, required=True
            )
            if clean_ref not in base_ref_map:
                raise ValueError(f"finding 引用了未知基础来源: {clean_ref}")
    capture_ref_map: dict[str, str] = {}
    for capture_id in requested_capture_ids:
        item = capture_map[capture_id]
        new_ref = f"S{len(sources) + 1}"
        capture_ref_map[capture_id] = new_ref
        sources.append(
            {
                "source_ref": new_ref,
                "dossier_scope": item.dossier_scope,
                "url": item.url,
                "title": item.title,
                "publisher": item.publisher,
                "source_class": item.source_class,
                "published_at": item.published_at,
                "excerpt": item.excerpt,
            }
        )
    for finding in findings:
        merged_findings.append(
            {
                "dossier_scope": finding["dossier_scope"],
                "finding_type": finding["finding_type"],
                "statement": finding["statement"],
                "details": finding["details"],
                "source_refs": [
                    base_ref_map[str(source_ref)]
                    for source_ref in finding["base_source_refs"]
                ]
                + [
                    capture_ref_map[str(capture_id)]
                    for capture_id in finding["capture_ids"]
                ],
            }
        )
    if len(sources) > 40:
        raise ValueError("合并后的证据超过 40 条，请减少本次引用")
    if len(merged_findings) > 80:
        raise ValueError("合并后的结论超过 80 条，请拆分调研")
    clean_gaps = [
        _clean_text(item, "gaps", 800, required=True)
        for item in [*base["gaps"], *gaps]
    ]
    return {
        "sources": sources,
        "findings": merged_findings,
        "gaps": clean_gaps[:20],
    }


async def complete_authorized_research_session(
    session_id: str,
    findings: list[dict[str, Any]],
    user_confirmed_findings: bool,
    gaps: Optional[list[str]] = None,
) -> dict[str, Any]:
    if user_confirmed_findings is not True:
        raise ValueError("必须由使用者确认登录态证据与待写入结论")
    if not isinstance(findings, list) or not findings:
        raise ValueError("findings 必须是非空数组")
    if gaps is not None and not isinstance(gaps, list):
        raise ValueError("gaps 必须是字符串数组")
    clean_session_id = _clean_text(
        session_id, "session_id", 64, required=True
    )
    async with async_session() as db:
        session = (
            await db.execute(
                select(AuthorizedResearchSession).where(
                    AuthorizedResearchSession.session_id == clean_session_id
                )
            )
        ).scalar_one_or_none()
        if session is None:
            raise ValueError("授权浏览会话不存在")
        if session.status == "completed" and session.completed_run_id:
            return {
                **_session_summary(session),
                "accepted": False,
                "message": "该会话已完成，未重复创建调研运行",
            }
        if session.status not in {"read_only", "interrupted", "expired"}:
            raise ValueError(f"当前会话状态不能完成调研: {session.status}")
        captures = (
            await db.execute(
                select(AuthorizedResearchCapture).where(
                    AuthorizedResearchCapture.session_id == clean_session_id,
                    AuthorizedResearchCapture.status == "staged",
                )
            )
        ).scalars().all()
        if not captures:
            raise ValueError("会话没有可用的最小证据摘录")
        base_run = None
        if session.base_run_id:
            base_run = (
                await db.execute(
                    select(JobResearchRun).where(
                        JobResearchRun.run_id == session.base_run_id,
                        JobResearchRun.job_id == session.job_id,
                        JobResearchRun.status == "completed",
                        JobResearchRun.review_status.in_(("candidate", "accepted")),
                    )
                )
            ).scalar_one_or_none()
            if base_run is None:
                raise ValueError("基础公开网调研已失效，不能合并")
        payload = _combined_payload(
            base=_base_payload(base_run),
            captures=captures,
            findings=findings,
            gaps=gaps or [],
        )

    runtime_version = ""
    try:
        runtime_version = importlib.metadata.version("playwright")
    except importlib.metadata.PackageNotFoundError:
        pass
    completed = await persist_authorized_research_result(
        job_id=session.job_id,
        result_payload=payload,
        trace={
            "authorized_session_id": clean_session_id,
            "base_run_id": session.base_run_id,
            "platform": session.platform,
            "capture_ids": sorted(
                {
                    str(capture_id)
                    for finding in findings
                    for capture_id in finding["capture_ids"]
                }
            ),
            "authorization": {
                "user_authorized_login": True,
                "user_confirmed_findings": True,
                "read_only_capture": True,
                "credentials_persisted": False,
                "storage_state_persisted": False,
            },
        },
        runtime_version=runtime_version,
        run_id=f"job_research_auth_{clean_session_id.rsplit('_', 1)[-1]}",
    )
    async with async_session() as db:
        stored = (
            await db.execute(
                select(AuthorizedResearchSession).where(
                    AuthorizedResearchSession.session_id == clean_session_id
                )
            )
        ).scalar_one()
        stored.status = "completed"
        stored.read_only_active = False
        stored.completed_run_id = completed["run_id"]
        stored.completed_at = _utc_now()
        stored.error = ""
        promoted_ids = {
            str(capture_id)
            for finding in findings
            for capture_id in finding["capture_ids"]
        }
        staged = (
            await db.execute(
                select(AuthorizedResearchCapture).where(
                    AuthorizedResearchCapture.session_id == clean_session_id
                )
            )
        ).scalars().all()
        for capture in staged:
            capture.status = (
                "promoted" if capture.capture_id in promoted_ids else "discarded"
            )
        await db.commit()
    await _close_live_browser(clean_session_id)
    _cancel_expiry(clean_session_id)
    return {
        **_session_summary(stored, len(staged)),
        "accepted": True,
        "research_run": {
            "run_id": completed["run_id"],
            "status": completed["status"],
            "source_count": completed["source_count"],
            "finding_count": completed["finding_count"],
            "report_available": True,
        },
    }


async def cancel_authorized_research_session(
    session_id: str,
    reason: str,
) -> dict[str, Any]:
    clean_session_id = _clean_text(
        session_id, "session_id", 64, required=True
    )
    clean_reason = _clean_text(reason, "reason", 500, required=True)
    await _close_live_browser(clean_session_id)
    _cancel_expiry(clean_session_id)
    async with async_session() as db:
        session = (
            await db.execute(
                select(AuthorizedResearchSession).where(
                    AuthorizedResearchSession.session_id == clean_session_id
                )
            )
        ).scalar_one_or_none()
        if session is None:
            return {"error": f"Authorized research session {clean_session_id} not found"}
        if session.status == "completed":
            raise ValueError("已完成会话不能取消；调研结果需通过来源失效流程处理")
        await db.execute(
            delete(AuthorizedResearchCapture).where(
                AuthorizedResearchCapture.session_id == clean_session_id
            )
        )
        session.status = "cancelled"
        session.read_only_active = False
        session.error = clean_reason
        session.completed_at = _utc_now()
        await db.commit()
    return {
        **_session_summary(session, 0),
        "scrubbed_capture_count": True,
    }
