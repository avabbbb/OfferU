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


def _runtime_source(settings) -> str:
    provider = (settings.llm_provider or "deepseek").strip().lower()
    if provider == "ollama":
        return "ollama"
    if settings.active_llm_config_id or settings.active_llm_base_url or settings.active_llm_api_key:
        return "active_config"
    return "legacy_fallback"


def get_llm_runtime_info(
    tier: str = "standard",
    settings_override: Any | None = None,
) -> dict[str, str]:
    """Return the model selection that chat_completion will use for this tier."""
    settings = settings_override or get_settings()
    provider = (settings.llm_provider or "deepseek").strip().lower()
    user_tier_map = getattr(settings, "tier_model_map", None) or {}
    if user_tier_map:
        model = str(user_tier_map.get(tier) or settings.llm_model)
        model_source = "tier_model_map"
    else:
        model = str(settings.llm_model)
        model_source = "llm_model"
    return {
        "provider": provider,
        "model": model,
        "tier": tier,
        "source": _runtime_source(settings),
        "model_source": model_source,
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
    配置优先级（PRD §8.1 LLM Configuration Transparency）:
      1. 若存在激活配置 (active_llm_config_id / active_llm_base_url / active_llm_api_key)
         → 仅使用 active 配置，缺少必需项则报错
      2. 完全没有 active 配置 → 允许 fallback 到 legacy per-provider key
      3. Ollama 特殊路径：不需要 API Key

    返回: (client, model_name)
    """
    settings = get_settings()
    # openai imports hundreds of generated schema modules. Keep that ~1.2s
    # cost off the desktop cold-start path and pay it only for the first LLM call.
    from openai import AsyncOpenAI
    provider = (settings.llm_provider or "deepseek").strip().lower()
    model = settings.llm_model
    active_base_url = (settings.active_llm_base_url or "").strip().rstrip("/")
    active_api_key = (settings.active_llm_api_key or "").strip()
    active_config_id = (settings.active_llm_config_id or "").strip()
    http_client = _make_http_client()

    # Ollama 特殊处理：确保 /v1 后缀，使用占位 key
    if provider == "ollama":
        base_url = active_base_url or settings.ollama_base_url
        client = AsyncOpenAI(
            api_key="ollama",
            base_url=_ensure_ollama_v1(base_url),
            http_client=http_client,
        )
        _logger.info("[LLM Config] source=ollama, base_url=%s, model=%s", base_url, model)
        return client, model

    # 判断是否存在激活配置
    has_active_selection = bool(active_config_id or active_base_url or active_api_key)

    if has_active_selection:
        # ── 路径 A：存在激活配置，严格使用 active 字段，不做隐式 fallback ──
        api_key = active_api_key
        base_url = active_base_url

        if not api_key:
            raise ValueError(
                f"当前激活的 LLM 配置缺少 API Key（provider={provider}）。"
                f"请在设置页面填写，或切换到其他配置。"
            )

        if not base_url:
            # active 配置允许从 preset 补充默认 base_url
            base_url = DEFAULT_BASE_URLS.get(provider, "")

        if not base_url:
            raise ValueError(
                f"当前激活的 LLM 配置缺少 Base URL（provider={provider}）。"
                f"请在设置页面填写完整信息。"
            )

        _logger.info("[LLM Config] source=active_config, provider=%s, model=%s", provider, model)
    else:
        # ── 路径 B：完全没有 active 配置，回退到 legacy per-provider key ──
        legacy_keys = {
            "deepseek": settings.deepseek_api_key,
            "openai": settings.openai_api_key,
            "qwen": settings.qwen_api_key,
            "siliconflow": settings.siliconflow_api_key,
            "gemini": settings.gemini_api_key,
            "zhipu": settings.zhipu_api_key,
        }
        api_key = legacy_keys.get(provider, "")
        base_url = DEFAULT_BASE_URLS.get(provider, "")

        if not api_key:
            raise ValueError(f"LLM API Key 未配置（provider={provider}），请在设置页面填写")

        if not base_url:
            raise ValueError(f"LLM Base URL 未配置（provider={provider}），请在设置页面填写")

        _logger.info("[LLM Config] source=legacy_fallback, provider=%s, model=%s", provider, model)

    client = AsyncOpenAI(
        api_key=api_key,
        base_url=base_url,
        http_client=http_client,
    )

    return client, model


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
    client, default_model = _get_client()

    # 用户配置的模型始终优先，tier 映射仅作为 fallback
    # 如需分档，在设置中配置 tier_model_map 即可覆盖
    settings = get_settings()
    provider = (settings.llm_provider or "deepseek").strip().lower()
    user_tier_map = getattr(settings, "tier_model_map", None) or {}
    if user_tier_map:
        model = user_tier_map.get(tier, default_model)
    else:
        model = default_model

    kwargs: dict = {
        "model": model,
        "messages": messages,
        "temperature": temperature,
        "max_tokens": max_tokens,
    }

    # JSON mode — OpenAI / DeepSeek / Qwen 默认支持 response_format
    # Ollama 兼容实现不稳定，默认关闭
    if json_mode and settings.llm_provider != "ollama":
        kwargs["response_format"] = {"type": "json_object"}

    try:
        response = await asyncio.wait_for(
            client.chat.completions.create(**kwargs),
            timeout=settings.llm_timeout,
        )
        return response.choices[0].message.content
    except asyncio.TimeoutError:
        _logger.error(f"[LLM Timeout] {provider}/{model} (tier={tier}): 超过 {settings.llm_timeout}s")
        return None
    except Exception as e:
        _logger.error(f"[LLM Error] {provider}/{model} (tier={tier}): {e}")
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
    client, default_model = _get_client()

    settings = get_settings()
    provider = (settings.llm_provider or "deepseek").strip().lower()
    user_tier_map = getattr(settings, "tier_model_map", None) or {}
    if user_tier_map:
        model = user_tier_map.get(tier, default_model)
    else:
        model = default_model

    kwargs: dict = {
        "model": model,
        "messages": messages,
        "temperature": temperature,
        "max_tokens": max_tokens,
        "stream": True,
    }

    if json_mode and settings.llm_provider != "ollama":
        kwargs["response_format"] = {"type": "json_object"}

    try:
        stream = await client.chat.completions.create(**kwargs)
        async for chunk in stream:
            delta = chunk.choices[0].delta if chunk.choices else None
            if delta and delta.content:
                yield delta.content
    except asyncio.TimeoutError:
        _logger.error(f"[LLM Timeout] {provider}/{model} (tier={tier}, stream): 超过 {settings.llm_timeout}s")
        return
    except Exception as e:
        _logger.error(f"[LLM Error] {provider}/{model} (tier={tier}, stream): {e}")
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
        _logger.error(f"[Embedding Error] model={model}: {e}")
        return [0.0] * 1024
