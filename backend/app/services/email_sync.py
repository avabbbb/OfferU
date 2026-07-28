from __future__ import annotations

import asyncio
import base64
import email as email_lib
import hashlib
import imaplib
import re
import secrets
import ssl
from datetime import datetime, timedelta, timezone
from email.header import decode_header
from email.utils import parsedate_to_datetime
from typing import Any, Optional
from urllib.parse import urlencode

import httpx
from sqlalchemy import select

from app.config import get_settings
from app.database import async_session
from app.models.models import (
    ApplicationProgressCandidate,
    EmailAccount,
    EmailSyncRun,
    ExternalProgressSignal,
)
from app.services.application_progress import ingest_application_signal
from app.services.credential_store import delete_secret, load_secret, store_secret


GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token"
GMAIL_API_URL = "https://gmail.googleapis.com/gmail/v1"
GMAIL_SCOPES = ("https://www.googleapis.com/auth/gmail.readonly",)
ACCOUNT_STATUSES = frozenset({"active", "revoked", "error"})
SYNC_STATUSES = frozenset({"pending", "running", "completed", "failed"})
IMAP_PRESETS = {
    "qq": {"host": "imap.qq.com", "port": 993},
    "163": {"host": "imap.163.com", "port": 993},
    "126": {"host": "imap.126.com", "port": 993},
    "gmail": {"host": "imap.gmail.com", "port": 993},
    "outlook": {"host": "outlook.office365.com", "port": 993},
    "foxmail": {"host": "imap.qq.com", "port": 993},
}
EMAIL_RELEVANCE_TERMS = (
    "面试",
    "笔试",
    "测评",
    "网申",
    "简历已收到",
    "申请已提交",
    "录用",
    "offer",
    "interview",
    "assessment",
    "application received",
    "application submitted",
    "未通过",
    "遗憾",
    "not moving forward",
)
MAX_MESSAGES_PER_SYNC = 500
MAX_GMAIL_MESSAGES_PER_SYNC = 5_000
MAX_TRANSIENT_BODY_CHARS = 200_000
_ACCOUNT_LOCKS: dict[tuple[int, str], asyncio.Lock] = {}
_SYNC_SERVICE_TASK: Optional[asyncio.Task[None]] = None


class GmailHistoryExpired(RuntimeError):
    pass


def _now() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _clean_text(value: Any, field: str, *, limit: int, required: bool = False) -> str:
    text = str(value or "").strip()
    if required and not text:
        raise ValueError(f"{field} 不能为空")
    if len(text) > limit:
        raise ValueError(f"{field} 最长 {limit} 个字符")
    return text


def _account_lock(account_id: str) -> asyncio.Lock:
    loop_key = id(asyncio.get_running_loop())
    return _ACCOUNT_LOCKS.setdefault((loop_key, account_id), asyncio.Lock())


def _credential_reference() -> str:
    return f"email:{secrets.token_urlsafe(32)}"


def _account_key(provider: str, email_address: str, host: str = "") -> str:
    identity = f"{provider}:{email_address.casefold()}:{host.casefold()}"
    return hashlib.sha256(identity.encode("utf-8")).hexdigest()


def _signal_account_ref(account_key: str) -> str:
    return hashlib.sha256(f"email-account:{account_key}".encode("utf-8")).hexdigest()


def _bounded_identifier(value: Any, *, fallback: str = "") -> str:
    text = str(value or fallback).strip()
    if len(text) <= 500:
        return text
    return f"sha256:{hashlib.sha256(text.encode('utf-8')).hexdigest()}"


def _account_payload(account: EmailAccount) -> dict[str, Any]:
    return {
        "account_id": account.account_id,
        "provider": account.provider,
        "email_address": account.email_address,
        "host": account.host,
        "port": account.port,
        "auth_type": account.auth_type,
        "scopes": account.scopes_json or [],
        "status": account.status,
        "sync_enabled": bool(account.sync_enabled),
        "cursor_type": (account.sync_cursor_json or {}).get("type"),
        "last_synced_at": (
            account.last_synced_at.isoformat() if account.last_synced_at else None
        ),
        "last_error": account.last_error or "",
        "created_at": str(account.created_at),
        "updated_at": str(account.updated_at),
    }


def _run_payload(run: EmailSyncRun) -> dict[str, Any]:
    return {
        "run_id": run.run_id,
        "provider": run.provider,
        "status": run.status,
        "attempts": run.attempts,
        "result": run.result_json or {},
        "trace": run.trace_json or {},
        "error": run.error or "",
        "created_at": str(run.created_at),
        "started_at": run.started_at.isoformat() if run.started_at else None,
        "completed_at": run.completed_at.isoformat() if run.completed_at else None,
    }


