"""Contract tests for the actual migrated loop; scripted streams are fixtures, not live Agent evidence."""
from __future__ import annotations

import asyncio
import hashlib
import json
import sys
from pathlib import Path
from types import SimpleNamespace
from typing import Any
from unittest.mock import AsyncMock, patch
from uuid import uuid4

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.agent.provider import LlmStreamProvider, ScriptedStreamProvider
from app.agent.types import TextContent, ToolCallContent
from app.agent.messages import create_text_message
from app.database import async_session, init_db
from app.models.models import Job, OperationAuditLog
from app.ops import OPERATIONS
from app.services import ui_approval_capability
from app.services import embedded_agent_host as host
from app.services.agent_run_state import create_agent_run, list_agent_run_events, load_agent_run, save_agent_run
from app.services.embedded_agent_worker import EmbeddedAgentWorker, EmbeddedAgentWorkerError

RUN_ID = "run_0123456789abcdef"


def test_provider_masks_remote_pii_and_restores_local_tool_arguments():
    async def flow():
        async def create(**kwargs):
            encoded = json.dumps(kwargs["messages"])
            assert "13912345678" not in encoded
            assert "fixture@example.test" not in encoded
            import re
            placeholder = re.search(r"\[__PII_EMAIL_[^\]]+\]", encoded)[0]
            async def chunks():
                yield {"choices": [{"delta": {"tool_calls": [{"index": 0, "id": "call_pii", "function": {
                    "name": "read_contact", "arguments": json.dumps({"email": placeholder})}}]}}]}
            return chunks()
        client = SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=AsyncMock(side_effect=create))), close=AsyncMock())
        provider = LlmStreamProvider(client_factory=lambda: (client, "fixture-model"))
        with patch("app.agent.provider.resolve_llm_client_config", return_value={"provider": "fixture", "api_format": "openai"}), patch("app.agent.provider.configured_model_for_tier", return_value="fixture-model"):
            events = [event async for event in provider.stream("", [create_text_message("13912345678 fixture@example.test")], [])]
        call = next(block for block in events[-1].message.content if isinstance(block, ToolCallContent))
        assert call.arguments == {"email": "fixture@example.test"}
        assert "fixture@example.test" not in json.dumps([event.delta for event in events])
        await provider.close()
        client.close.assert_awaited_once()
    asyncio.run(flow())


def test_native_anthropic_fragments_and_provider_error_fail_closed():
    async def flow():
        class Stream:
            def __init__(self, events): self.events, self.closed = events, False
            async def __aiter__(self):
                for event in self.events: yield event
            async def close(self): self.closed = True
        stream = Stream([
            {"type": "content_block_start", "index": 1, "content_block": {"type": "tool_use", "id": "native_call", "name": "read_job"}},
            {"type": "content_block_delta", "index": 1, "delta": {"type": "input_json_delta", "partial_json": '{"job_id":'}},
            {"type": "content_block_delta", "index": 1, "delta": {"type": "input_json_delta", "partial_json": '7}'}},
            {"type": "message_delta", "delta": {"stop_reason": "tool_use"}},
        ])
        client = SimpleNamespace(messages=SimpleNamespace(create=AsyncMock(return_value=stream)))
        provider = LlmStreamProvider()
        events = [event async for event in provider.stream_chunks(provider._anthropic_chunks(client, "fixture", [{"role": "user", "content": "Read job"}], []), "fixture", "fixture")]
        assert stream.closed
        assert events[-1].message.stop_reason == "tool_calls"
        call = next(block for block in events[-1].message.content if isinstance(block, ToolCallContent))
        assert call.id == "native_call" and call.arguments == {"job_id": 7}
        failed = Stream([{"type": "error", "error": {"message": "provider failed sk-fixture123456789"}}])
        client.messages.create.return_value = failed
        events = [event async for event in provider.stream_chunks(provider._anthropic_chunks(client, "fixture", [], []), "fixture", "fixture")]
        assert failed.closed and events[-1].type == "error"
        assert "sk-fixture123456789" not in events[-1].message.error_message
    asyncio.run(flow())


