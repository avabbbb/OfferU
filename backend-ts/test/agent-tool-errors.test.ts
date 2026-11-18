// Built-in Agent tool failures come back structured ({ok:false, error:{code, message, retryable,
// suggestedAction}}) and preflight catches missing ids / wrong kinds before a tool runs
// (packages/core/src/tools/preflight.ts). Driven through the real HTTP run endpoint.

import { afterEach, describe, expect, it } from "vitest";

import { classifyToolError, CoreError, preflightTool, saveRecord, toolSpec, type ChatRequest, type LlmClient, type LlmStreamEvent, type ParsedToolCall } from "@offeru/core";

import { SqliteAgentRunStore } from "../src/agent-store";
import { createApp } from "../src/app";
import { SqliteCoreStore } from "../src/store";

type Call = { name: string; args: Record<string, unknown> };

function scriptedLlm(turns: Array<{ text?: string; calls?: Call[] }>, seen: ChatRequest[]): LlmClient {
  return {
    provider: "fake",
    model: "fake-1",
    async chat() { return null; },
    async *completeStream(request: ChatRequest): AsyncIterable<LlmStreamEvent> {
      seen.push(request);
      const turn = turns.shift() ?? { text: "好。" };
      const toolCalls: ParsedToolCall[] = (turn.calls || []).map((call, index) => ({ id: `call_${index}`, name: call.name, arguments: JSON.stringify(call.args), args: call.args }));
      yield { type: "done", result: { provider: "fake", model: "fake-1", content: turn.text || "", reasoning: "", toolCalls, finishReason: toolCalls.length ? "tool_calls" : "stop", usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15, estimated: false } } };
    },
  };
}

const USER = { actor: "你", now: "2026-11-18T00:00:00+00:00", today: "2026-11-18" };

let stores: SqliteCoreStore[] = [];
afterEach(() => {
  for (const store of stores) store.close();
  stores = [];
});

async function runWith(calls: Call[], seed?: (store: SqliteCoreStore) => Promise<void>) {
  const store = new SqliteCoreStore(":memory:");
  stores.push(store);
  await seed?.(store);
  const seen: ChatRequest[] = [];
  const llm = scriptedLlm([{ calls }, { text: "好。" }], seen);
  const app = createApp({ store, runtime: "node", storage: "sqlite", agentRuns: new SqliteAgentRunStore(store), llm: () => llm });
  const response = await app.request("/api/agent/runtime/runs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message: "试试" }) });
  expect(response.status).toBe(200);
  const replies = seen[1].messages.filter((message) => message.role === "tool").map((message) => JSON.parse(String(message.content)));
  return { store, replies };
}

describe("structured tool errors and preflight", () => {
  it("schema errors, missing ids, wrong kinds, double undo and unknown tools each say how to fix", async () => {
    const { store, replies } = await runWith([
      { name: "save", args: { type: "nope", data: {} } },
      { name: "get", args: { type: "job", id: 99 } },
      { name: "evaluate_jobs", args: { ids: [42] } },
      { name: "save", args: { type: "event", data: { title: "笔试", kind: "test", job_id: 7 } } },
      { name: "sav", args: {} },
      { name: "save", args: { _raw: "{type: memory" } },
      { name: "undo", args: { change_id: 2 } },
      { name: "undo", args: { change_id: 2 } },
    ], async (seeded) => {
      await saveRecord(seeded, { type: "job", data: { company: "飞书", title: "产品经理实习" } }, USER);
      await saveRecord(seeded, { type: "memory", data: { kind: "skill", title: "SQL" } }, USER);
    });

    expect(replies[0]).toMatchObject({ ok: false, error: { code: "invalid_args", retryable: false } });
    expect(replies[0].error.suggestedAction).toContain("tool_manual(names=[\"save\"])");

    expect(replies[1]).toMatchObject({ ok: false, error: { code: "not_found", retryable: false } });
    expect(replies[1].error.suggestedAction).toContain("#1 飞书");

    expect(replies[2]).toMatchObject({ ok: false, error: { code: "not_found", message: "ids=42：没有这条 job" } });
    expect(replies[3]).toMatchObject({ ok: false, error: { code: "not_found", message: "data.job_id=7：没有这条 job" } });
    expect(replies[4]).toMatchObject({ ok: false, error: { code: "unknown_tool" } });
    expect(replies[4].error.suggestedAction).toContain("save");
    expect(replies[5]).toMatchObject({ ok: false, error: { code: "invalid_args" } });
    expect(replies[6]).not.toHaveProperty("ok", false);
    expect(replies[7]).toMatchObject({ ok: false, error: { code: "conflict" } });

    // the blocked calls wrote nothing; only the first undo ran
    expect((await store.all("event")).length).toBe(0);
    expect((await store.all("job")).length).toBe(1);
    expect((await store.all("memory")).length).toBe(0);
  });

  it("export_resume_pdf / tailor_resume refuse a doc that is not a resume before running", async () => {
    const store = new SqliteCoreStore(":memory:");
    stores.push(store);
    await saveRecord(store, { type: "doc", data: { kind: "note", title: "笔记", body: "x" } }, USER);
    for (const name of ["tailor_resume", "export_resume_pdf"]) {
      expect(await preflightTool(toolSpec(name)!, { id: 1 }, store)).toMatchObject({ ok: false, error: { code: "invalid", message: "doc #1 是 note，不是简历" } });
    }
  });

  it("upstream failures are retryable; business rules are not", () => {
    expect(classifyToolError(new Error("HTTP 429 Too Many Requests"))).toMatchObject({ error: { code: "upstream_unavailable", retryable: true } });
    expect(classifyToolError(new Error("fetch failed"))).toMatchObject({ error: { code: "upstream_unavailable", retryable: true } });
    expect(classifyToolError(new CoreError("岗位已关闭", "conflict"))).toMatchObject({ error: { code: "conflict", retryable: false } });
  });
});
