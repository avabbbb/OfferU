"""Focused tests for backend/app/services/decision_plans.py (Proposal v2).

Uses an isolated per-test SQLite database created under the pytest temp root
(OFFERU_DATA_DIR is already isolated by conftest); the service's async_session
factory is patched to point at the throwaway engine.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi.encoders import jsonable_encoder
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.database import Base
from app.models.models import AgentRunRecord, JobSearchTask
from app.services import decision_plans
from app.services.decision_plans import (
    DecisionConflictError,
    DecisionPlanError,
    DecisionPlanNotFoundError,
    canonical_digest,
    create_decision_plan,
    create_single_operation_plan,
    get_active_decision_plan,
    get_decision_plan,
    list_pending_decision_plans,
    record_group_decision,
)

# Registered operations reused as node arguments; execution is never invoked.
_OP_READ = "get_job"
_OP_WRITE = "triage_job"


def _expected_canonical_digest(value) -> str:
    """The byte-exact pipeline Execution recomputes in _validate_authorization."""
    payload = json.dumps(
        jsonable_encoder(value),
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        allow_nan=False,
    ).encode("utf-8")
    return hashlib.sha256(payload).hexdigest()


class DecisionPlanTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        db_path = Path(self._tmp.name) / "decision-plans.db"
        self._engine = create_async_engine(
            f"sqlite+aiosqlite:///{db_path.as_posix()}"
        )
        self._session = async_sessionmaker(self._engine, expire_on_commit=False)
        self._patcher = patch.object(
            decision_plans, "async_session", self._session
        )
        self._patcher.start()

        async def _create() -> None:
            async with self._engine.begin() as connection:
                await connection.run_sync(Base.metadata.create_all)

        asyncio.run(_create())

    def tearDown(self) -> None:
        self._patcher.stop()
        asyncio.run(self._engine.dispose())
        self._tmp.cleanup()

    def _run(self, coro):
        return asyncio.run(coro)

    async def _seed_run(self, run_id: str, *, task_id: str | None = None) -> None:
        task_id = task_id or f"task-{run_id}"
        async with self._session() as db:
            db.add(JobSearchTask(task_id=task_id))
            db.add(AgentRunRecord(run_id=run_id, task_id=task_id))
            await db.commit()

    def _create(self, **overrides):
        kwargs = {
            "run_id": "run-1",
            "title": "Plan title",
            "purpose": "purpose",
            "groups": [
                {
                    "title": "Group A",
                    "summary": "first",
                    "risk_level": "L2",
                    "dependency_indices": [],
                    "display": {"kind": "test"},
                    "nodes": [
                        {
                            "operation": _OP_READ,
                            "args": {"job_id": 1},
                            "target": {"kind": "job", "id": 1},
                            "summary": "read job",
                        }
                    ],
                },
                {
                    "title": "Group B",
                    "summary": "second",
                    "risk_level": "L1",
                    "dependency_indices": [0],
                    "display": {},
                    "nodes": [
                        {
                            "operation": _OP_WRITE,
                            "args": {"job_id": 1, "status": "picked"},
                            "target": {},
                            "summary": "triage",
                        }
                    ],
                },
            ],
        }
        kwargs.update(overrides)
        return self._run(create_decision_plan(**kwargs))

    # ------------------------------------------------------------------
    # create / seal / digest
    # ------------------------------------------------------------------

    def test_create_plan_seals_material_with_canonical_digests(self) -> None:
        self._run(self._seed_run("run-1"))
        plan = self._create()

        self.assertEqual(plan["run_id"], "run-1")
        self.assertEqual(plan["status"], "pending")
        self.assertEqual(plan["revision"], 1)
        self.assertRegex(plan["plan_digest"], r"^[0-9a-f]{64}$")
        self.assertEqual(len(plan["groups"]), 2)
        self.assertEqual(plan["groups"][1]["dependency_group_ids"],
                         [plan["groups"][0]["group_id"]])

        group = plan["groups"][0]
        node = group["nodes"][0]
        self.assertEqual(node["status"], "pending")
        self.assertEqual(node["operation"], _OP_READ)
        self.assertTrue(
            node["idempotency_key"].startswith(f"decision-node:{node['node_id']}:")
        )
        # Public view exposes normalized keys, never *_json.
        self.assertIn("args", node)
        self.assertIn("target", node)
        self.assertIn("display", group)
        self.assertNotIn("args_json", node)
        self.assertNotIn("display_json", group)

        # Stored digests are recomputable from sealed material.
        stored = self._run(self._stored_plan(plan["plan_id"]))
        self.assertEqual(
            stored["plan_digest"], _expected_canonical_digest(stored["immutable_json"])
        )
        material_group = stored["immutable_json"]["groups"][0]
        self.assertEqual(
            group["group_digest"], _expected_canonical_digest(material_group)
        )
        self.assertEqual(
            node["args_digest"], _expected_canonical_digest(node["args"])
        )

    async def _stored_plan(self, plan_id: str) -> dict:
        from sqlalchemy import select
        from app.models.models import ProposalPlan

        async with self._session() as db:
            row = (
                await db.execute(
                    select(ProposalPlan).where(ProposalPlan.plan_id == plan_id)
                )
            ).scalar_one()
            return {
                "plan_digest": row.plan_digest,
                "immutable_json": row.immutable_json,
            }

    def test_canonical_digest_matches_execution_byte_pipeline(self) -> None:
        value = {
            "b": [1, "两", {"x": None}],
            "a": {"nested": True},
        }
        self.assertEqual(canonical_digest(value), _expected_canonical_digest(value))
        self.assertNotEqual(
            canonical_digest(value), canonical_digest({"b": [1], "a": {}})
        )

    def test_digest_changes_on_group_node_and_target_changes(self) -> None:
        self._run(self._seed_run("run-1"))
        self._run(self._seed_run("run-2", task_id="task-2"))
        baseline = self._create()

        async def _material(plan_id: str) -> dict:
            stored = await self._stored_plan(plan_id)
            return stored["immutable_json"]

        baseline_material = self._run(_material(baseline["plan_id"]))

        # Group-level change (title) flips group_digest and plan_digest.
        changed_group = self._create(
            run_id="run-2",
            groups=[
                {
                    "title": "Group A renamed",
                    "summary": "first",
                    "risk_level": "L2",
                    "dependency_indices": [],
                    "display": {"kind": "test"},
                    "nodes": [
                        {
                            "operation": _OP_READ,
                            "args": {"job_id": 1},
                            "target": {"kind": "job", "id": 1},
                            "summary": "read job",
                        }
                    ],
                },
                {
                    "title": "Group B",
                    "summary": "second",
                    "risk_level": "L1",
                    "dependency_indices": [0],
                    "display": {},
                    "nodes": [
                        {
                            "operation": _OP_WRITE,
                            "args": {"job_id": 1, "status": "picked"},
                            "target": {},
                            "summary": "triage",
                        }
                    ],
                },
            ],
        )
        changed_material = self._run(_material(changed_group["plan_id"]))
        self.assertNotEqual(baseline["plan_digest"], changed_group["plan_digest"])
        # Same input shape but different ids/digests means tamper-evidence:
        # a stored digest recomputes from its own sealed material only.
        self.assertEqual(
            baseline["plan_digest"],
            _expected_canonical_digest(baseline_material),
        )
        self.assertNotEqual(
            baseline_material["groups"][0]["title"],
            changed_material["groups"][0]["title"],
        )

        # Node args change and target change alter their digests.
        args_a = canonical_digest({"job_id": 1})
        args_b = canonical_digest({"job_id": 2})
        target_a = canonical_digest({"kind": "job", "id": 1})
        target_b = canonical_digest({"kind": "job", "id": 2})
        self.assertNotEqual(args_a, args_b)
        self.assertNotEqual(target_a, target_b)

    # ------------------------------------------------------------------
    # validation
    # ------------------------------------------------------------------

    def test_unregistered_operation_rejected(self) -> None:
        self._run(self._seed_run("run-1"))
        with self.assertRaises(DecisionPlanError):
            self._create(
                groups=[
                    {
                        "title": "G",
                        "risk_level": "L2",
                        "nodes": [
                            {
                                "operation": "definitely_not_registered",
                                "args": {},
                                "target": {},
                            }
                        ],
                    }
                ]
            )

    def test_invalid_dependency_rejected(self) -> None:
        self._run(self._seed_run("run-1"))
        for dep in (-1, 0, 5):
            with self.assertRaises(DecisionPlanError, msg=f"dep={dep}"):
                self._create(
                    groups=[
                        {
                            "title": "G0",
                            "risk_level": "L2",
                            "dependency_indices": [dep],
                            "nodes": [
                                {
                                    "operation": _OP_READ,
                                    "args": {},
                                    "target": {},
                                }
                            ],
                        }
                    ]
                )
        # Forward/self dependency across two groups is also rejected.
        with self.assertRaises(DecisionPlanError):
            self._create(
                groups=[
                    {
                        "title": "G0",
                        "risk_level": "L2",
                        "nodes": [
                            {"operation": _OP_READ, "args": {}, "target": {}}
                        ],
                    },
                    {
                        "title": "G1",
                        "risk_level": "L2",
                        "dependency_indices": [1],
                        "nodes": [
                            {"operation": _OP_READ, "args": {}, "target": {}}
                        ],
                    },
                ]
            )

    def test_empty_nodes_and_bad_risk_level_rejected(self) -> None:
        self._run(self._seed_run("run-1"))
        with self.assertRaises(DecisionPlanError):
            self._create(
                groups=[{"title": "G", "risk_level": "L2", "nodes": []}]
            )
        with self.assertRaises(DecisionPlanError):
            self._create(
                groups=[
                    {
                        "title": "G",
                        "risk_level": "L9",
                        "nodes": [
                            {"operation": _OP_READ, "args": {}, "target": {}}
                        ],
                    }
                ]
            )

    def test_dynamic_output_reference_rejected(self) -> None:
        self._run(self._seed_run("run-1"))
        for bad_value in ("$node.node_1.outputs.text", "${nodes[0].result}"):
            with self.assertRaises(DecisionPlanError, msg=bad_value):
                self._create(
                    groups=[
                        {
                            "title": "G",
                            "risk_level": "L2",
                            "nodes": [
                                {
                                    "operation": _OP_READ,
                                    "args": {"job_id": bad_value},
                                    "target": {},
                                }
                            ],
                        }
                    ]
                )

    def test_unknown_run_rejected(self) -> None:
        with self.assertRaises(DecisionPlanNotFoundError):
            self._create(run_id="missing-run")

    def test_one_nonterminal_plan_per_run_and_supersede(self) -> None:
        self._run(self._seed_run("run-1"))
        first = self._create()
        with self.assertRaises(DecisionConflictError):
            self._create()

        second = self._create(supersedes_plan_id=first["plan_id"])
        self.assertEqual(second["revision"], 2)
        self.assertEqual(second["supersedes_plan_id"], first["plan_id"])
        superseded = self._run(get_decision_plan(first["plan_id"]))
        self.assertEqual(superseded["status"], "superseded")
        self.assertEqual(superseded["groups"][0]["status"], "stale")
        self.assertEqual(superseded["groups"][0]["nodes"][0]["status"], "stale")

        # Only one active plan remains.
        active = self._run(get_active_decision_plan("run-1"))
        self.assertEqual(active["plan_id"], second["plan_id"])

    def test_create_single_operation_plan(self) -> None:
        self._run(self._seed_run("run-1"))
        with patch.object(decision_plans, "async_session", self._session):
            plan = self._run(
                create_single_operation_plan(
                    run_id="run-1",
                    operation=_OP_WRITE,
                    args={"job_id": 3, "status": "picked"},
                    summary="分拣岗位",
                    target={"kind": "job", "id": 3},
                )
            )
        self.assertEqual(plan["status"], "pending")
        self.assertEqual(len(plan["groups"]), 1)
        group = plan["groups"][0]
        self.assertEqual(group["risk_level"], "L3")
        self.assertEqual(len(group["nodes"]), 1)
        node = group["nodes"][0]
        self.assertEqual(node["operation"], _OP_WRITE)
        self.assertEqual(node["status"], "pending")
        self.assertEqual(
            node["args_digest"], canonical_digest(node["args"])
        )

    # ------------------------------------------------------------------
    # decisions
    # ------------------------------------------------------------------

    def _decision_kwargs(self, plan, *, group_index=0, **overrides):
        group = plan["groups"][group_index]
        kwargs = {
            "plan_id": plan["plan_id"],
            "group_id": group["group_id"],
            "decision_id": f"dec-{group['group_id']}",
            "decision": "approve",
            "plan_digest": plan["plan_digest"],
            "group_digest": group["group_digest"],
            "surface": "desktop",
        }
        kwargs.update(overrides)
        return kwargs

    def test_approve_authorizes_nodes_and_replay_returns_stored(self) -> None:
        self._run(self._seed_run("run-1"))
        plan = self._create()
        kwargs = self._decision_kwargs(plan)

        with patch.object(decision_plans, "async_session", self._session):
            result = self._run(record_group_decision(**kwargs))
            replay = self._run(record_group_decision(**kwargs))

        self.assertTrue(result["ok"])
        self.assertFalse(result["replayed"])
        self.assertEqual(result["group_status"], "approved")

        self.assertTrue(replay["replayed"])
        self.assertEqual(replay["decision"], "approve")
        self.assertEqual(replay["decision_id"], kwargs["decision_id"])

        view = self._run(get_decision_plan(plan["plan_id"]))
        node = view["groups"][0]["nodes"][0]
        self.assertEqual(node["status"], "authorized")

    def test_conflicting_replay_rejected(self) -> None:
        self._run(self._seed_run("run-1"))
        plan = self._create()
        kwargs = self._decision_kwargs(plan)

        with patch.object(decision_plans, "async_session", self._session):
            self._run(record_group_decision(**kwargs))
            # Same decision_id, different decision field → fail closed.
            with self.assertRaises(DecisionConflictError):
                self._run(
                    record_group_decision(**{**kwargs, "decision": "reject"})
                )
            # Same decision_id, different digest → fail closed.
            with self.assertRaises(DecisionConflictError):
                self._run(
                    record_group_decision(
                        **{**kwargs, "group_digest": "0" * 64}
                    )
                )
            # New decision_id on an already-decided group → conflict.
            with self.assertRaises(DecisionConflictError):
                self._run(
                    record_group_decision(
                        **{**kwargs, "decision_id": "dec-other"}
                    )
                )

    def test_wrong_digests_and_cross_plan_group_rejected(self) -> None:
        self._run(self._seed_run("run-1"))
        plan = self._create()
        kwargs = self._decision_kwargs(plan)

        with patch.object(decision_plans, "async_session", self._session):
            with self.assertRaises(DecisionConflictError):
                self._run(
                    record_group_decision(
                        **{**kwargs, "plan_digest": "f" * 64}
                    )
                )
            with self.assertRaises(DecisionConflictError):
                self._run(
                    record_group_decision(
                        **{**kwargs, "group_digest": "e" * 64}
                    )
                )
            # Nonexistent plan is a not-found, not a conflict.
            with self.assertRaises(DecisionPlanNotFoundError):
                self._run(
                    record_group_decision(
                        **{
                            **kwargs,
                            "group_id": plan["groups"][1]["group_id"],
                            "plan_id": "plan_nonexistent",
                        }
                    )
                )
            # Group belonging to a different plan is a conflict.
            self._run(self._seed_run("run-9", task_id="task-9"))
            other = self._create(run_id="run-9")
            with self.assertRaises(DecisionConflictError):
                self._run(
                    record_group_decision(
                        **{
                            **kwargs,
                            "plan_id": plan["plan_id"],
                            "group_id": other["groups"][0]["group_id"],
                        }
                    )
                )

    def test_reject_blocks_transitive_dependents(self) -> None:
        self._run(self._seed_run("run-1"))
        plan = self._create(
            groups=[
                {
                    "title": "G0",
                    "risk_level": "L2",
                    "nodes": [
                        {"operation": _OP_READ, "args": {}, "target": {}}
                    ],
                },
                {
                    "title": "G1",
                    "risk_level": "L2",
                    "dependency_indices": [0],
                    "nodes": [
                        {"operation": _OP_READ, "args": {}, "target": {}}
                    ],
                },
                {
                    "title": "G2",
                    "risk_level": "L2",
                    "dependency_indices": [1],
                    "nodes": [
                        {"operation": _OP_READ, "args": {}, "target": {}}
                    ],
                },
            ]
        )
        kwargs = self._decision_kwargs(plan, decision="reject")

        with patch.object(decision_plans, "async_session", self._session):
            result = self._run(record_group_decision(**kwargs))

        self.assertEqual(result["group_status"], "rejected")
        self.assertEqual(result["plan_status"], "rejected")
        blocked = set(result["blocked_group_ids"])
        self.assertEqual(
            blocked,
            {plan["groups"][1]["group_id"], plan["groups"][2]["group_id"]},
        )
        self.assertEqual(len(result["blocked_node_ids"]), 2)
        view = self._run(get_decision_plan(plan["plan_id"]))
        statuses = [group["status"] for group in view["groups"]]
        self.assertEqual(statuses, ["rejected", "blocked", "blocked"])
        node_statuses = [
            node["status"] for group in view["groups"] for node in group["nodes"]
        ]
        self.assertEqual(node_statuses, ["rejected", "blocked", "blocked"])

        with patch.object(decision_plans, "async_session", self._session):
            with self.assertRaises(DecisionConflictError):
                self._run(
                    record_group_decision(
                        **self._decision_kwargs(plan, group_index=1)
                    )
                )

    def test_decision_on_terminal_plan_rejected(self) -> None:
        self._run(self._seed_run("run-1"))
        plan = self._create(
            groups=[
                {
                    "title": "G",
                    "risk_level": "L2",
                    "nodes": [
                        {"operation": _OP_READ, "args": {}, "target": {}}
                    ],
                }
            ]
        )
        kwargs = self._decision_kwargs(plan, decision="reject")
        with patch.object(decision_plans, "async_session", self._session):
            self._run(record_group_decision(**kwargs))
            # Plan is now terminal (all groups rejected) — further decisions fail.
            view = self._run(get_decision_plan(plan["plan_id"]))
            with self.assertRaises(DecisionConflictError):
                self._run(
                    record_group_decision(
                        **{**kwargs, "decision_id": "dec-late"}
                    )
                )
            self.assertIsNone(
                self._run(get_active_decision_plan("run-1"))
            )
            self.assertEqual(view["status"], "rejected")

    # ------------------------------------------------------------------
    # queries
    # ------------------------------------------------------------------

    def test_list_pending_and_get_active(self) -> None:
        self._run(self._seed_run("run-1"))
        self.assertIsNone(self._run(get_active_decision_plan("run-1")))
        plan = self._create()
        active = self._run(get_active_decision_plan("run-1"))
        self.assertEqual(active["plan_id"], plan["plan_id"])
        with patch.object(decision_plans, "async_session", self._session):
            pending = self._run(list_pending_decision_plans())
        self.assertEqual(pending["count"], 1)
        self.assertEqual(pending["plans"][0]["plan_id"], plan["plan_id"])

    def test_get_missing_plan_raises(self) -> None:
        with self.assertRaises(DecisionPlanNotFoundError):
            self._run(get_decision_plan("plan_missing"))


if __name__ == "__main__":
    unittest.main()
