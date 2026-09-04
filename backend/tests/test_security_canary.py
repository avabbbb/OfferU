from __future__ import annotations

import asyncio
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import AsyncMock, patch

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

BACKEND_DIR = Path(__file__).resolve().parents[1]
import sys

if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from app.database import Base  # noqa: E402
from app.models.models import (  # noqa: E402
    AgentRunEvent,
    AgentRunRecord,
    OperationAuditLog,
    Profile,
)
from app.ops import execute_operation  # noqa: E402
from app.services import (  # noqa: E402
    agent_run_state,
    application_events,
    application_followups,
    career_artifacts,
    data_export,
    diagnostics,
    harness_history,
    harness_memory,
    pre_application_decisions,
    resume_drafts,
)
from app.services.agent_files import atomic_write_json  # noqa: E402
from app.services.agent_run_state import create_agent_run  # noqa: E402
from app.services.artifact_workspace import ArtifactWorkspaceManager  # noqa: E402


RELEASE_CANARY = "OFFERU_RELEASE_CANARY_SECRET_20260831_7f5c"


class SecurityCanaryTests(unittest.TestCase):
    def test_isolated_json_artifact_matrix_redacts_canary(self) -> None:
        canary = "OFFERU_ARTIFACT_CANARY_SECRET_20260831_9ab3"

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            atomic_write_json(
                root / "generic.json",
                {
                    "content": f"api_token={canary}",
                    "owner": "owner@example.com",
                    "nested": {"Authorization": f"Bearer {canary}"},
                },
            )
            career_artifacts.CareerArtifactStore(root / "artifacts").save(
                artifact_type="cover_letter",
                title=f"token={canary}",
                content_markdown=f"正文 api_key={canary}",
                metadata={"client_secret": canary},
            )
            application_events.ApplicationEventStore(root / "application-events").record(
                application_type="application",
                application_id=1,
                event_type="field_updated",
                source="security-canary",
                value=f"secret={canary}",
                metadata={"refresh_token": canary},
            )
            application_followups.FollowUpStore(root / "follow-ups").record(
                application_type="application",
                application_id=1,
                channel="email",
                contact=f"token={canary}",
                notes=f"password={canary}",
            )
            pre_application_decisions.PreApplicationDecisionStore(
                root / "pre-application"
            ).create({"job_id": 1, "rationale": f"credential={canary}"})

            workspace = ArtifactWorkspaceManager("run_artifact_canary", root=root / "runs")
            workspace.create(owner="security-canary")
            workspace.write_artifact(
                "inbox/result.json",
                {"result": f"Bearer {canary}", "note": "owner@example.com"},
            )

            harness_history.save_conversation_messages(
                conversation_id="canary",
                messages=[{"role": "user", "content": f"cookie={canary}"}],
                path=root / "history.json",
            )
            harness_memory.save_agent_memory(
                {"facts": [f"session_token={canary}"]},
                path=root / "memory.json",
            )
            with patch.object(resume_drafts, "DRAFT_DIR", root / "resume-drafts"):
                resume_drafts.save_resume_draft(
                    resume_id=1,
                    profile_id=1,
                    jd_text=f"authorization={canary}",
                    summary="保留职业内容",
                    sections=[{"content": f"api_token={canary}"}],
                    fact_gates={"status": f"token={canary}"},
                )

            persisted = "\n".join(
                path.read_text(encoding="utf-8")
                for path in root.rglob("*")
                if path.is_file() and not path.name.endswith(".tmp")
            )

        self.assertNotIn(canary, persisted)
        self.assertIn("owner@example.com", persisted)

    def test_isolated_canary_does_not_enter_durable_run_audit_or_export(self) -> None:
        async def run(database_path: Path) -> dict[str, object]:
            engine = create_async_engine(
                f"sqlite+aiosqlite:///{database_path.as_posix()}"
            )
            session = async_sessionmaker(
                engine, class_=AsyncSession, expire_on_commit=False
            )
            try:
                async with engine.begin() as connection:
                    await connection.run_sync(Base.metadata.create_all)
                async with session() as db:
                    db.add(
                        Profile(
                            name="Canary Fixture",
                            email="canary@example.com",
                            base_info_json={
                                "api_token": RELEASE_CANARY,
                                "note": f"Bearer {RELEASE_CANARY}",
                            },
                        )
                    )
                    await db.commit()

                with patch.object(agent_run_state, "async_session", session), patch.object(
                    data_export, "async_session", session
                ), patch.object(
                    data_export,
                    "career_artifact_store",
                    type("EmptyArtifactStore", (), {"export_all": lambda self: {"items": []}})(),
                ), patch("app.ops.async_session", session):
                    run_record = await create_agent_run(
                        conversation_id="security-canary",
                        goal=f"prepare api_token={RELEASE_CANARY}",
                        mode="security-canary",
                        skill_snapshot={"secret": RELEASE_CANARY},
                        llm_runtime={"session_token": RELEASE_CANARY},
                        actions=[
                            {
                                "id": "canary:1",
                                "tool": "get_profile",
                                "args": {"api_key": RELEASE_CANARY},
                                "summary": f"token={RELEASE_CANARY}",
                            }
                        ],
                    )
                    await execute_operation(
                        "security_canary_unknown_operation",
                        {"api_token": RELEASE_CANARY},
                        surface="security_canary",
                    )
                    exported = await data_export.export_user_data()

                async with session() as db:
                    run_row = await db.get(AgentRunRecord, run_record["id"])
                    run_events = (
                        await db.execute(
                            select(AgentRunEvent).where(
                                AgentRunEvent.run_id == run_record["id"]
                            )
                        )
                    ).scalars().all()
                    audit_rows = (
                        await db.execute(
                            select(OperationAuditLog).where(
                                OperationAuditLog.surface == "security_canary"
                            )
                        )
                    ).scalars().all()

                raw = json.dumps(
                    {
                        "run": run_row.steps_json if run_row else None,
                        "run_events": [row.payload_json for row in run_events],
                        "audit_inputs": [row.inputs_json for row in audit_rows],
                        "audit_errors": [row.errors_json for row in audit_rows],
                        "export": exported,
                    },
                    ensure_ascii=False,
                )
                return {
                    "canary_found": RELEASE_CANARY in raw,
                    "run_status": run_row.status if run_row else "missing",
                    "event_count": len(run_events),
                    "audit_count": len(audit_rows),
                    "export_schema": exported["schema_version"],
                }
            finally:
                await engine.dispose()

        with tempfile.TemporaryDirectory() as directory:
            result = asyncio.run(run(Path(directory) / "security-canary.db"))

        self.assertFalse(result["canary_found"], result)
        self.assertEqual(result["run_status"], "waiting_confirmation")
        self.assertGreaterEqual(result["event_count"], 2)
        self.assertEqual(result["audit_count"], 1)
        self.assertEqual(result["export_schema"], "offeru.internal-beta.export.v1")

    def test_diagnostic_bundle_and_error_response_redact_canary(self) -> None:
        async def run() -> tuple[dict[str, object], bytes, str]:
            diagnostics.record_error(
                "err_0123456789abcdef",
                method="POST",
                path=f"/api/canary?api_token={RELEASE_CANARY}",
                status_code=503,
                kind="provider",
                message=f"provider failed api_token={RELEASE_CANARY}",
            )
            with patch(
                "app.services.agent_provider_health.list_provider_health",
                new=AsyncMock(
                    return_value={
                        "providers": [
                            {
                                "provider_id": "pi",
                                "status": "blocked",
                                "available": False,
                                "authenticated": False,
                                "blocked": True,
                                "last_error": f"token={RELEASE_CANARY}",
                                "capabilities": {},
                            }
                        ]
                    }
                ),
            ), patch(
                "app.services.data_safety.get_data_safety_status",
                new=AsyncMock(
                    return_value={
                        "database": {"exists": True, "filename": "canary.db"},
                        "backup_count": 1,
                        "invalid_backup_count": 0,
                        "pending_restore": None,
                        "storage_mode": "managed_local",
                        "error": f"api_token={RELEASE_CANARY}",
                    }
                ),
            ), patch(
                "app.services.data_safety.check_database_integrity",
                new=AsyncMock(
                    return_value={
                        "status": "ok",
                        "foreign_key_violations": [],
                    }
                ),
            ):
                bundle = await diagnostics.export_diagnostic_bundle()

            from app.main import _error_response
            from starlette.requests import Request

            request = Request(
                {
                    "type": "http",
                    "method": "POST",
                    "path": "/api/canary",
                    "headers": [],
                    "query_string": b"",
                }
            )
            response = _error_response(
                request,
                status_code=503,
                detail=f"provider failed api_token={RELEASE_CANARY}",
                kind="security_canary",
            )
            return bundle, response.body, response.headers.get("X-OfferU-Error-Id", "")

        bundle, response_body, error_id = asyncio.run(run())
        raw = json.dumps(
            {"bundle": bundle, "response": response_body.decode("utf-8")},
            ensure_ascii=False,
        )
        self.assertNotIn(RELEASE_CANARY, raw)
        self.assertEqual(bundle["schema_version"], "offeru.internal-beta.diagnostics.v1")
        self.assertFalse(bundle["privacy"]["includes_credentials"])
        self.assertRegex(error_id, r"^err_[a-f0-9]{16}$")
        self.assertIn(error_id, response_body.decode("utf-8"))


if __name__ == "__main__":
    unittest.main()
