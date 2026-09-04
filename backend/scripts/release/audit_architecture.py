"""Static release audit for OfferU's authority and dependency boundaries.

The audit is deliberately conservative: it reports source-level escape hatches
that can be checked without importing the application or touching a user's
database.  It complements the runtime Operation Registry tests; it does not
claim that static inspection proves every possible dynamic call path safe.
"""

from __future__ import annotations

import argparse
import ast
import json
import re
import sys
from pathlib import Path
from typing import Any, Iterable


ROOT = Path(__file__).resolve().parents[3]
BACKEND_DIR = ROOT / "backend"
ROUTES_DIR = BACKEND_DIR / "app" / "routes"

CONTROL_SURFACES = {
    "cli": BACKEND_DIR / "app" / "cli.py",
    "mcp": BACKEND_DIR / "app" / "mcp_server.py",
    "plugins": BACKEND_DIR / "app" / "services" / "capability_plugins.py",
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
MUTATING_SQL = {"delete", "insert", "update", "replace", "alter", "drop", "create"}
MUTATING_SERVICE_NAME = re.compile(
    r"^(?:activate|apply|cancel|capture|complete|create|delete|distill|import|"
    r"ingest|move|patch|promote|rename|restore|review|revoke|save|set|start|"
    r"submit|sync|update)(?:_|$)"
)

# These endpoints are intentional non-Registry boundaries: they either
# configure a local provider, render/export derived data, or control the
# replaceable Agent Runtime lifecycle.  The existing global contract test and
# this release audit keep the exception list explicit and reviewable.
EXPLICIT_ROUTE_BOUNDARIES = {
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

REGISTRY_HELPERS = {
    "execute_operation",
    "_execute_operation",
    "_execute",
    "_ui_operation_outputs",
    "_ui_operation_projection",
    "_execute_agent_operation",
    "_operation_outputs",
    "execute_or_propose_operation",
}

PROVIDER_COMPARISON = re.compile(
    r"\b(?:provider|provider_id|runtime_provider|runtimeProvider)\s*(?:===|!==|==|!=)"
)
PROVIDER_BRANCH_ALLOWLIST = (
    "frontend/src/components/onboarding/",
    "frontend/src/app/settings/",
    "frontend/src/app/email/",
    "frontend/src/lib/",
)

LOCAL_ENTRY_FILES = (
    ROOT / ".env.example",
    ROOT / "docker-compose.yml",
    ROOT / "frontend" / "Dockerfile",
    ROOT / "frontend" / "vite.config.ts",
    ROOT / "frontend" / "src-tauri" / "tauri.conf.json",
    ROOT / "frontend" / "src-tauri" / "src" / "lib.rs",
    ROOT / "frontend" / "src" / "lib" / "apiBase.ts",
    ROOT / "frontend" / "src" / "app" / "providers.tsx",
    ROOT / "frontend" / "src" / "app" / "email" / "page.tsx",
    ROOT / "backend" / "Dockerfile",
    ROOT / "backend" / "run_server.py",
    ROOT / "backend" / "sidecar_entry.py",
    ROOT / "backend" / "app" / "config.py",
    ROOT / "backend" / "app" / "cli.py",
    ROOT / "backend" / "app" / "main.py",
    ROOT / "backend" / "app" / "routes" / "email.py",
    ROOT / "backend" / "app" / "services" / "email_sync.py",
    ROOT / "backend" / "app" / "routes" / "resume.py",
    ROOT / "backend" / "app" / "services" / "resume_route_operations.py",
    ROOT / "backend" / "scripts" / "seed" / "seed_jobs.py",
    ROOT / "backend" / "scripts" / "seed" / "seed_mock_jobs.py",
    ROOT / "backend" / "scripts" / "seed" / "seed_profile.py",
    ROOT / "extension" / "README.md",
    ROOT / "extension" / "wxt.config.ts",
    ROOT / "extension" / "src" / "popup.ts",
    ROOT / "extension" / "src" / "background" / "server-url.ts",
    ROOT / "extension" / "popup.html",
    ROOT / "extension" / "scripts" / "sync-root-build.mjs",
    ROOT / "extension" / "static" / "popup.html",
)
GENERATED_EXTENSION_ARTIFACTS = (
    ROOT / "extension" / "manifest.json",
    ROOT / "extension" / "background.js",
    ROOT / "extension" / "popup.html",
)
STALE_LOCAL_ENDPOINTS = re.compile(
    r"(?:localhost|127\.0\.0\.1):(?!7410\b|8765\b)(?:8080|3011|9000|8000|3300|3000|3001|5140)\b"
)
LEGACY_PORT_OVERRIDE = re.compile(r"OFFERU_LEGACY_PORT")
FORBIDDEN_AUTOMATED_BROWSER_SELECTORS = re.compile(
    r'''headless\s*[:=]\s*false|executable[_ ]?Path|PLAYWRIGHT_CHROMIUM_EXECUTABLE|'''
    r'''Microsoft[\\/]Edge|msedge(?:\.exe)?|channel\s*[:=]\s*["'](?:msedge|chrome)["']''',
    re.IGNORECASE,
)


def _automated_browser_files() -> list[Path]:
    files = [
        ROOT / "backend" / "app" / "routes" / "resume.py",
        ROOT / "backend" / "app" / "services" / "pdf_exporter.py",
        *sorted((ROOT / "backend" / "scripts" / "e2e").glob("*.py")),
        *sorted((ROOT / "extension" / "scripts").glob("*.mjs")),
        ROOT / "_tmp_online.cjs",
    ]
    excluded = {
        # Explicit user-confirmed interactive login boundary, not automated
        # acceptance. Keep the exception visible and narrow.
        ROOT / "backend" / "app" / "services" / "authorized_research.py",
        # This contract test contains forbidden tokens only as negative
        # assertions; it never launches a browser.
        ROOT / "backend" / "scripts" / "e2e" / "test_resume_template_contract.py",
    }
    return [path for path in files if path not in excluded]


def _release_e2e_endpoint_bypasses() -> list[dict[str, Any]]:
    """Keep public-release E2E endpoint overrides behind the fixed guard."""

    findings: list[dict[str, Any]] = []
    for path in sorted((ROOT / "backend" / "scripts" / "e2e").glob("test_public_release_*.py")):
        source = path.read_text(encoding="utf-8")
        uses_endpoint_override = (
            "OFFERU_E2E_BASE_URL" in source or "OFFERU_E2E_API_URL" in source
        )
        if not uses_endpoint_override:
            continue
        if "from release_endpoints import" not in source:
            findings.append(
                {
                    "path": _relative(path),
                    "kind": "release_e2e_missing_endpoint_guard",
                }
            )
        for line, content in enumerate(source.splitlines(), 1):
            if "os.getenv(\"OFFERU_E2E_BASE_URL\"" in content or "os.getenv(\"OFFERU_E2E_API_URL\"" in content:
                findings.append(
                    {
                        "path": _relative(path),
                        "line": line,
                        "kind": "release_e2e_direct_endpoint_override",
                    }
                )
    return findings


def _generated_extension_artifact_bypasses() -> list[dict[str, Any]]:
    """Reject a tracked extension bundle that was not produced by the guarded build."""

    findings: list[dict[str, Any]] = []
    for path in GENERATED_EXTENSION_ARTIFACTS:
        if not path.is_file():
            findings.append({"path": _relative(path), "kind": "missing_extension_artifact"})

    background = ROOT / "extension" / "background.js"
    if background.is_file():
        background_content = background.read_text(encoding="utf-8")
        required_background_markers = (
            "127.0.0.1:8765",
            "/api/health",
            "OfferU",
            "redirect",
        )
        if not all(marker in background_content for marker in required_background_markers):
            findings.append(
                {
                    "path": _relative(background),
                    "kind": "stale_extension_background_artifact",
                }
            )

    popup = ROOT / "extension" / "popup.html"
    if popup.is_file():
        popup_content = popup.read_text(encoding="utf-8")
        if "src/popup.ts" in popup_content or not re.search(
            r"(?:^|[\"'])chunks/[^\"']+\.js",
            popup_content,
        ):
            findings.append(
                {
                    "path": _relative(popup),
                    "kind": "stale_extension_popup_artifact",
                }
            )

    return findings


def _call_name(node: ast.Call) -> str:
    if isinstance(node.func, ast.Attribute):
        owner = ast.unparse(node.func.value) if hasattr(ast, "unparse") else "?"
        return f"{owner}.{node.func.attr}"
    return ast.unparse(node.func) if hasattr(ast, "unparse") else "?"


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
            if not isinstance(call, ast.Call) or not isinstance(call.func, ast.Name):
                continue
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


def _sql_is_mutating(node: ast.AST) -> bool:
    if not isinstance(node, ast.Call):
        return False
    if any(
        isinstance(child, ast.Call)
        and isinstance(child.func, ast.Name)
        and child.func.id in MUTATING_SQL
        for child in ast.walk(node)
    ):
        return True
    if not isinstance(node.func, ast.Name) or node.func.id != "text" or not node.args:
        return False
    value = node.args[0]
    return (
        isinstance(value, ast.Constant)
        and isinstance(value.value, str)
        and re.match(
            r"^\s*(?:insert|update|delete|replace|alter|drop|create)\b",
            value.value,
            re.I,
        )
        is not None
    )


def _route_direct_mutations(path: Path, tree: ast.Module) -> list[dict[str, Any]]:
    findings: list[dict[str, Any]] = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call) or not isinstance(node.func, ast.Attribute):
            continue
        receiver = node.func.value
        if not isinstance(receiver, ast.Name) or receiver.id not in {"db", "session"}:
            continue
        if node.func.attr in MUTATING_METHODS:
            findings.append({"path": _relative(path), "line": node.lineno, "kind": f"db.{node.func.attr}"})
        elif node.func.attr == "execute" and node.args and _sql_is_mutating(node.args[0]):
            findings.append({"path": _relative(path), "line": node.lineno, "kind": "db.execute(write_sql)"})
    return findings


def _route_registry_bypasses(path: Path, tree: ast.Module) -> list[dict[str, Any]]:
    helpers = _local_helpers(tree)
    findings: list[dict[str, Any]] = []
    for name, node, methods in _route_functions(tree):
        if (path.name, name) in EXPLICIT_ROUTE_BOUNDARIES:
            continue
        if not _calls_registry(node, helpers):
            findings.append(
                {
                    "path": _relative(path),
                    "line": getattr(node, "lineno", 0),
                    "kind": "mutation_route_without_registry",
                    "methods": sorted(methods),
                    "function": name,
                }
            )
    return findings


def _route_mutating_service_bypasses(path: Path, tree: ast.Module) -> list[dict[str, Any]]:
    if path.name == "config.py":
        return []
    imported_mutators: set[str] = set()
    for node in tree.body:
        if not isinstance(node, ast.ImportFrom) or not node.module or not node.module.startswith("app."):
            continue
        for alias in node.names:
            if MUTATING_SERVICE_NAME.match(alias.name) and alias.name not in {"confirm_proposal"}:
                imported_mutators.add(alias.asname or alias.name)
    return [
        {
            "path": _relative(path),
            "line": node.lineno,
            "kind": "direct_mutating_service_call",
            "function": node.func.id,
        }
        for node in ast.walk(tree)
        if isinstance(node, ast.Call)
        and isinstance(node.func, ast.Name)
        and node.func.id in imported_mutators
    ]


def _imports(path: Path) -> set[str]:
    tree = ast.parse(path.read_text(encoding="utf-8"))
    modules: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom) and node.module:
            modules.add(node.module)
        elif isinstance(node, ast.Import):
            modules.update(alias.name for alias in node.names)
    return modules