class SequenceProvider:
    def __init__(self, scripts):
        self.scripts = scripts
        self.calls = 0
        self.prompts = []

    async def stream(self, system_prompt, messages, tools, cancel=None):
        self.calls += 1
        self.prompts.append(list(messages))
        script = self.scripts.pop(0)
        async for event in ScriptedStreamProvider(script).stream(system_prompt, messages, tools, cancel=cancel):
            yield event

    async def close(self):
        pass


async def _seed_reviewable_resume(job_suffix: str) -> dict[str, Any]:
    """Seed a canonical resume proposal for the Plan-to-receipt kernel smoke."""

    from sqlalchemy import select
    from sqlalchemy.orm import selectinload
    from app.models.models import Profile, ProfileSection, Resume, ResumeOptimizationProposal, ResumeSection
    from app.services.resume_optimization import _profile_snapshot_hash, _sha256
    from app.services.resume_workspace import workspace_content_hash

    description = "A product role requiring reliable workflow testing."
    change_ids = [f"change-{job_suffix}-experience", f"change-{job_suffix}-project"]
    async with async_session() as db:
        profile = Profile(name=f"Plan kernel smoke {job_suffix}", is_default=False)
        job = Job(
            title="Evidence-backed Product Role",
            company=f"Kernel smoke company {job_suffix}",
            raw_description=description,
            hash_key=hashlib.sha256(job_suffix.encode("utf-8")).hexdigest(),
        )
        db.add_all([profile, job])
        await db.flush()
        evidence_rows = [
            ProfileSection(
                profile_id=profile.id,
                section_type=section_type,
                title=title,
                tier="verified_fact",
                status="active",
                content_json={"normalized": {"description": evidence}},
            )
            for section_type, title, evidence in (
                ("experience", "Verified workflow", "Built a CI test workflow"),
                ("project", "Verified coverage", "Expanded automated test coverage"),
            )
        ]
        db.add_all(evidence_rows)
        await db.flush()
        resume = Resume(
            user_name=profile.name,
            title="Master resume",
            summary="Original summary",
            source_mode="manual",
            is_primary=True,
            source_profile_id=profile.id,
        )
        db.add(resume)
        await db.flush()
        before_rows = [
            {
                "section_type": section_type,
                "title": title,
                "sort_order": index,
                "visible": True,
                "source_section_ids": [evidence_rows[index].id],
                "content_json": [{"description": before}],
            }
            for index, (section_type, title, before) in enumerate((
                ("experience", "Project Experience", "Maintained a CI workflow"),
                ("project", "Quality Improvements", "Added test coverage"),
            ))
        ]
        after_rows = [
            {
                **before,
                "content_json": [{"description": after}],
            }
            for before, after in zip(before_rows, ("Built a CI test workflow", "Expanded automated test coverage"))
        ]
        sections = [
            ResumeSection(
                resume_id=resume.id,
                section_type=row["section_type"],
                title=row["title"],
                sort_order=row["sort_order"],
                visible=True,
                source_section_ids=row["source_section_ids"],
                content_json=row["content_json"],
            )
            for row in before_rows
        ]
        db.add_all(sections)
        await db.flush()
        resume = (await db.execute(
            select(Resume).options(selectinload(Resume.sections)).where(Resume.id == resume.id)
        )).scalar_one()
        proposal = ResumeOptimizationProposal(
            proposal_id=f"resume_opt_kernel_{job_suffix}",
            job_id=job.id,
            profile_id=profile.id,
            research_run_id=None,
            status="ready",
            source_section_ids_json=[row.id for row in evidence_rows],
            source_snapshot_hash=_profile_snapshot_hash(evidence_rows),
            research_snapshot_hash="0" * 64,
            original_rows_json=before_rows,
            proposed_rows_json=after_rows,
            diff_json=[
                {
                    "change_id": change_id,
                    "change_type": "modified",
                    "section_key": f"{row['section_type']}:{row['title']}",
                    "section_type": row["section_type"],
                    "title": row["title"],
                    "source_section_ids": row["source_section_ids"],
                    "before": row,
                    "after": after,
                }
                for change_id, row, after in zip(change_ids, before_rows, after_rows)
            ],
            strategy_json={"job_description_sha256": _sha256(description)},
            fact_gates_json={"status": "passed"},
            workspace_resume_id=resume.id,
            workspace_snapshot_hash=workspace_content_hash(resume),
        )
        db.add(proposal)
        await db.commit()
        return {
            "job_id": int(job.id),
            "profile_id": int(profile.id),
            "resume_id": int(resume.id),
            "proposal_id": proposal.proposal_id,
            "change_ids": change_ids,
            "expected_after": [row["content_json"][0]["description"] for row in after_rows],
        }


