// Model-service (BYOK) settings: normalization, masking and the /api/config
// response shape. Pure: the host decides where the state lives (browser
// localforage / the local companion's own config file) and never sends the
// plain key anywhere but the provider itself.

import { CoreError } from "./types";
import { PLACEHOLDER_API_KEYS, type LlmApiFormat, type LlmEndpoint } from "./llm";

export type LlmApiConfig = {
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
  api_format: LlmApiFormat;
  supports_json_mode: boolean;
  default_headers: Record<string, string>;
  icon: string;
  website_url: string;
  notes: string;
};

/** Same field set as Python ConfigUpdate so the settings page round-trips unchanged. */
export type LlmConfigState = {
  llm_provider: string;
  llm_model: string;
  deepseek_api_key: string;
  openai_api_key: string;
  qwen_api_key: string;
  siliconflow_api_key: string;
  gemini_api_key: string;
  zhipu_api_key: string;
  ollama_base_url: string;
  llm_api_configs: LlmApiConfig[];
  active_llm_config_id: string;
  active_llm_base_url: string;
  active_llm_api_key: string;
  secret_refs: Record<string, string>;
  tier_model_map: Record<string, string>;
  disabled_llm_providers: string[];
  ssl_verify: boolean;
  llm_timeout: number;
  max_concurrent_agent_runs: number;
  llm_fallback_to_agent: boolean;
};

export const ENDPOINT_PROTOCOL_TEMPLATES = [
  {
    id: "openai-compatible",
    name: "OpenAI-compatible",
    description: "OpenAI-compatible endpoint with a custom service name, URL, and model ID.",
    api_format: "openai",
  },
  {
    id: "anthropic-compatible",
    name: "Anthropic-compatible",
    description: "Anthropic Messages endpoint with a custom service name, URL, and model ID.",
    api_format: "anthropic",
  },
] as const;

type Preset = { id: string; name: string; url: string; model: string; tiers: Record<string, string> };

/** id → name / default URL / first model / tier map, from llm_presets.PROVIDER_PRESETS. */
export const PROVIDER_PRESETS: Preset[] = [
  { id: "deepseek", name: "DeepSeek", url: "https://api.deepseek.com", model: "deepseek-v4-flash", tiers: { fast: "deepseek-v4-flash", standard: "deepseek-v4-flash", premium: "deepseek-v4-pro" } },
  { id: "openai", name: "OpenAI", url: "https://api.openai.com/v1", model: "gpt-4.1-mini", tiers: { fast: "gpt-4o-mini", standard: "gpt-4.1", premium: "gpt-4.1" } },
  { id: "qwen", name: "Qwen", url: "https://dashscope.aliyuncs.com/compatible-mode/v1", model: "qwen-flash", tiers: { fast: "qwen-flash", standard: "qwen3.5-plus", premium: "qwen3.6-plus" } },
  { id: "siliconflow", name: "SiliconFlow", url: "https://api.siliconflow.com/v1", model: "deepseek-ai/DeepSeek-V3.2", tiers: { fast: "deepseek-ai/DeepSeek-V3.2", standard: "Qwen/Qwen3-32B", premium: "zai-org/GLM-4.5" } },
  { id: "gemini", name: "Google Gemini", url: "https://generativelanguage.googleapis.com/v1beta/openai", model: "gemini-2.5-flash", tiers: { fast: "gemini-2.5-flash", standard: "gemini-2.5-pro", premium: "gemini-2.5-pro" } },
  { id: "zhipu", name: "智谱", url: "https://open.bigmodel.cn/api/paas/v4", model: "glm-5.1", tiers: { fast: "glm-4-flash", standard: "glm-5.1", premium: "glm-5.1" } },
  { id: "moonshot", name: "Moonshot (Kimi)", url: "https://api.moonshot.cn/v1", model: "kimi-k2", tiers: { fast: "kimi-k2-turbo-preview", standard: "kimi-k2", premium: "kimi-k2" } },
  { id: "groq", name: "Groq", url: "https://api.groq.com/openai/v1", model: "llama-3.3-70b-versatile", tiers: { fast: "llama-3.3-70b-versatile", standard: "llama-3.3-70b-versatile", premium: "llama-3.1-70b-versatile" } },
  { id: "openrouter", name: "OpenRouter", url: "https://openrouter.ai/api/v1", model: "openai/gpt-4o", tiers: { fast: "meta-llama/llama-3.3-70b-instruct", standard: "openai/gpt-4o", premium: "anthropic/claude-3.5-sonnet" } },
  { id: "ollama", name: "Ollama", url: "http://localhost:11434/v1", model: "qwen2.5:7b", tiers: { fast: "qwen2.5:7b", standard: "qwen2.5:7b", premium: "qwen2.5:14b" } },
  { id: "custom", name: "自定义 (OpenAI 兼容)", url: "", model: "", tiers: {} },
];