def _lower_layer_import_bypasses() -> list[dict[str, Any]]:
    findings: list[dict[str, Any]] = []
    roots = {
        "models": BACKEND_DIR / "app" / "models",
        "agents": BACKEND_DIR / "app" / "agents",
        "services": BACKEND_DIR / "app" / "services",
    }
    for layer, root in roots.items():
        for path in sorted(root.rglob("*.py")):
            forbidden = sorted(
                module
                for module in _imports(path)
                if module == "app.routes" or module.startswith("app.routes.")
            )
            findings.extend(
                {"path": _relative(path), "kind": "lower_layer_imports_route", "layer": layer, "module": module}
                for module in forbidden
            )
    return findings


def _model_import_bypasses() -> list[dict[str, Any]]:
    findings: list[dict[str, Any]] = []
    forbidden_prefixes = ("app.routes", "app.services", "app.agents", "app.ops")
    for path in sorted((BACKEND_DIR / "app" / "models").rglob("*.py")):
        findings.extend(
            {
                "path": _relative(path),
                "kind": "model_imports_application_layer",
                "module": module,
            }
            for module in sorted(_imports(path))
            if module.startswith(forbidden_prefixes)
        )
    return findings


def _control_surface_bypasses() -> list[dict[str, Any]]:
    findings: list[dict[str, Any]] = []
    forbidden_imports = {
        # CLI Doctor is an intentionally read-only diagnostic boundary and
        # may inspect database health; business mutations still go through
        # the Registry calls checked below.
        "cli": {"app.models", "app.services.agent_operations"},
        "mcp": {"app.database", "app.models.models", "app.services.agent_operations"},
        "plugins": {"app.models.models", "app.database", "sqlalchemy"},
    }
    for surface, path in CONTROL_SURFACES.items():
        if not path.is_file():
            findings.append({"path": _relative(path), "kind": "missing_control_surface"})
            continue
        modules = _imports(path)
        for module in sorted(modules & forbidden_imports[surface]):
            findings.append({"path": _relative(path), "kind": "control_surface_domain_import", "module": module})

        tree = ast.parse(path.read_text(encoding="utf-8"))
        required: dict[str, set[str]] = {}
        if surface == "cli":
            required = {"_run_operation": {"execute_or_propose_operation"}, "_confirm_operation": {"confirm_operation_proposal"}}
        elif surface == "mcp":
            required = {
                "offeru_operation": {"execute_or_propose_operation"},
                "confirm_operation": {"confirm_operation_proposal"},
                "resource_profile": {"execute_or_propose_operation"},
            }
        for function_name, expected_calls in required.items():
            function = next(
                (
                    node
                    for node in tree.body
                    if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
                    and node.name == function_name
                ),
                None,
            )
            calls = {
                node.func.id
                for node in ast.walk(function)
                if isinstance(node, ast.Call) and isinstance(node.func, ast.Name)
            } if function is not None else set()
            for expected in sorted(expected_calls - calls):
                findings.append(
                    {
                        "path": _relative(path),
                        "kind": "control_surface_missing_registry_call",
                        "function": function_name,
                        "expected": expected,
                    }
                )
    return findings