def start(worker, directory, runner, **kwargs):
    return worker.start_run(run_id=RUN_ID, system_prompt="Only Registry tools may be used.", provider={},
        session_directory=str(directory), operation_runner=runner, allowed_operations=[
            {"name": "read_job", "input_schema": {"type": "object", "properties": {"job_id": {"type": "integer"}}}}
        ], **kwargs)


def test_source_loop_selects_registry_tools_and_persists_session(tmp_path):
    async def flow():
        provider = SequenceProvider([[{"type": "tool_call", "name": "read_job", "arguments": {"job_id": 7}}],
                                     [{"type": "text", "text": "Job 7 verified."}]])
        worker = EmbeddedAgentWorker(provider_factory=lambda: provider)
        runner = AsyncMock(return_value={"ok": True, "outputs": {"id": 7}})
        events = []
        async def emit(event): events.append(event)
        await start(worker, tmp_path, runner, event_listener=emit)
        result = await worker.prompt(run_id=RUN_ID, message="Read job 7")
        assert result["assistant_message"] == "Job 7 verified."
        runner.assert_awaited_once_with("read_job", {"job_id": 7})
        assert any(event["event"] == "tool.started" for event in events)
        stored = json.loads((tmp_path / f"{RUN_ID}.json").read_text())
        assert stored["messages"][-1]["content"][0]["text"] == "Job 7 verified."
        assert "api_key" not in stored
        await worker.dispose_run(RUN_ID)
        resumed = EmbeddedAgentWorker(provider_factory=lambda: SequenceProvider([[{"type": "text", "text": "Resumed."}]]))
        await start(resumed, tmp_path, runner, session_file=str(tmp_path / f"{RUN_ID}.json"))
        assert (await resumed.prompt(run_id=RUN_ID, message="Continue"))["assistant_message"] == "Resumed."
        await resumed.close()
    asyncio.run(flow())


@pytest.mark.parametrize("read_before_ask", [False, True])
def test_ask_stops_remaining_tools_and_model_turn_even_after_a_read(tmp_path, read_before_ask):
    async def flow():
        calls = [{"type": "tool_call", "name": "request_user_input", "arguments": {}}]
        if read_before_ask:
            calls.insert(0, {"type": "tool_call", "name": "read_job", "arguments": {"job_id": 7}})
        calls.append({"type": "tool_call", "name": "read_job", "arguments": {"job_id": 8}})
        provider = SequenceProvider([calls, [{"type": "text", "text": "Must not run before user answer"}]])
        worker = EmbeddedAgentWorker(provider_factory=lambda: provider)
        runner = AsyncMock(return_value={"ok": True, "outputs": {"id": 7}})
        ask = AsyncMock(return_value={"ok": True, "terminate": True})
        try:
            await start(worker, tmp_path, runner, host_tools=[{
                "name": "request_user_input", "description": "Ask the user",
                "input_schema": {"type": "object", "properties": {}}, "execute": ask,
            }])
            await worker.prompt(run_id=RUN_ID, message="Read, then ask before continuing")
            assert provider.calls == 1
            ask.assert_awaited_once()
            if read_before_ask:
                runner.assert_awaited_once_with("read_job", {"job_id": 7})
            else:
                runner.assert_not_awaited()
            stored = json.loads((tmp_path / f"{RUN_ID}.json").read_text())
            assert "Skipped because the tool paused this Run" in json.dumps(stored)
        finally:
            await worker.close()
    asyncio.run(flow())


