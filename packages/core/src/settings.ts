// Settings host + the /api/config, /api/consent service functions. Pure: the
// host (companion files, browser IndexedDB) is injected, so the Hono route on
// the companion and the browser transport run the same code.

import { CoreError, isCoreError } from "./types";
import { consentAgreement, consentStatus, type ConsentRecord } from "./consent";
import { createConfiguredLlm, probeLlmEndpoint, type ConfiguredLlm, type WebFetch } from "./llm-endpoint";
import {
  activeLlmEndpoint,
  applyLlmConfigUpdate,
  fetchProviderModels,
  importLlmProvider,
  llmConfigResponse,
  normalizeLlmConfig,
  validateExternalBaseUrl,
  type LlmConfigState,
} from "./llm-config";

/**
 * Where the user's own settings live: the model config with its API keys and
 * the platform-consent record. Runtime-agnostic interface; implementations:
 *   - companion: backend-ts/src/settings-node.ts (files in the data dir, mode 0600);
 *   - browser:   frontend/src/lib/local/settings.ts (IndexedDB).
 * The stateless Worker has none, so a key can never reach it.
 */
export interface SettingsHost {
  /** Current model config, plain keys included. Sync: hosts keep it cached. */
  loadLlmConfig(): LlmConfigState;
  saveLlmConfig(next: LlmConfigState): Promise<void>;
  vaultStatus(): { available: boolean; error: string; read_error_count: number };
  loadConsent(): ConsentRecord | null;
  saveConsent(record: ConsentRecord | null): Promise<void>;
  /** Network for the provider (probe, model list, chat). */
  fetch: WebFetch;
  /** DNS for the SSRF guard; absent (browser) = only IP literals are checked. */
  resolveHost?: (host: string) => Promise<string[]>;
  /** Production requires https base URLs (Python OFFERU_ENV=production). */
  production?: boolean;
}

export type VaultStatus = ReturnType<SettingsHost["vaultStatus"]>;

/**
 * `AppDeps.llm` factory: builds the client from the saved config on every
 * call, so a changed key or model applies to the next request. `fallback`
 * (dev only, e.g. env vars) is used when nothing is configured.
 */
export function llmFactory(settings: SettingsHost, fallback?: () => ConfiguredLlm | null): () => ConfiguredLlm | null {
  return () => {
    const cfg = settings.loadLlmConfig();
    let endpoint;
    try {
      endpoint = activeLlmEndpoint(cfg);
    } catch (cause) {
      if (!isCoreError(cause)) throw cause;
      // Something is configured but incomplete/disabled: say so instead of silently using a fallback.
      if (cfg.llm_api_configs.length) throw cause;
      return fallback?.() ?? null;
    }
    return createConfiguredLlm(endpoint, { fetch: settings.fetch, timeoutMs: Math.max(1, cfg.llm_timeout || 60) * 1000 });
  };
}

const str = (value: unknown): string => (typeof value === "string" ? value : value === null || value === undefined ? "" : String(value));
const obj = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

function requireSettings(settings: SettingsHost | null | undefined): SettingsHost {
  if (!settings) throw new CoreError("这个运行环境不保存模型配置：API Key 只存在你的浏览器或本机 OfferU 里", "unsupported");
  return settings;
}

// Python serializes config read-modify-write with an asyncio.Lock (C-02).
const locks = new WeakMap<SettingsHost, Promise<unknown>>();
function serialized<T>(settings: SettingsHost, task: () => Promise<T>): Promise<T> {
  const previous = locks.get(settings) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(task);
  locks.set(settings, next);
  return next;
}

/** GET /api/config/ */
export function getConfigView(settings: SettingsHost | null | undefined): Record<string, unknown> {
  const host = requireSettings(settings);
  return llmConfigResponse(host.loadLlmConfig(), host.vaultStatus());
}

/** PUT /api/config/: merge, restore masked keys, normalize, persist. */
export function updateConfig(settings: SettingsHost | null | undefined, patch: unknown): Promise<Record<string, unknown>> {
  const host = requireSettings(settings);
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new CoreError("请求体要是 JSON 对象");
  return serialized(host, async () => {
    const next = applyLlmConfigUpdate(host.loadLlmConfig(), patch as Record<string, unknown>);
    await host.saveLlmConfig(next);
    return { message: "Config updated", config: llmConfigResponse(next, host.vaultStatus()) };
  });
}

/** POST /api/config/test-llm: probe the active endpoint. */
export async function testActiveLlm(settings: SettingsHost | null | undefined): Promise<Record<string, unknown>> {
  const host = requireSettings(settings);
  const cfg = host.loadLlmConfig();
  let endpoint;
  try {
    endpoint = activeLlmEndpoint(cfg);
  } catch (cause) {
    if (!isCoreError(cause)) throw cause;
    return { success: false, provider: cfg.llm_provider, model: cfg.llm_model, message: cause.message };
  }
  return probeLlmEndpoint({
    base_url: endpoint.base_url,
    api_key: endpoint.api_key,
    model: endpoint.model,
    provider_id: cfg.llm_provider || endpoint.provider_id,
    api_format: endpoint.api_format,
    default_headers: endpoint.default_headers,
  }, host.fetch);
}

async function ssrfError(host: SettingsHost, baseUrl: string): Promise<string | null> {
  return validateExternalBaseUrl(baseUrl, host.resolveHost, Boolean(host.production));
}

