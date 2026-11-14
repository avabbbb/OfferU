import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  CoreError,
  createOpenAiLlm,
  isLocalLlmUrl,
  streamOrChat,
  AVAILABLE_PROVIDERS,
  ENDPOINT_PROTOCOL_TEMPLATES,
  PROVIDER_PRESETS,
  createLlmClient,
  desensitize,
  endpointFromSettings,
  extractJson,
  resolveLlmClientConfig,
  resolveModelForTier,
  restore,
  type FetchLike,
  type LlmStreamEvent,
} from "@offeru/core";

const pythonPresets = JSON.parse(readFileSync(new URL("./fixtures/llm_presets.python.json", import.meta.url), "utf8"));

function sseBody(chunks: unknown[]): { getReader(): { read(): Promise<{ done: boolean; value?: Uint8Array }> } } {
  const text = chunks.map((chunk) => `data: ${typeof chunk === "string" ? chunk : JSON.stringify(chunk)}\n\n`).join("");
  // Split mid-event to prove the parser buffers across reads.
  const bytes = new TextEncoder().encode(text);
  const parts = [bytes.slice(0, 7), bytes.slice(7, 61), bytes.slice(61)];
  return {
    getReader() {
      let i = 0;
      return { read: async () => (i < parts.length ? { done: false, value: parts[i++] } : { done: true }) };
    },
  };
}

type Call = { url: string; headers: Record<string, string>; body: any };

function fakeFetch(responses: Array<{ status?: number; chunks?: unknown[]; json?: unknown }>): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, headers: init?.headers ?? {}, body: init?.body ? JSON.parse(init.body) : null });
    const next = responses.shift() || { status: 500, json: { error: { message: "no more" } } };
    const status = next.status || 200;
    return {
      ok: status < 400,
      status,
      body: next.chunks ? sseBody(next.chunks) : null,
      text: async () => JSON.stringify(next.json ?? {}),
    };
  };
  return { fetch, calls };
}

async function collect(stream: AsyncIterable<LlmStreamEvent>): Promise<LlmStreamEvent[]> {
  const out: LlmStreamEvent[] = [];
  for await (const event of stream) out.push(event);
  return out;
}

const endpoint = { provider: "deepseek", baseUrl: "https://api.deepseek.com/", apiKey: "sk-test-123456789", model: "deepseek-v4-flash" };

