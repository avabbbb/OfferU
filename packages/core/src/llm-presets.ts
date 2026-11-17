// LLM provider presets — data copy of backend/app/llm_presets.py (cc-switch style,
// data-driven: ids are identity slugs only, never behaviour branches).
// Keep in sync with the Python file until it is deleted; test/llm.test.ts pins it.

export interface LlmPresetModel { id: string; name: string; description: string }
export interface LlmProviderPreset {
  id: string;
  name: string;
  description: string;
  default_base_url: string;
  website_url: string;
  icon: string;
  tiers: Partial<Record<"fast" | "standard" | "premium", string>>;
  models: LlmPresetModel[];
  key_prefix: string;
}
export interface EndpointProtocolTemplate { id: string; name: string; description: string; api_format: "openai" | "anthropic" }

export const ENDPOINT_PROTOCOL_TEMPLATES: EndpointProtocolTemplate[] = [
  {
    "id": "openai-compatible",
    "name": "OpenAI-compatible",
    "description": "OpenAI-compatible endpoint with a custom service name, URL, and model ID.",
    "api_format": "openai"
  },
  {
    "id": "anthropic-compatible",
    "name": "Anthropic-compatible",
    "description": "Anthropic Messages endpoint with a custom service name, URL, and model ID.",
    "api_format": "anthropic"
  }
];