const PRESET = new Map(PROVIDER_PRESETS.map((preset) => [preset.id, preset]));
export const providerName = (id: string): string => PRESET.get(id)?.name ?? id;
export const providerDefaultUrl = (id: string): string => (PRESET.get(id)?.url ?? "").trim().replace(/\/+$/, "");
export const providerDefaultModel = (id: string): string => PRESET.get(id)?.model ?? "";
export const providerTierModels = (id: string): Record<string, string> => ({ ...(PRESET.get(id)?.tiers ?? {}) });

const LEGACY_KEY_FIELDS = [
  ["deepseek", "deepseek_api_key"],
  ["openai", "openai_api_key"],
  ["qwen", "qwen_api_key"],
  ["siliconflow", "siliconflow_api_key"],
  ["gemini", "gemini_api_key"],
  ["zhipu", "zhipu_api_key"],
] as const;
const DEFAULT_OLLAMA = "http://localhost:11434";

export function normalizeProviderId(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "custom";
}

export function maskKey(key: string): string {
  if (!key) return "";
  if (key.startsWith("env:") || key.startsWith("ENV:")) return key;
  if (key.length <= 8) return "*".repeat(key.length);
  return `${key.slice(0, 4)}${"*".repeat(key.length - 8)}${key.slice(-4)}`;
}

export function sanitizeApiKey(raw: string): string {
  const value = (raw || "").trim();
  if (!value) return "";
  if (value.startsWith("env:") || value.startsWith("ENV:")) return value;
  const lowered = value.toLowerCase();
  if (value.includes("*") || PLACEHOLDER_API_KEYS.has(lowered)) return "";
  if (lowered.includes("your") && lowered.includes("key")) return "";
  if (lowered.startsWith("sk-your-")) return "";
  return value;
}

let idCounter = 0;
function newId(): string {
  const random = globalThis.crypto?.randomUUID?.().replace(/-/g, "");
  idCounter += 1;
  return random ?? `${Date.now().toString(16)}${idCounter.toString(16)}`.padEnd(32, "0");
}

const text = (value: unknown): string => (typeof value === "string" ? value : value === null || value === undefined ? "" : String(value));
const stringMap = (value: unknown): Record<string, string> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, text(v)]));
};

export function defaultLlmConfig(): LlmConfigState {
  return {
    llm_provider: "",
    llm_model: "",
    deepseek_api_key: "",
    openai_api_key: "",
    qwen_api_key: "",
    siliconflow_api_key: "",
    gemini_api_key: "",
    zhipu_api_key: "",
    ollama_base_url: DEFAULT_OLLAMA,
    llm_api_configs: [],
    active_llm_config_id: "",
    active_llm_base_url: "",
    active_llm_api_key: "",
    secret_refs: {},
    tier_model_map: {},
    disabled_llm_providers: [],
    ssl_verify: true,
    llm_timeout: 60,
    max_concurrent_agent_runs: 3,
    llm_fallback_to_agent: false,
  };
}

