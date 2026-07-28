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
