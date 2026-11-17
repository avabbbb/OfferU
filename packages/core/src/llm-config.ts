// BYOK LLM config resolution — port of backend/app/agents/llm.py
// resolve_llm_client_config / resolve_model_for_tier. Pure: the caller hands
// in the settings object (Python config.json shape, or the browser's own copy)
// and, optionally, an env lookup for `env:VAR` key references.

import { CoreError } from "./types";
import type { LlmApiFormat, LlmEndpoint, LlmTier } from "./llm";
import { providerDefaultModel, providerDefaultUrl, providerTierModels } from "./llm-presets";


/** One entry of config.json llm_api_configs. */
export interface LlmApiConfig {
  id?: string;
  provider_id?: string;
  service_name?: string;
  base_url?: string;
  api_key?: string;
  model?: string;
  api_format?: string;
  supports_json_mode?: boolean | string | null;
  default_headers?: Record<string, string>;
  models?: Partial<Record<LlmTier, string>>;
  is_active?: boolean;
  [key: string]: unknown;
}

/** The LLM fields of config.json (llm_config_store._LLM_RUNTIME_FIELDS). */
export interface LlmSettings {
  llm_provider?: string;
  llm_model?: string;
  llm_api_configs?: LlmApiConfig[];
  active_llm_config_id?: string;
  active_llm_base_url?: string;
  active_llm_api_key?: string;
  tier_model_map?: Partial<Record<LlmTier, string>>;
  disabled_llm_providers?: string[];
  ollama_base_url?: string;
  deepseek_api_key?: string;
  openai_api_key?: string;
  qwen_api_key?: string;
  siliconflow_api_key?: string;
  gemini_api_key?: string;
  zhipu_api_key?: string;
  [key: string]: unknown;
}

export interface ResolvedLlmConfig {
  base_url: string;
  api_key: string;
  model: string;
  provider: string;
  service_name: string;
  source: "active_config" | "ollama" | "legacy_fallback";
  supports_json_mode: boolean;
  default_headers: Record<string, string>;
  models: Partial<Record<LlmTier, string>>;
  api_format: LlmApiFormat;
}

export interface ResolveOptions {
  /** RunOptions.llm_config_id: the composer's per-run model choice. */
  llmConfigId?: string;
  env?: (name: string) => string | undefined;
}

function cfgBool(value: unknown, fallback = true): boolean {
  if (value === null || value === undefined) return fallback;
  if (typeof value === "boolean") return value;
  return ["1", "true", "yes", "on"].includes(String(value).trim().toLowerCase());
}

export function isLocalLlm(baseUrl: string): boolean {
  let host = "";
  try {
    host = new URL(String(baseUrl || "").trim()).hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return false;
  }
  if (host === "localhost") return true;
  if (host === "[::1]" || host === "::1") return true;
  return /^127\.\d+\.\d+\.\d+$/.test(host);
}

function ensureOllamaV1(baseUrl: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  return base.endsWith("/v1") ? base : `${base}/v1`;
}

export function activeProviderConfig(settings: LlmSettings, llmConfigId = ""): LlmApiConfig | null {
  const configs = Array.isArray(settings.llm_api_configs) ? settings.llm_api_configs : [];
  const isCfg = (cfg: unknown): cfg is LlmApiConfig => Boolean(cfg) && typeof cfg === "object" && !Array.isArray(cfg);
  if (llmConfigId) {
    const chosen = configs.find((cfg) => isCfg(cfg) && String(cfg.id || "") === llmConfigId);
    if (chosen) return chosen;
  }
  const activeId = String(settings.active_llm_config_id || "").trim();
  if (activeId) {
    const active = configs.find((cfg) => isCfg(cfg) && String(cfg.id || "") === activeId);
    if (active) return active;
  }
  const flagged = configs.find((cfg) => isCfg(cfg) && cfg.is_active);
  if (flagged) return flagged;
  return configs.length === 1 && isCfg(configs[0]) ? configs[0] : null;
}

/** llm_config_store.resolve_api_key: `env:NAME` → the env value; anything else as is. */
export function resolveApiKey(raw: string, env?: (name: string) => string | undefined): string {
  const value = String(raw || "").trim();
  if (value.toLowerCase().startsWith("env:")) return String(env?.(value.slice(4).trim()) || "").trim();
  return value;
}