def _resolve_imap_host(
    *,
    host: str,
    port: int,
    provider: str,
    email_address: str,
) -> tuple[str, int]:
    clean_host = host.strip()
    clean_port = int(port or 993)
    provider_key = provider.strip().lower()
    if not clean_host and provider_key in IMAP_PRESETS:
        preset = IMAP_PRESETS[provider_key]
        return str(preset["host"]), int(preset["port"])
    if not clean_host and "@" in email_address:
        domain = email_address.rsplit("@", 1)[-1].lower()
        domain_provider = {
            "qq.com": "qq",
            "foxmail.com": "qq",
            "vip.qq.com": "qq",
            "163.com": "163",
            "126.com": "126",
            "gmail.com": "gmail",
            "outlook.com": "outlook",
            "hotmail.com": "outlook",
        }.get(domain)
        if domain_provider:
            preset = IMAP_PRESETS[domain_provider]
            return str(preset["host"]), int(preset["port"])
    if not clean_host:
        raise ValueError("无法确定 IMAP 服务器地址")
    if not 1 <= clean_port <= 65535:
        raise ValueError("IMAP port 无效")
    return clean_host, clean_port


def _imap_status_number(conn: imaplib.IMAP4_SSL, key: str) -> int:
    response = conn.response(key)
    values = response[1] if response else None
    if values:
        for value in values:
            match = re.search(rb"\d+", value if isinstance(value, bytes) else b"")
            if match:
                return int(match.group())
    status, rows = conn.status("INBOX", f"({key})")
    if status == "OK" and rows:
        match = re.search(fr"{key}\s+(\d+)".encode("ascii"), rows[0] or b"")
        if match:
            return int(match.group(1))
    return 0


def _probe_imap(host: str, port: int, user: str, password: str) -> dict[str, int]:
    conn: Optional[imaplib.IMAP4_SSL] = None
    try:
        conn = imaplib.IMAP4_SSL(
            host,
            port,
            ssl_context=ssl.create_default_context(),
            timeout=20,
        )
        conn.login(user, password)
        status, _ = conn.select("INBOX", readonly=True)
        if status != "OK":
            raise RuntimeError("无法以只读方式打开 INBOX")
        uidvalidity = _imap_status_number(conn, "UIDVALIDITY")
        if not uidvalidity:
            raise RuntimeError("IMAP 服务器未返回 UIDVALIDITY")
        return {
            "uidvalidity": uidvalidity,
            "uidnext": _imap_status_number(conn, "UIDNEXT"),
        }
    except imaplib.IMAP4.error as exc:
        raise RuntimeError("IMAP 登录失败，请检查邮箱地址和应用授权码") from exc
    except RuntimeError:
        raise
    except Exception as exc:
        raise RuntimeError("IMAP 连接失败，请检查服务器地址和网络") from exc
    finally:
        if conn is not None:
            try:
                conn.logout()
            except Exception:
                pass


async def connect_imap_account(
    *,
    user: str,
    password: str,
    provider: str = "",
    host: str = "",
    port: int = 993,
) -> dict[str, Any]:
    clean_user = _clean_text(user, "user", limit=320, required=True)
    clean_password = _clean_text(password, "password", limit=4000, required=True)
    clean_host, clean_port = _resolve_imap_host(
        host=host,
        port=port,
        provider=provider,
        email_address=clean_user,
    )
    probe = await asyncio.to_thread(
        _probe_imap,
        clean_host,
        clean_port,
        clean_user,
        clean_password,
    )
    key = _account_key("imap", clean_user, clean_host)
    async with async_session() as db:
        account = (
            await db.execute(select(EmailAccount).where(EmailAccount.account_key == key))
        ).scalar_one_or_none()
        credential_ref = (
            account.credential_ref
            if account is not None and account.credential_ref
            else _credential_reference()
        )

    await store_secret(
        credential_ref,
        {"user": clean_user, "password": clean_password},
    )
    async with async_session() as db:
        account = (
            await db.execute(select(EmailAccount).where(EmailAccount.account_key == key))
        ).scalar_one_or_none()
        if account is None:
            account = EmailAccount(
                account_id=f"email-{secrets.token_hex(16)}",
                account_key=key,
                signal_account_ref=_signal_account_ref(key),
                provider="imap",
                email_address=clean_user,
                host=clean_host,
                port=clean_port,
                auth_type="app_password",
                credential_ref=credential_ref,
                scopes_json=["imap:read"],
                sync_cursor_json={
                    "type": "imap_uid",
                    "uidvalidity": probe["uidvalidity"],
                    "last_uid": 0,
                },
                status="active",
                sync_enabled=True,
            )
            db.add(account)
        else:
            previous = account.sync_cursor_json or {}
            same_uidvalidity = (
                int(previous.get("uidvalidity") or 0) == int(probe["uidvalidity"] or 0)
            )
            account.email_address = clean_user
            account.host = clean_host
            account.port = clean_port
            account.auth_type = "app_password"
            account.credential_ref = credential_ref
            account.scopes_json = ["imap:read"]
            account.sync_cursor_json = (
                previous
                if same_uidvalidity
                else {
                    "type": "imap_uid",
                    "uidvalidity": probe["uidvalidity"],
                    "last_uid": 0,
                }
            )
            account.status = "active"
            account.sync_enabled = True
            account.last_error = ""
            account.revoked_at = None
        await db.commit()
        await db.refresh(account)
        return _account_payload(account)


def _oauth_state_ref(state: str) -> str:
    digest = hashlib.sha256(state.encode("utf-8")).hexdigest()
    return f"email-oauth-state:{digest}"


