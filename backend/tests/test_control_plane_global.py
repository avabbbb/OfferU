"""Static guardrails for the global Operation Registry boundary.

The route layer may keep direct reads and derived/external-only endpoints, but
formal Career Runtime mutations must not grow a second ORM write path.  This
test is intentionally source-level: the dangerous regression is a route that
starts mutating the database before a runtime test happens to exercise it.
"""

from __future__ import annotations

import ast
import re
from pathlib import Path
from typing import Iterable


BACKEND_DIR = Path(__file__).resolve().parents[1]
ROUTES_DIR = BACKEND_DIR / "app" / "routes"

REGISTRY_HELPERS = {
    "execute_operation",
    "_execute_operation",
    "_execute",
    "_ui_operation_outputs",
    "_ui_operation_projection",
    "_execute_agent_operation",
    "_operation_outputs",
}

# These are intentionally not Career Runtime mutations.  They either produce
# a derived response/file, probe an external service, or control the Agent
# Runtime provider lifecycle.  Provider adapters own their run-state seam;
# they do not become a second Career domain write path.
NON_REGISTRY_MUTATION_ENDPOINTS = {
    ("agent.py", "agent_chat"),
    ("config.py", "update_config"),
    ("config.py", "import_llm_provider"),
    ("config.py", "test_llm_connection"),
    ("config.py", "fetch_models"),
    ("main_agent.py", "start_runtime_run"),
    ("main_agent.py", "stream_runtime_run"),
    ("main_agent.py", "confirm_runtime_action"),
    ("main_agent.py", "resume_runtime_run"),
    ("main_agent.py", "abort_runtime_run"),
    ("main_agent.py", "cancel_hosted_executor_session_from_ui"),
    ("main_agent.py", "resume_hosted_executor_session_from_ui"),
    ("profile.py", "instant_draft"),
    ("profile.py", "smart_fill_ping"),
    ("profile.py", "smart_fill_cache_get"),
    ("profile.py", "smart_fill_option_match"),
    ("resume.py", "export_pdf"),
    ("resume.py", "export_image"),
    ("resume.py", "ai_optimize_resume"),
    ("resume.py", "ai_optimize_text"),
    ("resume.py", "ai_analyze_resume"),
    ("resume.py", "ai_analyze_text"),
    ("resume.py", "parse_resume_upload"),
}

MUTATING_METHODS = {
    "add",
    "add_all",
    "commit",
    "delete",
    "flush",
    "merge",
    "refresh",
    "rollback",
}
MUTATING_SQL = {"delete", "insert", "update"}
MUTATING_SERVICE_NAME = re.compile(
    r"^(?:activate|apply|cancel|capture|complete|create|delete|distill|import|"
    r"ingest|move|patch|promote|rename|restore|review|revoke|save|set|start|"
    r"submit|sync|update)(?:_|$)"
)


def _route_functions(tree: ast.Module) -> Iterable[tuple[str, ast.AST, set[str]]]:
    for node in tree.body:
        if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            continue
        methods: set[str] = set()
        for decorator in node.decorator_list:
            if (
                isinstance(decorator, ast.Call)
                and isinstance(decorator.func, ast.Attribute)
                and isinstance(decorator.func.value, ast.Name)
                and decorator.func.value.id in {"router", "runtime_router"}
                and decorator.func.attr.lower() in {"post", "put", "patch", "delete"}
            ):
                methods.add(decorator.func.attr.lower())
        if methods:
            yield node.name, node, methods


def _local_helpers(tree: ast.Module) -> dict[str, ast.AST]:
    return {
        node.name: node
        for node in tree.body
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
    }


def _calls_registry(node: ast.AST, helpers: dict[str, ast.AST]) -> bool:
    visited: set[str] = set()

    def walk(current: ast.AST) -> bool:
        for call in ast.walk(current):
            if not isinstance(call, ast.Call):
                continue
            if isinstance(call.func, ast.Name):
                name = call.func.id
                if name in REGISTRY_HELPERS:
                    return True
                helper = helpers.get(name)
                if helper is not None and name not in visited:
                    visited.add(name)
                    if walk(helper):
                        return True
        return False

    return walk(node)


def _direct_orm_mutations(path: Path, tree: ast.Module) -> list[str]:
    violations: list[str] = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call) or not isinstance(node.func, ast.Attribute):
            continue
        receiver = node.func.value
        if isinstance(receiver, ast.Name) and receiver.id in {"db", "session"}:
            if node.func.attr in MUTATING_METHODS:
                violations.append(f"{path.name}:{node.lineno}: db.{node.func.attr}(...)")
                continue
            if node.func.attr == "execute" and node.args:
                statement = node.args[0]
                if (
                    isinstance(statement, ast.Call)
                    and isinstance(statement.func, ast.Name)
                    and statement.func.id in MUTATING_SQL
                ):
                    violations.append(
                        f"{path.name}:{node.lineno}: db.execute({statement.func.id}(...))"
                    )
                elif (
                    isinstance(statement, ast.Call)
                    and isinstance(statement.func, ast.Name)
                    and statement.func.id == "text"
                    and statement.args
                    and isinstance(statement.args[0], ast.Constant)
                    and isinstance(statement.args[0].value, str)
                    and re.match(r"^\\s*(?:insert|update|delete|replace|alter|drop|create)\\b", statement.args[0].value, re.I)
                ):
                    violations.append(f"{path.name}:{node.lineno}: db.execute(text(write-sql))")
    return violations


def test_route_modules_have_no_direct_orm_mutation() -> None:
    violations: list[str] = []
    for path in sorted(ROUTES_DIR.glob("*.py")):
        violations.extend(_direct_orm_mutations(path, ast.parse(path.read_text(encoding="utf-8"))))
    assert not violations, "Direct ORM mutation found in route layer:\n" + "\n".join(violations)


def test_domain_mutation_routes_use_registry_or_explicit_runtime_boundary() -> None:
    violations: list[str] = []
    for path in sorted(ROUTES_DIR.glob("*.py")):
        tree = ast.parse(path.read_text(encoding="utf-8"))
        helpers = _local_helpers(tree)
        for name, node, methods in _route_functions(tree):
            key = (path.name, name)
            if key in NON_REGISTRY_MUTATION_ENDPOINTS:
                continue
            if not _calls_registry(node, helpers):
                violations.append(
                    f"{path.name}:{getattr(node, 'lineno', '?')} {name} "
                    f"({', '.join(sorted(methods))})"
                )
    assert not violations, (
        "Mutation route lacks an Operation Registry call or an explicit "
        "runtime/derived exemption:\n" + "\n".join(violations)
    )


def test_mutating_service_imports_are_not_called_directly_from_domain_routes() -> None:
    violations: list[str] = []
    for path in sorted(ROUTES_DIR.glob("*.py")):
        if path.name == "config.py":
            continue  # provider configuration is a separate local file surface
        tree = ast.parse(path.read_text(encoding="utf-8"))
        imported_mutators: set[str] = set()
        for node in tree.body:
            if not isinstance(node, ast.ImportFrom) or not node.module or not node.module.startswith("app."):
                continue
            for alias in node.names:
                local_name = alias.asname or alias.name
                if MUTATING_SERVICE_NAME.match(alias.name) and alias.name not in {"confirm_proposal"}:
                    imported_mutators.add(local_name)
        for node in ast.walk(tree):
            if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id in imported_mutators:
                violations.append(f"{path.name}:{node.lineno}: {node.func.id}(...)")
    assert not violations, "Direct mutating service call from route layer:\n" + "\n".join(violations)