def _frontend_provider_bypasses() -> list[dict[str, Any]]:
    findings: list[dict[str, Any]] = []
    source_root = ROOT / "frontend" / "src"
    if not source_root.is_dir():
        return [{"path": _relative(source_root), "kind": "missing_frontend_source"}]
    source_files = sorted({*source_root.rglob("*.ts"), *source_root.rglob("*.tsx")})
    for path in source_files:
        relative = _relative(path)
        if relative.startswith(PROVIDER_BRANCH_ALLOWLIST):
            continue
        for line, content in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
            if PROVIDER_COMPARISON.search(content):
                findings.append(
                    {
                        "path": relative,
                        "line": line,
                        "kind": "provider_specific_ui_branch",
                    }
                )
    return findings


def _local_entry_boundary_bypasses() -> list[dict[str, Any]]:
    """Keep user-facing local URLs and extension browser selection fail-closed."""

    findings: list[dict[str, Any]] = []
    legacy_root_binary = ROOT / "OfferU.exe"
    if legacy_root_binary.is_file():
        findings.append(
            {
                "path": _relative(legacy_root_binary),
                "kind": "legacy_root_executable_present",
            }
        )
    for path in LOCAL_ENTRY_FILES:
        if not path.is_file():
            findings.append({"path": _relative(path), "kind": "missing_local_entry_file"})
            continue
        for line, content in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
            if STALE_LOCAL_ENDPOINTS.search(content):
                findings.append(
                    {
                        "path": _relative(path),
                        "line": line,
                        "kind": "stale_local_endpoint",
                    }
                )
            if LEGACY_PORT_OVERRIDE.search(content):
                findings.append(
                    {
                        "path": _relative(path),
                        "line": line,
                        "kind": "legacy_backend_port_override",
                    }
                )

    popup_source = ROOT / "extension" / "popup.html"
    if popup_source.is_file():
        popup_content = popup_source.read_text(encoding="utf-8")
        if "src/popup.ts" not in popup_content or re.search(
            r"/chunks/popup-[^\"']+\.js", popup_content
        ):
            findings.append(
                {
                    "path": _relative(popup_source),
                    "kind": "stale_extension_popup_bundle_reference",
                }
            )

    wxt_config = ROOT / "extension" / "wxt.config.ts"
    if wxt_config.is_file():
        wxt_content = wxt_config.read_text(encoding="utf-8")
        if not re.search(r"webExt\s*:\s*\{[\s\S]*?disabled\s*:\s*true", wxt_content):
            findings.append(
                {
                    "path": _relative(wxt_config),
                    "kind": "extension_dev_runner_may_open_browser",
                }
            )
        if '"entrypoints:found"' not in wxt_content:
            findings.append(
                {
                    "path": _relative(wxt_config),
                    "kind": "root_popup_not_registered_with_wxt",
                }
            )

    vite_config = ROOT / "frontend" / "vite.config.ts"
    if vite_config.is_file():
        vite_content = vite_config.read_text(encoding="utf-8")
        if not re.search(r"server\s*:\s*\{[\s\S]*?open\s*:\s*false", vite_content):
            findings.append(
                {
                    "path": _relative(vite_config),
                    "kind": "frontend_dev_server_may_open_browser",
                }
            )

    sync_script = ROOT / "extension" / "scripts" / "sync-root-build.mjs"
    if sync_script.is_file():
        sync_content = sync_script.read_text(encoding="utf-8")
        if "REQUIRED_OUTPUTS" not in sync_content:
            findings.append(
                {
                    "path": _relative(sync_script),
                    "kind": "extension_sync_allows_stale_root_output",
                }
                )

    popup_ts = ROOT / "extension" / "src" / "popup.ts"
    if popup_ts.is_file():
        popup_content = popup_ts.read_text(encoding="utf-8")
        if "async function probeOfferUFrontend" not in popup_content:
            findings.append(
                {
                    "path": _relative(popup_ts),
                    "kind": "extension_frontend_probe_missing",
                }
            )
        if "mode: \"no-cors\"" in popup_content:
            findings.append(
                {
                    "path": _relative(popup_ts),
                    "kind": "extension_frontend_probe_uses_no_cors",
                }
            )
        if not all(
            marker in popup_content
            for marker in (
                "function normalizeReleaseDownloadUrl",
                'parsed.protocol !== "https:"',
                "更新地址不安全",
            )
        ):
            findings.append(
                {
                    "path": _relative(popup_ts),
                    "kind": "extension_update_navigation_guard_missing",
                }
            )

    email_page = ROOT / "frontend" / "src" / "app" / "email" / "page.tsx"
    if email_page.is_file():
        email_page_content = email_page.read_text(encoding="utf-8")
        if not all(
            marker in email_page_content
            for marker in (
                "function isTrustedGmailAuthUrl",
                'parsed.hostname === "accounts.google.com"',
                'parsed.pathname === "/o/oauth2/v2/auth"',
                "Gmail 授权地址异常，已停止跳转",
                "isTrustedGmailAuthUrl(result.auth_url)",
            )
        ):
            findings.append(
                {
                    "path": _relative(email_page),
                    "kind": "gmail_auth_navigation_guard_missing",
                }
            )

    email_route = ROOT / "backend" / "app" / "routes" / "email.py"
    if email_route.is_file():
        email_route_content = email_route.read_text(encoding="utf-8")
        if not all(
            marker in email_route_content
            for marker in (
                "DEFAULT_GMAIL_CALLBACK_URL",
                "validate_gmail_redirect_uri",
                'raise HTTPException(status_code=503',
            )
        ):
            findings.append(
                {
                    "path": _relative(email_route),
                    "kind": "gmail_callback_port_guard_missing",
                }
            )

    email_service = ROOT / "backend" / "app" / "services" / "email_sync.py"
    if email_service.is_file():
        email_service_content = email_service.read_text(encoding="utf-8")
        if not all(
            marker in email_service_content
            for marker in (
                'DEFAULT_GMAIL_CALLBACK_URL = "http://127.0.0.1:8765/api/email/callback"',
                "def validate_gmail_redirect_uri",
                "port != 8765",
                'parsed.path != "/api/email/callback"',
                "clean_redirect = validate_gmail_redirect_uri",
            )
        ):
            findings.append(
                {
                    "path": _relative(email_service),
                    "kind": "gmail_domain_callback_guard_missing",
                }
            )

    release_endpoints = ROOT / "backend" / "scripts" / "e2e" / "release_endpoints.py"
    if release_endpoints.is_file():
        release_content = release_endpoints.read_text(encoding="utf-8")
        if "ProxyHandler({})" not in release_content:
            findings.append(
                {
                    "path": _relative(release_endpoints),
                    "kind": "release_loopback_probe_inherits_proxy",
                }
            )
        if "_ALLOWED_RELEASE_URLS" not in release_content or "release smoke URL is not allowed" not in release_content:
            findings.append(
                {
                    "path": _relative(release_endpoints),
                    "kind": "release_loopback_probe_missing_url_allowlist",
                }
            )

    for path in _automated_browser_files():
        if not path.is_file():
            findings.append({"path": _relative(path), "kind": "missing_automated_browser_file"})
            continue
        for line, content in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
            if FORBIDDEN_AUTOMATED_BROWSER_SELECTORS.search(content):
                findings.append(
                    {
                        "path": _relative(path),
                        "line": line,
                        "kind": "system_browser_or_visible_automated_browser",
                    }
                )
    return findings


