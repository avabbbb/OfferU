from __future__ import annotations

import asyncio
import io
import json
import sys
import unittest
from pathlib import Path
from datetime import datetime, timedelta, timezone
from unittest.mock import patch

BACKEND_DIR = Path(__file__).resolve().parents[2]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from app.database import async_session, init_db  # noqa: E402
from app.models.models import AgentRunEvent, AgentRunRecord, BridgePairing, JobSearchTask, Profile  # noqa: E402
from app.services.agent_bridge.errors import BridgeProtocolError  # noqa: E402
from app.services.agent_bridge.event_stream import follow_events  # noqa: E402
from app.services.agent_bridge.operation_gateway import (  # noqa: E402
    granted_operations,
    invoke_read_operation,
)
from app.services.agent_bridge.run_coordinator import (  # noqa: E402
    LeaseLostError,
    RunCoordinator,
    consume_bootstrap_token,
    create_bridge_pairing,
)
from app.services.agent_bridge.server import BridgeSession  # noqa: E402
from app.services.agent_run_state import create_agent_run, load_agent_run  # noqa: E402
from sqlalchemy import select  # noqa: E402
from sqlalchemy.exc import IntegrityError  # noqa: E402

import secrets  # noqa: E402

_SALT = secrets.token_hex(8)


def _hello_payload() -> dict:
    return {
        "adapter": {"name": "fake-adapter", "version": "0.0.1"},
        "harness": {"name": "fake-harness", "version": "0.0.1"},
        "protocols": [1],
        "capabilities": {
            "sessionResume": True,
            "steer": False,
            "interrupt": True,
            "toolSuspendResume": True,
            "eventStream": True,
            "workspaceIsolation": "native_tools_disabled",
            "nativeClient": False,
        },
    }


