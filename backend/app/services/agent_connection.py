"""Read-only local Agent onboarding; business execution stays in the Registry.

Discovery, a local protocol handshake, and successful model execution are
different evidence. Never turn a detected CLI or Replay fixture into a live
connection, and never erase a persisted provider failure after a local check.
"""

from __future__ import annotations

import asyncio
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from app.services import coding_agent_runtime as runtime
from app.services.agent_integration import integration_manager
from app.services.agent_provider_health import list_provider_health
from app.services.security_redaction import redact_sensitive_text

_CHECKS: dict[str, dict[str, Any]] = {}
_CHECK_LOCK = asyncio.Lock()
_CHECK_TTL = 120

from app.services.agent_host_registry import (
    beginner_host_ids,
    get_host,
    recommended_host_id,
)


def _can_install_skill(provider_id: str) -> bool:
    """Whether OfferU can install/update the canonical Skill into this host.

    Replaces the former hard-coded _BEGINNER_PROVIDER_IDS gate: a host that is
    only a hosted runtime (pi/omp/gemini/codebuddy) has no skill-install face.
    """
    host = get_host(provider_id)
    return bool(host and host.can_install_skill)


def _view(item: dict[str, Any], health: dict[str, Any]) -> dict[str, Any]:
    provider_id = item["id"]
    can_install = _can_install_skill(provider_id)
    integration = integration_manager.inspect(provider_id) if can_install else {
        "skill_status": "NOT_SUPPORTED",
        "skill_version": "",
        "skill_hash": "",
        "expected_skill_version": "",
        "expected_skill_hash": "",
        "registry_hash": "",
        "can_install": False,
        "can_live_verify": False,
        "error": "",
    }
    executable = (
        integration_manager.adapter(provider_id).detected_executable(str(item.get("executable_path") or ""))
        if can_install
        else str(item.get("executable_path") or "")
    )
    check = _CHECKS.get(provider_id, {})
    if (time.monotonic() - check.get("at", 0) > _CHECK_TTL
            or check.get("version") != item.get("version")
            or check.get("executable") != executable
            or check.get("skill_hash", integration.get("expected_skill_hash")) != integration.get("expected_skill_hash")):
        check = {}
    installed = bool(executable)
    compatible = bool(item.get("contract_compatible"))
    status = "check_required"
    if not installed:
        status = "missing"
    elif not compatible:
        status = "incompatible"
    elif health.get("blocked") or health.get("status") == "blocked":
        status = "blocked"
    elif health.get("authenticated") is False or health.get("status") == "auth_required":
        status = "auth_required"
    elif health.get("status") == "unavailable" and health.get("checked_at"):
        status = "failed"
    elif integration["skill_status"] == "NOT_INSTALLED":
        status = "integration_missing"
    elif integration["skill_status"] == "OUTDATED":
        status = "outdated"
    elif integration["skill_status"] == "ERROR":
        status = "failed"
    elif check.get("integration_status") == "VERIFIED":
        status = "ready"
    elif check:
        status = check["status"]
    capabilities = health.get("capabilities") if isinstance(health.get("capabilities"), dict) else {}
    conformance = capabilities.get("conformance") if isinstance(capabilities.get("conformance"), dict) else {}
    conformance_matches = bool(
        conformance.get("binary_path") == item.get("executable_path")
        and conformance.get("version") == item.get("version")
    )
    persisted_authenticated = conformance_matches and conformance.get("native_auth_detected") == "VERIFIED"
    live_model_verified = bool(
        conformance_matches and conformance.get("live_model_verified") == "VERIFIED"
    )
    def conformance_state(field: str) -> str:
        if not conformance_matches:
            return "NOT_VERIFIED"
        value = str(conformance.get(field) or "NOT_VERIFIED")
        return value if value in {
            "SUPPORTED",
            "VERIFIED",
            "UNSUPPORTED",
            "NOT_VERIFIED",
            "BLOCKED_AUTH",
            "UNAVAILABLE",
            "ERROR",
        } else "NOT_VERIFIED"

    return {
        "id": provider_id,
        "name": item["name"],
        "installed": installed,
        "compatible": compatible,
        "version": redact_sensitive_text(item.get("version") or "", max_length=160),
        "status": status,
        "authenticated": (
            check.get("authenticated")
            if check
            else True
            if persisted_authenticated
            else False
            if conformance_matches and conformance.get("native_auth_detected") == "BLOCKED_AUTH"
            else None
        ),
        "connection_verified": compatible and check.get("integration_status") == "VERIFIED",
        "integration_status": check.get("integration_status") or integration["skill_status"],
        "skill_status": integration["skill_status"],
        "skill_version": integration["skill_version"],
        "skill_hash": integration["skill_hash"],
        "expected_skill_version": integration["expected_skill_version"],
        "expected_skill_hash": integration["expected_skill_hash"],
        "can_install_skill": integration["can_install"],
        "can_live_verify_skill": integration["can_live_verify"],
        "auth_mode": check.get("auth_mode", "native_probe" if persisted_authenticated else "unknown"),
        "checked_at": check.get("checked_at") or conformance.get("last_probe_at"),
        "detected_at": item.get("checked_at"),
        "last_error": redact_sensitive_text(
            health.get("last_error") or check.get("error") or integration.get("error") or "", max_length=500,
        ),
        "provider_checked_at": health.get("checked_at"),
        "docs_url": (get_host(provider_id).docs_url if get_host(provider_id) else ""),
        "can_verify_login": bool(get_host(provider_id) and get_host(provider_id).can_verify_login),
        "live_model_verified": live_model_verified,
        "native_auth_state": conformance_state("native_auth_detected"),
        "live_model_state": conformance_state("live_model_verified"),
        "structured_output_state": conformance_state("structured_output_verified"),
        "streaming_state": conformance_state("streaming_verified"),
        "resume_state": conformance_state("resume_verified"),
        "cancel_state": conformance_state("cancel_verified"),
        "cwd_isolation_state": conformance_state("cwd_isolation_verified"),
        "web_search_state": conformance_state("web_search_verified"),
        "conformance_checked_at": conformance.get("last_probe_at") if conformance_matches else None,
        "beginner": bool(get_host(provider_id) and get_host(provider_id).beginner),
        "recommended": bool(get_host(provider_id) and get_host(provider_id).recommended),
    }


