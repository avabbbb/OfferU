// TTFT and prompt-cache guarantees of the built-in Agent (docs/perf/agent-latency-cache.md):
// streamed deltas reach the listener before the provider stream ends, every turn re-sends the
// previous turn's request bytes unchanged (PII placeholders included), a new run keeps the
// tools + system prefix even when the user's data and the date context changed, and cache /
// latency numbers land in the run trace.

import { afterEach, describe, expect, it } from "vitest";

import {
  MemoryAgentRunStore,
  PiiMasker,
  createAgentRuntime,
  createLlmClient,
  runAgentLoop,
  saveRecord,
  type AgentTool,
  type FetchLike,
} from "@offeru/core";

import { SqliteCoreStore } from "../src/store";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type Sent = { at: number; body: any; end?: number };

/**
 * OpenAI-compatible provider over a mock fetch: each request streams `script(n)` as SSE,
 * one event every `gap` ms (the first after `first` ms).
 */
function delayedProvider(script: (n: number) => unknown[], timing = { first: 20, gap: 60 }) {
  const sent: Sent[] = [];
  const fetch: FetchLike = async (_url, init) => {
    const call: Sent = { at: Date.now(), body: JSON.parse(init?.body || "{}") };
    const chunks = [...script(sent.length).map((event) => `data: ${JSON.stringify(event)}\n\n`), "data: [DONE]\n\n"]
      .map((text) => new TextEncoder().encode(text));
    sent.push(call);
    let i = 0;
    return {
      ok: true,
      status: 200,
      text: async () => "",
      body: {
        getReader: () => ({
          async read() {
            if (i >= chunks.length) return { done: true };
            await sleep(i === 0 ? timing.first : timing.gap);
            const value = chunks[i++];
            if (i === chunks.length) call.end = Date.now();
            return { done: false, value };
          },
        }),
      },
    };
  };
  return { fetch, sent };
}

const toolTurn = (n: number) => [
  { choices: [{ delta: { reasoning_content: "想一下" } }] },
  { choices: [{ delta: { content: "我先查一下。" } }] },
  { choices: [{ delta: { tool_calls: [{ index: 0, id: `call_${n}`, function: { name: "lookup", arguments: "" } }] } }] },
  { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "{\"q\":\"联系方式\"}" } }] }, finish_reason: "tool_calls" }] },
  { choices: [], usage: { prompt_tokens: 1200, completion_tokens: 20, prompt_tokens_details: { cached_tokens: n ? 1024 : 0 } } },
];
const answerTurn = () => [
  { choices: [{ delta: { content: "查到了。" }, finish_reason: "stop" }] },
  { choices: [], usage: { prompt_tokens: 1300, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 1152 } } },
];

const anthropicAnswer = () => [
  { type: "message_start", message: { usage: { input_tokens: 148, cache_read_input_tokens: 1152, cache_creation_input_tokens: 0, output_tokens: 1 } } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "查到了。" } },
  { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } },
];

const lookup: AgentTool = {
  name: "lookup",
  description: "查用户档案",
  parameters: { type: "object", properties: { q: { type: "string" } }, additionalProperties: false },
  async execute() {
    return { text: JSON.stringify({ phone: "13900001111", email: "me@example.com" }), isError: false };
  },
};

let stores: SqliteCoreStore[] = [];
afterEach(() => {
  for (const store of stores) store.close();
  stores = [];
});

describe("Agent TTFT: streaming end to end", () => {
  it("emits the first reasoning / text delta long before the provider stream ends", async () => {
    const { fetch, sent } = delayedProvider((n) => (n === 0 ? toolTurn(n) : answerTurn()));
    const client = createLlmClient({ provider: "deepseek", baseUrl: "https://api.deepseek.com", apiKey: "k", model: "m" }, { fetch });
    const seen: Array<{ type: string; at: number }> = [];
    const result = await runAgentLoop({
      client,
      systemPrompt: "sys",
      messages: [{ role: "user", content: "我的手机 13812345678，帮我查" }],
      tools: [lookup],
      softLimit: 4,
      hardLimit: 5,
      emit: (event) => { seen.push({ type: event.type, at: Date.now() }); },
    });
    expect(result.stopReason).toBe("stop");
    const firstThinking = seen.find((event) => event.type === "thinking_delta")!;
    const firstText = seen.find((event) => event.type === "text_delta")!;
    const toolStart = seen.find((event) => event.type === "tool_execution_start")!;
    // first delta ≈ 20 ms after the request; the turn's stream ends ≈ 320 ms after it
    expect(firstThinking.at - sent[0].at).toBeLessThan(150);
    expect(firstThinking.at).toBeLessThan(sent[0].end!);
    expect(firstText.at).toBeLessThan(sent[0].end!);
    expect(firstText.at).toBeLessThan(toolStart.at);
    // telemetry: TTFT, latency and provider cache numbers per turn
    expect(result.turnStats).toHaveLength(2);
    expect(result.turnStats[0].ttft_ms).toBeLessThan(150);
    expect(result.turnStats[0].llm_ms).toBeGreaterThanOrEqual(result.turnStats[0].ttft_ms!);
    expect(result.turnStats[1]).toMatchObject({ input_tokens: 1300, cached_input_tokens: 1152, estimated: false });
  });
});