class Slice1BridgeTests(unittest.TestCase):
    def _run(self, coro):
        return asyncio.run(coro)

    async def _make_run(self) -> str:
        await init_db()
        async with async_session() as db:
            profile = (
                await db.execute(select(Profile).where(Profile.is_default == True))
            ).scalar_one_or_none()
            if profile is None:
                db.add(Profile(name="Bridge fixture", is_default=True))
                await db.commit()
        run = await create_agent_run(
            conversation_id=f"slice1-{_SALT}-{id(object())}",
            goal="Slice 1 只读链路验收",
            mode="general",
            skill_id="pre_application_decision",
            actions=[],
        )
        return str(run["id"])

    def test_pairing_token_is_single_use(self) -> None:
        async def flow():
            run_id = await self._make_run()
            pairing = await create_bridge_pairing(run_id=run_id)
            redeemed = await consume_bootstrap_token(pairing["bootstrapToken"])
            assert redeemed is not None and redeemed["runId"] == run_id
            replay = await consume_bootstrap_token(pairing["bootstrapToken"])
            return replay

        self.assertIsNone(self._run(flow()))

    def test_attach_issues_single_writer_lease_and_rejects_second(self) -> None:
        async def flow():
            run_id = await self._make_run()
            coordinator = RunCoordinator()
            first = await coordinator.attach(
                run_id=run_id,
                harness={"name": "h1", "version": "1"},
                adapter={"name": "a1", "version": "1"},
                harness_session_id="sess-a",
            )
            with self.assertRaises(LeaseLostError):
                await coordinator.attach(
                    run_id=run_id,
                    harness={"name": "h2", "version": "1"},
                    adapter={"name": "a2", "version": "1"},
                    harness_session_id="sess-b",
                )
            await coordinator.assert_lease(
                run_id=run_id, lease_id=str(first["leaseId"])
            )
            return first

        first = self._run(flow())
        self.assertTrue(str(first["leaseId"]).startswith("lease_"))

    def test_attach_reconciles_the_same_session_without_a_duplicate_event(self) -> None:
        async def flow():
            run_id = await self._make_run()
            coordinator = RunCoordinator()
            identity = {
                "harness": {"name": "h1", "version": "1"},
                "adapter": {"name": "a1", "version": "1"},
                "harness_session_id": "sess-a",
            }
            first = await coordinator.attach(run_id=run_id, **identity)
            before = await load_agent_run(run_id)
            resumed = await coordinator.attach(
                run_id=run_id,
                **identity,
                lease_id=str(first["leaseId"]),
                last_event_seq=2,
            )
            after = await load_agent_run(run_id)
            return first, before, resumed, after

        first, before, resumed, after = self._run(flow())
        self.assertEqual(resumed["leaseId"], first["leaseId"])
        self.assertEqual(after["event_sequence"], before["event_sequence"])
        self.assertEqual(after["harness_session_id"], "sess-a")

    def test_attach_replaces_an_expired_lease_on_the_same_persisted_run(self) -> None:
        async def flow():
            run_id = await self._make_run()
            coordinator = RunCoordinator()
            identity = {
                "harness": {"name": "h1", "version": "1"},
                "adapter": {"name": "a1", "version": "1"},
                "harness_session_id": "sess-a",
            }
            first = await coordinator.attach(run_id=run_id, **identity)
            async with async_session() as db:
                row = (
                    await db.execute(
                        select(AgentRunRecord).where(AgentRunRecord.run_id == run_id)
                    )
                ).scalar_one()
                row.lease_expires_at = datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(minutes=1)
                await db.commit()
            resumed = await coordinator.attach(
                run_id=run_id,
                **identity,
                lease_id=str(first["leaseId"]),
                last_event_seq=2,
            )
            result = await load_agent_run(run_id)
            return first, resumed, result

        first, resumed, result = self._run(flow())
        self.assertNotEqual(resumed["leaseId"], first["leaseId"])
        self.assertEqual(result["harness_session_id"], "sess-a")
        self.assertGreater(result["event_sequence"], 1)

    def test_active_attach_requires_the_existing_lease_capability(self) -> None:
        async def flow():
            run_id = await self._make_run()
            coordinator = RunCoordinator()
            identity = {
                "harness": {"name": "h1", "version": "1"},
                "adapter": {"name": "a1", "version": "1"},
                "harness_session_id": "sess-a",
            }
            first = await coordinator.attach(run_id=run_id, **identity)
            for capability in (None, "lease_wrong"):
                with self.assertRaises(LeaseLostError):
                    await coordinator.attach(
                        run_id=run_id, **identity, lease_id=capability
                    )
            retry = await coordinator.attach(
                run_id=run_id,
                **identity,
                lease_id=str(first["leaseId"]),
                last_event_seq=2,
            )
            return first, retry

        first, retry = self._run(flow())
        self.assertEqual(first["leaseId"], retry["leaseId"])

    def test_lease_renew_requires_and_preserves_the_capability(self) -> None:
        async def flow():
            run_id = await self._make_run()
            coordinator = RunCoordinator()
            attached = await coordinator.attach(
                run_id=run_id,
                harness={"name": "h1", "version": "1"},
                adapter={"name": "a1", "version": "1"},
                harness_session_id="sess-renew",
            )
            for capability in (None, "lease_wrong"):
                with self.assertRaises(LeaseLostError):
                    await coordinator.renew_lease(run_id=run_id, lease_id=capability)
            renewed = await coordinator.renew_lease(
                run_id=run_id, lease_id=str(attached["leaseId"])
            )
            return attached, renewed

        attached, renewed = self._run(flow())
        self.assertEqual(renewed["leaseId"], attached["leaseId"])

    def test_attach_rejects_a_client_event_cursor_ahead_of_the_run(self) -> None:
        async def flow():
            run_id = await self._make_run()
            coordinator = RunCoordinator()
            attached = await coordinator.attach(
                run_id=run_id,
                harness={"name": "h1", "version": "1"},
                adapter={"name": "a1", "version": "1"},
                harness_session_id="sess-cursor",
            )
            with self.assertRaisesRegex(ValueError, "lastEventSeq"):
                await coordinator.attach(
                    run_id=run_id,
                    harness={"name": "h1", "version": "1"},
                    adapter={"name": "a1", "version": "1"},
                    harness_session_id="sess-cursor",
                    lease_id=str(attached["leaseId"]),
                    last_event_seq=10_000,
                )

        self._run(flow())

    def test_attach_event_failure_rolls_back_the_lease_for_a_clean_retry(self) -> None:
        async def flow():
            run_id = await self._make_run()
            async with async_session() as db:
                existing_event = (
                    await db.execute(
                        select(AgentRunEvent)
                        .where(AgentRunEvent.run_id == run_id)
                        .limit(1)
                    )
                ).scalar_one()
            identity = {
                "run_id": run_id,
                "harness": {"name": "h1", "version": "1"},
                "adapter": {"name": "a1", "version": "1"},
                "harness_session_id": "sess-a",
            }
            coordinator = RunCoordinator()
            duplicate_event_token = existing_event.event_id.removeprefix("evt_")
            with patch(
                "app.services.agent_bridge.run_coordinator.secrets.token_hex",
                side_effect=["lease-id-token", duplicate_event_token],
            ):
                with self.assertRaises(IntegrityError):
                    await coordinator.attach(**identity)
            failed = await load_agent_run(run_id)
            self.assertEqual(failed["lease_id"], "")
            self.assertEqual(failed["event_sequence"], 2)
            retried = await coordinator.attach(**identity)
            succeeded = await load_agent_run(run_id)
            return retried, succeeded

        retried, succeeded = self._run(flow())
        self.assertTrue(retried["leaseId"])
        self.assertEqual(succeeded["lease_id"], retried["leaseId"])
        self.assertEqual(succeeded["event_sequence"], 3)

    def test_expired_lease_cannot_be_rebound_to_another_harness_session(self) -> None:
        async def flow():
            run_id = await self._make_run()
            coordinator = RunCoordinator()
            first = await coordinator.attach(
                run_id=run_id,
                harness={"name": "h1", "version": "1"},
                adapter={"name": "a1", "version": "1"},
                harness_session_id="sess-a",
            )
            async with async_session() as db:
                row = (
                    await db.execute(
                        select(AgentRunRecord).where(AgentRunRecord.run_id == run_id)
                    )
                ).scalar_one()
                row.lease_expires_at = datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(minutes=1)
                await db.commit()
            with self.assertRaises(LeaseLostError):
                await coordinator.attach(
                    run_id=run_id,
                    harness={"name": "h2", "version": "2"},
                    adapter={"name": "a2", "version": "2"},
                    harness_session_id="sess-b",
                    lease_id=str(first["leaseId"]),
                    last_event_seq=2,
                )
            stored = await load_agent_run(run_id)
            return stored

        stored = self._run(flow())
        self.assertEqual(stored["harness_name"], "h1")
        self.assertEqual(stored["harness_session_id"], "sess-a")

    def test_bridge_restart_reconciles_same_run_with_pairing_and_lease(self) -> None:
        async def flow():
            run_id = await self._make_run()
            pairing = await create_bridge_pairing(run_id=run_id)
            first_session = BridgeSession()
            await first_session.handle(
                {"v": 1, "id": "h1", "type": "hello", "payload": _hello_payload()}
            )
            await first_session.handle(
                {"v": 1, "id": "p1", "type": "pairing.request", "payload": {"bootstrapToken": pairing["bootstrapToken"]}}
            )
            first = await first_session.handle(
                {
                    "v": 1,
                    "id": "a1",
                    "type": "run.attach",
                    "runId": run_id,
                    "payload": {
                        "harness": {"name": "fake-harness", "version": "0.0.1"},
                        "adapter": {"name": "fake-adapter", "version": "0.0.1"},
                        "harnessSessionId": "sess-restart",
                    },
                }
            )
            first_lease = first["result"]["leaseId"]
            before = await load_agent_run(run_id)

            new_pairing = await create_bridge_pairing(run_id=run_id)
            resumed_session = BridgeSession()
            await resumed_session.handle(
                {"v": 1, "id": "h2", "type": "hello", "payload": _hello_payload()}
            )
            await resumed_session.handle(
                {"v": 1, "id": "p2", "type": "pairing.request", "payload": {"bootstrapToken": new_pairing["bootstrapToken"]}}
            )
            resumed = await resumed_session.handle(
                {
                    "v": 1,
                    "id": "a2",
                    "type": "run.attach",
                    "runId": run_id,
                    "payload": {
                        "harness": {"name": "fake-harness", "version": "0.0.1"},
                        "adapter": {"name": "fake-adapter", "version": "0.0.1"},
                        "harnessSessionId": "sess-restart",
                        "leaseId": first_lease,
                        "lastEventSeq": before["event_sequence"],
                    },
                }
            )
            after = await load_agent_run(run_id)
            return first, resumed, before, after

        first, resumed, before, after = self._run(flow())
        self.assertTrue(resumed["ok"])
        self.assertEqual(resumed["result"]["leaseId"], first["result"]["leaseId"])
        self.assertEqual(after["event_sequence"], before["event_sequence"])

    def test_session_full_readonly_flow(self) -> None:
        async def flow():
            run_id = await self._make_run()
            pairing = await create_bridge_pairing(run_id=run_id)
            session = BridgeSession()
            hello = await session.handle(
                {"v": 1, "id": "h", "type": "hello", "payload": _hello_payload()}
            )
            assert hello["ok"] is True
            paired = await session.handle(
                {
                    "v": 1,
                    "id": "p",
                    "type": "pairing.request",
                    "payload": {"bootstrapToken": pairing["bootstrapToken"]},
                }
            )
            assert paired["result"]["paired"] is True
            attach = await session.handle(
                {
                    "v": 1,
                    "id": "a",
                    "type": "run.attach",
                    "runId": run_id,
                    "payload": {
                        "harness": {"name": "fake-harness", "version": "0.0.1"},
                        "adapter": {"name": "fake-adapter", "version": "0.0.1"},
                        "harnessSessionId": "sess-1",
                    },
                }
            )
            context_version = int(attach["result"]["contextVersion"])
            invoked = await session.handle(
                {
                    "v": 1,
                    "id": "i",
                    "type": "operation.invoke",
                    "runId": run_id,
                    "payload": {
                        "operation": "get_profile",
                        "arguments": {},
                        "idempotencyKey": f"{run_id}:c1",
                        "contextVersion": context_version,
                    },
                }
            )
            followed = await session.handle(
                {
                    "v": 1,
                    "id": "ef",
                    "type": "event.follow",
                    "runId": run_id,
                    "payload": {"afterSeq": 0},
                }
            )
            finished = await session.handle(
                {
                    "v": 1,
                    "id": "f",
                    "type": "run.finish",
                    "runId": run_id,
                    "payload": {"status": "completed"},
                }
            )
            return invoked, followed, finished

        invoked, followed, finished = self._run(flow())
        self.assertTrue(invoked["result"]["completed"])
        event_types = [event["type"] for event in followed["result"]["events"]]
        self.assertIn("operation.completed", event_types)

    def test_stale_context_version_fails_closed(self) -> None:
        async def flow():
            run_id = await self._make_run()
            pairing = await create_bridge_pairing(run_id=run_id)
            session = BridgeSession()
            await session.handle(
                {"v": 1, "id": "h", "type": "hello", "payload": _hello_payload()}
            )
            await session.handle(
                {
                    "v": 1,
                    "id": "p",
                    "type": "pairing.request",
                    "payload": {"bootstrapToken": pairing["bootstrapToken"]},
                }
            )
            await session.handle(
                {
                    "v": 1,
                    "id": "a",
                    "type":"run.attach",
                    "runId": run_id,
                    "payload": {
                        "harness": {"name": "fake-harness", "version": "0.0.1"},
                        "adapter": {"name": "fake-adapter", "version": "0.0.1"},
                        "harnessSessionId": "sess-1",
                    },
                }
            )
            try:
                await session.handle(
                    {
                        "v": 1,
                        "id": "i",
                        "type": "operation.invoke",
                        "runId": run_id,
                        "payload": {
                            "operation": "get_profile",
                            "arguments": {},
                            "idempotencyKey": f"{run_id}:stale",
                            "contextVersion": 99,
                        },
                    }
                )
            except BridgeProtocolError as error:
                return error.code
            raise AssertionError("stale contextVersion must fail")

        self.assertEqual(self._run(flow()), "context_stale")

    def test_mutation_operations_denied_in_slice1(self) -> None:
        async def flow():
            run_id = await self._make_run()
            pairing = await create_bridge_pairing(run_id=run_id)
            session = BridgeSession()
            await session.handle(
                {"v": 1, "id": "h", "type": "hello", "payload": _hello_payload()}
            )
            await session.handle(
                {
                    "v": 1,
                    "id": "p",
                    "type": "pairing.request",
                    "payload": {"bootstrapToken": pairing["bootstrapToken"]},
                }
            )
            await session.handle(
                {
                    "v": 1,
                    "id": "a",
                    "type": "run.attach",
                    "runId": run_id,
                    "payload": {
                        "harness": {"name": "fake-harness", "version": "0.0.1"},
                        "adapter": {"name": "fake-adapter", "version": "0.0.1"},
                        "harnessSessionId": "sess-1",
                    },
                }
            )
            try:
                await invoke_read_operation(operation="import_jd", arguments={})
            except BridgeProtocolError as error:
                return error.code
            raise AssertionError("mutation must be denied")

        self.assertEqual(self._run(flow()), "grant_denied")

    def test_read_operation_outside_run_grant_is_denied(self) -> None:
        async def flow():
            try:
                await invoke_read_operation(operation="list_pools", arguments={})
            except BridgeProtocolError as error:
                return error.code
            raise AssertionError("ungranted read must be denied")

        self.assertEqual(self._run(flow()), "grant_denied")

    def test_active_bridge_grant_lists_only_registry_reads(self) -> None:
        operations = granted_operations()

        self.assertTrue(operations)
        self.assertTrue(
            all(item["side_effects"] == ["read"] for item in operations)
        )
        self.assertNotIn("triage_job", {item["name"] for item in operations})

    def test_run_messages_require_pairing_first(self) -> None:
        async def flow():
            session = BridgeSession()
            await session.handle(
                {"v": 1, "id": "h", "type": "hello", "payload": _hello_payload()}
            )
            try:
                await session.handle(
                    {"v": 1, "id": "x", "type": "operation.list", "payload": {}}
                )
            except BridgeProtocolError as error:
                return error.code
            raise AssertionError("unpaired request must fail")

        self.assertEqual(self._run(flow()), "pairing_required")

    def test_stdio_cli_end_to_end(self) -> None:
        async def flow():
            run_id = await self._make_run()
            pairing = await create_bridge_pairing(run_id=run_id)
            lines = [
                json.dumps({"v": 1, "id": "h", "type": "hello", "payload": _hello_payload()}),
                json.dumps(
                    {
                        "v": 1,
                        "id": "p",
                        "type": "pairing.request",
                        "payload": {"bootstrapToken": pairing["bootstrapToken"]},
                    }
                ),
                json.dumps(
                    {
                        "v": 1,
                        "id": "a",
                        "type": "run.attach",
                        "runId": run_id,
                        "payload": {
                            "harness": {"name": "fake-harness", "version": "0.0.1"},
                            "adapter": {"name": "fake-adapter", "version": "0.0.1"},
                            "harnessSessionId": "sess-cli",
                        },
                    }
                ),
                json.dumps(
                    {
                        "v": 1,
                        "id": "f",
                        "type": "run.finish",
                        "runId": run_id,
                        "payload": {"status": "completed"},
                    }
                ),
            ]
            from app.services.agent_bridge.server import serve_stdio

            buffer = io.StringIO("\n".join(lines) + "\n")
            out = io.StringIO()
            with patch("sys.stdin", buffer), patch("sys.stdout", out):
                await serve_stdio()
            responses = [json.loads(line) for line in out.getvalue().splitlines() if line.strip()]
            return responses

        responses = self._run(flow())
        self.assertEqual(len(responses), 4)
        self.assertTrue(all(response.get("ok") for response in responses))
        self.assertEqual(responses[-1]["result"]["status"], "completed")


if __name__ == "__main__":
    unittest.main()
