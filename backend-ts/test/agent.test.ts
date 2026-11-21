// Contract tests for /api/agent (routes/main_agent.py parity) on the SQLite
// companion store, plus the same flow on the in-memory (browser-shaped) store.

import { afterEach, describe, expect, it } from "vitest";

import {
  MemoryAgentRunStore,
  createAgentRuntime,
  type AgentRunStore,
  type ChatRequest,
  type LlmClient,
  type LlmStreamEvent,
  type ParsedToolCall,
} from "@offeru/core";

import { SqliteAgentRunStore } from "../src/agent-store";
import { createApp, type AppDeps } from "../src/app";
import { SqliteCoreStore } from "../src/store";

type Turn = { text?: string; calls?: Array<{ name: string; args: Record<string, unknown> }> };

/** A scripted model: each completeStream call plays the next turn. */
function scriptedLlm(turns: Turn[], seen: ChatRequest[] = []): LlmClient {
  return {
    provider: "fake",
    model: "fake-1",
    async chat() { return null; },
    async *completeStream(request: ChatRequest): AsyncIterable<LlmStreamEvent> {
      seen.push(request);
      const turn = turns.shift() ?? { text: "（没有更多脚本）" };
      if (turn.text) {
        for (const piece of [turn.text.slice(0, 2), turn.text.slice(2)]) if (piece) yield { type: "text_delta", text: piece };
      }
      const toolCalls: ParsedToolCall[] = (turn.calls || []).map((call, index) => ({ id: `call_${index}`, name: call.name, arguments: JSON.stringify(call.args), args: call.args }));
      yield {
        type: "done",
        result: {
          provider: "fake", model: "fake-1", content: turn.text || "", reasoning: "", toolCalls,
          finishReason: toolCalls.length ? "tool_calls" : "stop",
          usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15, estimated: false },
        },
      };
    },
  };
}

let stores: SqliteCoreStore[] = [];
afterEach(() => {
  for (const store of stores) store.close();
  stores = [];
});

function setup(turns: Turn[], options: { llm?: boolean; runs?: "sqlite" | "memory" } = {}) {
  const store = new SqliteCoreStore(":memory:");
  stores.push(store);
  const agentRuns: AgentRunStore = options.runs === "memory" ? new MemoryAgentRunStore() : new SqliteAgentRunStore(store);
  const seen: ChatRequest[] = [];
  const llm = scriptedLlm(turns, seen);
  const deps: AppDeps = { store, runtime: "node", storage: "sqlite", agentRuns, llm: () => (options.llm === false ? null : llm) };
  const app = createApp(deps);
  const call = async (method: string, path: string, body?: unknown) => {
    const response = await app.request(path, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json() as any };
  };
  return { app, store, agentRuns, call, seen };
}

function parseSse(text: string): Array<{ event: string; id?: string; data: any }> {
  return text.split("\n\n").filter((block) => block.trim()).map((block) => {
    let event = "message";
    let id: string | undefined;
    const data: string[] = [];
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("id:")) id = line.slice(3).trim();
      else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
    }
    return { event, id, data: JSON.parse(data.join("\n")) };
  });
}

