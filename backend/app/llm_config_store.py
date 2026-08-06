# =============================================
# LLM 配置存储 — 轻量 config.json 读取与运行时同步
# =============================================
# 供 CLI / 服务器 / 外部 Agent 共用，确保所有入口读取同一份 LLM 配置
# （BYOK: provider 可自由配置，无写死的 provider 行为分支）。
# 不依赖 FastAPI，避免 CLI 冷启动变慢。
# =============================================

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any
from uuid import uuid4

from app.config import get_settings
from app.llm_presets import (
    provider_default_model,
    provider_default_url,
    provider_name,
    provider_tier_models,
)

# backend/config.json
_CONFIG_FILE = Path(__file__).resolve().parent.parent / "config.json"

# 从 config.json 同步进全局 Settings 的 LLM 相关字段。
# 与 app/routes/config.py 的 _sync_runtime_settings 保持一致。
_LLM_RUNTIME_FIELDS: tuple[str, ...] = (
    "llm_provider",
    "llm_model",
    "deepseek_api_key",
    "openai_api_key",
    "qwen_api_key",
    "siliconflow_api_key",
    "gemini_api_key",
    "zhipu_api_key",
    "ollama_base_url",
    "llm_api_configs",
    "active_llm_config_id",
    "active_llm_base_url",
    "active_llm_api_key",
    "tier_model_map",
    "disabled_llm_providers",
    "ssl_verify",
    "llm_timeout",
)


def config_file_path() -> Path:
    return _CONFIG_FILE


def load_llm_config_file() -> dict[str, Any] | None:
    """读取 backend/config.json，返回原始 dict；文件不存在或损坏时返回 None。"""
    if not _CONFIG_FILE.exists():
        return None
    try:
        raw = json.loads(_CONFIG_FILE.read_text(encoding="utf-8"))
        return raw if isinstance(raw, dict) else None
    except (json.JSONDecodeError, OSError):
        return None


def sync_runtime_settings_from_file() -> bool:
    """把 config.json 中的 LLM 配置同步进全局 Settings。

    服务器在导入 app.routes.config 时也会执行同等同步；本函数供 CLI /
    独立进程调用，确保『统一 Operation Registry』下各入口 LLM 解析一致。
    返回是否成功读取到 config.json。
    """
    raw = load_llm_config_file()
    if not raw:
        return False
    settings = get_settings()
    for field in _LLM_RUNTIME_FIELDS:
        if field in raw:
            setattr(settings, field, raw.get(field))
    return True


# ---- 一键导入 API Key（cc-switch 风格，数据驱动，无 provider 硬编码分支） ----

_PLACEHOLDER_API_KEYS = {
    "sk-your-openai-key-here",
    "your-openai-api-key",
    "your-deepseek-api-key",
    "your-gemini-api-key",
    "your-api-key",
    "replace-with-your-api-key",
    "api-key-here",
    "sk-your-key",
}


def _normalize_provider_id(value: str) -> str:
    normalized = re.sub(r"[^a-z0-9]+", "-", (value or "").lower()).strip("-")
    return normalized or "custom"


def _sanitize_api_key(raw: str) -> str:
    value = (raw or "").strip()
    if not value:
        return ""
    lowered = value.lower()
    # env:VAR_NAME 引用：不校验 key 形状，运行期从环境变量解析
    if value.startswith("env:") or value.startswith("ENV:"):
        return value
    if "*" in value or lowered in _PLACEHOLDER_API_KEYS:
        return ""
    if "your" in lowered and "key" in lowered:
        return ""
    return value


_ENV_FILE = Path(__file__).resolve().parent.parent / ".env"
_ENV_FILE_VALUES: dict[str, str] | None = None


def _load_env_file_values() -> dict[str, str]:
    """最小化解析 backend/.env（进程环境变量优先于 .env 文件，与 omp 一致）。"""
    global _ENV_FILE_VALUES
    if _ENV_FILE_VALUES is not None:
        return _ENV_FILE_VALUES
    values: dict[str, str] = {}
    try:
        for line in _ENV_FILE.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            value = value.strip()
            if len(value) >= 2 and value[0] == value[-1] and value[0] in ("'", '"'):
                value = value[1:-1]
            values[key.strip()] = value
    except OSError:
        pass
    _ENV_FILE_VALUES = values
    return values


def reload_env_file_cache() -> None:
    """配置或 .env 变化后清缓存，下次解析重新读取。"""
    global _ENV_FILE_VALUES
    _ENV_FILE_VALUES = None


