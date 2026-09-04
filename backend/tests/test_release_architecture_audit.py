from __future__ import annotations

import ast
from pathlib import Path

from scripts.release import audit_architecture
from scripts.release.audit_architecture import (
    LOCAL_ENTRY_FILES,
    ROOT,
    _route_direct_mutations,
    _automated_browser_files,
    _automation_model_bypasses,
    _local_entry_boundary_bypasses,
    _release_e2e_endpoint_bypasses,
    _public_web_transport_bypasses,
    _startup_recovery_bypasses,
    run_audit,
)


def test_current_architecture_audit_is_clear() -> None:
    result = run_audit()

    assert result["status"] == "clear"
    assert result["finding_count"] == 0
    assert result["scope"]["route_files"] >= 1
    assert result["scope"]["route_mutation_functions"] >= 1
    assert all(not values for values in result["findings"].values())
    assert result["scope"]["automation_dispatcher"].endswith(
        "app/services/automation.py::_process_automation_event"
    )


def test_automation_has_one_event_rule_task_dispatcher() -> None:
    assert _automation_model_bypasses() == []


def test_optional_startup_services_use_observable_recovery_boundary() -> None:
    assert _startup_recovery_bypasses() == []


def test_local_entry_boundary_is_clear() -> None:
    assert _local_entry_boundary_bypasses() == []


def test_tracked_extension_artifact_is_produced_by_guarded_build() -> None:
    workflow = (ROOT / ".github/workflows/build.yml").read_text(encoding="utf-8")
    assert "npm run build" in workflow
    assert "--generated-extension-artifacts" in workflow


def test_generated_extension_artifact_guard_accepts_built_output(tmp_path, monkeypatch) -> None:
    extension_root = tmp_path / "extension"
    extension_root.mkdir()
    (extension_root / "manifest.json").write_text('{"manifest_version":3}', encoding="utf-8")
    (extension_root / "background.js").write_text(
        "127.0.0.1:8765 /api/health OfferU redirect",
        encoding="utf-8",
    )
    (extension_root / "popup.html").write_text(
        '<script src="chunks/popup-abc123.js"></script>',
        encoding="utf-8",
    )
    monkeypatch.setattr(audit_architecture, "ROOT", tmp_path)
    monkeypatch.setattr(
        audit_architecture,
        "GENERATED_EXTENSION_ARTIFACTS",
        tuple(extension_root / name for name in ("manifest.json", "background.js", "popup.html")),
    )

    assert audit_architecture._generated_extension_artifact_bypasses() == []


def test_public_release_e2e_endpoint_boundary_is_clear() -> None:
    assert _release_e2e_endpoint_bypasses() == []


def test_extension_web_navigation_is_readiness_gated() -> None:
    source = (ROOT / "extension" / "src" / "popup.ts").read_text(encoding="utf-8")
    gate_start = source.index("async function openOfferUFrontend")
    gate_end = source.index("function toFileUrl", gate_start)
    gate = source[gate_start:gate_end]

    assert "DEFAULT_OFFERU_FRONTEND_URL" in gate
    assert "AbortController" in gate
    assert "response.ok" in gate
    assert 'redirect: "error"' in gate
    assert gate.index("await fetch(") < gate.index("await chrome.tabs.create")
    assert "OfferU 网页服务未启动" in gate
    assert "async function probeOfferUFrontend" in source
    assert 'fetch(url, { ...init, redirect: "error" })' in source
    assert 'health.service !== "OfferU"' in source
    assert "const html = await response.text()" in source
    assert "return /OfferU/i.test(html)" in source
    assert "normalizeReleaseDownloadUrl" in source
    assert 'parsed.protocol !== "https:"' in source
    assert "更新地址不安全" in source
    assert 'mode: "no-cors"' not in source

    audit_source = (ROOT / "backend/scripts/release/audit_architecture.py").read_text(
        encoding="utf-8"
    )
    assert "extension_update_navigation_guard_missing" in audit_source


def test_resume_user_urls_cannot_inherit_provider_endpoint() -> None:
    for relative_path in (
        "backend/app/routes/resume.py",
        "backend/app/services/resume_route_operations.py",
    ):
        source = (ROOT / relative_path).read_text(encoding="utf-8")
        assert 'FRONTEND_BASE_URL = "http://127.0.0.1:7410"' in source
        assert 'os.getenv("FRONTEND_BASE_URL"' not in source
        assert "127.0.0.1:8080" not in source


