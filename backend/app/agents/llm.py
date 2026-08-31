# =============================================
# LLM 抽象层 — 多 Provider 统一接口
# =============================================
# 支持的提供商：
#   - DeepSeek（中国首选，便宜快速）
#   - OpenAI（GPT-4o 系列）
#   - Qwen（阿里云百炼）
#   - Ollama（本地部署，完全免费）
#
# 所有提供商统一为 `chat_completion()` 接口，
# 使用 OpenAI 兼容协议（DeepSeek / Ollama 均支持）。
# =============================================

from __future__ import annotations

import asyncio
import json
import logging
import re
from typing import TYPE_CHECKING, Any, Optional, AsyncGenerator

import httpx
if TYPE_CHECKING:
    from openai import AsyncOpenAI

from app.config import get_settings
from app.services.security_redaction import redact_sensitive_text

_logger = logging.getLogger(__name__)


def _make_http_client() -> httpx.AsyncClient:
    """
    构造绕过系统代理（Clash / IE Settings）的 httpx 客户端。
    ─────────────────────────────────────────────
    Windows 下 httpx 会自动读取系统代理，导致 SSL 证书主机名
    不匹配错误。使用自定义 transport 来绕过。
    ssl_verify 由 config.py Settings.ssl_verify 控制：
      - True (默认)  = 正常 SSL 验证
      - False (开发) = 跳过验证（Clash 等代理场景）
    """
    settings = get_settings()
    return httpx.AsyncClient(
        transport=httpx.AsyncHTTPTransport(local_address="0.0.0.0"),
        verify=settings.ssl_verify,
        trust_env=False,
    )


DEFAULT_BASE_URLS = {
    "openai": "https://api.openai.com/v1",
    "deepseek": "https://api.deepseek.com",
    "qwen": "https://dashscope.aliyuncs.com/compatible-mode/v1",
    "siliconflow": "https://api.siliconflow.com/v1",
    "gemini": "https://generativelanguage.googleapis.com/v1beta/openai",
    "zhipu": "https://open.bigmodel.cn/api/paas/v4",
}

# ---- tier → model 映射 ----
# 每个 provider 定义 fast / standard / premium 三档模型
# 未列出的 provider 或 tier 会 fallback 到 settings.llm_model
TIER_MODEL_MAP: dict[str, dict[str, str]] = {
    "qwen": {
        "fast": "qwen-flash",
        "standard": "qwen3.5-plus",
        "premium": "qwen3.5-plus",
    },
    "deepseek": {
        "fast": "deepseek-v4-flash",
        "standard": "deepseek-v4-flash",
        "premium": "deepseek-v4-pro",
    },
    "openai": {
        "fast": "gpt-4o-mini",
        "standard": "gpt-4o",
        "premium": "gpt-4o",
    },
}


def _cfg_bool(value: Any, default: bool = True) -> bool:
    """宽松地把配置值解析为 bool（兼容 bool / str / None）。"""
    if value is None:
        return default
    if isinstance(value, bool):
        return value
    return str(value).strip().lower() in ("1", "true", "yes", "on")


def _is_local_llm(base_url: str, provider_id: str) -> bool:
    """本地推理端点判定：ollama / lmstudio 等或 localhost 地址。

    本地端点不需要真实 API Key（用占位 key），并统一补 /v1 后缀。
    provider_id 仅在此处作身份提示，不构成行为分支。
    """
    pid = (provider_id or "").strip().lower()
    if pid in ("ollama", "lmstudio", "local", "llamacpp", "vllm-local"):
        return True
    host = (base_url or "").strip().lower()
    return "localhost" in host or "127.0.0.1" in host or "0.0.0.0" in host


def _active_provider_config(settings: Any) -> dict[str, Any] | None:
    """从 llm_api_configs 中解析当前激活的 provider 配置（BYOK 主路径）。"""
    configs = getattr(settings, "llm_api_configs", None) or []
    if not isinstance(configs, list):
        return None
    active_id = str(getattr(settings, "active_llm_config_id", "") or "").strip()
    if active_id:
        for cfg in configs:
            if isinstance(cfg, dict) and str(cfg.get("id") or "") == active_id:
                return cfg
    for cfg in configs:
        if isinstance(cfg, dict) and cfg.get("is_active"):
            return cfg
    if len(configs) == 1 and isinstance(configs[0], dict):
        return configs[0]
    return None


