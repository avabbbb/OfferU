from __future__ import annotations

import ast
from pathlib import Path
import re
import unittest


REPO_ROOT = Path(__file__).resolve().parents[2]
BACKEND_APP = REPO_ROOT / "backend" / "app"
LOG_METHODS = {"debug", "info", "warning", "error", "exception", "critical"}
SENSITIVE_EXPRESSIONS = re.compile(
    r"\b(?:company|role|kw|keyword|jd|jd_text|raw_text|profile_bullets|question|"
    r"messages|prompt|content|resume|resume_text|qdrant_host|root|cwd|py_str|"
    r"path|url|headers|cookie|email|phone|api_key|api_token|password|secret|token)\b",
    re.IGNORECASE,
)
SAFE_WRAPPERS = ("len(", "type(", "redact_sensitive_", "safe_error_message(")


class SecurityLoggingContractTests(unittest.TestCase):
    def test_python_logging_does_not_emit_sensitive_payload_values(self) -> None:
        offenders: list[str] = []
        logging_calls = 0
        for path in sorted(BACKEND_APP.rglob("*.py")):
            tree = ast.parse(path.read_text(encoding="utf-8"))
            for node in ast.walk(tree):
                if not isinstance(node, ast.Call) or not isinstance(node.func, ast.Attribute):
                    continue
                if node.func.attr not in LOG_METHODS:
                    continue
                owner = node.func.value
                if not isinstance(owner, ast.Name) or owner.id not in {"logger", "_logger"}:
                    continue
                logging_calls += 1
                dynamic_args = node.args[1:] if node.args else []
                for argument in dynamic_args:
                    expression = ast.unparse(argument)
                    if not SENSITIVE_EXPRESSIONS.search(expression):
                        continue
                    if "X-OfferU-Error-Id" in expression:
                        continue
                    if expression.startswith(SAFE_WRAPPERS):
                        continue
                    offenders.append(f"{path.relative_to(REPO_ROOT)}:{node.lineno}: {expression}")

        self.assertGreater(logging_calls, 0)
        self.assertEqual(offenders, [])


if __name__ == "__main__":
    unittest.main()