def test_release_audit_covers_backend_container_entrypoint() -> None:
    paths = {path.as_posix() for path in LOCAL_ENTRY_FILES}
    assert (ROOT / "extension" / "popup.html").as_posix() in paths
    assert (ROOT / "extension" / "wxt.config.ts").as_posix() in paths
    assert (ROOT / "extension" / "src" / "popup.ts").as_posix() in paths
    assert (ROOT / "extension" / "src" / "background" / "server-url.ts").as_posix() in paths
    assert (ROOT / "extension" / "scripts" / "sync-root-build.mjs").as_posix() in paths

    assert any(path.endswith("backend/Dockerfile") for path in paths)
    assert (ROOT / "backend" / "app" / "cli.py").as_posix() in paths
    assert (ROOT / "backend" / "app" / "main.py").as_posix() in paths
    assert (ROOT / "backend" / "app" / "routes" / "email.py").as_posix() in paths
    assert (ROOT / "backend" / "app" / "services" / "email_sync.py").as_posix() in paths
    assert (ROOT / "backend" / "app" / "routes" / "resume.py").as_posix() in paths
    assert (ROOT / "backend" / "app" / "services" / "resume_route_operations.py").as_posix() in paths
    assert (ROOT / "frontend" / "src-tauri" / "tauri.conf.json").as_posix() in paths
    assert (ROOT / "frontend" / "src-tauri" / "src" / "lib.rs").as_posix() in paths
    assert (ROOT / "frontend" / "src" / "app" / "email" / "page.tsx").as_posix() in paths

    sync_source = (ROOT / "extension" / "scripts" / "sync-root-build.mjs").read_text(
        encoding="utf-8"
    )
    assert "readFileSync" in sync_source
    assert '"7410"' in sync_source
    assert "OfferU 网页服务未启动" in sync_source
    assert "Refusing to sync a stale popup" in sync_source
    assert "requiredBackgroundMarkers" in sync_source
    assert '"127.0.0.1:8765"' in sync_source
    assert "Refusing to sync a stale background" in sync_source

    background_source = (ROOT / "extension" / "src" / "background.ts").read_text(
        encoding="utf-8"
    )
    assert 'redirect: "error"' in background_source


def test_frontend_ready_gate_requires_offeru_health_identity() -> None:
    source = (ROOT / "frontend/src/app/providers.tsx").read_text(encoding="utf-8")
    assert "BACKEND_STARTUP_TIMEOUT_MS" in source
    assert 'payload?.status === "ok"' in source
    assert 'payload?.service === "OfferU"' in source
    assert 'payload?.runtime === "python"' in source
    assert 'const APP_VERSION = import.meta.env.VITE_APP_VERSION || "0.0.0"' in source
    assert 'payload?.version === APP_VERSION' in source
    assert 'redirect: "error"' in source
    assert 'data-testid="backend-ready-retry"' in source
    assert "无法连接 OfferU 后端" in source
    assert "8080 只是模型接口，不是网页地址" in source


def test_opencode_live_research_requires_controlled_web_adapter() -> None:
    source = (ROOT / "backend/app/services/coding_agent_runtime.py").read_text(
        encoding="utf-8"
    )
    start = source.index('    "opencode": {')
    end = source.index('    "pi": {', start)
    definition = source[start:end]

    assert '"supports_live_web_search": False' in definition
    assert "OfferU-controlled public-web adapter" in definition
    assert "redirect/private-address enforcement" in definition


def test_job_research_backend_fallback_uses_canonical_run_and_controlled_http() -> None:
    source = (ROOT / "backend/app/services/job_research.py").read_text(
        encoding="utf-8"
    )
    web_source = (ROOT / "backend/app/services/web_search.py").read_text(
        encoding="utf-8"
    )
    skill_source = (ROOT / "backend/app/agents/skills/jd-research/SKILL.md").read_text(
        encoding="utf-8"
    )

    assert '_BACKEND_SEARCH_RUNTIME_ID = "backend_search"' in source
    assert 'if run.runtime_id == _BACKEND_SEARCH_RUNTIME_ID' in source
    assert "_collect_backend_research" in source
    assert '"public_web_transport": "httpx-direct-manual-redirect-dns-v1"' in source
    assert "runtime_id=_BACKEND_SEARCH_RUNTIME_ID" in source
    assert "allow_optional_ddgs=False" in source
    assert "trust_env=False" in web_source
    assert "follow_redirects=False" in web_source
    assert "backend_search" in skill_source
    assert "run_backend_research" not in skill_source


