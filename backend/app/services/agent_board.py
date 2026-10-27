"""Agent board: built-in Skill hosts plus user-added Agents, with connect, check and memory state.

The board only runs OfferU's own fixed actions: install, update or repair the OfferU
Skill, look for an Agent's executable on PATH, and export OfferU memory. It never
executes an Agent's own command and never edits an Agent's settings or memory files;
the Agent writes its memory itself and reports back with ``mark_memory_imported``.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
import shutil
import tempfile
import threading
from typing import Any

from app.runtime_paths import runtime_data_dir
from app.services.agent_host_registry import get_host, skill_host_ids
from app.services.agent_integration import AgentIntegrationAdapter, integration_manager

CONNECT_ACTIONS = ("install", "update", "repair")
_LOCK = threading.Lock()
_ID = re.compile(r"^[a-z0-9][a-z0-9_-]{0,39}$")
# A bare command name only: the board looks it up on PATH and never runs it.
_EXECUTABLE = re.compile(r"^[A-Za-z0-9_.-]{1,80}$")


@dataclass(frozen=True)
class CustomAgentAdapter(AgentIntegrationAdapter):
    """A user-added Agent: the OfferU Skill goes into the Skill folder the user named."""

    root: str = ""
    executable: str = ""

    def skill_root(self) -> Path:
        return Path(self.root)

    def detected_executable(self, fallback: str = "") -> str:
        if fallback:
            return fallback
        return (shutil.which(self.executable) or "") if self.executable else ""


def _store_path() -> Path:
    return runtime_data_dir() / "agent_board.json"


def _load() -> dict[str, Any]:
    try:
        raw = json.loads(_store_path().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        raw = {}
    if not isinstance(raw, dict):
        raw = {}
    return {
        "custom": [item for item in raw.get("custom") or [] if isinstance(item, dict) and item.get("id")],
        "hidden": [str(item) for item in raw.get("hidden") or []],
        "memory": {key: value for key, value in (raw.get("memory") or {}).items() if isinstance(value, dict)},
        "checks": {key: value for key, value in (raw.get("checks") or {}).items() if isinstance(value, dict)},
    }


def _save(data: dict[str, Any]) -> None:
    path = _store_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    handle, temporary = tempfile.mkstemp(dir=path.parent, prefix=".agent_board.", suffix=".tmp")
    with os.fdopen(handle, "w", encoding="utf-8") as stream:
        json.dump(data, stream, ensure_ascii=False, indent=2)
    os.replace(temporary, path)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _validate_custom(raw: dict[str, Any], *, creating: bool) -> dict[str, Any]:
    agent_id = str(raw.get("id") or "").strip().lower()
    if not _ID.match(agent_id):
        raise ValueError("Agent id 只能用小写字母、数字、- 和 _，最长 40 个字符")
    if creating and (get_host(agent_id) or agent_id in integration_manager.adapters):
        raise ValueError(f"{agent_id} 是内置 Agent，已经在看板里，不需要添加")
    name = str(raw.get("display_name") or "").strip()
    if not 1 <= len(name) <= 60:
        raise ValueError("请填写 Agent 名称（60 字以内）")
    executable = str(raw.get("executable") or "").strip()
    if executable and not _EXECUTABLE.match(executable):
        raise ValueError("启动命令只填命令名（例如 workbuddy），不要带路径或参数")
    root_text = str(raw.get("skill_root") or "").strip()
    root = Path(root_text).expanduser()
    if not root_text or not root.is_absolute() or not root.resolve().is_relative_to(Path.home().resolve()):
        raise ValueError("Skill 目录要填你用户目录下的绝对路径，例如 ~/.workbuddy/skills")
    memory_text = str(raw.get("memory_file") or "").strip()
    memory_file = Path(memory_text).expanduser() if memory_text else None
    if memory_file is not None and not memory_file.is_absolute():
        raise ValueError("记忆文件要填绝对路径，不知道可以留空")
    return {
        "id": agent_id,
        "display_name": name,
        "executable": executable,
        "skill_root": str(root),
        "memory_file": str(memory_file) if memory_file else "",
    }


def _custom(data: dict[str, Any], agent_id: str) -> dict[str, Any] | None:
    return next((item for item in data["custom"] if item["id"] == agent_id), None)


def _adapter(data: dict[str, Any], agent_id: str) -> AgentIntegrationAdapter:
    custom = _custom(data, agent_id)
    if custom:
        return CustomAgentAdapter(
            agent_id,
            custom["display_name"],
            root=custom["skill_root"],
            executable=custom.get("executable", ""),
        )
    if agent_id in skill_host_ids() and agent_id in integration_manager.adapters:
        return integration_manager.adapter(agent_id)
    raise ValueError(f"看板里没有这个 Agent：{agent_id}。先运行 offeru agent list 查看")


def _memory_state(record: dict[str, Any]) -> str:
    if record.get("imported_at"):
        return "imported"
    return "exported" if record.get("exported_at") else "none"


def _row(data: dict[str, Any], agent_id: str) -> dict[str, Any]:
    adapter = _adapter(data, agent_id)
    custom = _custom(data, agent_id)
    try:
        skill = adapter.inspect()
    except (OSError, ValueError) as exc:
        skill = {"skill_status": "ERROR", "error": str(exc)[:300]}
    memory = data["memory"].get(agent_id, {})
    host = get_host(agent_id)
    return {
        "id": agent_id,
        "display_name": custom["display_name"] if custom else (host.display_name if host else adapter.name),
        "custom": bool(custom),
        "hidden": agent_id in data["hidden"],
        "executable_found": bool(adapter.detected_executable()),
        "skill_status": skill.get("skill_status", "ERROR"),
        "skill_path": str(adapter.skill_path()),
        "error": skill.get("error", ""),
        "memory_status": _memory_state(memory),
        "memory": memory,
        "last_check": data["checks"].get(agent_id, {}),
        "executable": custom.get("executable", "") if custom else "",
        "memory_file": custom.get("memory_file", "") if custom else "",
        "docs_url": host.docs_url if host else "",
    }


def list_board() -> dict[str, Any]:
    data = _load()
    ids = [*skill_host_ids(), *(item["id"] for item in data["custom"])]
    rows = [_row(data, agent_id) for agent_id in ids]
    visible = [row for row in rows if not row["hidden"]]
    return {
        "agents": rows,
        "summary": {
            "connected": sum(row["skill_status"] == "INSTALLED" for row in visible),
            "needs_attention": sum(row["skill_status"] in {"OUTDATED", "ERROR"} for row in visible),
            "detected": sum(row["executable_found"] for row in visible),
        },
    }


def add_custom_agent(raw: dict[str, Any]) -> dict[str, Any]:
    with _LOCK:
        data = _load()
        entry = _validate_custom(raw, creating=True)
        if _custom(data, entry["id"]):
            raise ValueError(f"已经有一个叫 {entry['id']} 的 Agent，可以用编辑修改它")
        data["custom"].append(entry)
        _save(data)
        return _row(data, entry["id"])


def update_custom_agent(agent_id: str, raw: dict[str, Any]) -> dict[str, Any]:
    with _LOCK:
        data = _load()
        current = _custom(data, agent_id)
        if not current:
            raise ValueError("只有你自己添加的 Agent 可以编辑；内置 Agent 只能隐藏")
        entry = _validate_custom({**current, **raw, "id": agent_id}, creating=False)
        data["custom"] = [entry if item["id"] == agent_id else item for item in data["custom"]]
        _save(data)
        return _row(data, agent_id)


def remove_custom_agent(agent_id: str) -> dict[str, Any]:
    """Drop a user-added Agent from the board. Installed Skill files stay where they are."""

    with _LOCK:
        data = _load()
        if not _custom(data, agent_id):
            raise ValueError("只有你自己添加的 Agent 可以删除；内置 Agent 只能隐藏")
        data["custom"] = [item for item in data["custom"] if item["id"] != agent_id]
        data["hidden"] = [item for item in data["hidden"] if item != agent_id]
        data["memory"].pop(agent_id, None)
        data["checks"].pop(agent_id, None)
        _save(data)
        return {"removed": agent_id}


def set_hidden(agent_id: str, hidden: bool) -> dict[str, Any]:
    with _LOCK:
        data = _load()
        _adapter(data, agent_id)
        data["hidden"] = [item for item in data["hidden"] if item != agent_id] + ([agent_id] if hidden else [])
        _save(data)
        return _row(data, agent_id)


def connect_agent(agent_id: str, action: str = "install") -> dict[str, Any]:
    if action not in CONNECT_ACTIONS:
        raise ValueError("连接动作只支持 install、update 或 repair")
    with _LOCK:
        data = _load()
        result = _adapter(data, agent_id).install(action)
        data["checks"][agent_id] = {"at": _now(), "action": action, "skill_status": result.get("skill_status", "")}
        _save(data)
        return _row(data, agent_id)


def check_agent(agent_id: str) -> dict[str, Any]:
    with _LOCK:
        data = _load()
        row = _row(data, agent_id)
        data["checks"][agent_id] = {
            "at": _now(),
            "action": "check",
            "skill_status": row["skill_status"],
            "executable_found": row["executable_found"],
        }
        _save(data)
        return {**row, "last_check": data["checks"][agent_id]}


def export_memory_for_agent(agent_id: str) -> dict[str, Any]:
    from app.services.harness_memory import export_agent_memory_markdown, load_agent_memory

    with _LOCK:
        data = _load()
        row = _row(data, agent_id)
        content = export_agent_memory_markdown(load_agent_memory())
        data["memory"][agent_id] = {**data["memory"].get(agent_id, {}), "exported_at": _now()}
        _save(data)
    return {
        "agent_id": agent_id,
        "format": "markdown",
        "content": content,
        "memory_file": row["memory_file"],
        "next": (
            "把这份 OfferU 记忆摘要给使用者看，经同意后写进你自己的记忆，"
            f"然后运行 offeru agent memory-done {agent_id} --target <写入位置>。"
            "不要改动 OfferU 以外的设置。"
        ),
    }


def mark_memory_imported(agent_id: str, target: str = "") -> dict[str, Any]:
    with _LOCK:
        data = _load()
        _adapter(data, agent_id)
        data["memory"][agent_id] = {
            **data["memory"].get(agent_id, {}),
            "imported_at": _now(),
            "target": str(target or "")[:300],
        }
        _save(data)
        return _row(data, agent_id)
