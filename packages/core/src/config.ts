// /api/config rules — port of the LLM part of backend/app/routes/config.py.
// Pure: the adapter loads/saves the stored object (browser IndexedDB, a JSON
// file on the companion) and hands it in. Keys are stored as given; every
// response masks them. Out of scope here: the OS keychain (credential_ref is
// kept as an opaque field), one-click provider import, SSRF DNS checks (the
// browser cannot resolve; the companion rejects private hosts by literal).

import { CoreError } from "./types";
import type { LlmApiConfig, LlmSettings } from "./llm-config";
import { ENDPOINT_PROTOCOL_TEMPLATES, providerDefaultModel, providerDefaultUrl, providerName, providerTierModels } from "./llm-presets";
import type { HttpFetch } from "./tools/net";

/** What an adapter persists. Same field names as Python config.json. */
export interface StoredConfig extends LlmSettings {
  llm_provider: string;
  llm_model: string;
  llm_api_configs: StoredLlmApiConfig[];
  active_llm_config_id: string;
  active_llm_base_url: string;
  active_llm_api_key: string;
  tier_model_map: Record<string, string>;
  disabled_llm_providers: string[];
  ollama_base_url: string;
  ssl_verify: boolean;
  llm_timeout: number;
  max_concurrent_agent_runs: number;
  llm_fallback_to_agent: boolean;
}

export interface StoredLlmApiConfig extends LlmApiConfig {
  id: string;
  provider_id: string;
  service_name: string;
  model: string;
  base_url: string;
  api_key: string;
  credential_ref: string;
  is_active: boolean;
  extra_params: Record<string, string>;
  models: Record<string, string>;
  api_format: "openai" | "anthropic";
  supports_json_mode: boolean;
  default_headers: Record<string, string>;
  icon: string;
  website_url: string;
  notes: string;
}

/** Load/save the stored config; the adapter owns where (and how safely) it lives. */
export interface ConfigStore {
  load(): Promise<Partial<StoredConfig> | null>;
  save(config: StoredConfig): Promise<void>;
}

const LEGACY_KEY_FIELDS = ["deepseek_api_key", "openai_api_key", "qwen_api_key", "siliconflow_api_key", "gemini_api_key", "zhipu_api_key"] as const;
const LEGACY_PROVIDERS = ["deepseek", "openai", "qwen", "siliconflow", "gemini", "zhipu"] as const;
const DEFAULT_OLLAMA = "http://localhost:11434";
const PLACEHOLDER_KEYS = new Set([
  "sk-your-openai-key-here", "your-openai-api-key", "your-deepseek-api-key", "your-gemini-api-key",
  "your-api-key", "replace-with-your-api-key", "api-key-here", "sk-your-key",
]);

const str = (value: unknown): string => (typeof value === "string" ? value : value === null || value === undefined ? "" : String(value));
const strMap = (value: unknown): Record<string, string> => (value && typeof value === "object" && !Array.isArray(value)
  ? Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, str(v)]))
  : {});
const newId = (): string => {
  const cryptoApi = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  return cryptoApi?.randomUUID ? cryptoApi.randomUUID().replace(/-/g, "") : Math.random().toString(16).slice(2) + Date.now().toString(16);
};

export function normalizeProviderId(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "custom";
}

export function maskKey(key: string): string {
  if (!key) return "";
  if (/^env:/i.test(key)) return key;
  if (key.length <= 8) return "*".repeat(key.length);
  return `${key.slice(0, 4)}${"*".repeat(key.length - 8)}${key.slice(-4)}`;
}

export function sanitizeApiKey(raw: unknown): string {
  const value = str(raw).trim();
  if (!value) return "";
  if (/^env:/i.test(value)) return value;
  const lowered = value.toLowerCase();
  if (value.includes("*") || PLACEHOLDER_KEYS.has(lowered)) return "";
  if (lowered.includes("your") && lowered.includes("key")) return "";
  if (lowered.startsWith("sk-your-")) return "";
  return value;
}

export function defaultConfig(): StoredConfig {
  return {
    llm_provider: "", llm_model: "",
    deepseek_api_key: "", openai_api_key: "", qwen_api_key: "", siliconflow_api_key: "", gemini_api_key: "", zhipu_api_key: "",
    ollama_base_url: DEFAULT_OLLAMA,
    llm_api_configs: [], active_llm_config_id: "", active_llm_base_url: "", active_llm_api_key: "",
    tier_model_map: {}, disabled_llm_providers: [],
    ssl_verify: true, llm_timeout: 60, max_concurrent_agent_runs: 3, llm_fallback_to_agent: false,
  };
}