def resolve_llm_client_config(settings: Any | None = None) -> dict[str, Any]:
    """BYOK 统一 LLM 解析 —— 唯一事实源，CLI / GUI / Agent / 测试共用。

    配置优先级：
      1. config.json 中激活的 provider 配置（llm_api_configs + active_llm_config_id）
      2. legacy active 字段（active_llm_base_url + active_llm_api_key）
      3. legacy 每 provider .env key（llm_provider + *api_key，仅向后兼容老用户）

    provider 可自由配置（base_url / api_key / model 任意组合），provider_id
    只作身份与图标/预设匹配，不参与任何行为分支。
    返回 dict: base_url / api_key / model / provider / service_name /
    source / supports_json_mode / default_headers / models。
    """
    config = settings or get_settings()
    active_cfg = _active_provider_config(config)
    legacy_base_url = str(getattr(config, "active_llm_base_url", "") or "").strip().rstrip("/")
    legacy_api_key = str(getattr(config, "active_llm_api_key", "") or "").strip()
    default_model = str(getattr(config, "llm_model", "") or "").strip()

    # 自愈式同步：若运行时 Settings 没有任何激活配置（例如直接 import
    # app.agents.llm 的独立脚本，未经过 cli.py / routes.config 的同步），
    # 尝试从 backend/config.json 装载 provider 列表，保证所有入口解析一致。
    if active_cfg is None and not legacy_base_url and not legacy_api_key:
        try:
            from app.llm_config_store import sync_runtime_settings_from_file

            if sync_runtime_settings_from_file():
                config = settings or get_settings()
                active_cfg = _active_provider_config(config)
                legacy_base_url = str(
                    getattr(config, "active_llm_base_url", "") or ""
                ).strip().rstrip("/")
                legacy_api_key = str(
                    getattr(config, "active_llm_api_key", "") or ""
                ).strip()
                default_model = str(getattr(config, "llm_model", "") or "").strip()
        except Exception:
            # config.json 缺失/损坏时静默回退到 legacy .env 路径。
            pass

    if active_cfg is not None:
        provider_id = str(
            active_cfg.get("provider_id") or active_cfg.get("service_name") or "custom"
        ).strip().lower() or "custom"
        service_name = str(active_cfg.get("service_name") or provider_id)
        base_url = str(active_cfg.get("base_url") or "").strip().rstrip("/")
        api_key = str(active_cfg.get("api_key") or "").strip()
        model = str(active_cfg.get("model") or default_model).strip()
        api_format = str(active_cfg.get("api_format") or "openai").strip().lower()
        supports_json_mode = _cfg_bool(active_cfg.get("supports_json_mode"), default=True)
        default_headers = (
            active_cfg.get("default_headers")
            if isinstance(active_cfg.get("default_headers"), dict)
            else {}
        )
        models = (
            active_cfg.get("models") if isinstance(active_cfg.get("models"), dict) else {}
        )
        source = "active_config"
        if not base_url:
            raise ValueError(
                f"当前激活的 LLM 配置缺少 Base URL（{service_name}）。请在设置页面填写完整信息。"
            )
        if api_format not in ("openai", ""):
            raise ValueError(
                f"暂不支持的 API 协议 {api_format}（{service_name}）；当前仅支持 OpenAI 兼容接口。"
            )
        if not api_key and not _is_local_llm(base_url, provider_id):
            raise ValueError(
                f"当前激活的 LLM 配置缺少 API Key（{service_name}）。请在设置页面填写。"
            )
        if _is_local_llm(base_url, provider_id):
            base_url = _ensure_ollama_v1(base_url)
            api_key = api_key or "ollama"
            if provider_id == "ollama":
                source = "ollama"
        if not model:
            raise ValueError(f"当前激活的 LLM 配置缺少模型名称（{service_name}）。")
    elif legacy_base_url and legacy_api_key:
        provider_id = str(getattr(config, "llm_provider", "") or "custom").strip().lower() or "custom"
        service_name = provider_id
        base_url = legacy_base_url
        api_key = legacy_api_key
        model = default_model
        supports_json_mode = not _is_local_llm(base_url, provider_id)
        default_headers = {}
        models = {}
        source = "active_config"
    else:
        provider = (getattr(config, "llm_provider", "") or "deepseek").strip().lower() or "deepseek"
        provider_id = provider
        service_name = provider
        model = default_model
        if provider == "ollama":
            ollama_url = str(getattr(config, "ollama_base_url", "") or "").strip() or "http://localhost:11434"
            base_url = _ensure_ollama_v1(ollama_url)
            api_key = "ollama"
            supports_json_mode = False
            source = "ollama"
        else:
            legacy_keys = {
                "deepseek": getattr(config, "deepseek_api_key", ""),
                "openai": getattr(config, "openai_api_key", ""),
                "qwen": getattr(config, "qwen_api_key", ""),
                "siliconflow": getattr(config, "siliconflow_api_key", ""),
                "gemini": getattr(config, "gemini_api_key", ""),
                "zhipu": getattr(config, "zhipu_api_key", ""),
            }
            api_key = str(legacy_keys.get(provider, "") or "").strip()
            base_url = DEFAULT_BASE_URLS.get(provider, "")
            supports_json_mode = True
            source = "legacy_fallback"
            if not api_key:
                raise ValueError(f"LLM API Key 未配置（provider={provider}），请在设置页面填写")
            if not base_url:
                raise ValueError(f"LLM Base URL 未配置（provider={provider}），请在设置页面填写")
        default_headers = {}
        models = {}

    # env:VAR_NAME 引用解析 + 禁用 provider 检查（ADR/omp 模式：disabled 不可选）
    from app.llm_config_store import resolve_api_key

    resolved_api_key = resolve_api_key(api_key)
    disabled = set(getattr(config, "disabled_llm_providers", None) or [])
    if provider_id in disabled:
        raise ValueError(
            f"LLM provider「{service_name}」已被禁用，请在设置中启用后再使用"
        )

    return {
        "base_url": base_url,
        "api_key": resolved_api_key,
        "model": model,
        "provider": provider_id,
        "service_name": service_name,
        "source": source,
        "supports_json_mode": supports_json_mode,
        "default_headers": default_headers,
        "models": models,
    }