def test_unknown_model_tool_cannot_reach_registry(tmp_path):
    async def flow():
        provider = SequenceProvider([[{"type": "tool_call", "name": "hidden_shell", "arguments": {}}],
                                     [{"type": "text", "text": "Unavailable."}]])
        worker = EmbeddedAgentWorker(provider_factory=lambda: provider)
        runner = AsyncMock()
        await start(worker, tmp_path, runner)
        await worker.prompt(run_id=RUN_ID, message="Do something")
        runner.assert_not_awaited()
        await worker.close()
    asyncio.run(flow())


def test_session_path_and_version_fail_closed(tmp_path):
    async def flow():
        worker = EmbeddedAgentWorker()
        with pytest.raises(EmbeddedAgentWorkerError, match="runtime directory"):
            await start(worker, tmp_path, AsyncMock(), session_file=str(tmp_path.parent / f"{RUN_ID}.json"))
        path = tmp_path / f"{RUN_ID}.json"
        path.write_text(json.dumps({"version": 999, "run_id": RUN_ID, "messages": []}))
        with pytest.raises(EmbeddedAgentWorkerError, match="version/identity"):
            await start(worker, tmp_path, AsyncMock(), session_file=str(path))
        assert worker.active_run_id is None
    asyncio.run(flow())


def test_legacy_pi_run_is_preserved_and_cannot_be_replayed(tmp_path):
    async def flow():
        await init_db()
        legacy = tmp_path / "old-pi-session.jsonl"
        legacy.write_text('{"legacy":true}\n', encoding="utf-8")
        run = await create_agent_run(conversation_id="legacy-fixture", goal="Read jobs", mode="general", actions=[],
            llm_runtime={"runtime": "pi_sdk_worker", "session_file": str(legacy)})
        run["status"] = "interrupted"
        await save_agent_run(run)
        worker = EmbeddedAgentWorker()
        with pytest.raises(ValueError, match="旧 Pi 会话"):
            await host.resume_embedded_agent_run(run["id"], worker=worker)
        assert legacy.read_text(encoding="utf-8") == '{"legacy":true}\n'
        assert (await load_agent_run(run["id"]))["status"] == "interrupted"
        assert worker.active_run_id is None
    asyncio.run(flow())


def test_cancel_interrupts_a_stalled_provider(tmp_path):
    async def flow():
        ready = asyncio.Event()
        class StalledProvider:
            async def stream(self, *args, **kwargs):
                ready.set()
                await asyncio.Future()
                yield
        worker = EmbeddedAgentWorker(provider_factory=StalledProvider)
        await start(worker, tmp_path, AsyncMock())
        task = asyncio.create_task(worker.prompt(run_id=RUN_ID, message="Wait"))
        await ready.wait()
        await worker.abort_run(RUN_ID)
        assert task.cancelled()
        await worker.dispose_run(RUN_ID)
        assert worker.active_run_id is None
    asyncio.run(flow())


def test_provider_assembles_fragmented_calls_and_reports_stream_failure():
    async def flow():
        chunks = [{"choices": [{"delta": {"tool_calls": [{"index": 0, "id": "call-1", "function": {"name": "read_job", "arguments": '{"job_'}}]}}]},
                  {"choices": [{"delta": {"tool_calls": [{"index": 0, "function": {"arguments": 'id":7}'}}]}, "finish_reason": "tool_calls"}]}]
        events = [event async for event in LlmStreamProvider().stream_chunks(chunks, provider="fixture", model="fixture")]
        call = next(block for block in events[-1].message.content if isinstance(block, ToolCallContent))
        assert call.arguments == {"job_id": 7}
        async def failed():
            yield {"choices": [{"delta": {"content": "partial"}}]}
            raise RuntimeError("api_key=canary-secret-value")
        errors = [event async for event in LlmStreamProvider().stream_chunks(failed(), provider="fixture", model="fixture")]
        assert errors[-1].type == "error"
        assert "canary-secret-value" not in errors[-1].message.error_message
    asyncio.run(flow())


