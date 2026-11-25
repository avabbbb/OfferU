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
import { reconcileToolBatch } from "./reconcile";
import { delegateTool } from "./subagent";
import { compactionPolicyFor, type CompactionPolicy } from "./compaction";
import { DEFAULT_CONTEXT_WINDOW_TOKENS, resolveContextWindow } from "../llm-context";
import type { StreamGuardPolicy } from "./stream-guard";
import { MAX_STEPS } from "./prompt";
import { applySandbox, resolveSandbox, type SandboxMode } from "./sandbox";
import {
  AgentConversations,
  AgentRunState,
  type AgentInputRequest,
  type AgentRun,
  type AgentRunEvent,
} from "./run-state";
import type { Json } from "../types";
import type { ReasoningEffort } from "../llm-reasoning";
import type { RawRunEvent } from "./events";

export const PROTOCOL_VERSION = "offeru.ts-agent.v1";
export const RUNTIME_ID = "ts_agent";
const SKILL_ID = "offeru";
/** Default context window (256K); per model it is capped at the model's known limit (llm-context.ts). */
export const CONTEXT_WINDOW_TOKENS = DEFAULT_CONTEXT_WINDOW_TOKENS;
export const CONTEXT_RESERVE_TOKENS = compactionPolicyFor(CONTEXT_WINDOW_TOKENS).reserveTokens;
export const CONTEXT_KEEP_RECENT_TOKENS = compactionPolicyFor(CONTEXT_WINDOW_TOKENS).keepRecentTokens;
const DELTA_FLUSH_CHARS = 512;

export interface RunOptions {
  llm_config_id?: string;
  /** Model id inside that service; "" = the service's configured model. */
  model?: string;
  reasoning_effort?: ReasoningEffort;
  approval_mode?: "auto" | "ask";
  /** read_only：写类工具不执行，回 read_only 错误（agent/sandbox.ts）。不给就沿用这个 Run 记下的，默认可写。 */
  sandbox?: SandboxMode;
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
  /**
   * Change ids a tool call of this run committed (ChangeRow.op "<run>:<call>"). Used on resume to
   * close a tool batch the process died in. Absent: every unanswered call counts as not executed.
   */
  committedChanges?: (runId: string, callId: string) => Promise<number[]>;
  /** Offer delegate_research (read-only sub-agents) to the model. Default true. */
  subagents?: boolean;
  /** `texts`: the user's message + recent conversation, for auto-loading matching skills. */
  systemPrompt(options: { maxSteps: number; texts?: string[] }): Promise<string>;
  /** Read uploaded attachments; absent means attachments are unsupported here. */
  prepareAttachments?(message: string, ids: string[]): Promise<PreparedAttachments>;
  /** User decisions on queued actions the Agent has not heard about (action_gate.take_decisions_for_agent). */
  takeDecisions?(runId: string, conversationId: string): Promise<string>;
  /**
   * Run admission limit: a number, or read per admission (settings: max_concurrent_agent_runs).
   * New runs, resumes and answer continuations all count against it.
   */
  maxConcurrentRuns?: number | (() => number | Promise<number>);
  /** Override the stream timeouts / retries (tests); default stream-guard DEFAULT_STREAM_GUARD. */
  streamGuard?: StreamGuardPolicy | false;
  /** Override context compaction (tests); default compactionPolicyFor(contextWindow(...)). */
  compaction?: CompactionPolicy | false;
  /**
   * Context window for this run's model (config: per-service / global, capped at the model's
   * known limit). Absent: resolveContextWindow({ model }) — 256K capped at the model limit.
   */
  contextWindow?(llm: ResolvedLlm, options: RunOptions): number | Promise<number>;
  /** Default tool-step budget when the request gives none (config agent_max_steps); absent = MAX_STEPS. */
  defaultMaxSteps?(): number | undefined | Promise<number | undefined>;
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

/** A reserved run slot: taken synchronously before any await, released once (idempotent). */
export interface AdmissionTicket {
  /** The run is now in `active` (counted there): drop the reservation, keep the resume guard. */
  activate(): void;
  release(): void;
}

const clampRuns = (value: unknown): number => Math.min(10, Math.max(1, Math.trunc(Number(value)) || 3));

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
  /** Slots reserved by admit() whose run is not in `active` yet (record still being created). */
  private readonly admitting = new Set<symbol>();
  /** Runs being resumed / continued right now (reserved or active), so one run never runs twice. */
  private readonly resuming = new Set<string>();
  /** Conversations with a turn in flight: one turn per conversation at a time. */
  private readonly busyConversations = new Set<string>();
  private lastLimit = 3;

  constructor(private readonly deps: AgentHostDeps) {}

