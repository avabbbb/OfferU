// Run reliability (packages/core/src/agent/stream-guard.ts, compaction.ts): staged retry before the
// first byte (429 / stall), no retry once output started (idle stall fails the run, resumable),
// context compaction that keeps references and confirmed evidence, and one aggressive retry on a
// provider overflow error.

import { afterEach, describe, expect, it } from "vitest";

import {
  compactSession,
  createAgentRuntime,
  estimateMessages,
  saveRecord,
  type ChatMessage,
  type ChatRequest,
  type LlmClient,
  type LlmStreamEvent,
  type ParsedToolCall,
} from "@offeru/core";

import { SqliteAgentRunStore } from "../src/agent-store";
import { SqliteCoreStore } from "../src/store";

type Step =
  | { kind: "text"; text: string }
  | { kind: "calls"; calls: Array<{ name: string; args: Record<string, unknown> }> }
  | { kind: "http"; status: number; error: string }
  | { kind: "hang" }
  | { kind: "text_then_hang"; text: string };

const usage = { input_tokens: 10, output_tokens: 5, total_tokens: 15, estimated: false };

/** Each completeStream call plays the next step; "hang" waits until the request is aborted. */
function stepLlm(steps: Step[], seen: ChatRequest[]): LlmClient {
  const waitAbort = (signal?: AbortSignal) => new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve();
    signal?.addEventListener("abort", () => resolve());
  });
  return {
    provider: "fake",
    model: "fake-1",
    async chat() { return null; },
    async *completeStream(request: ChatRequest): AsyncIterable<LlmStreamEvent> {
      seen.push(request);
      const step = steps.shift() ?? { kind: "text", text: "好。" };
      if (step.kind === "hang") { await waitAbort(request.signal); return; }
      if (step.kind === "text_then_hang") {
        yield { type: "text_delta", text: step.text };
        await waitAbort(request.signal);
        return;
      }
      if (step.kind === "http") {
        yield { type: "done", result: { provider: "fake", model: "fake-1", content: "", reasoning: "", toolCalls: [], finishReason: "error", usage, error: step.error, errorStatus: step.status } };
        return;
      }
      const toolCalls: ParsedToolCall[] = step.kind === "calls" ? step.calls.map((call, index) => ({ id: `call_${seen.length}_${index}`, name: call.name, arguments: JSON.stringify(call.args), args: call.args })) : [];
      const text = step.kind === "text" ? step.text : "";
      if (text) yield { type: "text_delta", text };
      yield { type: "done", result: { provider: "fake", model: "fake-1", content: text, reasoning: "", toolCalls, finishReason: toolCalls.length ? "tool_calls" : "stop", usage } };
    },
  };
}

let stores: SqliteCoreStore[] = [];
afterEach(() => {
  for (const store of stores) store.close();
  stores = [];
});

const FAST = { firstByteMs: 80, idleMs: 80, retries: 2, backoffMs: [0] };

function host(steps: Step[], extra: { compaction?: { windowTokens: number; reserveTokens: number; keepRecentTokens: number } } = {}) {
  const store = new SqliteCoreStore(":memory:");
  stores.push(store);
  const seen: ChatRequest[] = [];
  const runs = new SqliteAgentRunStore(store);
  const agent = createAgentRuntime({ store, runs, llm: () => stepLlm(steps, seen), streamGuard: FAST, compaction: extra.compaction });
  return { agent, store, runs, seen };
}

describe("stream guard", () => {
  it("429 before any output: retries, the save runs once, the retry is in the run log", async () => {
    const { agent, store, seen } = host([
      { kind: "http", status: 429, error: "429 Too Many Requests" },
      { kind: "calls", calls: [{ name: "save", args: { type: "memory", data: { kind: "skill", title: "SQL", body: "会写窗口函数" } } }] },
      { kind: "http", status: 503, error: "503 Service Unavailable" },
      { kind: "text", text: "记下了。" },
    ]);
    const result = await agent.conversationTurn({ message: "记一下我会 SQL" });
    expect(result.ok).toBe(true);
    expect(result.assistant_message).toBe("记下了。");
    expect(seen).toHaveLength(4);
    expect(await store.all("memory")).toHaveLength(1);
    const events = await agent.state.listEvents(result.run.id);
    const retries = events.filter((event) => event.type === "runtime.retry_started").map((event) => event.payload);
    expect(retries).toMatchObject([{ attempt: 1, reason: "upstream_error" }, { attempt: 1, reason: "upstream_error" }]);
  });

  it("a stalled first byte is retried; a 401 is not", async () => {
    const stalled = host([{ kind: "hang" }, { kind: "text", text: "好的。" }]);
    expect((await stalled.agent.conversationTurn({ message: "你好" })).assistant_message).toBe("好的。");
    expect(stalled.seen).toHaveLength(2);

    const denied = host([{ kind: "http", status: 401, error: "401 invalid api key" }, { kind: "text", text: "不该到这" }]);
    const result = await denied.agent.conversationTurn({ message: "你好" });
    expect(result.ok).toBe(false);
    expect(denied.seen).toHaveLength(1);
  });

  it("gives up after the retry budget with the reason", async () => {
    const { agent, seen } = host([{ kind: "hang" }, { kind: "hang" }, { kind: "hang" }, { kind: "text", text: "x" }]);
    const result = await agent.conversationTurn({ message: "你好" });
    expect(result.ok).toBe(false);
    expect(seen).toHaveLength(3);
    expect(result.errors?.[0]).toMatch(/没有返回任何内容（已重试 2 次）/);
  });

  it("an idle stall after output fails the run without replaying it", async () => {
    const { agent, seen } = host([{ kind: "text_then_hang", text: "我先看看" }, { kind: "text", text: "重复" }]);
    const result = await agent.conversationTurn({ message: "你好" });
    expect(result.ok).toBe(false);
    expect(result.errors?.[0]).toMatch(/输出中断/);
    expect(seen).toHaveLength(1);
  });
});