def resolve_api_key(raw: str) -> str:
    """解析配置中的 API Key；支持 env:VAR_NAME 引用（运行期从环境变量读取）。

    优先级：进程环境变量 > backend/.env 文件（pydantic-settings 只把 .env 填进
    模型字段，不会写入 os.environ，因此这里需要显式回退读文件）。
    """
    value = (raw or "").strip()
    if value.startswith("env:") or value.startswith("ENV:"):
        var_name = value[4:].strip()
        if not var_name:
            return ""
        import os

        resolved = (os.environ.get(var_name) or "").strip()
        if resolved:
            return resolved
        return _load_env_file_values().get(var_name, "")
    return value


async def probe_llm_endpoint(
    base_url: str,
    api_key: str,
    model: str,
    provider: str = "custom",
) -> dict[str, Any]:
    """对指定 base_url / api_key / model 做一次真实连接探测。

    失败时如实暴露 HTTP 状态与错误消息（如无效 API Key 401），便于用户定位。
    无 FastAPI 依赖，CLI / 服务器 / 一键导入共用。
    """
    import httpx

    resolved_key = resolve_api_key(api_key)
    if not resolved_key or resolved_key in _PLACEHOLDER_API_KEYS:
        return {
            "success": False,
            "provider": provider,
            "model": model,
            "message": "API Key 未配置或仍为占位符，请先填写有效的 API Key。",
        }
    clean_base = (base_url or "").strip().rstrip("/")
    if not clean_base:
        return {
            "success": False,
            "provider": provider,
            "model": model,
            "message": "Base URL 未配置。",
        }
    test_url = f"{clean_base}/chat/completions"
    headers = {"Content-Type": "application/json", "Authorization": f"Bearer {resolved_key}"}
    payload = {"model": model, "messages": [{"role": "user", "content": "Hi"}], "max_tokens": 5}
    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.post(test_url, json=payload, headers=headers)
        if resp.status_code == 200:
            body = resp.json()
            model_used = body.get("model", model)
            return {
                "success": True,
                "provider": provider,
                "model": model_used,
                "message": f"连接成功！模型 {model_used} 可正常使用。",
            }
        try:
            err_body = resp.json()
            err_msg = err_body.get("error", {}).get("message", "") or err_body.get("message", "")
        except Exception:
            err_msg = resp.text[:200]
        return {
            "success": False,
            "provider": provider,
            "model": model,
            "message": f"API 返回错误 ({resp.status_code}): {err_msg}",
        }
    except httpx.ConnectError:
        return {
            "success": False,
            "provider": provider,
            "model": model,
            "message": f"无法连接到 {clean_base}，请检查 Base URL 是否正确以及网络是否畅通。",
        }
    except httpx.TimeoutException:
        return {
            "success": False,
            "provider": provider,
            "model": model,
            "message": f"连接超时 ({clean_base})，请检查网络或更换 Base URL。",
        }
    except Exception as exc:
        return {
            "success": False,
            "provider": provider,
            "model": model,
            "message": f"检测失败: {exc}",
        }


