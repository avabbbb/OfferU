from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path
import subprocess
import sys
import unittest

BACKEND_DIR = Path(__file__).resolve().parents[1]
os.chdir(BACKEND_DIR)
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from app.database import init_db
from app.ops import OPERATIONS, execute_operation, get_operation_schema, list_operations
from app.routes.agent import _execute_tool, confirm_agent_operation, AgentConfirmRequest


class OperationRegistryTests(unittest.TestCase):
    def test_registry_exposes_expected_atomic_operations(self) -> None:
        expected = {
            "get_profile",
            "list_profile_evidence",
            "add_profile_evidence",
            "list_learning_observations",
            "list_memory_inbox",
            "create_memory_proposal",
            "review_memory_proposal",
            "invalidate_memory_source",
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

        self.assertEqual(expected, set(OPERATIONS))
        self.assertEqual(len(expected), len(list_operations()))

    def test_operation_schema_contains_agent_metadata(self) -> None:
        schema = get_operation_schema("triage_job")

        self.assertIsNotNone(schema)
        assert schema is not None
        self.assertEqual(schema["name"], "triage_job")
        self.assertEqual(schema["group"], "jobs")
        self.assertEqual(schema["side_effects"], ["write"])
        self.assertTrue(schema["supports_dry_run"])
        self.assertTrue(schema["requires_confirmation"])
        self.assertEqual(schema["parameters"]["job_id"], "int")
        self.assertIn("output_contract", schema)
        self.assertEqual(schema["output_contract"]["ok"], "bool")
        self.assertIn("operation_version", schema)

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

    def test_dry_run_skips_mutating_operation(self) -> None:
        result = asyncio.run(
            execute_operation(
                "triage_job",
                {"job_id": 1, "status": "screened"},
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
        self.assertFalse(payload["safety"]["auto_submit_applications"])

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

    def test_routes_lists_fastapi_control_surface(self) -> None:
        payload = self.run_cli("routes")

        self.assertEqual(payload["_exit_code"], 0)
        self.assertTrue(payload["ok"])
        paths = {item["path"] for item in payload["routes"]}
        self.assertIn("/api/health", paths)
        self.assertIn("/api/jobs/", paths)
        self.assertGreater(payload["route_count"], len(OPERATIONS))

    def test_api_get_executes_against_internal_app(self) -> None:
        payload = self.run_cli("api", "GET", "/api/health")

        self.assertEqual(payload["_exit_code"], 0)
        self.assertTrue(payload["ok"])
        self.assertTrue(payload["executed"])
        self.assertEqual(payload["status_code"], 200)
        self.assertEqual(payload["outputs"]["service"], "OfferU")

    def test_api_post_requires_execute_flag(self) -> None:
        payload = self.run_cli("api", "POST", "/api/agent/confirm", "--field", "proposal_id=missing")

        self.assertEqual(payload["_exit_code"], 0)
        self.assertTrue(payload["ok"])
        self.assertFalse(payload["executed"])
        self.assertTrue(payload["requires_execute"])

    def test_api_post_execute_calls_internal_app(self) -> None:
        payload = self.run_cli(
            "api",
            "POST",
            "/api/agent/confirm",
            "--field",
            "proposal_id=missing",
            "--execute",
        )

        self.assertEqual(payload["_exit_code"], 1)
        self.assertFalse(payload["ok"])
        self.assertTrue(payload["executed"])
        self.assertEqual(payload["status_code"], 404)

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
            "status=screened",
            "--dry-run",
        )

        self.assertEqual(payload["_exit_code"], 0)
        self.assertTrue(payload["ok"])
        self.assertEqual(payload["inputs"], {"job_id": 1, "status": "screened"})
        self.assertTrue(payload["outputs"]["skipped"])

    def test_run_accepts_json_like_key_value_list(self) -> None:
        payload = self.run_cli(
            "run",
            "batch_triage",
            "--arg",
            "job_ids=[1,2,3]",
            "--arg",
            "status=screened",
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
                "status=screened",
                "--dry-run",
            )
        finally:
            input_file.unlink(missing_ok=True)

        self.assertEqual(payload["_exit_code"], 0)
        self.assertTrue(payload["ok"])
        self.assertEqual(payload["inputs"], {"job_id": 1, "status": "screened"})
        self.assertTrue(payload["outputs"]["skipped"])

    def test_run_accepts_powershell_utf8_bom_input_file(self) -> None:
        input_file = BACKEND_DIR / "tmp_cli_args_bom.json"
        input_file.write_text(json.dumps({"job_id": 1, "status": "screened"}), encoding="utf-8-sig")
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
        self.assertEqual(payload["inputs"], {"job_id": 1, "status": "screened"})
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


class WebAgentToolSafetyTests(unittest.TestCase):
    def test_web_agent_returns_full_envelope_for_read_operation(self) -> None:
        result = asyncio.run(_execute_tool("list_jobs", {"page_size": 1}))

        self.assertTrue(result["ok"])
        self.assertEqual(result["operation"], "list_jobs")
        self.assertEqual(result["side_effects"], ["read"])
        self.assertIn("outputs", result)
        self.assertNotIn("requires_confirmation", result)

    def test_web_agent_forces_dry_run_for_side_effect_operation(self) -> None:
        result = asyncio.run(_execute_tool("triage_job", {"job_id": 1, "status": "screened"}))

        self.assertTrue(result["ok"])
        self.assertEqual(result["operation"], "triage_job")
        self.assertEqual(result["outputs"]["reason"], "dry_run")
        self.assertTrue(result["requires_confirmation"])
        self.assertTrue(result["proposal_id"])

    def test_web_agent_unknown_tool_returns_error(self) -> None:
        result = asyncio.run(_execute_tool("missing_tool", {}))

        self.assertIn("error", result)

    def test_confirm_unknown_proposal_fails(self) -> None:
        async def run_confirm() -> None:
            await confirm_agent_operation(AgentConfirmRequest(proposal_id="missing"))

        with self.assertRaises(Exception):
            asyncio.run(run_confirm())


if __name__ == "__main__":
    unittest.main()