def _automation_model_bypasses() -> list[dict[str, Any]]:
    """Check that automation has one durable Event -> Rule -> Task entrypoint."""

    path = BACKEND_DIR / "app" / "services" / "automation.py"
    if not path.is_file():
        return [{"path": _relative(path), "kind": "missing_automation_dispatcher"}]
    tree = ast.parse(path.read_text(encoding="utf-8"))
    functions = {
        node.name: node
        for node in tree.body
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
    }
    findings: list[dict[str, Any]] = []
    required = {
        "record_automation_event": {"_process_automation_event"},
        "_process_automation_event": {
            "_claim_automation_event",
            "_rule",
            "_dispatch_job_saved",
            "_update_event",
        },
        "_dispatch_job_saved": {"start_career_task"},
        "recover_automation_events": {"_process_automation_event"},
    }
    for function_name, expected_calls in required.items():
        function = functions.get(function_name)
        if function is None:
            findings.append(
                {
                    "path": _relative(path),
                    "kind": "missing_automation_boundary",
                    "function": function_name,
                }
            )
            continue
        calls = {
            call.func.id
            for call in ast.walk(function)
            if isinstance(call, ast.Call) and isinstance(call.func, ast.Name)
        }
        for expected in sorted(expected_calls - calls):
            findings.append(
                {
                    "path": _relative(path),
                    "kind": "automation_missing_boundary_call",
                    "function": function_name,
                    "expected": expected,
                }
            )

    dispatcher_count = sum(
        1
        for node in tree.body
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
        and node.name == "_process_automation_event"
    )
    if dispatcher_count != 1:
        findings.append(
            {
                "path": _relative(path),
                "kind": "automation_dispatcher_count",
                "count": dispatcher_count,
            }
        )

    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        if isinstance(node.func, ast.Attribute) and node.func.attr == "create_task":
            findings.append(
                {
                    "path": _relative(path),
                    "line": node.lineno,
                    "kind": "automation_private_async_loop",
                }
            )
        if isinstance(node.func, ast.Name) and node.func.id in {
            "execute_deep_task",
            "start_runtime_run",
            "run_agent",
        }:
            findings.append(
                {
                    "path": _relative(path),
                    "line": node.lineno,
                    "kind": "automation_provider_bypass",
                    "call": node.func.id,
                }
            )
    return findings


