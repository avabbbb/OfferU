from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import AsyncMock, patch

BACKEND_DIR = Path(__file__).resolve().parents[1]
os.chdir(BACKEND_DIR)
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from app.services import coding_agent_runtime as runtime


OUTPUT_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "required": ["score"],
    "properties": {"score": {"type": "integer"}},
}


class CodingAgentRuntimeTests(unittest.TestCase):
    def setUp(self) -> None:
        runtime._PROBE_CACHE.clear()

    def test_codex_uses_app_server_protocol_instead_of_one_shot_exec(self) -> None:
        schema_path = Path("worker/output.schema.json")

        args = runtime._runtime_args("codex", output_schema=OUTPUT_SCHEMA, schema_path=schema_path)

        self.assertEqual(args, ["app-server", "--stdio"])
        self.assertEqual(
            runtime.RUNTIME_DEFINITIONS["codex"]["protocol"],
            "codex-app-server-jsonl-v2",
        )
        self.assertTrue(
            runtime.RUNTIME_DEFINITIONS["codex"]["capabilities_decl"]["supports_resume"]
        )

    def test_codex_web_grant_is_sent_in_protocol_not_hardcoded_argv(self) -> None:
        args = runtime._runtime_args(
            "codex",
            output_schema=OUTPUT_SCHEMA,
            schema_path=Path("worker/output.schema.json"),
            web_search_mode="live",
        )

        self.assertEqual(args, ["app-server", "--stdio"])
        self.assertNotIn("exec", args)
        config = runtime._codex_thread_config("live")
        self.assertEqual(config["web_search"], "live")
        self.assertFalse(config["features.shell_tool"])
        self.assertFalse(config["features.unified_exec"])
        self.assertFalse(config["features.apps"])
        self.assertFalse(config["features.browser_use"])
        self.assertFalse(config["features.computer_use"])
        self.assertFalse(config["features.multi_agent"])
        self.assertFalse(config["features.multi_agent_v2"])
        self.assertFalse(config["features.workspace_dependencies"])
        self.assertEqual(config["mcp_servers"], {})
        self.assertEqual(config["project_doc_max_bytes"], 0)

    def test_claude_uses_sdk_worker_instead_of_print_mode(self) -> None:
        args = runtime._runtime_args(
            "claude",
            output_schema=OUTPUT_SCHEMA,
            schema_path=Path("unused.json"),
        )

        self.assertEqual(args, [str(runtime._CLAUDE_SDK_WORKER)])
        worker_source = runtime._CLAUDE_SDK_WORKER.read_text(encoding="utf-8")
        self.assertIn('settingSources: []', worker_source)
        self.assertIn('tools.includes(toolName)', worker_source)
        self.assertIn('options.resume = command.external_session_id', worker_source)
        self.assertIn("normalizeMessageEvent(message)", worker_source)
        self.assertIn('event_type: "provider.initialized"', worker_source)
        self.assertIn('"tool.started"', worker_source)
        self.assertIn('event_type: "tool.progress"', worker_source)
        self.assertIn('event_type: "tool.completed"', worker_source)
        self.assertIn("command.max_turns", worker_source)
        self.assertIn("maxTurns,", worker_source)
        self.assertIn("includePartialMessages: false", worker_source)
        self.assertNotIn('event_type: "message.delta"', worker_source)
        self.assertNotIn("--no-session-persistence", worker_source)

    def test_claude_live_web_search_remains_inside_sdk_tool_allowlist(self) -> None:
        worker_source = runtime._CLAUDE_SDK_WORKER.read_text(encoding="utf-8")

        self.assertIn('["WebSearch", "WebFetch"]', worker_source)
        self.assertIn('behavior: "deny"', worker_source)
        self.assertIn('"Bash"', worker_source)
        self.assertIn('"Read"', worker_source)

    def test_deep_task_carries_stable_task_identity_and_minimal_grant(self) -> None:
        task = runtime.DeepTaskSpec(
            runtime_id="codex",
            prompt="research one job",
            cwd=Path("worker/job_research_1"),
            output_schema=OUTPUT_SCHEMA,
            web_search_mode="live",
            task_type="job_research",
            task_id="job_research_1",
            capability_grant={
                "offeru_operations": [],
                "data_scope": {"job_id": 1},
                "network": "public_web_only",
            },
        )

        self.assertEqual(task.task_type, "job_research")
        self.assertEqual(task.task_id, "job_research_1")
        self.assertEqual(task.capability_grant["offeru_operations"], [])

    def test_capability_probe_fails_closed_when_required_flag_is_missing(self) -> None:
        definition = runtime.RUNTIME_DEFINITIONS["codex"]
        help_text = "--listen"
        capture = AsyncMock(
            side_effect=[
                (0, "codex-cli 0.144.1\n", ""),
                (0, help_text, ""),
            ]
        )
        with tempfile.TemporaryDirectory() as directory:
            executable = Path(directory) / "codex.exe"
            executable.touch()
            with patch.object(runtime.shutil, "which", return_value=str(executable)), patch.object(
                runtime,
                "_capture",
                capture,
            ):
                result = asyncio.run(runtime._probe("codex", refresh=True))

        self.assertTrue(result["available"])
        self.assertFalse(result["contract_compatible"])
        self.assertEqual(result["missing_required_flags"], ["--stdio"])

    def test_windows_probe_prefers_runnable_launcher_over_extensionless_npm_shim(self) -> None:
        with patch.object(runtime.os, "name", "nt"), patch.object(
            runtime.shutil,
            "which",
            side_effect=[
                r"C:\npm\codex",
                r"C:\npm\codex.cmd",
            ],
        ):
            executable = runtime._resolve_executable("codex")

        self.assertEqual(executable, r"C:\npm\codex.cmd")

    def test_public_selector_rejects_adapter_without_required_schema_flag(self) -> None:
        with patch.object(runtime, "_probe", AsyncMock()) as probe:
            with self.assertRaises(ValueError):
                asyncio.run(
                    runtime.select_local_executor(
                        "gemini",
                        requirements=runtime.ExecutorRequirements(schema_flag=True),
                    )
                )

        probe.assert_not_awaited()

    def test_hosted_adapters_remember_cancel_before_process_start(self) -> None:
        codex = runtime.CodexAppServerAdapter("session-1", "codex")
        claude = runtime.ClaudeAgentSdkAdapter("session-2")

        asyncio.run(codex.cancel())
        asyncio.run(claude.cancel())

        self.assertTrue(codex._cancel_requested)
        self.assertTrue(claude._cancel_requested)

    def test_public_selector_returns_compatible_adapter(self) -> None:
        selected = {
            "id": "codex",
            **runtime.RUNTIME_DEFINITIONS["codex"],
            "available": True,
            "contract_compatible": True,
            "missing_required_flags": [],
        }
        with patch.object(runtime, "_probe", AsyncMock(return_value=selected)):
            result = asyncio.run(
                runtime.select_local_executor(
                    "codex",
                    requirements=runtime.ExecutorRequirements(
                        web_search=True,
                        schema_flag=True,
                    ),
                )
            )

        self.assertEqual(result["id"], "codex")

    def test_extracts_codex_agent_message_from_jsonl(self) -> None:
        stdout = "\n".join(
            [
                json.dumps({"type": "thread.started", "thread_id": "thread-1"}),
                json.dumps(
                    {
                        "type": "item.completed",
                        "item": {"type": "agent_message", "text": '{"score": 87}'},
                    }
                ),
            ]
        )

        text, event_count = runtime._extract_worker_text("codex", stdout)

        self.assertEqual(text, '{"score": 87}')
        self.assertEqual(event_count, 2)

    def test_prefers_claude_structured_output_over_display_result(self) -> None:
        stdout = json.dumps(
            {
                "type": "result",
                "result": "Evaluation complete",
                "structured_output": {"score": 91},
            }
        )

        text, event_count = runtime._extract_worker_text("claude", stdout)

        self.assertEqual(json.loads(text), {"score": 91})
        self.assertEqual(event_count, 1)

    def test_structured_decoder_rejects_markdown_guessing_and_non_objects(self) -> None:
        self.assertEqual(runtime._decode_structured_output('{"score": 80}'), {"score": 80})
        with self.assertRaises(ValueError):
            runtime._decode_structured_output('```json\n{"score": 80}\n```')
        with self.assertRaises(ValueError):
            runtime._decode_structured_output("[1, 2, 3]")


if __name__ == "__main__":
    unittest.main()
