from __future__ import annotations

import asyncio
import tempfile
import unittest
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

from sqlalchemy import event, select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.database import Base
from app.models.models import (
    AgentRunRecord, Job, JobSearchTask, OperationAuditLog, ProposalConfirmationDecision,
    ProposalContinuation, ProposalExecutionPlan,
)
from app.services import proposal_plan_store as store
from app.services.proposal_plan_builder import build_plan, canonical_digest, plan_material


class ProposalPlanStoreTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        db_path = (Path(self.temp.name) / "proposal-plan-store.db").as_posix()
        self.engine = create_async_engine(f"sqlite+aiosqlite:///{db_path}", connect_args={"timeout": 15})

        @event.listens_for(self.engine.sync_engine, "connect")
        def _enable_foreign_keys(connection, _record):  # noqa: ANN001
            connection.execute("PRAGMA foreign_keys=ON")

        self.factory = async_sessionmaker(self.engine, expire_on_commit=False)
        asyncio.run(self._initialize())
        self.patcher = patch.object(store, "async_session", self.factory)
        self.patcher.start()

    def tearDown(self) -> None:
        self.patcher.stop()
        asyncio.run(self.engine.dispose())
        self.temp.cleanup()

    async def _initialize(self) -> None:
        async with self.engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)
        async with self.factory() as db, db.begin():
            db.add(JobSearchTask(task_id="task-store"))
            await db.flush()
            db.add(AgentRunRecord(run_id="run-store", task_id="task-store"))

    def _run(self, coroutine):
        return asyncio.run(coroutine)

    def _plan(self) -> dict:
        return build_plan(
            [
                {
                    "id": "answer-intent",
                    "operation": "submit_career_answer",
                    "args": {
                        "task_id": "task-store",
                        "question_index": 0,
                        "answer": "Use verified work evidence",
                        "proposal_id": None,
                    },
                    "summary": "Save an evidence-backed answer",
                }
            ],
            run_id="run-store",
            title="Prepare the application answer",
        )

    def _decision(self, plan: dict, decision: str = "approve") -> dict:
        event_id = f"decision_{uuid.uuid4().hex}"
        group = plan["groups"][0]
        return {
            "id": event_id,
            "event_id": event_id,
            "plan_id": plan["id"],
            "group_id": group["id"],
            "plan_digest": plan["digest"],
            "group_digest": group["digest"],
            "decision": decision,
            "authorization_source": "desktop-ui",
            "surface": "desktop",
        }

    def test_decision_duplicate_claim_cas_checkpoint_and_outbox_delivery(self) -> None:
        async def exercise() -> None:
            plan = await store.create_plan(self._plan())
            group = plan["groups"][0]
            decision = self._decision(plan)
            first = await store.record_decision(decision)
            replay = await store.record_decision(decision)
            self.assertFalse(first["duplicate"])
            self.assertTrue(replay["duplicate"])
            self.assertEqual(first["decision"]["authorization_source"], "desktop-ui")

            node_id = group["nodes"][0]["id"]
            claims = await asyncio.gather(
                store.claim_node(node_id, claim_id="attempt-a", lease_seconds=30),
                store.claim_node(node_id, claim_id="attempt-b", lease_seconds=30),
            )
            won = [claim for claim in claims if claim is not None]
            self.assertEqual(len(won), 1)
            claim = won[0]
            checkpoint = await store.checkpoint_node(
                node_id,
                claim_id=claim["claim_id"],
                status="completed",
                effect_state="committed",
                result={"accepted": True},
                audit_ref="audit:proposal-test",
            )
            self.assertEqual(checkpoint["node"]["status"], "completed")
            self.assertEqual(checkpoint["receipt"]["effect_identity"], claim["effect_identity"])
            self.assertEqual(checkpoint["receipt"]["attempt_id"], claim["claim_id"])

            saved = await store.get_plan(plan["id"])
            self.assertEqual(saved["groups"][0]["status"], "completed")
            self.assertEqual(saved["groups"][0]["nodes"][0]["args"], group["nodes"][0]["args"])
            outbox = await store.list_continuations(run_id="run-store")
            self.assertEqual(len(outbox), 1)
            self.assertEqual(outbox[0]["receipt_ids"], [checkpoint["receipt"]["id"]])
            claimed = await store.claim_continuation(outbox[0]["id"], claim_id="delivery-a")
            self.assertEqual(claimed["status"], "delivering")
            finished = await store.finish_continuation(
                outbox[0]["id"], claim_id="delivery-a", status="delivered"
            )
            self.assertEqual(finished["status"], "delivered")
            duplicate = await store.create_continuation(
                {
                    "run_id": "run-store",
                    "group_id": group["id"],
                    "receipt_ids": [checkpoint["receipt"]["id"]],
                }
            )
            self.assertTrue(duplicate["duplicate"])
            self.assertEqual(duplicate["continuation"]["status"], "delivered")

        self._run(exercise())

    def test_concurrent_group_decisions_have_one_cas_winner(self) -> None:
        async def exercise() -> None:
            plan = await store.create_plan(self._plan())
            approve = self._decision(plan, "approve")
            reject = self._decision(plan, "reject")

            async def choose(value: dict):
                try:
                    return await store.record_decision(value)
                except store.ProposalDecisionConflictError as exc:
                    return exc

            results = await asyncio.gather(choose(approve), choose(reject))
            winners = [item for item in results if isinstance(item, dict)]
            losers = [item for item in results if isinstance(item, store.ProposalDecisionConflictError)]
            self.assertEqual(len(winners), 1)
            self.assertEqual(len(losers), 1)
            async with self.factory() as db:
                decisions = (
                    await db.execute(
                        select(ProposalConfirmationDecision).where(
                            ProposalConfirmationDecision.plan_id == plan["id"]
                        )
                    )
                ).scalars().all()
                self.assertEqual(len(decisions), 1)

        self._run(exercise())

    def test_continuation_lease_renewal_is_live_only_and_fenced(self) -> None:
        async def exercise() -> None:
            plan = await store.create_plan(self._plan())
            await store.record_decision(self._decision(plan))
            node = plan["groups"][0]["nodes"][0]
            claim = await store.claim_node(node["id"], claim_id="node-attempt")
            await store.checkpoint_node(node["id"], claim_id=claim["claim_id"],
                status="completed", effect_state="committed", result={"ok": True}, audit_ref="201")
            outbox = (await store.list_continuations("run-store"))[0]
            original = await store.claim_continuation(outbox["id"], claim_id="live-delivery", lease_seconds=60)
            original_deadline = original["lease_until"]
            self.assertTrue(await store.renew_continuation_claim(
                outbox["id"], claim_id="live-delivery", lease_seconds=120
            ))
            extended = (await store.list_continuations("run-store"))[0]
            self.assertGreater(extended["lease_until"], original_deadline)

            async with self.factory() as db, db.begin():
                row = await db.get(ProposalContinuation, outbox["id"])
                row.lease_until = datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(seconds=1)
            self.assertFalse(await store.renew_continuation_claim(
                outbox["id"], claim_id="live-delivery", lease_seconds=120
            ))
            replacement = await store.claim_continuation(outbox["id"], claim_id="replacement-delivery")
            self.assertIsNotNone(replacement)
            with self.assertRaises(store.ProposalNodeClaimConflictError):
                await store.finish_continuation(outbox["id"], claim_id="live-delivery", status="delivered")
            finished = await store.finish_continuation(
                outbox["id"], claim_id="replacement-delivery", status="delivered"
            )
            self.assertEqual(finished["status"], "delivered")

        self._run(exercise())

    def test_outbox_claim_ack_is_receipt_set_scoped_and_retry_keeps_audit_history(self) -> None:
        async def exercise() -> None:
            intents = [
                {"id": "intent-one", "operation": "submit_career_answer",
                 "args": {"task_id": "task-store", "question_index": 0,
                          "answer": "First answer", "proposal_id": None},
                 "summary": "First bounded answer"},
                {"id": "intent-two", "operation": "submit_career_answer",
                 "args": {"task_id": "task-store", "question_index": 1,
                          "answer": "Second answer", "proposal_id": None},
                 "summary": "Second bounded answer"},
            ]
            plan = build_plan(intents, run_id="run-store", title="Prepare two answers",
                              groups=[{"id": "answers", "title": "Answers",
                                       "node_ids": ["intent-one", "intent-two"]}])
            saved = await store.create_plan(plan)
            group = saved["groups"][0]
            decision_result = await store.record_decision(self._decision(saved))
            confirmed_decision_id = decision_result["decision"]["id"]

            first = group["nodes"][0]
            first_claim = await store.claim_node(first["id"], claim_id="first-attempt")
            first_done = await store.checkpoint_node(first["id"], claim_id="first-attempt",
                status="completed", effect_state="committed", result={"value": 1}, audit_ref="101")
            outbox = (await store.list_continuations("run-store"))[0]
            self.assertIsNone(await store.claim_continuation(outbox["id"], claim_id="too-early"))

            second = group["nodes"][1]
            retry_claim = await store.claim_node(second["id"], claim_id="failed-attempt")
            audit_key = second["idempotency_key"]
            confirmation_ref = f"proposal-v2:{confirmed_decision_id}:{second['id']}:failed-attempt"
            async with self.factory() as db, db.begin():
                audit = OperationAuditLog(
                    operation=second["operation"], operation_version=second["operation_version"],
                    surface="agent", status="failed", confirmation_ref=confirmation_ref,
                    idempotency_key=audit_key, ok=False, dry_run=False,
                    side_effects=["write"], inputs_json=second["args"], outputs_json={},
                    warnings_json=[], errors_json=["transient"], elapsed_ms=1.0,
                )
                db.add(audit)
                await db.flush()
                audit_ref = str(audit.id)
                self.assertEqual(audit.confirmation_ref, confirmation_ref)
                self.assertEqual(audit.idempotency_key, audit_key)
                self.assertEqual(audit.operation, second["operation"])
                self.assertEqual(audit.operation_version, second["operation_version"])
                self.assertEqual(audit.status, "failed")
                self.assertIs(audit.ok, False)
            witness = {"verified": True, "complete": True,
                       "before_versions": {"resume:1": "v1"},
                       "after_versions": {"resume:1": "v1"}, "effects": []}
            second_failed = await store.checkpoint_node(second["id"],
                claim_id=retry_claim["claim_id"], status="failed", effect_state="no_effect",
                result={"source_evidence": witness, "audit_attempt_key": audit_key},
                audit_ref=audit_ref, error="OperationalError: temporary Registry error")
            self.assertEqual(second_failed["receipt"]["status"], "failed")
            self.assertEqual(second_failed["receipt"]["error"], "OperationalError: temporary Registry error")
            outbox = (await store.list_continuations("run-store"))[0]
            delivery = await store.claim_continuation(outbox["id"], claim_id="delivery-one")
            self.assertEqual(set(delivery["delivery_receipt_ids"]),
                             {first_done["receipt"]["id"], second_failed["receipt"]["id"]})
            self.assertEqual(delivery["claimed_receipt_ids"], delivery["delivery_receipt_ids"])
            self.assertTrue(delivery["delivery_key"])
            self.assertTrue(await store.renew_continuation_claim(
                outbox["id"], claim_id="delivery-one", lease_seconds=120
            ))

            evidence = {"receipt_id": second_failed["receipt"]["id"], "audit_ref": audit_ref,
                        "audit_attempt_key": audit_key, "decision_id": confirmed_decision_id,
                        "source_evidence": witness,
                        "registry_failure": {"stage": "execute", "transient": True}}
            resolved = await store.resolve_node_reconciliation(second["id"],
                effect_state="no_effect", evidence=evidence)
            self.assertEqual(resolved["node"]["status"], "pending")
            duplicate_resolution = await store.resolve_node_reconciliation(second["id"],
                effect_state="no_effect", evidence=evidence)
            self.assertTrue(duplicate_resolution["duplicate"])

            finished = await store.finish_continuation(outbox["id"], claim_id="delivery-one", status="delivered")
            self.assertEqual(finished["status"], "pending")
            self.assertEqual(set(finished["delivered_receipt_ids"]),
                             {first_done["receipt"]["id"], second_failed["receipt"]["id"]})
            self.assertEqual(finished["delivery_receipt_ids"], [resolved["receipt"]["id"]])

            retried = await store.claim_node(second["id"], claim_id="successful-retry")
            second_done = await store.checkpoint_node(second["id"], claim_id="successful-retry",
                status="completed", effect_state="committed", result={"value": 2}, audit_ref="102")
            history = (await store.get_plan(saved["id"]))["groups"][0]["nodes"][1]["receipts"]
            self.assertEqual(len(history), 3)
            self.assertEqual([receipt["status"] for receipt in history], ["failed", "reconciled", "completed"])
            outbox = (await store.list_continuations("run-store"))[0]
            self.assertEqual(outbox["status"], "pending")
            delivery2 = await store.claim_continuation(outbox["id"], claim_id="delivery-two")
            self.assertEqual(set(delivery2["delivery_receipt_ids"]),
                             {resolved["receipt"]["id"], second_done["receipt"]["id"]})
            async with self.factory() as db, db.begin():
                row = await db.get(ProposalContinuation, outbox["id"])
                row.lease_until = datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(seconds=1)
            self.assertFalse(await store.renew_continuation_claim(
                outbox["id"], claim_id="delivery-two", lease_seconds=120
            ))
            replacement_claim = await store.claim_continuation(outbox["id"], claim_id="delivery-three")
            self.assertEqual(replacement_claim["status"], "delivering")
            finished = await store.finish_continuation(
                outbox["id"], claim_id="delivery-three", status="delivered"
            )
            self.assertEqual(finished["status"], "delivered")

        self._run(exercise())

    def test_recovery_marks_live_claim_unknown_but_checkpoint_gap_paused(self) -> None:
        async def exercise() -> None:
            plan = build_plan(
                [
                    {"id": "intent-one", "operation": "submit_career_answer",
                     "args": {"task_id": "task-store", "question_index": 0, "answer": "A", "proposal_id": None}},
                    {"id": "intent-two", "operation": "submit_career_answer",
                     "args": {"task_id": "task-store", "question_index": 1, "answer": "B", "proposal_id": None}},
                ], run_id="run-store", title="Recover between checkpoints",
                groups=[{"id": "answers", "title": "Answers", "node_ids": ["intent-one", "intent-two"]}],
            )
            plan = await store.create_plan(plan)
            await store.record_decision(self._decision(plan))
            node = plan["groups"][0]["nodes"][0]
            claimed = await store.claim_node(node["id"], claim_id="crashed-live-attempt")
            unknown = await store.recover_executing_nodes("run-store")
            self.assertEqual(unknown["needs_reconciliation"], 1)
            binding = await store.get_node_authorization(node["id"])
            self.assertEqual(binding["node"]["status"], "uncertain")
            self.assertEqual(binding["receipt"]["effect_state"], "unknown")
            self.assertIsNone(await store.claim_node(node["id"], claim_id="must-not-replay"))

            # A completed checkpoint followed by process exit is known state,
            # so recovery pauses the group without adding an unknown receipt.
            second_plan = build_plan(
                [{"id": "intent-one", "operation": "submit_career_answer",
                  "args": {"task_id": "task-store", "question_index": 2, "answer": "C", "proposal_id": None}},
                 {"id": "intent-two", "operation": "submit_career_answer",
                  "args": {"task_id": "task-store", "question_index": 1, "answer": "D", "proposal_id": None}}],
                run_id="run-store", title="Recover after checkpoint",
                groups=[{"id": "answers", "title": "Answers", "node_ids": ["intent-one", "intent-two"]}],
            )
            second_plan = await store.create_plan(second_plan)
            await store.record_decision(self._decision(second_plan))
            first_node = second_plan["groups"][0]["nodes"][0]
            claim = await store.claim_node(first_node["id"], claim_id="done-before-crash")
            await store.checkpoint_node(first_node["id"], claim_id=claim["claim_id"],
                status="completed", effect_state="committed", result={"value": 3}, audit_ref="103")
            recovered = await store.recover_executing_nodes("run-store")
            self.assertEqual(recovered["paused_between_nodes"], 1)
            saved = await store.get_plan(second_plan["id"])
            self.assertEqual(saved["groups"][0]["status"], "paused")
            self.assertEqual(saved["groups"][0]["nodes"][0]["receipts"][0]["effect_state"], "committed")
            self.assertEqual(saved["groups"][0]["nodes"][1]["status"], "pending")

        self._run(exercise())

    def test_replace_unexecuted_groups_preserves_completed_history_and_is_idempotent(self) -> None:
        async def exercise() -> None:
            async with self.factory() as db, db.begin():
                from app.services import proposal_plan_sources
                job = Job(title="Initial source", company="Example", hash_key="refresh-chain-job")
                db.add(job)
                await db.flush()
                job_id = job.id
                source_ref = f"job:{job_id}"
                source_before = canonical_digest(await proposal_plan_sources._source(db, "job", str(job_id)))
            first_intent = {"id": "first", "operation": "submit_career_answer",
                "args": {"task_id": "task-store", "question_index": 0, "answer": "First", "proposal_id": None},
                "summary": "First answer", "source_versions": {source_ref: source_before},
                "affected_entities": [{"kind": "job", "id": str(job_id), "title": "Initial source"}]}
            second_intent = {"id": "second", "operation": "submit_career_answer",
                "args": {"task_id": "task-store", "question_index": 1, "answer": "Second", "proposal_id": None},
                "summary": "Second answer", "source_versions": {source_ref: source_before},
                "affected_entities": [{"kind": "job", "id": str(job_id), "title": "Initial source"}]}
            old = await store.create_plan(build_plan([first_intent, second_intent],
                run_id="run-store", title="Two answers", groups=[
                    {"id": "first-group", "title": "First answer", "summary": "First rationale",
                     "node_ids": ["first"]},
                    {"id": "second-group", "title": "Second answer", "summary": "Second rationale",
                     "node_ids": ["second"]},
                ]))
            first_group, pending_group = old["groups"]
            decision = await store.record_decision(self._decision(old))
            node = first_group["nodes"][0]
            claim = await store.claim_node(node["id"], claim_id="completed-parent-attempt")
            # Synthetic repository fixture: models one committed source effect
            # and its matching audited before/after witness. It is not Agent E2E.
            async with self.factory() as db, db.begin():
                audit = OperationAuditLog(
                    operation=node["operation"], operation_version=node["operation_version"],
                    surface="agent", status="completed",
                    confirmation_ref=f"proposal-v2:{decision['decision']['id']}:{node['id']}:{claim['claim_id']}",
                    idempotency_key=node["idempotency_key"], ok=True, dry_run=False,
                    side_effects=["write"], inputs_json=node["args"], outputs_json={},
                    warnings_json=[], errors_json=[], elapsed_ms=1.0,
                )
                db.add(audit)
                await db.flush()
                audit_id = str(audit.id)
                from app.services import proposal_plan_sources
                job = await db.get(Job, job_id)
                job.title = "Committed parent source"
                await db.flush()
                source_after = canonical_digest(await proposal_plan_sources._source(db, "job", str(job_id)))
            witness = {"verified": True, "complete": True,
                       "before_versions": {source_ref: source_before},
                       "after_versions": {source_ref: source_after},
                       "effects": [{"source": source_ref, "action": "update"}]}
            parent_result = await store.checkpoint_node(node["id"], claim_id=claim["claim_id"],
                status="completed", effect_state="committed",
                result={"source_evidence": witness, "value": "accepted"}, audit_ref=audit_id)
            parent_receipt_id = parent_result["receipt"]["id"]
            old_effect_identity = parent_result["node"]["effect_identity"]

            refreshed_second_intent = {**second_intent, "source_versions": {source_ref: source_after},
                "affected_entities": [{"kind": "job", "id": job_id, "title": "Committed parent source"}]}
            replacement = build_plan([refreshed_second_intent], run_id="run-store", title="Refreshed answers",
                groups=[{"id": "refreshed-second", "title": "Second answer",
                         "summary": "Second rationale", "node_ids": ["second"]}])
            replacement.update(revision=old["revision"] + 1,
                               lineage_id=old["lineage_id"], parent_plan_id=old["id"],
                               refresh_from={"plan_id": old["id"], "group_ids": [pending_group["id"]],
                                             "completed_receipt_ids": [parent_receipt_id]})
            replacement["digest"] = canonical_digest(plan_material(replacement))
            tampered_intent = {**refreshed_second_intent,
                               "args": {**second_intent["args"], "answer": "Changed answer"}}
            tampered = build_plan([tampered_intent], run_id="run-store", title="Tampered refresh",
                groups=[{"id": "tampered-second", "title": "Second answer",
                         "summary": "Second rationale", "node_ids": ["second"]}])
            tampered.update(revision=old["revision"] + 1, lineage_id=old["lineage_id"],
                parent_plan_id=old["id"], refresh_from=replacement["refresh_from"])
            tampered["digest"] = canonical_digest(plan_material(tampered))
            with self.assertRaises(store.ProposalPlanConflictError):
                await store.replace_unexecuted_groups(old["id"], tampered,
                    group_ids=[pending_group["id"]], completed_receipt_ids=[parent_receipt_id],
                    expected_sources={source_ref: source_after})
            self.assertEqual((await store.get_plan(old["id"]))["groups"][1]["status"], "pending")
            changed_target_intent = {**refreshed_second_intent,
                "affected_entities": [{"kind": "job", "id": job_id + 1,
                                      "title": "Committed parent source"}]}
            changed_target = build_plan([changed_target_intent], run_id="run-store",
                title="Changed target", groups=[{"id": "changed-target", "title": "Second answer",
                    "summary": "Second rationale", "node_ids": ["second"]}])
            changed_target.update(revision=old["revision"] + 1, lineage_id=old["lineage_id"],
                parent_plan_id=old["id"], refresh_from=replacement["refresh_from"])
            changed_target["digest"] = canonical_digest(plan_material(changed_target))
            with self.assertRaises(store.ProposalPlanConflictError):
                await store.replace_unexecuted_groups(old["id"], changed_target,
                    group_ids=[pending_group["id"]], completed_receipt_ids=[parent_receipt_id],
                    expected_sources={source_ref: source_after})
            refreshed, concurrent_replay = await asyncio.gather(
                store.replace_unexecuted_groups(old["id"], replacement,
                    group_ids=[pending_group["id"]], completed_receipt_ids=[parent_receipt_id],
                    expected_sources={source_ref: source_after}),
                store.replace_unexecuted_groups(old["id"], replacement,
                    group_ids=[pending_group["id"]], completed_receipt_ids=[parent_receipt_id],
                    expected_sources={source_ref: source_after}),
            )
            self.assertEqual(concurrent_replay["id"], refreshed["id"])
            self.assertEqual(refreshed["status"], "sealed")
            self.assertEqual(refreshed["snapshot"]["refresh_from"], replacement["refresh_from"])
            self.assertEqual(refreshed["groups"][0]["status"], "pending")
            self.assertEqual(refreshed["groups"][0]["affected_entities"],
                [{"kind": "job", "id": job_id, "title": "Committed parent source"}])

            old_after = await store.get_plan(old["id"])
            self.assertEqual(old_after["status"], "completed")
            self.assertEqual(old_after["groups"][0]["status"], "completed")
            self.assertEqual(old_after["groups"][0]["nodes"][0]["effect_identity"], old_effect_identity)
            self.assertEqual(old_after["groups"][0]["nodes"][0]["receipt_id"], parent_receipt_id)
            self.assertEqual(old_after["groups"][1]["status"], "replaced")
            self.assertEqual(old_after["groups"][1]["nodes"][0]["status"], "blocked")
            self.assertEqual(old_after["groups"][1]["nodes"][0]["receipt_ids"], [])

            replay = await store.replace_unexecuted_groups(old["id"], replacement,
                group_ids=[pending_group["id"]], completed_receipt_ids=[parent_receipt_id],
                expected_sources={source_ref: source_after})
            self.assertEqual(replay["id"], refreshed["id"])

        self._run(exercise())

    def test_replace_unexecuted_groups_rejects_foreign_source_edit_without_receipt_witness(self) -> None:
        async def exercise() -> None:
            async with self.factory() as db, db.begin():
                job = Job(title="Initial source", company="Example", hash_key="refresh-source-job")
                db.add(job)
                await db.flush()
                job_id = job.id
                from app.services import proposal_plan_sources
                source_before = canonical_digest(await proposal_plan_sources._source(db, "job", str(job_id)))
            source_ref = f"job:{job_id}"
            completed_intent = {"id": "completed", "operation": "submit_career_answer",
                "args": {"task_id": "task-store", "question_index": 0, "answer": "Done", "proposal_id": None},
                "summary": "Completed source-empty operation"}
            pending_intent = {"id": "pending", "operation": "submit_career_answer",
                "args": {"task_id": "task-store", "question_index": 1, "answer": "Pending", "proposal_id": None},
                "summary": "Pending source-bound operation", "source_versions": {source_ref: source_before}}
            old = await store.create_plan(build_plan([completed_intent, pending_intent],
                run_id="run-store", title="Mixed completed and pending",
                groups=[{"id": "done", "title": "Done", "node_ids": ["completed"]},
                        {"id": "pending", "title": "Pending", "node_ids": ["pending"]}]))
            completed_group, pending_group = old["groups"]
            decision = await store.record_decision(self._decision(old))
            completed_node = completed_group["nodes"][0]
            claim = await store.claim_node(completed_node["id"], claim_id="source-empty-parent")
            async with self.factory() as db, db.begin():
                audit = OperationAuditLog(
                    operation=completed_node["operation"], operation_version=completed_node["operation_version"],
                    surface="agent", status="completed",
                    confirmation_ref=f"proposal-v2:{decision['decision']['id']}:{completed_node['id']}:{claim['claim_id']}",
                    idempotency_key=completed_node["idempotency_key"], ok=True, dry_run=False,
                    side_effects=["write"], inputs_json=completed_node["args"], outputs_json={},
                    warnings_json=[], errors_json=[], elapsed_ms=1.0,
                )
                db.add(audit)
                await db.flush()
                audit_id = str(audit.id)
            # This completed fixture deliberately has no source witness.
            completed = await store.checkpoint_node(completed_node["id"], claim_id=claim["claim_id"],
                status="completed", effect_state="committed", result={"done": True}, audit_ref=audit_id)
            receipt_id = completed["receipt"]["id"]
            async with self.factory() as db, db.begin():
                job = await db.get(Job, job_id)
                job.title = "Foreign edit after Plan snapshot"
            async with self.factory() as db:
                source_after = canonical_digest(await proposal_plan_sources._source(db, "job", str(job_id)))
            refreshed_intent = {**pending_intent, "source_versions": {source_ref: source_after}}
            replacement = build_plan([refreshed_intent], run_id="run-store", title="Foreign hash refresh",
                groups=[{"id": "pending-refresh", "title": "Pending", "summary": "Pending",
                         "node_ids": ["pending"]}])
            replacement.update(revision=old["revision"] + 1, lineage_id=old["lineage_id"],
                parent_plan_id=old["id"],
                refresh_from={"plan_id": old["id"], "group_ids": [pending_group["id"]],
                              "completed_receipt_ids": [receipt_id]})
            replacement["digest"] = canonical_digest(plan_material(replacement))
            # The DB hash matches expected_sources, but no committed receipt
            # links old H0 to foreign H1, so the refresh must fail closed.
            with self.assertRaises(store.ProposalStaleSnapshotError):
                await store.replace_unexecuted_groups(old["id"], replacement,
                    group_ids=[pending_group["id"]], completed_receipt_ids=[receipt_id],
                    expected_sources={source_ref: source_after})
            current = await store.get_plan(old["id"])
            self.assertEqual(current["groups"][0]["status"], "completed")
            self.assertEqual(current["groups"][1]["status"], "pending")
            self.assertEqual(await store.list_plans(run_id="run-store"), [current])

        self._run(exercise())

    def test_legacy_status_migration_is_fail_safe_and_idempotent(self) -> None:
        async def exercise() -> None:
            valid_args = {
                "task_id": "task-store",
                "question_index": 0,
                "answer": "A bounded draft answer",
                "proposal_id": None,
            }
            steps = [
                {"id": "legacy-pending", "tool": "submit_career_answer", "args": valid_args,
                 "summary": "pending proposal", "status": "waiting_confirmation"},
                {"id": "legacy-redacted", "tool": "submit_career_answer",
                 "args": {**valid_args, "answer": "[redacted]"}, "status": "pending"},
                {"id": "legacy-running", "tool": "submit_career_answer", "args": valid_args,
                 "summary": "running", "status": "executing"},
                {"id": "legacy-unknown", "tool": "submit_career_answer", "args": valid_args,
                 "summary": "unknown", "status": "uncertain"},
                {"id": "legacy-completed", "status": "completed"},
                {"id": "legacy-failed", "status": "failed"},
                {"id": "legacy-rejected", "status": "rejected"},
            ]
            async with self.factory() as db:
                run = await db.get(AgentRunRecord, "run-store")
                run.steps_json = steps
                await db.commit()
            first = await store.migrate_legacy_proposals(run_id="run-store")
            self.assertEqual(
                first,
                {"imported": 1, "preserved": 3, "needs_review": 1, "reconciliation": 2},
            )
            plans = await store.list_plans(run_id="run-store")
            self.assertEqual(len(plans), 3)
            self.assertEqual(
                sorted(plan["status"] for plan in plans),
                ["needs_reconciliation", "needs_reconciliation", "sealed"],
            )
            self.assertEqual(
                await store.migrate_legacy_proposals(run_id="run-store"),
                {"imported": 0, "preserved": 0, "needs_review": 0, "reconciliation": 0},
            )
            async with self.factory() as db:
                run = await db.get(AgentRunRecord, "run-store")
                self.assertEqual(run.steps_json, steps)
                self.assertEqual(
                    await db.scalar(
                        select(ProposalConfirmationDecision.id).where(
                            ProposalConfirmationDecision.plan_id.in_([plan["id"] for plan in plans])
                        )
                    ),
                    None,
                )

        self._run(exercise())


if __name__ == "__main__":
    unittest.main()