async def begin_gmail_oauth(redirect_uri: str) -> dict[str, Any]:
    settings = get_settings()
    if not settings.gmail_client_id:
        raise ValueError("GMAIL_CLIENT_ID 未配置")
    clean_redirect = _clean_text(
        redirect_uri,
        "redirect_uri",
        limit=2000,
        required=True,
    )
    state = secrets.token_urlsafe(32)
    verifier = secrets.token_urlsafe(64)
    challenge = base64.urlsafe_b64encode(
        hashlib.sha256(verifier.encode("ascii")).digest()
    ).decode("ascii").rstrip("=")
    await store_secret(
        _oauth_state_ref(state),
        {
            "code_verifier": verifier,
            "redirect_uri": clean_redirect,
            "created_at": _now().isoformat(),
        },
    )
    params = {
        "client_id": settings.gmail_client_id,
        "redirect_uri": clean_redirect,
        "response_type": "code",
        "scope": " ".join(GMAIL_SCOPES),
        "access_type": "offline",
        "prompt": "consent",
        "state": state,
        "code_challenge": challenge,
        "code_challenge_method": "S256",
    }
    return {"auth_url": f"{GOOGLE_AUTH_URL}?{urlencode(params)}"}


async def complete_gmail_oauth(*, code: str, state: str) -> dict[str, Any]:
    clean_code = _clean_text(code, "code", limit=4000, required=True)
    clean_state = _clean_text(state, "state", limit=500, required=True)
    state_ref = _oauth_state_ref(clean_state)
    state_secret = await load_secret(state_ref)
    await delete_secret(state_ref)
    try:
        created_at = datetime.fromisoformat(str(state_secret.get("created_at") or ""))
    except ValueError as exc:
        raise ValueError("OAuth state 无效") from exc
    if _now() - created_at > timedelta(minutes=10):
        raise ValueError("OAuth state 已过期，请重新授权")

    settings = get_settings()
    data = {
        "code": clean_code,
        "client_id": settings.gmail_client_id,
        "redirect_uri": state_secret.get("redirect_uri"),
        "grant_type": "authorization_code",
        "code_verifier": state_secret.get("code_verifier"),
    }
    if settings.gmail_client_secret:
        data["client_secret"] = settings.gmail_client_secret
    async with httpx.AsyncClient(timeout=30.0) as client:
        response = await client.post(GOOGLE_TOKEN_URL, data=data)
        if response.status_code != 200:
            raise RuntimeError("Gmail OAuth token 交换失败")
        token = response.json()
        access_token = str(token.get("access_token") or "")
        if not access_token:
            raise RuntimeError("Gmail OAuth 未返回 access token")
        profile_response = await client.get(
            f"{GMAIL_API_URL}/users/me/profile",
            headers={"Authorization": f"Bearer {access_token}"},
        )
        if profile_response.status_code != 200:
            raise RuntimeError("无法读取 Gmail 账号元数据")
        profile = profile_response.json()

    email_address = _clean_text(
        profile.get("emailAddress"),
        "gmail email",
        limit=320,
        required=True,
    )
    key = _account_key("gmail", email_address)
    async with async_session() as db:
        account = (
            await db.execute(select(EmailAccount).where(EmailAccount.account_key == key))
        ).scalar_one_or_none()
        credential_ref = (
            account.credential_ref
            if account is not None and account.credential_ref
            else _credential_reference()
        )
    previous_secret: dict[str, Any] = {}
    if account is not None and credential_ref:
        try:
            previous_secret = await load_secret(credential_ref)
        except RuntimeError:
            previous_secret = {}
    expires_at = _now() + timedelta(seconds=max(60, int(token.get("expires_in") or 3600)))
    await store_secret(
        credential_ref,
        {
            "access_token": access_token,
            "refresh_token": token.get("refresh_token")
            or previous_secret.get("refresh_token")
            or "",
            "expires_at": expires_at.isoformat(),
            "token_type": token.get("token_type") or "Bearer",
        },
    )

    async with async_session() as db:
        account = (
            await db.execute(select(EmailAccount).where(EmailAccount.account_key == key))
        ).scalar_one_or_none()
        if account is None:
            account = EmailAccount(
                account_id=f"email-{secrets.token_hex(16)}",
                account_key=key,
                signal_account_ref=_signal_account_ref(key),
                provider="gmail",
                email_address=email_address,
                host="gmail.googleapis.com",
                port=443,
                auth_type="oauth2_pkce",
                scopes_json=list(GMAIL_SCOPES),
                credential_ref=credential_ref,
                sync_cursor_json={"type": "gmail_history"},
                status="active",
                sync_enabled=True,
            )
            db.add(account)
        else:
            account.email_address = email_address
            account.auth_type = "oauth2_pkce"
            account.scopes_json = list(GMAIL_SCOPES)
            account.credential_ref = credential_ref
            account.status = "active"
            account.sync_enabled = True
            account.last_error = ""
            account.revoked_at = None
        await db.commit()
        await db.refresh(account)
        return _account_payload(account)


async def list_email_accounts(
    *,
    status: str = "active",
    limit: int = 50,
) -> dict[str, Any]:
    clean_status = str(status or "active").strip().lower()
    if clean_status not in ACCOUNT_STATUSES | {"all"}:
        raise ValueError("status 必须是 active、revoked、error 或 all")
    safe_limit = max(1, min(int(limit), 200))
    query = select(EmailAccount).order_by(EmailAccount.updated_at.desc()).limit(safe_limit)
    if clean_status != "all":
        query = query.where(EmailAccount.status == clean_status)
    async with async_session() as db:
        rows = (await db.execute(query)).scalars().all()
    return {"total": len(rows), "items": [_account_payload(item) for item in rows]}


