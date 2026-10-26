"""`offeru` command: run OfferU locally and open the workbench in the browser."""

from __future__ import annotations

import argparse
import os
from pathlib import Path
import secrets
import sys
import threading
import time
import urllib.request
import warnings
import webbrowser

# Third-party regex literals (jieba) warn on every start; not actionable for users.
warnings.filterwarnings("ignore", category=SyntaxWarning)

PORT = 8766
BASE_URL = f"http://127.0.0.1:{PORT}"


def default_data_dir() -> Path:
    if os.name == "nt":
        return Path(os.environ.get("LOCALAPPDATA") or Path.home()) / "OfferU"
    return Path.home() / ".offeru"


def configure(data_dir: Path | None) -> Path:
    configured = data_dir or Path(os.environ.get("OFFERU_DATA_DIR") or default_data_dir())
    resolved = configured.expanduser().resolve()
    resolved.mkdir(parents=True, exist_ok=True)
    os.environ["OFFERU_DATA_DIR"] = str(resolved)
    inherited = str(os.environ.get("DATABASE_URL") or "").strip()
    if inherited:
        from app.runtime_paths import database_location_problem

        problem = database_location_problem(inherited, resolved)
        if problem and os.environ.get("OFFERU_ALLOW_EXTERNAL_DATABASE") != "1":
            raise SystemExit(
                f"OfferU 拒绝启动：{problem}。\n"
                "会话和配置写入数据目录，而 Agent 运行记录、操作审计会写到另一个库，看起来像数据丢失。\n"
                "请取消 DATABASE_URL（常见来源：仓库根目录的旧 .env），"
                "或确需外部数据库时设置 OFFERU_ALLOW_EXTERNAL_DATABASE=1。"
            )
        if problem:
            print(f"警告：{problem}（已按 OFFERU_ALLOW_EXTERNAL_DATABASE=1 继续）", file=sys.stderr, flush=True)
    else:
        os.environ["DATABASE_URL"] = f"sqlite+aiosqlite:///{(resolved / 'djm.db').as_posix()}"
    os.environ["OFFERU_RUNTIME_MODE"] = "lite"
    os.environ["OFFERU_PORT"] = str(PORT)
    os.environ.setdefault("OFFERU_FRONTEND_HEALTH_URL", f"{BASE_URL}/")
    return resolved


def _running() -> bool:
    try:
        with urllib.request.urlopen(f"{BASE_URL}/api/health", timeout=1) as response:
            return response.status == 200
    except OSError:
        return False


def _open_when_ready(url: str) -> None:
    for _ in range(120):
        if _running():
            webbrowser.open(url)
            return
        time.sleep(0.5)


def start(*, open_browser: bool) -> int:
    if _running():
        print(f"OfferU 已在运行：{BASE_URL}")
        if open_browser:
            webbrowser.open(f"{BASE_URL}/")
        return 0

    os.environ["OFFERU_APPROVAL_TOKEN"] = secrets.token_urlsafe(32)
    import uvicorn
    from app.main import app
    from app.services.ui_approval_capability import issue_pairing_code

    url = f"{BASE_URL}/#/pair/{issue_pairing_code()}"
    if open_browser:
        threading.Thread(target=_open_when_ready, args=(url,), daemon=True).start()
    print(f"OfferU 正在启动（按 Ctrl+C 退出）。工作台：{url}", flush=True)
    print("这个链接 5 分钟内有效、只能打开一次；之后直接访问 http://127.0.0.1:8766 即可。", flush=True)
    uvicorn.run(app, host="127.0.0.1", port=PORT, reload=False, access_log=False, log_level="warning")
    return 0


def _register_mcp() -> None:
    """Let Codex / Claude Code see OfferU's tools directly: `offeru mcp` over stdio."""
    import shutil
    import subprocess

    command = [shutil.which("offeru") or sys.executable, *([] if shutil.which("offeru") else ["-m", "app.entry"]), "mcp"]
    for agent, add in (("codex", ["codex", "mcp", "add", "offeru", "--"]), ("claude", ["claude", "mcp", "add", "--scope", "user", "offeru", "--"])):
        if not shutil.which(agent):
            continue
        done = subprocess.run([*add, *command], capture_output=True, text=True, timeout=30)
        print(f"{agent} MCP: {'已接入' if done.returncode == 0 else (done.stderr or done.stdout).strip()[:200]}")


def connect() -> int:
    from app.services.agent_integration import integration_manager

    installed = 0
    for provider_id, adapter in integration_manager.adapters.items():
        if provider_id == "external":
            continue
        if not adapter.detected_executable():
            continue
        result = adapter.install()
        status = result.get("skill_status")
        print(f"{adapter.name}: {'已接入' if status == 'INSTALLED' else result.get('error') or status} → {adapter.skill_path()}")
        installed += status == "INSTALLED"
    # Any agent reading the shared ~/.agents/skills (Codex, DSH, ...) also picks this up.
    result = integration_manager.adapter("external").install()
    print(f"通用 Skill 目录: {'已接入' if result.get('skill_status') == 'INSTALLED' else result.get('error')} → {integration_manager.adapter('external').skill_path()}")
    _register_mcp()
    if not installed and result.get("skill_status") != "INSTALLED":
        return 1
    print("重开一个 Agent 会话后就能用 OfferU。")
    return 0


def tool(name: str | None, raw: str) -> int:
    import json

    from app.core.tools import TOOLS, call

    if not name:
        for item in TOOLS.values():
            print(f"{item.name}: {item.description}")
        return 0
    try:
        result = call(name, json.loads(raw or "{}"), actor=os.environ.get("OFFERU_ACTOR") or "agent")
    except Exception as exc:  # noqa: BLE001 - shown to the agent as-is
        print(json.dumps({"error": str(exc)}, ensure_ascii=False))
        return 1
    print(json.dumps(result, ensure_ascii=False, default=str))
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="offeru", description="OfferU 本地求职工作台")
    parser.add_argument("--data-dir", type=Path, help="数据目录，默认 ~/.offeru（Windows 为 %%LOCALAPPDATA%%\\OfferU）")
    sub = parser.add_subparsers(dest="command")
    start_parser = sub.add_parser("start", help="启动 OfferU 并在浏览器打开工作台")
    start_parser.add_argument("--no-browser", action="store_true", help="只启动，不打开浏览器")
    sub.add_parser("connect", help="把 OfferU Skill 装进本机的 Agent（Codex、Claude Code、DSH 等）")
    tool_parser = sub.add_parser("tool", help="调用一个 OfferU 工具：offeru tool overview / offeru tool save '{\"type\":\"job\",...}'")
    tool_parser.add_argument("name", nargs="?")
    tool_parser.add_argument("args", nargs="?", default="{}", help="JSON 参数")
    sub.add_parser("mcp", help="以 MCP（stdio）方式提供 OfferU 工具，给 Codex / Claude Code 用")
    cli_parser = sub.add_parser("cli", help="Agent 用的操作命令", add_help=False)
    cli_parser.add_argument("cli_args", nargs=argparse.REMAINDER)
    args = parser.parse_args(argv)

    configure(args.data_dir)
    if args.command == "tool":
        return tool(args.name, args.args)
    if args.command == "mcp":
        from app.mcp_server import mcp

        mcp.run("stdio")
        return 0
    if args.command == "cli":
        from app.cli import main as cli_main

        return cli_main(args.cli_args)
    if args.command == "connect":
        return connect()
    if args.command == "start":
        return start(open_browser=not args.no_browser)
    parser.print_help()
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
