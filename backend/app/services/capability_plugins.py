"""OfferU Capability Plugin registry.

Plugins are capability packages, not domain extensions.  A plugin may expose
a CLI and Skills, but its output is still an untrusted candidate consumed by
an OfferU Operation.  Installation state is a small local registry and
uninstall only disables discovery; it never deletes plugin files.
"""

from __future__ import annotations

import asyncio
import json
import os
import shlex
import sys
from pathlib import Path
from typing import Any

from app.services.agent_files import atomic_write_json
from app.services.security_redaction import safe_error_message


PLUGIN_MANIFEST = "offeru-plugin.json"
PLUGIN_SCHEMA = "offeru.capability_plugin.v1"
_REPO_ROOT = Path(__file__).resolve().parents[3]
PLUGIN_ROOT = _REPO_ROOT / "plugins"
PLUGIN_STATE_PATH = Path(__file__).resolve().parents[2] / "data" / "installed_plugins.json"


def _clean_name(value: str) -> str:
    clean = str(value or "").strip().lower()
    if not clean or any(not (char.isalnum() or char in "._-") for char in clean):
        raise ValueError("插件名称只能包含字母、数字、点、下划线和连字符")
    return clean


def _read_json(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ValueError(f"无法读取插件 Manifest: {path}") from exc
    if not isinstance(value, dict):
        raise ValueError("插件 Manifest 必须是 JSON object")
    return value


def _manifest_from_dir(plugin_dir: Path) -> dict[str, Any]:
    payload = _read_json(plugin_dir / PLUGIN_MANIFEST)
    name = _clean_name(str(payload.get("name") or plugin_dir.name))
    version = str(payload.get("version") or "").strip()
    description = str(payload.get("description") or "").strip()
    cli = payload.get("cli") if isinstance(payload.get("cli"), dict) else {}
    command = str(cli.get("command") or "").strip()
    args = cli.get("args") if isinstance(cli.get("args"), list) else []
    executable_payload = (
        payload.get("executable") if isinstance(payload.get("executable"), dict) else {}
    )
    executable_command = str(executable_payload.get("command") or command).strip()
    executable_args = (
        executable_payload.get("args")
        if isinstance(executable_payload.get("args"), list)
        else args
    )
    capabilities = payload.get("capabilities")
    if not version or not description or not command or not isinstance(capabilities, list):
        raise ValueError(f"插件 {name} Manifest 缺少 version/description/cli/capabilities")
    normalized_capabilities: list[dict[str, Any]] = []
    for item in capabilities:
        if isinstance(item, str):
            capability = item.strip()
            item = {"name": capability}
        elif isinstance(item, dict):
            item = dict(item)
            capability = str(item.get("name") or item.get("capability") or "").strip()
        else:
            continue
        if not capability:
            raise ValueError(f"插件 {name} 存在空 capability")
        item["name"] = capability
        side_effects = item.get("side_effects")
        if isinstance(side_effects, str):
            side_effects = [side_effects]
        if not isinstance(side_effects, list):
            side_effects = ["read"]
        item["side_effects"] = [str(effect) for effect in side_effects if str(effect).strip()]
        item["input_contract"] = (
            item.get("input_contract")
            if isinstance(item.get("input_contract"), dict)
            else {"type": "object"}
        )
        item["output_contract"] = (
            item.get("output_contract") if isinstance(item.get("output_contract"), dict) else {}
        )
        normalized_capabilities.append(item)
    if not normalized_capabilities:
        raise ValueError(f"插件 {name} 至少需要声明一个 capability")
    skill_entry = str(
        payload.get("skill_entry") or payload.get("skills") or "skills"
    ).strip()
    executable = {
        "command": executable_command,
        "args": [str(arg) for arg in executable_args],
    }
    health_check = payload.get("health_check")
    if not isinstance(health_check, dict):
        health_check = {
            "capability": normalized_capabilities[0]["name"],
            "arguments": {},
        }
    return {
        "schema": str(payload.get("schema") or PLUGIN_SCHEMA),
        "name": name,
        "version": version[:80],
        "description": description[:1000],
        "root": str(plugin_dir.resolve()),
        "cli": {
            "command": command,
            "args": [str(arg) for arg in args],
        },
        "executable": executable,
        "skill_entry": skill_entry,
        "skills": skill_entry,
        "health_check": health_check,
        "capabilities": normalized_capabilities,
        "permissions": payload.get("permissions") if isinstance(payload.get("permissions"), dict) else {},
    }


def _state_path(path: Path | None = None) -> Path:
    if path is not None:
        return path
    configured = os.environ.get("OFFERU_PLUGIN_STATE_PATH", "").strip()
    return Path(configured).expanduser() if configured else PLUGIN_STATE_PATH


def _installed_names(path: Path | None = None) -> set[str]:
    state_file = _state_path(path)
    if not state_file.is_file():
        return set()
    try:
        payload = json.loads(state_file.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return set()
    values = payload.get("installed") if isinstance(payload, dict) else payload
    return {_clean_name(str(value)) for value in values or [] if isinstance(value, str)}


def _write_installed(names: set[str], path: Path | None = None) -> None:
    atomic_write_json(
        _state_path(path),
        {"schema": "offeru.installed_plugins.v1", "installed": sorted(names)},
    )


def discover_plugins(*, root: Path | None = None, state_path: Path | None = None) -> dict[str, Any]:
    plugin_root = (root or PLUGIN_ROOT).resolve()
    installed = _installed_names(state_path)
    rows: list[dict[str, Any]] = []
    if plugin_root.is_dir():
        for plugin_dir in sorted(plugin_root.iterdir()):
            if not plugin_dir.is_dir() or not (plugin_dir / PLUGIN_MANIFEST).is_file():
                continue
            try:
                manifest = _manifest_from_dir(plugin_dir)
            except ValueError as exc:
                rows.append({"name": plugin_dir.name, "status": "invalid", "error": safe_error_message(exc)})
                continue
            rows.append(
                {
                    **manifest,
                    "installed": manifest["name"] in installed,
                    "status": "installed" if manifest["name"] in installed else "available",
                }
            )
    return {"plugins": rows, "installed": sorted(installed)}


def _plugin_manifest(name: str, *, root: Path | None = None, state_path: Path | None = None) -> dict[str, Any]:
    clean = _clean_name(name)
    plugin_root = (root or PLUGIN_ROOT).resolve()
    plugin_dir = (plugin_root / clean).resolve()
    try:
        plugin_dir.relative_to(plugin_root)
    except ValueError as exc:
        raise ValueError("插件路径超出插件目录") from exc
    manifest = _manifest_from_dir(plugin_dir)
    if manifest["name"] != clean:
        raise ValueError("插件目录名与 Manifest name 不一致")
    if clean not in _installed_names(state_path):
        raise ValueError(f"插件 {clean} 尚未安装")
    return manifest


def install_plugin(name: str, *, root: Path | None = None, state_path: Path | None = None) -> dict[str, Any]:
    clean = _clean_name(name)
    plugin_root = (root or PLUGIN_ROOT).resolve()
    manifest = _manifest_from_dir(plugin_root / clean)
    if manifest["name"] != clean:
        raise ValueError("插件目录名与 Manifest name 不一致")
    installed = _installed_names(state_path)
    already = clean in installed
    installed.add(clean)
    _write_installed(installed, state_path)
    return {"installed": True, "reused": already, "plugin": manifest}


def uninstall_plugin(name: str, *, state_path: Path | None = None) -> dict[str, Any]:
    clean = _clean_name(name)
    installed = _installed_names(state_path)
    existed = clean in installed
    installed.discard(clean)
    _write_installed(installed, state_path)
    return {"uninstalled": True, "reused": not existed, "name": clean, "files_deleted": False}


def list_plugin_capabilities(*, root: Path | None = None, state_path: Path | None = None) -> dict[str, Any]:
    discovered = discover_plugins(root=root, state_path=state_path)
    capabilities = []
    for plugin in discovered["plugins"]:
        if not plugin.get("installed"):
            continue
        for capability in plugin.get("capabilities") or []:
            capabilities.append(
                {
                    "plugin": plugin["name"],
                    "plugin_version": plugin["version"],
                    **capability,
                }
            )
    return {"capabilities": capabilities}


def _safe_env() -> dict[str, str]:
    env = dict(os.environ)
    for key in list(env):
        upper = key.upper()
        if any(marker in upper for marker in ("API_KEY", "TOKEN", "SECRET", "PASSWORD", "CREDENTIAL")):
            env.pop(key, None)
    env["OFFERU_PLUGIN_MODE"] = "1"
    env["NO_COLOR"] = "1"
    return env


def _command_parts(manifest: dict[str, Any]) -> list[str]:
    executable = manifest.get("executable") or manifest["cli"]
    command = shlex.split(str(executable["command"]), posix=False)
    if not command:
        raise ValueError("插件 CLI command 为空")
    executable_name = command[0].strip('"')
    if executable_name.casefold() in {"python", "python.exe", "py", "py.exe"}:
        command[0] = sys.executable
    elif not os.path.isabs(executable_name) and (
        "/" in executable_name
        or "\\" in executable_name
        or executable_name.endswith(".py")
    ):
        path = (Path(manifest["root"]) / executable_name).resolve()
        root = Path(manifest["root"]).resolve()
        try:
            path.relative_to(root)
        except ValueError as exc:
            raise ValueError("插件 CLI 路径超出插件目录") from exc
        command[0] = str(path)
    return [*command, *[str(arg) for arg in executable.get("args") or []]]


async def invoke_plugin_capability(
    plugin: str,
    capability: str,
    arguments: dict[str, Any] | None = None,
    timeout_seconds: int = 60,
    *,
    root: Path | None = None,
    state_path: Path | None = None,
) -> dict[str, Any]:
    manifest = _plugin_manifest(plugin, root=root, state_path=state_path)
    clean_capability = str(capability or "").strip()
    declared = next(
        (item for item in manifest["capabilities"] if item.get("name") == clean_capability),
        None,
    )
    if declared is None:
        raise ValueError(f"插件 {plugin} 未声明 capability {clean_capability}")
    effects = set(str(effect) for effect in declared.get("side_effects") or [])
    if effects.intersection({"external_write", "irreversible"}):
        raise ValueError("当前 Capability Gateway 只允许读取型插件 capability")
    command = _command_parts(manifest)
    command.extend([clean_capability, "--json"])
    try:
        process = await asyncio.create_subprocess_exec(
            *command,
            cwd=manifest["root"],
            env=_safe_env(),
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await asyncio.wait_for(
            process.communicate(
                (json.dumps(arguments or {}, ensure_ascii=False) + "\n").encode("utf-8")
            ),
            timeout=max(1, min(int(timeout_seconds), 300)),
        )
    except asyncio.TimeoutError as exc:
        if "process" in locals():
            process.kill()
        raise RuntimeError(f"插件 {plugin} capability {clean_capability} 超时") from exc
    output_text = stdout.decode("utf-8", errors="replace").strip()
    diagnostics = stderr.decode("utf-8", errors="replace")[-2000:]
    if process.returncode != 0:
        raise RuntimeError(
            f"插件 {plugin} capability {clean_capability} 退出码 {process.returncode}: {diagnostics}"
        )
    try:
        value = json.loads(output_text)
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"插件 {plugin} CLI 未返回合法 JSON") from exc
    if not isinstance(value, dict):
        raise RuntimeError(f"插件 {plugin} CLI 必须返回 JSON object")
    contract = declared.get("output_contract") if isinstance(declared.get("output_contract"), dict) else {}
    required = contract.get("required") if isinstance(contract.get("required"), list) else []
    missing = [str(key) for key in required if str(key) not in value]
    if missing:
        raise RuntimeError(
            f"插件 {plugin} capability {clean_capability} 输出缺少字段: {', '.join(missing)}"
        )
    return {
        "plugin": manifest["name"],
        "plugin_version": manifest["version"],
        "capability": clean_capability,
        "side_effects": sorted(effects),
        "output": value,
        "stderr": diagnostics,
    }


def plugin_skill_catalog(*, root: Path | None = None, state_path: Path | None = None) -> list[Any]:
    """Load installed plugin SKILL.md files as discovery-only AgentSkills."""

    from app.services.agent_skill_registry import AgentSkill

    discovered = discover_plugins(root=root, state_path=state_path)
    skills: list[AgentSkill] = []
    for plugin in discovered["plugins"]:
        if not plugin.get("installed"):
            continue
        skill_root = (Path(plugin["root"]) / str(plugin.get("skills") or "skills")).resolve()
        try:
            skill_root.relative_to(Path(plugin["root"]).resolve())
        except ValueError:
            continue
        if not skill_root.is_dir():
            continue
        for skill_file in sorted(skill_root.glob("*/SKILL.md")):
            text = skill_file.read_text(encoding="utf-8")
            if not text.startswith("---") or "\n---" not in text[3:]:
                continue
            end = text.find("\n---", 3)
            try:
                import yaml

                meta = yaml.safe_load(text[3:end]) or {}
            except Exception:
                continue
            if not isinstance(meta, dict) or not str(meta.get("description") or "").strip():
                continue
            skill_id = f"plugin_{plugin['name']}_{skill_file.parent.name}".replace("-", "_")
            skills.append(
                AgentSkill(
                    id=skill_id,
                    name=str(meta.get("display_name") or skill_file.parent.name),
                    group="plugin",
                    status="plugin",
                    description=(
                        f"[{plugin['name']}] {str(meta.get('description') or '').strip()}"
                    ),
                    mode="skill_assistant",
                    allowed_tools=frozenset({"invoke_plugin_capability"}),
                    featured=False,
                    order=700,
                    version=f"{plugin['version']}:{skill_file.parent.name}",
                    aliases=(),
                )
            )
    return skills


__all__ = [
    "PLUGIN_ROOT",
    "PLUGIN_STATE_PATH",
    "discover_plugins",
    "install_plugin",
    "invoke_plugin_capability",
    "list_plugin_capabilities",
    "plugin_skill_catalog",
    "uninstall_plugin",
]
