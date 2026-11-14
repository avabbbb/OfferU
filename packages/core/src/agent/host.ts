// The embedded Agent host: one governed Run per user turn. Port of
// backend/app/services/embedded_agent_host.py + embedded_agent_worker.py and
// the conversation bookkeeping of routes/main_agent.py (start_runtime_run /
// stream_runtime_run). Event names, payload fields and the durable /
// non-durable split match Python so the frontend stream code is unchanged.
//
// Runtime-agnostic: LLM, tools, prompt and storage are injected.

import { CoreError } from "../types";
import type { ChatContentPart, ChatMessage, LlmClient } from "../llm";
import { sanitizeLlmError } from "../llm";
import { runAgentLoop, type AgentTool, type LoopEvent } from "./loop";
import { MAX_STEPS } from "./prompt";
import {
  AgentConversations,
  AgentRunState,
  type AgentInputRequest,
  type AgentRun,
  type AgentRunEvent,
} from "./run-state";
import type { Json } from "../types";
import type { RawRunEvent } from "./events";

export const PROTOCOL_VERSION = "offeru.ts-agent.v1";
export const RUNTIME_ID = "ts_agent";
const SKILL_ID = "offeru";
export const CONTEXT_WINDOW_TOKENS = 64000;
export const CONTEXT_RESERVE_TOKENS = 8000;
const DELTA_FLUSH_CHARS = 512;

export interface RunOptions {
  llm_config_id?: string;
  reasoning_effort?: "" | "low" | "medium" | "high";
  approval_mode?: "auto" | "ask";
  max_steps?: number;
  journey_id?: string;
}

export interface ResolvedLlm {
  client: LlmClient;
  metadata: { provider: string; model: string; source: string };
}

export interface PreparedAttachments {
  /** Text the model reads (documents inlined). */
  modelMessage: string;
  /** Text stored in the conversation. */
  historyMessage: string;
  attachments: Array<{ id: string; name: string; kind: "image" | "document" }>;
  /** data: URLs of images for vision models. */
  images: string[];
}

export interface AgentHostDeps {
  state: AgentRunState;
  conversations: AgentConversations;
  resolveLlm(options: RunOptions): Promise<ResolvedLlm>;
  /** Core tools bound to the Agent actor. */
  tools(): AgentTool[];
  systemPrompt(options: { maxSteps: number }): Promise<string>;
  /** Read uploaded attachments; absent means attachments are unsupported here. */
  prepareAttachments?(message: string, ids: string[]): Promise<PreparedAttachments>;
  /** User decisions on queued actions the Agent has not heard about (action_gate.take_decisions_for_agent). */
  takeDecisions?(runId: string, conversationId: string): Promise<string>;
  maxConcurrentRuns?: number;
}

export type StreamListener = (event: RawRunEvent) => void | Promise<void>;

export interface RunResult {
  ok: boolean;
  run: AgentRun;
  assistant_message: string;
  pending_actions: Json[];
  input_request?: AgentInputRequest | null;
  errors?: string[];
  conversation_id?: string;
  conversation_title?: string;
  [key: string]: unknown;
}

interface ActiveRun {
  controller: AbortController;
  steering: ChatMessage[];
  promptActive: boolean;
}

/** Same heuristics as embedded_agent_host._announces_next_step / _dangling_reference. */
export function announcesNextStep(text: string): boolean {
  const tail = text.trim().split("\n").at(-1) ?? "";
  if (tail.includes("你") || tail.includes("建议")) return false;
  return /(接下来|下一步|然后|稍后|随后)[^。？?]{0,30}(会|再|就|先|去|开始|评估|写|生成|准备)/.test(tail);
}

export function danglingReference(text: string): boolean {
  const tail = (text.trim().split("\n").at(-1) ?? "").trim();
  return /(\b(is|are)\s+(as\s+follows|below)|\bbelow\s*:|如下|见下[文方]?|以下[^。？?]{0,20}[：:])\s*[。.：:]?\s*$/i.test(tail);
}

