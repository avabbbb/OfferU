"""LLM API Key 的钥匙串边界。

config.json 只保留 `credential_ref`，真实 Key 只写入操作系统钥匙串
（Windows Credential Manager / macOS Keychain / Linux Secret Service）。

读写语义刻意不对称：

- 读取失败不阻断启动，但会把原因暴露到 `/api/config` 的 `vault_status`，
  避免用户看到"Key 不见了"却不知道钥匙串不可用；
- 写入失败必须 fail-closed 抛出，调用方绝不能回退成明文落盘。
"""

from __future__ import annotations

import time
from copy import deepcopy
from typing import Any
from uuid import uuid4

from app.services import credential_store

# 历史 config.json 中的单 provider 明文字段，迁移时逐个搬进钥匙串。
LEGACY_KEY_FIELDS: tuple[str, ...] = (
    "deepseek_api_key",
    "openai_api_key",
    "qwen_api_key",
    "siliconflow_api_key",
    "gemini_api_key",
    "zhipu_api_key",
    "active_llm_api_key",
)
SCRAPER_SECRET_FIELDS: tuple[str, ...] = ("boss_cookie", "zhilian_cookie")


class VaultUnavailableError(RuntimeError):
    """钥匙串不可用；调用方必须向用户暴露，不得静默改为明文存储。"""


_hydrate_errors: list[str] = []


def config_ref(config_id: str) -> str:
    return f"llm/config/{config_id}"


def legacy_ref(field: str) -> str:
    return f"llm/legacy/{field}"


def _is_env_reference(value: str) -> bool:
    return value.startswith("env:") or value.startswith("ENV:")


def _is_masked(value: str) -> bool:
    return "*" in value


def read_key(reference: str) -> str:
    """读一个 Key；钥匙串不可用时返回空串，由 status() 单独暴露原因。"""
    if not reference:
        return ""
    try:
        payload = credential_store.load_secret_sync(reference)
    except Exception:
        return ""
    if not isinstance(payload, dict):
        return ""
    return str(payload.get("api_key") or "")


def _read_connection_secret(reference: str, *, record_error: bool = False) -> dict[str, Any]:
    if not reference:
        return {}
    try:
        payload = credential_store.load_secret_sync(reference)
    except Exception:
        if record_error:
            _hydrate_errors.append("系统钥匙串中的连接凭据无法读取")
        return {}
    return payload if isinstance(payload, dict) else {}


def write_key(reference: str, api_key: str) -> None:
    """写入钥匙串。失败必须抛出，不允许调用方回退为明文落盘。"""
    try:
        credential_store.store_secret_sync(reference, {"api_key": api_key})
    except Exception as exc:
        raise VaultUnavailableError(str(exc)) from exc


def delete_key(reference: str) -> None:
    if not reference:
        return
    try:
        credential_store.delete_secret_sync(reference)
    except Exception:
        # 残留凭据只影响磁盘卫生，不值得阻断配置保存。
        pass


def credential_references(payload: dict[str, Any]) -> set[str]:
    references = {
        str(item.get("credential_ref") or "")
        for item in payload.get("llm_api_configs") or []
        if isinstance(item, dict)
    }
    refs = payload.get("secret_refs")
    if isinstance(refs, dict):
        references.update(str(reference or "") for reference in refs.values())
    return {
        reference
        for reference in references
        if reference.startswith(("llm/config/", "llm/legacy/", "scraper/"))
    }


def hydrate(payload: dict[str, Any]) -> None:
    """把一份 config dict 中的 credential_ref 还原为内存可用的 Key。"""
    global _status_cache
    _hydrate_errors.clear()
    _status_cache = None
    configs = payload.get("llm_api_configs")
    if isinstance(configs, list):
        for item in configs:
            if not isinstance(item, dict):
                continue
            api_key = str(item.get("api_key") or "").strip()
            reference = str(item.get("credential_ref") or "")
            if api_key and not reference:
                continue
            secret = _read_connection_secret(reference, record_error=bool(reference))
            if not api_key and secret.get("api_key"):
                item["api_key"] = str(secret["api_key"])
            if isinstance(secret.get("default_headers"), dict):
                item["default_headers"] = dict(secret["default_headers"])
    refs = payload.get("secret_refs") if isinstance(payload.get("secret_refs"), dict) else {}
    for field in LEGACY_KEY_FIELDS:
        if str(payload.get(field) or "").strip():
            continue
        reference = str(refs.get(field) or "")
        secret = _read_connection_secret(reference, record_error=bool(reference))
        resolved = str(secret.get("api_key") or "")
        if not resolved:
            resolved = read_key(legacy_ref(field))
        if resolved:
            payload[field] = resolved
    for field in SCRAPER_SECRET_FIELDS:
        if str(payload.get(field) or "").strip():
            continue
        reference = str(refs.get(field) or "")
        secret = _read_connection_secret(reference, record_error=bool(reference))
        if secret.get("value"):
            payload[field] = str(secret["value"])