function coerceItem(raw: unknown): LlmApiConfig {
  const item = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const format = text(item.api_format || "openai").trim().toLowerCase();
  if (format !== "openai" && format !== "anthropic") throw new CoreError(`不支持的 API 协议: ${format}`);
  const providerId = normalizeProviderId(text(item.provider_id) || text(item.service_name));
  return {
    id: text(item.id) || newId(),
    provider_id: providerId,
    service_name: (text(item.service_name) || providerName(providerId)).trim(),
    model: (text(item.model) || providerDefaultModel(providerId)).trim(),
    base_url: (text(item.base_url) || providerDefaultUrl(providerId)).trim().replace(/\/+$/, ""),
    api_key: sanitizeApiKey(text(item.api_key)),
    credential_ref: text(item.credential_ref),
    is_active: Boolean(item.is_active),
    extra_params: stringMap(item.extra_params),
    models: stringMap(item.models),
    api_format: format,
    supports_json_mode: item.supports_json_mode === undefined ? true : Boolean(item.supports_json_mode),
    default_headers: stringMap(item.default_headers),
    icon: text(item.icon),
    website_url: text(item.website_url),
    notes: text(item.notes),
  };
}

/** Coerce + validate a stored or submitted payload (Python ConfigUpdate(**raw)). */
export function coerceLlmConfig(raw: unknown): LlmConfigState {
  const value = (raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  const base = defaultLlmConfig();
  const runs = value.max_concurrent_agent_runs === undefined ? base.max_concurrent_agent_runs : Number(value.max_concurrent_agent_runs);
  if (!Number.isInteger(runs) || runs < 1 || runs > 10) throw new CoreError("max_concurrent_agent_runs 必须是 1-10 的整数");
  const timeout = value.llm_timeout === undefined ? base.llm_timeout : Number(value.llm_timeout);
  if (!Number.isInteger(timeout)) throw new CoreError("llm_timeout 必须是整数");
  if (value.llm_api_configs !== undefined && !Array.isArray(value.llm_api_configs)) throw new CoreError("llm_api_configs 必须是数组");
  return {
    ...base,
    ...Object.fromEntries(
      (["llm_provider", "llm_model", "deepseek_api_key", "openai_api_key", "qwen_api_key", "siliconflow_api_key", "gemini_api_key",
        "zhipu_api_key", "ollama_base_url", "active_llm_config_id", "active_llm_base_url", "active_llm_api_key"] as const)
        .filter((key) => value[key] !== undefined)
        .map((key) => [key, text(value[key])]),
    ),
    llm_api_configs: Array.isArray(value.llm_api_configs) ? value.llm_api_configs.map(coerceItem) : [],
    secret_refs: stringMap(value.secret_refs),
    tier_model_map: stringMap(value.tier_model_map),
    disabled_llm_providers: Array.isArray(value.disabled_llm_providers) ? value.disabled_llm_providers.map(text) : [],
    ssl_verify: value.ssl_verify === undefined ? true : Boolean(value.ssl_verify),
    llm_timeout: timeout,
    max_concurrent_agent_runs: runs,
    llm_fallback_to_agent: Boolean(value.llm_fallback_to_agent),
  };
}

/** Python _normalize_llm_state + _sync_legacy_fields_from_configs. */
export function normalizeLlmConfig(cfg: LlmConfigState): LlmConfigState {
  const next: LlmConfigState = { ...cfg, llm_api_configs: cfg.llm_api_configs.map((item) => coerceItem(item)) };
  const active = next.llm_api_configs.find((item) => item.id === next.active_llm_config_id)
    ?? next.llm_api_configs.find((item) => item.is_active)
    ?? next.llm_api_configs[0];
  for (const item of next.llm_api_configs) item.is_active = Boolean(active && item.id === active.id);
  next.active_llm_config_id = active?.id ?? "";
  if (active) {
    next.llm_provider = active.provider_id;
    next.llm_model = active.model;
    next.active_llm_base_url = active.base_url;
    next.active_llm_api_key = active.api_key;
  } else {
    next.active_llm_base_url = "";
    next.active_llm_api_key = "";
  }
  for (const [provider, field] of LEGACY_KEY_FIELDS) {
    next[field] = next.llm_api_configs.find((item) => item.provider_id === provider)?.api_key ?? "";
  }
  const ollama = next.llm_api_configs.find((item) => item.provider_id === "ollama");
  next.ollama_base_url = ollama?.base_url ? ollama.base_url.replace(/\/v1$/, "") : DEFAULT_OLLAMA;
  return next;
}

/**
 * PUT /api/config/ merge: patch over current, put back the real keys the page
 * echoed masked (by config id), normalize. Mirrors Python update_config minus
 * the env-var legacy fallback (see migration notes).
 */
export function applyLlmConfigUpdate(current: LlmConfigState, patch: Record<string, unknown>): LlmConfigState {
  const merged = coerceLlmConfig({ ...current, ...patch });
  const fields = new Set(Object.keys(patch));
  for (const field of ["deepseek_api_key", "openai_api_key", "qwen_api_key", "siliconflow_api_key", "gemini_api_key", "zhipu_api_key", "active_llm_api_key"] as const) {
    if (fields.has(field) && merged[field].includes("*")) merged[field] = current[field];
  }
  if (fields.has("llm_api_configs")) {
    const before = new Map(current.llm_api_configs.map((item) => [item.id, item]));
    const rawItems = Array.isArray(patch.llm_api_configs) ? patch.llm_api_configs as Array<Record<string, unknown>> : [];
    merged.llm_api_configs.forEach((item, index) => {
      const sent = text(rawItems[index]?.api_key).trim();
      const previous = before.get(item.id);
      if (sent && sent.includes("*")) {
        item.api_key = previous?.api_key ?? "";
        if (previous && !item.credential_ref) item.credential_ref = previous.credential_ref;
      }
      if (previous) {
        item.default_headers = Object.fromEntries(Object.entries(item.default_headers).map(([key, value]) => [
          key,
          value.includes("[redacted]") ? previous.default_headers[key] ?? value : value,
        ]));
      }
    });
  }
  return normalizeLlmConfig(merged);
}

const SENSITIVE_KEY = /(api[_-]?key|token|secret|password|authorization|cookie|credential)/i;
function redactMap(map: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(map).map(([key, value]) => [key, SENSITIVE_KEY.test(key) ? "[redacted]" : value]));
}