export function promptWithContext(goal: string, contextMessages: Array<{ role: string; content: string }> | undefined): string {
  const rows: string[] = [];
  for (const item of (contextMessages || []).slice(-12)) {
    const role = String(item.role || "").trim();
    const content = String(item.content || "").trim();
    if ((role !== "user" && role !== "assistant") || !content) continue;
    rows.push(`${role}: ${content.slice(0, 2000)}`);
  }
  if (!rows.length) return goal;
  return "Prior task conversation (context only; Operation results remain the source "
    + `of truth):\n${rows.join("\n").slice(0, 10_000)}\n\nCurrent user request:\n${goal}`;
}

function contextUsage(event: Extract<LoopEvent, { type: "turn_end" }>): Json {
  const usage = event.usage;
  if (usage && usage.input_tokens > 0 && !usage.estimated) {
    return { used: usage.input_tokens + usage.output_tokens, window: CONTEXT_WINDOW_TOKENS, compact_at: CONTEXT_WINDOW_TOKENS - CONTEXT_RESERVE_TOKENS, estimated: false };
  }
  const used = Math.max(1, Math.floor(JSON.stringify(event.messages).length / 4));
  return { used, window: CONTEXT_WINDOW_TOKENS, compact_at: CONTEXT_WINDOW_TOKENS - CONTEXT_RESERVE_TOKENS, estimated: true };
}

const REQUEST_USER_INPUT_SCHEMA = {
  type: "object",
  properties: {
    question: { type: "string", minLength: 1 },
    reason: { type: "string" },
    options: {
      type: "array",
      items: {
        type: "object",
        properties: {
          option_id: { type: "string" },
          label: { type: "string" },
          description: { type: "string" },
          recommended: { type: "boolean" },
        },
        required: ["option_id", "label"],
        additionalProperties: false,
      },
    },
    allow_free_text: { type: "boolean" },
    selection_mode: { type: "string", enum: ["single", "multiple"] },
    min_selections: { type: "integer", minimum: 0 },
    max_selections: { type: "integer", minimum: 0 },
    allow_skip: { type: "boolean" },
  },
  required: ["question"],
  additionalProperties: false,
};

const REQUEST_USER_INPUT_DESCRIPTION = "向用户提出一个结构化问题（Ask）。仅当缺少的用户偏好或取舍"
  + "决定无法从现有数据推断时使用；绝不能用来请求批准受保护"
  + "变更或代替用户做决定。调用后本轮立即结束。"
  + "互斥选项用 selection_mode=single（默认）；只有可同时成立的"
  + "选项才用 multiple。最可能的选项标 recommended=true。";

export class AgentHost {
  private readonly active = new Map<string, ActiveRun>();
  private readonly continuationLocks = new Map<string, Promise<unknown>>();

  constructor(private readonly deps: AgentHostDeps) {}

  get state(): AgentRunState { return this.deps.state; }
  get conversations(): AgentConversations { return this.deps.conversations; }

  activeRunIds(): string[] { return [...this.active.keys()]; }

  maxConcurrentRuns(): number {
    return Math.min(10, Math.max(1, this.deps.maxConcurrentRuns ?? 3));
  }

  /** GET /api/agent/runtime — EmbeddedAgentRuntimeProvider.status(). */
  status(): Json {
    return {
      provider_id: "embedded",
      runtime: RUNTIME_ID,
      status: "ready",
      available: true,
      authenticated: null,
      blocked: false,
      version: "offeru-ts-agent",
      protocol_version: "offeru.agent-runtime.v1",
      capabilities: { stream: true, resume: true, approval: true, live_web_search: false },
      kernel: "ts",
      session_scope: "one_session_per_agent_run",
      active_runs: this.active.size,
      max_concurrent_runs: this.maxConcurrentRuns(),
      features: { persistent_sessions: true, compaction: false, steer: true, follow_up: false, registry_tools_only: true },
    };
  }