describe("LlmClient (OpenAI-compatible)", () => {
  it("streams text, reasoning and fragmented tool calls like provider.py", async () => {
    const { fetch, calls } = fakeFetch([{
      chunks: [
        { choices: [{ delta: { reasoning_content: "想" } }] },
        { choices: [{ delta: { content: "好的" } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_a", function: { name: "get", arguments: "{\"type\":" } }] } }] },
        // name repeated on every fragment must not become "getget"
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: "get", arguments: "\"job\",\"id\":1}" } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 1, function: { arguments: "{}" } }] } }] }, // nameless slot: dropped
        { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
        { choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } },
        "[DONE]",
      ],
    }]);
    const client = createLlmClient(endpoint, { fetch });
    const events = await collect(client.completeStream({ messages: [{ role: "user", content: "hi" }], tools: [{ name: "get", description: "d", parameters: { type: "object" } }], reasoningEffort: "low" }));
    expect(calls[0].url).toBe("https://api.deepseek.com/chat/completions");
    expect(calls[0].headers.Authorization).toBe("Bearer sk-test-123456789");
    expect(calls[0].body).toMatchObject({ model: "deepseek-v4-flash", stream: true, stream_options: { include_usage: true }, reasoning_effort: "low" });
    expect(calls[0].body.tools[0]).toEqual({ type: "function", function: { name: "get", description: "d", parameters: { type: "object" } } });
    expect(events.filter((e) => e.type === "text_delta")).toEqual([{ type: "text_delta", text: "好的" }]);
    const done = events.at(-1);
    expect(done?.type).toBe("done");
    if (done?.type !== "done") throw new Error("no done");
    expect(done.result.content).toBe("好的");
    expect(done.result.reasoning).toBe("想");
    expect(done.result.finishReason).toBe("tool_calls");
    expect(done.result.toolCalls).toEqual([{ id: "call_a", name: "get", arguments: "{\"type\":\"job\",\"id\":1}", args: { type: "job", id: 1 } }]);
    expect(done.result.usage).toEqual({ input_tokens: 10, output_tokens: 5, total_tokens: 15, estimated: false });
  });

  it("retries once without stream_options / reasoning_effort on 400", async () => {
    const { fetch, calls } = fakeFetch([
      { status: 400, json: { error: { message: "unknown field stream_options" } } },
      { chunks: [{ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] }] },
    ]);
    const events = await collect(createLlmClient(endpoint, { fetch }).completeStream({ messages: [{ role: "user", content: "hi" }], reasoningEffort: "high" }));
    expect(calls).toHaveLength(2);
    expect(calls[1].body.stream_options).toBeUndefined();
    expect(calls[1].body.reasoning_effort).toBeUndefined();
    const done = events.at(-1);
    expect(done?.type === "done" && done.result.content).toBe("ok");
  });

  it("ends the stream with a sanitized error instead of throwing", async () => {
    const { fetch } = fakeFetch([{ status: 401, json: { error: { message: "bad key sk-abcdefghijklmnop" } } }]);
    const events = await collect(createLlmClient(endpoint, { fetch }).completeStream({ messages: [{ role: "user", content: "hi" }] }));
    const done = events.at(-1);
    if (done?.type !== "done") throw new Error("no done");
    expect(done.result.finishReason).toBe("error");
    expect(done.result.error).toContain("认证失败");
    expect(done.result.error).not.toContain("sk-abcdefghijklmnop");
  });

  it("chat() supports json mode and tool calls", async () => {
    const { fetch, calls } = fakeFetch([{ json: { choices: [{ message: { content: "{\"a\":1}", tool_calls: [] }, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 2 } } }]);
    const result = await createLlmClient({ ...endpoint, supportsJsonMode: true }, { fetch }).complete({ messages: [{ role: "user", content: "x" }], json: true, maxTokens: 50 });
    expect(calls[0].body.response_format).toEqual({ type: "json_object" });
    expect(calls[0].body.max_tokens).toBe(50);
    expect(calls[0].body.stream).toBeUndefined();
    expect(extractJson(result.content)).toEqual({ a: 1 });
    expect(result.usage.total_tokens).toBe(5);
  });

  it("chat() throws a forbidden CoreError on 401", async () => {
    const { fetch } = fakeFetch([{ status: 401, json: { error: "nope" } }]);
    await expect(createLlmClient(endpoint, { fetch }).complete({ messages: [] })).rejects.toMatchObject({ code: "forbidden" });
  });
});

describe("LlmClient (Anthropic Messages)", () => {
  it("translates messages and streamed blocks", async () => {
    const { fetch, calls } = fakeFetch([{
      chunks: [
        { type: "message_start", message: { usage: { input_tokens: 7 } } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "嗨" } },
        { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "tu_1", name: "search" } },
        { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "{\"q\":\"x\"}" } },
        { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 4 } },
      ],
    }]);
    const client = createLlmClient({ provider: "custom", baseUrl: "https://api.anthropic.com", apiKey: "k", model: "claude", apiFormat: "anthropic" }, { fetch });
    const events = await collect(client.completeStream({
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: "q" },
        { role: "assistant", content: "", tool_calls: [{ id: "t0", type: "function", function: { name: "get", arguments: "{\"id\":1}" } }] },
        { role: "tool", tool_call_id: "t0", content: "{}" },
      ],
      tools: [{ name: "search", description: "s", parameters: { type: "object" } }],
    }));
    expect(calls[0].url).toBe("https://api.anthropic.com/v1/messages");
    expect(calls[0].headers["x-api-key"]).toBe("k");
    expect(calls[0].body.system).toBe("sys");
    expect(calls[0].body.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "q" }] },
      { role: "assistant", content: [{ type: "tool_use", id: "t0", name: "get", input: { id: 1 } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t0", content: "{}" }] },
    ]);
    expect(calls[0].body.tools).toEqual([{ name: "search", description: "s", input_schema: { type: "object" } }]);
    const done = events.at(-1);
    if (done?.type !== "done") throw new Error("no done");
    expect(done.result).toMatchObject({ content: "嗨", finishReason: "tool_calls", toolCalls: [{ id: "tu_1", name: "search", args: { q: "x" } }] });
    expect(done.result.usage).toMatchObject({ input_tokens: 7, output_tokens: 4, estimated: false });
  });
});