def resolve_model_for_tier(tier: str = "standard", settings: Any | None = None) -> str:
    """按档位解析模型：provider 配置 models → 全局 tier_model_map → 默认模型。"""
    config = settings or get_settings()
    active_cfg = _active_provider_config(config)
    if active_cfg is not None:
        models = (
            active_cfg.get("models") if isinstance(active_cfg.get("models"), dict) else {}
        )
        if models.get(tier):
            return str(models[tier])
    user_tier_map = getattr(config, "tier_model_map", None) or {}
    if user_tier_map.get(tier):
        return str(user_tier_map[tier])
    if active_cfg is not None and str(active_cfg.get("model") or "").strip():
        return str(active_cfg["model"]).strip()
    return str(getattr(config, "llm_model", "") or "").strip()


def get_llm_runtime_info(
    tier: str = "standard",
    settings_override: Any | None = None,
) -> dict[str, str]:
    """Return the model selection that chat_completion will use for this tier."""
    resolved = resolve_llm_client_config(settings_override)
    model = resolve_model_for_tier(tier, settings_override)
    return {
        "provider": resolved["provider"],
        "model": model,
        "tier": tier,
        "source": resolved["source"],
        "model_source": "provider_models" if resolved.get("models") else "llm_model",
    }


def _ensure_ollama_v1(base_url: str) -> str:
    base = base_url.rstrip("/")
    if base.endswith("/v1"):
        return base
    return f"{base}/v1"


def _get_client() -> tuple[Any, str]:
    """
    根据当前配置的 LLM Provider 创建对应客户端
    ─────────────────────────────────────────────
    BYOK 统一解析（见 resolve_llm_client_config）：
      provider 可自由配置，base_url / api_key / model 来自激活配置；
      无激活配置时向后兼容 legacy .env per-provider key。

    返回: (client, model_name)
    """
    resolved = resolve_llm_client_config()
    # openai imports hundreds of generated schema modules. Keep that ~1.2s
    # cost off the desktop cold-start path and pay it only for the first LLM call.
    from openai import AsyncOpenAI
    http_client = _make_http_client()
    kwargs: dict[str, Any] = {
        "api_key": resolved["api_key"],
        "base_url": resolved["base_url"],
        "http_client": http_client,
    }
    if resolved.get("default_headers"):
        kwargs["default_headers"] = resolved["default_headers"]
    client = AsyncOpenAI(**kwargs)
    _logger.info(
        "[LLM Config] source=%s, provider=%s, model=%s, base_url=%s",
        resolved["source"],
        resolved["provider"],
        resolved["model"],
        redact_sensitive_text(resolved["base_url"], max_length=300),
    )
    return client, resolved["model"]