async def email_connection_status() -> dict[str, Any]:
    accounts = await list_email_accounts(status="active", limit=200)
    items = accounts["items"]
    gmail = [item for item in items if item["provider"] == "gmail"]
    imap = [item for item in items if item["provider"] == "imap"]
    first_imap = imap[0] if imap else {}
    return {
        "connected": bool(items),
        "gmail_connected": bool(gmail),
        "has_refresh": bool(gmail),
        "imap_connected": bool(imap),
        "imap_host": first_imap.get("host", ""),
        "imap_user": first_imap.get("email_address", ""),
        "accounts": items,
    }


def _decode_header_value(raw: str) -> str:
    if not raw:
        return ""
    result: list[str] = []
    for value, charset in decode_header(raw):
        if isinstance(value, bytes):
            result.append(value.decode(charset or "utf-8", errors="replace"))
        else:
            result.append(value)
    return " ".join(result)


def _received_at(raw: str) -> Optional[str]:
    if not raw:
        return None
    try:
        value = parsedate_to_datetime(raw)
    except (TypeError, ValueError, OverflowError):
        return None
    return value.isoformat()


def _extract_email_body(message: Any) -> str:
    if message.is_multipart():
        for part in message.walk():
            if part.get_content_type() != "text/plain":
                continue
            payload = part.get_payload(decode=True)
            if payload:
                return payload.decode(
                    part.get_content_charset() or "utf-8",
                    errors="replace",
                )
        for part in message.walk():
            if part.get_content_type() != "text/html":
                continue
            payload = part.get_payload(decode=True)
            if payload:
                html = payload.decode(
                    part.get_content_charset() or "utf-8",
                    errors="replace",
                )
                return re.sub(r"<[^>]+>", " ", html)
        return ""
    payload = message.get_payload(decode=True)
    if not payload:
        return ""
    return payload.decode(message.get_content_charset() or "utf-8", errors="replace")


def _is_relevant(message: dict[str, Any]) -> bool:
    text = "\n".join(
        [
            str(message.get("subject") or ""),
            str(message.get("from") or ""),
            str(message.get("body") or "")[:20_000],
        ]
    ).casefold()
    return any(term.casefold() in text for term in EMAIL_RELEVANCE_TERMS)


def _fetch_imap_delta_blocking(
    *,
    host: str,
    port: int,
    user: str,
    password: str,
    cursor: dict[str, Any],
) -> tuple[list[dict[str, Any]], dict[str, Any], dict[str, Any]]:
    conn: Optional[imaplib.IMAP4_SSL] = None
    try:
        conn = imaplib.IMAP4_SSL(
            host,
            port,
            ssl_context=ssl.create_default_context(),
            timeout=30,
        )
        conn.login(user, password)
        status, _ = conn.select("INBOX", readonly=True)
        if status != "OK":
            raise RuntimeError("无法以只读方式打开 INBOX")
        uidvalidity = _imap_status_number(conn, "UIDVALIDITY")
        if not uidvalidity:
            raise RuntimeError("IMAP 服务器未返回 UIDVALIDITY")
        previous_uidvalidity = int(cursor.get("uidvalidity") or 0)
        last_uid = int(cursor.get("last_uid") or 0)
        recovered = bool(
            previous_uidvalidity
            and uidvalidity
            and previous_uidvalidity != uidvalidity
        )
        if recovered:
            last_uid = 0

        if last_uid:
            search_criteria = f"UID {last_uid + 1}:*"
        else:
            since = (_now() - timedelta(days=30)).strftime("%d-%b-%Y")
            search_criteria = f'(SINCE "{since}")'
        search_status, search_rows = conn.uid("search", None, search_criteria)
        if search_status != "OK":
            raise RuntimeError("IMAP UID 增量搜索失败")
        uid_values = [
            int(value)
            for value in ((search_rows[0] or b"").split() if search_rows else [])
            if value.isdigit() and int(value) > last_uid
        ]
        selected_uids = sorted(uid_values)[:MAX_MESSAGES_PER_SYNC]
        messages: list[dict[str, Any]] = []
        high_uid = last_uid
        for uid in selected_uids:
            fetch_status, rows = conn.uid("fetch", str(uid), "(BODY.PEEK[])")
            if fetch_status != "OK":
                raise RuntimeError("IMAP UID 消息读取失败")
            raw_bytes = next(
                (
                    item[1]
                    for item in rows or []
                    if isinstance(item, tuple)
                    and len(item) > 1
                    and isinstance(item[1], bytes)
                ),
                None,
            )
            if raw_bytes is None:
                raise RuntimeError("IMAP 返回了无效消息")
            message = email_lib.message_from_bytes(raw_bytes)
            body = _extract_email_body(message)[:MAX_TRANSIENT_BODY_CHARS]
            item = {
                "provider_id": str(uid),
                "message_id": _decode_header_value(message.get("Message-ID", ""))
                or f"imap:{uidvalidity}:{uid}",
                "thread_id": _decode_header_value(
                    message.get("References", "") or message.get("In-Reply-To", "")
                ),
                "received_at": _received_at(message.get("Date", "")),
                "subject": _decode_header_value(message.get("Subject", "")),
                "from": _decode_header_value(message.get("From", "")),
                "body": body,
            }
            if _is_relevant(item):
                messages.append(item)
            high_uid = max(high_uid, uid)

        if not selected_uids and not last_uid:
            uidnext = _imap_status_number(conn, "UIDNEXT")
            high_uid = max(0, uidnext - 1)
        next_cursor = {
            "type": "imap_uid",
            "uidvalidity": uidvalidity,
            "last_uid": high_uid,
        }
        return (
            messages,
            next_cursor,
            {
                "mode": "uid_incremental" if last_uid else "uid_backfill_30d",
                "uidvalidity_recovered": recovered,
                "fetched_uid_count": len(selected_uids),
                "relevant_message_count": len(messages),
                "more_available": len(uid_values) > len(selected_uids),
            },
        )
    except imaplib.IMAP4.error as exc:
        raise RuntimeError("IMAP 认证或 UID 同步失败") from exc
    finally:
        if conn is not None:
            try:
                conn.logout()
            except Exception:
                pass