def _startup_recovery_bypasses() -> list[dict[str, Any]]:
    """Check optional startup services stay inside the observable recovery seam."""

    path = BACKEND_DIR / "app" / "main.py"
    if not path.is_file():
        return [{"path": _relative(path), "kind": "missing_startup_recovery_boundary"}]
    tree = ast.parse(path.read_text(encoding="utf-8"))
    lifespan = next(
        (
            node
            for node in tree.body
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
            and node.name == "lifespan"
        ),
        None,
    )
    if lifespan is None:
        return [{"path": _relative(path), "kind": "missing_lifespan"}]

    required_services = {
        "email_sync": "start_email_sync_service",
        "memory_distill": "start_memory_distill_service",
        "work_source_auto_sync": "start_work_source_auto_sync",
    }
    findings: list[dict[str, Any]] = []
    recovery_names = {
        str(call.args[0].value)
        for call in ast.walk(lifespan)
        if isinstance(call, ast.Call)
        and isinstance(call.func, ast.Name)
        and call.func.id == "run_startup_recovery"
        and call.args
        and isinstance(call.args[0], ast.Constant)
        and isinstance(call.args[0].value, str)
    }
    for recovery_name, service_name in required_services.items():
        if recovery_name not in recovery_names:
            findings.append(
                {
                    "path": _relative(path),
                    "kind": "startup_service_outside_recovery",
                    "service": service_name,
                    "recovery": recovery_name,
                }
            )

    # A service may be referenced as the callable passed to the recovery
    # wrapper.  A direct call in the lifespan body would bypass health/error
    # reporting, so inspect only the non-nested statements here.
    direct_calls = {
        call.func.id
        for statement in lifespan.body
        if not isinstance(statement, (ast.FunctionDef, ast.AsyncFunctionDef))
        for call in ast.walk(statement)
        if isinstance(call, ast.Call)
        and isinstance(call.func, ast.Name)
        and call.func.id in required_services.values()
    }
    for service_name in sorted(direct_calls):
        findings.append(
            {
                "path": _relative(path),
                "kind": "direct_optional_startup_call",
                "service": service_name,
            }
        )
    return findings


