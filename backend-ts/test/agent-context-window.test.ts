// Agent context window (packages/core/src/llm-context.ts) and step budget (agent/limits.ts):
// 256K by default, configurable globally / per service, capped at a model's known limit; the
// compaction trigger scales with the window; MAX_STEPS defaults to 12 and is configurable.

import {
  COMPACTION_KEEP_RECENT_RATIO,
  COMPACTION_RESERVE_RATIO,
  DEFAULT_COMPACTION,
  DEFAULT_CONTEXT_WINDOW_TOKENS,
  MAX_STEPS,
  MemoryAgentRunStore,
  PROVIDER_PRESETS,
  agentContextWindow,
  compactSession,
  compactionPolicyFor,
  createAgentRuntime,
  llmModelCatalog,
  modelContextLimit,
  normalizeConfig,
  resolveContextWindow,
  type ChatRequest,
  type ConfigStore,
  type LlmClient,
  type LlmStreamEvent,
  type StoredConfig,
} from "@offeru/core";
import { afterEach, describe, expect, it } from "vitest";

import { SqliteAgentRunStore } from "../src/agent-store";
import { createApp } from "../src/app";
import { ConfigRuntime } from "../src/routes/config";
import { SqliteCoreStore } from "../src/store";

let stores: SqliteCoreStore[] = [];
afterEach(() => {
  for (const store of stores) store.close();
  stores = [];
});

describe("context window per model", () => {
  it("defaults to 256K and caps at the model's known limit", () => {
    expect(DEFAULT_CONTEXT_WINDOW_TOKENS).toBe(262_144);
    // Unknown model: the default, uncapped.
    expect(resolveContextWindow({ model: "my-private-model" })).toEqual({ tokens: 262_144, requested: 262_144, limit: null, capped: false });
    // Larger models keep the full 256K.
    expect(resolveContextWindow({ model: "deepseek-v4-flash" })).toMatchObject({ tokens: 262_144, limit: 1_048_576, capped: false });
    expect(resolveContextWindow({ model: "kimi-k2-turbo-preview" })).toMatchObject({ tokens: 262_144, limit: 262_144, capped: false });
    // Smaller models are cut to their limit.
    expect(resolveContextWindow({ model: "gpt-4o-mini" })).toMatchObject({ tokens: 128_000, capped: true });
    expect(resolveContextWindow({ model: "zai-org/GLM-4.5" })).toMatchObject({ tokens: 131_072, capped: true });
    expect(resolveContextWindow({ model: "glm-5.1" })).toMatchObject({ tokens: 200_000, capped: true });
    expect(resolveContextWindow({ model: "moonshot-v1-32k" }).tokens).toBe(32_768);
    expect(resolveContextWindow({ model: "gemma2:9b" }).tokens).toBe(8_192);
    // Gateway prefixes and case do not matter.
    expect(modelContextLimit("openai/gpt-4o")).toBe(128_000);
    expect(modelContextLimit("deepseek-ai/DeepSeek-V3.2")).toBe(163_840);
  });

  it("takes a configured window (service before global), still capped by the model", () => {
    expect(resolveContextWindow({ model: "qwen3.6-plus", configured: [1_000_000] }).tokens).toBe(1_000_000);
    expect(resolveContextWindow({ model: "gpt-4o-mini", configured: [1_000_000] }).tokens).toBe(128_000);
    expect(resolveContextWindow({ model: "x", configured: [0, 65_536] }).tokens).toBe(65_536);
    expect(resolveContextWindow({ model: "x", configured: ["nope", 12] }).tokens).toBe(262_144); // out of range = unset
    const settings = {
      active_llm_config_id: "a",
      agent_context_window: 100_000,
      llm_api_configs: [{ id: "a", context_window: 0 }, { id: "b", context_window: 50_000 }],
    };
    expect(agentContextWindow(settings, "unknown-model").tokens).toBe(100_000);
    expect(agentContextWindow(settings, "unknown-model", "b").tokens).toBe(50_000);
    expect(agentContextWindow(settings, "moonshot-v1-32k", "b").tokens).toBe(32_768);
  });

  it("knows a limit for every bundled preset model", () => {
    const unknown = PROVIDER_PRESETS.flatMap((preset) => preset.models.map((model) => model.id)).filter((id) => modelContextLimit(id) === null);
    expect(unknown).toEqual([]);
  });

  it("serves context_limit / context_window in the model catalog", () => {
    const [service] = llmModelCatalog({ agent_context_window: 0, llm_api_configs: [{ id: "c", provider_id: "openai", model: "gpt-4.1" }] });
    expect(service.models.find((model) => model.id === "gpt-4.1")).toMatchObject({ context_limit: 1_047_576, context_window: 262_144 });
    expect(service.models.find((model) => model.id === "gpt-4o-mini")).toMatchObject({ context_limit: 128_000, context_window: 128_000 });
  });
});

