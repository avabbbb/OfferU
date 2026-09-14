from __future__ import annotations

import asyncio
import json
from typing import Any


SERVICE_NAME = "OfferU"


def _keyring():
    try:
        import keyring
    except ImportError as exc:
        raise RuntimeError(
            "系统钥匙串支持未安装，请先安装 backend/requirements.txt"
        ) from exc
    return keyring


def _store(reference: str, payload: dict[str, Any]) -> None:
    try:
        serialized = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
        _keyring().set_password(SERVICE_NAME, reference, serialized)
    except Exception as exc:
        raise RuntimeError("无法写入操作系统钥匙串") from exc


def _load(reference: str) -> dict[str, Any]:
    try:
        serialized = _keyring().get_password(SERVICE_NAME, reference)
    except Exception as exc:
        raise RuntimeError("无法读取操作系统钥匙串") from exc
    if not serialized:
        raise RuntimeError("系统钥匙串中的连接凭据不存在")
    try:
        payload = json.loads(serialized)
    except (TypeError, json.JSONDecodeError) as exc:
        raise RuntimeError("系统钥匙串中的连接凭据已损坏") from exc
    if not isinstance(payload, dict):
        raise RuntimeError("系统钥匙串中的连接凭据格式无效")
    return payload


def _delete(reference: str) -> None:
    keyring = _keyring()
    try:
        keyring.delete_password(SERVICE_NAME, reference)
    except keyring.errors.PasswordDeleteError:
        return
    except Exception as exc:
        raise RuntimeError("无法从操作系统钥匙串删除连接凭据") from exc


async def store_secret(reference: str, payload: dict[str, Any]) -> None:
    await asyncio.to_thread(_store, reference, payload)


async def load_secret(reference: str) -> dict[str, Any]:
    return await asyncio.to_thread(_load, reference)


async def delete_secret(reference: str) -> None:
    await asyncio.to_thread(_delete, reference)


def store_secret_sync(reference: str, payload: dict[str, Any]) -> None:
    """阻塞式写入，供同步的配置加载/保存路径使用。"""
    _store(reference, payload)


def load_secret_sync(reference: str) -> dict[str, Any]:
    """阻塞式读取，供同步的配置加载/保存路径使用。"""
    return _load(reference)


def delete_secret_sync(reference: str) -> None:
    """阻塞式删除，供同步的配置加载/保存路径使用。"""
    _delete(reference)


_PROBE_REFERENCE = "offeru/vault-probe"


def probe_backend() -> str:
    """Write/read/delete one throwaway entry to prove the OS vault really works.

    Returns an empty string when the round trip succeeds, otherwise a short
    reason. Probing matters because keyring can import fine yet silently
    resolve to a unusable backend on a locked-down machine.
    """
    try:
        keyring = _keyring()
    except Exception as exc:
        return str(exc)
    try:
        keyring.set_password(SERVICE_NAME, _PROBE_REFERENCE, "probe")
        if keyring.get_password(SERVICE_NAME, _PROBE_REFERENCE) != "probe":
            return "系统钥匙串返回的内容与写入不一致"
    except Exception as exc:
        return str(exc)
    finally:
        try:
            _delete(_PROBE_REFERENCE)
        except Exception:
            pass
    return ""
