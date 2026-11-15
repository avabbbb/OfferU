// /api/config (LLM settings) — the shape the settings page reads and writes, per Python routes/config.py.

import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { applyConfigUpdate, maskKey, normalizeConfig, type ConfigStore, type StoredConfig } from "@offeru/core";
import { afterEach, describe, expect, it } from "vitest";

import { createApp } from "../src/app";
import { nodeConfigFile } from "../src/routes/companion/config-file";
import { ConfigRuntime } from "../src/routes/config";
import { SqliteCoreStore } from "../src/store";

let stores: SqliteCoreStore[] = [];
afterEach(() => {
  for (const s of stores) s.close();
  stores = [];
});

function memoryConfig(initial: Partial<StoredConfig> | null = null): ConfigStore & { saved: StoredConfig | null } {
  const box = { saved: null as StoredConfig | null };
  return {
    get saved() { return box.saved; },
    async load() { return box.saved ?? initial; },
    async save(config) { box.saved = JSON.parse(JSON.stringify(config)); },
  };
}

function setup(fetchFn: (input: string, init?: RequestInit) => Promise<Response> = async () => new Response("{}", { status: 500 })) {
  const store = new SqliteCoreStore(":memory:");
  stores.push(store);
  const cfgStore = memoryConfig();
  const config = new ConfigRuntime(cfgStore, fetchFn);
  const app = createApp({ store, runtime: "browser", storage: "indexeddb", config, llm: () => config.llm(), llmFetch: fetchFn });
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await app.request(path, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: await res.json() as Record<string, any> };
  };
  return { call, config, cfgStore };
}

const KEY = "sk-abcdefghijklmnop1234";

describe("/api/config", () => {
  it("starts empty with protocol templates and no active model", async () => {
    const { call } = setup();
    const res = await call("GET", "/api/config/");
    expect(res.status).toBe(200);
    expect(res.body.llm_api_configs).toEqual([]);
    expect(res.body.active_llm_config_id).toBe("");
    expect(res.body.provider_presets.map((p: { id: string }) => p.id)).toEqual(["openai-compatible", "anthropic-compatible"]);
    expect(res.body.active_llm_summary.source).toBe("legacy_env");
  });

  it("saves a provider, masks the key, keeps it when the masked value comes back", async () => {
    const { call, config, cfgStore } = setup();
    const put = await call("PUT", "/api/config/", {
      llm_api_configs: [{ id: "c1", provider_id: "custom", service_name: "My GW", base_url: "https://api.example.com/v1/", model: "m-1", api_key: KEY }],
      active_llm_config_id: "c1",
    });
    expect(put.status).toBe(200);
    expect(put.body.message).toBe("Config updated");
    const shown = put.body.config.llm_api_configs[0];
    expect(shown.api_key).toBe(maskKey(KEY));
    expect(shown.api_key).not.toContain("efgh");
    expect(shown.base_url).toBe("https://api.example.com/v1");
    expect(shown.is_active).toBe(true);
    expect(put.body.config.active_llm_summary).toMatchObject({ service_name: "My GW", model: "m-1", source: "active_config" });
    expect(cfgStore.saved?.llm_api_configs[0].api_key).toBe(KEY);

    // The settings page sends back what it was shown: the masked key must not wipe the real one.
    await call("PUT", "/api/config/", { llm_api_configs: [{ ...shown, model: "m-2" }] });
    expect(cfgStore.saved?.llm_api_configs[0]).toMatchObject({ api_key: KEY, model: "m-2" });
    expect(config.llm()).not.toBeNull();
  });

  it("legacy single-key update (onboarding) creates and activates the provider", () => {
    const next = applyConfigUpdate(normalizeConfig(null), { llm_provider: "deepseek", deepseek_api_key: KEY });
    expect(next.llm_api_configs).toHaveLength(1);
    expect(next.llm_api_configs[0]).toMatchObject({ provider_id: "deepseek", api_key: KEY, is_active: true });
    expect(next.deepseek_api_key).toBe(KEY);
    expect(next.llm_provider).toBe("deepseek");
  });

  it("rejects an unknown API protocol", async () => {
    const { call } = setup();
    const res = await call("PUT", "/api/config/", { llm_api_configs: [{ base_url: "https://x.example/v1", api_key: KEY, model: "m", api_format: "grpc" }] });
    expect(res.status).toBe(400);
  });

  it("test-llm probes the active endpoint through llmFetch", async () => {
    const seen: { url: string; auth: string | null }[] = [];
    const { call } = setup(async (url, init) => {
      seen.push({ url, auth: new Headers(init?.headers).get("authorization") });
      return new Response(JSON.stringify({ choices: [{ message: { content: "hi" } }] }), { status: 200 });
    });
    expect((await call("POST", "/api/config/test-llm")).body.success).toBe(false);
    await call("PUT", "/api/config/", { llm_api_configs: [{ id: "c1", base_url: "https://api.example.com/v1", model: "m", api_key: KEY }] });
    const res = await call("POST", "/api/config/test-llm");
    expect(res.body).toMatchObject({ success: true, model: "m" });
    expect(seen.at(-1)).toEqual({ url: "https://api.example.com/v1/chat/completions", auth: `Bearer ${KEY}` });
  });

  it("fetch-models uses the stored key for a masked one, sorted by id", async () => {
    const { call } = setup(async (url, init) => {
      expect(url).toBe("https://api.example.com/v1/models");
      expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${KEY}`);
      return new Response(JSON.stringify({ data: [{ id: "z" }, { id: "a", owned_by: "x" }] }), { status: 200 });
    });
    await call("PUT", "/api/config/", { llm_api_configs: [{ id: "c1", base_url: "https://api.example.com/v1", model: "m", api_key: KEY }] });
    const res = await call("POST", "/api/config/fetch-models", { base_url: "https://api.example.com/v1", api_key: maskKey(KEY), config_id: "c1" });
    expect(res.body).toMatchObject({ success: true, models: [{ id: "a", name: "a", owned_by: "x" }, { id: "z", name: "z", owned_by: "" }] });
    const moved = await call("POST", "/api/config/fetch-models", { base_url: "https://other.example.com/v1", api_key: maskKey(KEY), config_id: "c1" });
    expect(moved.status).toBe(400);
  });

  it("is 501 where no config store is wired", async () => {
    const store = new SqliteCoreStore(":memory:");
    stores.push(store);
    const res = await createApp({ store, runtime: "worker", storage: "none" }).request("/api/config/");
    expect(res.status).toBe(501);
  });

  it("companion file store is owner-only and survives a reload", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "offeru-config-")), "offeru-ts-config.json");
    const first = new ConfigRuntime(nodeConfigFile(path), globalThis.fetch);
    await first.update({ llm_api_configs: [{ id: "c1", base_url: "https://api.example.com/v1", model: "m", api_key: KEY }] });
    if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(path, "utf8")).llm_api_configs[0].api_key).toBe(KEY);
    const second = new ConfigRuntime(nodeConfigFile(path), globalThis.fetch);
    expect((await second.get()).active_llm_config_id).toBe("c1");
  });
});