def test_role_intelligence_auto_path_uses_controlled_backend_search_fallback() -> None:
    source = (ROOT / "backend/app/services/role_intelligence.py").read_text(
        encoding="utf-8"
    )

    assert 'runtime_id: str = "auto"' in source
    assert "class BackendSearchRoleCollectionProvider" in source
    assert "_collect_backend_role_benchmark" in source
    assert "allow_optional_ddgs=False" in source
    assert '"public_web_transport": "httpx-direct-manual-redirect-dns-v1"' in source
    assert 'if clean not in {"", "auto"}:' in source
    assert _public_web_transport_bypasses() == []


def test_windows_installed_smoke_requires_release_health_identity() -> None:
    source = (ROOT / ".github/workflows/build.yml").read_text(encoding="utf-8")
    smoke_start = source.index("  desktop-installed-smoke:")
    smoke_end = source.index("  release:", smoke_start)
    smoke = source[smoke_start:smoke_end]

    assert "browser = 'none'" in smoke
    assert "web_url = 'not_used'" in smoke
    assert "api_url = 'http://127.0.0.1:8765'" in smoke
    assert "release-assets/version.json" in smoke
    assert "$expectedVersion" in smoke
    assert "$healthHandler.AllowAutoRedirect = $false" in smoke
    assert "$healthHandler.UseProxy = $false" in smoke
    assert "$healthClient.GetAsync('http://127.0.0.1:8765/api/health')" in smoke
    assert "$health.status -eq 'ok'" in smoke
    assert "$health.service -eq 'OfferU'" in smoke
    assert "$health.runtime -eq 'python'" in smoke
    assert "$health.build_mode -eq 'release'" in smoke
    assert "$health.version -eq $expectedVersion" in smoke
    assert "ownedSidecarPath" in smoke
    assert "Start-Process -FilePath $app.FullName -WindowStyle Hidden" in smoke
    assert "8080" not in smoke


def test_ci_local_service_waits_verify_page_and_runtime_identity() -> None:
    source = (ROOT / ".github/workflows/build.yml").read_text(encoding="utf-8")

    assert source.count('b"OfferU" not in body') >= 2
    assert source.count('payload.get("build_mode") != "local-development"') >= 2
    assert source.count('payload.get("version") != expected_version') >= 2
    assert 'b"OfferU" in response.read(8192)' in source
    assert source.count("NoRedirectHandler") >= 3
    assert source.count("urllib.request.ProxyHandler({})") >= 3


def test_migration_smoke_requires_current_health_identity() -> None:
    source = (ROOT / "backend/scripts/e2e/test_public_release_migration.py").read_text(
        encoding="utf-8"
    )
    assert "release_version" in source
    assert '"OFFERU_BUILD_MODE": "local-development"' in source
    assert '"OFFERU_RUNTIME_MODE": "local"' in source
    assert "expect_offeru_frontend=True" in source
    assert "invalid OfferU frontend identity" in source
    assert 'expected_version=expected_version' in source
    assert 'expected_build_mode="local-development"' in source


def test_worker_soak_requires_current_health_identity() -> None:
    source = (ROOT / "backend/scripts/e2e/test_public_release_worker_soak.py").read_text(
        encoding="utf-8"
    )
    assert "release_version" in source
    assert "expected_version=release_version()" in source
    assert 'expected_build_mode="local-development"' in source


def test_frontend_api_base_is_local_only() -> None:
    source = (ROOT / "frontend/src/lib/apiBase.ts").read_text(encoding="utf-8")
    assert 'const DEFAULT_API_BASE = "http://127.0.0.1:8765"' in source
    assert 'return parsed.origin' not in source
    assert "window.location.hostname" not in source


