"""Focused tests for Proposal v2 decision-group execution and authorization.

Covers: one approval executes all nodes once; concurrent duplicate approvals
still effect once; args tamper/digest mismatch is blocked; rejection executes
nothing; first failure pauses remaining nodes; crash leftovers become
uncertain without replay; the legacy single-step confirm path still works.

Isolation: a temp SQLite database under OFFERU_TEST_TEMP_ROOT (conftest),
with ``async_session`` patched into the modules under test. No real DB, no
network, no external effects — the probe operation only records invocations.
"""

from __future__ import annotations

import asyncio
import sys
import tempfile
import unittest
import uuid
from pathlib import Path
from typing import Any
from unittest.mock import patch

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

import app.database as database_module  # noqa: E402
import app.ops as operation_registry  # noqa: E402
import app.services.agent_run_coordinator as run_coordinator  # noqa: E402
import app.services.agent_run_state as run_state  # noqa: E402
import app.services.decision_execution as decision_execution  # noqa: E402
import app.services.decision_plans as decision_plans  # noqa: E402
from app.database import Base  # noqa: E402
from app.models.models import (  # noqa: E402
    DecisionGroup,
    ExecutionReceipt,
    OperationNode,
    ProposalPlan,
)
from app.ops import (  # noqa: E402
    OPERATIONS,
    Operation,
    confirmed_decision_node,
    execute_operation,
)
from app.services.agent_run_state import create_agent_run  # noqa: E402
from app.services.decision_plans import canonical_digest  # noqa: E402


_PROBE_OPERATION = "test_decision_probe"


class _ProbeInput(operation_registry._StrictOperationInput):
    marker: str = ""
    fail: bool = False


PROBE_CALLS: list[dict[str, Any]] = []


async def _probe(marker: str = "", fail: bool = False) -> dict[str, Any]:
    PROBE_CALLS.append({"marker": marker, "fail": fail})
    if fail:
        return {"error": "probe failed"}
    return {"ok_marker": marker}


def _register_probe() -> None:
    OPERATIONS[_PROBE_OPERATION] = Operation(
        name=_PROBE_OPERATION,
        fn=_probe,
        description="Decision execution test probe; records invocations only.",
        side_effects=("write",),
        input_model=_ProbeInput,
        version="test",
    )


def _unregister_probe() -> None:
    OPERATIONS.pop(_PROBE_OPERATION, None)


class _IsolatedDb:
    def __init__(self, directory: str) -> None:
        self.path = Path(directory) / f"decision_{uuid.uuid4().hex}.db"
        self.engine = create_async_engine(
            f"sqlite+aiosqlite:///{self.path.as_posix()}"
        )
        self.session = async_sessionmaker(self.engine, expire_on_commit=False)
        self._patches: list[Any] = []

    async def __aenter__(self) -> "_IsolatedDb":
        async with self.engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)
        for module in (
            database_module,
            decision_execution,
            decision_plans,
            operation_registry,
            run_state,
            run_coordinator,
        ):
            patcher = patch.object(module, "async_session", self.session)
            patcher.start()
            self._patches.append(patcher)
        return self

    async def __aexit__(self, *exc: Any) -> None:
        for patcher in self._patches:
            patcher.stop()
        await self.engine.dispose()


async def _make_run() -> str:
    run = await create_agent_run(
        conversation_id=f"conv_{uuid.uuid4().hex[:8]}",
        goal="decision test",
        mode="general",
        actions=[],
    )
    return str(run["id"])


async def _make_plan(
    run_id: str,
    markers: list[str],
    *,
    second_group_markers: list[str] | None = None,
) -> dict[str, Any]:
    groups: list[dict[str, Any]] = [
        {
            "title": "g1",
            "summary": "group one",
            "risk_level": "L1",
            "dependency_indices": [],
            "display": {},
            "nodes": [
                {
                    "operation": _PROBE_OPERATION,
                    "args": {"marker": marker},
                    "target": {},
                    "summary": f"probe {marker}",
                }
                for marker in markers
            ],
        }
    ]
    if second_group_markers is not None:
        groups.append(
            {
                "title": "g2",
                "summary": "group two depends on g1",
                "risk_level": "L1",
                "dependency_indices": [0],
                "display": {},
                "nodes": [
                    {
                        "operation": _PROBE_OPERATION,
                        "args": {"marker": marker},
                        "target": {},
                        "summary": f"probe {marker}",
                    }
                    for marker in second_group_markers
                ],
            }
        )
    return await decision_plans.create_decision_plan(
        run_id=run_id,
        title="test plan",
        purpose="testing",
        groups=groups,
    )