async def _gmail_access_token(account: EmailAccount) -> str:
    secret = await load_secret(account.credential_ref)
    access_token = str(secret.get("access_token") or "")
    try:
        expires_at = datetime.fromisoformat(str(secret.get("expires_at") or ""))
    except ValueError:
        expires_at = datetime.min
    if access_token and _now() < expires_at - timedelta(seconds=60):
        return access_token
    refresh_token = str(secret.get("refresh_token") or "")
    if not refresh_token:
        raise RuntimeError("Gmail refresh token 不存在，请重新授权")
    settings = get_settings()
    data = {
        "client_id": settings.gmail_client_id,
        "refresh_token": refresh_token,
        "grant_type": "refresh_token",
    }
    if settings.gmail_client_secret:
        data["client_secret"] = settings.gmail_client_secret
    async with httpx.AsyncClient(timeout=30.0) as client:
        response = await client.post(GOOGLE_TOKEN_URL, data=data)
    if response.status_code != 200:
        raise RuntimeError("Gmail token 刷新失败，请重新授权")
    payload = response.json()
    access_token = str(payload.get("access_token") or "")
    if not access_token:
        raise RuntimeError("Gmail token 刷新未返回 access token")
    secret["access_token"] = access_token
    secret["expires_at"] = (
        _now() + timedelta(seconds=max(60, int(payload.get("expires_in") or 3600)))
    ).isoformat()
    await store_secret(account.credential_ref, secret)
    return access_token


def _decode_gmail_part(data: str) -> str:
    padded = data + "=" * (-len(data) % 4)
    return base64.urlsafe_b64decode(padded.encode("ascii")).decode(
        "utf-8",
        errors="replace",
    )


def _extract_gmail_body(payload: dict[str, Any]) -> str:
    mime_type = str(payload.get("mimeType") or "")
    data = (payload.get("body") or {}).get("data")
    if mime_type == "text/plain" and data:
        return _decode_gmail_part(str(data))
    for part in payload.get("parts") or []:
        if isinstance(part, dict):
            text = _extract_gmail_body(part)
            if text:
                return text
    if mime_type == "text/html" and data:
        return re.sub(r"<[^>]+>", " ", _decode_gmail_part(str(data)))
    return ""


async def _gmail_json(
    client: httpx.AsyncClient,
    url: str,
    *,
    headers: dict[str, str],
    params: Optional[dict[str, Any]] = None,
    history_request: bool = False,
) -> dict[str, Any]:
    response = await client.get(url, headers=headers, params=params)
    if history_request and response.status_code == 404:
        raise GmailHistoryExpired("Gmail historyId 已过期")
    if response.status_code != 200:
        raise RuntimeError("Gmail API 增量读取失败")
    payload = response.json()
    if not isinstance(payload, dict):
        raise RuntimeError("Gmail API 返回格式无效")
    return payload


async def _gmail_message(
    client: httpx.AsyncClient,
    *,
    message_id: str,
    headers: dict[str, str],
) -> Optional[dict[str, Any]]:
    payload = await _gmail_json(
        client,
        f"{GMAIL_API_URL}/users/me/messages/{message_id}",
        headers=headers,
        params={"format": "full"},
    )
    raw_headers = payload.get("payload", {}).get("headers", [])
    message_headers = {
        str(item.get("name") or "").casefold(): str(item.get("value") or "")
        for item in raw_headers
        if isinstance(item, dict)
    }
    body = _extract_gmail_body(payload.get("payload") or {})[
        :MAX_TRANSIENT_BODY_CHARS
    ]
    internal_date = str(payload.get("internalDate") or "")
    item = {
        "provider_id": message_id,
        "message_id": message_headers.get("message-id") or message_id,
        "thread_id": str(payload.get("threadId") or ""),
        "received_at": (
            datetime.fromtimestamp(
                int(internal_date) / 1000,
                tz=timezone.utc,
            ).isoformat()
            if internal_date.isdigit()
            else None
        ),
        "subject": message_headers.get("subject", ""),
        "from": message_headers.get("from", ""),
        "body": body,
    }
    return item if _is_relevant(item) else None


