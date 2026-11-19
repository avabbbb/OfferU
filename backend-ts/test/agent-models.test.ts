// The composer's model picker: GET /api/agent/runtime/models (services → models →
// reasoning levels decided in core) and a run that picks a service, a model and an
// effort reaching the provider request body.

import { MemoryAgentRunStore, buildReasoningParams, llmModelCatalog, reasoningLevelsFor, type ConfigStore, type StoredConfig } from "@offeru/core";
import { afterEach, describe, expect, it } from "vitest";

import { createApp } from "../src/app";
import { ConfigRuntime } from "../src/routes/config";
import { SqliteCoreStore } from "../src/store";

let stores: SqliteCoreStore[] = [];
afterEach(() => {
  for (const store of stores) store.close();
  stores = [];
});

const KEY = "sk-abcdefghijklmnop1234";

function memoryConfig(initial: Partial<StoredConfig>): ConfigStore {
  let saved: StoredConfig | null = null;
  return { async load() { return saved ?? initial; }, async save(config) { saved = JSON.parse(JSON.stringify(config)); } };
}

const SERVICES: Partial<StoredConfig> = {
  llm_api_configs: [
    { id: "ds", provider_id: "deepseek", service_name: "DeepSeek", base_url: "https://api.deepseek.com", model: "deepseek-v4-flash", api_key: KEY, models: {} },
    { id: "oa", provider_id: "openai", service_name: "OpenAI", base_url: "https://api.openai.com/v1", model: "o4-mini", api_key: KEY, models: {} },
  ] as StoredConfig["llm_api_configs"],
  active_llm_config_id: "ds",
};

function setup() {
  const store = new SqliteCoreStore(":memory:");
  stores.push(store);
  const bodies: Array<Record<string, any>> = [];
  const urls: string[] = [];
  const fetchFn = async (input: string, init?: RequestInit) => {
    urls.push(input);
    bodies.push(JSON.parse(String(init?.body || "{}")));
    const sse = 'data: {"choices":[{"delta":{"content":"好的"}}]}\n\n'
      + 'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}\n\n'
      + "data: [DONE]\n\n";
    return new Response(sse, { status: 200, headers: { "Content-Type": "text/event-stream" } });
  };
  const config = new ConfigRuntime(memoryConfig(SERVICES), fetchFn);
  void config.get();
  const app = createApp({ store, runtime: "browser", storage: "indexeddb", config, llm: (choice) => config.llm(choice), llmFetch: fetchFn, agentRuns: new MemoryAgentRunStore() });
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await app.request(path, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: await res.json() as any };
  };
  return { call, config, bodies, urls };
}

describe("reasoning levels (core)", () => {
  it("offers no control for chat-only models and Anthropic, minimal only on OpenAI / OpenRouter", () => {
    expect(reasoningLevelsFor({ provider: "deepseek", model: "deepseek-v4-flash" })).toEqual([]);
    expect(reasoningLevelsFor({ provider: "openai", model: "gpt-4.1" })).toEqual([]);
    expect(reasoningLevelsFor({ provider: "custom", model: "openai/gpt-4o-mini" })).toEqual([]);
    expect(reasoningLevelsFor({ provider: "custom", apiFormat: "anthropic", model: "claude-sonnet-4" })).toEqual([]);
    expect(reasoningLevelsFor({ provider: "openai", model: "o4-mini" })).toEqual(["minimal", "low", "medium", "high"]);
    expect(reasoningLevelsFor({ provider: "deepseek", model: "deepseek-v4-pro" })).toEqual(["low", "medium", "high"]);
    expect(reasoningLevelsFor({ provider: "custom", baseUrl: "https://openrouter.ai/api/v1", model: "x/y" })).toContain("minimal");
  });

  it("maps an effort to each provider's body fields", () => {
    expect(buildReasoningParams("", { provider: "openai" }).params).toEqual({});
    expect(buildReasoningParams("high", { provider: "openai" }).params).toEqual({ reasoning_effort: "high" });
    expect(buildReasoningParams("minimal", { provider: "deepseek" }).params).toEqual({ reasoning_effort: "low" });
    expect(buildReasoningParams("medium", { provider: "openrouter" }).params).toEqual({ reasoning: { effort: "medium" } });
    expect(buildReasoningParams("low", { provider: "qwen" }).params).toEqual({ enable_thinking: true, thinking_budget: 2048 });
  });

  it("lists configured, tier and preset models once each", () => {
    const [service] = llmModelCatalog({ llm_api_configs: [{ id: "c", provider_id: "deepseek", model: "deepseek-v4-pro", models: { fast: "deepseek-v4-flash" } }] });
    expect(service.models.map((model) => model.id).slice(0, 3)).toEqual(["deepseek-v4-pro", "deepseek-v4-flash", "deepseek-chat"]);
    expect(new Set(service.models.map((model) => model.id)).size).toBe(service.models.length);
  });
});

describe("GET /api/agent/runtime/models", () => {
  it("serves services → models → efforts from the saved settings", async () => {
    const { call } = setup();
    const res = await call("GET", "/api/agent/runtime/models");
    expect(res.status).toBe(200);
    const [deepseek, openai] = res.body.services;
    expect(deepseek).toMatchObject({ config_id: "ds", service_name: "DeepSeek", active: true, default_model: "deepseek-v4-flash" });
    expect(deepseek.models[0]).toEqual({ id: "deepseek-v4-flash", name: "DeepSeek V4 Flash", efforts: [], context_limit: 1_048_576, context_window: 262_144 });
    expect(deepseek.models.find((model: { id: string }) => model.id === "deepseek-v4-pro").efforts.map((level: { id: string }) => level.id)).toEqual(["low", "medium", "high"]);
    expect(openai).toMatchObject({ config_id: "oa", active: false });
    expect(openai.models[0].efforts[0]).toEqual({ id: "minimal", label: "极简", hint: "几乎不思考，最快" });
  });

  it("is 501 where there are no model settings", async () => {
    const store = new SqliteCoreStore(":memory:");
    stores.push(store);
    const app = createApp({ store, runtime: "node", storage: "sqlite" });
    expect((await app.request("/api/agent/runtime/models")).status).toBe(501);
  });
});

describe("a run with a picked service / model / effort", () => {
  it("sends that model and the provider's reasoning field", async () => {
    const { call, bodies, urls, config } = setup();
    await config.get();
    const res = await call("POST", "/api/agent/runtime/runs", { message: "你好", llm_config_id: "oa", model: "o3", reasoning_effort: "minimal" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, assistant_message: "好的" });
    expect(urls[0]).toBe("https://api.openai.com/v1/chat/completions");
    expect(bodies[0]).toMatchObject({ model: "o3", reasoning_effort: "minimal" });
    expect(res.body.run.llm_runtime).toMatchObject({ model: "o3" });
  });

  it("uses the active service's model when nothing is picked, and rejects an unknown effort", async () => {
    const { call, bodies, urls, config } = setup();
    await config.get();
    await call("POST", "/api/agent/runtime/runs", { message: "你好" });
    expect(urls[0]).toBe("https://api.deepseek.com/chat/completions");
    expect(bodies[0].model).toBe("deepseek-v4-flash");
    expect(bodies[0]).not.toHaveProperty("reasoning_effort");
    const bad = await call("POST", "/api/agent/runtime/runs", { message: "你好", reasoning_effort: "max" });
    expect(bad.status).toBe(400);
  });
});