def import_provider(
    *,
    provider_id: str = "",
    api_key: str = "",
    base_url: str = "",
    model: str = "",
    service_name: str = "",
    models: dict[str, str] | None = None,
    activate: bool = True,
) -> dict[str, Any]:
    """一键导入自己的 API Key（数据驱动，cc-switch 风格）。

    - 从 PROVIDER_PRESETS 按 provider_id 自动补全 base_url / 默认模型 /
      tier 映射 / 服务商名；无预设时要求显式 base_url + model（任意
      OpenAI 兼容端点均可，不写死任何 provider 行为分支）。
    - 写入 backend/config.json 的 llm_api_configs 并同步运行时，
      GUI / CLI / Agent 立即生效。
    - activate=True 时把该配置设为当前激活。

    返回 {ok, config, errors}。
    """
    errors: list[str] = []
    key = _sanitize_api_key(api_key)
    if not key:
        errors.append("API Key 不能为空，且不能是占位符。")

    pid = _normalize_provider_id(provider_id) if (provider_id or "").strip() else ""
    settings = get_settings()
    if pid and pid in set(getattr(settings, "disabled_llm_providers", None) or []):
        errors.append(f"provider「{pid}」已被禁用，请先在设置中启用后再导入。")
    eff_service = (service_name or "").strip() or (
        provider_name(pid) if pid else (provider_id or "自定义")
    )
    eff_base = (base_url or "").strip().rstrip("/") or (
        provider_default_url(pid) if pid else ""
    )
    eff_model = (model or "").strip() or (
        provider_default_model(pid) if pid else ""
    )
    eff_models = dict(models or {}) if models else (
        provider_tier_models(pid) if pid else {}
    )
    if not eff_base:
        errors.append("缺少 Base URL：请选择预设服务商或填写接口地址。")
    if not eff_model:
        errors.append("缺少模型名称：请选择预设模型或填写模型名。")
    if errors:
        return {"ok": False, "config": None, "errors": errors}

    raw = load_llm_config_file() or {}
    configs = raw.get("llm_api_configs") if isinstance(raw.get("llm_api_configs"), list) else []
    # 按 provider_id 更新现有配置；否则新建（custom 或无 provider_id 时总是新建）
    target = None
    if pid:
        target = next((c for c in configs if c.get("provider_id") == pid), None)
    if target is None:
        target = {
            "id": uuid4().hex,
            "provider_id": pid or "custom",
            "service_name": eff_service,
            "model": eff_model,
            "base_url": eff_base,
            "api_key": key,
            "is_active": False,
            "extra_params": {},
            "models": eff_models,
            "api_format": "openai",
            "supports_json_mode": True,
            "default_headers": {},
            "icon": "",
            "website_url": "",
            "notes": "",
        }
        configs.append(target)
    else:
        target["service_name"] = eff_service
        target["model"] = eff_model
        target["base_url"] = eff_base
        target["api_key"] = key
        # 显式传 models 才覆盖；否则清空旧映射，让 tier 解析回退到显式 model，
        # 避免 preset 的官方模型名与用户自定义模型（如 -free 系列）冲突。
        target["models"] = dict(models or {}) if models is not None else {}

    if activate:
        for cfg in configs:
            cfg["is_active"] = cfg is target
        raw["active_llm_config_id"] = target["id"]
        raw["active_llm_base_url"] = target["base_url"]
        raw["active_llm_api_key"] = target["api_key"]
        raw["llm_provider"] = target["provider_id"]
        raw["llm_model"] = target["model"]

    raw["llm_api_configs"] = configs
    try:
        _CONFIG_FILE.write_text(
            json.dumps(raw, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
    except OSError as exc:
        return {"ok": False, "config": None, "errors": [f"保存配置失败: {exc}"]}
    sync_runtime_settings_from_file()
    return {"ok": True, "config": target, "errors": []}


# ---- 本地推理引擎自动发现（omp 模式：引擎在跑且 keyless 即可用） ----

_LOCAL_ENGINE_PROBES = (
    ("ollama", "http://127.0.0.1:11434", "v1/models"),
    ("lm-studio", "http://127.0.0.1:1234", "v1/models"),
    ("vllm", "http://127.0.0.1:8000", "v1/models"),
    ("llama.cpp", "http://127.0.0.1:8080", "v1/models"),
)


async def discover_local_llms(
    *,
    timeout: float = 1.5,
) -> dict[str, Any]:
    """探测本地 OpenAI 兼容推理引擎；发现且未配置时自动追加 keyless 配置。

    - 引擎未运行 / 连接失败一律静默跳过，不阻塞启动
    - 已有同 provider_id 配置（即使禁用）不覆盖
    - 新配置不自动激活，避免抢走用户显式选择的 provider
    """
    import httpx

    raw = load_llm_config_file() or {}
    configs = raw.get("llm_api_configs") if isinstance(raw.get("llm_api_configs"), list) else []
    known = {str(c.get("provider_id") or "") for c in configs}
    discovered: list[str] = []
    errors: list[str] = []
    for provider_id, base_url, probe_path in _LOCAL_ENGINE_PROBES:
        if provider_id in known:
            continue
        try:
            async with httpx.AsyncClient(timeout=timeout) as client:
                resp = await client.get(f"{base_url}/{probe_path}")
            if resp.status_code != 200:
                continue
        except Exception:
            continue
        target = {
            "id": uuid4().hex,
            "provider_id": provider_id,
            "service_name": provider_name(provider_id) or provider_id,
            "model": provider_default_model(provider_id) or "",
            "base_url": base_url.rstrip("/") + "/v1",
            "api_key": "",
            "is_active": False,
            "extra_params": {},
            "models": provider_tier_models(provider_id) or {},
            "api_format": "openai",
            "supports_json_mode": True,
            "default_headers": {},
            "icon": provider_id,
            "website_url": "",
            "notes": "本地自动发现（keyless）",
        }
        configs.append(target)
        known.add(provider_id)
        discovered.append(provider_id)
    if not discovered:
        return {"discovered": [], "errors": errors}
    raw["llm_api_configs"] = configs
    try:
        _CONFIG_FILE.write_text(
            json.dumps(raw, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        sync_runtime_settings_from_file()
    except OSError as exc:
        errors.append(f"保存配置失败: {exc}")
    return {"discovered": discovered, "errors": errors}