function entry(raw: Partial<StoredLlmApiConfig>): StoredLlmApiConfig {
  const providerId = normalizeProviderId(str(raw.provider_id) || str(raw.service_name));
  const apiFormat = str(raw.api_format || "openai").trim().toLowerCase();
  if (apiFormat !== "openai" && apiFormat !== "anthropic") throw new CoreError(`不支持的 API 协议: ${apiFormat}`, "invalid");
  return {
    id: str(raw.id) || newId(),
    provider_id: providerId,
    service_name: (str(raw.service_name) || providerName(providerId)).trim(),
    model: (str(raw.model) || providerDefaultModel(providerId)).trim(),
    base_url: (str(raw.base_url) || providerDefaultUrl(providerId)).trim().replace(/\/+$/, ""),
    api_key: sanitizeApiKey(raw.api_key),
    credential_ref: str(raw.credential_ref),
    is_active: Boolean(raw.is_active),
    extra_params: strMap(raw.extra_params),
    models: strMap(raw.models),
    api_format: apiFormat,
    supports_json_mode: raw.supports_json_mode === undefined || raw.supports_json_mode === null ? true : Boolean(raw.supports_json_mode),
    default_headers: strMap(raw.default_headers),
    icon: str(raw.icon), website_url: str(raw.website_url), notes: str(raw.notes),
  };
}

function upsertProvider(configs: StoredLlmApiConfig[], providerId: string, fields: { service_name?: string; model?: string; base_url?: string; api_key?: string }): StoredLlmApiConfig {
  const target = configs.find((cfg) => cfg.provider_id === providerId);
  if (!target) {
    const created = entry({
      provider_id: providerId,
      service_name: fields.service_name || providerName(providerId),
      model: fields.model || providerDefaultModel(providerId),
      base_url: fields.base_url || providerDefaultUrl(providerId),
      api_key: fields.api_key || "",
      models: providerTierModels(providerId),
    });
    configs.push(created);
    return created;
  }
  if (fields.service_name !== undefined) target.service_name = fields.service_name;
  if (fields.model !== undefined) target.model = fields.model;
  if (fields.base_url !== undefined) target.base_url = fields.base_url.replace(/\/+$/, "");
  if (fields.api_key !== undefined) target.api_key = fields.api_key;
  return target;
}

/** _normalize_llm_state: clean every entry, pick exactly one active, mirror legacy fields. */
export function normalizeConfig(raw: Partial<StoredConfig> | null | undefined): StoredConfig {
  const base = defaultConfig();
  const cfg: StoredConfig = { ...base, ...(raw ?? {}) } as StoredConfig;
  cfg.tier_model_map = strMap(cfg.tier_model_map);
  cfg.disabled_llm_providers = Array.isArray(cfg.disabled_llm_providers) ? cfg.disabled_llm_providers.map(str) : [];
  cfg.ssl_verify = cfg.ssl_verify !== false;
  cfg.llm_timeout = Number(cfg.llm_timeout) || 60;
  cfg.max_concurrent_agent_runs = Math.min(10, Math.max(1, Math.trunc(Number(cfg.max_concurrent_agent_runs) || 3)));
  cfg.llm_fallback_to_agent = Boolean(cfg.llm_fallback_to_agent);
  cfg.llm_api_configs = (Array.isArray(cfg.llm_api_configs) ? cfg.llm_api_configs : []).map((item) => entry(item ?? {}));

  const active = (cfg.active_llm_config_id && cfg.llm_api_configs.find((item) => item.id === cfg.active_llm_config_id))
    || cfg.llm_api_configs.find((item) => item.is_active)
    || cfg.llm_api_configs[0];
  for (const item of cfg.llm_api_configs) item.is_active = Boolean(active && item.id === active.id);
  if (active) {
    cfg.llm_provider = active.provider_id;
    cfg.llm_model = active.model;
    cfg.active_llm_config_id = active.id;
    cfg.active_llm_base_url = active.base_url;
    cfg.active_llm_api_key = active.api_key;
  } else {
    cfg.active_llm_config_id = "";
    cfg.active_llm_base_url = "";
    cfg.active_llm_api_key = "";
  }
  LEGACY_PROVIDERS.forEach((provider, index) => {
    const found = cfg.llm_api_configs.find((item) => item.provider_id === provider);
    (cfg as Record<string, unknown>)[LEGACY_KEY_FIELDS[index]] = found ? found.api_key : "";
  });
  const ollama = cfg.llm_api_configs.find((item) => item.provider_id === "ollama");
  cfg.ollama_base_url = ollama?.base_url ? ollama.base_url.replace(/\/v1$/, "") : DEFAULT_OLLAMA;
  return cfg;
}

