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

type Turn = { text?: string; thinking?: string; calls?: Array<{ name: string; args: Record<string, unknown> }> };

/** A scripted model: each completeStream call plays the next turn. */
function scriptedLlm(turns: Turn[], seen: ChatRequest[] = []): LlmClient {
  return {
    provider: "fake",
    model: "fake-1",
    async chat() { return null; },
    async *completeStream(request: ChatRequest): AsyncIterable<LlmStreamEvent> {
      seen.push(request);
      const turn = turns.shift() ?? { text: "（没有更多脚本）" };
      if (turn.thinking) for (const piece of [turn.thinking.slice(0, 3), turn.thinking.slice(3)]) if (piece) yield { type: "thinking_delta", text: piece };
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

function setup(turns: Turn[], options: { llm?: boolean; runs?: "sqlite" | "memory"; client?: LlmClient } = {}) {
  const store = new SqliteCoreStore(":memory:");
  stores.push(store);
  const agentRuns: AgentRunStore = options.runs === "memory" ? new MemoryAgentRunStore() : new SqliteAgentRunStore(store);
  const seen: ChatRequest[] = [];
  const llm = options.client ?? scriptedLlm(turns, seen);
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

    // system prompt + every registry tool this runtime can run (no companion: no read_file / find_files;
    // export_resume_pdf / tailor_resume / email_sync are not in core) + request_user_input reach the model
    expect(seen[0].messages[0].role).toBe("system");
    expect(seen[0].tools?.map((tool) => tool.name)).toEqual([
      "overview", "search", "list", "get", "save", "delete", "undo", "changes",
      "web_search", "fetch_page", "split_resume", "add_job", "evaluate_jobs", "apply_answer", "draft_email", "reconcile_memory",
      "export_data", "tool_manual", "skill_read", "request_user_input",
    ]);

    // user-only guard: the Agent may not confirm a memory; the error goes back to the model
    const toolReply = seen[1].messages.find((message) => message.role === "tool");
    expect(JSON.parse(String(toolReply?.content))).toMatchObject({ ok: false, error: { code: "forbidden", retryable: false } });
    expect(JSON.parse(String(toolReply?.content)).error.message).toMatch(/^只有用户能确认记忆/);
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

  it.each(["sqlite", "memory"] as const)("branches a conversation from a message (%s run store)", async (runs) => {
    const { call, seen } = setup([{ text: "你好！" }, { text: "第二轮" }, { text: "分叉后的回答" }], { runs });
    const first = await call("POST", "/api/agent/runtime/runs", { message: "嗨" });
    const sourceId = first.body.conversation_id as string;
    await call("POST", "/api/agent/runtime/runs", { message: "再来", conversation_id: sourceId });

    // 分叉到第 2 条（含）：新对话只有前两条，原对话不动
    const branched = await call("POST", `/api/agent/conversations/${sourceId}/branch`, { upto: 2, content: "你好！", role: "assistant" });
    expect(branched.status).toBe(200);
    expect(branched.body).toMatchObject({ message_count: 2, branched_from: sourceId, title: "嗨 · 分叉" });
    expect(branched.body.id).not.toBe(sourceId);
    expect(branched.body.messages.map((m: any) => m.content)).toEqual(["嗨", "你好！"]);
    expect((await call("GET", `/api/agent/conversations/${sourceId}`)).body.messages).toHaveLength(4);
    // Run 不复制
    expect((await call("GET", `/api/agent/runs?conversation_id=${branched.body.id}`)).body.runs).toHaveLength(0);

    // 下标偏了（界面多出本地提示）：按 content + role 校正到真正那条
    const corrected = await call("POST", `/api/agent/conversations/${sourceId}/branch`, { upto: 3, content: "  你好！ ", role: "assistant" });
    expect(corrected.body.messages.map((m: any) => m.content)).toEqual(["嗨", "你好！"]);
    // upto 超出时截到末尾
    expect((await call("POST", `/api/agent/conversations/${sourceId}/branch`, { upto: 99 })).body.message_count).toBe(4);

    // 错误：不存在 / upto 非法 / 内容对不上
    expect((await call("POST", "/api/agent/conversations/nope/branch", { upto: 1 })).status).toBe(404);
    expect((await call("POST", `/api/agent/conversations/${sourceId}/branch`, { upto: 0 })).status).toBe(400);
    expect((await call("POST", `/api/agent/conversations/${sourceId}/branch`, {})).status).toBe(400);
    const conflict = await call("POST", `/api/agent/conversations/${sourceId}/branch`, { upto: 2, content: "从没说过的话" });
    expect(conflict.status).toBe(409);
    expect(conflict.body.code).toBe("conflict");

    // 新对话像普通续聊一样接着跑：模型看到的是分叉前的消息
    const next = await call("POST", "/api/agent/runtime/runs", { message: "换个方向", conversation_id: branched.body.id });
    expect(next.body).toMatchObject({ ok: true, assistant_message: "分叉后的回答", conversation_id: branched.body.id });
    const history = seen.at(-1)!.messages.filter((m) => m.role === "user" || m.role === "assistant").map((m) => String(m.content));
    expect(history.some((text) => text.includes("再来"))).toBe(false);
    expect(history.some((text) => text.includes("嗨"))).toBe(true);
    expect((await call("GET", `/api/agent/conversations/${branched.body.id}`)).body.messages.map((m: any) => m.content))
      .toEqual(["嗨", "你好！", "换个方向", "分叉后的回答"]);
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

  it("streams thinking as live-only reasoning.delta (never persisted)", async () => {
    const { app, call } = setup([{ thinking: "先看看岗位要求", text: "好的" }]);
    const response = await app.request("/api/agent/runtime/runs/stream", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message: "hi", run_id: "run_dddddddddddddddd" }) });
    const frames = parseSse(await response.text());
    const reasoning = frames.filter((frame) => frame.event === "reasoning.delta");
    expect(reasoning.map((frame) => frame.data.payload.delta).join("")).toBe("先看看岗位要求");
    expect(reasoning.every((frame) => frame.data.durable !== true && frame.id === undefined)).toBe(true);
    expect(reasoning[0].data.provider_event).toBe("reasoning.delta");
    // 思考在正文之前
    expect(frames.findIndex((frame) => frame.event === "reasoning.delta")).toBeLessThan(frames.findIndex((frame) => frame.event === "assistant.delta"));
    const events = await call("GET", "/api/agent/runs/run_dddddddddddddddd/events?after_sequence=0");
    expect(events.body.events.some((event: any) => event.type === "reasoning.delta" || event.provider_event === "reasoning.delta")).toBe(false);
    expect(JSON.stringify(events.body.events)).not.toContain("先看看岗位要求");
  });

  it("steers a live run: the message reaches the model before its next step and is saved in the conversation", async () => {
    const seen: ChatRequest[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    let call = 0;
    const client: LlmClient = {
      provider: "fake", model: "fake-1",
      async chat() { return null; },
      async *completeStream(request: ChatRequest): AsyncIterable<LlmStreamEvent> {
        seen.push(request);
        call += 1;
        const usage = { input_tokens: 10, output_tokens: 5, total_tokens: 15, estimated: false };
        if (call === 1) {
          entered();
          await gate;
          const toolCalls: ParsedToolCall[] = [{ id: "call_0", name: "overview", arguments: "{}", args: {} }];
          yield { type: "done", result: { provider: "fake", model: "fake-1", content: "", reasoning: "", toolCalls, finishReason: "tool_calls", usage } };
          return;
        }
        yield { type: "text_delta", text: "按你说的只看上海" };
        yield { type: "done", result: { provider: "fake", model: "fake-1", content: "按你说的只看上海", reasoning: "", toolCalls: [], finishReason: "stop", usage } };
      },
    };
    const { call: request } = setup([], { client });
    const running = request("POST", "/api/agent/runtime/runs", { message: "帮我找岗位", run_id: "run_eeeeeeeeeeeeeeee" });
    await started;
    const steered = await request("POST", "/api/agent/runtime/runs/run_eeeeeeeeeeeeeeee/steer", { message: "只看上海" });
    expect(steered.body).toEqual({ ok: true, disposition: "steered" });
    release();
    const done = await running;
    expect(done.body).toMatchObject({ ok: true, assistant_message: "按你说的只看上海" });
    const second = seen[1].messages.map((message) => `${message.role}:${typeof message.content === "string" ? message.content : ""}`);
    expect(second.some((line) => line === "user:只看上海")).toBe(true);
    const conversation = await request("GET", `/api/agent/conversations/${done.body.conversation_id}`);
    expect(conversation.body.messages.map((m: any) => m.content)).toEqual(["帮我找岗位", "只看上海", "按你说的只看上海"]);
    // 结束后再插话：not_running（前端据此放回队列）
    expect((await request("POST", "/api/agent/runtime/runs/run_eeeeeeeeeeeeeeee/steer", { message: "再加北京" })).body).toEqual({ ok: true, disposition: "not_running" });
  });

  it("lists the skill registry for the Skill Hub", async () => {
    const { call } = setup([]);
    const response = await call("GET", "/api/agent/skills");
    expect(response.status).toBe(200);
    expect(response.body.skills.map((skill: any) => skill.id)).toEqual(["interview-practice", "role-research", "resume-tailoring", "job-evaluation", "email-writing"]);
    const interview = response.body.skills[0];
    expect(interview).toMatchObject({ title: "模拟面试与面试准备", example: expect.stringContaining("模拟面试") });
    expect(interview.keywords).toContain("模拟面试");
    expect(interview.body).toContain("模拟面试");
    expect(response.body.sandbox).toMatchObject({ modes: ["read_only", "workspace_write"], default: "workspace_write" });
    expect(response.body.sandbox.read_only_tools).toContain("search");
    expect(response.body.sandbox.read_only_tools).not.toContain("save");
  });

  it("read-only sandbox blocks write tools (structured read_only error) but lets reads through", async () => {
    const { call, store, seen } = setup([
      { calls: [{ name: "save", args: { type: "memory", data: { kind: "note", title: "试写", body: "x" } } }, { name: "overview", args: {} }] },
      { text: "只读模式下没写入。" },
    ]);
    const response = await call("POST", "/api/agent/runtime/runs", { message: "记一下", sandbox: "read_only" });
    expect(response.body).toMatchObject({ ok: true, assistant_message: "只读模式下没写入。" });
    expect(response.body.run.llm_runtime.sandbox).toBe("read_only");
    const replies = seen[1].messages.filter((message) => message.role === "tool").map((message) => JSON.parse(String(message.content)));
    expect(replies[0]).toMatchObject({ ok: false, error: { code: "read_only", retryable: false } });
    expect(replies[0].error.message).toContain("save");
    expect(replies[0].error.suggestedAction).toContain("可写");
    expect(replies[1].ok).not.toBe(false); // overview 照常
    expect(await store.all("memory")).toHaveLength(0);
    // 写类工具的描述里标了只读
    expect(seen[0].tools?.find((tool) => tool.name === "save")?.description).toMatch(/^【只读模式下不可用/);
    expect(seen[0].tools?.find((tool) => tool.name === "search")?.description).not.toMatch(/只读模式/);
    expect((await call("POST", "/api/agent/runtime/runs", { message: "x", sandbox: "yolo" })).status).toBe(400);
  });

  it("writable sandbox (default) still writes", async () => {
    const { call, store } = setup([
      { calls: [{ name: "save", args: { type: "memory", data: { kind: "note", title: "可写", body: "y" } } }] },
      { text: "存好了" },
    ]);
    const response = await call("POST", "/api/agent/runtime/runs", { message: "记一下", sandbox: "workspace_write" });
    expect(response.body.run.llm_runtime.sandbox).toBe("workspace_write");
    expect(await store.all("memory")).toHaveLength(1);
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