describe("compaction scales with the window", () => {
  it("keeps the 1/8 reserve and 1/4 keep-recent ratios", () => {
    expect(COMPACTION_RESERVE_RATIO).toBe(0.125);
    expect(COMPACTION_KEEP_RECENT_RATIO).toBe(0.25);
    expect(DEFAULT_COMPACTION).toEqual({ windowTokens: 262_144, reserveTokens: 32_768, keepRecentTokens: 65_536 });
    expect(compactionPolicyFor(128_000)).toEqual({ windowTokens: 128_000, reserveTokens: 16_000, keepRecentTokens: 32_000 });
    // The old fixed policy is the 64K point of the same curve.
    expect(compactionPolicyFor(64_000)).toEqual({ windowTokens: 64_000, reserveTokens: 8_000, keepRecentTokens: 16_000 });
  });

  it("a 100K-token session fits 256K but compacts on a 64K window", () => {
    const big = "x".repeat(400_000); // ~100K tokens
    const messages = [{ role: "user" as const, content: "目标" }, { role: "assistant" as const, content: big }, { role: "user" as const, content: "继续" }];
    expect(compactSession(messages, 1_000).compacted).toBe(false);
    expect(compactSession(messages, 1_000, compactionPolicyFor(64_000)).compacted).toBe(true);
  });
});

const usage = { input_tokens: 10, output_tokens: 5, total_tokens: 15, estimated: false };

function fakeLlm(model: string, seen: ChatRequest[]): LlmClient {
  return {
    provider: "fake",
    model,
    async chat() { return null; },
    async *completeStream(request: ChatRequest): AsyncIterable<LlmStreamEvent> {
      seen.push(request);
      yield { type: "text_delta", text: "好。" };
      yield { type: "done", result: { provider: "fake", model, content: "好。", reasoning: "", toolCalls: [], finishReason: "stop", usage } };
    },
  };
}

describe("the run uses the model's window and the step budget", () => {
  async function turn(model: string, message: string) {
    const store = new SqliteCoreStore(":memory:");
    stores.push(store);
    const seen: ChatRequest[] = [];
    const agent = createAgentRuntime({ store, runs: new SqliteAgentRunStore(store), llm: () => fakeLlm(model, seen), streamGuard: false });
    const result = await agent.conversationTurn({ message });
    const events = await agent.state.listEvents(result.run.id);
    return { result, seen, compactions: events.filter((event) => event.type === "runtime.compaction_completed") };
  }

  it("40K tokens of input: no compaction at 256K, compaction on a 32K model", async () => {
    const message = "资料：" + "负责数据分析，写周报。".repeat(5_800); // ~40K tokens (0.7 per CJK char)
    const roomy = await turn("deepseek-v4-flash", message);
    expect(roomy.result.run.llm_runtime).toMatchObject({ context_window: 262_144, max_steps: MAX_STEPS });
    expect(roomy.compactions).toHaveLength(0);
    const tight = await turn("moonshot-v1-32k", message);
    expect(tight.result.run.llm_runtime).toMatchObject({ context_window: 32_768 });
    expect(tight.compactions.length).toBeGreaterThan(0);
  });

  it("defaults to 12 steps, written into the prompt", async () => {
    expect(MAX_STEPS).toBe(12);
    const { seen } = await turn("fake-1", "你好");
    expect(String(seen[0].messages[0].content)).toContain("最多调用 12 轮工具");
  });
});

