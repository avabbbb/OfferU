from __future__ import annotations

import argparse
import asyncio
import json
from pathlib import Path
import sys
from typing import Any, Optional, Union

from app.config import get_settings
from app.database import init_db
from app.ops import get_operation_schema, list_operations
from app.bridge_cli import main as bridge_main
from app.services.agent_skill_registry import registry_snapshot
from app.services.operation_projection import (
    confirm_operation_proposal,
    execute_or_propose_operation,
)
from app.services.resume_parser import get_resume_ocr_capabilities


APP_VERSION = "0.4.0"


class CliParseError(Exception):
    def __init__(self, message: str):
        super().__init__(message)
        self.message = message


class JsonArgumentParser(argparse.ArgumentParser):
    def error(self, message: str) -> None:
        raise CliParseError(message)

    def exit(self, status: int = 0, message: Optional[str] = None) -> None:
        if status:
            raise CliParseError(message.strip() if message else f"parser exited with status {status}")
        raise SystemExit(status)


def main(argv: Optional[list[str]] = None) -> int:
    parser = _build_parser()
    try:
        args = parser.parse_args(argv)
    except CliParseError as exc:
        return _print({"ok": False, "errors": [exc.message], "commands": _commands()}, exit_code=2)
    # BYOK: CLI 与服务器共用同一份 config.json LLM 配置，避免 CLI 只读 .env
    # 导致与 GUI 解析不一致（统一 Operation Registry 原则）。文件不存在时静默跳过。
    try:
        from app.llm_config_store import sync_runtime_settings_from_file

        sync_runtime_settings_from_file()
    except Exception:
        # 配置同步失败不应阻塞只读操作；具体错误由 LLM 调用时可见地暴露。
        pass
    try:
        if args.command == "bridge":
            return bridge_main(args.bridge_args)
        if args.command == "doctor":
            return _print(_doctor(), args.pretty)
        if args.command == "manifest":
            return _print(_manifest(), args.pretty)
        if args.command == "ops":
            return _print({"ok": True, "operations": list_operations()}, args.pretty)
        if args.command == "schema":
            schema = get_operation_schema(args.name)
            if not schema:
                return _print({"ok": False, "errors": [f"未知操作: {args.name}"]}, args.pretty, exit_code=1)
            return _print({"ok": True, "schema": schema}, args.pretty)
        if args.command == "run":
            op_args = _parse_args_json(args.args_json)
            if isinstance(op_args, str):
                return _print({"ok": False, "errors": [op_args]}, args.pretty, exit_code=1)
            file_args = _parse_input_file(args.input_file)
            if isinstance(file_args, str):
                return _print({"ok": False, "errors": [file_args]}, args.pretty, exit_code=1)
            pair_args = _parse_arg_pairs(args.arg_pairs)
            if isinstance(pair_args, str):
                return _print({"ok": False, "errors": [pair_args]}, args.pretty, exit_code=1)
            op_args.update(file_args)
            op_args.update(pair_args)
            result = asyncio.run(_run_operation(args.name, op_args, dry_run=args.dry_run))
            return _print(result, args.pretty, exit_code=0 if result.get("ok") else 1)
        if args.command == "confirm":
            result = asyncio.run(
                _confirm_operation(
                    args.run_id,
                    action_id=args.action_id,
                )
            )
            return _print(result, args.pretty, exit_code=0 if result.get("ok") else 1)
        return _print({"ok": False, "errors": ["缺少命令"], "commands": _commands()}, exit_code=2)
    except KeyboardInterrupt:
        return _print({"ok": False, "errors": ["interrupted"]}, getattr(args, "pretty", False), exit_code=130)


