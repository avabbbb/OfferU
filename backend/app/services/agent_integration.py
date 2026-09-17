from __future__ import annotations

import hashlib
import json
import os
import re
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from uuid import uuid4

from app.runtime_paths import runtime_data_path
from app.services.agent_files import atomic_write_bytes, atomic_write_json
from app.services.security_redaction import redact_sensitive_text


_PROJECT_ROOT = Path(__file__).resolve().parents[3]
_BACKEND_ROOT = _PROJECT_ROOT / "backend"
_SOURCE_SKILL = _PROJECT_ROOT / ".agents" / "skills" / "offeru" / "SKILL.md"
_CHALLENGE_TTL_SECONDS = 300
_MARKER = re.compile(r"generated: offeru-skill-registry@([^\s]+) sha256=([a-f0-9]{64})")
_PROVIDER_IDS = ("codex", "opencode", "claude")


def _sha256(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def _command_prefix() -> str:
    executable = str(Path(sys.executable).resolve())
    return f"& '{executable}'" if os.name == "nt" else f"'{executable}'"


def _installed_content() -> str:
    source = _SOURCE_SKILL.read_text(encoding="utf-8")
    backend = str(_BACKEND_ROOT.resolve())
    source = source.replace(
        "Work from `backend/`.",
        f"Work from the OfferU backend at `{backend}`.",
        1,
    )
    return source.replace("python -m app.cli", f"{_command_prefix()} -m app.cli")


def _skill_metadata(content: str) -> tuple[str, str]:
    match = _MARKER.search(content)
    return (match.group(1), match.group(2)) if match else ("", "")


@dataclass(frozen=True)
class AgentIntegrationAdapter:
    provider_id: str
    name: str

    def skill_root(self) -> Path:
        home = Path.home()
        if self.provider_id == "codex":
            return Path(os.environ.get("CODEX_HOME") or home / ".codex") / "skills"
        if self.provider_id == "claude":
            return Path(os.environ.get("CLAUDE_CONFIG_DIR") or home / ".claude") / "skills"
        config_home = Path(os.environ.get("XDG_CONFIG_HOME") or home / ".config")
        return config_home / "opencode" / "skills"

    def skill_path(self) -> Path:
        return self.skill_root() / "offeru" / "SKILL.md"

    def detected_executable(self, fallback: str = "") -> str:
        if self.provider_id == "codex":
            return fallback
        from app.services.coding_agent_runtime import _resolve_executable

        binary = "claude" if self.provider_id == "claude" else "opencode"
        return _resolve_executable(binary) or ""

    def inspect(self) -> dict[str, Any]:
        expected = _installed_content()
        expected_bytes = expected.encode("utf-8")
        expected_version, registry_hash = _skill_metadata(expected)
        path = self.skill_path()
        result = {
            "skill_status": "NOT_INSTALLED",
            "skill_version": "",
            "skill_hash": "",
            "expected_skill_version": expected_version,
            "expected_skill_hash": _sha256(expected_bytes),
            "registry_hash": registry_hash,
            "can_install": True,
            "can_live_verify": self.provider_id == "codex",
            "error": "",
        }
        if not path.exists():
            return result
        if path.is_symlink():
            return {**result, "skill_status": "ERROR", "error": "OfferU Skill 不能使用符号链接，请执行修复。"}
        try:
            installed = path.read_text(encoding="utf-8")
        except OSError as exc:
            return {**result, "skill_status": "ERROR", "error": redact_sensitive_text(exc, max_length=300)}
        installed_version, _ = _skill_metadata(installed)
        installed_hash = _sha256(installed.encode("utf-8"))
        if "name: offeru" not in installed:
            state = "ERROR"
            error = "目标目录存在非 OfferU Skill；只有明确修复后才会覆盖。"
        elif installed == expected:
            state = "INSTALLED"
            error = ""
        else:
            state = "OUTDATED"
            error = ""
        return {
            **result,
            "skill_status": state,
            "skill_version": installed_version,
            "skill_hash": installed_hash,
            "error": error,
        }

    def install(self, action: str = "install") -> dict[str, Any]:
        if action not in {"install", "update", "repair"}:
            raise ValueError("integration action 仅支持 install、update 或 repair")
        path = self.skill_path()
        root = self.skill_root()
        current = self.inspect()
        if current["skill_status"] == "ERROR" and action != "repair":
            raise ValueError(current["error"])
        if path.is_symlink() or root.is_symlink():
            raise ValueError("OfferU Skill 目标目录不能使用符号链接")
        resolved_root = root.resolve()
        resolved_path = path.resolve()
        if os.path.commonpath([str(resolved_root), str(resolved_path)]) != str(resolved_root):
            raise ValueError("OfferU Skill 目标路径越过允许目录")
        atomic_write_bytes(path, _installed_content().encode("utf-8"))
        return self.inspect()

    def update(self) -> dict[str, Any]:
        return self.install("update")

    def repair(self) -> dict[str, Any]:
        return self.install("repair")


class CodexIntegration(AgentIntegrationAdapter):
    def __init__(self) -> None:
        super().__init__("codex", "Codex")


class OpenCodeIntegration(AgentIntegrationAdapter):
    def __init__(self) -> None:
        super().__init__("opencode", "OpenCode")


class ClaudeCodeIntegration(AgentIntegrationAdapter):
    def __init__(self) -> None:
        super().__init__("claude", "Claude Code")


class AgentIntegrationManager:
    def __init__(self) -> None:
        self.adapters = {
            adapter.provider_id: adapter
            for adapter in (CodexIntegration(), OpenCodeIntegration(), ClaudeCodeIntegration())
        }

    def adapter(self, provider_id: str) -> AgentIntegrationAdapter:
        clean = str(provider_id or "").strip().lower()
        if clean not in self.adapters:
            raise ValueError("当前 Agent 尚不支持自动安装 OfferU Skill")
        return self.adapters[clean]

    def inspect(self, provider_id: str) -> dict[str, Any]:
        return self.adapter(provider_id).inspect()

    def install(self, provider_id: str, action: str = "install") -> dict[str, Any]:
        return self.adapter(provider_id).install(action)

    async def probe(self, provider_id: str, executable: str) -> dict[str, Any]:
        if provider_id == "opencode":
            installed = self.inspect(provider_id)
            if installed["skill_status"] != "INSTALLED":
                return {
                    **installed,
                    "integration_status": installed["skill_status"],
                    "connection_verified": False,
                }
            from app.services.coding_agent_runtime import _capture

            try:
                workspace = runtime_data_path("agent_integration_probe_workspace")
                workspace.mkdir(parents=True, exist_ok=True)
                return_code, stdout, stderr = await _capture(
                    executable,
                    ["debug", "skill", "--pure"],
                    timeout=30,
                    runtime_id="opencode",
                    cwd=str(workspace),
                )
                skills = json.loads(stdout) if return_code == 0 else []
                skill_path = str(self.adapter(provider_id).skill_path().resolve())
                discovered = any(
                    str(item.get("name") or "") == "offeru"
                    and str(Path(str(item.get("location") or "")).resolve()) == skill_path
                    for item in skills
                    if isinstance(item, dict)
                )
                return {
                    **installed,
                    "integration_status": "DISCOVERED" if discovered else "ERROR",
                    "connection_verified": False,
                    "checked_at": _iso_now(),
                    "error": "" if discovered else redact_sensitive_text(stderr or "OpenCode 未发现 OfferU Skill。", max_length=500),
                }
            except (OSError, ValueError, TimeoutError) as exc:
                return {
                    **installed,
                    "integration_status": "ERROR",
                    "connection_verified": False,
                    "error": redact_sensitive_text(exc, max_length=500),
                }
        if provider_id != "codex":
            return {
                **self.inspect(provider_id),
                "integration_status": "INSTALLED",
                "connection_verified": False,
                "error": "该 Agent 已安装 Skill；真实 readback 验证尚未实现。",
            }
        installed = self.inspect(provider_id)
        if installed["skill_status"] != "INSTALLED":
            return {
                **installed,
                "integration_status": installed["skill_status"],
                "connection_verified": False,
            }
        challenge = create_connection_challenge(provider_id)
        from app.services.agent_bridge.codex_adapter import CodexMainLoopAdapter

        workspace = runtime_data_path("agent_integration_probe_workspace")
        workspace.mkdir(parents=True, exist_ok=True)
        adapter = CodexMainLoopAdapter(
            executable=executable,
            thread_params={
                "config": {
                    "features": {"plugins": False, "apps": False},
                    "skills": {"include_instructions": False},
                },
                "ephemeral": True,
            },
            turn_timeout=300,
            turn_effort="low",
        )
        try:
            await adapter.start()
            skills = await adapter.list_skills(cwd=str(workspace), force_reload=True)
            skill_path = str(self.adapter(provider_id).skill_path().resolve())
            discovered = any(
                str(item.get("name") or "") == "offeru"
                and str(Path(str(item.get("path") or "")).resolve()) == skill_path
                and item.get("enabled") is not False
                for item in skills
                if isinstance(item, dict)
            )
            if not discovered:
                return {
                    **installed,
                    "integration_status": "INSTALLED",
                    "connection_verified": False,
                    "error": "Codex 未在新会话中发现 OfferU Skill。",
                }
            mcp_names = {
                str(event.get("params", {}).get("name") or "")
                for event in adapter.events()
                if event.get("method") == "mcpServer/startupStatus/updated"
            }
            adapter.thread_params["config"]["mcp_servers"] = {
                name: {"enabled": False} for name in mcp_names if name
            }
            from app.ops import execute_operation

            async def execute_probe_operation(name: str, arguments: dict[str, Any]) -> dict[str, Any]:
                if name != "get_agent_connection_nonce":
                    raise ValueError("connection probe 只允许 nonce Operation")
                operation_result = await execute_operation(
                    name,
                    arguments,
                    surface="agent_integration_probe",
                    audit=False,
                )
                if not operation_result.get("ok"):
                    raise ValueError(
                        "；".join(operation_result.get("errors") or [])
                        or "nonce Operation 失败"
                    )
                outputs = operation_result.get("outputs")
                if not isinstance(outputs, dict):
                    raise ValueError("nonce Operation 返回无效")
                return outputs

            adapter.on_operation = execute_probe_operation
            await adapter.create_thread(
                cwd=str(workspace),
                tool_descriptions=[
                    "get_agent_connection_nonce(provider_id: string, challenge_id: 32-char lowercase hex) "
                    "— Read the one-time OfferU integration nonce. No career data and no mutation."
                ],
            )
            result = await adapter.start_turn(
                cwd=str(workspace),
                skill={"type": "skill", "name": "offeru", "path": skill_path},
                prompt=(
                    "Verify the installed OfferU integration. Use the OfferU Skill, select the "
                    "connection_probe Skill, then call the offered read-only nonce Operation for "
                    f"provider_id=codex and challenge_id={challenge['challenge_id']}. "
                    "Return only JSON with one nonce field. "
                    "Do not use shell, read repository source or challenge storage directly, or guess."
                ),
            )
            final_message = str(result.get("finalMessage") or "")
            event_text = json.dumps(adapter.events(), ensure_ascii=False)
            used_operation = "get_agent_connection_nonce" in event_text and any(
                marker in event_text
                for marker in ("item/tool/call", "dynamic_tool_call", "custom_tool_call")
            )
            verified = challenge["nonce"] in final_message and used_operation
            return {
                **installed,
                "integration_status": "VERIFIED" if verified else "ERROR",
                "connection_verified": verified,
                "checked_at": _iso_now(),
                "error": "" if verified else "Agent 未通过 OfferU Skill 的 nonce readback。",
            }
        except TimeoutError:
            return {**installed, "integration_status": "DISCOVERED", "connection_verified": False, "error": "Agent readback 超时。"}
        except Exception as exc:
            return {
                **installed,
                "integration_status": "ERROR",
                "connection_verified": False,
                "error": redact_sensitive_text(exc, max_length=500),
            }
        finally:
            await adapter.close()


def _iso_now() -> str:
    from datetime import datetime, timezone

    return datetime.now(timezone.utc).isoformat()


def _challenge_path() -> Path:
    return runtime_data_path("agent_integration_challenges.json")


def _load_challenges() -> dict[str, dict[str, Any]]:
    try:
        payload = json.loads(_challenge_path().read_text(encoding="utf-8"))
    except (OSError, ValueError, TypeError):
        return {}
    return payload if isinstance(payload, dict) else {}


def create_connection_challenge(provider_id: str) -> dict[str, str]:
    if provider_id not in _PROVIDER_IDS:
        raise ValueError("未知的 Agent integration provider")
    now = time.time()
    challenges = {
        key: value
        for key, value in _load_challenges().items()
        if isinstance(value, dict) and float(value.get("expires_at") or 0) > now
    }
    challenge_id = uuid4().hex
    nonce = uuid4().hex
    challenges[challenge_id] = {
        "provider_id": provider_id,
        "nonce": nonce,
        "expires_at": now + _CHALLENGE_TTL_SECONDS,
    }
    atomic_write_json(_challenge_path(), challenges)
    return {"challenge_id": challenge_id, "nonce": nonce}


def get_connection_nonce(provider_id: str, challenge_id: str) -> dict[str, str]:
    challenges = _load_challenges()
    clean_id = str(challenge_id or "").strip()
    challenge = challenges.get(clean_id)
    if not isinstance(challenge, dict) or challenge.get("provider_id") != provider_id:
        raise ValueError("OfferU connection challenge 不存在")
    if float(challenge.get("expires_at") or 0) <= time.time():
        raise ValueError("OfferU connection challenge 已过期")
    nonce = str(challenge.get("nonce") or "")
    challenges.pop(clean_id, None)
    atomic_write_json(_challenge_path(), challenges)
    return {"nonce": nonce}


integration_manager = AgentIntegrationManager()


__all__ = [
    "AgentIntegrationManager",
    "ClaudeCodeIntegration",
    "CodexIntegration",
    "OpenCodeIntegration",
    "create_connection_challenge",
    "get_connection_nonce",
    "integration_manager",
]
