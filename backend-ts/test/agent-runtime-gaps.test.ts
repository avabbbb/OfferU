// Runtime gaps the journey trace exposed: tailor_resume as a registry tool,
// aborting a run while a tool's sub-model call is in flight, resuming a run
// whose process died mid tool batch, and the per-run trace.

import { afterEach, describe, expect, it } from "vitest";

import {
  INTERRUPTED_TOOL_RESULT,
  saveRecord,
  type AgentTraceData,
  type ChatMessage,
  type ChatRequest,
  type LlmChatOptions,
  type LlmClient,
  type LlmMessage,
  type LlmStreamEvent,
  type ParsedToolCall,
} from "@offeru/core";

import { SqliteAgentRunStore } from "../src/agent-store";
import { createApp, type AppDeps } from "../src/app";
import { agentHost } from "../src/routes/agent";
import { SqliteCoreStore } from "../src/store";

type Turn = { text?: string; calls?: Array<{ name: string; args: Record<string, unknown> }> };
const RESUME = "# 林知远\n\n13800000000 | 上海\n\n## 实习经历\n### 示例电商 | 数据分析实习生 | 2025.07 – 2025.09\n- 每周用 SQL 出 GMV 周报\n";

/** Scripted agent turns; tool sub-model calls (tailor draft / review) answered by `sub`. */
function fakeLlm(turns: Turn[], sub: (messages: LlmMessage[], options?: LlmChatOptions) => Promise<string | null>, seen: ChatRequest[] = []): LlmClient {
  return {
    provider: "fake",
    model: "fake-1",
    chat: sub,
    async *completeStream(request: ChatRequest): AsyncIterable<LlmStreamEvent> {
      seen.push(request);
      const turn = turns.shift() ?? { text: "（没有更多脚本）" };
      if (turn.text) yield { type: "text_delta", text: turn.text };
      const toolCalls: ParsedToolCall[] = (turn.calls || []).map((call, index) => ({ id: `call_${seen.length}_${index}`, name: call.name, arguments: JSON.stringify(call.args), args: call.args }));
      yield { type: "done", result: { provider: "fake", model: "fake-1", content: turn.text || "", reasoning: "", toolCalls, finishReason: toolCalls.length ? "tool_calls" : "stop", usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15, estimated: false } } };
    },
  };
}

const answers = async (messages: LlmMessage[]) => {
  const system = String(messages[0]?.content ?? "");
  if (system.startsWith("你是简历编辑")) return RESUME;
  if (system.startsWith("你是简历审稿人")) return JSON.stringify({ edits: [], notes: {}, asks: [] });
  return null;
};

let stores: SqliteCoreStore[] = [];
afterEach(() => {
  for (const store of stores) store.close();
  stores = [];
});

async function setup(llm: LlmClient) {
  const store = new SqliteCoreStore(":memory:");
  stores.push(store);
  const traces: AgentTraceData[] = [];
  const deps: AppDeps = {
    store, runtime: "node", storage: "sqlite", agentRuns: new SqliteAgentRunStore(store), llm: () => llm,
    agentTrace: { codeVersion: "test", write: (trace) => { traces.push(structuredClone(trace)); } },
  };
  const app = createApp(deps);
  const call = async (method: string, path: string, body?: unknown) => {
    const response = await app.request(path, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json() as any };
  };
  const ctx = { actor: "你", now: new Date().toISOString(), today: "2026-11-15" };
  const resume = (await saveRecord(store, { type: "doc", data: { kind: "resume", title: "主简历", body: RESUME } }, ctx)).record;
  const job = (await saveRecord(store, { type: "job", data: { company: "示例科技", title: "数据分析师", jd: "负责 GMV 周报与 A/B 实验分析，熟练 SQL。" } }, ctx)).record;
  return { app, deps, store, call, traces, resume, job };
}