describe("LLM presets and config resolution (parity with Python)", () => {
  it("presets are a data copy of llm_presets.py", () => {
    expect(PROVIDER_PRESETS).toEqual(pythonPresets.presets);
    expect(ENDPOINT_PROTOCOL_TEMPLATES).toEqual(pythonPresets.templates);
    expect(AVAILABLE_PROVIDERS).toEqual(pythonPresets.available);
  });

  it("resolves the active config, per-run choice and tiers", () => {
    const settings = {
      active_llm_config_id: "b",
      llm_api_configs: [
        { id: "a", provider_id: "deepseek", base_url: "https://api.deepseek.com/", api_key: "sk-a", model: "deepseek-v4-flash", models: { premium: "deepseek-v4-pro" } },
        { id: "b", service_name: "Kimi", base_url: "https://api.moonshot.cn/v1", api_key: "env:KIMI_KEY", model: "kimi-k2", supports_json_mode: "false" },
      ],
    };
    const env = (name: string) => (name === "KIMI_KEY" ? "sk-kimi" : undefined);
    const active = resolveLlmClientConfig(settings, { env });
    expect(active).toMatchObject({ provider: "kimi", service_name: "Kimi", api_key: "sk-kimi", base_url: "https://api.moonshot.cn/v1", supports_json_mode: false, source: "active_config", api_format: "openai" });
    expect(() => resolveLlmClientConfig(settings)).toThrow("环境变量未解析");
    const chosen = endpointFromSettings(settings, "premium", { llmConfigId: "a", env });
    expect(chosen).toMatchObject({ provider: "deepseek", baseUrl: "https://api.deepseek.com", model: "deepseek-v4-pro" });
    expect(resolveModelForTier(settings, "fast", { llmConfigId: "a" })).toBe("deepseek-v4-flash");
  });

  it("local endpoints need no key; missing config is an invalid CoreError", () => {
    expect(resolveLlmClientConfig({ llm_api_configs: [{ provider_id: "ollama", base_url: "http://127.0.0.1:11434/v1", model: "qwen2.5:7b" }] }))
      .toMatchObject({ api_key: "local", source: "ollama" });
    expect(() => resolveLlmClientConfig({})).toThrow("还没有配置模型服务");
    expect(resolveLlmClientConfig({ llm_provider: "ollama" }).base_url).toBe("http://localhost:11434/v1");
    expect(resolveModelForTier({ llm_provider: "qwen" }, "premium")).toBe("qwen3.6-plus");
    expect(() => resolveLlmClientConfig({ llm_provider: "qwen", qwen_api_key: "k", disabled_llm_providers: ["qwen"] })).toThrow("已被禁用");
  });
});

describe("PII desensitize", () => {
  it("masks phone / email / id card and restores loose placeholders", () => {
    const { text, mapping } = desensitize("电话 13812345678，邮箱 a.b@x.com，身份证 11010119900307123X，再次 13812345678");
    expect(text).not.toContain("13812345678");
    expect(text).not.toContain("a.b@x.com");
    expect(Object.keys(mapping)).toHaveLength(3);
    expect(restore(text, mapping)).toBe("电话 13812345678，邮箱 a.b@x.com，身份证 11010119900307123X，再次 13812345678");
    const email = Object.keys(mapping).find((key) => key.includes("EMAIL"))!;
    expect(restore(`发到 ${email.slice(1, -3)}`, mapping)).toBe("发到 a.b@x.com");
  });
});

// ---- core-tools chat()/chatStream() surface ----