describe("Agent prompt cache: byte-stable prefix", () => {
  it("turn 2 repeats turn 1's tools and messages byte for byte (PII placeholders included)", async () => {
    const { fetch, sent } = delayedProvider((n) => (n === 0 ? toolTurn(n) : answerTurn()), { first: 1, gap: 1 });
    const client = createLlmClient({ provider: "openai", baseUrl: "https://api.openai.com/v1", apiKey: "k", model: "m" }, { fetch });
    await runAgentLoop({
      client,
      systemPrompt: "sys",
      messages: [{ role: "user", content: "我的手机 13812345678，邮箱 me@example.com" }],
      tools: [lookup],
      softLimit: 4,
      hardLimit: 5,
      maskSeed: "run_1",
      cacheKey: "offeru-conv_1",
    });
    const [first, second] = sent.map((call) => call.body);
    expect(JSON.stringify(second.tools)).toBe(JSON.stringify(first.tools));
    expect(second.messages.slice(0, first.messages.length).map((m: unknown) => JSON.stringify(m)))
      .toEqual(first.messages.map((m: unknown) => JSON.stringify(m)));
    // nothing left in clear text, and the tool result reuses the user's placeholder for the same email
    const wire = JSON.stringify(second.messages);
    expect(wire).not.toContain("13812345678");
    expect(wire).not.toContain("me@example.com");
    expect(wire).not.toContain("13900001111");
    const emailPlaceholder = /\[__PII_EMAIL_1_[0-9a-f]{8}__\]/.exec(JSON.stringify(first.messages))![0];
    expect(wire.split(emailPlaceholder).length - 1).toBe(2);
    // OpenAI gets the session's prompt_cache_key
    expect(first.prompt_cache_key).toBe("offeru-conv_1");
  });

  it("a seeded masker reproduces the same placeholders after a resume", () => {
    const text = "电话 13812345678 邮箱 a@b.cn";
    expect(new PiiMasker("run_1").mask(text)).toBe(new PiiMasker("run_1").mask(text));
    expect(new PiiMasker("run_1").mask(text)).not.toBe(new PiiMasker("run_2").mask(text));
    const masker = new PiiMasker("run_1");
    const once = masker.mask(text);
    expect(masker.mask(`再说一次 ${"13812345678"}`)).toContain(/\[__PII_PHONE_1_[0-9a-f]{8}__\]/.exec(once)![0]);
  });

  it("two runs share tools + system; date, overview and memory go in the run's first user message", async () => {
    const store = new SqliteCoreStore(":memory:");
    stores.push(store);
    const user = () => ({ actor: "你", now: new Date().toISOString(), today: new Date().toISOString().slice(0, 10) });
    await saveRecord(store, { type: "memory", data: { kind: "preference", title: "不写实习时长", body: "简历里不写实习时长" } }, user());
    const { fetch, sent } = delayedProvider(() => anthropicAnswer(), { first: 1, gap: 1 });
    const client = createLlmClient({ provider: "anthropic", baseUrl: "https://api.anthropic.com", apiKey: "k", model: "claude", apiFormat: "anthropic" }, { fetch });
    const runs = new MemoryAgentRunStore();
    const host = createAgentRuntime({ store, runs, llm: () => client });
    const events: Array<{ type: string; payload: any }> = [];
    const first = await host.conversationTurn({ message: "看看现在的情况", listener: (event) => { events.push(event as never); } });
    await saveRecord(store, { type: "job", data: { company: "飞书", title: "数据分析实习", jd: "SQL" } }, user());
    await saveRecord(store, { type: "memory", data: { kind: "project", title: "增长分析", body: "做过漏斗分析" } }, user());
    await host.conversationTurn({ message: "再看一下" });

    const [a, b] = sent.map((call) => call.body);
    expect(JSON.stringify(b.tools)).toBe(JSON.stringify(a.tools));
    expect(JSON.stringify(b.system)).toBe(JSON.stringify(a.system));
    // static system: rules + confirmed preferences, no date / overview / memory index
    const system = a.system.map((block: any) => block.text).join("");
    expect(system).toContain("规则：");
    expect(system).toContain("- 不写实习时长：简历里不写实习时长");
    expect(system).not.toContain("今天是");
    expect(system).not.toContain("overview 摘要");
    // the dynamic context opens the run's user message instead, and reflects the new data in run 2
    const userText = (body: any) => body.messages[0].content[0].text as string;
    expect(userText(a)).toMatch(/^<context>\n今天是 \d{4}-\d{2}-\d{2}。\n用户现在的情况（overview 摘要）：/);
    expect(userText(a)).toContain("看看现在的情况");
    expect(userText(b)).toContain("增长分析");
    expect(userText(a)).not.toContain("增长分析");
    // Anthropic breakpoints: last tool, static system block, end of history
    expect(a.tools.at(-1).cache_control).toEqual({ type: "ephemeral" });
    expect(a.tools.slice(0, -1).every((tool: any) => !tool.cache_control)).toBe(true);
    expect(a.system[0].cache_control).toEqual({ type: "ephemeral" });
    expect(a.messages.at(-1).content.at(-1).cache_control).toEqual({ type: "ephemeral" });
    // tools are sorted by name
    const names = a.tools.map((tool: any) => tool.name);
    expect(names).toEqual([...names].sort());

    // trace: per-turn latency + cache numbers, run summary
    const completed = events.find((event) => event.type === "runtime.turn_completed")!;
    expect(completed.payload.llm).toMatchObject({ input_tokens: 1300, cached_input_tokens: 1152, cache_hit_rate: 0.886, estimated: false });
    expect(typeof completed.payload.llm.ttft_ms).toBe("number");
    expect(first.run.final_result.llm_stats).toMatchObject({ turns: 1, input_tokens: 1300, cached_input_tokens: 1152, cache_hit_rate: 0.886 });
  });
});