async def chat_completion(
    messages: list[dict],
    temperature: float = 0.3,
    json_mode: bool = False,
    max_tokens: int = 4096,
    tier: str = "standard",
) -> Optional[str]:
    """
    统一的 LLM Chat Completion 接口
    ─────────────────────────────────────────────
    根据全局配置自动选择 Provider 和模型。
    所有 Provider 都走 OpenAI 兼容协议。

    参数:
      messages: ChatML 格式消息列表
      temperature: 生成温度（0=确定性, 1=创造性）
      json_mode: 是否强制 JSON 输出格式
      max_tokens: 最大生成 token 数
      tier: 模型档位 fast / standard / premium

    返回: 模型的文本输出，失败返回 None
    """
    client, _ = _get_client()

    # BYOK: 模型与 json_mode 能力由统一解析决定（provider 可自由配置，
    # provider_id 不参与行为分支；仅本地/明确关闭 json 的 provider 禁用 response_format）。
    settings = get_settings()
    resolved = resolve_llm_client_config()
    provider = resolved["provider"]
    model = resolve_model_for_tier(tier)

    kwargs: dict = {
        "model": model,
        "messages": messages,
        "temperature": temperature,
        "max_tokens": max_tokens,
    }

    if json_mode and resolved["supports_json_mode"]:
        kwargs["response_format"] = {"type": "json_object"}
        # 部分网关（如 opencode Console 上游）要求 prompt 含 'json' 字样才接受
        # response_format=json_object；缺失时在最后一条消息末尾追加。
        prompt_text = " ".join(
            str(message.get("content") or "") for message in messages
        ).lower()
        if "json" not in prompt_text:
            messages = [*messages]
            last = dict(messages[-1])
            last["content"] = str(last.get("content") or "") + "\n\nReturn JSON only."
            messages[-1] = last
            kwargs["messages"] = messages

    try:
        async def _create(**kw: Any) -> Any:
            """带超时与瞬态重试（408/429/5xx 指数退避，最多 3 次）。"""
            last_error: Optional[BaseException] = None
            for attempt in range(3):
                try:
                    return await asyncio.wait_for(
                        client.chat.completions.create(**kw),
                        timeout=settings.llm_timeout,
                    )
                except Exception as exc:
                    status = getattr(exc, "status_code", None)
                    retryable = status in (408, 429) or (
                        status is not None and status >= 500
                    )
                    if not retryable or attempt == 2:
                        raise
                    last_error = exc
                    await asyncio.sleep(0.5 * (2**attempt))
            raise last_error  # type: ignore[misc]

        # 推理模型（deepseek-v4 等）的思考会消耗 max_tokens 预算，正文被截断；
        # 用 max_completion_tokens 提供含思考的总预算，老端点不支持时回退 max_tokens。
        try:
            completion_kwargs = {
                **kwargs,
                "max_completion_tokens": int(max_tokens) * 3,
            }
            completion_kwargs.pop("max_tokens", None)
            response = await _create(**completion_kwargs)
        except Exception as completion_exc:
            message_lower = str(completion_exc).lower()
            if "max_completion_tokens" not in message_lower:
                raise
            response = await _create(**kwargs)
        return response.choices[0].message.content
    except asyncio.TimeoutError:
        _logger.error(f"[LLM Timeout] {provider}/{model} (tier={tier}): 超过 {settings.llm_timeout}s")
        return None
    except Exception as e:
        _logger.error(
            "[LLM Error] %s/%s (tier=%s): %s",
            provider,
            model,
            tier,
            redact_sensitive_text(e, max_length=500),
        )
        return None