async def _gmail_full_message_ids(
    client: httpx.AsyncClient,
    *,
    headers: dict[str, str],
) -> list[str]:
    ids: list[str] = []
    page_token = ""
    query = (
        "subject:(面试 OR 笔试 OR 测评 OR 网申 OR interview OR offer "
        "OR assessment OR 遗憾) newer_than:30d"
    )
    while True:
        params: dict[str, Any] = {
            "q": query,
            "maxResults": 500,
        }
        if page_token:
            params["pageToken"] = page_token
        payload = await _gmail_json(
            client,
            f"{GMAIL_API_URL}/users/me/messages",
            headers=headers,
            params=params,
        )
        ids.extend(
            str(item.get("id"))
            for item in payload.get("messages") or []
            if isinstance(item, dict) and item.get("id")
        )
        if len(ids) > MAX_GMAIL_MESSAGES_PER_SYNC:
            raise RuntimeError("Gmail 首次回补消息过多，请缩小账号中的求职邮件范围")
        page_token = str(payload.get("nextPageToken") or "")
        if not page_token:
            break
    return ids


async def _gmail_history_message_ids(
    client: httpx.AsyncClient,
    *,
    headers: dict[str, str],
    history_id: str,
) -> tuple[list[str], str]:
    ids: set[str] = set()
    page_token = ""
    latest_history_id = history_id
    while True:
        params: dict[str, Any] = {
            "startHistoryId": history_id,
            "historyTypes": "messageAdded",
            "maxResults": 500,
        }
        if page_token:
            params["pageToken"] = page_token
        payload = await _gmail_json(
            client,
            f"{GMAIL_API_URL}/users/me/history",
            headers=headers,
            params=params,
            history_request=True,
        )
        latest_history_id = str(payload.get("historyId") or latest_history_id)
        for history in payload.get("history") or []:
            if not isinstance(history, dict):
                continue
            for added in history.get("messagesAdded") or []:
                message = added.get("message") if isinstance(added, dict) else None
                if isinstance(message, dict) and message.get("id"):
                    ids.add(str(message["id"]))
        if len(ids) > MAX_GMAIL_MESSAGES_PER_SYNC:
            raise RuntimeError("Gmail 增量历史过大，未推进游标，请重试或重新回补")
        page_token = str(payload.get("nextPageToken") or "")
        if not page_token:
            break
    return sorted(ids), latest_history_id


async def _fetch_gmail_delta(
    *,
    token: str,
    cursor: dict[str, Any],
) -> tuple[list[dict[str, Any]], dict[str, Any], dict[str, Any]]:
    headers = {"Authorization": f"Bearer {token}"}
    history_id = str(cursor.get("history_id") or "")
    recovered = False
    async with httpx.AsyncClient(timeout=30.0) as client:
        if history_id:
            try:
                ids, next_history_id = await _gmail_history_message_ids(
                    client,
                    headers=headers,
                    history_id=history_id,
                )
                mode = "history_incremental"
            except GmailHistoryExpired:
                recovered = True
                history_id = ""
        if not history_id:
            profile = await _gmail_json(
                client,
                f"{GMAIL_API_URL}/users/me/profile",
                headers=headers,
            )
            next_history_id = str(profile.get("historyId") or "")
            if not next_history_id:
                raise RuntimeError("Gmail profile 未返回 historyId")
            ids = await _gmail_full_message_ids(client, headers=headers)
            mode = "full_backfill_30d"

        messages: list[dict[str, Any]] = []
        for message_id in ids:
            item = await _gmail_message(
                client,
                message_id=message_id,
                headers=headers,
            )
            if item is not None:
                messages.append(item)
    return (
        messages,
        {"type": "gmail_history", "history_id": next_history_id},
        {
            "mode": mode,
            "history_expired_recovered": recovered,
            "fetched_message_count": len(ids),
            "relevant_message_count": len(messages),
        },
    )


async def _create_sync_run(account: EmailAccount) -> EmailSyncRun:
    async with async_session() as db:
        active = (
            await db.execute(
                select(EmailSyncRun)
                .where(EmailSyncRun.email_account_id == account.id)
                .where(EmailSyncRun.status.in_(("pending", "running")))
            )
        ).scalars().first()
        if active is not None:
            raise ValueError("该邮箱已有同步任务正在运行")
        run = EmailSyncRun(
            run_id=f"email-sync-{secrets.token_hex(16)}",
            email_account_id=account.id,
            provider=account.provider,
            status="pending",
            cursor_before_json=dict(account.sync_cursor_json or {}),
        )
        db.add(run)
        await db.commit()
        await db.refresh(run)
        return run


