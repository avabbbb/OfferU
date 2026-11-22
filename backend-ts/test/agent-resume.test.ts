// 写入后中断、恢复不重复：一批三个工具，第一个写完返回，第二个写库后进程「死掉」（不返回），
// 第三个没开始。换一个新 Host（模拟重启）恢复：第一、二个的写入各只一次，第二个被认出「已提交」，
// 第三个被标成「没执行」，模型不会因为恢复而重复创建记录。

import { afterEach, describe, expect, it } from "vitest";

import {
  createAgentRuntime,
  saveRecord,
  toolOpKey,
  type AgentTool,
  type ChatRequest,
  type LlmClient,
  type LlmStreamEvent,
  type ParsedToolCall,
} from "@offeru/core";

import { SqliteAgentRunStore } from "../src/agent-store";
import { SqliteCoreStore } from "../src/store";

type Turn = { text?: string; calls?: Array<{ id: string; name: string; args: Record<string, unknown> }> };

function scripted(turns: Turn[], seen: ChatRequest[] = []): LlmClient {
  return {
    provider: "fake",
    model: "fake-1",
    async chat() { return null; },
    async *completeStream(request: ChatRequest): AsyncIterable<LlmStreamEvent> {
      seen.push(structuredClone(request));
      const turn = turns.shift() ?? { text: "（没有更多脚本）" };
      if (turn.text) yield { type: "text_delta", text: turn.text };
      const toolCalls: ParsedToolCall[] = (turn.calls || []).map((call) => ({ id: call.id, name: call.name, arguments: JSON.stringify(call.args), args: call.args }));
      yield { type: "done", result: { provider: "fake", model: "fake-1", content: turn.text || "", reasoning: "", toolCalls, finishReason: toolCalls.length ? "tool_calls" : "stop", usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2, estimated: false } } };
    },
  };
}

let stores: SqliteCoreStore[] = [];
afterEach(() => { for (const store of stores) store.close(); stores = []; });

describe("resume after a crash inside a tool batch", () => {
  it("committed calls are not re-run, unfinished ones are reported as not executed", async () => {
    const store = new SqliteCoreStore(":memory:");
    stores.push(store);
    const runs = new SqliteAgentRunStore(store);
    let entered!: () => void;
    const crashed = new Promise<void>((resolve) => { entered = resolve; });

    // Writes with the call's op key, then never returns: the process "dies" here.
    const commitThenDie: AgentTool = {
      name: "commit_then_die",
      description: "test",
      parameters: { type: "object", properties: {} },
      async execute(_args, call) {
        await saveRecord(store, { type: "job", data: { title: "B" } }, { actor: "OfferU Agent", now: "2026-11-23T00:00:00+08:00", today: "2026-11-23", op: toolOpKey(call.runId!, call.callId) });
        entered();
        return new Promise(() => undefined);
      },
    };
    const first = createAgentRuntime({
      store, runs,
      llm: () => scripted([{ calls: [
        { id: "c1", name: "save", args: { type: "job", data: { title: "A" } } },
        { id: "c2", name: "commit_then_die", args: {} },
        { id: "c3", name: "save", args: { type: "job", data: { title: "C" } } },
      ] }]),
      toolDeps: () => ({ store }),
      extraTools: () => [commitThenDie],
    });
    void first.startRun({ message: "建三个岗位" });
    await crashed;
    const runId = first.activeRunIds()[0];

    // Restart: a fresh host over the same files.
    const seen: ChatRequest[] = [];
    const second = createAgentRuntime({ store, runs, llm: () => scripted([{ text: "A、B 已建好，C 没建成。" }], seen), toolDeps: () => ({ store }) });
    await second.state.recoverInterrupted();
    const result = await second.resumeRun(runId);
    expect(result.ok).toBe(true);

    const titles = (await store.all("job")).map((job) => job.title).sort();
    expect(titles).toEqual(["A", "B"]); // A and B once each, C never ran

    const toolResults = seen[0].messages.filter((message) => message.role === "tool");
    const byCall = Object.fromEntries(toolResults.map((message) => [message.tool_call_id, JSON.parse(String(message.content))]));
    expect(byCall.c1).toMatchObject({ change_id: expect.any(Number) });
    expect(byCall.c2).toMatchObject({ ok: true, recovered: true, change_ids: [expect.any(Number)] });
    expect(byCall.c3).toMatchObject({ ok: false, error: { code: "interrupted" } });
    // tool results stay right after their assistant message (providers reject anything else)
    const index = seen[0].messages.findIndex((message) => message.role === "assistant" && message.tool_calls?.length);
    expect(seen[0].messages.slice(index + 1, index + 4).map((message) => message.tool_call_id)).toEqual(["c1", "c2", "c3"]);
  });
});