  /**
   * One conversation turn (routes/main_agent.py start_runtime_run / stream_runtime_run):
   * save the user message, run, append the assistant reply to the latest
   * conversation copy, and tag the result with the conversation id / title.
   */
  async conversationTurn(input: {
    message: string;
    conversation_id?: string | null;
    task_id?: string | null;
    run_id?: string | null;
    attachments?: string[];
    options?: RunOptions;
    listener?: StreamListener;
  }): Promise<RunResult> {
    const prepared = await this.prepare(input.message, input.attachments || []);
    const previous = input.conversation_id ? await this.conversations.get(input.conversation_id) : null;
    const previousMessages = previous?.messages || [];
    const conversation = await this.conversations.save(input.conversation_id, [
      ...previousMessages,
      { role: "user", content: prepared.historyMessage, attachments: prepared.attachments },
    ]);
    const result = await this.startRun({
      message: prepared.modelMessage,
      images: prepared.images,
      conversationId: conversation.id,
      taskId: String(input.task_id || ""),
      contextMessages: previousMessages.map((item) => ({ role: item.role, content: item.content })),
      requestedRunId: String(input.run_id || ""),
      options: input.options || {},
      listener: input.listener,
    });
    let completed = conversation;
    const assistant = String(result.assistant_message || "").trim();
    if (assistant) {
      // Re-read: steering and parallel runs may have appended meanwhile.
      const latest = await this.conversations.get(conversation.id) || conversation;
      completed = await this.conversations.save(conversation.id, [...latest.messages, { role: "assistant", content: assistant }]);
    }
    result.conversation_id = completed.id;
    result.conversation_title = completed.title;
    return result;
  }

  private async prepare(message: string, ids: string[]): Promise<PreparedAttachments> {
    if (!ids.length) return { modelMessage: message.trim(), historyMessage: message.trim(), attachments: [], images: [] };
    if (!this.deps.prepareAttachments) throw new CoreError("当前运行环境不支持附件；请在本机 OfferU 里发送文件", "unsupported");
    return this.deps.prepareAttachments(message, ids);
  }

