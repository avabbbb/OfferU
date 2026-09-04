from __future__ import annotations

import asyncio
import inspect
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
import uuid
from unittest.mock import AsyncMock, patch

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

BACKEND_DIR = Path(__file__).resolve().parents[1]
os.chdir(BACKEND_DIR)
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from app.database import Base, init_db
from app.models.models import Application, Job
from app.ops import (
    OPERATIONS,
    OperationAuditError,
    execute_operation,
    get_operation_schema,
    list_operations,
)
from app.services.operation_projection import (
    confirm_operation_proposal,
    execute_or_propose_operation,
)
from app.services.agent_operations import (
    create_application,
    list_applications,
    update_application_status,
)
from app.services.application_events import application_event_store


class OperationRegistryTests(unittest.TestCase):
    def test_registry_exposes_expected_atomic_operations(self) -> None:
        expected = {
            "get_profile",
            "list_calendar_events",
            "list_interview_questions",
            "list_agent_runs",
            "list_profile_evidence",
            "add_profile_evidence",
            "list_learning_observations",
            "list_memory_inbox",
            "create_memory_proposal",
            "review_memory_proposal",
            "invalidate_memory_source",
            "consolidate_memory_observations",
            "import_jd",
            "validate_fact_gate",
            "create_application_attempt",
            "list_pools",
            "list_jobs",
            "list_coding_agents",
            "list_batch_job_evaluations",
            "get_batch_job_evaluation",
            "start_batch_job_evaluation",
            "resume_batch_job_evaluation",
            "list_job_research_runs",
            "get_job_research",
            "start_job_research",
            "resume_job_research",
            "get_job",
            "triage_job",
            "batch_triage",
            "prepare_resume_optimization",
            "list_resume_optimizations",
            "get_resume_optimization",
            "review_resume_optimization",
            "inspect_resume_document",
            "list_resumes",
            "get_resume",
            "export_resume_pdf",
            "list_applications",
            "create_application",
            "update_application_status",
            "get_application_workspace",
            "list_application_records",
            "list_application_events",
            "analyze_application_patterns",
            "update_application_record",
            "list_follow_up_cadence",
            "record_follow_up",
            "list_career_artifacts",
            "get_career_artifact",
            "save_career_artifact",
            "generate_cover_letter",
            "job_stats",
            "agent_playbook",
            "workflow_catalog",
            "workflow_plan",
            "create_pool",
            "update_pool",
            "delete_pool",
            "update_job",
            "batch_update_jobs",
            "list_operation_audit",
            "get_current_view",
            "set_current_view",
            "clear_current_view",
        }

        self.assertTrue(expected.issubset(OPERATIONS))
        self.assertEqual(len(OPERATIONS), len(list_operations()))

    def test_operation_schema_contains_agent_metadata(self) -> None:
        schema = get_operation_schema("triage_job")

        self.assertIsNotNone(schema)
        assert schema is not None
        self.assertEqual(schema["name"], "triage_job")
        self.assertEqual(schema["group"], "jobs")
        self.assertEqual(schema["side_effects"], ["write"])
        self.assertTrue(schema["supports_dry_run"])
        self.assertTrue(schema["requires_confirmation"])
        self.assertEqual(schema["parameters"]["job_id"]["type"], "integer")
        self.assertEqual(schema["parameters"]["job_id"]["exclusiveMinimum"], 0)
        self.assertIn("output_contract", schema)
        self.assertEqual(schema["output_contract"]["ok"], "bool")
        self.assertIn("operation_version", schema)

    def test_resume_document_inspection_is_confirmed_and_redacted(self) -> None:
        schema = get_operation_schema("inspect_resume_document")

        self.assertIsNotNone(schema)
        assert schema is not None
        self.assertTrue(schema["requires_confirmation"])
        self.assertEqual(schema["side_effects"], ["external"])
        self.assertEqual(schema["permissions"], ["local_file:read"])
        self.assertEqual(schema["audit_redacted_parameters"], ["file_path"])
        self.assertEqual(schema["audit_redacted_output_parameters"], ["text"])

    def test_control_plane_operations_publish_validated_json_schema(self) -> None:
        for name in {
            "agent_playbook",
            "workflow_catalog",
            "workflow_plan",
            "list_operation_audit",
            "get_current_view",
            "set_current_view",
            "clear_current_view",
            "list_pools",
            "list_jobs",
            "job_stats",
            "triage_job",
            "batch_triage",
            "create_pool",
            "update_pool",
            "delete_pool",
            "update_job",
            "batch_update_jobs",
            "get_profile",
            "inspect_resume_document",
            "list_profile_evidence",
            "add_profile_evidence",
            "list_learning_observations",
            "list_memory_inbox",
            "create_memory_proposal",
            "review_memory_proposal",
            "invalidate_memory_source",
            "consolidate_memory_observations",
            "validate_fact_gate",
            "create_application_attempt",
            "list_applications",
            "create_application",
            "update_application_status",
            "ingest_application_signal",
            "list_application_progress_candidates",
            "get_application_progress_candidate",
            "review_application_progress",
            "get_application_progress_overview",
            "get_application_workspace",
            "list_application_records",
            "list_application_events",
            "analyze_application_patterns",
            "update_application_record",
            "list_follow_up_cadence",
            "record_follow_up",
            "get_job",
            "get_pre_application_state",
            "list_job_research_runs",
            "get_job_research",
            "review_job_research",
            "start_job_research",
            "resume_job_research",
            "cancel_job_research",
            "list_hosted_executor_sessions",
            "get_hosted_executor_session",
            "list_calendar_events",
            "list_interview_questions",
            "list_agent_runs",
        }:
            schema = get_operation_schema(name)
            self.assertIsNotNone(schema)
            assert schema is not None
            self.assertEqual(schema["input_schema"]["type"], "object")
            self.assertFalse(schema["input_schema"]["additionalProperties"])

    def test_every_operation_publishes_a_closed_machine_readable_contract(self) -> None:
        required_output_keys = {
            "ok",
            "operation",
            "operation_version",
            "inputs",
            "outputs",
            "warnings",
            "errors",
            "side_effects",
            "elapsed_ms",
        }

        for name, operation in OPERATIONS.items():
            schema = operation.schema()
            input_schema = schema["input_schema"]

            self.assertIsInstance(input_schema, dict, name)
            self.assertEqual(input_schema.get("type"), "object", name)
            self.assertIs(input_schema.get("additionalProperties"), False, name)
            self.assertIsInstance(input_schema.get("properties"), dict, name)
            self.assertTrue(required_output_keys.issubset(schema["output_contract"]), name)
            self.assertEqual(schema["requires_confirmation"], operation.is_mutation, name)
            self.assertEqual(schema["supports_dry_run"], operation.is_mutation, name)
            self.assertTrue(schema["operation_version"], name)

            if operation.input_model is None:
                parameters = inspect.signature(operation.fn).parameters
                schema_names = set(input_schema["properties"])
                expected_names = {
                    parameter_name
                    for parameter_name, parameter in parameters.items()
                    if parameter.kind
                    not in (inspect.Parameter.VAR_POSITIONAL, inspect.Parameter.VAR_KEYWORD)
                }
                self.assertEqual(schema_names, expected_names, name)
                expected_required = {
                    parameter_name
                    for parameter_name, parameter in parameters.items()
                    if parameter.kind
                    not in (inspect.Parameter.VAR_POSITIONAL, inspect.Parameter.VAR_KEYWORD)
                    and parameter.default is inspect.Parameter.empty
                }
                self.assertEqual(set(input_schema.get("required", [])), expected_required, name)

    def test_application_schema_wire_name_is_preserved_after_reserved_name_fix(self) -> None:
        for name in ("update_application_table_schema", "update_application_template"):
            schema = get_operation_schema(name)
            assert schema is not None
            properties = schema["input_schema"]["properties"]
            self.assertIn("schema", properties)
            self.assertNotIn("schema_", properties)

    def test_application_schema_alias_reaches_operation_as_schema(self) -> None:
        payload = [{"key": "stage", "label": "Stage"}]
        result = asyncio.run(
            execute_operation(
                "update_application_template",
                {"schema": payload},
                dry_run=True,
            )
        )

        self.assertTrue(result["ok"])
        self.assertEqual(result["inputs"]["schema"], payload)
        self.assertNotIn("schema_", result["inputs"])

    def test_unknown_operation_returns_error_envelope(self) -> None:
        result = asyncio.run(execute_operation("does_not_exist", {}))

        self.assertFalse(result["ok"])
        self.assertEqual(result["operation"], "does_not_exist")
        self.assertIn("未知操作", result["errors"][0])

    def test_missing_required_argument_is_rejected_before_execution(self) -> None:
        result = asyncio.run(execute_operation("get_job", {}))

        self.assertFalse(result["ok"])
        self.assertIn("缺少必填参数", result["errors"][0])
        self.assertIn("job_id", result["errors"][0])

    def test_job_triage_schema_rejects_pool_for_non_picked_status(self) -> None:
        result = asyncio.run(
            execute_operation(
                "triage_job",
                {"job_id": 1, "status": "ignored", "pool_id": 2},
                dry_run=True,
            )
        )

        self.assertFalse(result["ok"])
        self.assertIn("pool_id can only be used with status=picked", result["errors"][0])

    def test_job_update_schema_rejects_empty_mutation(self) -> None:
        result = asyncio.run(
            execute_operation(
                "update_job",
                {"job_id": 1},
                dry_run=True,
            )
        )

        self.assertFalse(result["ok"])
        self.assertIn("no update fields provided", result["errors"][0])

    def test_profile_evidence_schema_rejects_unknown_tier(self) -> None:
        result = asyncio.run(
            execute_operation(
                "add_profile_evidence",
                {
                    "section_type": "project",
                    "title": "OfferU",
                    "content_json": {"description": "Local career workspace"},
                    "source_text": "Built a local career workspace named OfferU.",
                    "tier": "agent_guess",
                },
                dry_run=True,
            )
        )

        self.assertFalse(result["ok"])
        self.assertIn("参数校验失败", result["errors"][0])

    def test_memory_review_schema_rejects_unknown_action(self) -> None:
        result = asyncio.run(
            execute_operation(
                "review_memory_proposal",
                {"proposal_id": 1, "action": "auto_accept"},
                dry_run=True,
            )
        )

        self.assertFalse(result["ok"])
        self.assertIn("参数校验失败", result["errors"][0])

    def test_application_signal_schema_rejects_unknown_channel(self) -> None:
        result = asyncio.run(
            execute_operation(
                "ingest_application_signal",
                {
                    "channel": "browser_scrape",
                    "account_ref": "local",
                    "external_message_id": "message-1",
                    "sender": "recruiter@example.com",
                    "subject": "Interview",
                    "body": "We would like to schedule an interview.",
                },
                dry_run=True,
            )
        )

        self.assertFalse(result["ok"])
        self.assertIn("参数校验失败", result["errors"][0])

    def test_application_progress_review_schema_accepts_record_creation_options(self) -> None:
        result = asyncio.run(
            execute_operation(
                "review_application_progress",
                {
                    "candidate_id": "progress_candidate_schema",
                    "action": "accept",
                    "stage": "interview_1",
                    "add_calendar": False,
                    "create_record": True,
                },
                dry_run=True,
                audit=False,
            )
        )

        self.assertTrue(result["ok"])
        self.assertTrue(result["inputs"]["create_record"])
        self.assertFalse(result["inputs"]["add_calendar"])

    def test_application_progress_review_schema_rejects_record_creation_on_reject(self) -> None:
        result = asyncio.run(
            execute_operation(
                "review_application_progress",
                {
                    "candidate_id": "progress_candidate_schema",
                    "action": "reject",
                    "create_record": True,
                },
                dry_run=True,
                audit=False,
            )
        )

        self.assertFalse(result["ok"])
        self.assertIn("create_record", result["errors"][0])

    def test_application_record_schema_rejects_unknown_status(self) -> None:
        result = asyncio.run(
            execute_operation(
                "update_application_record",
                {
                    "record_id": 1,
                    "field_key": "apply_status",
                    "value": "AI 自动通过",
                },
                dry_run=True,
            )
        )

        self.assertFalse(result["ok"])
        self.assertIn("apply_status has an unsupported value", result["errors"][0])

    def test_application_operations_share_the_workspace_record(self) -> None:
        async def run(
            database_path: Path,
        ) -> tuple[dict, dict, bool, list[dict], bool]:
            test_engine = create_async_engine(
                f"sqlite+aiosqlite:///{database_path.as_posix()}"
            )
            test_session = async_sessionmaker(
                test_engine,
                class_=AsyncSession,
                expire_on_commit=False,
            )
            try:
                async with test_engine.begin() as connection:
                    await connection.run_sync(Base.metadata.create_all)
                token = uuid.uuid4().hex
                async with test_session() as db:
                    legacy_job = Job(
                        title=f"Legacy application {token}",
                        company=f"Legacy application company {token}",
                        location="Remote",
                        url=f"https://legacy.jobs.invalid/{token}",
                        apply_url=f"https://legacy.jobs.invalid/{token}/apply",
                        source="unit-test",
                        raw_description="Legacy application collision record",
                        hash_key=f"legacy-{token}",
                        batch_id="legacy-import",
                    )
                    job = Job(
                        title=f"Agent application {token}",
                        company=f"Agent application company {token}",
                        location="Remote",
                        url=f"https://jobs.invalid/{token}",
                        apply_url=f"https://jobs.invalid/{token}/apply",
                        source="unit-test",
                        raw_description="Agent application operation round trip",
                        hash_key=token,
                        batch_id="legacy-import",
                    )
                    db.add_all([legacy_job, job])
                    await db.commit()
                    await db.refresh(legacy_job)
                    await db.refresh(job)
                    job_id = job.id
                    legacy = Application(
                        id=1,
                        job_id=legacy_job.id,
                        status="pending",
                        notes="旧表记录不得被修改",
                    )
                    db.add(legacy)
                    await db.commit()

                with patch(
                    "app.services.agent_operations.async_session",
                    test_session,
                ):
                    created = await create_application(job_id, notes="创建备注")
                    listed = await list_applications(status="pending", page_size=100)
                    listed_before = any(
                        item["id"] == created["id"] and item["job_id"] == job_id
                        for item in listed["items"]
                    )
                    updated = await update_application_status(
                        created["id"],
                        "interview",
                        notes="进入面试",
                    )
                    listed_after = await list_applications(
                        status="interview",
                        page_size=100,
                    )
                    matching = [
                        item
                        for item in listed_after["items"]
                        if item["id"] == created["id"] and item["job_id"] == job_id
                    ]
                async with test_session() as db:
                    legacy = await db.get(Application, 1)
                    legacy_unchanged = bool(
                        legacy
                        and legacy.status == "pending"
                        and legacy.notes == "旧表记录不得被修改"
                        and legacy.job_id == legacy_job.id
                    )
                return created, updated, listed_before, matching, legacy_unchanged
            finally:
                await test_engine.dispose()

        with tempfile.TemporaryDirectory() as temp_dir, patch.object(
            application_event_store,
            "directory",
            Path(temp_dir) / "events",
        ):
            created, updated, listed_before, matching, legacy_unchanged = asyncio.run(
                run(Path(temp_dir) / "application-operations.db")
            )

        self.assertEqual(created["application_type"], "application_record")
        self.assertEqual(created["id"], 1)
        self.assertTrue(listed_before)
        self.assertEqual(updated["id"], created["id"])
        self.assertEqual(updated["application_type"], "application_record")
        self.assertEqual(updated["status"], "interview")
        self.assertEqual(updated["workspace_status"], "面试中")
        self.assertEqual(len(matching), 1)
        self.assertEqual(matching[0]["status"], "interview")
        self.assertEqual(matching[0]["notes"], "进入面试")
        self.assertTrue(legacy_unchanged)

    def test_dry_run_skips_mutating_operation(self) -> None:
        result = asyncio.run(
            execute_operation(
                "triage_job",
                {"job_id": 1, "status": "picked"},
                dry_run=True,
            )
        )

        self.assertTrue(result["ok"])
        self.assertEqual(result["outputs"]["skipped"], True)
        self.assertEqual(result["outputs"]["reason"], "dry_run")
        self.assertEqual(result["side_effects"], ["write"])

    def test_workspace_context_round_trip(self) -> None:
        async def run_round_trip() -> tuple[dict, dict, dict]:
            await init_db()
            scope = "test-context"
            await execute_operation("clear_current_view", {"scope": scope}, audit=False)
            written = await execute_operation(
                "set_current_view",
                {
                    "scope": scope,
                    "route": "/jobs/123",
                    "title": "岗位详情",
                    "entity_type": "job",
                    "entity_id": "123",
                    "selection": {"job_ids": [123]},
                    "filters": {"triage_status": "picked"},
                    "context": {"source": "unit-test"},
                    "updated_by": "test",
                },
                audit=False,
            )
            read_back = await execute_operation("get_current_view", {"scope": scope}, audit=False)
            cleared = await execute_operation("clear_current_view", {"scope": scope}, audit=False)
            return written, read_back, cleared

        written, read_back, cleared = asyncio.run(run_round_trip())

        self.assertTrue(written["ok"])
        self.assertEqual(written["outputs"]["route"], "/jobs/123")
        self.assertEqual(read_back["outputs"]["entity_type"], "job")
        self.assertEqual(read_back["outputs"]["selection"], {"job_ids": [123]})
        self.assertTrue(cleared["outputs"]["cleared"])

    def test_audit_failure_is_visible_in_operation_envelope(self) -> None:
        with patch(
            "app.ops._record_audit",
            new=AsyncMock(side_effect=OperationAuditError("forced audit failure")),
        ):
            result = asyncio.run(execute_operation("get_current_view", {}))

        self.assertFalse(result["ok"])
        self.assertIn("forced audit failure", " ".join(result["errors"]))
        self.assertIn("审计完整性失败已显式暴露。", result["warnings"])