def _build_parser() -> JsonArgumentParser:
    parser = JsonArgumentParser(
        prog="offeru",
        description="OfferU agent-native CLI. Every command prints machine-readable JSON.",
        add_help=False,
    )
    sub = parser.add_subparsers(dest="command", parser_class=JsonArgumentParser)

    bridge = sub.add_parser(
        "bridge",
        help="Agent Bridge machine surface (probe/schema).",
        add_help=False,
    )
    bridge.add_argument("bridge_args", nargs=argparse.REMAINDER, help="Arguments passed to the bridge surface.")

    doctor = sub.add_parser("doctor", help="Check runtime configuration and CLI health.", add_help=False)
    doctor.add_argument("--pretty", action="store_true", help="Pretty-print JSON.")

    manifest = sub.add_parser("manifest", help="Print the agent control contract for Claude Code and other CLIs.", add_help=False)
    manifest.add_argument("--pretty", action="store_true", help="Pretty-print JSON.")

    ops = sub.add_parser("ops", help="List all atomic internal operations.", add_help=False)
    ops.add_argument("--pretty", action="store_true", help="Pretty-print JSON.")

    schema = sub.add_parser("schema", help="Show one operation schema.", add_help=False)
    schema.add_argument("name", help="Operation name, for example list_jobs.")
    schema.add_argument("--pretty", action="store_true", help="Pretty-print JSON.")

    run = sub.add_parser("run", help="Run one atomic operation.", add_help=False)
    run.add_argument("name", help="Operation name, for example list_jobs.")
    run.add_argument("--args", dest="args_json", default="{}", help="JSON object passed as operation args.")
    run.add_argument("--input", dest="input_file", default="", help="Path to a JSON object file passed as operation args.")
    run.add_argument("--arg", dest="arg_pairs", action="append", default=[], help="Single key=value arg. May be repeated.")
    run.add_argument("--dry-run", action="store_true", help="Skip mutation, LLM, or external side-effect operations.")
    run.add_argument("--pretty", action="store_true", help="Pretty-print JSON.")

    confirm = sub.add_parser(
        "confirm",
        help="Confirm one persisted Operation proposal.",
        add_help=False,
    )
    confirm.add_argument("run_id", help="Persisted Agent Run ID returned by run.")
    confirm.add_argument(
        "--action",
        dest="action_id",
        default="",
        help="Action ID. Defaults to the first pending action.",
    )
    confirm.add_argument("--pretty", action="store_true", help="Pretty-print JSON.")
    return parser


def _commands() -> list[str]:
    return ["doctor", "manifest", "ops", "schema", "run", "confirm", "bridge"]


def _doctor() -> dict[str, Any]:
    settings = get_settings()
    provider_health = _doctor_provider_health()
    return {
        "ok": True,
        "service": "OfferU CLI",
        "version": APP_VERSION,
        "commands": _commands(),
        "operation_count": len(list_operations()),
        "database_url_configured": bool(settings.database_url),
        "backend": {
            "status": "ready",
            "runtime": "python",
            "health_url": "http://127.0.0.1:8765/api/health",
        },
        "frontend": {
            "status": "not_probed",
            "url": "http://127.0.0.1:7410",
            "note": "打开该地址完成浏览器检查",
        },
        "agent_providers": provider_health,
        "optional_integrations": {
            "codex_oauth": "optional",
            "gmail_oauth": "optional",
            "deepseek_harness": "experimental",
        },
        "llm_provider": settings.llm_provider,
        "llm_model": settings.llm_model,
        "resume_import": {
            "formats": ["pdf", "docx"],
            "max_file_size_mb": 10,
            "ocr": get_resume_ocr_capabilities(),
        },
        "safety": {
            "json_output": True,
            "dry_run_for_mutations": True,
            "auto_submit_applications": False,
        },
    }


def _doctor_provider_health() -> list[dict[str, Any]]:
    """Read safe persisted Provider health without making Doctor depend on DB setup."""
    from app.services.agent_provider_health import KNOWN_PROVIDER_IDS, list_provider_health

    try:
        payload = asyncio.run(list_provider_health())
        providers = payload.get("providers") if isinstance(payload, dict) else None
        if isinstance(providers, list):
            return providers
    except Exception:
        pass
    return [
        {
            "provider_id": provider_id,
            "available": False,
            "authenticated": None,
            "blocked": False,
            "status": "unavailable",
            "version": "",
            "auth_mode": "unknown",
            "protocol_version": "",
            "capabilities": {},
            "last_error": "database unavailable",
            "checked_at": None,
        }
        for provider_id in KNOWN_PROVIDER_IDS
    ]