def test_extension_control_probe_requires_release_health_identity() -> None:
    source = (ROOT / "extension/src/background/offeru-control-http.ts").read_text(
        encoding="utf-8"
    )
    assert "function isOfferUHealthIdentity" in source
    assert 'payload.status === "ok"' in source
    assert 'payload.service === "OfferU"' in source
    assert 'payload.runtime === "python"' in source
    assert "payload.version.trim().length > 0" in source
    assert 'payload.build_mode === "local-development"' in source
    assert 'payload.build_mode === "release"' in source
    assert "ok: isOfferUHealthIdentity(health)" in source


def test_extension_http_adapter_does_not_echo_backend_error_body() -> None:
    source = (ROOT / "extension/src/background/offeru-control-http.ts").read_text(
        encoding="utf-8"
    )
    assert 'resp.headers.get("X-OfferU-Error-Id")' in source
    assert "HTTP ${resp.status}" in source
    assert "await resp.text()" not in source
    assert "text.slice(0, 300)" not in source


def test_extension_user_errors_use_bounded_redaction() -> None:
    helper = (ROOT / "extension/src/lib/safe-error.ts").read_text(encoding="utf-8")
    assert "MAX_ERROR_LENGTH = 240" in helper
    assert "[local endpoint]" in helper
    assert "[credential]" in helper
    assert "[email]" in helper
    assert "[phone]" in helper
    assert "SAFE_DEBUG_KEYS" in helper
    assert "safeExtensionDebugPayload" in helper

    for relative_path in (
        "extension/src/background.ts",
        "extension/src/popup.ts",
        "extension/src/content.ts",
        "extension/src/page-agent/collect.ts",
        "extension/src/rule-packs/remote.ts",
        "extension/src/background/offeru-control-http.ts",
        "extension/src/content/smartfill-v2/write/cascade-writer.ts",
    ):
        source = (ROOT / relative_path).read_text(encoding="utf-8")
        assert "safeExtensionError" in source

    background = (ROOT / "extension/src/background.ts").read_text(encoding="utf-8")
    content = (ROOT / "extension/src/content.ts").read_text(encoding="utf-8")
    assert "error instanceof Error ? error.message : String(error)" not in background
    assert "error instanceof Error ? error.message : String(error)" not in content
    popup = (ROOT / "extension/src/popup.ts").read_text(encoding="utf-8")
    assert 'console.error("[OfferU Popup] bootstrap failed:", text)' in popup
    logger = (ROOT / "extension/src/content/smartfill-v2/shared/logger.ts").read_text(
        encoding="utf-8"
    )
    assert "console.log(safeExtensionDebugPayload(payload))" in background
    assert "console.log(safeExtensionDebugPayload(payload))" in logger


def test_frontend_user_errors_use_bounded_redaction() -> None:
    helper = (ROOT / "frontend/src/lib/safe-error.ts").read_text(encoding="utf-8")
    assert "CLIENT_ERROR_MAX_LENGTH = 500" in helper
    assert "[local endpoint]" in helper
    assert "[credential]" in helper
    assert "[email]" in helper
    assert "[phone]" in helper
    assert "safeClientErrorMessage" in helper

    user_surface_paths = (
        "frontend/src/lib/hooks.ts",
        "frontend/src/lib/showcase/llm.ts",
        "frontend/src/lib/agentToolPresentation.ts",
        "frontend/src/app/page.tsx",
        "frontend/src/app/applications/page.tsx",
        "frontend/src/app/email/page.tsx",
        "frontend/src/app/interview/page.tsx",
        "frontend/src/app/interview/ai/page.tsx",
        "frontend/src/app/interview/ai/components/InterviewStage.tsx",
        "frontend/src/app/interview/pose/page.tsx",
        "frontend/src/app/jobs/page.tsx",
        "frontend/src/app/jobs/[id]/page.tsx",
        "frontend/src/app/optimize/components/ConversationList.tsx",
        "frontend/src/app/optimize/components/OptimizeChatPanel.tsx",
        "frontend/src/app/profile/page.tsx",
        "frontend/src/app/profile/components/AIImportModal.tsx",
        "frontend/src/app/profile/components/BulletConfirmCard.tsx",
        "frontend/src/app/profile/components/ChatPanel.tsx",
        "frontend/src/app/profile/components/ProfileOnboarding.tsx",
        "frontend/src/app/profile/components/archive/CareerLedgerPanel.tsx",
        "frontend/src/app/resume/page.tsx",
        "frontend/src/app/resume/[id]/page.tsx",
        "frontend/src/app/resume/components/AiGenerateDrawer.tsx",
        "frontend/src/app/resume/components/AiOptimizeDrawer.tsx",
        "frontend/src/app/settings/page.tsx",
        "frontend/src/components/ai/ProfileAgentDock.tsx",
        "frontend/src/components/jobs/AddJobModal.tsx",
        "frontend/src/components/jobs/BatchOptimizeModal.tsx",
        "frontend/src/components/jobs/RoleIntelligencePanel.tsx",
        "frontend/src/components/onboarding/OnboardingWizard.tsx",
        "frontend/src/components/progress-board.tsx",
        "frontend/src/components/workbench/AgentPanel.tsx",
    )

    for relative_path in user_surface_paths:
        source = (ROOT / relative_path).read_text(encoding="utf-8")
        assert "safeClientErrorMessage" in source, relative_path
        assert "error instanceof Error ? error.message" not in source, relative_path
        assert "err.message ||" not in source, relative_path
        assert "err?.message ||" not in source, relative_path
        assert "e instanceof Error ? e.message" not in source, relative_path
        assert "e?.message ||" not in source, relative_path

    hooks = (ROOT / "frontend/src/lib/hooks.ts").read_text(encoding="utf-8")
    assert "throw new Error(err.detail ||" not in hooks
    assert "throw new Error(payload.detail ||" not in hooks
    assert "throw new Error(confirmed.detail ||" not in hooks
    assert "无法连接本地后端 ${API_BASE}" not in hooks