class CliBlackBoxTests(unittest.TestCase):
    def run_cli(self, *args: str) -> dict:
        completed = subprocess.run(
            [sys.executable, "-m", "app.cli", *args],
            check=False,
            capture_output=True,
            cwd=BACKEND_DIR,
            text=True,
        )
        try:
            payload = json.loads(completed.stdout)
        except json.JSONDecodeError as exc:  # pragma: no cover - failure diagnostic
            self.fail(f"CLI did not print JSON: {exc}; stdout={completed.stdout!r}; stderr={completed.stderr!r}")
        payload["_exit_code"] = completed.returncode
        return payload

    def test_doctor_reports_cli_health(self) -> None:
        payload = self.run_cli("doctor")

        self.assertEqual(payload["_exit_code"], 0)
        self.assertTrue(payload["ok"])
        self.assertEqual(payload["service"], "OfferU CLI")
        self.assertEqual(payload["operation_count"], len(OPERATIONS))
        self.assertEqual(payload["resume_import"]["formats"], ["pdf", "docx"])
        self.assertEqual(payload["resume_import"]["max_file_size_mb"], 10)
        self.assertIn("configured", payload["resume_import"]["ocr"])
        self.assertFalse(payload["safety"]["auto_submit_applications"])
        self.assertEqual(payload["backend"]["runtime"], "python")
        self.assertEqual(payload["frontend"]["url"], "http://127.0.0.1:7410")
        self.assertTrue(payload["agent_providers"])
        self.assertIn(payload["data_safety"]["status"], {"ready", "failed", "unavailable"})
        self.assertIn("integrity_check", payload["data_safety"])

    def test_ops_lists_machine_readable_operation_metadata(self) -> None:
        payload = self.run_cli("ops")

        self.assertEqual(payload["_exit_code"], 0)
        names = {item["name"] for item in payload["operations"]}
        self.assertIn("list_jobs", names)
        self.assertIn("prepare_resume_optimization", names)
        self.assertIn("list_resume_optimizations", names)
        self.assertIn("get_resume_optimization", names)
        self.assertIn("review_resume_optimization", names)
        self.assertNotIn("generate_resume", names)

    def test_routes_is_not_an_agent_capability(self) -> None:
        payload = self.run_cli("routes")

        self.assertEqual(payload["_exit_code"], 2)
        self.assertFalse(payload["ok"])

    def test_api_is_not_an_agent_capability(self) -> None:
        payload = self.run_cli("api", "GET", "/api/health")

        self.assertEqual(payload["_exit_code"], 2)
        self.assertFalse(payload["ok"])

    def test_manifest_exposes_cc_control_contract(self) -> None:
        payload = self.run_cli("manifest")

        self.assertEqual(payload["_exit_code"], 0)
        self.assertTrue(payload["ok"])
        self.assertEqual(payload["service"], "OfferU CLI")
        self.assertIn("run_operation", payload["commands"])
        self.assertIn("workflow_plan", payload["commands"])
        self.assertEqual(payload["io_contract"]["stdout"], "single JSON object")
        self.assertEqual(payload["operation_count"], len(OPERATIONS))
        self.assertFalse(payload["safety"]["auto_submit_applications"])
        self.assertFalse(payload["safety"]["raw_api_capability"])
        self.assertNotIn("call_get_api", payload["commands"])
        self.assertNotIn("call_write_api", payload["commands"])
        self.assertNotIn("list_routes", payload["commands"])
        self.assertIn("confirm_proposal", payload["commands"])

    def test_agent_playbook_exposes_external_agent_contract(self) -> None:
        payload = self.run_cli("run", "agent_playbook", "--arg", "detail=full")

        self.assertEqual(payload["_exit_code"], 0)
        self.assertTrue(payload["ok"])
        outputs = payload["outputs"]
        self.assertIn("OfferU external-agent", outputs["role"])
        self.assertIn("workflow_plan", outputs["commands"])
        self.assertIn("daily_review", outputs["workflow_names"])
        self.assertIn("workflows", outputs)

    def test_workflow_catalog_lists_builtin_workflows(self) -> None:
        payload = self.run_cli("run", "workflow_catalog")

        self.assertEqual(payload["_exit_code"], 0)
        self.assertTrue(payload["ok"])
        names = {item["name"] for item in payload["outputs"]["workflows"]}
        self.assertIn("daily_review", names)
        self.assertIn("batch_triage", names)
        self.assertIn("tailored_resume", names)

    def test_workflow_plan_returns_atomic_cli_commands(self) -> None:
        payload = self.run_cli("run", "workflow_plan", "--arg", "goal=批量筛选岗位", "--arg", "limit=7")

        self.assertEqual(payload["_exit_code"], 0)
        self.assertTrue(payload["ok"])
        outputs = payload["outputs"]
        self.assertEqual(outputs["workflow"], "batch_triage")
        self.assertTrue(outputs["commands"])
        self.assertTrue(all(command.startswith("python -m app.cli run ") for command in outputs["commands"]))
        self.assertIn("--dry-run", outputs["commands"][-1])
        list_jobs_step = next(step for step in outputs["steps"] if step["operation"] == "list_jobs")
        self.assertEqual(list_jobs_step["args"]["page_size"], 7)

    def test_workflow_plan_rejects_unknown_goal(self) -> None:
        payload = self.run_cli("run", "workflow_plan", "--arg", "goal=完全无关目标")

        self.assertEqual(payload["_exit_code"], 1)
        self.assertFalse(payload["ok"])
        self.assertIn("unsupported workflow goal", payload["errors"][0])

    def test_schema_unknown_operation_exits_non_zero(self) -> None:
        payload = self.run_cli("schema", "missing_operation")

        self.assertEqual(payload["_exit_code"], 1)
        self.assertFalse(payload["ok"])
        self.assertIn("未知操作", payload["errors"][0])

    def test_run_accepts_key_value_args_and_dry_run(self) -> None:
        payload = self.run_cli(
            "run",
            "triage_job",
            "--arg",
            "job_id=1",
            "--arg",
            "status=picked",
            "--dry-run",
        )

        self.assertEqual(payload["_exit_code"], 0)
        self.assertTrue(payload["ok"])
        self.assertEqual(payload["inputs"], {"job_id": 1, "status": "picked"})
        self.assertTrue(payload["outputs"]["skipped"])

    def test_mutation_creates_persisted_proposal_then_confirms_once(self) -> None:
        proposal = self.run_cli(
            "run",
            "set_current_view",
            "--arg",
            "scope=cli-control-plane-test",
            "--arg",
            "route=/jobs/42",
        )

        self.assertEqual(proposal["_exit_code"], 0)
        self.assertTrue(proposal["ok"])
        self.assertFalse(proposal["outputs"]["executed"])
        run_id = proposal["outputs"]["proposal"]["run_id"]
        action_id = proposal["outputs"]["proposal"]["action_id"]

        first = self.run_cli("confirm", run_id, "--action", action_id)
        second = self.run_cli("confirm", run_id, "--action", action_id)

        self.assertEqual(first["_exit_code"], 0)
        self.assertTrue(first["ok"])
        self.assertEqual(first["run"]["status"], "completed")
        self.assertEqual(len(first["tool_calls"]), 1)
        self.assertEqual(second["_exit_code"], 0)
        self.assertTrue(second["ok"])
        self.assertEqual(second["tool_calls"], [])

    def test_run_accepts_json_like_key_value_list(self) -> None:
        payload = self.run_cli(
            "run",
            "batch_triage",
            "--arg",
            "job_ids=[1,2,3]",
            "--arg",
            "status=picked",
            "--dry-run",
        )

        self.assertEqual(payload["_exit_code"], 0)
        self.assertTrue(payload["ok"])
        self.assertEqual(payload["inputs"]["job_ids"], [1, 2, 3])
        self.assertTrue(payload["outputs"]["skipped"])

    def test_run_accepts_input_file_and_arg_override(self) -> None:
        input_file = BACKEND_DIR / "tmp_cli_args.json"
        input_file.write_text(json.dumps({"job_id": 1, "status": "ignored"}), encoding="utf-8")
        try:
            payload = self.run_cli(
                "run",
                "triage_job",
                "--input",
                str(input_file),
                "--arg",
                "status=picked",
                "--dry-run",
            )
        finally:
            input_file.unlink(missing_ok=True)

        self.assertEqual(payload["_exit_code"], 0)
        self.assertTrue(payload["ok"])
        self.assertEqual(payload["inputs"], {"job_id": 1, "status": "picked"})
        self.assertTrue(payload["outputs"]["skipped"])

    def test_run_accepts_powershell_utf8_bom_input_file(self) -> None:
        input_file = BACKEND_DIR / "tmp_cli_args_bom.json"
        input_file.write_text(json.dumps({"job_id": 1, "status": "picked"}), encoding="utf-8-sig")
        try:
            payload = self.run_cli(
                "run",
                "triage_job",
                "--input",
                str(input_file),
                "--dry-run",
            )
        finally:
            input_file.unlink(missing_ok=True)

        self.assertEqual(payload["_exit_code"], 0)
        self.assertTrue(payload["ok"])
        self.assertEqual(payload["inputs"], {"job_id": 1, "status": "picked"})
        self.assertTrue(payload["outputs"]["skipped"])

    def test_run_rejects_malformed_json_args(self) -> None:
        payload = self.run_cli("run", "list_jobs", "--args", "not-json")

        self.assertEqual(payload["_exit_code"], 1)
        self.assertFalse(payload["ok"])
        self.assertIn("--args", payload["errors"][0])

    def test_run_rejects_missing_input_file(self) -> None:
        payload = self.run_cli("run", "list_jobs", "--input", "missing-file.json")

        self.assertEqual(payload["_exit_code"], 1)
        self.assertFalse(payload["ok"])
        self.assertIn("--input", payload["errors"][0])

    def test_no_command_returns_json_error(self) -> None:
        payload = self.run_cli()

        self.assertEqual(payload["_exit_code"], 2)
        self.assertFalse(payload["ok"])
        self.assertIn("缺少命令", payload["errors"][0])

    def test_unknown_command_returns_json_error(self) -> None:
        payload = self.run_cli("missing_command")

        self.assertEqual(payload["_exit_code"], 2)
        self.assertFalse(payload["ok"])
        self.assertTrue(payload["errors"])

    def test_run_missing_operation_name_returns_json_error(self) -> None:
        payload = self.run_cli("run")

        self.assertEqual(payload["_exit_code"], 2)
        self.assertFalse(payload["ok"])
        self.assertTrue(payload["errors"])

    def test_unknown_flag_returns_json_error(self) -> None:
        payload = self.run_cli("run", "list_jobs", "--bad-flag")

        self.assertEqual(payload["_exit_code"], 2)
        self.assertFalse(payload["ok"])
        self.assertTrue(payload["errors"])

    def test_malformed_arg_pair_returns_json_error(self) -> None:
        payload = self.run_cli("run", "list_jobs", "--arg", "not-a-pair")

        self.assertEqual(payload["_exit_code"], 1)
        self.assertFalse(payload["ok"])
        self.assertIn("--arg", payload["errors"][0])