async def sync_email_account(account_id: str) -> dict[str, Any]:
    clean_account_id = _clean_text(
        account_id,
        "account_id",
        limit=64,
        required=True,
    )
    async with _account_lock(clean_account_id):
        async with async_session() as db:
            account = (
                await db.execute(
                    select(EmailAccount).where(
                        EmailAccount.account_id == clean_account_id
                    )
                )
            ).scalar_one_or_none()
        if account is None:
            raise ValueError(f"邮箱账号 {clean_account_id} 不存在")
        if account.status != "active" or not account.sync_enabled:
            raise ValueError("邮箱账号未启用同步")
        run = await _create_sync_run(account)
        async with async_session() as db:
            stored_run = (
                await db.execute(
                    select(EmailSyncRun).where(EmailSyncRun.run_id == run.run_id)
                )
            ).scalar_one()
            stored_run.status = "running"
            stored_run.attempts += 1
            stored_run.started_at = _now()
            await db.commit()

        try:
            cursor = dict(account.sync_cursor_json or {})
            if account.provider == "gmail":
                token = await _gmail_access_token(account)
                messages, next_cursor, trace = await _fetch_gmail_delta(
                    token=token,
                    cursor=cursor,
                )
            elif account.provider == "imap":
                secret = await load_secret(account.credential_ref)
                messages, next_cursor, trace = await asyncio.to_thread(
                    _fetch_imap_delta_blocking,
                    host=account.host,
                    port=account.port,
                    user=str(secret.get("user") or ""),
                    password=str(secret.get("password") or ""),
                    cursor=cursor,
                )
            else:
                raise ValueError(f"不支持的邮箱 provider: {account.provider}")

            synced = 0
            duplicates = 0
            candidate_ids: list[str] = []
            for message in messages:
                body = str(message.get("body") or message.get("subject") or "")[
                    :MAX_TRANSIENT_BODY_CHARS
                ]
                result = await ingest_application_signal(
                    channel="email",
                    account_ref=account.signal_account_ref,
                    external_message_id=_bounded_identifier(
                        message.get("message_id"),
                        fallback=str(message.get("provider_id") or ""),
                    ),
                    external_thread_id=_bounded_identifier(
                        message.get("thread_id"),
                    ),
                    sender=str(message.get("from") or "")[:500],
                    received_at=message.get("received_at"),
                    subject=str(message.get("subject") or "")[:500],
                    body=body,
                )
                if result.get("duplicate"):
                    duplicates += 1
                else:
                    synced += 1
                if result.get("candidate_id"):
                    candidate_ids.append(str(result["candidate_id"]))

            result_payload = {
                "account_id": account.account_id,
                "source": account.provider,
                "synced": synced,
                "duplicates": duplicates,
                "failed": 0,
                "total_found": len(messages),
                "calendar_created": 0,
                "candidate_ids": candidate_ids,
                "requires_review": synced,
            }
            async with async_session() as db:
                stored_account = (
                    await db.execute(
                        select(EmailAccount).where(EmailAccount.id == account.id)
                    )
                ).scalar_one()
                stored_run = (
                    await db.execute(
                        select(EmailSyncRun).where(EmailSyncRun.run_id == run.run_id)
                    )
                ).scalar_one()
                if stored_account.status != "active" or not stored_account.sync_enabled:
                    raise RuntimeError("邮箱账号在同步期间被撤销")
                stored_account.sync_cursor_json = next_cursor
                stored_account.last_synced_at = _now()
                stored_account.last_error = ""
                stored_run.cursor_after_json = next_cursor
                stored_run.result_json = result_payload
                stored_run.trace_json = {
                    **trace,
                    "full_body_stored": False,
                    "credential_exposed": False,
                }
                stored_run.status = "completed"
                stored_run.completed_at = _now()
                stored_run.error = ""
                await db.commit()
            return {**_run_payload(stored_run), **result_payload}
        except Exception as exc:
            safe_error = (
                "邮箱增量同步失败；请检查授权、网络和 provider 游标后重试"
            )
            async with async_session() as db:
                stored_account = (
                    await db.execute(
                        select(EmailAccount).where(EmailAccount.id == account.id)
                    )
                ).scalar_one_or_none()
                stored_run = (
                    await db.execute(
                        select(EmailSyncRun).where(EmailSyncRun.run_id == run.run_id)
                    )
                ).scalar_one_or_none()
                if stored_account is not None and stored_account.status == "active":
                    stored_account.last_error = safe_error
                if stored_run is not None:
                    stored_run.status = "failed"
                    stored_run.error = safe_error
                    stored_run.trace_json = {
                        "error_type": type(exc).__name__,
                        "full_body_stored": False,
                        "credential_exposed": False,
                    }
                    stored_run.completed_at = _now()
                await db.commit()
            raise RuntimeError(safe_error) from exc


async def sync_email_notifications(
    account_id: Optional[str] = None,
) -> dict[str, Any]:
    if account_id:
        return await sync_email_account(account_id)
    async with async_session() as db:
        accounts = (
            await db.execute(
                select(EmailAccount)
                .where(EmailAccount.status == "active")
                .where(EmailAccount.sync_enabled == True)
                .order_by(EmailAccount.created_at.asc())
            )
        ).scalars().all()
    results: list[dict[str, Any]] = []
    failed = 0
    for account in accounts:
        try:
            results.append(await sync_email_account(account.account_id))
        except Exception:
            failed += 1
    return {
        "account_count": len(accounts),
        "completed": len(results),
        "failed_accounts": failed,
        "synced": sum(int(item.get("synced") or 0) for item in results),
        "duplicates": sum(int(item.get("duplicates") or 0) for item in results),
        "total_found": sum(int(item.get("total_found") or 0) for item in results),
        "calendar_created": 0,
        "requires_review": sum(
            int(item.get("requires_review") or 0) for item in results
        ),
        "runs": results,
    }