describe("POST /api/agent/runtime/runs", () => {
  it("runs tools as the Agent actor: memory stays unconfirmed, the write is undoable", async () => {
    const { call, store, seen } = setup([
      { calls: [{ name: "save", args: { type: "memory", data: { kind: "preference", title: "只投上海", body: "用户只看上海的岗位", confirmed: true } } }] },
      { calls: [{ name: "save", args: { type: "memory", data: { kind: "preference", title: "只投上海", body: "用户只看上海的岗位" } } }] },
      { text: "记下了：只投上海。" },
    ]);
    const response = await call("POST", "/api/agent/runtime/runs", { message: "以后只投上海" });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ ok: true, assistant_message: "记下了：只投上海。", conversation_title: "以后只投上海" });
    expect(response.body.run).toMatchObject({ status: "completed", mode: "core", skill_id: "offeru" });
    expect(response.body.run.final_result).toMatchObject({ terminal_state: "completed", turn_finished: true, steps_used: 3 });
    expect(response.body.run.llm_runtime).toMatchObject({ runtime: "ts_agent", provider: "fake", model: "fake-1" });

    // system prompt + the record tools + request_user_input reach the model
    expect(seen[0].messages[0].role).toBe("system");
    expect(seen[0].tools?.map((tool) => tool.name)).toEqual(["overview", "search", "list", "get", "save", "delete", "undo", "changes", "request_user_input"]);

    // user-only guard: the Agent may not confirm a memory; the error goes back to the model
    const toolReply = seen[1].messages.find((message) => message.role === "tool");
    expect(String(toolReply?.content)).toMatch(/^ERROR: 只有用户能确认记忆/);
    const [memory] = await store.all("memory");
    expect(memory).toMatchObject({ title: "只投上海", confirmed: false, source: "agent" });
    const [change] = await store.changes(1);
    expect(change.actor).toBe("助手");

    // the timeline shows it; the user can undo it
    const actions = await call("GET", "/api/agent/runtime/actions");
    expect(actions.body.items).toHaveLength(1);
    expect(actions.body.items[0]).toMatchObject({ id: `chg_${change.id}`, status: "done", undoable: true, operation: "save" });
    expect((await call("GET", `/api/agent/runtime/actions/chg_${change.id}/undo-preview`)).body).toEqual({ changed_after: false, message: "" });
    const undone = await call("POST", `/api/agent/runtime/actions/chg_${change.id}/undo`);
    expect(undone.body).toMatchObject({ ok: true, action: { status: "undone" } });
    expect(await store.all("memory")).toHaveLength(0);
    expect((await call("POST", `/api/agent/runtime/actions/chg_${change.id}/confirm`)).status).toBe(409);
  });

  it("keeps the conversation and run history", async () => {
    const { call } = setup([{ text: "你好！" }, { text: "第二轮" }]);
    const first = await call("POST", "/api/agent/runtime/runs", { message: "嗨" });
    const conversationId = first.body.conversation_id as string;
    await call("POST", "/api/agent/runtime/runs", { message: "再来", conversation_id: conversationId });

    const list = await call("GET", "/api/agent/conversations");
    expect(list.body.conversations).toHaveLength(1);
    expect(list.body.conversations[0]).toMatchObject({ id: conversationId, title: "嗨", message_count: 4, last_message: "第二轮" });
    const detail = await call("GET", `/api/agent/conversations/${conversationId}`);
    expect(detail.body.messages.map((m: any) => m.content)).toEqual(["嗨", "你好！", "再来", "第二轮"]);

    const runs = await call("GET", `/api/agent/runs?conversation_id=${conversationId}`);
    expect(runs.body.runs).toHaveLength(2);
    // both runs share the conversation's task
    expect(runs.body.runs[0].task_id).toBe(runs.body.runs[1].task_id);
    const runId = first.body.run.id as string;
    expect((await call("GET", `/api/agent/runs/${runId}`)).body.run.id).toBe(runId);
    const events = await call("GET", `/api/agent/runs/${runId}/events?after_sequence=0`);
    const sequences = events.body.events.map((event: any) => event.sequence);
    expect(sequences).toEqual(sequences.map((_: number, index: number) => index + 1)); // gap-free
    expect(events.body.events[0]).toMatchObject({ type: "run.started", provider_event: "run.started", payload: { goal: expect.stringContaining("嗨") } });
    expect(events.body.last_sequence).toBe(sequences.at(-1));

    expect((await call("DELETE", `/api/agent/conversations/${conversationId}`)).body).toEqual({ ok: true, conversation_id: conversationId });
    expect((await call("GET", `/api/agent/conversations/${conversationId}`)).status).toBe(404);
    expect((await call("DELETE", "/api/agent/conversations/nope")).body.ok).toBe(false);
  });

  it("re-posting an existing run_id returns the stored run instead of running again", async () => {
    const { call, seen } = setup([{ text: "一次" }]);
    const runId = "run_0123456789abcdef";
    await call("POST", "/api/agent/runtime/runs", { message: "x", run_id: runId });
    const again = await call("POST", "/api/agent/runtime/runs", { message: "x", run_id: runId });
    expect(again.body).toMatchObject({ ok: true, assistant_message: "一次", run: { id: runId } });
    expect(seen).toHaveLength(1);
  });

  it("validates the body like PiAgentRunRequest (400 instead of 422)", async () => {
    const { call } = setup([]);
    expect((await call("POST", "/api/agent/runtime/runs", { message: "" })).status).toBe(400);
    expect((await call("POST", "/api/agent/runtime/runs", { message: "x", run_id: "bad" })).status).toBe(400);
    expect((await call("POST", "/api/agent/runtime/runs", { message: "x", max_steps: 99 })).status).toBe(400);
    expect((await call("POST", "/api/agent/runtime/runs", { message: "x", reasoning_effort: "max" })).status).toBe(400);
  });

  it("no model configured: the run fails with a readable error", async () => {
    const { call } = setup([], { llm: false });
    const response = await call("POST", "/api/agent/runtime/runs", { message: "hi" });
    expect(response.status).toBe(200);
    expect(response.body.ok).toBe(false);
    expect(response.body.run.status).toBe("failed");
    expect(response.body.errors[0]).toContain("没配模型");
  });
});

