// 只读 Sub-agent：父 Agent 分出三份核查，一份失败另外两份照用，子任务拿不到写工具，父任务取消会传下去。

import { describe, expect, it } from "vitest";

import { createAgentRuntime, delegateTool, type AgentTool, type ChatRequest, type LlmClient, type LlmStreamEvent, type ParsedToolCall } from "@offeru/core";

import { SqliteAgentRunStore } from "../src/agent-store";
import { SqliteCoreStore } from "../src/store";

function done(text: string, calls: ParsedToolCall[] = []): LlmStreamEvent {
  return { type: "done", result: { provider: "fake", model: "fake-1", content: text, reasoning: "", toolCalls: calls, finishReason: calls.length ? "tool_calls" : "stop", usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2, estimated: false } } };
}

/** Parent turns are scripted; a child (system prompt mentions 子任务) answers by its title. */
function model(parentTurns: Array<{ text?: string; calls?: ParsedToolCall[] }>, seenChildTools: string[][]): LlmClient {
  return {
    provider: "fake",
    model: "fake-1",
    async chat() { return null; },
    async *completeStream(request: ChatRequest): AsyncIterable<LlmStreamEvent> {
      const system = String(request.messages[0]?.content ?? "");
      if (system.includes("只读核查子任务")) {
        seenChildTools.push((request.tools ?? []).map((tool) => tool.name));
        const brief = String(request.messages.at(-1)?.content ?? "");
        if (brief.includes("坏公司")) { yield done("", []); yield* []; return; }
        yield { type: "text_delta", text: "x" };
        const company = /【(.+?)】/.exec(brief)?.[1] ?? "?";
        yield done(JSON.stringify({ summary: `${company} 要 SQL`, findings: [{ claim: "要 SQL", source: "JD" }], gaps: [] }));
        return;
      }
      const turn = parentTurns.shift() ?? { text: "完" };
      if (turn.text) yield { type: "text_delta", text: turn.text };
      yield done(turn.text ?? "", turn.calls ?? []);
    },
  };
}

describe("delegate_research", () => {
  it("fans out read-only branches; a failed branch is reported missing, the others are usable", async () => {
    const store = new SqliteCoreStore(":memory:");
    const childTools: string[][] = [];
    const args = { tasks: [{ title: "飞书", instructions: "查岗位" }, { title: "坏公司", instructions: "查岗位" }, { title: "字节", instructions: "查岗位" }] };
    const parentSeen: ChatRequest[] = [];
    const base = model([{ calls: [{ id: "d1", name: "delegate_research", arguments: JSON.stringify(args), args }] }, { text: "比较完了" }], childTools);
    const llm: LlmClient = { ...base, completeStream: (request) => { if (!String(request.messages[0]?.content ?? "").includes("只读核查子任务")) parentSeen.push(structuredClone(request)); return base.completeStream!(request); } };
    const agent = createAgentRuntime({ store, runs: new SqliteAgentRunStore(store), llm: () => llm, toolDeps: () => ({ store }) });
    const result = await agent.startRun({ message: "比较三家公司的数据分析岗" });
    expect(result.ok).toBe(true);
    const toolMessage = parentSeen[1].messages.find((message) => message.role === "tool" && message.tool_call_id === "d1");
    const payload = JSON.parse(String(toolMessage?.content));
    expect(payload.ok).toBe(true);
    expect(payload.missing).toEqual(["坏公司"]);
    expect(payload.results.filter((item: { ok: boolean }) => item.ok).map((item: { summary: string }) => item.summary)).toEqual(["飞书 要 SQL", "字节 要 SQL"]);
    // children never see a write tool
    for (const names of childTools) {
      expect(names).toContain("get");
      expect(names).not.toContain("save");
      expect(names).not.toContain("delete");
      expect(names).not.toContain("request_user_input");
      expect(names).not.toContain("delegate_research");
    }
    const events = await agent.state.listEvents(result.run.id);
    expect(events.filter((event) => event.type === "subtask.finished")).toHaveLength(3);
    store.close();
  });

  it("aborting the parent aborts every child", async () => {
    const controller = new AbortController();
    let started = 0;
    const hanging: LlmClient = {
      provider: "fake",
      async chat() { return null; },
      async *completeStream(request: ChatRequest): AsyncIterable<LlmStreamEvent> {
        started += 1;
        await new Promise<void>((resolve) => request.signal?.addEventListener("abort", () => resolve(), { once: true }));
        yield { type: "done", result: { provider: "fake", model: "fake-1", content: "", reasoning: "", toolCalls: [], finishReason: "aborted", usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0, estimated: true } } };
      },
    };
    const readTool: AgentTool = { name: "get", description: "", parameters: { type: "object", properties: {} }, async execute() { return { text: "{}", isError: false }; } };
    const tool = delegateTool({ client: hanging, tools: [readTool], signal: controller.signal });
    const pending = tool.execute({ tasks: [{ title: "a", instructions: "x" }, { title: "b", instructions: "y" }] }, { callId: "c" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(started).toBe(2);
    controller.abort();
    const result = await pending;
    expect(JSON.parse(result.text)).toMatchObject({ ok: false, missing: ["a", "b"] });
  });
});