def test_doctor_has_fail_closed_release_exit_mode() -> None:
    source = (ROOT / "backend/app/cli.py").read_text(encoding="utf-8")
    assert '"--require-ready"' in source
    assert 'release_readiness.get("status") == "CORE_READY"' in source
    assert "exit_code=0 if ready else 1" in source
    assert 'payload.get("version") != APP_VERSION' in source
    assert 'b"OfferU" in body' in source


def test_automated_browser_audit_excludes_only_non_automated_boundaries() -> None:
    paths = {path.as_posix() for path in _automated_browser_files()}

    assert not any(path.endswith("backend/app/services/authorized_research.py") for path in paths)
    assert not any(path.endswith("backend/scripts/e2e/test_resume_template_contract.py") for path in paths)
    assert any(path.endswith("backend/app/routes/resume.py") for path in paths)
    assert any(path.endswith("backend/app/services/pdf_exporter.py") for path in paths)
    assert any(path.endswith("_tmp_online.cjs") for path in paths)


def test_gmail_auth_navigation_is_allowlisted() -> None:
    source = (ROOT / "frontend/src/app/email/page.tsx").read_text(encoding="utf-8")
    assert "function isTrustedGmailAuthUrl" in source
    assert 'parsed.protocol === "https:"' in source
    assert 'parsed.hostname === "accounts.google.com"' in source
    assert 'parsed.pathname === "/o/oauth2/v2/auth"' in source
    assert "!parsed.username" in source
    assert "!parsed.password" in source
    assert "Gmail 授权地址异常，已停止跳转" in source
    assert "isTrustedGmailAuthUrl(result.auth_url)" in source


def test_gmail_callback_cannot_use_stale_local_port() -> None:
    route_source = (ROOT / "backend/app/routes/email.py").read_text(encoding="utf-8")
    service_source = (ROOT / "backend/app/services/email_sync.py").read_text(encoding="utf-8")
    assert 'DEFAULT_GMAIL_CALLBACK_URL' in route_source
    assert "validate_gmail_redirect_uri" in route_source
    assert 'raise HTTPException(status_code=503' in route_source
    assert 'DEFAULT_GMAIL_CALLBACK_URL = "http://127.0.0.1:8765/api/email/callback"' in service_source
    assert "def validate_gmail_redirect_uri" in service_source
    assert 'parsed.hostname.lower() not in _LOCAL_CALLBACK_HOSTS' in service_source
    assert "port != 8765" in service_source
    assert 'parsed.path != "/api/email/callback"' in service_source
    assert "clean_redirect = validate_gmail_redirect_uri" in service_source