async def get_agent_connections() -> dict[str, Any]:
    detected, health = await asyncio.gather(
        runtime.list_local_executors(), list_provider_health(),
    )
    by_id = {item["provider_id"]: item for item in health["providers"]}
    skill = Path(__file__).resolve().parents[3] / ".agents" / "skills" / "offeru" / "SKILL.md"
    skill_instruction = (
        f"请先阅读本机文件 {skill}，按其中的 OfferU 接入约定发现实时能力。"
        if skill.is_file()
        else "请先通过 OfferU Agent Bridge 的实时 manifest 发现能力，不要猜测固定命令。"
    )
    connect_prompt = (
        f"{skill_instruction}"
        "先检查连接，再查看 get_current_view 的 schema，通过该只读 Operation 读取我在 OfferU 中同步的当前页面和选中对象。"
        "请告诉我你实际读到了什么，然后等待我的任务。不要修改数据、配置、凭据或代理；"
        "后续业务操作继续使用同一 Operation Registry，写入先在 OfferU 中等待我确认。"
    )
    return {
        "items": [_view(item, by_id.get(item["id"], {})) for item in detected["items"]],
        "checked_at": datetime.now(timezone.utc).isoformat(),
        "connect_prompt": connect_prompt,
        "beginner_provider_ids": beginner_host_ids(),
        "recommended_provider_id": recommended_host_id(),
    }