  async startRun(input: {
    message: string;
    images?: string[];
    conversationId?: string;
    taskId?: string;
    contextMessages?: Array<{ role: string; content: string }>;
    requestedRunId?: string;
    options?: RunOptions;
    listener?: StreamListener;
    resumeRunId?: string;
    continuation?: boolean;
  }): Promise<RunResult> {
    const state = this.deps.state;
    const options = input.options || {};
    const maxSteps = options.max_steps || MAX_STEPS;
    let goal = String(input.message || "").trim();
    if (!goal && !input.resumeRunId) throw new CoreError("Agent Run 需要非空消息。", "invalid");
    if (!input.resumeRunId && this.active.size >= this.maxConcurrentRuns()) {
      throw new CoreError(`已达到最大并发数 ${this.maxConcurrentRuns()}，请等待其他任务完成或在设置中调高。`, "conflict");
    }

    let run: AgentRun;
    let session: ChatMessage[] = [];
    if (input.resumeRunId) {
      const existing = await state.loadRun(input.resumeRunId);
      if (!existing) throw new CoreError(`Agent Run ${input.resumeRunId} 不存在。`, "not_found");
      if (String(existing.llm_runtime?.runtime || "") !== RUNTIME_ID) {
        throw new CoreError("旧 Agent 会话已保留为历史，不能由新内核自动重放；请开启新的任务。", "conflict");
      }
      const allowed = input.continuation ? ["completed", "interrupted", "failed"] : ["interrupted"];
      if (!allowed.includes(existing.status)) throw new CoreError(`Agent Run ${input.resumeRunId} 不能恢复（status=${existing.status}）。`, "conflict");
      if (this.active.has(existing.id)) throw new CoreError("A model turn is already running", "conflict");
      goal = goal || String(existing.goal || "").trim();
      const stored = await state.store.getSession(existing.id);
      if (!stored) throw new CoreError("Run 没有可恢复的 Agent Session，不能确定性恢复。", "conflict");
      const last = stored.at(-1);
      if (last?.role === "assistant" && last.tool_calls?.length) throw new CoreError("Interrupted tool batch needs reconciliation", "conflict");
      session = stored;
      run = existing;
    } else {
      run = await state.createRun({
        conversation_id: input.conversationId || "",
        task_id: input.taskId,
        goal,
        mode: "core",
        skill_id: SKILL_ID,
        skill_version: "core",
        skill_snapshot: { id: SKILL_ID, name: "OfferU" },
        exit_criteria: [
          "the user goal is answered from tool results",
          "every irreversible write is either confirmed by the user or visibly waiting",
        ],
        llm_runtime: { runtime: RUNTIME_ID, provider_id: "embedded", protocol_version: PROTOCOL_VERSION, stream_protocol: "cursor_v1", status: "configuring" },
        run_id: input.requestedRunId,
      });
    }
    const runId = run.id;
    const listener = input.listener;
    const activeRun: ActiveRun = { controller: new AbortController(), steering: [], promptActive: false };
    this.active.set(runId, activeRun);

    const publish = async (type: string, payload: Json, extra: Partial<AgentRunEvent> & { durable?: boolean } = {}) => {
      if (!listener) return;
      const event: RawRunEvent = { run_id: runId, type, payload, durable: Boolean(extra.durable) };
      if (extra.sequence !== undefined) event.sequence = extra.sequence;
      if (extra.event_id) event.event_id = extra.event_id;
      if (extra.timestamp) event.timestamp = extra.timestamp;
      try {
        await listener(event);
      } catch {
        // A detached or slow UI never blocks the run; the durable log is authoritative.
      }
    };
    const publishPersisted = (event: AgentRunEvent) => publish(event.type, event.payload || {}, { sequence: event.sequence, event_id: event.event_id, timestamp: event.timestamp, durable: true });
    const persistAndPublish = async (type: string, payload: Json) => {
      const event = await state.appendEvent(runId, type, payload);
      await publishPersisted(event);
      return event;
    };
    const runtimeTag = { runtime: RUNTIME_ID, provider_id: "embedded" };

    const deltaBuffer: Array<{ delta_index: number; delta: string }> = [];
    let nextDeltaIndex = 0;
    const flushDeltas = async () => {
      if (!deltaBuffer.length) return;
      const parts = deltaBuffer.splice(0, deltaBuffer.length);
      const event = await state.appendEvent(runId, "message.delta", {
        delta: parts.map((part) => part.delta).join(""),
        parts,
        delta_index_start: parts[0].delta_index,
        delta_index_end: parts[parts.length - 1].delta_index,
        ...runtimeTag,
      });
      await publish("stream.cursor", { cursor_for: "message.delta", delta_index_end: parts[parts.length - 1].delta_index }, { sequence: event.sequence });
    };
    const persistWorkerEvent = async (type: string, payload: Json, source: string) => {
      await flushDeltas();
      await persistAndPublish(type, { ...payload, ...runtimeTag, source_event: source });
    };

    const turnState: { inputRequest: AgentInputRequest | null } = { inputRequest: null };
    const tools = this.deps.tools();
    const describe = new Map(tools.map((tool) => [tool.name, tool.description]));
    const askTool: AgentTool = {
      name: "request_user_input",
      description: REQUEST_USER_INPUT_DESCRIPTION,
      parameters: REQUEST_USER_INPUT_SCHEMA,
      execute: async (args) => {
        let request: AgentInputRequest;
        try {
          request = await state.createInputRequest(runId, {
            question: String(args.question || ""),
            reason: String(args.reason || ""),
            options: Array.isArray(args.options) ? args.options.filter((item): item is Json => Boolean(item) && typeof item === "object") : [],
            allow_free_text: args.allow_free_text === undefined ? true : Boolean(args.allow_free_text),
            selection_mode: String(args.selection_mode || "single"),
            min_selections: args.min_selections,
            max_selections: args.max_selections,
            allow_skip: args.allow_skip === undefined ? true : Boolean(args.allow_skip),
          });
        } catch (cause) {
          const result = { ok: false, errors: [cause instanceof Error ? cause.message : String(cause)] };
          return { text: JSON.stringify(result), isError: true, details: result };
        }
        turnState.inputRequest = request;
        await flushDeltas();
        await persistAndPublish("input.required", { request, run_id: runId });
        const latest = await state.loadRun(runId);
        if (latest) await publish("stream.cursor", { cursor_for: "input.required" }, { sequence: latest.event_sequence });
        const result = { ok: true, terminate: true, input_request: request, message: "提问已持久化；本轮结束，用户回答后会作为新一轮继续。" };
        return { text: JSON.stringify(result), isError: false, terminate: true, details: result };
      },
    };

    const failRun = async (cause: unknown): Promise<RunResult> => {
      const message = sanitizeLlmError(cause instanceof Error ? cause.message : String(cause), 1000);
      await flushDeltas().catch(() => undefined);
      const latest = await state.loadRun(runId);
      if (latest?.status === "cancelled") {
        return { ok: false, run: latest, assistant_message: String(latest.final_result?.assistant_message || ""), pending_actions: [], errors: ["Run 已由使用者取消。"] };
      }
      await state.expirePendingInputRequests(runId, "run_failed").catch(() => 0);
      let failed = latest || run;
      failed = await state.saveRun({
        ...failed,
        status: "failed",
        llm_runtime: { ...failed.llm_runtime, status: "failed" },
        failure_reason: message,
        final_result: { ...failed.final_result, terminal_state: "failed", stop_reason: "error", turn_finished: false },
      }, { type: "runtime.failed", payload: { error: message } });
      await publish("run.failed", { status: "failed", error: message });
      await persistAndPublish("run.turn_finished", { status: "failed" });
      const reloaded = await state.loadRun(runId) || failed;
      failed = await state.saveRun({ ...reloaded, final_result: { ...reloaded.final_result, turn_finished: true } });
      return { ok: false, run: failed, assistant_message: "", pending_actions: [], errors: [message] };
    };

    try {
      await publish("run.created", { task_id: run.task_id, skill_id: SKILL_ID, status: run.status });
      if (!input.resumeRunId) for (const seed of await state.listEvents(runId)) await publishPersisted(seed);
      const llm = await this.deps.resolveLlm(options);
      const metadata = { runtime: RUNTIME_ID, provider_id: "embedded", protocol_version: PROTOCOL_VERSION, ...llm.metadata };
      run = await state.saveRun(
        { ...run, status: "executing", llm_runtime: { ...run.llm_runtime, ...metadata, status: input.resumeRunId ? "resuming" : "starting", session_id: runId } },
        input.resumeRunId ? { type: "recovery.started", payload: { session_id: runId } } : undefined,
      );
      await publish(input.resumeRunId ? "runtime.resuming" : "runtime.starting", { provider: llm.metadata.provider, model: llm.metadata.model });

      await state.store.putSession(runId, session);
      await persistWorkerEvent("runtime.session_started", { session_id: runId, kernel: "ts" }, "run.started");
      const allTools = [...tools, askTool];
      const current = await state.loadRun(runId) || run;
      run = await state.saveRun({ ...current, llm_runtime: { ...current.llm_runtime, ...metadata, status: "active", session_id: runId, active_tools: allTools.map((tool) => tool.name) } });

      let promptMessage = input.resumeRunId && !input.continuation
        ? `Resume this interrupted OfferU Agent Run from the persisted Agent Session. Do not claim interrupted work completed. Original goal:\n${goal}`
        : input.resumeRunId ? goal : promptWithContext(goal, input.contextMessages);
      const decisions = this.deps.takeDecisions ? await this.deps.takeDecisions(runId, String(run.conversation_id || "")) : "";
      promptMessage = [decisions, promptMessage].filter(Boolean).join("\n\n");
      const userContent: string | ChatContentPart[] = input.images?.length
        ? [{ type: "text", text: promptMessage }, ...input.images.map((url) => ({ type: "image_url" as const, image_url: { url } }))]
        : promptMessage;
      session = [...session, { role: "user", content: userContent }];
      await state.store.putSession(runId, session);

      activeRun.promptActive = true;
      const systemPrompt = await this.deps.systemPrompt({ maxSteps });
      const result = await runAgentLoop({
        client: llm.client,
        systemPrompt,
        messages: session,
        tools: allTools,
        softLimit: maxSteps,
        hardLimit: maxSteps + 1,
        signal: activeRun.controller.signal,
        reasoningEffort: options.reasoning_effort || "",
        takeSteering: () => activeRun.steering.splice(0, activeRun.steering.length),
        onSavePoint: (messages) => state.store.putSession(runId, messages),
        emit: async (event) => {
          switch (event.type) {
            case "text_delta": {
              if (!event.text) return;
              const part = { delta_index: nextDeltaIndex, delta: event.text };
              nextDeltaIndex += 1;
              deltaBuffer.push(part);
              await publish("message.delta", { ...part, ...runtimeTag });
              if (deltaBuffer.reduce((size, item) => size + item.delta.length, 0) >= DELTA_FLUSH_CHARS) await flushDeltas();
              return;
            }
            case "thinking_delta":
              return;
            case "agent_start":
              return persistWorkerEvent("runtime.agent_started", {}, "kernel.agent_start");
            case "turn_start":
              return persistWorkerEvent("runtime.turn_started", {}, "kernel.turn_start");
            case "turn_end":
              return persistWorkerEvent("runtime.turn_completed", { context_usage: contextUsage(event) }, "kernel.turn_end");
            case "agent_end":
              return persistWorkerEvent("runtime.agent_settled", {}, "kernel.agent_end");
            case "tool_execution_start":
            case "tool_execution_end": {
              const started = event.type === "tool_execution_start";
              return persistWorkerEvent(started ? "runtime.tool_started" : "runtime.tool_completed", {
                tool_call_id: event.tool_call_id,
                operation: event.tool_name,
                args: event.args,
                description: describe.get(event.tool_name) || (event.tool_name === askTool.name ? askTool.description : ""),
                result: started ? null : event.result,
                is_error: started ? false : event.is_error,
              }, started ? "tool.started" : "tool.completed");
            }
          }
        },
      });
      activeRun.promptActive = false;
      await state.store.putSession(runId, result.messages);
      await flushDeltas();
      if (result.stopReason === "error" || result.stopReason === "aborted") {
        let detail = sanitizeLlmError(result.error || result.stopReason);
        if (input.images?.length && result.stopReason === "error") {
          detail = `当前模型可能不支持图片输入，请换一个支持视觉的模型，或去掉图片后重试。模型返回：${detail}`;
        }
        throw new Error(detail);
      }

      let assistant = result.assistantText.trim();
      let stopReason = String(result.stopReason || "stop");
      if (stopReason === "hard_loop_limit" && !assistant) {
        assistant = `步数预算用完（${maxSteps} 轮工具），任务只完成了一部分；已做的改动在「最近改动」里，可以说「继续」接着做。`;
      }
      const pendingActions: Json[] = [];
      let inputRequest = turnState.inputRequest;
      if (!inputRequest) inputRequest = (await state.pendingInputRequests(runId))[0] ?? null;
      if (!assistant && !pendingActions.length && !inputRequest) {
        throw new Error("主 Agent 未返回任何回复；请检查 LLM API Key / 模型 / Base URL 配置是否有效。");
      }
      const tail = assistant.trimEnd().split("\n").at(-1) ?? "";
      const askedUser = /[？?]$/.test(tail.replace(/[ 。.]+$/, ""));
      if (stopReason === "stop" && askedUser && !inputRequest && !pendingActions.length) stopReason = "asked_user";
      if (stopReason === "stop" && !inputRequest && !pendingActions.length && announcesNextStep(assistant)) stopReason = "announced_next_step";
      if (stopReason === "stop" && !inputRequest && !pendingActions.length && danglingReference(assistant)) stopReason = "missing_body";
      const terminalState = ["hard_loop_limit", "announced_next_step", "missing_body"].includes(stopReason)
        ? "partial"
        : inputRequest || pendingActions.length || askedUser ? "waiting_user" : "completed";

      let latest = await state.loadRun(runId) || run;
      latest = await state.saveRun({
        ...latest,
        status: "completed",
        final_result: {
          ...latest.final_result,
          assistant_message: assistant,
          pending_action_count: pendingActions.length,
          requires_input: inputRequest !== null,
          input_request: inputRequest,
          turn_finished: false,
          terminal_state: terminalState,
          stop_reason: stopReason,
          steps_used: result.turns,
        },
      });
      if (inputRequest) await publish("run.waiting_input", { input_request: inputRequest });
      await publish("run.completed", { status: "completed" });
      await persistWorkerEvent("runtime.disposed", {}, "run.disposed");
      await persistAndPublish("run.turn_finished", { status: latest.status });
      const reloaded = await state.loadRun(runId) || latest;
      const finished = await state.saveRun({ ...reloaded, final_result: { ...reloaded.final_result, turn_finished: true } });
      return { ok: true, run: finished, assistant_message: assistant, pending_actions: pendingActions, input_request: inputRequest };
    } catch (cause) {
      activeRun.promptActive = false;
      return await failRun(cause);
    } finally {
      this.active.delete(runId);
    }
  }