def test_docker_examples_require_explicit_secrets() -> None:
    env_example = (ROOT / ".env.example").read_text(encoding="utf-8")
    compose = (ROOT / "docker-compose.yml").read_text(encoding="utf-8")

    assert "DB_PASSWORD=QX7OeA7bzp0m07u03m18CJUMXRY9Y1OZ" not in env_example
    assert "DB_PASSWORD=" in env_example
    assert "SECRET_KEY=change-me-to-a-random-string-in-production" not in env_example
    assert "SECRET_KEY=" in env_example
    assert "${DB_PASSWORD:?Set DB_PASSWORD in .env before starting Docker Compose}" in compose
    assert "${SECRET_KEY:?Set SECRET_KEY in .env before starting Docker Compose}" in compose
    assert "${DB_PASSWORD:-" not in compose
    assert "${SECRET_KEY:-" not in compose


def test_resume_export_redacts_renderer_failures() -> None:
    source = (ROOT / "backend/app/services/resume_export.py").read_text(encoding="utf-8")

    assert "from app.services.security_redaction import safe_error_message" in source
    assert "safe_error_message(playwright_error)" in source
    assert "safe_error_message(fallback_error)" in source
    assert "f\"PDF 渲染失败（Playwright: {playwright_error}" not in source
    assert "f\"备用渲染器: {fallback_error}" not in source


def test_external_database_startup_does_not_enter_sqlite_restore_path() -> None:
    source = (ROOT / "backend/app/main.py").read_text(encoding="utf-8")

    assert 'settings.database_url.strip().lower().startswith("sqlite")' in source
    assert '"reason": "external_database_data_safety_not_applicable"' in source
    assert "Data Safety is deliberately local SQLite-only" in source


def test_llm_endpoint_probes_are_direct_and_redacted() -> None:
    store_source = (ROOT / "backend/app/llm_config_store.py").read_text(encoding="utf-8")
    route_source = (ROOT / "backend/app/routes/config.py").read_text(encoding="utf-8")

    for source in (store_source, route_source):
        assert "follow_redirects=False" in source
        assert "trust_env=False" in source
        assert "safe_error_message(exc)" in source

    assert "err_msg = redact_sensitive_text(err_msg, max_length=300)" in store_source
    assert "err_msg = redact_sensitive_text(err_msg, max_length=300)" in route_source
    assert "f\"检测失败: {exc}\"" not in store_source


def test_local_llm_discovery_save_error_is_redacted() -> None:
    source = (ROOT / "backend/app/llm_config_store.py").read_text(encoding="utf-8")
    assert 'errors.append(f"保存配置失败: {safe_error_message(exc)}")' in source
    assert 'errors.append(f"保存配置失败: {exc}")' not in source


def test_public_web_http_boundary_is_direct_and_redirect_bounded() -> None:
    source = (ROOT / "backend/app/services/web_search.py").read_text(encoding="utf-8")

    assert "_MAX_REDIRECTS = 3" in source
    assert "_REDIRECT_STATUSES = {301, 302, 303, 307, 308}" in source
    assert "socket.getaddrinfo" in source
    assert "parsed.username or parsed.password" in source
    assert "await _assert_public_destination(current_url)" in source
    assert "follow_redirects=False" in source
    assert "trust_env=False" in source
    assert "next_url = urljoin(current_url, location)" in source
    assert "response.close()" in source
    assert "目标经重定向指向非公网地址，已拒绝抓取" in source
    assert "async with httpx.AsyncClient(timeout=_TIMEOUT)" not in source
    assert "follow_redirects=True" not in source


def test_llm_config_writes_are_atomic() -> None:
    store_source = (ROOT / "backend/app/llm_config_store.py").read_text(encoding="utf-8")
    route_source = (ROOT / "backend/app/routes/config.py").read_text(encoding="utf-8")

    assert "def save_llm_config_file" in store_source
    assert "os.replace(temporary, _CONFIG_FILE)" in store_source
    assert "save_llm_config_file(raw)" in store_source
    assert "from app.llm_config_store import save_llm_config_file" in route_source
    assert "save_llm_config_file(cfg.model_dump())" in route_source
    assert "_CONFIG_FILE.write_text" not in store_source
    assert "_CONFIG_FILE.write_text" not in route_source


