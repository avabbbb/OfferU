// 多 Run 并发：准入在异步前占位、同一对话只跑一轮、对话追加是原子的、恢复也算名额。

import { afterEach, describe, expect, it } from "vitest";

import { AgentConversations, MemoryAgentRunStore, createAgentRuntime, type ChatRequest, type LlmClient, type LlmStreamEvent } from "@offeru/core";

import { SqliteAgentRunStore } from "../src/agent-store";
import { SqliteCoreStore } from "../src/store";

/** Every turn waits for `open` before answering, so runs overlap for as long as the test wants. */
function gatedLlm(open: Promise<void>, text = "好"): LlmClient {
  return {
    provider: "fake",
    model: "fake-1",
    async chat() { return null; },
    async *completeStream(_request: ChatRequest): AsyncIterable<LlmStreamEvent> {
      await open;
      yield { type: "text_delta", text };
      yield { type: "done", result: { provider: "fake", model: "fake-1", content: text, reasoning: "", toolCalls: [], finishReason: "stop", usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2, estimated: false } } };
    },
  };
}

function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => { open = resolve; });
  return { opened, open };
}

let stores: SqliteCoreStore[] = [];
afterEach(() => { for (const store of stores) store.close(); stores = []; });

function host(llm: LlmClient, maxConcurrentRuns: number | (() => Promise<number>) = 1) {
  const store = new SqliteCoreStore(":memory:");
  stores.push(store);
  return createAgentRuntime({ store, runs: new SqliteAgentRunStore(store), llm: () => llm, maxConcurrentRuns });
}

const settle = (promises: Array<Promise<unknown>>) => Promise.allSettled(promises);

describe("run admission", () => {
  it("concurrent starts cannot all slip past the limit while the first is still creating its record", async () => {
    const { opened, open } = gate();
    const agent = host(gatedLlm(opened), 1);
    const results = settle([agent.startRun({ message: "一" }), agent.startRun({ message: "二" }), agent.startRun({ message: "三" })]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    open();
    const outcomes = await results;
    expect(outcomes.filter((item) => item.status === "fulfilled")).toHaveLength(1);
    const refused = outcomes.filter((item): item is PromiseRejectedResult => item.status === "rejected");
    expect(refused).toHaveLength(2);
    for (const item of refused) expect(String(item.reason.message)).toContain("最大并发数 1");
  });

  it("the limit is read from settings on every admission", async () => {
    let limit = 1;
    const { opened, open } = gate();
    const agent = host(gatedLlm(opened), async () => limit);
    const first = agent.startRun({ message: "一" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    await expect(agent.startRun({ message: "二" })).rejects.toThrow(/最大并发数 1/);
    limit = 2;
    const second = agent.startRun({ message: "二" });
    open();
    await Promise.all([first, second]);
    expect(agent.maxConcurrentRuns()).toBe(2);
  });
});

describe("one turn per conversation", () => {
  it("a second turn in the same conversation is refused; another conversation runs in parallel", async () => {
    const { opened, open } = gate();
    const agent = host(gatedLlm(opened, "收到"), 3);
    const first = await agent.conversations.append(null, { role: "user", content: "你好" });
    const turn = agent.conversationTurn({ message: "改简历", conversation_id: first.id });
    await new Promise((resolve) => setTimeout(resolve, 10));
    await expect(agent.conversationTurn({ message: "再加一条", conversation_id: first.id })).rejects.toThrow(/这个对话还有一轮在运行/);
    const other = agent.conversationTurn({ message: "另一个话题" });
    open();
    const [a, b] = await Promise.all([turn, other]);
    expect(a.conversation_id).toBe(first.id);
    expect(b.conversation_id).not.toBe(first.id);
    const saved = await agent.conversations.get(first.id);
    expect(saved?.messages.map((message) => `${message.role}:${message.content}`)).toEqual(["user:你好", "user:改简历", "assistant:收到"]);
    // the refused turn left no orphan user message, and the conversation is free again
    await expect(agent.conversationTurn({ message: "现在可以了", conversation_id: first.id })).resolves.toMatchObject({ ok: true });
  });

  it("a turn refused at the run limit writes nothing into the conversation", async () => {
    const { opened, open } = gate();
    const agent = host(gatedLlm(opened), 1);
    const busy = agent.startRun({ message: "占住名额" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const conversation = await agent.conversations.append(null, { role: "user", content: "早" });
    await expect(agent.conversationTurn({ message: "被拒的一条", conversation_id: conversation.id })).rejects.toThrow(/最大并发数/);
    expect((await agent.conversations.get(conversation.id))?.messages).toHaveLength(1);
    open();
    await busy;
  });
});

describe("conversation append", () => {
  it("concurrent appends to one conversation keep every message", async () => {
    const conversations = new AgentConversations(new MemoryAgentRunStore());
    const created = await conversations.append(null, { role: "user", content: "0" });
    await Promise.all(Array.from({ length: 10 }, (_, index) => conversations.append(created.id, { role: "user", content: String(index + 1) })));
    expect((await conversations.get(created.id))?.messages).toHaveLength(11);
  });
});
