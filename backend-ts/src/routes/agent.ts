// /api/agent — the embedded Agent: runs (sync + SSE stream + follow),
// resume / steer / abort, structured Ask, run history, conversations, and the
// Agent-writes timeline. Port of backend/app/routes/main_agent.py (the parts
// the frontend calls for the chat). Runtime-agnostic: no node:* here, so the
// same module serves the Node companion and the in-browser Hono app (TO C web:
// IndexedDB rows + the user's own key).

import type { Context, Hono } from "hono";
import { streamSSE, type SSEStreamingApi } from "hono/streaming";
import {
  CoreError,
  MemoryAgentRunStore,
  agentActionUndoPreview,
  agentActions,
  canonicalAgentRunEvent,
  createAgentRuntime,
  randomHex,
  runtimeResponseFromRun,
  runtimeTurnIsFinished,
  sanitizeLlmError,
  undoAgentAction,
  type AgentHost,
  type Json,
  type RawRunEvent,
  type RunOptions,
  USER_ACTOR,
  nowIso,
  todayIso,
} from "@offeru/core";

import { jsonBody, type AppDeps, type AppEnv } from "../app";

const RUN_ID = /^run_[a-f0-9]{16,32}$/;
const PROVIDER_ID = /^[a-z0-9][a-z0-9_-]*$/;
const FOLLOW_POLL_MS = 250;

const hosts = new WeakMap<AppDeps, AgentHost>();

/** One AgentHost per app instance (its active-run table lives in memory). */
export function agentHost(deps: AppDeps): AgentHost {
  let host = hosts.get(deps);
  if (!host) {
    host = createAgentRuntime({
      store: deps.store,
      runs: deps.agentRuns ?? new MemoryAgentRunStore(),
      llm: () => deps.llm?.() ?? null,
    });
    hosts.set(deps, host);
  }
  return host;
}

function requireRunStorage(deps: AppDeps): void {
  if (deps.storage === "none" && !deps.agentRuns) {
    throw new CoreError("这个运行环境不保存数据，不能运行 Agent；请在网页本地版或本机 OfferU 里使用", "unsupported");
  }
}

export interface RunRequest {
  message: string;
  max_steps: number;
  journey_id: string;
  skill_id: string;
  conversation_id: string | null;
  task_id: string | null;
  run_id: string | null;
  runtime_provider: string;
  llm_config_id: string;
  reasoning_effort: "" | "low" | "medium" | "high";
  approval_mode: "auto" | "ask";
  attachments: string[];
}

const str = (value: unknown) => (value === undefined || value === null ? "" : String(value));

/** PiAgentRunRequest validation (Python 422 → 400 here, by decision). */
export function parseRunRequest(raw: unknown): RunRequest {
  const body = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Json : {};
  const message = str(body.message);
  if (!message || message.length > 20_000) throw new CoreError("message 需要 1–20000 个字符", "invalid");
  const maxSteps = body.max_steps === undefined ? 0 : Number(body.max_steps);
  if (!Number.isInteger(maxSteps) || maxSteps < 0 || maxSteps > 40) throw new CoreError("max_steps 需要 0–40 的整数", "invalid");
  const runId = body.run_id === undefined || body.run_id === null ? null : str(body.run_id);
  if (runId !== null && !RUN_ID.test(runId)) throw new CoreError("run_id 格式不对", "invalid");
  const provider = str(body.runtime_provider || "embedded");
  if (provider.length > 40 || !PROVIDER_ID.test(provider)) throw new CoreError("runtime_provider 格式不对", "invalid");
  const effort = str(body.reasoning_effort);
  if (!["", "low", "medium", "high"].includes(effort)) throw new CoreError("reasoning_effort 只能是 low / medium / high", "invalid");
  const approval = str(body.approval_mode || "auto");
  if (approval !== "auto" && approval !== "ask") throw new CoreError("approval_mode 只能是 auto / ask", "invalid");
  const attachments = body.attachments === undefined ? [] : body.attachments;
  if (!Array.isArray(attachments) || attachments.length > 8) throw new CoreError("attachments 最多 8 个", "invalid");
  const skill = str(body.skill_id || "auto");
  if (skill.length > 120) throw new CoreError("skill_id 太长", "invalid");
  const llmConfig = str(body.llm_config_id);
  if (llmConfig.length > 64) throw new CoreError("llm_config_id 太长", "invalid");
  return {
    message,
    max_steps: maxSteps,
    journey_id: str(body.journey_id).slice(0, 120),
    skill_id: skill,
    conversation_id: body.conversation_id ? str(body.conversation_id) : null,
    task_id: body.task_id ? str(body.task_id) : null,
    run_id: runId,
    runtime_provider: provider,
    llm_config_id: llmConfig,
    reasoning_effort: effort as RunRequest["reasoning_effort"],
    approval_mode: approval as RunRequest["approval_mode"],
    attachments: attachments.map(String),
  };
}