export const PROVIDER_PRESETS: LlmProviderPreset[] = [
  {
    "id": "deepseek",
    "name": "DeepSeek",
    "description": "Cost-effective Chinese/English model",
    "default_base_url": "https://api.deepseek.com",
    "website_url": "https://platform.deepseek.com",
    "icon": "deepseek",
    "tiers": {
      "fast": "deepseek-v4-flash",
      "standard": "deepseek-v4-flash",
      "premium": "deepseek-v4-pro"
    },
    "models": [
      {
        "id": "deepseek-v4-flash",
        "name": "DeepSeek V4 Flash",
        "description": "Current fast non-thinking model"
      },
      {
        "id": "deepseek-v4-pro",
        "name": "DeepSeek V4 Pro",
        "description": "Current high-quality reasoning model"
      },
      {
        "id": "deepseek-chat",
        "name": "DeepSeek Chat (deprecated 2026-07-24)",
        "description": "Legacy alias for DeepSeek V4 Flash"
      },
      {
        "id": "deepseek-reasoner",
        "name": "DeepSeek Reasoner (deprecated 2026-07-24)",
        "description": "Legacy alias for DeepSeek V4 reasoning mode"
      }
    ],
    "key_prefix": "sk-"
  },
  {
    "id": "openai",
    "name": "OpenAI",
    "description": "Mainstream global provider",
    "default_base_url": "https://api.openai.com/v1",
    "website_url": "https://platform.openai.com",
    "icon": "openai",
    "tiers": {
      "fast": "gpt-4o-mini",
      "standard": "gpt-4.1",
      "premium": "gpt-4.1"
    },
    "models": [
      {
        "id": "gpt-4.1-mini",
        "name": "GPT-4.1 Mini",
        "description": "Balanced speed and quality"
      },
      {
        "id": "gpt-4o-mini",
        "name": "GPT-4o Mini",
        "description": "Fast multimodal model"
      },
      {
        "id": "gpt-4.1",
        "name": "GPT-4.1",
        "description": "High quality general model"
      }
    ],
    "key_prefix": "sk-"
  },
  {
    "id": "qwen",
    "name": "Qwen",
    "description": "Alibaba DashScope OpenAI-compatible API",
    "default_base_url": "https://dashscope.aliyuncs.com/compatible-mode/v1",
    "website_url": "https://bailian.console.aliyun.com",
    "icon": "qwen",
    "tiers": {
      "fast": "qwen-flash",
      "standard": "qwen3.5-plus",
      "premium": "qwen3.6-plus"
    },
    "models": [
      {
        "id": "qwen-flash",
        "name": "Qwen Flash",
        "description": "Ultra-fast, lowest cost (tier=fast)"
      },
      {
        "id": "qwen3.5-plus",
        "name": "Qwen3.5 Plus",
        "description": "Balanced quality and speed (tier=standard/premium)"
      },
      {
        "id": "qwen3.6-plus",
        "name": "Qwen3.6 Plus",
        "description": "Best reasoning quality (tier=premium)"
      },
      {
        "id": "qwen3.5-flash",
        "name": "Qwen3.5 Flash",
        "description": "Fast with good quality"
      }
    ],
    "key_prefix": "sk-"
  },
  {
    "id": "siliconflow",
    "name": "SiliconFlow",
    "description": "Aggregated open model inference",
    "default_base_url": "https://api.siliconflow.com/v1",
    "website_url": "https://siliconflow.cn",
    "icon": "siliconflow",
    "tiers": {
      "fast": "deepseek-ai/DeepSeek-V3.2",
      "standard": "Qwen/Qwen3-32B",
      "premium": "zai-org/GLM-4.5"
    },
    "models": [
      {
        "id": "deepseek-ai/DeepSeek-V3.2",
        "name": "DeepSeek-V3.2",
        "description": "Popular coding and writing model"
      },
      {
        "id": "Qwen/Qwen3-32B",
        "name": "Qwen3-32B",
        "description": "Strong Chinese performance"
      },
      {
        "id": "zai-org/GLM-4.5",
        "name": "GLM-4.5",
        "description": "General purpose option"
      }
    ],
    "key_prefix": "sk-"
  },
  {
    "id": "gemini",
    "name": "Google Gemini",
    "description": "Gemini via OpenAI-compatible endpoint",
    "default_base_url": "https://generativelanguage.googleapis.com/v1beta/openai",
    "website_url": "https://ai.google.dev",
    "icon": "gemini",
    "tiers": {
      "fast": "gemini-2.5-flash",
      "standard": "gemini-2.5-pro",
      "premium": "gemini-2.5-pro"
    },
    "models": [
      {
        "id": "gemini-2.5-flash",
        "name": "Gemini 2.5 Flash",
        "description": "Fast and low-cost"
      },
      {
        "id": "gemini-2.5-pro",
        "name": "Gemini 2.5 Pro",
        "description": "High quality reasoning"
      }
    ],
    "key_prefix": ""
  },
  {
    "id": "zhipu",
    "name": "智谱",
    "description": "BigModel Open Platform",
    "default_base_url": "https://open.bigmodel.cn/api/paas/v4",
    "website_url": "https://open.bigmodel.cn",
    "icon": "zhipu",
    "tiers": {
      "fast": "glm-4-flash",
      "standard": "glm-5.1",
      "premium": "glm-5.1"
    },
    "models": [
      {
        "id": "glm-5.1",
        "name": "GLM-5.1",
        "description": "Latest flagship"
      },
      {
        "id": "glm-4.6",
        "name": "GLM-4.6",
        "description": "Stable general model"
      },
      {
        "id": "glm-4-plus",
        "name": "GLM-4-Plus",
        "description": "Legacy high-quality model"
      }
    ],
    "key_prefix": ""
  },
  {
    "id": "moonshot",
    "name": "Moonshot (Kimi)",
    "description": "Kimi 官方 OpenAI 兼容接口",
    "default_base_url": "https://api.moonshot.cn/v1",
    "website_url": "https://platform.moonshot.cn",
    "icon": "moonshot",
    "tiers": {
      "fast": "kimi-k2-turbo-preview",
      "standard": "kimi-k2",
      "premium": "kimi-k2"
    },
    "models": [
      {
        "id": "kimi-k2",
        "name": "Kimi K2",
        "description": "Latest flagship long-context model"
      },
      {
        "id": "kimi-k2-turbo-preview",
        "name": "Kimi K2 Turbo Preview",
        "description": "Fast reasoning preview"
      },
      {
        "id": "moonshot-v1-32k",
        "name": "Moonshot V1 32K",
        "description": "Stable long-context model"
      }
    ],
    "key_prefix": "sk-"
  },
  {
    "id": "groq",
    "name": "Groq",
    "description": "Ultra-low-latency inference",
    "default_base_url": "https://api.groq.com/openai/v1",
    "website_url": "https://console.groq.com",
    "icon": "groq",
    "tiers": {
      "fast": "llama-3.3-70b-versatile",
      "standard": "llama-3.3-70b-versatile",
      "premium": "llama-3.1-70b-versatile"
    },
    "models": [
      {
        "id": "llama-3.3-70b-versatile",
        "name": "Llama 3.3 70B Versatile",
        "description": "General purpose"
      },
      {
        "id": "llama-3.1-8b-instant",
        "name": "Llama 3.1 8B Instant",
        "description": "Fast and light"
      }
    ],
    "key_prefix": ""
  },
  {
    "id": "openrouter",
    "name": "OpenRouter",
    "description": "Unified gateway to 300+ models",
    "default_base_url": "https://openrouter.ai/api/v1",
    "website_url": "https://openrouter.ai",
    "icon": "openrouter",
    "tiers": {
      "fast": "meta-llama/llama-3.3-70b-instruct",
      "standard": "openai/gpt-4o",
      "premium": "anthropic/claude-3.5-sonnet"
    },
    "models": [
      {
        "id": "openai/gpt-4o",
        "name": "GPT-4o",
        "description": "Balanced general model"
      },
      {
        "id": "anthropic/claude-3.5-sonnet",
        "name": "Claude 3.5 Sonnet",
        "description": "High quality reasoning"
      },
      {
        "id": "meta-llama/llama-3.3-70b-instruct",
        "name": "Llama 3.3 70B",
        "description": "Strong open model"
      }
    ],
    "key_prefix": "sk-or-"
  },
  {
    "id": "ollama",
    "name": "Ollama",
    "description": "Local open-source inference",
    "default_base_url": "http://localhost:11434/v1",
    "website_url": "https://ollama.com",
    "icon": "ollama",
    "tiers": {
      "fast": "qwen2.5:7b",
      "standard": "qwen2.5:7b",
      "premium": "qwen2.5:14b"
    },
    "models": [
      {
        "id": "qwen2.5:7b",
        "name": "Qwen2.5 7B",
        "description": "Good Chinese local model"
      },
      {
        "id": "llama3.1:8b",
        "name": "Llama 3.1 8B",
        "description": "General open model"
      },
      {
        "id": "gemma2:9b",
        "name": "Gemma2 9B",
        "description": "Google open model"
      }
    ],
    "key_prefix": ""
  },
  {
    "id": "custom",
    "name": "自定义 (OpenAI 兼容)",
    "description": "Any OpenAI-compatible API endpoint (e.g. Groq, Mistral, Together, Azure OpenAI, LM Studio, vLLM, etc.)",
    "default_base_url": "",
    "website_url": "",
    "icon": "custom",
    "tiers": {},
    "models": [],
    "key_prefix": ""
  }
];

const BY_ID = new Map(PROVIDER_PRESETS.map((preset) => [preset.id, preset]));

export function providerPreset(id: string): LlmProviderPreset | undefined {
  return BY_ID.get(id);
}

export function providerName(id: string): string {
  return BY_ID.get(id)?.name ?? id;
}

export function providerDefaultUrl(id: string): string {
  return (BY_ID.get(id)?.default_base_url ?? "").trim().replace(/\/+$/, "");
}

export function providerDefaultModel(id: string): string {
  return (BY_ID.get(id)?.models[0]?.id ?? "").trim();
}

/** fast / standard / premium model ids from the preset; {} when unknown. */
export function providerTierModels(id: string): Record<string, string> {
  const tiers = BY_ID.get(id)?.tiers ?? {};
  return Object.fromEntries(Object.entries(tiers).filter(([, model]) => Boolean(model))) as Record<string, string>;
}

export const AVAILABLE_PROVIDERS = PROVIDER_PRESETS.map((preset) => ({
  id: preset.id,
  name: preset.name,
  description: preset.description,
  models: preset.models.map((model) => ({ id: model.id, name: model.name, description: model.description || "" })),
}));
