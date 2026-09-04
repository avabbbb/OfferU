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
CONTROL_SURFACE_FILES = {
    "cli": BACKEND_DIR / "app" / "cli.py",
    "mcp": BACKEND_DIR / "app" / "mcp_server.py",
    "plugins": BACKEND_DIR / "app" / "services" / "capability_plugins.py",
}

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


def _imported_modules(tree: ast.Module) -> set[str]:
    modules: set[str] = set()
    for node in tree.body:
        if isinstance(node, ast.ImportFrom) and node.module:
            modules.add(node.module)
        elif isinstance(node, ast.Import):
            modules.update(alias.name for alias in node.names)
    return modules


def _function_calls(tree: ast.Module, function_name: str) -> set[str]:
    for node in tree.body:
        if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) or node.name != function_name:
            continue
        return {
            call.func.id
            for call in ast.walk(node)
            if isinstance(call, ast.Call) and isinstance(call.func, ast.Name)
        }
    return set()


def test_cli_mcp_and_plugin_surfaces_do_not_create_a_domain_write_escape_hatch() -> None:
    cli_tree = ast.parse(CONTROL_SURFACE_FILES["cli"].read_text(encoding="utf-8"))
    mcp_tree = ast.parse(CONTROL_SURFACE_FILES["mcp"].read_text(encoding="utf-8"))
    plugin_tree = ast.parse(CONTROL_SURFACE_FILES["plugins"].read_text(encoding="utf-8"))

    cli_modules = _imported_modules(cli_tree)
    assert "app.models" not in cli_modules
    assert "app.services.agent_operations" not in cli_modules
    assert "execute_or_propose_operation" in _function_calls(cli_tree, "_run_operation")
    assert "confirm_operation_proposal" in _function_calls(cli_tree, "_confirm_operation")

    mcp_modules = _imported_modules(mcp_tree)
    assert "app.database" not in mcp_modules
    assert "app.models.models" not in mcp_modules
    assert "app.services.agent_operations" not in mcp_modules
    assert "execute_or_propose_operation" in _function_calls(mcp_tree, "offeru_operation")
    assert "confirm_operation_proposal" in _function_calls(mcp_tree, "confirm_operation")
    assert "execute_or_propose_operation" in _function_calls(mcp_tree, "resource_profile")

    plugin_modules = _imported_modules(plugin_tree)
    assert "app.models.models" not in plugin_modules
    assert "app.database" not in plugin_modules
    assert "sqlalchemy" not in plugin_modules


def _module_imports(path: Path) -> set[str]:
    tree = ast.parse(path.read_text(encoding="utf-8"))
    imports: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom) and node.module:
            imports.add(node.module)
        elif isinstance(node, ast.Import):
            imports.update(alias.name for alias in node.names)
    return imports


def test_lower_layers_do_not_import_web_route_modules() -> None:
    """Keep the HTTP layer at the top of the domain dependency graph.

    Services may use the Registry as an explicit control-plane seam and
    agents may use domain services, but neither lower layer may reach back into
    FastAPI routes.  This is intentionally narrow so it protects direction
    without pretending that read-only route projections are domain services.
    """

    violations: list[str] = []
    lower_layers = {
        "models": BACKEND_DIR / "app" / "models",
        "agents": BACKEND_DIR / "app" / "agents",
        "services": BACKEND_DIR / "app" / "services",
    }
    for layer, root in lower_layers.items():
        for path in sorted(root.rglob("*.py")):
            imported = _module_imports(path)
            forbidden = sorted(module for module in imported if module == "app.routes" or module.startswith("app.routes."))
            violations.extend(f"{layer}: {path.relative_to(BACKEND_DIR)} -> {module}" for module in forbidden)
    assert not violations, "Lower-layer module imports a FastAPI route:\n" + "\n".join(violations)


def test_data_layer_does_not_depend_on_application_or_control_plane_modules() -> None:
    """ORM models remain leaf modules and cannot acquire business seams."""

    violations: list[str] = []
    data_roots = [BACKEND_DIR / "app" / "models"]
    forbidden_prefixes = ("app.routes", "app.services", "app.agents", "app.ops")
    for root in data_roots:
        paths = [root] if root.is_file() else sorted(root.rglob("*.py"))
        for path in paths:
            imported = _module_imports(path)
            forbidden = sorted(
                module for module in imported if module.startswith(forbidden_prefixes)
            )
            violations.extend(f"{path.relative_to(BACKEND_DIR)} -> {module}" for module in forbidden)
    assert not violations, "Data-layer module imports an application/control-plane module:\n" + "\n".join(violations)