function runOptions(body: RunRequest): RunOptions {
  return {
    llm_config_id: body.llm_config_id,
    reasoning_effort: body.reasoning_effort,
    approval_mode: body.approval_mode,
    max_steps: body.max_steps,
    journey_id: body.journey_id,
  };
}

function streamErrorPayload(cause: unknown, ids: { run_id?: string; task_id?: string; provider_id?: string }): Json {
  const message = cause instanceof CoreError || cause instanceof Error
    ? sanitizeLlmError(cause.message, 1000) || "Agent 流式请求失败"
    : "Agent 流式请求失败";
  return {
    error: message,
    error_id: `err_${randomHex(12)}`,
    ...(ids.run_id ? { run_id: ids.run_id } : {}),
    ...(ids.task_id ? { task_id: ids.task_id } : {}),
    ...(ids.provider_id ? { provider_id: ids.provider_id } : {}),
  };
}

async function writeEvent(stream: SSEStreamingApi, event: RawRunEvent, durable?: boolean): Promise<void> {
  const canonical = canonicalAgentRunEvent(event);
  await stream.writeSSE({
    ...(canonical.sequence !== undefined && canonical.sequence !== null ? { id: String(canonical.sequence) } : {}),
    event: String(canonical.type || "reasoning.status"),
    data: JSON.stringify(durable ? { ...canonical, durable: true } : canonical),
  });
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Replay durable events after `after`, then follow until the run's turn is finished. */
async function followRun(host: AgentHost, stream: SSEStreamingApi, runId: string, after: number): Promise<void> {
  let cursor = Math.max(0, Math.trunc(after) || 0);
  try {
    while (!stream.aborted) {
      const batch = await host.state.listEvents(runId, cursor, 500);
      for (const event of batch) {
        cursor = event.sequence;
        await writeEvent(stream, event as unknown as RawRunEvent, true);
      }
      const run = await host.state.loadRun(runId);
      if (!run) {
        await stream.writeSSE({ event: "error", data: JSON.stringify(streamErrorPayload(new Error("Agent Run disappeared"), { run_id: runId })) });
        return;
      }
      if (runtimeTurnIsFinished(run) && cursor >= Number(run.event_sequence || 0)) {
        const conversation = run.conversation_id ? await host.conversations.get(run.conversation_id) : null;
        await stream.writeSSE({ event: "message", data: JSON.stringify({ response: runtimeResponseFromRun(run, conversation?.title || "") }) });
        return;
      }
      await sleep(FOLLOW_POLL_MS);
    }
  } catch (cause) {
    await stream.writeSSE({ event: "error", data: JSON.stringify(streamErrorPayload(cause, { run_id: runId })) });
  }
}

function followResponse(c: Context<AppEnv>, host: AgentHost, runId: string, after: number) {
  return streamSSE(c, (stream) => followRun(host, stream, runId, after));
}

/** A tiny async queue so the run never waits on a slow SSE client. */
function eventQueue() {
  const items: RawRunEvent[] = [];
  let wake: (() => void) | null = null;
  return {
    push(event: RawRunEvent) {
      if (items.length >= 1000) return; // durable log stays authoritative
      items.push(event);
      wake?.();
    },
    async next(timeoutMs: number): Promise<RawRunEvent | null> {
      if (items.length) return items.shift()!;
      await Promise.race([new Promise<void>((resolve) => { wake = resolve; }), sleep(timeoutMs)]);
      wake = null;
      return items.shift() ?? null;
    },
    get size() { return items.length; },
  };
}

export function registerAgent(app: Hono<AppEnv>): void {
  // ---- runtime ----

  app.get("/api/agent/runtime", (c) => c.json(agentHost(c.get("deps")).status()));

  // Hosted CLI providers (codex / claude) are a companion feature not ported yet.
  app.get("/api/agent/runtime/providers/health", (c) => c.json({ providers: [] }));

  // ---- runs ----

  app.post("/api/agent/runtime/runs", async (c) => {
    const deps = c.get("deps");
    requireRunStorage(deps);
    const body = parseRunRequest(await jsonBody(c));
    const host = agentHost(deps);
    if (body.run_id) {
      const existing = await host.state.loadRun(body.run_id);
      if (existing) {
        const conversation = existing.conversation_id ? await host.conversations.get(existing.conversation_id) : null;
        return c.json(runtimeResponseFromRun(existing, conversation?.title || ""));
      }
    }
    const result = await host.conversationTurn({
      message: body.message,
      conversation_id: body.conversation_id,
      task_id: body.task_id,
      run_id: body.run_id,
      attachments: body.attachments,
      options: runOptions(body),
    });
    return c.json(result);
  });

  app.post("/api/agent/runtime/runs/stream", async (c) => {
    const deps = c.get("deps");
    requireRunStorage(deps);
    const body = parseRunRequest(await jsonBody(c));
    const host = agentHost(deps);
    if (body.run_id && await host.state.loadRun(body.run_id)) return followResponse(c, host, body.run_id, 0);

    return streamSSE(c, async (stream) => {
      const queue = eventQueue();
      let activeRunId = body.run_id || "";
      let done = false;
      const task = host.conversationTurn({
        message: body.message,
        conversation_id: body.conversation_id,
        task_id: body.task_id,
        run_id: body.run_id,
        attachments: body.attachments,
        options: runOptions(body),
        listener: (event) => {
          if (event.run_id) activeRunId = String(event.run_id);
          queue.push(event);
        },
      }).finally(() => { done = true; });
      stream.onAbort(() => {
        if (activeRunId) void host.markInterrupted(activeRunId).catch(() => undefined);
      });
      try {
        while (!done || queue.size) {
          const event = await queue.next(FOLLOW_POLL_MS);
          if (event && !stream.aborted) await writeEvent(stream, event);
        }
        const result = await task;
        await stream.writeSSE({ event: "message", data: JSON.stringify({ response: result }) });
      } catch (cause) {
        await stream.writeSSE({
          event: "error",
          data: JSON.stringify(streamErrorPayload(cause, { run_id: activeRunId, task_id: body.task_id || "", provider_id: body.runtime_provider })),
        });
      } finally {
        if (stream.aborted && activeRunId) await host.markInterrupted(activeRunId).catch(() => undefined);
      }
    });
  });

  app.get("/api/agent/runtime/runs/:runId/events/stream", async (c) => {
    const host = agentHost(c.get("deps"));
    const runId = c.req.param("runId");
    if (!await host.state.loadRun(runId)) return c.json({ detail: "Agent Run not found" }, 404);
    return followResponse(c, host, runId, Number(c.req.query("after_sequence") || 0));
  });

  app.post("/api/agent/runtime/runs/:runId/resume", async (c) => {
    const host = agentHost(c.get("deps"));
    let result: Json;
    try {
      result = await host.resumeRun(c.req.param("runId"));
    } catch (cause) {
      // Python maps every ValueError here to 400.
      if (cause instanceof CoreError && cause.code !== "unsupported") throw new CoreError(cause.message, "invalid");
      throw cause;
    }
    const conversationId = String((result.run as Json | undefined)?.conversation_id || "");
    const assistant = String(result.assistant_message || "").trim();
    const conversation = conversationId ? await host.conversations.get(conversationId) : null;
    if (conversation && assistant) {
      const saved = await host.conversations.save(conversationId, [...conversation.messages, { role: "assistant", content: assistant }]);
      result.conversation_id = saved.id;
      result.conversation_title = saved.title;
    }
    return c.json(result);
  });

  app.post("/api/agent/runtime/runs/:runId/steer", async (c) => {
    const host = agentHost(c.get("deps"));
    const raw = await jsonBody(c) as Json;
    const message = str(raw?.message);
    if (!message || message.length > 4000) throw new CoreError("message 需要 1–4000 个字符", "invalid");
    const result = await host.steerRun(c.req.param("runId"), message);
    if (result.disposition === "steered") {
      const conversationId = String((result.run as Json | undefined)?.conversation_id || "");
      const conversation = conversationId ? await host.conversations.get(conversationId) : null;
      if (conversation) await host.conversations.save(conversationId, [...conversation.messages, { role: "user", content: message }]);
    }
    return c.json({ ok: true, disposition: result.disposition || "not_running" });
  });

  app.post("/api/agent/runtime/runs/:runId/abort", async (c) => {
    const host = agentHost(c.get("deps"));
    return c.json(await host.abortRun(c.req.param("runId")));
  });

  app.get("/api/agent/runtime/runs/:runId/input-requests/pending", async (c) => {
    const host = agentHost(c.get("deps"));
    return c.json({ requests: await host.state.pendingInputRequests(c.req.param("runId")) });
  });

  app.post("/api/agent/runtime/runs/:runId/input-requests/:requestId/answer", async (c) => {
    const host = agentHost(c.get("deps"));
    const raw = await jsonBody(c) as Json;
    const answerId = str(raw?.answer_id).trim();
    if (!answerId) throw new CoreError("answer_id 不能为空", "invalid");
    const selected = raw.selected_option_ids;
    if (selected !== undefined && selected !== null && !Array.isArray(selected)) throw new CoreError("selected_option_ids 必须是数组", "invalid");
    const result = await host.answerInput(c.req.param("runId"), c.req.param("requestId"), {
      answer_id: answerId,
      selected_option_ids: (selected as unknown[] | undefined || []).map(String),
      free_text: str(raw.free_text),
      skipped: Boolean(raw.skipped),
    });
    if (!result.ok) {
      const errors = (result.errors as unknown[] | undefined || []).map(String);
      const code = result.error_code === "invalid" ? "invalid" : result.error_code === "not_found" || errors.some((item) => item.includes("不存在")) ? "not_found" : "conflict";
      throw new CoreError(errors.join("; ") || "回答失败", code);
    }
    return c.json(result);
  });

  app.get("/api/agent/runs", async (c) => {
    const host = agentHost(c.get("deps"));
    const runs = await host.state.listRuns({
      conversation_id: c.req.query("conversation_id") || null,
      task_id: c.req.query("task_id") || null,
      limit: Number(c.req.query("limit") || 20),
    });
    return c.json({ runs });
  });

  app.get("/api/agent/runs/:runId", async (c) => {
    const run = await agentHost(c.get("deps")).state.loadRun(c.req.param("runId"));
    if (!run) return c.json({ detail: "Agent Run not found" }, 404);
    return c.json({ run });
  });

  app.get("/api/agent/runs/:runId/events", async (c) => {
    const host = agentHost(c.get("deps"));
    const runId = c.req.param("runId");
    if (!await host.state.loadRun(runId)) return c.json({ detail: "Agent Run not found" }, 404);
    const after = Math.max(0, Number(c.req.query("after_sequence") || 0) || 0);
    const events = await host.state.listEvents(runId, after, Number(c.req.query("limit") || 200));
    return c.json({
      run_id: runId,
      events: events.map((event) => canonicalAgentRunEvent(event as unknown as RawRunEvent)),
      last_sequence: events.length ? events[events.length - 1].sequence : after,
    });
  });

  // ---- conversations ----

  app.get("/api/agent/conversations", async (c) => c.json({ conversations: await agentHost(c.get("deps")).conversations.list() }));

  app.get("/api/agent/conversations/:id", async (c) => {
    const conversation = await agentHost(c.get("deps")).conversations.get(c.req.param("id"));
    if (!conversation) return c.json({ detail: "Conversation not found" }, 404);
    return c.json(conversation);
  });

  app.delete("/api/agent/conversations/:id", async (c) => {
    const id = c.req.param("id");
    return c.json({ ok: await agentHost(c.get("deps")).conversations.delete(id), conversation_id: id });
  });

  // ---- Agent writes timeline (core Agent writes directly; undo is the user's) ----

  app.get("/api/agent/runtime/actions", async (c) => {
    const deps = c.get("deps");
    if (c.req.query("run_id")) return c.json({ items: [] }); // change log rows carry no run id
    return c.json({ items: await agentActions(deps.store, { status: c.req.query("status") || "", limit: Number(c.req.query("limit") || 100) }) });
  });

  app.post("/api/agent/runtime/actions/:actionId/confirm", () => {
    throw new CoreError("没有待确认的动作：Agent 的改动已直接生效，可以撤销", "conflict");
  });

  app.post("/api/agent/runtime/actions/:actionId/reject", () => {
    throw new CoreError("没有待确认的动作：Agent 的改动已直接生效，可以撤销", "conflict");
  });

  app.get("/api/agent/runtime/actions/:actionId/undo-preview", async (c) => {
    return c.json(await agentActionUndoPreview(c.get("deps").store, c.req.param("actionId")));
  });

  app.post("/api/agent/runtime/actions/:actionId/undo", async (c) => {
    const ctx = { actor: USER_ACTOR, now: nowIso(), today: todayIso() };
    return c.json(await undoAgentAction(c.get("deps").store, c.req.param("actionId"), ctx));
  });
}
