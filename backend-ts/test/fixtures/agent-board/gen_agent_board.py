"""Python outputs of services/agent_board.py → agent-board.json.

Run from repo root while the Python backend still exists (needs filelock):
    python3 backend-ts/test/fixtures/agent-board/gen_agent_board.py
Uses a throwaway HOME / data dir, a PATH with fake `codex` and `workbuddy`, and a fixed process
listing, so rows are deterministic. Paths under HOME are written as "~"; timestamps are dropped.
"""
import json
import os
import shutil
import stat
import sys
import tempfile
import types
from pathlib import Path

here = Path(__file__).resolve().parent
root = here.parents[3]
home = Path(tempfile.mkdtemp())
data = Path(tempfile.mkdtemp())
bin_dir = Path(tempfile.mkdtemp())
for name in ("codex", "workbuddy"):
    exe = bin_dir / name
    exe.write_text("#!/bin/sh\n")
    exe.chmod(exe.stat().st_mode | stat.S_IEXEC)
os.environ.update({"HOME": str(home), "OFFERU_DATA_DIR": str(data), "PATH": str(bin_dir)})
for key in ("CODEX_HOME", "CLAUDE_CONFIG_DIR", "XDG_CONFIG_HOME", "PI_CODING_AGENT_DIR", "DSH_HOME"):
    os.environ.pop(key, None)
sys.path.insert(0, str(root / "backend"))
sys.modules["app.services.coding_agent_runtime"] = types.SimpleNamespace(_resolve_executable=shutil.which, _command=lambda e, a: (e, a))

from app.services import agent_board  # noqa: E402

PROCESSES = "/usr/bin/node /home/x/.npm/lib/node_modules/@google/gemini-cli/dist/index.js\ncodex --yolo\n/usr/bin/workbuddy.exe serve\n"
agent_board._process_listing = lambda: PROCESSES


def scrub(value):
    if isinstance(value, dict):
        return {k: scrub(v) for k, v in value.items() if k != "at"}
    if isinstance(value, list):
        return [scrub(v) for v in value]
    if isinstance(value, str):
        return value.replace(str(home), "~")
    return value


def attempt(fn, *args):
    try:
        return {"ok": scrub(fn(*args))}
    except ValueError as exc:
        return {"error": scrub(str(exc))}


out = {"processes": PROCESSES, "steps": []}
step = lambda name, result: out["steps"].append({"name": name, **result})  # noqa: E731
step("list_empty", attempt(agent_board.list_board))
step("add_bad_id", attempt(agent_board.add_custom_agent, {"id": "Bad Id", "display_name": "x", "skill_root": "~/.wb/skills"}))
step("add_builtin", attempt(agent_board.add_custom_agent, {"id": "codex", "display_name": "x", "skill_root": "~/.wb/skills"}))
step("add_no_name", attempt(agent_board.add_custom_agent, {"id": "wb", "display_name": " ", "skill_root": "~/.wb/skills"}))
step("add_bad_exe", attempt(agent_board.add_custom_agent, {"id": "wb", "display_name": "WorkBuddy", "executable": "/usr/bin/wb", "skill_root": "~/.wb/skills"}))
step("add_outside_home", attempt(agent_board.add_custom_agent, {"id": "wb", "display_name": "WorkBuddy", "skill_root": "/etc/skills"}))
step("add_relative", attempt(agent_board.add_custom_agent, {"id": "wb", "display_name": "WorkBuddy", "skill_root": "skills"}))
step("add", attempt(agent_board.add_custom_agent, {"id": "WB", "display_name": "WorkBuddy", "executable": "workbuddy", "skill_root": "~/.wb/skills"}))
step("add_dup", attempt(agent_board.add_custom_agent, {"id": "wb", "display_name": "WorkBuddy", "skill_root": "~/.wb/skills"}))
step("edit_builtin", attempt(agent_board.update_custom_agent, "codex", {"display_name": "x"}))
step("edit", attempt(agent_board.update_custom_agent, "wb", {"display_name": "WorkBuddy CLI"}))
step("connect_codex", attempt(agent_board.connect_agent, "codex", "install"))
step("connect_bad_action", attempt(agent_board.connect_agent, "codex", "nuke"))
step("connect_unknown", attempt(agent_board.connect_agent, "nobody", "install"))
step("hide_claude", attempt(agent_board.set_hidden, "claude", True))
step("check_wb", attempt(agent_board.check_agent, "wb"))
clients = ["codex", "Claude Code", "claude-code", "gemini-cli-mcp-client", "workbuddy", "opencode", "unknown-client", "codex-mcp-client", ""]
out["match_client"] = {c: agent_board._match_client(agent_board._load(), c.strip().lower()) for c in clients}
step("list_full", attempt(agent_board.list_board))
step("remove_builtin", attempt(agent_board.remove_custom_agent, "codex"))
step("remove", attempt(agent_board.remove_custom_agent, "wb"))
(here / "agent-board.json").write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
print("ok")