async def chat_completion_stream(
    messages: list[dict],
    temperature: float = 0.3,
    json_mode: bool = False,
    max_tokens: int = 4096,
    tier: str = "standard",
) -> AsyncGenerator[str, None]:
    """流式 LLM Chat Completion，逐 token yield 文本。

    参数同 chat_completion，返回 async generator。
    """
    client, _ = _get_client()

    settings = get_settings()
    resolved = resolve_llm_client_config()
    provider = resolved["provider"]
    model = resolve_model_for_tier(tier)

    kwargs: dict = {
        "model": model,
        "messages": messages,
        "temperature": temperature,
        "max_tokens": max_tokens,
        "stream": True,
    }

    if json_mode and resolved["supports_json_mode"]:
        kwargs["response_format"] = {"type": "json_object"}
        # 部分网关要求 prompt 含 'json' 字样才接受 response_format=json_object
        prompt_text = " ".join(
            str(message.get("content") or "") for message in messages
        ).lower()
        if "json" not in prompt_text:
            messages = [*messages]
            last = dict(messages[-1])
            last["content"] = str(last.get("content") or "") + "\n\nReturn JSON only."
            messages[-1] = last
            kwargs["messages"] = messages

    try:
        async def _create_stream(**kw: Any) -> Any:
            """带超时与瞬态重试的流式 create。"""
            last_error: Optional[BaseException] = None
            for attempt in range(3):
                try:
                    return await asyncio.wait_for(
                        client.chat.completions.create(**kw),
                        timeout=settings.llm_timeout,
                    )
                except Exception as exc:
                    status = getattr(exc, "status_code", None)
                    retryable = status in (408, 429) or (
                        status is not None and status >= 500
                    )
                    if not retryable or attempt == 2:
                        raise
                    last_error = exc
                    await asyncio.sleep(0.5 * (2**attempt))
            raise last_error  # type: ignore[misc]

        # 推理模型思考消耗 max_tokens 预算导致正文截断；max_completion_tokens 提供总预算
        try:
            stream_kwargs = {
                **kwargs,
                "max_completion_tokens": int(max_tokens) * 3,
            }
            stream_kwargs.pop("max_tokens", None)
            stream = await _create_stream(**stream_kwargs)
        except Exception as completion_exc:
            message_lower = str(completion_exc).lower()
            if "max_completion_tokens" not in message_lower:
                raise
            stream = await _create_stream(**kwargs)
        try:
            async for chunk in stream:
                delta = chunk.choices[0].delta if chunk.choices else None
                if delta and delta.content:
                    yield delta.content
        finally:
            # 关闭底层连接，避免流中断/异常时连接泄漏
            close = getattr(stream, "close", None)
            if callable(close):
                try:
                    close()
                except Exception:
                    pass
    except asyncio.TimeoutError:
        _logger.error(f"[LLM Timeout] {provider}/{model} (tier={tier}, stream): 超过 {settings.llm_timeout}s")
        return
    except Exception as e:
        _logger.error(
            "[LLM Error] %s/%s (tier=%s, stream): %s",
            provider,
            model,
            tier,
            redact_sensitive_text(e, max_length=500),
        )
        return


def extract_json(text: str) -> Optional[dict]:
    """
    从 LLM 输出文本中提取 JSON
    ─────────────────────────────────────────────
    模型可能将 JSON 包装在 markdown code block 中，
    如 ```json ... ```，需要剥离后解析。
    兼容各种 LLM 的输出习惯。
    """
    if not text:
        return None

    text = text.strip()

    # 尝试直接解析
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        _logger.debug("extract_json: direct parse failed, trying fallback: %s", text[:200])

    # 尝试从 markdown code block 中提取
    match = re.search(r'```(?:json)?\s*\n(.*?)\n```', text, re.DOTALL)
    if match:
        try:
            return json.loads(match.group(1))
        except json.JSONDecodeError:
            pass

    # 尝试找到第一个 { 到最后一个 } 的范围
    start = text.find("{")
    end = text.rfind("}")
    if start >= 0 and end > start:
        try:
            return json.loads(text[start:end + 1])
        except json.JSONDecodeError:
            pass

    return None


# =============================================
# Embedding API — 文本向量化（用于语义搜索）
# =============================================

async def get_embedding(text: str, model: str = "text-embedding-v3") -> list[float]:
    """
    获取文本的 Embedding 向量
    ─────────────────────────────────────────────
    优先使用 Qwen 的 embedding 模型（便宜且效果好）
    备选：OpenAI text-embedding-3-small

    参数:
      text: 待向量化的文本
      model: embedding 模型名称

    返回: 向量列表（长度取决于模型，Qwen v3 为 1024 维）
    """
    if not text or not text.strip():
        # 返回零向量（避免崩溃）
        return [0.0] * 1024

    client, _ = _get_client()
    settings = get_settings()

    try:
        # OpenAI 兼容的 embedding API
        response = await asyncio.wait_for(
            client.embeddings.create(
                model=model,
                input=text[:8000],  # 截断过长文本（避免超限）
            ),
            timeout=settings.llm_timeout,
        )

        embedding = response.data[0].embedding
        _logger.debug(f"[Embedding] model={model}, text_len={len(text)}, vec_dim={len(embedding)}")
        return embedding

    except asyncio.TimeoutError:
        _logger.error(f"[Embedding Timeout] model={model}: 超过 {settings.llm_timeout}s")
        return [0.0] * 1024
    except Exception as e:
        _logger.error(
            "[Embedding Error] model=%s: %s",
            model,
            redact_sensitive_text(e, max_length=500),
        )
        return [0.0] * 1024