/** GET /api/config/ body: every key masked, plus the active summary and protocol templates. */
export function llmConfigResponse(cfg: LlmConfigState, vaultStatus: { available: boolean; error: string; read_error_count: number }): Record<string, unknown> {
  const active = cfg.llm_api_configs.find((item) => item.is_active);
  const hasActive = Boolean(cfg.active_llm_config_id || cfg.active_llm_base_url || cfg.active_llm_api_key);
  return {
    ...cfg,
    deepseek_api_key: maskKey(cfg.deepseek_api_key),
    openai_api_key: maskKey(cfg.openai_api_key),
    qwen_api_key: maskKey(cfg.qwen_api_key),
    siliconflow_api_key: maskKey(cfg.siliconflow_api_key),
    gemini_api_key: maskKey(cfg.gemini_api_key),
    zhipu_api_key: maskKey(cfg.zhipu_api_key),
    active_llm_api_key: maskKey(cfg.active_llm_api_key),
    llm_api_configs: cfg.llm_api_configs.map((item) => ({
      ...item,
      api_key: maskKey(item.api_key),
      extra_params: redactMap(item.extra_params),
      default_headers: redactMap(item.default_headers),
    })),
    active_llm_summary: {
      provider_id: active ? active.provider_id : cfg.llm_provider,
      service_name: active ? active.service_name : providerName(cfg.llm_provider),
      model: active ? active.model : cfg.llm_model,
      base_url: active ? active.base_url : providerDefaultUrl(cfg.llm_provider),
      source: cfg.llm_provider === "ollama" ? "ollama" : hasActive && active ? "active_config" : "legacy_env",
    },
    provider_presets: ENDPOINT_PROTOCOL_TEMPLATES,
    available_providers: ENDPOINT_PROTOCOL_TEMPLATES,
    vault_status: vaultStatus,
  };
}