async def probe_agent_connection(provider_id: str) -> dict[str, Any]:
    if provider_id not in runtime.RUNTIME_DEFINITIONS:
        raise ValueError("未知的本地 Agent")
    # Serialize user-triggered probes; polling only reads their cached result.
    async with _CHECK_LOCK:
        item = await runtime._probe(provider_id, refresh=True)
        check: dict[str, Any] = {
            "version": item.get("version"), "executable": item.get("executable_path"),
            "authenticated": None,
            "status": "check_required", "auth_mode": "unknown", "error": "",
            "integration_status": integration_manager.inspect(provider_id).get("skill_status")
            if _can_install_skill(provider_id) else "NOT_SUPPORTED",
        }
        if item.get("contract_compatible") and provider_id == "codex":
            from app.services.agent_bridge.codex_adapter import (
                CodexMainLoopAdapter,
                _resolve_codex_binary,
            )

            executable = item["executable_path"]
            # npm's Windows .cmd shim can emit an EPIPE when its Node wrapper
            # is terminated after a short read-only probe. Prefer the bundled
            # native binary when it is available; the public result stays
            # redacted and still reports the detected CLI version only.
            try:
                native_executable = _resolve_codex_binary()
                if Path(native_executable).suffix.lower() == ".exe":
                    executable = native_executable
            except FileNotFoundError:
                pass
            check["executable"] = executable
            adapter = CodexMainLoopAdapter(executable=executable)
            verify_integration = False
            try:
                async with asyncio.timeout(15):
                    await adapter.start()
                    account = await adapter.read_account()
                details = account.get("account")
                kind = details.get("type") if isinstance(details, dict) else None
                authenticated = kind in {"chatgpt", "apiKey"}
                if not authenticated and account.get("requiresOpenaiAuth") is False:
                    # A custom provider may not use OpenAI login; its remote
                    # authentication cannot be established by this local check.
                    check["error"] = "本机连接已响应；当前服务商的登录状态需要在实际任务中确认。"
                elif authenticated or details is None:
                    check.update(
                        authenticated=authenticated,
                        auth_mode=kind if authenticated else "unknown",
                        status="check_required" if authenticated else "auth_required",
                    )
                    verify_integration = authenticated
                else:
                    check["error"] = "当前 Agent 返回了尚未支持的登录类型，请在其原生界面确认。"
            except TimeoutError:
                check.update(status="failed", error="连接检查超时，请确认 Agent 可以正常启动后重试。")
            except Exception as exc:
                check.update(status="failed", error=redact_sensitive_text(str(exc), max_length=500))
            finally:
                await adapter.close()
            if verify_integration:
                integration = integration_manager.inspect(provider_id)
                if integration["skill_status"] == "INSTALLED":
                    verification = await integration_manager.probe(provider_id, executable)
                    check.update(
                        status="ready" if verification.get("connection_verified") else "failed",
                        integration_status=verification.get("integration_status") or "ERROR",
                        skill_hash=integration.get("expected_skill_hash"),
                        error=verification.get("error") or "",
                    )
                else:
                    check.update(
                        status="integration_missing" if integration["skill_status"] == "NOT_INSTALLED" else "outdated",
                        integration_status=integration["skill_status"],
                    )
        elif item.get("contract_compatible") and provider_id in {"opencode", "claude"}:
            integration = integration_manager.inspect(provider_id)
            if integration["skill_status"] == "INSTALLED":
                verification = await integration_manager.probe(
                    provider_id,
                    integration_manager.adapter(provider_id).detected_executable(
                        str(item.get("executable_path") or "")
                    ),
                )
                check.update(
                    status="ready" if verification.get("connection_verified") else "check_required",
                    integration_status=verification.get("integration_status") or "ERROR",
                    skill_hash=integration.get("expected_skill_hash"),
                    error=verification.get("error") or "",
                )
            else:
                check.update(
                    status="integration_missing" if integration["skill_status"] == "NOT_INSTALLED" else "outdated",
                    integration_status=integration["skill_status"],
                )
        check.update(at=time.monotonic(), checked_at=datetime.now(timezone.utc).isoformat())
        _CHECKS[provider_id] = check
    return await get_agent_connections()


async def connect_agent_integration(provider_id: str, action: str = "install") -> dict[str, Any]:
    if not _can_install_skill(provider_id):
        raise ValueError("当前 Agent 尚不支持自动安装 OfferU Skill")
    item = await runtime._probe(provider_id, refresh=True)
    executable = integration_manager.adapter(provider_id).detected_executable(
        str(item.get("executable_path") or "")
    )
    if not executable:
        raise ValueError("未检测到本机 Agent，请先安装后重试")
    await asyncio.to_thread(integration_manager.install, provider_id, action)
    return await probe_agent_connection(provider_id)
