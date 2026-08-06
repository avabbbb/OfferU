from __future__ import annotations

import json
import os
from pathlib import Path
import sys
import unittest

BACKEND_DIR = Path(__file__).resolve().parents[1]
os.chdir(BACKEND_DIR)
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from app.services.coding_agent_runtime import _extract_worker_text, _runtime_args


class PiOmpAdapterTests(unittest.TestCase):
    def test_runtime_args_are_headless(self) -> None:
        for runtime_id in ("pi", "omp"):
            args = _runtime_args(runtime_id, output_schema={}, schema_path=Path("/tmp/x.json"))
            self.assertIn("--print", args)
            self.assertIn("--no-session", args)
            self.assertIn("--mode", args)
            self.assertEqual(args[args.index("--mode") + 1], "json")
        omp_args = _runtime_args("omp", output_schema={}, schema_path=Path("/tmp/x.json"))
        self.assertIn("--no-pty", omp_args)
        self.assertIn("--no-lsp", omp_args)

    def test_extract_text_skips_thinking_blocks(self) -> None:
        stdout = "\n".join(
            [
                '{"type":"session","id":"s1"}',
                '{"type":"message_end","message":{"role":"assistant","content":['
                '{"type":"thinking","thinking":"思考过程"},'
                '{"type":"text","text":"{\\"reply\\":\\"OK\\"}"}]}}',
                '{"type":"turn_end","message":{"role":"assistant","content":['
                '{"type":"text","text":"{\\"reply\\":\\"OK\\"}"}]}}',
            ]
        )
        text, event_count = _extract_worker_text("omp", stdout)
        self.assertEqual(event_count, 3)
        self.assertIn('{"reply":"OK"}', text)
        self.assertNotIn("思考过程", text)

    def test_extract_text_empty_output_falls_back_to_stdout(self) -> None:
        text, _ = _extract_worker_text("pi", "no json here")
        self.assertEqual(text, "no json here")

    def test_extract_text_merges_multiple_text_blocks(self) -> None:
        stdout = "\n".join(
            [
                '{"type":"message_end","message":{"role":"assistant","content":['
                '{"type":"text","text":"第一段"},{"type":"text","text":"第二段"}]}}',
            ]
        )
        text, _ = _extract_worker_text("pi", stdout)
        self.assertIn("第一段", text)
        self.assertIn("第二段", text)


class OpencodeAdapterTests(unittest.TestCase):
    def test_runtime_args_are_headless(self) -> None:
        args = _runtime_args("opencode", output_schema={}, schema_path=Path("/tmp/x.json"))
        self.assertEqual(args[:2], ["run", "--format"])
        self.assertIn("json", args)
        self.assertIn("--pure", args)

    def test_extract_text_from_part_events(self) -> None:
        stdout = "\n".join(
            [
                '{"type":"part","part":{"type":"text","text":"你好"}}',
                '{"type":"part","part":{"type":"text","text":"世界"}}',
                '{"type":"step","step":{"type":"agent"}}',
            ]
        )
        text, event_count = _extract_worker_text("opencode", stdout)
        self.assertEqual(event_count, 3)
        self.assertEqual(text, "世界")

    def test_extract_text_from_message_content(self) -> None:
        stdout = json.dumps(
            {
                "type": "message",
                "message": {
                    "role": "assistant",
                    "content": [{"type": "text", "text": '{"reply":"OK"}'}],
                },
            }
        )
        text, _ = _extract_worker_text("opencode", stdout)
        self.assertIn('{"reply":"OK"}', text)

    def test_error_event_surfaces_reason(self) -> None:
        stdout = json.dumps(
            {
                "type": "error",
                "error": {
                    "data": {"message": "Insufficient balance", "statusCode": 401},
                },
            }
        )
        text, _ = _extract_worker_text("opencode", stdout)
        self.assertIn("Insufficient balance", text)


if __name__ == "__main__":
    unittest.main()
