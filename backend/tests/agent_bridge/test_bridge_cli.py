from __future__ import annotations

import io
import json
import subprocess
import sys
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
BACKEND_DIR = Path(__file__).resolve().parents[2]
REPO_ROOT = BACKEND_DIR.parent
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from app.bridge_cli import main as bridge_main  # noqa: E402


class BridgeCliProbeTests(unittest.TestCase):
    def test_probe_reports_protocol_and_database_reachability(self) -> None:
        stdout = io.StringIO()
        stderr = io.StringIO()
        with redirect_stdout(stdout), redirect_stderr(stderr):
            exit_code = bridge_main(["probe", "--json"])
        self.assertEqual(exit_code, 0)
        payload = json.loads(stdout.getvalue())
        self.assertTrue(payload["ok"])
        self.assertEqual(payload["protocolVersion"], 1)
        self.assertIsInstance(payload["databaseReachable"], bool)
        constraints = payload["runConstraints"]
        self.assertIn("operation.invoke", constraints["runRequiredMessageTypes"])
        self.assertNotIn("hello", constraints["runRequiredMessageTypes"])
        self.assertIn("hello", constraints["runForbiddenMessageTypes"])

    def test_schema_emits_full_bundle(self) -> None:
        stdout = io.StringIO()
        with redirect_stdout(stdout):
            exit_code = bridge_main(["schema", "--json"])
        self.assertEqual(exit_code, 0)
        payload = json.loads(stdout.getvalue())
        self.assertTrue(payload["ok"])
        self.assertEqual(payload["protocolVersion"], 1)
        self.assertIn("request", payload["schemas"])
        self.assertIn("response", payload["schemas"])
        self.assertNotIn("run.create", payload["messageTypes"])


class BridgeCliSubprocessTests(unittest.TestCase):
    """Black-box check: stdout is exactly one JSON object, no banner noise."""

    def test_subprocess_stdout_is_single_json_line(self) -> None:
        python = sys.executable
        result = subprocess.run(
            [python, "-m", "app.cli", "bridge", "probe", "--json"],
            cwd=BACKEND_DIR,
            capture_output=True,
            text=True,
            timeout=60,
        )
        self.assertEqual(result.returncode, 0, msg=result.stderr)
        lines = [line for line in result.stdout.splitlines() if line.strip()]
        self.assertEqual(len(lines), 1)
        payload = json.loads(lines[0])
        self.assertTrue(payload["ok"])
        self.assertEqual(payload["protocolVersion"], 1)

    def test_conformance_runner_passes_all_scenarios(self) -> None:
        runner = REPO_ROOT / "integrations" / "conformance" / "runner.py"
        result = subprocess.run(
            [sys.executable, str(runner)],
            capture_output=True,
            text=True,
            timeout=120,
        )
        self.assertEqual(result.returncode, 0, msg=result.stderr)
        summary = json.loads(result.stdout.strip().splitlines()[-1])
        self.assertTrue(summary["ok"])
        self.assertEqual(summary["failures"], 0)
        self.assertGreaterEqual(summary["scenarios"], 5)


if __name__ == "__main__":
    unittest.main()
