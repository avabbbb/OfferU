from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from types import SimpleNamespace
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

    def test_pi_cli_is_not_advertised_as_bounded_live_web_provider(self) -> None:
        self.assertFalse(
            runtime.RUNTIME_DEFINITIONS["pi"]["capabilities_decl"]["supports_live_web_search"]
        )
        self.assertFalse(
            runtime.RUNTIME_DEFINITIONS["omp"]["capabilities_decl"]["supports_live_web_search"]
        )

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

    def test_probe_status_not_installed_when_executable_missing(self) -> None:
        with patch.object(runtime.shutil, "which", return_value=None), patch.object(
            runtime, "_resolve_executable", return_value=None
        ):
            result = asyncio.run(runtime._probe("codex", refresh=True))

        self.assertFalse(result["available"])
        self.assertEqual(result["probe_status"], "not_installed")
        self.assertIsNone(result["probe_error"])

    def test_probe_status_timeout_when_capture_hangs(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            executable = Path(directory) / "codex.exe"
            executable.touch()
            with patch.object(runtime.shutil, "which", return_value=str(executable)), patch.object(
                runtime, "_capture", AsyncMock(side_effect=asyncio.TimeoutError())
            ):
                result = asyncio.run(runtime._probe("codex", refresh=True))

        self.assertFalse(result["available"])
        self.assertEqual(result["probe_status"], "timeout")
        self.assertIn("timed out", result["probe_error"])

    def test_probe_status_incompatible_when_flags_missing(self) -> None:
        capture = AsyncMock(side_effect=[(0, "codex-cli 0.144.1\n", ""), (0, "--listen", "")])
        with tempfile.TemporaryDirectory() as directory:
            executable = Path(directory) / "codex.exe"
            executable.touch()
            with patch.object(runtime.shutil, "which", return_value=str(executable)), patch.object(
                runtime, "_capture", capture
            ):
                result = asyncio.run(runtime._probe("codex", refresh=True))

        self.assertTrue(result["available"])
        self.assertEqual(result["probe_status"], "incompatible")
        self.assertIn("--stdio", result["probe_error"])

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

    def test_codex_hosted_runtime_requires_native_auth_before_turn(self) -> None:
        with self.assertRaisesRegex(RuntimeError, "authentication required"):
            runtime._require_codex_auth(
                {"account": None, "requiresOpenaiAuth": True}
            )
        runtime._require_codex_auth(
            {"account": {"type": "chatgpt"}, "requiresOpenaiAuth": True}
        )
        runtime._require_codex_auth(
            {"account": None, "requiresOpenaiAuth": False}
        )

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

    def test_selector_prefers_persisted_lifecycle_verified_provider(self) -> None:
        claude = {
            "id": "claude",
            **runtime.RUNTIME_DEFINITIONS["claude"],
            "available": True,
            "contract_compatible": True,
            "missing_required_flags": [],
        }
        codex = {
            "id": "codex",
            **runtime.RUNTIME_DEFINITIONS["codex"],
            "available": True,
            "contract_compatible": True,
            "missing_required_flags": [],
        }

        async def health(provider_id: str) -> dict[str, object]:
            return {
                "capabilities": {
                    "conformance": {
                        "resume_verified": "VERIFIED" if provider_id == "codex" else "SUPPORTED",
                    }
                }
            }

        with patch.object(
            runtime,
            "_probe",
            AsyncMock(side_effect=[claude, codex]),
        ), patch(
            "app.services.agent_provider_health.get_provider_health",
            new=AsyncMock(side_effect=health),
        ), patch(
            "app.config.get_settings",
            return_value=SimpleNamespace(coding_agent_priority="claude,codex"),
        ):
            result = asyncio.run(
                runtime.select_local_executor(
                    requirements=runtime.ExecutorRequirements(resume=True),
                )
            )

        self.assertEqual(result["id"], "codex")
        self.assertEqual(result["verified_capabilities"], {"resume": "VERIFIED"})

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

    def test_pi_error_event_wins_over_echoed_user_prompt(self) -> None:
        stdout = "\n".join(
            [
                json.dumps({
                    "type": "message_end",
                    "message": {"role": "user", "content": [{"type": "text", "text": "prompt"}]},
                }),
                json.dumps({
                    "type": "message_end",
                    "message": {
                        "role": "assistant",
                        "content": [],
                        "stopReason": "error",
                        "errorMessage": "401 Insufficient balance",
                    },
                }),
            ]
        )

        text, event_count = runtime._extract_worker_text("pi", stdout)

        self.assertEqual(event_count, 2)
        self.assertTrue(text.startswith("[pi error] 401"))
        with self.assertRaisesRegex(RuntimeError, "401 Insufficient balance"):
            runtime._decode_structured_output(text, schema_mode="prompt")

    def test_pi_and_omp_disable_global_extensions_for_isolated_probes(self) -> None:
        for runtime_id in ("pi", "omp"):
            with self.subTest(runtime_id=runtime_id):
                args = runtime._runtime_args(
                    runtime_id,
                    output_schema=OUTPUT_SCHEMA,
                    schema_path=Path("worker/output.schema.json"),
                )
                self.assertIn("--no-extensions", args)


class WorkerStartupTests(unittest.IsolatedAsyncioTestCase):
    async def _process(self, script):
        return await asyncio.create_subprocess_exec(
            sys.executable, "-u", "-c", script,
            stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            creationflags=runtime.subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
        )

    async def test_concurrent_refresh_probes_share_one_capture_sequence(self):
        async def capture(*args, **kwargs):
            await asyncio.sleep(0.01)
            return 0, "v1 --print --mode --no-session --no-pty", ""

        with patch.object(runtime, "_resolve_executable", return_value=sys.executable), \
             patch.object(runtime, "_capture", AsyncMock(side_effect=capture)) as mock_capture:
            results = await asyncio.gather(*[runtime._probe("omp", refresh=True) for _ in range(5)])
        self.assertEqual(mock_capture.await_count, 2)
        self.assertTrue(all(result["contract_compatible"] for result in results))
        self.assertTrue(all(call.kwargs["timeout"] == 20 for call in mock_capture.await_args_list))

    async def test_silent_worker_hits_startup_deadline(self):
        process = await self._process("import time; time.sleep(10)")
        try:
            with self.assertRaisesRegex(RuntimeError, "仍无输出"):
                await runtime._collect_worker_output(process, b"", startup_timeout=0.05, progress=AsyncMock())
        finally:
            await runtime._terminate_process(process)
        self.assertIsNotNone(process.returncode)

    async def test_pi_headers_and_user_messages_do_not_end_startup_deadline(self):
        headers = "\n".join(json.dumps(event) for event in [
            {"type": "session"}, {"type": "agent_start"}, {"type": "turn_start"},
            {"type": "message_end", "message": {"role": "user", "content": "prompt"}},
        ])
        process = await self._process(f"import time; print({headers!r}); time.sleep(10)")
        progress = AsyncMock()
        try:
            with self.assertRaisesRegex(RuntimeError, "仍无模型活动"):
                await runtime._collect_worker_output(process, b"", startup_timeout=0.3,
                    progress=progress, activity_classifier=runtime._pi_model_activity)
        finally:
            await runtime._terminate_process(process)
        self.assertTrue(any(call.args[0].get("stdout_bytes", 0) > 0 for call in progress.await_args_list))
        self.assertTrue(all(call.args[0]["stage"] == "executor_starting" for call in progress.await_args_list))

    async def test_pi_model_event_split_across_chunks_allows_long_task(self):
        event = json.dumps({"type": "message_update", "assistantMessageEvent": {"type": "thinking_delta"}})
        script = (f"import sys,time; print('{{\"type\":\"session\"}}'); "
                  f"sys.stdout.write({event[:20]!r}); sys.stdout.flush(); time.sleep(0.03); "
                  f"print({event[20:]!r}); time.sleep(0.8); print('done')")
        process = await self._process(script)
        progress = AsyncMock()
        stdout, _ = await runtime._collect_worker_output(process, b"", startup_timeout=0.5,
            progress=progress, activity_classifier=runtime._pi_model_activity)
        self.assertIn(b"done", stdout)
        self.assertTrue(any(call.args[0].get("startup_activity_observed") for call in progress.await_args_list))

    async def test_pi_activity_does_not_disable_total_timeout(self):
        event = json.dumps({"type": "tool_execution_start"})
        process = await self._process(f"import time; print({event!r}); time.sleep(10)")
        try:
            with self.assertRaises(asyncio.TimeoutError):
                await asyncio.wait_for(runtime._collect_worker_output(process, b"", startup_timeout=0.5,
                    progress=AsyncMock(), activity_classifier=runtime._pi_model_activity), timeout=0.7)
        finally:
            await runtime._terminate_process(process)

    def test_pi_activity_classifier_rejects_unrelated_or_malformed_events(self):
        for event in [b"not json", b"[]", b"{\"type\":\"message_update\"}",
                      b'{"type":"message_update","assistantMessageEvent":{"type":"start"}}']:
            self.assertFalse(runtime._pi_model_activity(event))
        self.assertTrue(runtime._pi_model_activity(b'{"type":"message_end","message":{"role":"assistant"}}'))

    async def test_first_output_does_not_limit_healthy_task_duration_or_expose_text(self):
        process = await self._process("import time; print('private_token'); time.sleep(0.8); print('done')")
        progress = AsyncMock()
        stdout, stderr = await runtime._collect_worker_output(process, b"", startup_timeout=0.5, progress=progress)
        self.assertEqual(stdout.splitlines(), [b"private_token", b"done"])
        self.assertEqual(stderr, b"")
        self.assertNotIn("private_token", repr(progress.await_args_list))
        self.assertEqual(progress.await_args_list[1].args[0]["stage"], "executor_output")

    async def test_buffered_protocol_can_wait_for_result_without_startup_claim(self):
        process = await self._process("import time; time.sleep(0.1); print('result')")
        stdout, _ = await runtime._collect_worker_output(process, b"", startup_timeout=None, progress=AsyncMock())
        self.assertEqual(stdout.splitlines(), [b"result"])

    async def test_stdout_overflow_is_explicit_and_stderr_tail_is_bounded(self):
        process = await self._process("import sys; sys.stderr.write('x'*10000); sys.stdout.write('y'*2100000)")
        try:
            with self.assertRaisesRegex(RuntimeError, "2 MB"):
                await runtime._collect_worker_output(process, b"", startup_timeout=1, progress=AsyncMock())
        finally:
            await runtime._terminate_process(process)
        process = await self._process("import sys; sys.stderr.write('x'*10000); print('done')")
        _, stderr = await runtime._collect_worker_output(process, b"", startup_timeout=1, progress=AsyncMock())
        self.assertEqual(len(stderr), 4000)

    async def test_executor_cancellation_terminates_process_tree(self):
        process = SimpleNamespace()
        with tempfile.TemporaryDirectory() as directory, \
             patch.object(runtime, "select_local_executor", AsyncMock(return_value={"executable_path": sys.executable})), \
             patch.object(runtime, "_command", return_value=(sys.executable, [])), \
             patch.object(runtime.asyncio, "create_subprocess_exec", AsyncMock(return_value=process)), \
             patch.object(runtime, "_collect_worker_output", AsyncMock(side_effect=asyncio.CancelledError())), \
             patch.object(runtime, "_terminate_process", AsyncMock()) as terminate:
            with self.assertRaises(asyncio.CancelledError):
                await runtime.execute_deep_task(runtime.DeepTaskSpec(
                    runtime_id="omp", prompt="test", cwd=Path(directory), output_schema=OUTPUT_SCHEMA,
                ))
        terminate.assert_awaited_once_with(process)


if __name__ == "__main__":
    unittest.main()