def test_source_kernel_stages_resume_batch_and_continues_same_run_after_native_group_decision(
    tmp_path, monkeypatch
):
    """Scripted provider verifies the migration seam, not live Agent behavior."""

    async def flow():
        await init_db()
        seed = await _seed_reviewable_resume(uuid4().hex)
        intent_id = "review-displayed-resume-changes"
        stage_args = {
            "title": "Review the prepared resume changes",
            "intents": [{
                "id": intent_id,
                "operation": "review_resume_proposal_items",
                "args": {
                    "proposal_id": seed["proposal_id"],
                    "resume_id": seed["resume_id"],
                    "change_ids": seed["change_ids"],
                    "action": "accept",
                },
                "summary": "Accept both displayed changes as one resume review operation",
            }],
            "groups": [{
                "id": "resume-review",
                "title": "Accept the displayed resume changes",
                "rationale": "The existing batch review operation applies the exact displayed change IDs together.",
                "summary": "Accept the two evidence-backed resume changes",
                "node_ids": [intent_id],
            }],
        }
        provider = SequenceProvider([
            [{"type": "tool_call", "name": "prepare_proposal_plan", "arguments": stage_args}],
            [{"type": "text", "text": "Both approved resume changes were verified from the Registry receipt."}],
        ])
        worker = EmbeddedAgentWorker(provider_factory=lambda: provider)
        config = ({"name": "fixture", "model": "fixture"}, {"runtime": "python_agent", "provider_id": "embedded"})
        native_token = f"plan-smoke-{uuid4().hex}"
        authorization_header = f"Bearer {native_token}"
        accepts_fixture_authorization = lambda header: header == authorization_header
        monkeypatch.setattr(ui_approval_capability, "accepts_authorization", accepts_fixture_authorization)
        from app.models.models import ResumeOptimizationProposal, ResumeSection
        from app.routes import main_agent
        from app.routes.main_agent import ProposalPlanDecisionRequest, decide_proposal_plan_group_endpoint
        from app.services.proposal_plan_store import get_plan, list_plans
        from app.services import embedded_agent_worker as embedded_worker_module
        from app.services.operation_projection import confirm_operation_proposal
        from fastapi import HTTPException
        from sqlalchemy import select

        # Both module-level references must observe the same fake UI capability;
        # this also survives test suites that reload the capability module.
        monkeypatch.setattr(main_agent, "accepts_authorization", accepts_fixture_authorization)
        monkeypatch.setattr(embedded_worker_module, "get_embedded_agent_worker", lambda: worker)
        with patch.object(host, "_SESSION_DIRECTORY", tmp_path), patch.object(
            host, "_prepare_guardian_advice", new=AsyncMock(return_value=({}, None))
        ), patch.object(host, "resolve_embedded_provider_config", return_value=config):
            initial = await host.start_embedded_agent_run(
                message="Review the prepared resume changes for this role.",
                skill_id="tailor_resume",
                worker=worker,
                provider_config=config[0],
                provider_metadata=config[1],
            )
            assert initial["ok"], initial
            assert initial["run"]["status"] == "waiting_confirmation"
            plans = await list_plans(run_id=initial["run"]["id"])
            assert len(plans) == 1
            plan = plans[0]
            group = plan["groups"][0]
            assert plan["run_id"] == initial["run"]["id"]
            assert len(group["nodes"]) == 1
            node = group["nodes"][0]
            assert node["operation"] == "review_resume_proposal_items"
            assert node["args"]["change_ids"] == seed["change_ids"]
            assert len(node["display"]["changes"]) == len(seed["change_ids"])
            digestless = await confirm_operation_proposal(
                initial["run"]["id"], action_id=node["id"], surface="agent_runtime_ui",
                authorization_source=authorization_header,
            )
            assert not digestless["ok"]
            assert "Plan snapshot" in digestless["errors"][0]
            with pytest.raises(HTTPException) as missing_bearer:
                await decide_proposal_plan_group_endpoint(
                    plan["id"], group["id"],
                    ProposalPlanDecisionRequest(
                        approve=True, plan_digest=plan["digest"], group_digest=group["digest"],
                        decision_id=f"decision_{uuid4().hex}",
                    ),
                    authorization="",
                )
            assert missing_bearer.value.status_code == 403
            with pytest.raises(HTTPException) as unauthorized:
                await decide_proposal_plan_group_endpoint(
                    plan["id"], group["id"],
                    ProposalPlanDecisionRequest(
                        approve=True, plan_digest=plan["digest"], group_digest=group["digest"],
                        decision_id=f"decision_{uuid4().hex}",
                    ),
                    authorization="Bearer guessed-token",
                )
            assert unauthorized.value.status_code == 403
            assert (await get_plan(plan["id"]))["groups"][0]["status"] == "pending"

            decision = ProposalPlanDecisionRequest(
                approve=True,
                plan_digest=plan["digest"],
                group_digest=group["digest"],
                decision_id=f"decision_{uuid4().hex}",
            )
            confirmed = await decide_proposal_plan_group_endpoint(
                plan["id"], group["id"], decision, authorization=authorization_header
            )
            assert confirmed["ok"] and confirmed["approved"], confirmed
            assert confirmed["continuation"]["status"] == "delivered"
            assert confirmed["run_status"] == "completed"
            assert provider.calls == 2
            continuation_messages = [
                block.text
                for message in provider.prompts[-1]
                if getattr(message, "role", "") == "user"
                for block in getattr(message, "content", [])
                if isinstance(block, TextContent)
            ]
            assert any("Outbox ID:" in text and "Receipts:" in text for text in continuation_messages)

            async with async_session() as db:
                proposal = await db.get(ResumeOptimizationProposal, seed["proposal_id"])
                sections = list((await db.execute(
                    select(ResumeSection).where(ResumeSection.resume_id == seed["resume_id"])
                )).scalars().all())
                audits = list((await db.execute(
                    select(OperationAuditLog).where(OperationAuditLog.idempotency_key == node["idempotency_key"])
                )).scalars().all())
            assert {
                change_id: proposal.item_reviews_json[change_id]["action"]
                for change_id in seed["change_ids"]
            } == {change_id: "accept" for change_id in seed["change_ids"]}
            assert [row.content_json[0]["description"] for row in sorted(sections, key=lambda row: row.sort_order)] == seed["expected_after"]
            assert len(audits) == 1 and audits[0].operation == "review_resume_proposal_items" and audits[0].ok

            duplicate = await decide_proposal_plan_group_endpoint(
                plan["id"], group["id"], decision, authorization=authorization_header
            )
            assert duplicate["ok"] and duplicate["approved"] and duplicate["duplicate"]
            assert provider.calls == 2
            assert len(await list_agent_run_events(initial["run"]["id"])) > 0
            accepted = [
                event for event in await list_agent_run_events(initial["run"]["id"])
                if event["type"] == "continuation.accepted"
            ]
            assert len(accepted) == 1
            assert accepted[0]["payload"]["receiver"] == "python_agent_session"
            assert accepted[0]["payload"]["receipt_ids"]
            assert all(receipt_id in "\n".join(continuation_messages) for receipt_id in accepted[0]["payload"]["receipt_ids"])
            from app.services.proposal_plan_store import get_node_authorization
            authorization = await get_node_authorization(node["id"])
            assert authorization["decision"]["authorization_source"] == "desktop-ui"
            assert native_token not in json.dumps(authorization)
            stored_plan = await get_plan(plan["id"])
            assert stored_plan["status"] == "completed"
            assert (await load_agent_run(initial["run"]["id"]))["status"] == "completed"
        await worker.close()

    asyncio.run(flow())