describe("settings: agent_context_window / context_window / agent_max_steps", () => {
  it("normalizes the new fields", () => {
    const defaults = normalizeConfig({});
    expect(defaults).toMatchObject({ agent_context_window: 0, agent_max_steps: 12 });
    const cfg = normalizeConfig({
      agent_context_window: 131_072,
      agent_max_steps: 99,
      llm_api_configs: [{ id: "a", provider_id: "deepseek", context_window: "500000" }] as unknown as StoredConfig["llm_api_configs"],
    });
    expect(cfg.agent_context_window).toBe(131_072);
    expect(cfg.agent_max_steps).toBe(12); // out of 1–40 → default
    expect(cfg.llm_api_configs[0].context_window).toBe(500_000);
    expect(normalizeConfig({ agent_max_steps: 20 }).agent_max_steps).toBe(20);
  });

  it("a run reads them from /api/config and still caps at the model limit", async () => {
    const store = new SqliteCoreStore(":memory:");
    stores.push(store);
    const sse = 'data: {"choices":[{"delta":{"content":"好的"}}]}\n\n'
      + 'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}\n\n'
      + "data: [DONE]\n\n";
    const bodies: Array<Record<string, any>> = [];
    const fetchFn = async (_input: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body || "{}")));
      return new Response(sse, { status: 200, headers: { "Content-Type": "text/event-stream" } });
    };
    let saved: Partial<StoredConfig> = {
      agent_context_window: 65_536,
      agent_max_steps: 5,
      llm_api_configs: [
        { id: "ds", provider_id: "deepseek", base_url: "https://api.deepseek.com", model: "deepseek-v4-flash", api_key: "sk-abcdefghijklmnop1234", models: {} },
        { id: "mo", provider_id: "moonshot", base_url: "https://api.moonshot.cn/v1", model: "moonshot-v1-32k", api_key: "sk-abcdefghijklmnop1234", models: {}, context_window: 1_000_000 },
      ] as StoredConfig["llm_api_configs"],
      active_llm_config_id: "ds",
    };
    const configStore: ConfigStore = { async load() { return saved; }, async save(config) { saved = JSON.parse(JSON.stringify(config)); } };
    const config = new ConfigRuntime(configStore, fetchFn);
    const app = createApp({ store, runtime: "browser", storage: "indexeddb", config, llm: (choice) => config.llm(choice), llmFetch: fetchFn, agentRuns: new MemoryAgentRunStore() });
    const post = async (body: unknown) => (await app.request("/api/agent/runtime/runs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })).json() as Promise<any>;

    const global = await post({ message: "你好" });
    expect(global.run.llm_runtime).toMatchObject({ model: "deepseek-v4-flash", context_window: 65_536, max_steps: 5 });
    const capped = await post({ message: "你好", llm_config_id: "mo" });
    expect(capped.run.llm_runtime).toMatchObject({ model: "moonshot-v1-32k", context_window: 32_768 });
    const override = await post({ message: "你好", max_steps: 20 });
    expect(override.run.llm_runtime).toMatchObject({ max_steps: 20 });

    const models = await (await app.request("/api/agent/runtime/models")).json() as any;
    const moonshot = models.services.find((service: { config_id: string }) => service.config_id === "mo");
    expect(moonshot.models[0]).toMatchObject({ id: "moonshot-v1-32k", context_limit: 32_768, context_window: 32_768 });
  });
});
