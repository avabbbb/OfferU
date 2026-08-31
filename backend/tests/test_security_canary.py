from __future__ import annotations

import asyncio
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

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
from app.services import agent_run_state, data_export  # noqa: E402
from app.services.agent_run_state import create_agent_run  # noqa: E402


RELEASE_CANARY = "OFFERU_RELEASE_CANARY_SECRET_20260831_7f5c"


class SecurityCanaryTests(unittest.TestCase):
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


if __name__ == "__main__":
    unittest.main()