describe("context compaction", () => {
  const page = "正文".repeat(6000);
  const session = (): ChatMessage[] => [
    { role: "user", content: "帮我调研岗位 #3 并更新简历" },
    { role: "assistant", content: "", tool_calls: [{ id: "a", type: "function", function: { name: "get", arguments: "{\"type\":\"job\",\"id\":3}" } }] },
    { role: "tool", tool_call_id: "a", name: "get", content: JSON.stringify({ type: "job", id: 3, company: "飞书", title: "数据分析实习", jd: "要求".repeat(3000), docs: [{ type: "doc", id: 9, kind: "evaluation", body: "评估".repeat(2000) }] }) },
    { role: "assistant", content: "", tool_calls: [{ id: "b", type: "function", function: { name: "fetch_page", arguments: "{\"url\":\"https://jobs.feishu.cn/x\"}" } }] },
    { role: "tool", tool_call_id: "b", name: "fetch_page", content: JSON.stringify({ url: "https://jobs.feishu.cn/x", title: "飞书招聘", text: page }) },
    { role: "assistant", content: "", tool_calls: [{ id: "c", type: "function", function: { name: "search", arguments: "{\"query\":\"SQL\"}" } }] },
    { role: "tool", tool_call_id: "c", name: "search", content: JSON.stringify({ results: [{ type: "memory", id: 12, kind: "project", title: "留存分析", confirmed: true, body: "用 SQL 做了 30 日留存分析，留存提升 2.1 个百分点" }, { type: "memory", id: 13, confirmed: false, title: "自评", body: "评估分 6.4".repeat(200) }], remaining: 2 }) },
    { role: "assistant", content: "", tool_calls: [{ id: "d", type: "function", function: { name: "save", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "d", name: "save", content: JSON.stringify({ ok: true, change_id: 41, record: { type: "doc", id: 15, kind: "research" } }) },
  ];

  it("keeps the goal, the tool-call pairing, references and confirmed evidence; drops raw bodies", () => {
    const messages = session();
    const out = compactSession(messages, 1000, { windowTokens: 12_000, reserveTokens: 2_000, keepRecentTokens: 200 });
    expect(out.compacted).toBe(true);
    expect(out.after).toBeLessThan(out.before / 3);
    expect(out.messages.map((message) => [message.role, message.tool_call_id ?? ""])).toEqual(messages.map((message) => [message.role, message.tool_call_id ?? ""]));
    expect(out.messages[0]).toEqual(messages[0]);
    const text = JSON.stringify(out.messages);
    expect(text).not.toContain("正文正文正文正文正文正文正文正文正文正文正文正文正文正文正文正文正文正文正文正文正文正文正文正文正文正文正文正文正文正文正文正文正文正文正文正文正文正文正文正文正文正文正文正文正文正文正文正文正文正文正文正文正文正文正文正文正文正文正文正文正文正文正文正文正文正文正文正文正文正文正文正文正文正文正文正文正文正文正文正文正文正文");
    expect(text).toContain("用 SQL 做了 30 日留存分析，留存提升 2.1 个百分点");
    expect(text).toContain("https://jobs.feishu.cn/x");
    expect(out.ledger).toMatch(/岗位 #3/);
    expect(out.ledger).toMatch(/已确认的证据（记忆） #12/);
    expect(out.ledger).toMatch(/文档 #9 #15/);
    expect(out.ledger).toMatch(/本轮改动 #41/);
    expect(out.ledger).toMatch(/还有 2 个岗位没评估/);
    // the newest message stays verbatim
    expect(out.messages.at(-1)).toEqual(messages.at(-1));
  });

  it("under budget nothing changes", () => {
    const messages = session().slice(0, 2);
    const out = compactSession(messages, 100);
    expect(out.compacted).toBe(false);
    expect(out.after).toBe(estimateMessages(messages) + 100);
  });

  it("a long research run compacts mid-run and still finishes; overflow from the provider compacts harder once", async () => {
    const { agent, store, seen } = host([
      { kind: "calls", calls: [{ name: "get", args: { type: "job", id: 1 } }] },
      { kind: "http", status: 400, error: "This model's maximum context length is 8192 tokens" },
      { kind: "text", text: "调研写好了。" },
    ], { compaction: { windowTokens: 16_000, reserveTokens: 2_000, keepRecentTokens: 300 } });
    await saveRecord(store, { type: "job", data: { company: "飞书", title: "数据分析实习", jd: "岗位要求很长".repeat(4000) } }, { actor: "你", now: "2026-11-18T00:00:00+00:00", today: "2026-11-18" });
    const result = await agent.conversationTurn({ message: "调研一下岗位 #1" });
    expect(result.ok).toBe(true);
    expect(result.assistant_message).toBe("调研写好了。");
    const events = await agent.state.listEvents(result.run.id);
    const compactions = events.filter((event) => event.type === "runtime.compaction_completed").map((event) => event.payload);
    expect(compactions.map((payload) => payload.aggressive)).toEqual([false, true]);
    expect(Number(compactions[0].after_tokens)).toBeLessThan(Number(compactions[0].before_tokens) / 2);
    expect(JSON.stringify(seen[1].messages)).not.toContain("岗位要求很长".repeat(100));
    expect(String(seen[1].messages[0].content)).toContain("岗位 #1");
    expect(String(seen.at(-1)?.messages[0].content)).toContain("较早的工具结果已压缩");
    expect(agent.status()).toMatchObject({ features: { compaction: true } });
  });
});