def _public_web_transport_bypasses() -> list[dict[str, Any]]:
    """Keep public research HTTP paths direct, bounded and non-local."""

    requirements = {
        ROOT / "backend" / "app" / "services" / "web_search.py": (
            "_http_client",
            "follow_redirects=False",
            "trust_env=False",
            "_assert_public_destination",
            "asyncio.to_thread",
            "not ip.is_global",
        ),
        ROOT / "plugins" / "job-search" / "bin" / "job-search-cli.py": (
            "ProxyHandler({})",
            "class _NoRedirectHandler(HTTPRedirectHandler)",
            "_DIRECT_OPENER.open",
            "def _public_job_url",
            "ipaddress.ip_address(hostname)",
        ),
        ROOT / "backend" / "app" / "services" / "role_intelligence.py": (
            '_BACKEND_SEARCH_RUNTIME_ID = "backend_search"',
            "class BackendSearchRoleCollectionProvider",
            "allow_optional_ddgs=False",
            '"public_web_transport": "httpx-direct-manual-redirect-dns-v1"',
            'if clean == _BACKEND_SEARCH_RUNTIME_ID:',
            'if clean not in {"", "auto"}:',
        ),
    }
    findings: list[dict[str, Any]] = []
    for path, markers in requirements.items():
        if not path.is_file():
            findings.append({"path": _relative(path), "kind": "missing_public_web_transport_file"})
            continue
        source = path.read_text(encoding="utf-8")
        for marker in markers:
            if marker not in source:
                findings.append(
                    {
                        "path": _relative(path),
                        "kind": "public_web_transport_guard_missing",
                        "marker": marker,
                    }
                )
        if path.name == "job-search-cli.py" and "urlopen(" in source:
            findings.append(
                {
                    "path": _relative(path),
                    "kind": "job_search_plugin_inherits_default_urlopen",
                }
            )
    return findings