describe("tailor_resume (registry tool)", () => {
  it("over HTTP: writes a job copy, leaves the main resume alone", async () => {
    const { call, store, resume, job } = await setup(fakeLlm([], answers));
    const before = (await store.get("doc", resume.id))!.body;
    const response = await call("POST", "/api/tools/tailor_resume", { id: resume.id, job_id: job.id });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ doc_id: expect.any(Number), change_id: expect.any(Number), rounds: expect.any(Array) });
    const copy = await store.get("doc", response.body.doc_id);
    expect(copy).toMatchObject({ kind: "resume", job_id: job.id });
    expect((await store.get("doc", resume.id))!.body).toBe(before);
    expect((await call("POST", "/api/tools/tailor_resume", { id: resume.id, job_id: 999 })).body.detail).toMatch("先给这份简历选一个岗位");
  });
});

describe("abort while a tool is calling the model", () => {
  it("cancels the run, the tool writes nothing, the trace says cancelled / aborted", async () => {
    let drafting = false;
    const sub = (messages: LlmMessage[], options?: LlmChatOptions) => {
      if (!String(messages[0]?.content ?? "").startsWith("你是简历编辑")) return answers(messages);
      drafting = true;
      return new Promise<string | null>((resolve) => options?.signal?.addEventListener("abort", () => resolve(null), { once: true }));
    };
    const env = await setup(fakeLlm([], sub));
    const turns: Turn[] = [{ calls: [{ name: "tailor_resume", args: { id: env.resume.id, job_id: env.job.id } }] }, { text: "不该走到这里" }];
    const llm = fakeLlm(turns, sub);
    env.deps.llm = () => llm;
    const runId = "run_" + "a".repeat(24);
    const posted = env.call("POST", "/api/agent/runtime/runs", { message: "定制简历", run_id: runId });
    while (!drafting) await new Promise((resolve) => setTimeout(resolve, 5));
    expect((await env.call("POST", `/api/agent/runtime/runs/${runId}/abort`)).status).toBe(200);
    const response = await posted;
    expect(response.body.run.status).toBe("cancelled");
    expect((await env.store.all("doc")).filter((doc) => doc.kind === "resume")).toHaveLength(1);
    const run = (await env.call("GET", `/api/agent/runs/${runId}`)).body.run;
    expect(run.final_result).toMatchObject({ terminal_state: "cancelled", stop_reason: "aborted", turn_finished: true });
    expect(env.traces).toHaveLength(1);
    expect(env.traces[0]).toMatchObject({ run_id: runId, terminal_state: "cancelled", stop_reason: "aborted", code_version: "test" });
    expect(env.traces[0].tool_calls[0]).toMatchObject({ tool: "tailor_resume", ok: false });
  });
});

describe("resume after the process died mid tool batch", () => {
  it("closes the unanswered tool calls as 'interrupted, verify first' and continues instead of refusing", async () => {
    const seen: ChatRequest[] = [];
    const env = await setup(fakeLlm([{ calls: [{ name: "list", args: { type: "doc" } }] }, { text: "核对过了，主简历已经在，没有重复存。" }], answers, seen));
    const host = agentHost(env.deps);
    const run = await host.state.createRun({ conversation_id: "", goal: "存两条记忆", mode: "core", llm_runtime: { runtime: "ts_agent" } });
    const session: ChatMessage[] = [
      { role: "user", content: "存两条记忆" },
      { role: "assistant", content: "", tool_calls: [
        { id: "c1", type: "function", function: { name: "save", arguments: "{}" } },
        { id: "c2", type: "function", function: { name: "save", arguments: "{}" } },
      ] },
      { role: "tool", tool_call_id: "c1", name: "save", content: "{\"change_id\": 1}" },
    ];
    await host.state.store.putSession(run.id, session);
    await host.state.saveRun({ ...run, status: "interrupted" });

    const response = await env.call("POST", `/api/agent/runtime/runs/${run.id}/resume`);
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ ok: true, assistant_message: "核对过了，主简历已经在，没有重复存。" });
    const closed = seen[0].messages.find((message) => message.role === "tool" && message.tool_call_id === "c2");
    expect(closed?.content).toBe(INTERRUPTED_TOOL_RESULT);
    expect(env.traces.at(-1)).toMatchObject({ run_id: run.id, resumed: true, terminal_state: "completed" });
  });
});
