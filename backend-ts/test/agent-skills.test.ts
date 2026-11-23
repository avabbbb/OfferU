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
const system = (request: ChatRequest) => String(request.messages[0].content);

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

  it("the prompt keeps a stable prefix: per-run memory, overview and loaded skills come last", async () => {
    const { send, seen } = setup([{ text: "好。" }, { text: "第 1 题：讲讲你自己。" }]);
    await send("今天要做什么");
    await send("帮我模拟面试这个岗位");
    const stableOf = (text: string) => text.slice(0, text.indexOf("用户的记忆索引"));
    const [plain, mock] = [system(seen[0]), system(seen[1])];
    expect(stableOf(plain).length).toBeGreaterThan(200);
    expect(stableOf(plain)).toBe(stableOf(mock));
    expect(stableOf(plain)).toContain("技能索引");
    expect(stableOf(plain)).not.toContain("今天是");
    expect(mock.indexOf(MOCK_RULE)).toBeGreaterThan(mock.indexOf("今天是"));
  });
});