def _new_config_ref() -> str:
    return config_ref(uuid4().hex)


def _stored_secret_matches(reference: str, secret: dict[str, Any]) -> bool:
    return bool(reference and secret and _read_connection_secret(reference) == secret)


def _dehydrate_config_item(item: dict[str, Any], created_refs: list[str]) -> None:
    config_id = str(item.get("id") or "")
    api_key = str(item.get("api_key") or "").strip()
    default_headers = item.get("default_headers") if isinstance(item.get("default_headers"), dict) else {}
    existing_ref = str(item.get("credential_ref") or "")
    item["api_key"] = ""
    item["default_headers"] = {}
    if not config_id:
        return
    if _is_env_reference(api_key):
        # env:VAR 不是秘密，继续按原样留在配置文件里。
        item["api_key"] = api_key
        if not default_headers:
            item["credential_ref"] = ""
            return
    if not api_key and not default_headers:
        # 缺少运行时 Key 不能推断用户明确清空，保留现有引用。
        item["credential_ref"] = existing_ref
        return
    if _is_masked(api_key):
        # 前端回传的仍是脱敏值，保持既有引用不动。
        item["credential_ref"] = existing_ref or config_ref(config_id)
        return
    secret: dict[str, Any] = {}
    if api_key and not _is_env_reference(api_key):
        secret["api_key"] = api_key
    if default_headers:
        secret["default_headers"] = dict(default_headers)
    reference = existing_ref if _stored_secret_matches(existing_ref, secret) else _new_config_ref()
    if reference != existing_ref:
        created_refs.append(reference)
    try:
        credential_store.store_secret_sync(reference, secret)
    except Exception as exc:
        raise VaultUnavailableError(str(exc)) from exc
    item["credential_ref"] = reference


def dehydrate(payload: dict[str, Any]) -> list[str]:
    """把一份待落盘的 config dict 中的明文 Key 抽走，只留 credential_ref。"""
    created_refs: list[str] = []
    try:
        configs = payload.get("llm_api_configs")
        if isinstance(configs, list):
            for item in configs:
                if isinstance(item, dict):
                    _dehydrate_config_item(item, created_refs)
        refs = payload.setdefault("secret_refs", {})
        if not isinstance(refs, dict):
            refs = {}
            payload["secret_refs"] = refs
        for field in LEGACY_KEY_FIELDS:
            value = str(payload.get(field) or "").strip()
            existing_ref = str(refs.get(field) or "")
            if not value or _is_masked(value) or _is_env_reference(value):
                continue
            reference = existing_ref if _stored_secret_matches(existing_ref, {"api_key": value}) else f"llm/legacy/{uuid4().hex}"
            if reference != existing_ref:
                created_refs.append(reference)
            write_key(reference, value)
            refs[field] = reference
            payload[field] = ""
        for field in SCRAPER_SECRET_FIELDS:
            value = str(payload.get(field) or "").strip()
            existing_ref = str(refs.get(field) or "")
            if not value or _is_masked(value):
                continue
            secret = {"value": value}
            reference = existing_ref if _stored_secret_matches(existing_ref, secret) else f"scraper/{field}/{uuid4().hex}"
            if reference != existing_ref:
                created_refs.append(reference)
            try:
                credential_store.store_secret_sync(reference, secret)
            except Exception as exc:
                raise VaultUnavailableError(str(exc)) from exc
            refs[field] = reference
            payload[field] = ""
    except VaultUnavailableError:
        for reference in created_refs:
            delete_key(reference)
        raise
    return created_refs


def migrate_plaintext(raw: dict[str, Any]) -> bool:
    """把历史 config.json 里的明文 Key 迁移进钥匙串。返回是否发生了迁移。

    迁移只做一次：之后 config.json 不再出现明文，dehydrate 持续维持这个
    不变式。env:VAR 引用不是秘密，保持原样。
    """
    migrated = deepcopy(raw)
    dehydrate(migrated)
    changed = migrated != raw
    if changed:
        raw.clear()
        raw.update(migrated)
    return changed


_STATUS_TTL_SECONDS = 60.0
_status_cache: tuple[float, dict[str, Any]] | None = None


def status(force: bool = False) -> dict[str, Any]:
    """钥匙串是否真的可写可读；不可用时给出原因。

    探测本身是一次真实的写入/读取/删除往返，因此结果缓存 60 秒，
    避免配置页刷新不断敲击系统钥匙串。
    """
    global _status_cache
    now = time.monotonic()
    if not force and _status_cache and now - _status_cache[0] < _STATUS_TTL_SECONDS:
        return dict(_status_cache[1])
    probe_error = credential_store.probe_backend()
    read_error = _hydrate_errors[0] if _hydrate_errors else ""
    error = probe_error or read_error
    result = {
        "available": not error,
        "error": str(error or ""),
        "read_error_count": len(_hydrate_errors),
    }
    _status_cache = (now, result)
    return dict(result)
