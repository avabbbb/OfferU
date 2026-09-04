from __future__ import annotations

import argparse
import asyncio
import json
import os
from pathlib import Path
import sys
from typing import Any, Optional, Union
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener

from app.config import get_settings
from app.database import init_db
from app.ops import get_operation_schema, list_operations
from app.bridge_cli import main as bridge_main
from app.runtime_paths import runtime_data_dir, runtime_uploads_dir
from app.services.agent_skill_registry import registry_snapshot
from app.services.operation_projection import (
    confirm_operation_proposal,
    execute_or_propose_operation,
)
from app.services.resume_parser import get_resume_ocr_capabilities
from app.services.security_redaction import safe_error_message


APP_VERSION = "0.4.0"
FRONTEND_URL = "http://127.0.0.1:7410"
BACKEND_HEALTH_URL = "http://127.0.0.1:8765/api/health"


class _NoRedirectHandler(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


_LOCAL_LOOPBACK_OPENER = build_opener(ProxyHandler({}), _NoRedirectHandler())


class CliParseError(Exception):
    def __init__(self, message: str):
        super().__init__(message)
        self.message = message


def _open_local_url(request: Request, *, timeout: float):
    """Open fixed loopback probes without inheriting a system proxy."""

    return _LOCAL_LOOPBACK_OPENER.open(request, timeout=timeout)


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
            payload = _doctor()
            if args.require_ready:
                release_readiness = payload.get("release_readiness") or {}
                ready = release_readiness.get("status") == "CORE_READY"
                payload["ok"] = ready
                return _print(payload, args.pretty, exit_code=0 if ready else 1)
            return _print(payload, args.pretty)
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
    doctor.add_argument(
        "--require-ready",
        action="store_true",
        help="Return a non-zero exit code unless the local core reports CORE_READY.",
    )

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
    backend_health = _doctor_backend_health()
    provider_health = _doctor_provider_health()
    data_safety = _doctor_data_safety()
    frontend_health = _doctor_frontend_health()
    return {
        "ok": True,
        "service": "OfferU CLI",
        "version": APP_VERSION,
        "commands": _commands(),
        "operation_count": len(list_operations()),
        "database_url_configured": bool(settings.database_url),
        "backend": {**backend_health, "runtime": "python", "health_url": BACKEND_HEALTH_URL},
        "frontend": frontend_health,
        "agent_providers": provider_health,
        "data_safety": data_safety,
        "release_readiness": _doctor_release_readiness(
            settings=settings,
            backend_health=backend_health,
            provider_health=provider_health,
            data_safety=data_safety,
            frontend_health=frontend_health,
        ),
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


def _doctor_backend_health() -> dict[str, Any]:
    """Probe the fixed local API and never expose its response body."""

    request = Request(
        BACKEND_HEALTH_URL,
        headers={"User-Agent": "OfferU-Doctor/0.4"},
        method="GET",
    )
    try:
        with _open_local_url(request, timeout=2.0) as response:
            status_code = int(getattr(response, "status", 200))
            body = response.read(4097)
    except HTTPError as exc:
        return {
            "status": "failed",
            "url": BACKEND_HEALTH_URL,
            "http_status": int(exc.code),
            "error_kind": "http_error",
        }
    except (OSError, URLError, TimeoutError):
        return {
            "status": "unavailable",
            "url": BACKEND_HEALTH_URL,
            "error_kind": "backend_not_reachable",
        }

    try:
        payload = json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        payload = None
    if (
        status_code < 200
        or status_code >= 400
        or not isinstance(payload, dict)
        or payload.get("status") != "ok"
        or payload.get("service") != "OfferU"
        or payload.get("runtime") != "python"
        or payload.get("version") != APP_VERSION
        or payload.get("build_mode")
        != str(
            os.getenv("OFFERU_BUILD_MODE")
            or ("release" if os.getenv("OFFERU_RUNTIME_MODE") == "desktop-sidecar" else "local-development")
        ).strip()
    ):
        return {
            "status": "failed",
            "url": BACKEND_HEALTH_URL,
            "http_status": status_code,
            "error_kind": "backend_health_payload_invalid",
        }
    return {
        "status": "ready",
        "url": BACKEND_HEALTH_URL,
        "http_status": status_code,
    }


def _doctor_frontend_health() -> dict[str, Any]:
    """Probe the local UI without making frontend reachability a DB claim."""

    runtime_mode = (
        os.getenv("OFFERU_RUNTIME_MODE")
        or os.getenv("OFFERU_INTERVIEW_RUNTIME")
        or "local"
    ).strip()
    if runtime_mode == "desktop-sidecar":
        return {
            "status": "embedded",
            "url": "tauri://localhost",
        }
    raw_url = (os.getenv("OFFERU_FRONTEND_HEALTH_URL") or f"{FRONTEND_URL}/").strip()
    if not raw_url:
        return {
            "status": "unavailable",
            "url": "",
            "error_kind": "frontend_url_missing",
        }
    try:
        parsed_url = urlparse(raw_url)
        configured_port = parsed_url.port
    except ValueError:
        parsed_url = None
        configured_port = None
    report_url = FRONTEND_URL
    if parsed_url is not None and parsed_url.hostname:
        report_url = f"{parsed_url.scheme or 'http'}://{parsed_url.hostname}"
        if configured_port is not None:
            report_url += f":{configured_port}"
    if configured_port == 8080:
        return {
            "status": "failed",
            "url": report_url,
            "expected_url": FRONTEND_URL,
            "error_kind": "frontend_port_8080_forbidden",
        }
    if (
        parsed_url is None
        or parsed_url.scheme.lower() != "http"
        or parsed_url.hostname != "127.0.0.1"
        or configured_port != 7410
        or parsed_url.username
        or parsed_url.password
        or parsed_url.path not in {"", "/"}
        or parsed_url.query
        or parsed_url.fragment
    ):
        return {
            "status": "failed",
            "url": report_url,
            "expected_url": FRONTEND_URL,
            "error_kind": "frontend_url_not_allowed",
        }
    url = FRONTEND_URL
    request = Request(
        url,
        headers={"User-Agent": "OfferU-Doctor/0.4"},
        method="GET",
    )
    try:
        with _open_local_url(request, timeout=2.0) as response:
            status_code = int(getattr(response, "status", 200))
            body = response.read(8192)
    except HTTPError as exc:
        return {
            "status": "failed",
            "url": url,
            "http_status": int(exc.code),
            "error_kind": "http_error",
        }
    except (OSError, URLError, TimeoutError):
        return {
            "status": "unavailable",
            "url": url,
            "error_kind": "frontend_not_reachable",
        }
    return {
        "status": "ready" if 200 <= status_code < 300 and b"OfferU" in body else "failed",
        "url": url,
        "http_status": status_code,
        **(
            {}
            if 200 <= status_code < 300 and b"OfferU" in body
            else {"error_kind": "frontend_payload_invalid"}
        ),
    }


def _doctor_release_readiness(
    *,
    settings: Any,
    backend_health: dict[str, Any] | None = None,
    provider_health: list[dict[str, Any]],
    data_safety: dict[str, Any],
    frontend_health: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Return a fail-closed, package-aware Core readiness report.

    Doctor is still useful in development, so desktop-only checks are marked
    ``not_applicable`` outside the packaged sidecar.  A release sidecar must
    prove its writable data directory, bundled runtime paths, and version
    contract before it can report ``CORE_READY``.  Live external credentials
    remain a separate release gate and are never hidden by the built-in Replay
    provider.
    """

    build_mode = str(os.getenv("OFFERU_BUILD_MODE") or "local-development").strip()
    runtime_mode = str(
        os.getenv("OFFERU_RUNTIME_MODE")
        or os.getenv("OFFERU_INTERVIEW_RUNTIME")
        or "local"
    ).strip()
    release_mode = build_mode.casefold() in {"release", "production"} or runtime_mode == "desktop-sidecar"

    data_dir = runtime_data_dir()
    uploads_dir = runtime_uploads_dir()
    storage_missing = [
        str(path)
        for path in (data_dir, uploads_dir)
        if not path.is_dir()
    ]
    storage_status = "ready" if not storage_missing and os.access(data_dir, os.W_OK) else "failed"

    runtime_version = str(os.getenv("OFFERU_VERSION") or "").strip()
    version_status = (
        "ready"
        if runtime_version == APP_VERSION
        else "failed"
        if release_mode
        else "not_applicable"
    )

    bundled_runtime_paths = {
        "agent_runtime_dir": str(os.getenv("OFFERU_AGENT_RUNTIME_DIR") or ""),
        "node_path": str(os.getenv("OFFERU_NODE_PATH") or ""),
    }
    desktop_required = release_mode
    desktop_missing = [
        name
        for name, raw_path in bundled_runtime_paths.items()
        if desktop_required and (not raw_path or not Path(raw_path).exists())
    ]
    if not desktop_required:
        desktop_status = "not_applicable"
    else:
        desktop_status = "ready" if runtime_mode == "desktop-sidecar" and not desktop_missing else "failed"

    schema = data_safety.get("schema_migration")
    schema_status = schema.get("status") if isinstance(schema, dict) else None
    database_ready = (
        data_safety.get("status") == "ready"
        and data_safety.get("integrity_check") == "ok"
        and int(data_safety.get("foreign_key_violations") or 0) == 0
        and schema_status in {"ready", "not_applicable"}
    )
    providers_by_id = {
        str(item.get("provider_id") or ""): item
        for item in provider_health
        if isinstance(item, dict)
    }
    replay = providers_by_id.get("replay") or {}
    live_providers = [
        item
        for provider_id, item in providers_by_id.items()
        if provider_id != "replay" and item.get("available") and item.get("authenticated") is not False
    ]
    agent_runtime_status = "ready" if replay.get("available") or live_providers else "failed"
    live_provider_status = "ready" if live_providers else "not_verified"

    backend_check = backend_health or {
        "status": "not_probed",
        "url": BACKEND_HEALTH_URL,
    }
    frontend_check = frontend_health or {
        "status": "embedded" if release_mode else "not_probed",
        "url": "http://127.0.0.1:7410",
    }
    checks = {
        "backend": {**backend_check, "runtime": "python"},
        "database": {
            "status": "ready" if database_ready else "failed",
            "schema": schema_status or "unavailable",
            "integrity_check": data_safety.get("integrity_check", "unavailable"),
            "foreign_key_violations": int(data_safety.get("foreign_key_violations") or 0),
        },
        "storage": {
            "status": storage_status,
            "mode": "managed_local",
            "missing": storage_missing,
        },
        "desktop_bridge": {
            "status": desktop_status,
            "required": desktop_required,
            "runtime_mode": runtime_mode,
            "missing": desktop_missing,
        },
        "version_consistency": {
            "status": version_status,
            "app_version": APP_VERSION,
            "runtime_version": runtime_version or None,
        },
        "agent_runtime": {
            "status": agent_runtime_status,
            "replay_available": bool(replay.get("available")),
            "live_provider_status": live_provider_status,
            "live_provider_ids": [str(item.get("provider_id") or "") for item in live_providers],
        },
        "frontend": frontend_check,
    }
    required_checks = (
        "backend",
        "database",
        "storage",
        "desktop_bridge",
        "version_consistency",
        "agent_runtime",
        "frontend",
    )
    allowed_check_statuses = {"ready", "embedded", "not_applicable", "not_probed"}
    blockers = [
        name
        for name in required_checks
        if checks[name]["status"] not in allowed_check_statuses
    ]
    return {
        "status": "CORE_READY" if not blockers else "CORE_NOT_READY",
        "release_mode": release_mode,
        "checks": checks,
        "blockers": blockers,
        "live_provider_gate": live_provider_status,
        "note": "CORE_READY 不代表 live external provider、签名或公开发布 Gate 已通过。",
    }


def _doctor_data_safety() -> dict[str, Any]:
    from app.database import schema_migration_status
    from app.services.data_safety import (
        check_database_integrity,
        get_data_safety_status,
    )

    async def collect() -> tuple[dict[str, Any], dict[str, Any]]:
        status, integrity = await asyncio.gather(
            get_data_safety_status(),
            check_database_integrity(),
        )
        return status, integrity

    try:
        status, integrity = asyncio.run(collect())
    except Exception as exc:
        return {
            "status": "unavailable",
            "integrity_check": "not_verified",
            "error": safe_error_message(exc),
        }
    return {
        "status": "ready" if integrity.get("status") == "ok" else "failed",
        "schema_migration": schema_migration_status(),
        "integrity_check": integrity.get("status", "failed"),
        "foreign_key_violations": len(integrity.get("foreign_key_violations") or []),
        "backup_count": status.get("backup_count", 0),
        "invalid_backup_count": status.get("invalid_backup_count", 0),
        "pending_restore": status.get("pending_restore"),
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
            "release_health": "python -m app.cli doctor --require-ready --pretty",
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