def test_user_visible_bridge_and_optional_dependency_errors_are_redacted() -> None:
    bridge_source = (ROOT / "backend/app/services/agent_bridge/codex_adapter.py").read_text(
        encoding="utf-8"
    )
    email_source = (ROOT / "backend/app/routes/email.py").read_text(encoding="utf-8")
    resume_source = (ROOT / "backend/app/routes/resume.py").read_text(encoding="utf-8")

    assert "f\"error: {safe_error_message(exc)}\"" in bridge_source
    assert "f\"error: {type(exc).__name__}: {exc}\"" not in bridge_source
    assert "detail=safe_error_message(exc)" in email_source
    assert "detail=str(exc)" not in email_source
    assert "Playwright is not installed: {safe_error_message(exc)}" in resume_source


def test_skill_pipeline_redacts_skill_failures_before_agent_projection() -> None:
    source = (ROOT / "backend/app/agents/skills/__init__.py").read_text(encoding="utf-8")

    assert "from app.services.security_redaction import safe_error_message" in source
    assert 'context[skill.name] = {"error": safe_error_message(e)}' in source
    assert 'context[skill.name] = {"error": str(e)}' not in source


def test_research_failure_projections_use_shared_error_boundary() -> None:
    role_source = (ROOT / "backend/app/services/role_intelligence.py").read_text(encoding="utf-8")
    driver_source = (ROOT / "backend/scripts/run_research_driver.py").read_text(encoding="utf-8")

    assert "safe_error = safe_error_message(ValueError(raw_error))" in role_source
    assert "else safe_error or None" in role_source
    assert "else raw_error[:1000] or None" not in role_source
    assert "from app.services.security_redaction import safe_error_message" in driver_source
    assert 'print("TASK_EXC=" + safe_error_message(exc), flush=True)' in driver_source
    assert 'print("TASK_EXC=" + str(exc)[:500], flush=True)' not in driver_source


def test_coding_agent_runtime_redacts_provider_process_failures() -> None:
    source = (ROOT / "backend/app/services/coding_agent_runtime.py").read_text(
        encoding="utf-8"
    )
    assert "redact_sensitive_text(error, max_length=1000)" in source
    assert "stderr = redact_sensitive_text(" in source
    assert "raise RuntimeError(redact_sensitive_text(failure_message, max_length=1000))" in source
    assert 'worker 退出码 {process.returncode}: {stderr[-1000:]}' not in source


def test_capability_plugin_stderr_is_bounded_and_redacted() -> None:
    source = (ROOT / "backend/app/services/capability_plugins.py").read_text(
        encoding="utf-8"
    )
    assert "redact_sensitive_text" in source
    assert "diagnostics = redact_sensitive_text(" in source
    assert "max_length=2000" in source
    assert 'diagnostics = stderr.decode("utf-8", errors="replace")[-2000:]' not in source


def test_shared_redaction_covers_standalone_provider_credentials() -> None:
    source = (ROOT / "backend/app/services/security_redaction.py").read_text(
        encoding="utf-8"
    )
    assert "_STANDALONE_CREDENTIAL" in source
    assert "sk|rk|pk" in source
    assert "gh[pousr]_" in source
    assert "AIza" in source
    assert "_STANDALONE_CREDENTIAL.sub(\"[redacted]\", text)" in source


def test_extension_smart_fill_requests_do_not_echo_http_error_bodies() -> None:
    source = (ROOT / "extension/src/background.ts").read_text(encoding="utf-8")
    assert 'response.headers.get("X-OfferU-Error-Id")' in source
    assert "HTTP ${response.status}" in source
    assert "const text = await response.text()" not in source
    assert "throw new Error(text ||" not in source


def test_extension_direct_fetches_reject_redirects() -> None:
    sources = {
        relative_path: (ROOT / relative_path).read_text(encoding="utf-8")
        for relative_path in (
            "extension/src/content.ts",
            "extension/src/popup.ts",
            "extension/src/rule-packs/remote.ts",
        )
    }
    assert 'redirect: "error"' in sources["extension/src/content.ts"]
    assert sources["extension/src/popup.ts"].count('redirect: "error"') >= 3
    assert 'redirect: "error"' in sources["extension/src/rule-packs/remote.ts"]