export function resolveLlmClientConfig(settings: LlmSettings, options: ResolveOptions = {}): ResolvedLlmConfig {
  const active = activeProviderConfig(settings, options.llmConfigId);
  const legacyBase = String(settings.active_llm_base_url || "").trim().replace(/\/+$/, "");
  const legacyKey = String(settings.active_llm_api_key || "").trim();
  const defaultModel = String(settings.llm_model || "").trim();
  let providerId: string;
  let serviceName: string;
  let baseUrl: string;
  let apiKey: string;
  let model: string;
  let apiFormat: string = "openai";
  let supportsJson: boolean;
  let headers: Record<string, string> = {};
  let models: Partial<Record<LlmTier, string>> = {};
  let source: ResolvedLlmConfig["source"];

  if (active) {
    providerId = String(active.provider_id || active.service_name || "custom").trim().toLowerCase() || "custom";
    serviceName = String(active.service_name || providerId);
    baseUrl = String(active.base_url || "").trim().replace(/\/+$/, "");
    apiKey = String(active.api_key || "").trim();
    model = String(active.model || defaultModel).trim();
    apiFormat = String(active.api_format || "openai").trim().toLowerCase();
    supportsJson = cfgBool(active.supports_json_mode, true);
    headers = active.default_headers && typeof active.default_headers === "object" ? { ...active.default_headers } : {};
    models = active.models && typeof active.models === "object" ? { ...active.models } : {};
    source = "active_config";
    if (!baseUrl) throw new CoreError(`当前激活的 LLM 配置缺少 Base URL（${serviceName}）。请在设置页面填写完整信息。`, "invalid");
    if (apiFormat !== "openai" && apiFormat !== "anthropic") throw new CoreError(`暂不支持的 API 协议 ${apiFormat}（${serviceName}）。`, "invalid");
    if (!apiKey && !isLocalLlm(baseUrl)) throw new CoreError(`当前激活的 LLM 配置缺少 API Key（${serviceName}）。请在设置页面填写。`, "invalid");
    if (isLocalLlm(baseUrl)) {
      apiKey = apiKey || "local";
      if (providerId === "ollama") source = "ollama";
    }
    if (!model) throw new CoreError(`当前激活的 LLM 配置缺少模型名称（${serviceName}）。`, "invalid");
  } else if (legacyBase && legacyKey) {
    providerId = String(settings.llm_provider || "custom").trim().toLowerCase() || "custom";
    serviceName = providerId;
    baseUrl = legacyBase;
    apiKey = legacyKey;
    model = defaultModel;
    supportsJson = !isLocalLlm(baseUrl);
    source = "active_config";
  } else {
    const provider = String(settings.llm_provider || "").trim().toLowerCase();
    if (!provider) throw new CoreError("还没有配置模型服务，请先在设置里添加一个。", "invalid");
    providerId = provider;
    serviceName = provider;
    model = defaultModel;
    if (provider === "ollama") {
      baseUrl = ensureOllamaV1(String(settings.ollama_base_url || "").trim() || "http://localhost:11434");
      apiKey = "ollama";
      supportsJson = false;
      source = "ollama";
    } else {
      const legacyKeys: Record<string, unknown> = {
        deepseek: settings.deepseek_api_key, openai: settings.openai_api_key, qwen: settings.qwen_api_key,
        siliconflow: settings.siliconflow_api_key, gemini: settings.gemini_api_key, zhipu: settings.zhipu_api_key,
      };
      apiKey = String(legacyKeys[provider] || "").trim();
      baseUrl = providerDefaultUrl(provider);
      supportsJson = true;
      source = "legacy_fallback";
      if (!apiKey) throw new CoreError(`LLM API Key 未配置（provider=${provider}），请在设置页面填写`, "invalid");
      if (!baseUrl) throw new CoreError(`LLM Base URL 未配置（provider=${provider}），请在设置页面填写`, "invalid");
    }
  }

  const resolvedKey = resolveApiKey(apiKey, options.env);
  if (apiKey.trim().toLowerCase().startsWith("env:") && !resolvedKey) throw new CoreError(`LLM API Key 环境变量未解析（${serviceName}）。`, "invalid");
  if (!resolvedKey && !isLocalLlm(baseUrl)) throw new CoreError(`当前激活的 LLM 配置缺少 API Key（${serviceName}）。请在设置页面填写。`, "invalid");
  const disabled = new Set(Array.isArray(settings.disabled_llm_providers) ? settings.disabled_llm_providers : []);
  if (disabled.has(providerId)) throw new CoreError(`LLM provider「${serviceName}」已被禁用，请在设置中启用后再使用`, "forbidden");

  return {
    base_url: baseUrl, api_key: resolvedKey, model, provider: providerId, service_name: serviceName, source,
    supports_json_mode: supportsJson, default_headers: headers, models, api_format: apiFormat as LlmApiFormat,
  };
}

/** Tier → model: provider config models → global tier_model_map → config model → legacy preset tiers. */
export function resolveModelForTier(settings: LlmSettings, tier: LlmTier = "standard", options: ResolveOptions = {}): string {
  const active = activeProviderConfig(settings, options.llmConfigId);
  const models = active?.models && typeof active.models === "object" ? active.models : {};
  if (models[tier]) return String(models[tier]);
  const tierMap = settings.tier_model_map || {};
  if (tierMap[tier]) return String(tierMap[tier]);
  if (active && String(active.model || "").trim()) return String(active.model).trim();
  const configured = String(settings.llm_model || "").trim();
  const providerId = String(settings.llm_provider || "");
  if (configured && configured !== providerDefaultModel(providerId)) return configured;
  const legacy = providerTierModels(providerId);
  if (legacy[tier]) return legacy[tier];
  return configured;
}

/** Settings → a ready LlmEndpoint for createLlmClient. */
export function endpointFromSettings(settings: LlmSettings, tier: LlmTier = "standard", options: ResolveOptions = {}): LlmEndpoint {
  const resolved = resolveLlmClientConfig(settings, options);
  return {
    provider: resolved.provider,
    baseUrl: resolved.base_url,
    apiKey: resolved.api_key,
    model: resolveModelForTier(settings, tier, options) || resolved.model,
    apiFormat: resolved.api_format,
    supportsJsonMode: resolved.supports_json_mode,
    headers: resolved.default_headers,
    models: {
      fast: resolveModelForTier(settings, "fast", options) || undefined,
      standard: resolveModelForTier(settings, "standard", options) || undefined,
      premium: resolveModelForTier(settings, "premium", options) || undefined,
    },
  };
}