  get state(): AgentRunState { return this.deps.state; }
  get conversations(): AgentConversations { return this.deps.conversations; }

  activeRunIds(): string[] { return [...this.active.keys()]; }

  /** The admission limit last read (status display); admit() reads it fresh. */
  maxConcurrentRuns(): number {
    const configured = this.deps.maxConcurrentRuns;
    return typeof configured === "function" ? this.lastLimit : clampRuns(configured ?? 3);
  }

  private async readLimit(): Promise<number> {
    const configured = this.deps.maxConcurrentRuns;
    if (typeof configured !== "function") return clampRuns(configured ?? 3);
    try {
      this.lastLimit = clampRuns(await configured());
    } catch {
      // settings unreadable: keep the last known limit
    }
    return this.lastLimit;
  }

  /**
   * Reserve a run slot. The limit is read first (may await); the check and the reservation then
   * happen in one synchronous step, so concurrent requests cannot all pass the check before any
   * of them is counted. New runs, resumes and answer continuations share this gate.
   */
  async admit(resumeRunId = ""): Promise<AdmissionTicket> {
    const limit = await this.readLimit();
    if (resumeRunId && (this.active.has(resumeRunId) || this.resuming.has(resumeRunId))) {
      throw new CoreError("这个对话已经有一轮在运行，等它结束再继续", "conflict");
    }
    if (this.active.size + this.admitting.size >= limit) {
      throw new CoreError(`已达到最大并发数 ${limit}，请等待其他任务完成或在设置中调高。`, "conflict");
    }
    const slot = Symbol("run-slot");
    this.admitting.add(slot);
    if (resumeRunId) this.resuming.add(resumeRunId);
    let released = false;
    return {
      activate: () => { this.admitting.delete(slot); },
      release: () => {
        if (released) return;
        released = true;
        this.admitting.delete(slot);
        if (resumeRunId) this.resuming.delete(resumeRunId);
      },
    };
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
      admitting_runs: this.admitting.size,
      max_concurrent_runs: this.maxConcurrentRuns(),
      features: { persistent_sessions: true, compaction: true, steer: true, follow_up: false, registry_tools_only: true },
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
    // One turn per conversation: a second request would read the same history and its reply
    // could land out of order. Checked and claimed synchronously; the UI steers or queues instead.
    const claimed = input.conversation_id ? String(input.conversation_id) : "";
    if (claimed && this.busyConversations.has(claimed)) {
      throw new CoreError("这个对话还有一轮在运行：可以插话引导当前这轮、排队发下一条，或开一个新对话。", "conflict");
    }
    if (claimed) this.busyConversations.add(claimed);
    let ticket: AdmissionTicket | null = null;
    let conversationId = claimed;
    try {
      // Admit before writing anything, so a refused turn leaves no orphan user message.
      ticket = await this.admit();
      const prepared = await this.prepare(input.message, input.attachments || []);
      const previous = claimed ? await this.conversations.get(claimed) : null;
      const previousMessages = previous?.messages || [];
      const conversation = await this.conversations.append(claimed || null, { role: "user", content: prepared.historyMessage, attachments: prepared.attachments });
      conversationId = conversation.id;
      if (!claimed) this.busyConversations.add(conversationId);
      const result = await this.startRun({
        message: prepared.modelMessage,
        images: prepared.images,
        conversationId: conversation.id,
        taskId: String(input.task_id || ""),
        contextMessages: previousMessages.map((item) => ({ role: item.role, content: item.content })),
        requestedRunId: String(input.run_id || ""),
        options: input.options || {},
        listener: input.listener,
        ticket,
      });
      let completed = conversation;
      const assistant = String(result.assistant_message || "").trim();
      // Atomic append (read-modify-write inside one transaction), never a whole-list overwrite.
      if (assistant) completed = await this.conversations.append(conversation.id, { role: "assistant", content: assistant });
      result.conversation_id = completed.id;
      result.conversation_title = completed.title;
      return result;
    } finally {
      ticket?.release();
      if (conversationId) this.busyConversations.delete(conversationId);
    }
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
    /** A slot already reserved by the caller (conversationTurn); otherwise startRun admits itself. */
    ticket?: AdmissionTicket;
  }): Promise<RunResult> {
    const state = this.deps.state;
    const options = input.options || {};
    const maxSteps = options.max_steps || await this.deps.defaultMaxSteps?.() || MAX_STEPS;
    let goal = String(input.message || "").trim();
    if (!goal && !input.resumeRunId) throw new CoreError("Agent Run 需要非空消息。", "invalid");
    const ticket = input.ticket ?? await this.admit(input.resumeRunId || "");
    try {
      return await this.admittedRun(input, goal, maxSteps, ticket);
    } finally {
      ticket.release();
    }
  }

  private async admittedRun(input: Parameters<AgentHost["startRun"]>[0], goalText: string, maxSteps: number, ticket: AdmissionTicket): Promise<RunResult> {
    const state = this.deps.state;
    const options = input.options || {};
    let goal = goalText;
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
      if (this.active.has(existing.id)) throw new CoreError("这个对话已经有一轮在运行，等它结束再继续", "conflict");
      goal = goal || String(existing.goal || "").trim();
      const stored = await state.store.getSession(existing.id);
      if (!stored) throw new CoreError("Run 没有可恢复的 Agent Session，不能确定性恢复。", "conflict");
      // Died inside a tool batch: answer every unanswered call from the change log (committed or not), never re-run it.
      const reconciled = await reconcileToolBatch(stored, (callId) => this.deps.committedChanges?.(existing.id, callId) ?? Promise.resolve([]));
      session = reconciled.messages;
      if (reconciled.committed.length || reconciled.interrupted.length) {
        await state.store.putSession(existing.id, session);
        await state.appendEvent(existing.id, "recovery.tool_batch_reconciled", { committed: reconciled.committed, interrupted: reconciled.interrupted });
      }
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
    ticket.activate();

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
    const sandbox = resolveSandbox(options.sandbox, run.llm_runtime?.sandbox);
    const tools = applySandbox(this.deps.tools(), sandbox);
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
      const contextWindow = this.deps.contextWindow ? await this.deps.contextWindow(llm, options) : resolveContextWindow({ model: llm.metadata.model }).tokens;
      const metadata = { runtime: RUNTIME_ID, provider_id: "embedded", protocol_version: PROTOCOL_VERSION, ...llm.metadata, context_window: contextWindow, max_steps: maxSteps };
      run = await state.saveRun(
        { ...run, status: "executing", llm_runtime: { ...run.llm_runtime, ...metadata, status: input.resumeRunId ? "resuming" : "starting", session_id: runId } },
        input.resumeRunId ? { type: "recovery.started", payload: { session_id: runId } } : undefined,
      );
      await publish(input.resumeRunId ? "runtime.resuming" : "runtime.starting", { provider: llm.metadata.provider, model: llm.metadata.model });

      await state.store.putSession(runId, session);
      await persistWorkerEvent("runtime.session_started", { session_id: runId, kernel: "ts" }, "run.started");
      // Read-only sub-agents share this run's client (and so the provider's request budget) and its abort signal.
      const delegate = this.deps.subagents === false ? [] : [delegateTool({
        client: llm.client,
        tools,
        signal: activeRun.controller.signal,
        model: llm.metadata.model,
        onEvent: (type, payload) => persistWorkerEvent(type, payload, type),
      })];
      const allTools = [...tools, ...delegate, askTool];
      const current = await state.loadRun(runId) || run;
      run = await state.saveRun({ ...current, llm_runtime: { ...current.llm_runtime, ...metadata, status: "active", session_id: runId, sandbox, active_tools: allTools.map((tool) => tool.name) } });

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
      const recent = (input.contextMessages || []).slice(-6).map((item) => String(item.content || ""));
      const systemPrompt = await this.deps.systemPrompt({ maxSteps, texts: [goal, ...recent] });
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
        streamGuard: this.deps.streamGuard,
        compaction: this.deps.compaction ?? compactionPolicyFor(contextWindow),
        onSavePoint: (messages) => state.store.putSession(runId, messages),
        runId,
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
              // 思考过程只给在线的界面看（reasoning.delta），不落盘、不进事件日志。
              if (!event.text) return;
              return publish("reasoning.delta", { delta: event.text, ...runtimeTag });
            case "agent_start":
              return persistWorkerEvent("runtime.agent_started", {}, "kernel.agent_start");
            case "turn_start":
              return persistWorkerEvent("runtime.turn_started", {}, "kernel.turn_start");
            case "turn_end":
              return persistWorkerEvent("runtime.turn_completed", { context_usage: contextUsage(event) }, "kernel.turn_end");
            case "agent_end":
              return persistWorkerEvent("runtime.agent_settled", {}, "kernel.agent_end");
            case "stream_retry":
              return persistWorkerEvent("runtime.retry_started", { attempt: event.attempt, reason: event.reason, error: sanitizeLlmError(event.error, 300) }, "kernel.stream_retry");
            case "compaction":
              return persistWorkerEvent("runtime.compaction_completed", { before_tokens: event.before, after_tokens: event.after, shrunk_results: event.shrunk, aggressive: event.aggressive, estimated: true }, "kernel.compaction");
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
