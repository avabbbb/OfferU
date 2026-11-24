// Progressive Skill loading (packages/core/src/agent/skills.ts): the system prompt carries the core
// rules + a skill index; a skill whose triggers match the message or the recent conversation is
// loaded up front, the rest are read with skill_read. Driven through the real HTTP run endpoint.

import { afterEach, describe, expect, it } from "vitest";

import { AGENT_SKILLS, CORE_RULES, type ChatRequest, type LlmClient, type LlmStreamEvent, type ParsedToolCall } from "@offeru/core";

import { SqliteAgentRunStore } from "../src/agent-store";
import { createApp } from "../src/app";
import { SqliteCoreStore } from "../src/store";

type Turn = { text?: string; calls?: Array<{ name: string; args: Record<string, unknown> }> };

function scriptedLlm(turns: Turn[], seen: ChatRequest[]): LlmClient {
  return {
    provider: "fake",
    model: "fake-1",
    async chat() { return null; },
    async *completeStream(request: ChatRequest): AsyncIterable<LlmStreamEvent> {
      seen.push(request);
      const turn = turns.shift() ?? { text: "好。" };
      const toolCalls: ParsedToolCall[] = (turn.calls || []).map((call, index) => ({ id: `call_${index}`, name: call.name, arguments: JSON.stringify(call.args), args: call.args }));
      if (turn.text) yield { type: "text_delta", text: turn.text };
      yield { type: "done", result: { provider: "fake", model: "fake-1", content: turn.text || "", reasoning: "", toolCalls, finishReason: toolCalls.length ? "tool_calls" : "stop", usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15, estimated: false } } };
    },
  };
}

let stores: SqliteCoreStore[] = [];
afterEach(() => {
  for (const store of stores) store.close();
  stores = [];
});

function setup(turns: Turn[]) {
  const store = new SqliteCoreStore(":memory:");
  stores.push(store);
  const seen: ChatRequest[] = [];
  const app = createApp({ store, runtime: "node", storage: "sqlite", agentRuns: new SqliteAgentRunStore(store), llm: () => scriptedLlm(turns, seen) });
  const send = async (message: string, conversationId?: string) => {
    const response = await app.request("/api/agent/runtime/runs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message, conversation_id: conversationId }) });
    expect(response.status).toBe(200);
    return await response.json() as { conversation_id: string };
  };
  return { send, seen };
}

const MOCK_RULE = "这条回复只用一个问题追问他具体做了什么或结果";
/** The system prompt plus the per-run context the loop carries on this run's user message. */
const system = (request: ChatRequest) => request.messages.filter((message) => message.role === "system" || message.role === "user").map((message) => String(message.content)).join("\n");
const systemOnly = (request: ChatRequest) => String(request.messages[0].content);

describe("progressive skills", () => {
  it("a plain request gets the core rules and the index, not the skill bodies", async () => {
    const { send, seen } = setup([{ text: "你好。" }]);
    await send("今天要做什么");
    expect(system(seen[0])).toContain(CORE_RULES.trim());
    expect(system(seen[0])).toContain("技能索引");
    for (const skill of AGENT_SKILLS) expect(system(seen[0])).toContain(`- ${skill.id}（`);
    expect(system(seen[0])).not.toContain(MOCK_RULE);
    expect(system(seen[0])).not.toContain("## 面试方案 里加「Gap 质疑题」");
    expect(seen[0].tools?.map((tool) => tool.name)).toContain("skill_read");
  });

  it("mock interview rules load up front, and stay loaded on a vague follow-up answer in the same conversation", async () => {
    const { send, seen } = setup([{ text: "第 1 题：讲讲你做过的数据分析项目。" }, { text: "你具体用 SQL 做了什么？" }]);
    const first = await send("帮我模拟面试这个岗位");
    expect(system(seen[0])).toContain(MOCK_RULE);
    expect(system(seen[0])).toContain("interview-practice（模拟面试与面试准备）：模拟面试、押题、自我介绍、面试复盘 · 已加载");
    await send("就是用 SQL 查了一些数据", first.conversation_id);
    expect(system(seen[1])).toContain(MOCK_RULE);
  });

  it("skill_read returns the full method; an unknown id says which exist", async () => {
    const { send, seen } = setup([
      { calls: [{ name: "skill_read", args: { id: "role-research" } }, { name: "skill_read", args: { id: "salary" } }] },
      { text: "好。" },
    ]);
    await send("今天要做什么");
    const replies = seen[1].messages.filter((message) => message.role === "tool").map((message) => JSON.parse(String(message.content)));
    expect(replies[0]).toMatchObject({ ok: true, id: "role-research" });
    expect(replies[0].body).toContain("## 面试方案 里加「Gap 质疑题」");
    expect(replies[1]).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(replies[1].error.suggestedAction).toContain("interview-practice");
  });

  it("the system prompt is identical across runs; memory, overview and loaded skills ride on the run's user message", async () => {
    const { send, seen } = setup([{ text: "好。" }, { text: "第 1 题：讲讲你自己。" }]);
    const first = await send("今天要做什么");
    await send("帮我模拟面试这个岗位", first.conversation_id);
    const [plain, mock] = [systemOnly(seen[0]), systemOnly(seen[1])];
    expect(plain.length).toBeGreaterThan(200);
    expect(plain).toBe(mock);
    expect(plain).toContain("技能索引");
    expect(plain).not.toContain("今天是");
    expect(plain).not.toContain(MOCK_RULE);
    const user = String(seen[1].messages.at(-1)?.content);
    // earlier turns come first (part of the cacheable prefix), then this run's context, then the request
    expect(user.startsWith("Prior task conversation")).toBe(true);
    expect(user.indexOf("今天要做什么")).toBeLessThan(user.indexOf("今天是"));
    expect(user).toContain(MOCK_RULE);
    expect(user.endsWith("Current user request:\n帮我模拟面试这个岗位")).toBe(true);
    // a first run has no earlier turns: the context leads the message
    expect(String(seen[0].messages.at(-1)?.content).endsWith("今天要做什么")).toBe(true);
  });
});