  /** Mark an executing run interrupted (client disconnected mid-stream). */
  async markInterrupted(runId: string, reason = "client_disconnected"): Promise<void> {
    this.active.get(runId)?.controller.abort();
    const run = await this.deps.state.loadRun(runId);
    if (!run || ["completed", "failed", "cancelled", "interrupted"].includes(run.status)) return;
    await this.deps.state.saveRun({ ...run, status: "interrupted", recovery_cursor: { ...run.recovery_cursor, reason } });
  }

  async resumeRun(runId: string, options: RunOptions = {}): Promise<RunResult> {
    const run = await this.deps.state.loadRun(runId);
    if (!run) throw new CoreError(`Agent Run ${runId} 不存在。`, "not_found");
    return this.startRun({ message: String(run.goal || ""), conversationId: run.conversation_id, taskId: run.task_id, resumeRunId: runId, options });
  }

  async abortRun(runId: string): Promise<Json> {
    const state = this.deps.state;
    let run = await state.loadRun(runId);
    if (!run) throw new CoreError(`Agent Run ${runId} 不存在。`, "not_found");
    if (["completed", "failed", "cancelled"].includes(run.status)) return { ok: true, run, warnings: ["Run 已经结束。"] };
    // Persist cancelled first so the running turn's error path ends as "cancelled", not "failed".
    run = await state.saveRun({ ...run, status: "cancelled", failure_reason: "cancelled_by_user" });
    const active = this.active.get(runId);
    if (active) {
      active.controller.abort();
      await state.appendEvent(runId, "runtime.aborted", { runtime: RUNTIME_ID, provider_id: "embedded", source_event: "run.aborted" });
    }
    await state.expirePendingInputRequests(runId, "run_cancelled").catch(() => 0);
    run = await state.loadRun(runId) || run;
    run = await state.saveRun({ ...run, status: "cancelled", failure_reason: "cancelled_by_user", final_result: { ...run.final_result, turn_finished: false } });
    await state.appendEvent(runId, "run.turn_finished", { status: "cancelled" });
    run = await state.loadRun(runId) || run;
    run = await state.saveRun({ ...run, final_result: { ...run.final_result, turn_finished: true } });
    return { ok: true, run };
  }

