import type { Hono } from "hono";
import {
  CoreError,
  applyConfigUpdate,
  configResponse,
  createLlmClient,
  endpointFromSettings,
  fetchModelList,
  normalizeConfig,
  probeLlmEndpoint,
  resolveLlmClientConfig,
  type ConfigStore,
  type HttpFetch,
  type LlmClient,
  type StoredConfig,
} from "@offeru/core";

import { jsonBody, type AppDeps, type AppEnv } from "../app";

/**
 * The user's model settings over a ConfigStore (browser IndexedDB on the web,
 * a JSON file on the companion). Keeps the last loaded copy so AppDeps.llm can
 * answer synchronously; a save updates it at once.
 */
export class ConfigRuntime {
  private cached: StoredConfig | null = null;
  private loading: Promise<StoredConfig> | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(readonly store: ConfigStore, private readonly fetchFn: HttpFetch, private readonly env?: (name: string) => string | undefined) {}

  async get(): Promise<StoredConfig> {
    if (this.cached) return this.cached;
    this.loading ??= this.store.load().then((raw) => (this.cached = normalizeConfig(raw)));
    return this.loading;
  }

  /** Read-modify-write, serialized so two saves never overwrite each other. */
  update(patch: Record<string, unknown>): Promise<StoredConfig> {
    const run = this.queue.then(async () => {
      const next = applyConfigUpdate(await this.get(), patch);
      await this.store.save(next);
      this.cached = next;
      return next;
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** AppDeps.llm: null when nothing usable is configured (or not loaded yet). */
  llm(): LlmClient | null {
    if (!this.cached) {
      void this.get().catch(() => undefined);
      return null;
    }
    try {
      return createLlmClient(endpointFromSettings(this.cached, "standard", { env: this.env }), { fetch: this.fetchFn as never });
    } catch {
      return null;
    }
  }
}

function runtimeOf(deps: AppDeps): ConfigRuntime {
  if (!deps.config) throw new CoreError("这个运行环境没有模型设置", "unsupported");
  return deps.config;
}

/**
 * /api/config — the LLM part of Python routes/config.py.
 * GET  /api/config/              → settings, keys masked, active_llm_summary, protocol templates
 * PUT  /api/config/              → partial update; masked keys keep the stored value → {message, config}
 * POST /api/config/test-llm      → {success, provider, model, message}
 * POST /api/config/fetch-models  {base_url, api_key, config_id, api_format} → {success, models, message}
 * One-click provider import (/api/config/llm-providers/import) is not migrated: 501.
 */
export function registerConfig(app: Hono<AppEnv>): void {
  const extra = (deps: AppDeps) => ({ vault_status: { backend: deps.runtime === "browser" ? "browser-indexeddb" : "file", available: true } });

  app.get("/api/config/", async (c) => {
    const deps = c.get("deps");
    return c.json(configResponse(await runtimeOf(deps).get(), extra(deps)));
  });

  app.put("/api/config/", async (c) => {
    const deps = c.get("deps");
    const body = await jsonBody(c);
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new CoreError("配置必须是对象", "invalid");
    const next = await runtimeOf(deps).update(body as Record<string, unknown>);
    return c.json({ message: "Config updated", config: configResponse(next, extra(deps)) });
  });

  app.post("/api/config/test-llm", async (c) => {
    const deps = c.get("deps");
    const settings = await runtimeOf(deps).get();
    let resolved;
    try {
      resolved = resolveLlmClientConfig(settings);
    } catch (cause) {
      return c.json({ success: false, provider: settings.llm_provider, model: settings.llm_model, message: cause instanceof Error ? cause.message : String(cause) });
    }
    const fetchFn = deps.llmFetch ?? deps.fetch ?? ((input: string, init?: RequestInit) => globalThis.fetch(input, init));
    return c.json(await probeLlmEndpoint({
      baseUrl: resolved.base_url, apiKey: resolved.api_key, model: resolved.model, provider: resolved.provider,
      apiFormat: resolved.api_format, headers: resolved.default_headers,
    }, fetchFn));
  });

  app.post("/api/config/fetch-models", async (c) => {
    const deps = c.get("deps");
    const body = await jsonBody(c) as Record<string, unknown>;
    const fetchFn = deps.llmFetch ?? deps.fetch ?? ((input: string, init?: RequestInit) => globalThis.fetch(input, init));
    return c.json(await fetchModelList(body ?? {}, await runtimeOf(deps).get(), fetchFn));
  });

  app.post("/api/config/llm-providers/import", (c) => c.json({ detail: "一键导入还没迁到新后端，请在模型设置里手动添加", code: "unsupported" }, 501));
}