class OperationProjectionSafetyTests(unittest.TestCase):
    def test_protected_surface_cannot_execute_mutation_directly(self) -> None:
        async def run() -> dict:
            await init_db()
            return await execute_operation(
                "set_current_view",
                {"scope": "blocked-direct-mcp", "route": "/unsafe"},
                surface="mcp",
            )

        result = asyncio.run(run())

        self.assertFalse(result["ok"])
        self.assertFalse(result["outputs"]["executed"])
        self.assertTrue(result["outputs"]["requires_confirmation"])

    def test_projection_persists_then_executes_exactly_once(self) -> None:
        async def run() -> tuple[dict, dict, dict]:
            await init_db()
            proposal = await execute_or_propose_operation(
                "set_current_view",
                {"scope": "projection-test", "route": "/jobs/99"},
                surface="mcp",
            )
            proposal_data = proposal["outputs"]["proposal"]
            first = await confirm_operation_proposal(
                proposal_data["run_id"],
                action_id=proposal_data["action_id"],
                surface="mcp",
            )
            second = await confirm_operation_proposal(
                proposal_data["run_id"],
                action_id=proposal_data["action_id"],
                surface="mcp",
            )
            return proposal, first, second

        proposal, first, second = asyncio.run(run())

        self.assertTrue(proposal["ok"])
        self.assertFalse(proposal["outputs"]["executed"])
        self.assertTrue(first["ok"])
        self.assertEqual(len(first["tool_calls"]), 1)
        self.assertTrue(second["ok"])
        self.assertEqual(second["tool_calls"], [])

    def test_confirm_unknown_persisted_proposal_fails(self) -> None:
        result = asyncio.run(
            confirm_operation_proposal("missing", surface="mcp")
        )

        self.assertFalse(result["ok"])
        self.assertIn("不存在", result["errors"][0])


if __name__ == "__main__":
    unittest.main()
