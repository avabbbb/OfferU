"""Provider health snapshots for the OfferU Agent Runtime.

Authentication and executable availability belong to the executor boundary,
not to Career Runtime.  This module deliberately stores only safe diagnostic
metadata; credentials, tokens and raw provider output never enter the model.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from sqlalchemy import select

from app.database import async_session
from app.models.models import AgentProviderHealth


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _clean_error(value: Any) -> str:
    """Return a bounded, credential-safe provider error string."""

    text = str(value or "").strip()
    if not text:
        return ""
    lowered = text.casefold()
    if any(token in lowered for token in ("api_key", "apikey", "bearer", "token")):
        return "provider authentication failed"
    return text[:1000]


def provider_health_view(row: AgentProviderHealth | None) -> dict[str, Any]:
    if row is None:
        return {
            "provider_id": "",
            "available": False,
            "authenticated": None,
            "blocked": False,
            "status": "unprobed",
            "version": "",
            "auth_mode": "unknown",
            "protocol_version": "",
            "capabilities": {},
            "last_error": "",
            "checked_at": None,
        }
    if row.blocked:
        status = "blocked"
    elif row.authenticated is False:
        status = "auth_required"
    elif row.available:
        status = "ready"
    else:
        status = "unavailable"
    return {
        "provider_id": row.provider_id,
        "available": bool(row.available),
        "authenticated": row.authenticated,
        "blocked": bool(row.blocked),
        "status": status,
        "version": row.version or "",
        "auth_mode": row.auth_mode or "unknown",
        "protocol_version": row.protocol_version or "",
        "capabilities": row.capabilities_json if isinstance(row.capabilities_json, dict) else {},
        "last_error": row.last_error or "",
        "checked_at": row.checked_at.isoformat() if row.checked_at else None,
    }


async def record_provider_health(
    provider_id: str,
    *,
    available: bool,
    authenticated: bool | None = None,
    blocked: bool = False,
    version: str = "",
    auth_mode: str = "unknown",
    protocol_version: str = "",
    capabilities: dict[str, Any] | None = None,
    error: Any = "",
) -> dict[str, Any]:
    clean_id = str(provider_id or "").strip()[:80]
    if not clean_id:
        raise ValueError("provider_id 不能为空")
    now = _utc_now()
    async with async_session() as db:
        row = await db.get(AgentProviderHealth, clean_id)
        if row is None:
            row = AgentProviderHealth(provider_id=clean_id)
            db.add(row)
        row.available = bool(available)
        row.authenticated = authenticated
        row.blocked = bool(blocked)
        row.version = str(version or "")[:160]
        row.auth_mode = str(auth_mode or "unknown")[:60]
        row.protocol_version = str(protocol_version or "")[:80]
        row.capabilities_json = capabilities if isinstance(capabilities, dict) else {}
        row.last_error = _clean_error(error)
        row.checked_at = now
        await db.commit()
        await db.refresh(row)
        return provider_health_view(row)


async def get_provider_health(provider_id: str) -> dict[str, Any]:
    clean_id = str(provider_id or "").strip()[:80]
    if not clean_id:
        raise ValueError("provider_id 不能为空")
    async with async_session() as db:
        row = await db.get(AgentProviderHealth, clean_id)
        view = provider_health_view(row)
    if not view["provider_id"]:
        view["provider_id"] = clean_id
    return view


async def list_provider_health() -> dict[str, Any]:
    async with async_session() as db:
        rows = (
            await db.execute(
                select(AgentProviderHealth).order_by(AgentProviderHealth.provider_id.asc())
            )
        ).scalars().all()
    return {"providers": [provider_health_view(row) for row in rows]}


__all__ = [
    "get_provider_health",
    "list_provider_health",
    "provider_health_view",
    "record_provider_health",
]