function fakeTextFetch(replies: Array<{ status: number; body: unknown }>, seen: Array<Record<string, unknown>> = []): FetchLike {
  return async (_url, init) => {
    seen.push(JSON.parse(init?.body ?? "{}"));
    const next = replies.shift() ?? { status: 500, body: {} };
    return { ok: next.status < 400, status: next.status, text: async () => typeof next.body === "string" ? next.body : JSON.stringify(next.body) };
  };
}

const answer = (content: string) => ({ status: 200, body: { choices: [{ message: { content } }] } });

describe("extractJson (Python extract_json parity)", () => {
  it("parses plain, fenced and embedded objects", () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
    expect(extractJson('看：\n```json\n{"a":2}\n```')).toEqual({ a: 2 });
    expect(extractJson('前言 {"a":"}"} 后记 {"b":1}')).toEqual({ a: "}" });
    expect(extractJson("没有 json")).toBeNull();
    expect(extractJson("")).toBeNull();
  });
});

describe("createOpenAiLlm", () => {
  it("sends json mode, appends the json hint, uses tier model", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const llm = createOpenAiLlm({ baseUrl: "https://x/v1/", model: "m", models: { fast: "f" }, fetch: fakeTextFetch([answer("{}")], seen) });
    expect(await llm.chat([{ role: "user", content: "hi" }], { json: true, tier: "fast", maxTokens: 10 })).toBe("{}");
    expect(seen[0].model).toBe("f");
    expect(seen[0].response_format).toEqual({ type: "json_object" });
    expect(seen[0].max_completion_tokens).toBe(30);
    expect((seen[0].messages as Array<{ content: string }>)[0].content).toContain("Return JSON only.");
  });

  it("retries 429/5xx, falls back to max_tokens, null on failure, throws on bad key", async () => {
    const sleep = async () => {};
    const retry = createOpenAiLlm({ baseUrl: "https://x", model: "m", sleep, fetch: fakeTextFetch([{ status: 429, body: "" }, answer("ok")]) });
    expect(await retry.chat([{ role: "user", content: "q" }])).toBe("ok");

    const seen: Array<Record<string, unknown>> = [];
    const old = createOpenAiLlm({ baseUrl: "https://x", model: "m", sleep, fetch: fakeTextFetch([{ status: 400, body: "unknown max_completion_tokens" }, answer("ok")], seen) });
    expect(await old.chat([{ role: "user", content: "q" }], { maxTokens: 7 })).toBe("ok");
    expect(seen[1].max_tokens).toBe(7);

    const down = createOpenAiLlm({ baseUrl: "https://x", model: "m", sleep, fetch: fakeTextFetch([{ status: 500, body: "" }, { status: 500, body: "" }, { status: 500, body: "" }]) });
    expect(await down.chat([{ role: "user", content: "q" }])).toBeNull();

    const bad = createOpenAiLlm({ baseUrl: "https://x", model: "m", sleep, fetch: fakeTextFetch([{ status: 401, body: "" }]) });
    await expect(bad.chat([{ role: "user", content: "q" }])).rejects.toBeInstanceOf(CoreError);
  });
});

describe("chatStream", () => {
  it("parses SSE deltas and falls back to chat in streamOrChat", async () => {
    const sse = 'data: {"choices":[{"delta":{"content":"你"}}]}\n\ndata: {"choices":[{"delta":{"content":"好"}}]}\n\ndata: [DONE]\n\n';
    const fetch: FetchLike = async () => ({
      ok: true, status: 200, text: async () => sse,
      body: new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(sse)); c.close(); } }),
    });
    const llm = createOpenAiLlm({ baseUrl: "http://127.0.0.1:11434/v1", model: "m", fetch });
    expect(llm.local).toBe(true);
    const parts: string[] = [];
    for await (const part of llm.chatStream!([{ role: "user", content: "q" }])) parts.push(part);
    expect(parts.join("")).toBe("你好");
    const plain = { chat: async () => "整段" };
    const out: string[] = [];
    for await (const part of streamOrChat(plain, [{ role: "user", content: "q" }])) out.push(part);
    expect(out).toEqual(["整段"]);
    expect(isLocalLlmUrl("https://api.deepseek.com/v1")).toBe(false);
  });
});
