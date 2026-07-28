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

    def test_codex_args_enforce_current_isolated_structured_contract(self) -> None:
        schema_path = Path("worker/output.schema.json")

        args = runtime._runtime_args("codex", output_schema=OUTPUT_SCHEMA, schema_path=schema_path)

        self.assertEqual(args[0], "exec")
        self.assertIn('approval_policy="never"', args)
        self.assertIn("--sandbox", args)
        self.assertEqual(args[args.index("--sandbox") + 1], "read-only")
        self.assertIn("--ephemeral", args)
        self.assertIn("--ignore-user-config", args)
        self.assertIn("--ignore-rules", args)
        self.assertEqual(args[args.index("--output-schema") + 1], str(schema_path))
        self.assertIn("--json", args)
        self.assertNotIn("--ask-for-approval", args)
        self.assertNotIn('web_search="live"', args)
        self.assertEqual(args[-1], "-")

    def test_codex_live_web_search_uses_probed_config_surface(self) -> None:
        args = runtime._runtime_args(
            "codex",
            output_schema=OUTPUT_SCHEMA,
            schema_path=Path("worker/output.schema.json"),
            web_search_mode="live",
        )

        self.assertIn('web_search="live"', args)
        web_config_index = args.index('web_search="live"')
        self.assertEqual(args[web_config_index - 1], "--config")
        self.assertEqual(args[args.index("--sandbox") + 1], "read-only")
        self.assertIn("--ephemeral", args)

    def test_claude_args_enforce_schema_and_disable_tools_and_sessions(self) -> None:
        args = runtime._runtime_args(
            "claude",
            output_schema=OUTPUT_SCHEMA,
            schema_path=Path("unused.json"),
        )

        self.assertIn("--print", args)
        self.assertEqual(args[args.index("--output-format") + 1], "json")
        self.assertEqual(json.loads(args[args.index("--json-schema") + 1]), OUTPUT_SCHEMA)
        self.assertEqual(args[args.index("--permission-mode") + 1], "plan")
        self.assertEqual(args[args.index("--tools") + 1], "")
        self.assertIn("--no-session-persistence", args)
        self.assertIn("--safe-mode", args)

    def test_claude_live_web_search_fails_closed(self) -> None:
        with self.assertRaises(ValueError):
            runtime._runtime_args(
                "claude",
                output_schema=OUTPUT_SCHEMA,
                schema_path=Path("unused.json"),
                web_search_mode="live",
            )

    def test_capability_probe_fails_closed_when_required_flag_is_missing(self) -> None:
        definition = runtime.RUNTIME_DEFINITIONS["codex"]
        help_text = "\n".join(
            flag for flag in definition["required_flags"] if flag != "--output-schema"
        )
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
        self.assertEqual(result["missing_required_flags"], ["--output-schema"])

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