/** The endpoint chat calls will use, or the same readable error Python raises. */
export function activeLlmEndpoint(cfg: LlmConfigState): LlmEndpoint {
  const active = cfg.llm_api_configs.find((item) => item.is_active);
  if (!active) throw new CoreError("还没有配置模型服务，请先在设置里添加一个。");
  const local = /^https?:\/\/(localhost|127\.\d+\.\d+\.\d+|\[::1\])(?::\d+)?(\/|$)/i.test(active.base_url);
  if (!active.base_url) throw new CoreError(`当前激活的 LLM 配置缺少 Base URL（${active.service_name}）。请在设置页面填写完整信息。`);
  if (!active.api_key && !local) throw new CoreError(`当前激活的 LLM 配置缺少 API Key（${active.service_name}）。请在设置页面填写。`);
  if (!active.model) throw new CoreError(`当前激活的 LLM 配置缺少模型名称（${active.service_name}）。`);
  if (cfg.disabled_llm_providers.includes(active.provider_id)) {
    throw new CoreError(`LLM provider「${active.service_name}」已被禁用，请在设置中启用后再使用`);
  }
  return {
    provider_id: active.provider_id,
    service_name: active.service_name,
    base_url: active.base_url,
    api_key: active.api_key || (local ? "local" : ""),
    model: active.model,
    models: active.models,
    api_format: active.api_format,
    supports_json_mode: active.supports_json_mode,
    default_headers: active.default_headers,
    source: local && active.provider_id === "ollama" ? "ollama" : "active_config",
    tier_model_map: cfg.tier_model_map,
  };
}

/** Python import_provider: fill from a preset, upsert by provider id, optionally activate. */
export function importLlmProvider(
  cfg: LlmConfigState,
  input: { provider_id?: string; api_key: string; base_url?: string; model?: string; service_name?: string; models?: Record<string, string> | null; activate?: boolean },
): { ok: boolean; errors: string[]; config: LlmApiConfig | null; state: LlmConfigState } {
  const errors: string[] = [];
  const key = sanitizeApiKey(input.api_key);
  if (!key) errors.push("API Key 不能为空，且不能是占位符。");
  const pid = (input.provider_id ?? "").trim() ? normalizeProviderId(input.provider_id!) : "";
  if (pid && cfg.disabled_llm_providers.includes(pid)) errors.push(`provider「${pid}」已被禁用，请先在设置中启用后再导入。`);
  const service = (input.service_name ?? "").trim() || (pid ? providerName(pid) : input.provider_id || "自定义");
  const base = (input.base_url ?? "").trim().replace(/\/+$/, "") || (pid ? providerDefaultUrl(pid) : "");
  const model = (input.model ?? "").trim() || (pid ? providerDefaultModel(pid) : "");
  if (!base) errors.push("缺少 Base URL：请选择预设服务商或填写接口地址。");
  if (!model) errors.push("缺少模型名称：请选择预设模型或填写模型名。");
  if (errors.length) return { ok: false, errors, config: null, state: cfg };
  const configs = cfg.llm_api_configs.map((item) => ({ ...item }));
  let target = pid ? configs.find((item) => item.provider_id === pid) : undefined;
  if (!target) {
    target = coerceItem({
      provider_id: pid || "custom", service_name: service, model, base_url: base, api_key: key,
      models: input.models && Object.keys(input.models).length ? input.models : (pid ? providerTierModels(pid) : {}),
    });
    configs.push(target);
  } else {
    Object.assign(target, { service_name: service, model, base_url: base, api_key: key, models: input.models ? { ...input.models } : {} });
  }
  let state: LlmConfigState = { ...cfg, llm_api_configs: configs };
  if (input.activate !== false) {
    for (const item of configs) item.is_active = item === target;
    state.active_llm_config_id = target.id;
  }
  state = normalizeLlmConfig(state);
  return { ok: true, errors: [], config: state.llm_api_configs.find((item) => item.id === target!.id) ?? null, state };
}