def test_pi_guardian_failure_uses_shared_safe_error_boundary() -> None:
    source = (ROOT / "backend/app/services/pi_agent_host.py").read_text(encoding="utf-8")
    assert "guardian_error_message = safe_error_message(guardian_error)" in source
    assert '"error": guardian_error_message' in source
    assert '"error": str(guardian_error)[:500]' not in source
    assert '{"error": str(guardian_error)[:500]}' not in source


def test_frontend_network_errors_do_not_echo_raw_transport_text() -> None:
    api_source = (ROOT / "frontend/src/lib/api.ts").read_text(encoding="utf-8")
    hooks_source = (ROOT / "frontend/src/lib/hooks.ts").read_text(encoding="utf-8")
    assert "原始错误" not in api_source
    assert "原始错误" not in hooks_source
    assert "const errorId = res.headers.get(\"X-OfferU-Error-Id\")" in hooks_source
    assert "const text = await res.text()" not in hooks_source


def test_frontend_api_clients_reject_redirects() -> None:
    api_source = (ROOT / "frontend/src/lib/api.ts").read_text(encoding="utf-8")
    hooks_source = (ROOT / "frontend/src/lib/hooks.ts").read_text(encoding="utf-8")
    providers_source = (ROOT / "frontend/src/app/providers.tsx").read_text(encoding="utf-8")
    workbench_source = (ROOT / "frontend/src/components/workbench/WorkbenchShell.tsx").read_text(
        encoding="utf-8"
    )
    studio_source = (ROOT / "frontend/src/app/studio/page.tsx").read_text(encoding="utf-8")
    optimize_source = (ROOT / "frontend/src/app/optimize/components/OptimizeChatPanel.tsx").read_text(
        encoding="utf-8"
    )
    settings_source = (ROOT / "frontend/src/app/settings/page.tsx").read_text(encoding="utf-8")
    showcase_source = (ROOT / "frontend/src/lib/showcase/llm.ts").read_text(encoding="utf-8")
    assert api_source.count('redirect: "error"') >= 2
    assert hooks_source.count('redirect: "error"') >= 2
    assert 'redirect: "error"' in providers_source
    assert 'redirect: "error"' in workbench_source
    assert studio_source.count('redirect: "error"') >= 2
    assert optimize_source.count('redirect: "error"') >= 2
    assert settings_source.count('redirect: "error"') >= 2
    assert 'redirect: "error"' in showcase_source


def test_job_search_plugin_uses_direct_public_source_without_redirects() -> None:
    source = (ROOT / "plugins/job-search/bin/job-search-cli.py").read_text(encoding="utf-8")
    assert 'API_URL = "https://www.arbeitnow.com/api/job-board-api"' in source
    assert "class _NoRedirectHandler(HTTPRedirectHandler)" in source
    assert "return None" in source
    assert "_DIRECT_OPENER = build_opener(ProxyHandler({}), _NoRedirectHandler())" in source
    assert "_DIRECT_OPENER.open(request, timeout=20)" in source
    assert "from urllib.request import Request, urlopen" not in source
    assert "def _public_job_url" in source
    assert "ipaddress.ip_address(hostname)" in source
    assert "hostname == \"localhost\"" in source


def test_architecture_audit_includes_public_web_transport_boundary() -> None:
    source = (ROOT / "backend/scripts/release/audit_architecture.py").read_text(encoding="utf-8")
    assert "def _public_web_transport_bypasses" in source
    assert '"public_web_transport_bypasses"' in source
    assert "job_search_plugin_inherits_default_urlopen" in source


def test_release_audit_covers_gmail_navigation_guards() -> None:
    source = (ROOT / "backend/scripts/release/audit_architecture.py").read_text(
        encoding="utf-8"
    )
    assert "gmail_auth_navigation_guard_missing" in source
    assert "gmail_callback_port_guard_missing" in source
    assert "gmail_domain_callback_guard_missing" in source


def test_route_sqlalchemy_mutation_is_reported() -> None:
    path = Path("backend/app/routes/_fixture.py")
    tree = ast.parse(
        """
async def fixture(db):
    db.execute(update(jobs).values(status='x'))
    db.commit()
"""
    )

    findings = _route_direct_mutations(path, tree)

    assert [item["kind"] for item in findings] == [
        "db.execute(write_sql)",
        "db.commit",
    ]