describe("structured Ask", () => {
  it("request_user_input ends the turn; answering continues the same run once", async () => {
    const { call } = setup([
      { calls: [{ name: "request_user_input", args: { question: "投哪个城市？", options: [{ option_id: "sh", label: "上海", recommended: true }, { option_id: "bj", label: "北京" }] } }] },
      { text: "好，按上海来。" },
    ]);
    const first = await call("POST", "/api/agent/runtime/runs", { message: "帮我找岗位" });
    expect(first.body.input_request).toMatchObject({ question: "投哪个城市？", status: "pending", selection_mode: "single" });
    expect(first.body.run.final_result.terminal_state).toBe("waiting_user");
    const runId = first.body.run.id;
    const pending = await call("GET", `/api/agent/runtime/runs/${runId}/input-requests/pending`);
    expect(pending.body.requests).toHaveLength(1);
    const requestId = pending.body.requests[0].request_id;

    const bad = await call("POST", `/api/agent/runtime/runs/${runId}/input-requests/${requestId}/answer`, { answer_id: "a1", selected_option_ids: ["sh", "bj"] });
    expect(bad.status).toBe(400);

    const answered = await call("POST", `/api/agent/runtime/runs/${runId}/input-requests/${requestId}/answer`, { answer_id: "a1", selected_option_ids: ["sh"] });
    expect(answered.status).toBe(200);
    expect(answered.body).toMatchObject({ ok: true, duplicate: false, request: { status: "answered" } });
    expect(answered.body.continuation).toMatchObject({ ok: true, assistant_message: "好，按上海来。" });

    const duplicate = await call("POST", `/api/agent/runtime/runs/${runId}/input-requests/${requestId}/answer`, { answer_id: "a1", selected_option_ids: ["sh"] });
    expect(duplicate.body).toMatchObject({ ok: true, duplicate: true });
    const conflict = await call("POST", `/api/agent/runtime/runs/${runId}/input-requests/${requestId}/answer`, { answer_id: "a2", selected_option_ids: ["bj"] });
    expect(conflict.status).toBe(409);
    expect((await call("POST", `/api/agent/runtime/runs/${runId}/input-requests/input_x/answer`, { answer_id: "a" })).status).toBe(404);
  });
});