/** Is this IP literal private/loopback/link-local/reserved (SSRF guard, Python _is_disallowed_ip)? */
export function isDisallowedIp(address: string): boolean {
  let ip = address.trim().toLowerCase().replace(/^\[|\]$/g, "").split("%")[0];
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(ip);
  if (mapped) ip = mapped[1];
  const v4 = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(ip);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return a === 0 || a === 10 || a === 127 || a >= 224
      || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168)
      || (a === 192 && b === 0)
      || (a === 198 && (b === 18 || b === 19));
  }
  if (!ip.includes(":")) return false;
  return ip === "::" || ip === "::1" || /^f[cd]/.test(ip) || /^fe[89ab]/.test(ip) || /^ff/.test(ip) || ip.startsWith("2001:db8");
}

/**
 * Python _validate_external_base_url. `resolve` returns the host's addresses
 * (DNS is runtime-specific, so it is injected). null = allowed, else the reason.
 */
export async function validateExternalBaseUrl(baseUrl: string, resolve: (host: string) => Promise<string[]>, production = false): Promise<string | null> {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return "Base URL 格式无效";
  }
  const scheme = url.protocol.replace(/:$/, "").toLowerCase();
  if (scheme !== "http" && scheme !== "https") return `不支持的协议「${scheme || "(空)"}」，仅允许 http/https`;
  const host = url.hostname.replace(/\.$/, "").replace(/^\[|\]$/g, "");
  if (!host) return "Base URL 缺少主机名";
  const literal = /^[\d.]+$/.test(host) || host.includes(":");
  if (literal) {
    if (isDisallowedIp(host)) return `目标地址 ${host} 为私有/内网地址，禁止访问`;
  } else {
    let addresses: string[];
    try {
      addresses = await resolve(host);
    } catch {
      return `无法解析主机名 ${host}`;
    }
    if (!addresses.length) return `无法解析主机名 ${host}`;
    const bad = addresses.find(isDisallowedIp);
    if (bad) return `主机名 ${host} 解析到私有/内网地址 ${bad}，禁止访问`;
  }
  if (scheme === "http" && production) return "生产环境要求使用 HTTPS，请改用 https:// 地址";
  return null;
}

export type ModelListResult = { success: boolean; models: Array<{ id: string; name: string; owned_by: string }>; message: string };

/** POST /api/config/fetch-models body after the key was resolved. */
export async function fetchProviderModels(
  input: { base_url: string; api_key: string; api_format: LlmApiFormat },
  fetchImpl: (url: string, init?: RequestInit) => Promise<Response>,
): Promise<ModelListResult> {
  const base = input.base_url.replace(/\/+$/, "");
  const headers: Record<string, string> = input.api_format === "anthropic"
    ? { "x-api-key": input.api_key, "anthropic-version": "2023-06-01" }
    : { Authorization: `Bearer ${input.api_key}` };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetchImpl(`${base}/models`, { headers, redirect: "manual", signal: controller.signal });
    if (response.status !== 200) {
      const raw = await response.text().catch(() => "");
      let message: string;
      try {
        const body = JSON.parse(raw) as Record<string, any>;
        message = String(body?.error?.message || body?.message || "");
      } catch {
        message = raw.slice(0, 200);
      }
      if (input.api_key.length >= 6) message = message.split(input.api_key).join("[redacted]");
      return { success: false, models: [], message: `获取模型列表失败 (${response.status}): ${message.slice(0, 300)}` };
    }
    const body = await response.json() as { data?: unknown };
    const raw = Array.isArray(body?.data) ? body.data : [];
    const models = raw
      .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && Boolean((item as Record<string, unknown>).id))
      .map((item) => ({ id: text(item.id), name: text(item.display_name || item.name || item.id), owned_by: text(item.owned_by) }))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return { success: true, models, message: `获取到 ${models.length} 个模型` };
  } catch (cause) {
    const aborted = cause instanceof Error && cause.name === "AbortError";
    return { success: false, models: [], message: aborted ? `连接超时 (${base})，请检查网络。` : `无法连接到 ${base}，请检查 Base URL 是否正确。` };
  } finally {
    clearTimeout(timer);
  }
}