/** POST /api/config/llm-providers/import: one-click BYOK import, optional activate + live test. */
export async function importProviderKey(settings: SettingsHost | null | undefined, rawBody: unknown): Promise<Record<string, unknown>> {
  const host = requireSettings(settings);
  const body = obj(rawBody);
  const apiKey = str(body.api_key);
  if (!apiKey) throw new CoreError("api_key 不能为空");
  const baseUrl = str(body.base_url);
  if (baseUrl.trim()) {
    const blocked = await ssrfError(host, baseUrl);
    if (blocked) throw new CoreError(blocked);
  }
  const models = obj(body.models);
  const outcome = await serialized(host, async () => {
    const result = importLlmProvider(host.loadLlmConfig(), {
      provider_id: str(body.provider_id),
      api_key: apiKey,
      base_url: baseUrl,
      model: str(body.model),
      service_name: str(body.service_name),
      models: Object.keys(models).length ? Object.fromEntries(Object.entries(models).map(([k, v]) => [k, str(v)])) : null,
      activate: body.activate === undefined ? true : Boolean(body.activate),
    });
    if (result.config) await host.saveLlmConfig(result.state);
    return result;
  });
  const payload: Record<string, unknown> = { ok: outcome.ok, errors: outcome.errors.map((item) => item.slice(0, 500)) };
  const config = outcome.config;
  if (!config) return { ...payload, config: null, test_result: null };
  payload.config = {
    id: config.id,
    provider_id: config.provider_id,
    service_name: config.service_name,
    model: config.model,
    base_url: config.base_url,
    is_active: config.is_active,
    models: config.models,
  };
  const state = normalizeLlmConfig(outcome.state);
  const active = state.llm_api_configs.find((item) => item.is_active);
  payload.active_llm_summary = {
    provider_id: active ? active.provider_id : state.llm_provider,
    service_name: active ? active.service_name : state.llm_provider,
    model: active ? active.model : state.llm_model,
    base_url: (active ? active.base_url : "").slice(0, 300),
    is_active: Boolean(active),
  };
  payload.test_result = null;
  if (body.test === undefined || Boolean(body.test)) {
    const blocked = await ssrfError(host, config.base_url);
    // Python probes the imported entry with the default (OpenAI) protocol.
    payload.test_result = blocked
      ? { ok: false, error: blocked }
      : await probeLlmEndpoint({ base_url: config.base_url, api_key: config.api_key, model: config.model, provider_id: config.provider_id, api_format: "openai", default_headers: {} }, host.fetch);
  }
  return payload;
}

/** POST /api/config/fetch-models: list the provider's models, reusing a saved key when the page sends it masked. */
export async function fetchModelsForConfig(settings: SettingsHost | null | undefined, rawBody: unknown): Promise<Record<string, unknown>> {
  const host = requireSettings(settings);
  const body = obj(rawBody);
  const baseUrl = str(body.base_url).replace(/\/+$/, "");
  if (!str(body.base_url)) throw new CoreError("base_url 不能为空");
  const format = str(body.api_format || "openai");
  if (format !== "openai" && format !== "anthropic") throw new CoreError("api_format 只能是 openai 或 anthropic");
  const blocked = await ssrfError(host, baseUrl);
  if (blocked) throw new CoreError(blocked);
  let apiKey = str(body.api_key);
  if (!apiKey || apiKey.includes("*")) {
    const stored = host.loadLlmConfig().llm_api_configs.find((item) => item.id === str(body.config_id));
    if (stored) {
      if (stored.base_url.replace(/\/+$/, "") !== baseUrl) throw new CoreError("接口地址已更改，请重新填写密钥后获取模型。");
      apiKey = stored.api_key;
    } else if (apiKey.includes("*")) {
      throw new CoreError("请填写有效密钥后获取模型。");
    }
  }
  if (!apiKey) throw new CoreError("请填写 API Key 后获取模型。");
  return fetchProviderModels({ base_url: baseUrl, api_key: apiKey, api_format: format }, host.fetch);
}

/** Local time with offset, seconds precision (Python datetime.now().astimezone().isoformat(timespec="seconds")). */
export function localIsoSeconds(date = new Date()): string {
  const pad = (n: number) => String(Math.abs(n)).padStart(2, "0");
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
    + `${sign}${pad(Math.trunc(offset / 60))}:${pad(offset % 60)}`;
}

/** GET /api/consent/platform-collect */
export function platformConsentStatus(settings: SettingsHost | null | undefined): Record<string, unknown> {
  return consentStatus(requireSettings(settings).loadConsent());
}

/** POST /api/consent/platform-collect {version} — stale version is 409. */
export async function agreePlatformConsent(settings: SettingsHost | null | undefined, rawBody: unknown, now = new Date()): Promise<Record<string, unknown>> {
  const host = requireSettings(settings);
  const record = consentAgreement(obj(rawBody).version, localIsoSeconds(now));
  await host.saveConsent(record);
  return consentStatus(record);
}

/** DELETE /api/consent/platform-collect */
export async function revokePlatformConsent(settings: SettingsHost | null | undefined): Promise<Record<string, unknown>> {
  const host = requireSettings(settings);
  await host.saveConsent(null);
  return consentStatus(null);
}