def _decision_kwargs(run_id: str, plan: dict, group_index: int = 0) -> dict[str, Any]:
    group = plan["groups"][group_index]
    return {
        "run_id": run_id,
        "plan_id": plan["plan_id"],
        "group_id": group["group_id"],
        "decision_id": f"dec_{uuid.uuid4().hex}",
        "decision": "approve",
        "plan_digest": plan["plan_digest"],
        "group_digest": group["group_digest"],
        "surface": "test_desktop",
    }


class DecisionExecutionTests(unittest.TestCase):
    def setUp(self) -> None:
        PROBE_CALLS.clear()
        _register_probe()
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.addCleanup(_unregister_probe)

    def _db(self) -> _IsolatedDb:
        return _IsolatedDb(self._tmp.name)

    # ------------------------------------------------------------------
    def test_one_approval_executes_all_nodes_once(self) -> None:
        async def flow() -> dict[str, Any]:
            async with self._db():
                run_id = await _make_run()
                plan = await _make_plan(run_id, ["a", "b", "c"])
                result = await decision_execution.decide_group(
                    **_decision_kwargs(run_id, plan)
                )
                receipts = await decision_execution._receipts_for_group(
                    plan["groups"][0]["group_id"]
                )
                return {
                    "result": result,
                    "receipts": receipts,
                    "calls": list(PROBE_CALLS),
                }

        outcome = asyncio.run(flow())
        self.assertTrue(outcome["result"]["ok"], outcome["result"])
        self.assertEqual(
            [call["marker"] for call in outcome["calls"]], ["a", "b", "c"]
        )
        self.assertEqual(outcome["result"]["group_status"], "completed")
        self.assertEqual(outcome["result"]["plan_status"], "completed")
        self.assertEqual(len(outcome["receipts"]), 3)
        self.assertTrue(
            all(
                receipt["effect_state"] == "committed"
                for receipt in outcome["receipts"]
            ),
            outcome["receipts"],
        )

    # ------------------------------------------------------------------
    def test_concurrent_duplicate_approval_effects_once(self) -> None:
        async def flow() -> dict[str, Any]:
            async with self._db():
                run_id = await _make_run()
                plan = await _make_plan(run_id, ["x", "y"])
                kwargs = _decision_kwargs(run_id, plan)
                results = await asyncio.gather(
                    decision_execution.decide_group(**kwargs),
                    decision_execution.decide_group(**kwargs),
                    decision_execution.decide_group(**kwargs),
                    return_exceptions=True,
                )
                return {"results": results, "calls": list(PROBE_CALLS)}

        outcome = asyncio.run(flow())
        for result in outcome["results"]:
            if isinstance(result, Exception):
                self.fail(f"decide_group raised: {result}")
        # Every approval path resolves without double-executing nodes.
        self.assertEqual(len(outcome["calls"]), 2, outcome)

    # ------------------------------------------------------------------
    def test_args_tamper_digest_mismatch_is_blocked(self) -> None:
        async def flow() -> dict[str, Any]:
            async with self._db() as db:
                run_id = await _make_run()
                plan = await _make_plan(run_id, ["safe"])
                group_id = plan["groups"][0]["group_id"]
                node_id = plan["groups"][0]["nodes"][0]["node_id"]
                # Tamper with persisted args after sealing: digest no longer
                # matches the stored args_digest.
                async with db.session() as session:
                    await session.execute(
                        update(OperationNode)
                        .where(OperationNode.node_id == node_id)
                        .values(args_json={"marker": "evil"})
                    )
                    await session.commit()
                result = await decision_execution.decide_group(
                    **_decision_kwargs(run_id, plan)
                )
                async with db.session() as session:
                    node = (
                        await session.execute(
                            select(OperationNode).where(
                                OperationNode.node_id == node_id
                            )
                        )
                    ).scalar_one()
                    node_status = str(node.status)
                return {
                    "result": result,
                    "node_status": node_status,
                    "calls": list(PROBE_CALLS),
                    "group_id": group_id,
                }

        outcome = asyncio.run(flow())
        self.assertEqual(outcome["calls"], [], outcome)
        self.assertIn(
            outcome["node_status"], ("failed", "uncertain"), outcome
        )

    # ------------------------------------------------------------------
    def test_direct_execute_with_mismatched_args_is_blocked(self) -> None:
        """Authorization context + different args than sealed must not run."""
        async def flow() -> dict[str, Any]:
            async with self._db() as db:
                run_id = await _make_run()
                plan = await _make_plan(run_id, ["sealed"])
                group_id = plan["groups"][0]["group_id"]
                node_id = plan["groups"][0]["nodes"][0]["node_id"]
                async with db.session() as session:
                    await session.execute(
                        update(OperationNode)
                        .where(OperationNode.node_id == node_id)
                        .values(status="executing")
                    )
                    await session.execute(
                        update(DecisionGroup)
                        .where(DecisionGroup.group_id == group_id)
                        .values(status="executing")
                    )
                    await session.execute(
                        update(ProposalPlan)
                        .where(ProposalPlan.plan_id == plan["plan_id"])
                        .values(status="executing")
                    )
                    await session.commit()
                    node = (
                        await session.execute(
                            select(OperationNode).where(
                                OperationNode.node_id == node_id
                            )
                        )
                    ).scalar_one()
                with confirmed_decision_node(
                    operation=_PROBE_OPERATION,
                    run_id=run_id,
                    node_id=node_id,
                    group_id=group_id,
                    plan_id=plan["plan_id"],
                    args_digest=str(node.args_digest),
                    idempotency_key=str(node.idempotency_key),
                ):
                    envelope = await execute_operation(
                        _PROBE_OPERATION,
                        {"marker": "tampered"},
                        surface=decision_execution.DECISION_NODE_SURFACE,
                    )
                return {"envelope": envelope, "calls": list(PROBE_CALLS)}

        outcome = asyncio.run(flow())
        self.assertFalse(outcome["envelope"]["ok"], outcome["envelope"])
        self.assertEqual(outcome["envelope"]["effect_state"], "no_effect")
        self.assertEqual(outcome["calls"], [])

    # ------------------------------------------------------------------
    def test_rejection_executes_nothing(self) -> None:
        async def flow() -> dict[str, Any]:
            async with self._db():
                run_id = await _make_run()
                plan = await _make_plan(run_id, ["n1"], second_group_markers=["n2"])
                kwargs = _decision_kwargs(run_id, plan)
                kwargs["decision"] = "reject"
                result = await decision_execution.decide_group(**kwargs)
                return {"result": result, "calls": list(PROBE_CALLS)}

        outcome = asyncio.run(flow())
        self.assertTrue(outcome["result"]["ok"], outcome["result"])
        self.assertFalse(outcome["result"]["executed"])
        self.assertEqual(outcome["result"]["group_status"], "rejected")
        self.assertEqual(outcome["calls"], [])

    # ------------------------------------------------------------------
    def test_first_failure_pauses_remaining_nodes(self) -> None:
        async def flow() -> dict[str, Any]:
            async with self._db() as db:
                run_id = await _make_run()
                plan = await decision_plans.create_decision_plan(
                    run_id=run_id,
                    title="fail plan",
                    purpose="testing",
                    groups=[
                        {
                            "title": "g1",
                            "summary": "first node fails",
                            "risk_level": "L1",
                            "dependency_indices": [],
                            "display": {},
                            "nodes": [
                                {
                                    "operation": _PROBE_OPERATION,
                                    "args": {"marker": "boom", "fail": True},
                                    "target": {},
                                    "summary": "fails",
                                },
                                {
                                    "operation": _PROBE_OPERATION,
                                    "args": {"marker": "never"},
                                    "target": {},
                                    "summary": "paused",
                                },
                            ],
                        }
                    ],
                )
                result = await decision_execution.decide_group(
                    **_decision_kwargs(run_id, plan)
                )
                group_id = plan["groups"][0]["group_id"]
                async with db.session() as session:
                    rows = (
                        (
                            await session.execute(
                                select(OperationNode)
                                .where(OperationNode.group_id == group_id)
                                .order_by(OperationNode.sequence)
                            )
                        )
                        .scalars()
                        .all()
                    )
                    statuses = [str(row.status) for row in rows]
                return {
                    "result": result,
                    "statuses": statuses,
                    "calls": list(PROBE_CALLS),
                }

        outcome = asyncio.run(flow())
        self.assertTrue(outcome["result"]["ok"], outcome["result"])
        # A post-invocation failure is unknowable -> uncertain -> group and
        # plan need reconciliation; the second node is paused (blocked).
        self.assertEqual(
            outcome["result"]["group_status"], "needs_reconciliation", outcome["result"]
        )
        self.assertEqual(len(outcome["calls"]), 1, outcome)
        self.assertEqual(outcome["statuses"][0], "uncertain")
        self.assertEqual(outcome["statuses"][1], "blocked")

    # ------------------------------------------------------------------
    def test_crash_leftover_executing_becomes_uncertain_without_replay(self) -> None:
        async def flow() -> dict[str, Any]:
            async with self._db() as db:
                run_id = await _make_run()
                plan = await _make_plan(run_id, ["leftover"])
                group_id = plan["groups"][0]["group_id"]
                node_id = plan["groups"][0]["nodes"][0]["node_id"]
                # Simulate a crashed executor: node stuck mid-execution.
                async with db.session() as session:
                    await session.execute(
                        update(OperationNode)
                        .where(OperationNode.node_id == node_id)
                        .values(status="executing")
                    )
                    await session.execute(
                        update(DecisionGroup)
                        .where(DecisionGroup.group_id == group_id)
                        .values(status="executing")
                    )
                    await session.execute(
                        update(ProposalPlan)
                        .where(ProposalPlan.plan_id == plan["plan_id"])
                        .values(status="executing")
                    )
                    await session.commit()
                recovery = await decision_execution.recover_decision_execution()
                async with db.session() as session:
                    node = (
                        await session.execute(
                            select(OperationNode).where(
                                OperationNode.node_id == node_id
                            )
                        )
                    ).scalar_one()
                    group = (
                        await session.execute(
                            select(DecisionGroup).where(
                                DecisionGroup.group_id == group_id
                            )
                        )
                    ).scalar_one()
                    plan_row = (
                        await session.execute(
                            select(ProposalPlan).where(
                                ProposalPlan.plan_id == plan["plan_id"]
                            )
                        )
                    ).scalar_one()
                return {
                    "recovery": recovery,
                    "node_status": str(node.status),
                    "group_status": str(group.status),
                    "plan_status": str(plan_row.status),
                    "calls": list(PROBE_CALLS),
                }

        outcome = asyncio.run(flow())
        self.assertEqual(outcome["node_status"], "uncertain", outcome)
        self.assertEqual(
            outcome["group_status"], "needs_reconciliation", outcome
        )
        self.assertEqual(
            outcome["plan_status"], "needs_reconciliation", outcome
        )
        self.assertEqual(outcome["calls"], [], outcome)
        self.assertEqual(outcome["recovery"]["uncertain_nodes"], 1)

    # ------------------------------------------------------------------
    def test_legacy_single_step_confirm_still_passes(self) -> None:
        async def flow() -> dict[str, Any]:
            async with self._db():
                run = await create_agent_run(
                    conversation_id=f"conv_{uuid.uuid4().hex[:8]}",
                    goal="legacy confirm",
                    mode="general",
                    actions=[
                        {
                            "tool": _PROBE_OPERATION,
                            "args": {"marker": "legacy"},
                            "summary": "legacy probe",
                        }
                    ],
                )
                step = run["steps"][0]

                async def runner(tool: str, args: dict[str, Any]) -> Any:
                    return await execute_operation(
                        tool, args, surface="agent_runtime_ui"
                    )

                result = await run_coordinator.AgentRunCoordinator().execute_confirmed(
                    run=run,
                    confirmed_action_ids=[step["id"]],
                    tool_runner=runner,
                )
                return {"result": result, "calls": list(PROBE_CALLS)}

        outcome = asyncio.run(flow())
        self.assertEqual(
            outcome["calls"], [{"marker": "legacy", "fail": False}]
        )
        statuses = {
            step["status"]
            for step in outcome["result"]["run"]["steps"]
            if isinstance(step, dict)
        }
        self.assertEqual(
            statuses, {"completed"}, outcome["result"]["run"]["steps"]
        )

    # ------------------------------------------------------------------
    def test_digest_helper_is_canonical(self) -> None:
        # Canonical JSON: sorted keys, tight separators, UTF-8, deterministic.
        self.assertEqual(
            canonical_digest({"b": 1, "a": {"z": 2, "y": 1}}),
            canonical_digest({"a": {"y": 1, "z": 2}, "b": 1}),
        )
        self.assertNotEqual(
            canonical_digest({"marker": "safe"}),
            canonical_digest({"marker": "evil"}),
        )


if __name__ == "__main__":
    unittest.main()