def _manifest() -> dict[str, Any]:
    operations = list_operations()
    skills = registry_snapshot(operations)
    return {
        "ok": True,
        "service": "OfferU CLI",
        "version": APP_VERSION,
        "purpose": "Agent-native control surface for OfferU. External agents discover schemas and run reads; side-effect runs persist a proposal that requires a separate explicit confirm command.",
        "commands": {
            "health": "python -m app.cli doctor --pretty",
            "manifest": "python -m app.cli manifest --pretty",
            "list_operations": "python -m app.cli ops --pretty",
            "inspect_operation": "python -m app.cli schema <operation> --pretty",
            "agent_playbook": "python -m app.cli run agent_playbook --arg detail=full --pretty",
            "workflow_catalog": "python -m app.cli run workflow_catalog --pretty",
            "workflow_plan": "python -m app.cli run workflow_plan --arg goal=\"批量筛选岗位\" --pretty",
            "run_operation": "python -m app.cli run <operation> --arg key=value --pretty",
            "dry_run_mutation": "python -m app.cli run <operation> --arg key=value --dry-run --pretty",
            "confirm_proposal": "python -m app.cli confirm <run_id> --action <action_id> --pretty",
            "file_input": "python -m app.cli run <operation> --input args.json --pretty",
        },
        "io_contract": {
            "stdout": "single JSON object",
            "stderr": "reserved for Python/runtime diagnostics only",
            "exit_codes": {"0": "success", "1": "operation or input error", "2": "CLI syntax error", "130": "interrupted"},
            "argument_precedence": ["--args", "--input", "--arg"],
        },
        "safety": {
            "auto_submit_applications": False,
            "machine_mode_interactive_prompts": False,
            "side_effect_operations_create_persisted_proposal": True,
            "explicit_confirm_command_required": True,
            "raw_api_capability": False,
            "side_effect_labels": sorted({effect for op in operations for effect in op.get("side_effects", [])}),
        },
        "operation_count": len(operations),
        "operations": operations,
        "skill_registry": skills,
    }


async def _run_operation(name: str, args: dict[str, Any], *, dry_run: bool) -> dict[str, Any]:
    await init_db()
    return await execute_or_propose_operation(
        name,
        args,
        dry_run=dry_run,
        surface="cli",
    )


async def _confirm_operation(run_id: str, *, action_id: str = "") -> dict[str, Any]:
    await init_db()
    return await confirm_operation_proposal(
        run_id,
        action_id=action_id,
        surface="cli",
    )


def _parse_args_json(raw: str) -> Union[dict[str, Any], str]:
    try:
        value = json.loads(raw)
    except json.JSONDecodeError as exc:
        return f"--args 必须是合法 JSON 对象: {exc}"
    if not isinstance(value, dict):
        return "--args 必须是 JSON object"
    return value


def _parse_input_file(path: str) -> Union[dict[str, Any], str]:
    if not path:
        return {}
    input_path = Path(path)
    try:
        raw = input_path.read_text(encoding="utf-8-sig")
    except OSError as exc:
        return f"--input 无法读取文件: {exc}"
    try:
        value = json.loads(raw)
    except json.JSONDecodeError as exc:
        return f"--input 必须是合法 JSON 对象文件: {exc}"
    if not isinstance(value, dict):
        return "--input 必须是 JSON object 文件"
    return value


def _parse_arg_pairs(pairs: list[str]) -> Union[dict[str, Any], str]:
    out: dict[str, Any] = {}
    for pair in pairs:
        if "=" not in pair:
            return f"--arg 必须使用 key=value 格式: {pair}"
        key, raw_value = pair.split("=", 1)
        key = key.strip()
        if not key:
            return f"--arg key 不能为空: {pair}"
        out[key] = _parse_scalar(raw_value)
    return out


def _parse_scalar(raw: str) -> Any:
    value = raw.strip()
    if value.lower() == "true":
        return True
    if value.lower() == "false":
        return False
    if value.lower() in ("null", "none"):
        return None
    if value.startswith("[") or value.startswith("{"):
        try:
            return json.loads(value)
        except json.JSONDecodeError:
            return value
    try:
        return int(value)
    except ValueError:
        pass
    try:
        return float(value)
    except ValueError:
        return value


def _print(payload: dict[str, Any], pretty: bool = False, exit_code: int = 0) -> int:
    text = json.dumps(payload, ensure_ascii=True, indent=2 if pretty else None)
    sys.stdout.write(text + "\n")
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