async def list_email_sync_runs(
    *,
    account_id: Optional[str] = None,
    status: Optional[str] = None,
    limit: int = 50,
) -> dict[str, Any]:
    safe_limit = max(1, min(int(limit), 500))
    query = (
        select(EmailSyncRun)
        .join(EmailAccount, EmailAccount.id == EmailSyncRun.email_account_id)
        .order_by(EmailSyncRun.created_at.desc())
        .limit(safe_limit)
    )
    if account_id:
        query = query.where(EmailAccount.account_id == str(account_id))
    if status:
        clean_status = str(status).strip().lower()
        if clean_status not in SYNC_STATUSES:
            raise ValueError("无效的邮箱同步状态")
        query = query.where(EmailSyncRun.status == clean_status)
    async with async_session() as db:
        rows = (await db.execute(query)).scalars().all()
    return {"total": len(rows), "items": [_run_payload(item) for item in rows]}


async def get_email_sync_run(run_id: str) -> dict[str, Any]:
    clean_run_id = _clean_text(run_id, "run_id", limit=64, required=True)
    async with async_session() as db:
        run = (
            await db.execute(
                select(EmailSyncRun).where(EmailSyncRun.run_id == clean_run_id)
            )
        ).scalar_one_or_none()
    if run is None:
        raise ValueError(f"邮箱同步运行 {clean_run_id} 不存在")
    return _run_payload(run)


async def revoke_email_account(
    *,
    account_id: str,
    reason: str,
) -> dict[str, Any]:
    clean_account_id = _clean_text(
        account_id,
        "account_id",
        limit=64,
        required=True,
    )
    _clean_text(reason, "reason", limit=1000, required=True)
    async with _account_lock(clean_account_id):
        async with async_session() as db:
            account = (
                await db.execute(
                    select(EmailAccount).where(
                        EmailAccount.account_id == clean_account_id
                    )
                )
            ).scalar_one_or_none()
        if account is None:
            raise ValueError(f"邮箱账号 {clean_account_id} 不存在")
        duplicate = account.status == "revoked"
        if account.credential_ref:
            await delete_secret(account.credential_ref)
        async with async_session() as db:
            stored = (
                await db.execute(
                    select(EmailAccount).where(EmailAccount.id == account.id)
                )
            ).scalar_one()
            signals = (
                await db.execute(
                    select(ExternalProgressSignal).where(
                        ExternalProgressSignal.account_ref
                        == stored.signal_account_ref
                    )
                )
            ).scalars().all()
            signal_ids = [item.id for item in signals]
            candidates: list[ApplicationProgressCandidate] = []
            if signal_ids:
                candidates = (
                    await db.execute(
                        select(ApplicationProgressCandidate).where(
                            ApplicationProgressCandidate.signal_id.in_(signal_ids)
                        )
                    )
                ).scalars().all()
            invalidated_candidates = 0
            for signal in signals:
                signal.status = "invalidated"
                signal.snippet = ""
                signal.classification_json = {}
            for candidate in candidates:
                if candidate.status == "pending":
                    candidate.status = "invalidated"
                    candidate.match_candidates_json = []
                    candidate.reasons_json = []
                    invalidated_candidates += 1
            stored.credential_ref = ""
            stored.sync_cursor_json = {}
            stored.sync_enabled = False
            stored.status = "revoked"
            stored.last_error = ""
            stored.revoked_at = stored.revoked_at or _now()
            await db.commit()
        return {
            "account_id": clean_account_id,
            "revoked": True,
            "duplicate": duplicate,
            "invalidated_signal_count": len(signals),
            "invalidated_candidate_count": invalidated_candidates,
        }


async def recover_interrupted_email_sync_runs() -> int:
    async with async_session() as db:
        rows = (
            await db.execute(
                select(EmailSyncRun).where(
                    EmailSyncRun.status.in_(("pending", "running"))
                )
            )
        ).scalars().all()
        for run in rows:
            run.status = "failed"
            run.error = "OfferU 上次退出时同步中断，可安全重试"
            run.trace_json = {
                "recovered_after_restart": True,
                "full_body_stored": False,
                "credential_exposed": False,
            }
            run.completed_at = _now()
        await db.commit()
        return len(rows)


async def _email_sync_loop(interval_seconds: int) -> None:
    while True:
        try:
            await sync_email_notifications()
        except asyncio.CancelledError:
            raise
        except Exception:
            pass
        await asyncio.sleep(interval_seconds)


async def start_email_sync_service() -> None:
    global _SYNC_SERVICE_TASK
    await recover_interrupted_email_sync_runs()
    if _SYNC_SERVICE_TASK is not None and not _SYNC_SERVICE_TASK.done():
        return
    interval = max(
        60,
        min(int(get_settings().email_sync_interval_seconds or 300), 86_400),
    )
    _SYNC_SERVICE_TASK = asyncio.create_task(_email_sync_loop(interval))


async def stop_email_sync_service() -> None:
    global _SYNC_SERVICE_TASK
    task = _SYNC_SERVICE_TASK
    _SYNC_SERVICE_TASK = None
    if task is None or task.done():
        return
    task.cancel()
    try:
        await task
    except asyncio.CancelledError:
        pass