  async steerRun(runId: string, message: string): Promise<Json> {
    const text = String(message || "").trim();
    if (!text) throw new CoreError("引导消息不能为空。", "invalid");
    const run = await this.deps.state.loadRun(runId);
    if (!run) throw new CoreError(`Agent Run ${runId} 不存在。`, "not_found");
    const active = this.active.get(runId);
    if (!active || !active.promptActive) return { ok: true, disposition: "not_running", run };
    active.steering.push({ role: "user", content: text.slice(0, 4000) });
    await this.deps.state.appendEvent(runId, "input.steered", { characters: text.length });
    return { ok: true, disposition: "steered", run };
  }

  /** embedded_agent_host.answer_agent_input: persist one answer, continue the same run exactly once. */
  async answerInput(runId: string, requestId: string, body: { answer_id: string; selected_option_ids?: string[]; free_text?: string; skipped?: boolean }, options: RunOptions = {}): Promise<Json> {
    const state = this.deps.state;
    const answer: Json = {
      answer_id: String(body.answer_id || "").trim(),
      selected_option_ids: (body.selected_option_ids || []).map(String).filter((item) => item.trim()),
      free_text: String(body.free_text || "").slice(0, 4000),
    };
    if (body.skipped) answer.skipped = true;
    const stored = await state.answerInputRequest(runId, requestId, answer);
    if (!stored.ok) {
      const errors = stored.error === "invalid" ? stored.errors || [] : stored.error === "not_found" ? ["input request 不存在于该 Run。"] : ["input request 已有不同的回答；拒绝覆盖。"];
      return { ok: false, error_code: stored.error, errors, ...(stored.request ? { request: stored.request } : {}) };
    }
    const request = stored.request;
    const run = await state.loadRun(runId);
    const result: Json = { ok: true, request, duplicate: stored.duplicate, run };
    if (stored.duplicate) return { ...result, warnings: ["相同回答已持久化；没有重复续跑。"] };
    await state.appendEvent(runId, "input.answered", { request_id: requestId, answer_id: answer.answer_id });
    if (!await state.consumeInputRequest(requestId)) {
      return { ...result, run: await state.loadRun(runId) || run, warnings: ["该回答已触发过续跑；返回当前持久化状态。"] };
    }
    const effective = request.answer || answer;
    const answerText = "The user answered your earlier question (persisted answer, the only "
      + "authoritative content). Continue the original goal; do not ask the "
      + "same question again.\n"
      + (effective.skipped ? "The user skipped this question: proceed with the most reasonable default and state that assumption briefly.\n" : "")
      + JSON.stringify({ question: request.question, answer: effective })
      + "\nOriginal goal:\n" + String(run?.goal || "");
    const previous = this.continuationLocks.get(runId) || Promise.resolve();
    const work = previous.catch(() => undefined).then(async () => {
      const latest = await state.loadRun(runId);
      if (!latest || latest.status === "cancelled") return { ...result, run: latest || run, warnings: ["Run 已取消；回答已持久化但未续跑。"] };
      let continued: RunResult;
      try {
        continued = await this.startRun({ message: answerText, resumeRunId: runId, continuation: true, options });
      } catch (cause) {
        const failedMessage = cause instanceof Error ? cause.message : String(cause);
        const current = await state.loadRun(runId);
        const saved = current
          ? await state.saveRun({ ...current, status: "failed", failure_reason: failedMessage }, { type: "runtime.failed", payload: { phase: "input_continuation", error: failedMessage } })
          : null;
        continued = { ok: false, run: saved as AgentRun, assistant_message: "", pending_actions: [], errors: [failedMessage] };
      }
      return {
        ...result,
        run: continued.run || result.run,
        continuation: continued,
        ...(continued.ok ? {} : { warnings: ["回答已持久化；Agent 续跑失败，请查看 Run 的失败原因。"] }),
      };
    });
    this.continuationLocks.set(runId, work);
    try {
      return await work;
    } finally {
      if (this.continuationLocks.get(runId) === work) this.continuationLocks.delete(runId);
    }
  }
}
