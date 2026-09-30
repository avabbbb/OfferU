from __future__ import annotations

import asyncio
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
from unittest.mock import patch

from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.models.models import AgentProviderHealth, Base
from app.services import agent_provider_health


def _row(**overrides):
    values = {
        "provider_id": "fixture",
        "available": False,
        "authenticated": None,
        "blocked": False,
        "version": "",
        "auth_mode": "unknown",
        "protocol_version": "",
        "capabilities_json": {},
        "last_error": "",
        "checked_at": None,
    }
    values.update(overrides)
    return SimpleNamespace(**values)


def test_provider_health_view_covers_all_release_statuses() -> None:
    cases = [
        (None, "unprobed"),
        (_row(available=True, authenticated=True), "ready"),
        (_row(authenticated=False), "auth_required"),
        (_row(blocked=True, last_error="login required"), "blocked"),
        (_row(last_error="network unavailable"), "unavailable"),
    ]

    for row, expected in cases:
        view = agent_provider_health.provider_health_view(row)
        assert view["status"] == expected
        assert view["provider_id"] == ("" if row is None else "fixture")
        assert "capabilities" in view
        assert "last_error" in view


def test_provider_health_view_redacts_stale_persisted_secret() -> None:
    view = agent_provider_health.provider_health_view(
        _row(last_error="request failed token=RELEASE_CANARY_SECRET")
    )

    assert view["last_error"] == "provider authentication failed"
    assert "RELEASE_CANARY_SECRET" not in str(view)


def test_provider_health_view_redacts_stale_persisted_pii() -> None:
    view = agent_provider_health.provider_health_view(
        _row(last_error="request failed for owner@example.com at +86 13812345678")
    )

    assert "owner@example.com" not in view["last_error"]
    assert "13812345678" not in view["last_error"]
    assert "[redacted email]" in view["last_error"]
    assert "[redacted phone]" in view["last_error"]


def test_provider_health_view_rejects_non_mapping_capabilities() -> None:
    view = agent_provider_health.provider_health_view(
        _row(available=True, capabilities_json=["secret-shaped-value"])
    )

    assert view["status"] == "ready"
    assert view["capabilities"] == {}


def test_list_provider_health_projects_known_and_persisted_states() -> None:
    async def flow(database_path: Path) -> dict:
        engine = create_async_engine(f"sqlite+aiosqlite:///{database_path.as_posix()}")
        session = async_sessionmaker(engine, expire_on_commit=False)
        try:
            async with engine.begin() as connection:
                await connection.run_sync(Base.metadata.create_all)
            async with session() as db:
                db.add_all(
                    [
                        AgentProviderHealth(
                            provider_id="pi",
                            available=False,
                            authenticated=False,
                            blocked=True,
                            last_error="token=RELEASE_CANARY_SECRET",
                        ),
                        AgentProviderHealth(
                            provider_id="codex",
                            available=False,
                            authenticated=None,
                            blocked=False,
                            last_error="network unavailable",
                        ),
                    ]
                )
                await db.commit()
            with patch.object(agent_provider_health, "async_session", session):
                return await agent_provider_health.list_provider_health()
        finally:
            await engine.dispose()

    with TemporaryDirectory() as directory:
        result = asyncio.run(flow(Path(directory) / "provider-health.db"))

    providers = {item["provider_id"]: item for item in result["providers"]}
    assert set(providers) >= {"pi", "replay", "codex", "deepseek-harness"}
    assert providers["pi"]["status"] == "blocked"
    assert providers["pi"]["last_error"] == "provider authentication failed"
    assert providers["codex"]["status"] == "unavailable"
    assert providers["replay"]["status"] == "ready"
    assert providers["deepseek-harness"]["status"] == "unprobed"


def test_connection_readback_survives_database_reopen_without_erasing_provider_failure() -> None:
    async def flow(path: Path) -> None:
        url = f"sqlite+aiosqlite:///{path.as_posix()}"
        engine = create_async_engine(url)
        sessions = async_sessionmaker(engine, expire_on_commit=False)
        async with engine.begin() as db:
            await db.run_sync(Base.metadata.create_all)
        with patch.object(agent_provider_health, "async_session", sessions):
            await agent_provider_health.record_provider_health(
                "codex", available=False, authenticated=False, blocked=True,
                error="401 unauthorized", capabilities={"conformance": {"cancel_verified": "ERROR"}},
            )
            await agent_provider_health.record_connection_check("codex", {
                "status": "ready", "integration_status": "VERIFIED", "skill_hash": "bound-skill",
                "checked_at": "2026-09-30T00:00:00+00:00", "at": 1000,
                "readback_evidence": {"thread_id": "thread", "turn_id": "turn", "operation": "get_agent_connection_nonce", "successful_calls": 1},
                "error": "token=RELEASE_CANARY_SECRET", "account": "must-not-persist",
            })
        await engine.dispose()
        reopened = create_async_engine(url)
        try:
            with patch.object(agent_provider_health, "async_session", async_sessionmaker(reopened, expire_on_commit=False)):
                view = await agent_provider_health.get_provider_health("codex")
                assert view["status"] == "blocked" and view["last_error"] == "401 unauthorized"
                saved = view["capabilities"]["connection_check"]
                assert saved["readback_evidence"]["turn_id"] == "turn"
                assert "at" not in saved and "account" not in saved
                assert "RELEASE_CANARY_SECRET" not in str(saved)
                refreshed = await agent_provider_health.record_provider_health(
                    "codex", available=False, blocked=True, capabilities={"stream": True},
                )
                assert refreshed["capabilities"]["connection_check"] == saved
                assert refreshed["status"] == "blocked"
        finally:
            await reopened.dispose()

    with TemporaryDirectory() as directory:
        asyncio.run(flow(Path(directory) / "readback.db"))