/**
 * PUT /api/config/: merge a (possibly partial) update. Masked keys ("sk-a****wxyz")
 * coming back from the settings page are restored from the current config by entry
 * id; legacy single-provider fields still work (onboarding sends deepseek_api_key).
 */
export function applyConfigUpdate(current: StoredConfig, patch: Record<string, unknown>): StoredConfig {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new CoreError("配置必须是对象", "invalid");
  const fields = new Set(Object.keys(patch));
  const next = { ...JSON.parse(JSON.stringify(current)), ...JSON.parse(JSON.stringify(patch)) } as StoredConfig;

  for (const field of [...LEGACY_KEY_FIELDS, "active_llm_api_key"] as const) {
    if (fields.has(field) && str(next[field]).includes("*")) (next as Record<string, unknown>)[field] = current[field];
  }
  if (fields.has("llm_api_configs")) {
    if (!Array.isArray(next.llm_api_configs)) throw new CoreError("llm_api_configs 必须是数组", "invalid");
    const byId = new Map(current.llm_api_configs.map((item) => [item.id, item]));
    next.llm_api_configs = next.llm_api_configs.map((raw) => {
      const item = { ...(raw ?? {}) } as StoredLlmApiConfig;
      const previous = byId.get(str(item.id));
      if (str(item.api_key).includes("*")) item.api_key = previous ? previous.api_key : "";
      if (previous && item.default_headers && typeof item.default_headers === "object") {
        item.default_headers = Object.fromEntries(Object.entries(item.default_headers).map(([key, value]) =>
          [key, str(value).includes("[redacted]") ? previous.default_headers[key] ?? str(value) : str(value)]));
      }
      return item;
    });
  } else {
    next.llm_api_configs = next.llm_api_configs.map((item) => entry(item));
    LEGACY_PROVIDERS.forEach((provider, index) => {
      if (fields.has(LEGACY_KEY_FIELDS[index])) {
        upsertProvider(next.llm_api_configs, provider, {
          service_name: providerName(provider), model: providerDefaultModel(provider), base_url: providerDefaultUrl(provider),
          api_key: sanitizeApiKey(next[LEGACY_KEY_FIELDS[index]]),
        });
      }
    });
    if (fields.has("llm_provider") || fields.has("llm_model")) {
      const providerId = normalizeProviderId(str(next.llm_provider) || "deepseek");
      const legacyIndex = (LEGACY_PROVIDERS as readonly string[]).indexOf(providerId);
      const ollama = providerId === "ollama";
      const target = upsertProvider(next.llm_api_configs, providerId, {
        service_name: providerName(providerId),
        model: str(next.llm_model) || providerDefaultModel(providerId),
        base_url: ollama ? `${(str(next.ollama_base_url) || DEFAULT_OLLAMA).replace(/\/+$/, "")}/v1` : str(next.active_llm_base_url) || providerDefaultUrl(providerId),
        api_key: ollama ? "" : sanitizeApiKey(legacyIndex >= 0 ? next[LEGACY_KEY_FIELDS[legacyIndex]] : next.active_llm_api_key),
      });
      next.active_llm_config_id = target.id;
    }
  }
  if (fields.has("active_llm_config_id") && next.active_llm_config_id) {
    for (const item of next.llm_api_configs) item.is_active = item.id === next.active_llm_config_id;
  }
  return normalizeConfig(next);
}

/** GET /api/config/ payload: everything masked, plus the active summary and protocol templates. */
export function configResponse(cfg: StoredConfig, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const data: Record<string, unknown> = JSON.parse(JSON.stringify(cfg));
  for (const field of [...LEGACY_KEY_FIELDS, "active_llm_api_key"]) data[field] = maskKey(str(data[field]));
  data.llm_api_configs = cfg.llm_api_configs.map((item) => ({
    ...item,
    api_key: maskKey(item.api_key),
    extra_params: Object.fromEntries(Object.keys(item.extra_params).map((key) => [key, "[redacted]"])),
    default_headers: Object.fromEntries(Object.keys(item.default_headers).map((key) => [key, "[redacted]"])),
  }));
  const active = cfg.llm_api_configs.find((item) => item.is_active);
  const source = cfg.llm_provider === "ollama" ? "ollama" : active ? "active_config" : "legacy_env";
  data.active_llm_summary = {
    provider_id: active ? active.provider_id : cfg.llm_provider,
    service_name: active ? active.service_name : providerName(cfg.llm_provider),
    model: active ? active.model : cfg.llm_model,
    base_url: active ? active.base_url : providerDefaultUrl(cfg.llm_provider),
    source,
  };
  data.provider_presets = ENDPOINT_PROTOCOL_TEMPLATES;
  data.available_providers = ENDPOINT_PROTOCOL_TEMPLATES;
  return { ...data, ...extra };
}