describe("SSE", () => {
  it("streams canonical events then the final message, and the run can be followed after", async () => {
    const { app, call } = setup([{ text: "流式回复" }]);
    const response = await app.request("/api/agent/runtime/runs/stream", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message: "hi", run_id: "run_aaaaaaaaaaaaaaaa" }) });
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const frames = parseSse(await response.text());
    const types = frames.map((frame) => frame.event);
    expect(types[0]).toBe("run.started");
    expect(types).toContain("assistant.delta");
    const deltas = frames.filter((frame) => frame.event === "assistant.delta" && frame.data.payload.delta_index !== undefined);
    expect(deltas.map((frame) => frame.data.payload.delta).join("")).toBe("流式回复");
    const last = frames.at(-1)!;
    expect(last.event).toBe("message");
    expect(last.data.response).toMatchObject({ ok: true, assistant_message: "流式回复" });

    // follow: replay durable events, end with the stored response
    const follow = await app.request("/api/agent/runtime/runs/run_aaaaaaaaaaaaaaaa/events/stream?after_sequence=0");
    const replay = parseSse(await follow.text());
    expect(replay.every((frame) => frame.event === "message" || frame.data.durable === true)).toBe(true);
    expect(replay.slice(0, -1).map((frame) => Number(frame.id))).toEqual(replay.slice(0, -1).map((_, index) => index + 1));
    expect(replay.at(-1)!.data.response).toMatchObject({ ok: true, assistant_message: "流式回复", conversation_title: "hi" });
    expect((await call("GET", "/api/agent/runtime/runs/run_bbbbbbbbbbbbbbbb/events/stream")).status).toBe(404);
  });

  it("steer / abort / resume on a finished run", async () => {
    const { call } = setup([{ text: "完成" }]);
    const first = await call("POST", "/api/agent/runtime/runs", { message: "hi" });
    const runId = first.body.run.id;
    expect((await call("POST", `/api/agent/runtime/runs/${runId}/steer`, { message: "顺便" })).body).toEqual({ ok: true, disposition: "not_running" });
    expect((await call("POST", "/api/agent/runtime/runs/run_cccccccccccccccc/steer", { message: "x" })).status).toBe(404);
    expect((await call("POST", `/api/agent/runtime/runs/${runId}/abort`)).body).toMatchObject({ ok: true, warnings: ["Run 已经结束。"] });
    expect((await call("POST", `/api/agent/runtime/runs/${runId}/resume`)).status).toBe(400); // only interrupted runs resume
  });
});

describe("runtime + browser-shaped store", () => {
  it("status and the same flow over MemoryAgentRunStore", async () => {
    const { call } = setup([{ text: "网页端也能跑" }], { runs: "memory" });
    expect((await call("GET", "/api/agent/runtime")).body).toMatchObject({ runtime: "ts_agent", available: true });
    const result = await call("POST", "/api/agent/runtime/runs", { message: "hi" });
    expect(result.body).toMatchObject({ ok: true, assistant_message: "网页端也能跑" });
  });

  it("SQLite rows survive a new runtime (restart) and executing runs become interrupted", async () => {
    const store = new SqliteCoreStore(":memory:");
    stores.push(store);
    const runs = new SqliteAgentRunStore(store);
    const llm = scriptedLlm([]);
    const first = createAgentRuntime({ store, runs, llm: () => llm });
    const run = await first.state.createRun({ conversation_id: "conv_1", goal: "g", mode: "core", llm_runtime: { runtime: "ts_agent" } });
    await first.state.saveRun({ ...run, status: "executing" });
    await runs.putSession(run.id, [{ role: "user", content: "g" }]);
    const second = createAgentRuntime({ store, runs: new SqliteAgentRunStore(store), llm: () => llm });
    expect(await second.state.recoverInterrupted()).toEqual({ interrupted: 1 });
    const recovered = await second.state.loadRun(run.id);
    expect(recovered).toMatchObject({ status: "interrupted", recovery_cursor: { reason: "backend_or_worker_restart", previous_status: "executing" } });
    const events = await second.state.listEvents(run.id);
    expect(events.at(-1)).toMatchObject({ type: "recovery.interrupted", payload: { resume_available: true } });
    // records/changes untouched by the new tables
    const tables = store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((row: any) => row.name);
    expect(tables).toEqual(["agent_conversations", "agent_input_requests", "agent_run_events", "agent_runs", "agent_sessions", "changes", "records"]);
  });
});