def _relative(path: Path) -> str:
    try:
        return path.resolve().relative_to(ROOT).as_posix()
    except ValueError:
        return path.as_posix()


def run_audit(*, include_generated_extension_artifacts: bool = False) -> dict[str, Any]:
    route_direct_mutations: list[dict[str, Any]] = []
    route_registry_bypasses: list[dict[str, Any]] = []
    route_service_bypasses: list[dict[str, Any]] = []
    route_files = sorted(ROUTES_DIR.glob("*.py"))
    route_function_count = 0
    for path in route_files:
        tree = ast.parse(path.read_text(encoding="utf-8"))
        route_direct_mutations.extend(_route_direct_mutations(path, tree))
        route_registry_bypasses.extend(_route_registry_bypasses(path, tree))
        route_service_bypasses.extend(_route_mutating_service_bypasses(path, tree))
        route_function_count += sum(1 for _ in _route_functions(tree))

    findings = {
        "route_direct_mutations": route_direct_mutations,
        "route_registry_bypasses": route_registry_bypasses,
        "route_mutating_service_bypasses": route_service_bypasses,
        "lower_layer_import_bypasses": _lower_layer_import_bypasses(),
        "model_import_bypasses": _model_import_bypasses(),
        "control_surface_bypasses": _control_surface_bypasses(),
        "frontend_provider_bypasses": _frontend_provider_bypasses(),
        "local_entry_boundary_bypasses": _local_entry_boundary_bypasses(),
        "release_e2e_endpoint_bypasses": _release_e2e_endpoint_bypasses(),
        "automation_model_bypasses": _automation_model_bypasses(),
        "startup_recovery_bypasses": _startup_recovery_bypasses(),
        "public_web_transport_bypasses": _public_web_transport_bypasses(),
    }
    if include_generated_extension_artifacts:
        findings["generated_extension_artifact_bypasses"] = _generated_extension_artifact_bypasses()
    finding_count = sum(len(items) for items in findings.values())
    return {
        "schema_version": "offeru.architecture_audit.v1",
        "repository": "OfferU",
        "scope": {
            "route_files": len(route_files),
            "route_mutation_functions": route_function_count,
            "control_surfaces": sorted(CONTROL_SURFACES),
            "lower_layers": ["app/models", "app/agents", "app/services"],
            "frontend_provider_branch_allowlist": list(PROVIDER_BRANCH_ALLOWLIST),
        "local_web_entry": {
            "frontend": "http://127.0.0.1:7410",
                "backend": "http://127.0.0.1:8765",
                "provider_8080_is_not_web": True,
            },
            "automation_dispatcher": "backend/app/services/automation.py::_process_automation_event",
        },
        "findings": findings,
        "finding_count": finding_count,
        "status": "clear" if finding_count == 0 else "violations",
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--json", action="store_true", help="Emit machine-readable JSON.")
    parser.add_argument(
        "--generated-extension-artifacts",
        action="store_true",
        help="Audit the tracked extension bundle after the guarded WXT build.",
    )
    args = parser.parse_args(argv)
    try:
        result = run_audit(
            include_generated_extension_artifacts=args.generated_extension_artifacts,
        )
    except (OSError, SyntaxError, UnicodeError) as exc:
        payload = {"schema_version": "offeru.architecture_audit.v1", "status": "error", "error": type(exc).__name__}
        print(json.dumps(payload, ensure_ascii=False, indent=2))
        return 2
    if args.json:
        print(json.dumps(result, ensure_ascii=False, indent=2))
    else:
        print(f"OfferU architecture audit: {result['status']} ({result['finding_count']} findings)")
    return 0 if result["finding_count"] == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