export interface ProbeResult { success: boolean; provider: string; model: string; message: string }

const isLocalUrl = (url: string): boolean => {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === "localhost" || host === "[::1]" || /^127\./.test(host);
  } catch {
    return false;
  }
};

async function errorText(response: Response): Promise<string> {
  const text = await response.text().catch(() => "");
  try {
    const body = JSON.parse(text) as { error?: { message?: string } | string; message?: string };
    const message = typeof body.error === "object" ? body.error?.message : body.error;
    return String(message || body.message || text).slice(0, 200);
  } catch {
    return text.slice(0, 200);
  }
}

/** POST /api/config/test-llm: one tiny real call to the active endpoint (probe_llm_endpoint). */
export async function probeLlmEndpoint(
  endpoint: { baseUrl: string; apiKey: string; model: string; provider?: string; apiFormat?: string; headers?: Record<string, string> },
  fetchFn: HttpFetch,
): Promise<ProbeResult> {
  const provider = endpoint.provider || "custom";
  const model = endpoint.model;
  const base = endpoint.baseUrl.trim().replace(/\/+$/, "");
  const key = endpoint.apiKey || (isLocalUrl(base) ? "local" : "");
  if (!key || PLACEHOLDER_KEYS.has(key)) return { success: false, provider, model, message: "API Key 未配置或仍为占位符，请先填写有效的 API Key。" };
  if (!base) return { success: false, provider, model, message: "Base URL 未配置。" };
  const anthropic = endpoint.apiFormat === "anthropic";
  try {
    const response = await fetchFn(anthropic ? `${base}/v1/messages`.replace(/\/v1\/v1\//, "/v1/") : `${base}/chat/completions`, {
      method: "POST",
      headers: anthropic
        ? { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01", ...(endpoint.headers ?? {}) }
        : { "Content-Type": "application/json", Authorization: `Bearer ${key}`, ...(endpoint.headers ?? {}) },
      body: JSON.stringify({ model, messages: [{ role: "user", content: "Hi" }], max_tokens: 5 }),
    });
    if (!response.ok) return { success: false, provider, model, message: `连接失败 (${response.status}): ${await errorText(response)}` };
    return { success: true, provider, model, message: anthropic ? "连接成功，Anthropic 服务返回了文本。" : "连接成功，模型返回了回复。" };
  } catch (cause) {
    return { success: false, provider, model, message: `无法连接到 ${base}：${cause instanceof Error ? cause.message : String(cause)}` };
  }
}

/** POST /api/config/fetch-models. A blank or masked key falls back to the stored entry (same base URL only). */
export async function fetchModelList(
  body: { base_url?: unknown; api_key?: unknown; config_id?: unknown; api_format?: unknown },
  current: StoredConfig,
  fetchFn: HttpFetch,
): Promise<{ success: boolean; models: { id: string; name: string; owned_by: string }[]; message: string }> {
  const base = str(body.base_url).trim().replace(/\/+$/, "");
  if (!base) throw new CoreError("请填写接口地址", "invalid");
  if (!/^https?:\/\//i.test(base)) throw new CoreError("接口地址必须以 http:// 或 https:// 开头", "invalid");
  let key = str(body.api_key).trim();
  if (!key || key.includes("*")) {
    const stored = current.llm_api_configs.find((item) => item.id === str(body.config_id));
    if (stored) {
      if (stored.base_url.replace(/\/+$/, "") !== base) throw new CoreError("接口地址已更改，请重新填写密钥后获取模型。", "invalid");
      key = stored.api_key;
    } else if (key.includes("*")) {
      throw new CoreError("请填写有效密钥后获取模型。", "invalid");
    }
  }
  if (!key) throw new CoreError("请填写 API Key 后获取模型。", "invalid");
  const headers: Record<string, string> = str(body.api_format) === "anthropic"
    ? { "x-api-key": key, "anthropic-version": "2023-06-01" }
    : { Authorization: `Bearer ${key}` };
  try {
    const response = await fetchFn(`${base}/models`, { method: "GET", headers });
    if (response.status !== 200) return { success: false, models: [], message: `获取模型列表失败 (${response.status}): ${await errorText(response)}` };
    const data = await response.json() as { data?: unknown };
    const models = (Array.isArray(data.data) ? data.data : [])
      .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
      .filter((item) => str(item.id))
      .map((item) => ({ id: str(item.id), name: str(item.display_name || item.name || item.id), owned_by: str(item.owned_by) }))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return { success: true, models, message: `获取到 ${models.length} 个模型` };
  } catch (cause) {
    return { success: false, models: [], message: `无法连接到 ${base}，请检查 Base URL 是否正确。(${cause instanceof Error ? cause.message : String(cause)})` };
  }
}
