// Durable Agent Run state — port of backend/app/services/agent_run_state.py
// (runs, the per-run event log with gap-free sequences, structured Ask input
// requests) and services/harness_history.py (agent conversations).
//
// Persistence is an injected AgentRunStore (rows only); every rule lives
// here so the browser (IndexedDB) and the Node companion (SQLite) agree.

import { CoreError, type Json } from "../types";
import type { ChatMessage } from "../llm";


export const RUN_SCHEMA_VERSION = "offeru.agent_runs.v2";
export const ACTIVE_STATUSES = new Set(["created", "planning", "executing", "interrupted"]);
export const TERMINAL_STATUSES = new Set(["completed", "cancelled", "failed"]);
const RUN_ID = /^run_[a-f0-9]{16,32}$/;

export interface AgentRun {
  schema_version: string;
  id: string;
  task_id: string;
  conversation_id: string;
  goal: string;
  mode: string;
  skill_id: string;
  skill_version: string;
  skill_snapshot: Json;
  status: string;
  exit_criteria: string[];
  steps: Json[];
  llm_runtime: Json;
  recovery_cursor: Json;
  final_result: Json;
  failure_reason: string;
  event_sequence: number;
  created_at: string;
  updated_at: string;
  [key: string]: unknown;
}

export interface AgentRunEvent {
  event_id: string;
  run_id: string;
  sequence: number;
  type: string;
  timestamp: string;
  payload: Json;
}

export interface AgentInputRequest {
  request_id: string;
  run_id: string;
  status: "pending" | "answered" | "expired";
  question: string;
  reason: string;
  options: Json[];
  allow_free_text: boolean;
  selection_mode: "single" | "multiple";
  min_selections: number;
  max_selections: number;
  allow_skip: boolean;
  answer: Json | null;
  answer_digest: string;
  created_at: string;
  answered_at: string;
  consumed_at: string;
}

export interface ConversationMessage {
  role: "user" | "assistant";
  content: string;
  attachments?: Array<{ id: string; name: string; kind: "image" | "document" }>;
}

export interface Conversation {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  messages: ConversationMessage[];
}

/** Row storage for Agent state. Implementations keep JSON blobs; no rules. */
export interface AgentRunStore {
  getRun(id: string): Promise<AgentRun | null>;
  putRun(run: AgentRun): Promise<void>;
  /** Newest updated_at first. */
  listRuns(filter: { conversation_id?: string; task_id?: string; status?: string[]; limit: number }): Promise<AgentRun[]>;
  putEvent(event: AgentRunEvent): Promise<void>;
  listEvents(runId: string, afterSequence: number, limit: number): Promise<AgentRunEvent[]>;
  getInputRequest(requestId: string): Promise<AgentInputRequest | null>;
  putInputRequest(request: AgentInputRequest): Promise<void>;
  listInputRequests(runId: string): Promise<AgentInputRequest[]>;
  getSession(runId: string): Promise<ChatMessage[] | null>;
  putSession(runId: string, messages: ChatMessage[]): Promise<void>;
  listConversations(): Promise<Conversation[]>;
  getConversation(id: string): Promise<Conversation | null>;
  putConversation(conversation: Conversation): Promise<void>;
  deleteConversation(id: string): Promise<boolean>;
  /** All-or-nothing and serialized (sequence allocation relies on it). Never nested. */
  transaction<T>(fn: () => Promise<T>): Promise<T>;
}

// ---- ids / time / redaction ----

export function randomHex(chars: number): string {
  const bytes = new Uint8Array(Math.ceil(chars / 2));
  const cryptoApi = (globalThis as { crypto?: { getRandomValues(array: Uint8Array): Uint8Array } }).crypto;
  if (cryptoApi) cryptoApi.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("").slice(0, chars);
}

export const newRunId = () => `run_${randomHex(16)}`;
export const nowUtc = () => new Date().toISOString().replace("Z", "+00:00");

const SECRET_TEXT = /(sk-[A-Za-z0-9_-]{8,}|Bearer\s+[A-Za-z0-9._~+/=-]{8,}|api[_-]?key["']?\s*[=:]\s*["']?[A-Za-z0-9._-]{8,})/gi;
const SECRET_KEY = /^(api[_-]?key|authorization|password|secret|access[_-]?token|refresh[_-]?token|cookie)$/i;

/** Lightweight stand-in for security_redaction.redact_sensitive_value: mask key-shaped strings and secret fields. */
export function redactSecrets<T>(value: T): T {
  if (typeof value === "string") return value.replace(SECRET_TEXT, "[REDACTED]") as T;
  if (Array.isArray(value)) return value.map((item) => redactSecrets(item)) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Json).map(([key, item]) => [key, SECRET_KEY.test(key) ? "[REDACTED]" : redactSecrets(item)])) as T;
  }
  return value;
}

/** agent_run_state.safe_result_preview: redact, then cap the JSON size. */
export function safeResultPreview(value: unknown, limit = 6000): unknown {
  const clean = redactSecrets(value);
  const text = JSON.stringify(clean) ?? "";
  return text.length <= limit ? clean : { preview: text.slice(0, limit), truncated: true };
}

function asJson(value: unknown): Json {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Json : {};
}

/** sha256 of canonical JSON (sorted keys, compact) — agent_run_state.canonical_json_digest. */
export async function canonicalJsonDigest(value: unknown): Promise<string> {
  const canonical = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(canonical);
    if (item && typeof item === "object") return Object.fromEntries(Object.keys(item as Json).sort().map((key) => [key, canonical((item as Json)[key])]));
    return item;
  };
  const data = new TextEncoder().encode(JSON.stringify(canonical(value)));
  const subtle = (globalThis as { crypto?: { subtle?: { digest(alg: string, data: Uint8Array): Promise<ArrayBuffer> } } }).crypto?.subtle;
  if (!subtle) throw new CoreError("当前运行环境没有 WebCrypto", "unsupported");
  const hash = new Uint8Array(await subtle.digest("SHA-256", data));
  return Array.from(hash, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

// ---- runs and events ----

export class AgentRunState {
  constructor(readonly store: AgentRunStore, private readonly now: () => string = nowUtc) {}

  private cleanRun(run: AgentRun): AgentRun {
    return {
      ...run,
      schema_version: RUN_SCHEMA_VERSION,
      goal: redactSecrets(String(run.goal || "")).slice(0, 4000),
      llm_runtime: redactSecrets(asJson(run.llm_runtime)),
      final_result: redactSecrets(asJson(run.final_result)),
      recovery_cursor: asJson(run.recovery_cursor),
      failure_reason: redactSecrets(String(run.failure_reason || "")).slice(0, 1000),
      event_sequence: Number(run.event_sequence || 0),
    };
  }

  private async writeEvent(run: AgentRun, type: string, payload: Json): Promise<AgentRunEvent> {
    run.event_sequence = Number(run.event_sequence || 0) + 1;
    const event: AgentRunEvent = {
      event_id: `evt_${randomHex(32)}`,
      run_id: run.id,
      sequence: run.event_sequence,
      type,
      timestamp: this.now(),
      payload: safeResultPreview(payload) as Json,
    };
    await this.store.putEvent(event);
    return event;
  }

  /** The task a new run belongs to: the conversation's latest task, else a fresh one. */
  private async resolveTask(taskId: string, conversationId: string): Promise<string> {
    if (taskId) return taskId;
    if (conversationId) {
      const [latest] = await this.store.listRuns({ conversation_id: conversationId, limit: 1 });
      if (latest?.task_id) return latest.task_id;
    }
    return `task_${randomHex(16)}`;
  }

  async createRun(input: {
    conversation_id: string;
    task_id?: string;
    goal: string;
    mode: string;
    skill_id?: string;
    skill_version?: string;
    skill_snapshot?: Json;
    exit_criteria?: string[];
    llm_runtime?: Json;
    run_id?: string;
  }): Promise<AgentRun> {
    const runId = String(input.run_id || "").trim() || newRunId();
    if (!RUN_ID.test(runId)) throw new CoreError("Invalid Agent Run id", "invalid");
    return this.store.transaction(async () => {
      if (await this.store.getRun(runId)) throw new CoreError(`Agent Run ${runId} 已存在`, "conflict");
      const now = this.now();
      const run = this.cleanRun({
        schema_version: RUN_SCHEMA_VERSION,
        id: runId,
        task_id: await this.resolveTask(String(input.task_id || ""), String(input.conversation_id || "")),
        conversation_id: String(input.conversation_id || ""),
        goal: input.goal,
        mode: input.mode || "general",
        skill_id: input.skill_id || "",
        skill_version: input.skill_version || "",
        skill_snapshot: redactSecrets(input.skill_snapshot || {}),
        status: "planning",
        exit_criteria: input.exit_criteria?.length ? input.exit_criteria : ["all planned actions have completed"],
        steps: [],
        llm_runtime: input.llm_runtime || {},
        recovery_cursor: {},
        final_result: {},
        failure_reason: "",
        event_sequence: 0,
        created_at: now,
        updated_at: now,
      });
      await this.writeEvent(run, "run.started", { goal: run.goal, mode: run.mode, task_id: run.task_id });
      if (run.skill_id) {
        await this.writeEvent(run, "skill.selected", { skill_id: run.skill_id, skill_version: run.skill_version, skill_snapshot: run.skill_snapshot });
      }
      await this.store.putRun(run);
      return run;
    });
  }

  loadRun(runId: string | null | undefined): Promise<AgentRun | null> {
    return runId ? this.store.getRun(String(runId)) : Promise.resolve(null);
  }

  /**
   * Persist a run snapshot. Mirrors save_agent_run: optional lifecycle event,
   * plus run.completed / run.failed / run.cancelled on a transition into a
   * terminal status. The event_sequence of the stored row wins over the
   * snapshot's (events appended since the snapshot was read are kept).
   */
  async saveRun(run: AgentRun, event?: { type: string; payload?: Json }): Promise<AgentRun> {
    return this.store.transaction(async () => {
      const previous = await this.store.getRun(run.id);
      if (!previous) throw new CoreError(`Agent Run ${run.id} does not exist`, "not_found");
      const next = this.cleanRun({ ...run, event_sequence: previous.event_sequence, created_at: previous.created_at, updated_at: this.now() });
      if (event?.type) await this.writeEvent(next, event.type, event.payload || {});
      if (next.status !== previous.status && TERMINAL_STATUSES.has(next.status)) {
        const type = { completed: "run.completed", failed: "run.failed", cancelled: "run.cancelled" }[next.status as "completed"];
        await this.writeEvent(next, type, { status: next.status, failure_reason: next.failure_reason });
      }
      await this.store.putRun(next);
      return next;
    });
  }

  async appendEvent(runId: string, type: string, payload: Json = {}): Promise<AgentRunEvent> {
    return this.store.transaction(async () => {
      const run = await this.store.getRun(runId);
      if (!run) throw new CoreError(`Agent Run ${runId} does not exist`, "not_found");
      const event = await this.writeEvent(run, type, payload);
      await this.store.putRun(run);
      return event;
    });
  }

  listRuns(filter: { conversation_id?: string | null; task_id?: string | null; limit?: number } = {}): Promise<AgentRun[]> {
    const limit = Math.max(1, Math.min(Number(filter.limit) || 20, 100));
    return this.store.listRuns({ conversation_id: filter.conversation_id || undefined, task_id: filter.task_id || undefined, limit });
  }

  listEvents(runId: string, afterSequence = 0, limit = 200): Promise<AgentRunEvent[]> {
    return this.store.listEvents(runId, Math.max(0, Number(afterSequence) || 0), Math.max(1, Math.min(Number(limit) || 200, 1000)));
  }

  /** Startup recovery: executing runs of a dead process become interrupted (recover_interrupted_agent_runs). */
  async recoverInterrupted(): Promise<{ interrupted: number }> {
    const runs = await this.store.listRuns({ status: ["planning", "executing"], limit: 10_000 });
    let count = 0;
    for (const run of runs) {
      if (String(run.llm_runtime?.runtime || "") !== "ts_agent") continue;
      await this.store.transaction(async () => {
        const current = await this.store.getRun(run.id);
        if (!current) return;
        const previousStatus = current.status;
        current.recovery_cursor = { ...current.recovery_cursor, reason: "backend_or_worker_restart", previous_status: previousStatus, last_event_sequence: current.event_sequence, recovered_at: this.now() };
        current.status = "interrupted";
        current.failure_reason = "";
        current.llm_runtime = { ...current.llm_runtime, status: "interrupted" };
        await this.writeEvent(current, "recovery.interrupted", { previous_status: previousStatus, resume_available: Boolean(await this.store.getSession(run.id)), legacy_session_preserved: false });
        await this.store.putRun(current);
      });
      count += 1;
    }
    return { interrupted: count };
  }

  // ---- structured Ask ----

  async createInputRequest(runId: string, input: {
    question: string;
    reason?: string;
    options?: Json[];
    allow_free_text?: boolean;
    selection_mode?: string;
    min_selections?: unknown;
    max_selections?: unknown;
    allow_skip?: boolean;
  }): Promise<AgentInputRequest> {
    const question = String(input.question || "").trim();
    if (!question) throw new CoreError("request_user_input 需要非空 question。", "invalid");
    const seen = new Set<string>();
    const options: Json[] = [];
    for (const item of input.options || []) {
      const optionId = String(item?.option_id || "").trim();
      if (!optionId || seen.has(optionId)) continue;
      seen.add(optionId);
      const clean: Json = {};
      for (const key of ["option_id", "label", "description"]) if (key in item) clean[key] = item[key];
      if (item.recommended === true) clean.recommended = true;
      options.push(clean);
    }
    const mode = selectionMode(input.selection_mode);
    if (mode === "single") {
      let first = true;
      for (const option of options) {
        if (!option.recommended) continue;
        if (!first) delete option.recommended;
        first = false;
      }
    }
    const [min, max] = selectionBounds(mode, input.min_selections, input.max_selections, options.length);
    const signature = await canonicalJsonDigest({ question, options });
    return this.store.transaction(async () => {
      const run = await this.store.getRun(runId);
      if (!run) throw new CoreError(`Agent Run ${runId} does not exist`, "not_found");
      if (TERMINAL_STATUSES.has(run.status)) throw new CoreError(`Agent Run ${runId} is terminal (${run.status})`, "conflict");
      const pending = (await this.store.listInputRequests(runId)).filter((item) => item.status === "pending");
      for (const item of pending) {
        if (await canonicalJsonDigest({ question: item.question, options: item.options }) === signature) return item;
      }
      if (pending.length) throw new CoreError("该 Agent Run 已有一个待回答的提问；请先回答它再提问。", "conflict");
      const request: AgentInputRequest = {
        request_id: `input_${randomHex(32)}`,
        run_id: runId,
        status: "pending",
        question: question.slice(0, 4000),
        reason: String(input.reason || "").slice(0, 2000),
        options: redactSecrets(options),
        allow_free_text: input.allow_free_text !== false,
        selection_mode: mode,
        min_selections: min,
        max_selections: max,
        allow_skip: input.allow_skip !== false,
        answer: null,
        answer_digest: "",
        created_at: this.now(),
        answered_at: "",
        consumed_at: "",
      };
      await this.store.putInputRequest(request);
      return request;
    });
  }

  async pendingInputRequests(runId: string): Promise<AgentInputRequest[]> {
    return (await this.store.listInputRequests(runId))
      .filter((item) => item.status === "pending")
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
  }

  async answerInputRequest(runId: string, requestId: string, answer: Json): Promise<
    { ok: true; request: AgentInputRequest; duplicate: boolean } | { ok: false; error: "not_found" | "conflict" | "invalid"; errors?: string[]; request?: AgentInputRequest }
  > {
    const clean = redactSecrets(answer);
    const digest = await canonicalJsonDigest(clean);
    return this.store.transaction(async () => {
      const request = await this.store.getInputRequest(requestId);
      if (!request || request.run_id !== runId) return { ok: false as const, error: "not_found" as const };
      if (request.status === "answered") {
        return request.answer_digest === digest
          ? { ok: true as const, request, duplicate: true }
          : { ok: false as const, error: "conflict" as const, request };
      }
      if (request.status !== "pending") return { ok: false as const, error: "conflict" as const, request };
      const violations = validateInputAnswer(request, clean);
      if (violations.length) return { ok: false as const, error: "invalid" as const, errors: violations, request };
      const answered: AgentInputRequest = { ...request, status: "answered", answer: clean, answer_digest: digest, answered_at: this.now() };
      await this.store.putInputRequest(answered);
      return { ok: true as const, request: answered, duplicate: false };
    });
  }

  /** Claim the one allowed continuation for an answered request. */
  async consumeInputRequest(requestId: string): Promise<boolean> {
    return this.store.transaction(async () => {
      const request = await this.store.getInputRequest(requestId);
      if (!request || request.status !== "answered" || request.consumed_at) return false;
      await this.store.putInputRequest({ ...request, consumed_at: this.now() });
      return true;
    });
  }

  async expirePendingInputRequests(runId: string, reason = ""): Promise<number> {
    return this.store.transaction(async () => {
      const pending = (await this.store.listInputRequests(runId)).filter((item) => item.status === "pending");
      for (const item of pending) {
        await this.store.putInputRequest({ ...item, status: "expired", answer: reason ? { ...(item.answer || {}), expired_reason: reason.slice(0, 500) } : item.answer });
      }
      return pending.length;
    });
  }
}

export function selectionMode(value: unknown): "single" | "multiple" {
  const mode = String(value || "").trim().toLowerCase();
  return mode === "multiple" ? "multiple" : "single";
}

/** Clamp min/max so the question is always answerable (anti-deadlock). */
export function selectionBounds(mode: string, minRaw: unknown, maxRaw: unknown, optionCount: number): [number, number] {
  const int = (value: unknown) => {
    const parsed = Math.trunc(Number(value || 0));
    return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
  };
  if (mode === "single") return [Math.min(int(minRaw), 1, optionCount), 1];
  let upper = int(maxRaw);
  if (optionCount && upper) upper = Math.min(upper, optionCount);
  let lower = Math.min(int(minRaw), optionCount);
  if (upper) lower = Math.min(lower, upper);
  return [lower, upper];
}

export function validateInputAnswer(request: AgentInputRequest, answer: Json): string[] {
  const selected = Array.isArray(answer.selected_option_ids) ? answer.selected_option_ids.map(String) : [];
  const freeText = String(answer.free_text || "").trim();
  const skipped = Boolean(answer.skipped);
  const optionIds = new Set(request.options.map((item) => String(item.option_id)));
  const errors: string[] = [];
  if (new Set(selected).size !== selected.length) errors.push("选项重复。");
  if (selected.some((item) => !optionIds.has(item))) errors.push("包含不属于该问题的选项。");
  if (skipped) {
    if (!request.allow_skip) errors.push("该问题不能跳过。");
    if (selected.length || freeText) errors.push("跳过时不能同时提交选项或补充说明。");
    return errors;
  }
  if (freeText && !request.allow_free_text) errors.push("该问题不接受自由输入。");
  const mode = selectionMode(request.selection_mode);
  if (mode === "single" && selected.length > 1) errors.push("这是单选问题，只能选择一个选项。");
  const maximum = Number(request.max_selections || 0);
  if (mode === "multiple" && maximum && selected.length > maximum) errors.push(`最多选择 ${maximum} 项。`);
  if (!freeText) {
    const minimum = Math.max(Number(request.min_selections || 0), 1);
    if (selected.length < minimum) errors.push(minimum === 1 ? "请选择一个选项、填写补充说明，或跳过。" : `至少选择 ${minimum} 项，或填写补充说明。`);
  }
  return errors;
}

// ---- conversations (services/harness_history.py) ----

const MAX_TITLE_LENGTH = 32;
const MAX_MESSAGES_PER_CONVERSATION = 120;

function cleanAttachments(raw: unknown): ConversationMessage["attachments"] {
  if (!Array.isArray(raw)) return [];
  const out: NonNullable<ConversationMessage["attachments"]> = [];
  for (const item of raw.slice(0, 8)) {
    if (!item || typeof item !== "object") continue;
    const id = String((item as Json).id || "").trim();
    const kind = String((item as Json).kind || "").trim();
    if (!id || (kind !== "image" && kind !== "document")) continue;
    out.push({ id: id.slice(0, 80), name: String((item as Json).name || "").slice(0, 200), kind });
  }
  return out;
}

export function cleanConversationMessages(messages: unknown): ConversationMessage[] {
  if (!Array.isArray(messages)) return [];
  const out: ConversationMessage[] = [];
  for (const message of messages) {
    if (!message || typeof message !== "object") continue;
    const role = String((message as Json).role || "").trim();
    const content = String((message as Json).content ?? "").trim();
    if ((role !== "user" && role !== "assistant") || !content) continue;
    const cleaned: ConversationMessage = { role, content: content.slice(0, 8000) };
    const attachments = role === "user" ? cleanAttachments((message as Json).attachments) : [];
    if (attachments?.length) cleaned.attachments = attachments;
    out.push(cleaned);
  }
  return out.slice(-MAX_MESSAGES_PER_CONVERSATION);
}

function titleFromMessages(messages: ConversationMessage[]): string {
  const first = messages.find((message) => message.role === "user");
  if (!first) return "新对话";
  return first.content.replace(/\s+/g, " ").trim().slice(0, MAX_TITLE_LENGTH) || "新对话";
}

export class AgentConversations {
  constructor(private readonly store: AgentRunStore, private readonly now: () => string = nowUtc) {}

  async list(): Promise<Array<{ id: string; title: string; created_at: string; updated_at: string; message_count: number; last_message: string }>> {
    return (await this.store.listConversations())
      .filter((item) => item.id)
      .map((item) => {
        const messages = cleanConversationMessages(item.messages);
        return {
          id: item.id,
          title: item.title || "新对话",
          created_at: item.created_at || "",
          updated_at: item.updated_at || "",
          message_count: messages.length,
          last_message: messages.length ? messages[messages.length - 1].content.slice(0, 120) : "",
        };
      })
      .sort((a, b) => (b.updated_at || "").localeCompare(a.updated_at || ""));
  }

  async get(id: string): Promise<Conversation | null> {
    const item = await this.store.getConversation(String(id));
    if (!item) return null;
    return { id: item.id, title: item.title || "新对话", created_at: item.created_at || "", updated_at: item.updated_at || "", messages: cleanConversationMessages(item.messages) };
  }

  /** save_conversation_messages: replace the message list; the title is set once from the first user message. */
  async save(conversationId: string | null | undefined, messages: unknown): Promise<Conversation & { message_count: number }> {
    const clean = cleanConversationMessages(messages);
    const now = this.now();
    return this.store.transaction(async () => {
      const existing = conversationId ? await this.store.getConversation(String(conversationId)) : null;
      const next: Conversation = existing
        ? { ...existing, title: existing.title || titleFromMessages(clean), updated_at: now, messages: clean }
        : { id: conversationId || `conv_${randomHex(12)}`, title: titleFromMessages(clean), created_at: now, updated_at: now, messages: clean };
      await this.store.putConversation(next);
      return { ...next, message_count: clean.length };
    });
  }

  delete(id: string): Promise<boolean> {
    return this.store.transaction(() => this.store.deleteConversation(String(id)));
  }
}

// ---- in-memory store (browser default, tests) ----

export class MemoryAgentRunStore implements AgentRunStore {
  private runs = new Map<string, AgentRun>();
  private events = new Map<string, AgentRunEvent[]>();
  private requests = new Map<string, AgentInputRequest>();
  private sessions = new Map<string, ChatMessage[]>();
  private conversations = new Map<string, Conversation>();
  private queue: Promise<unknown> = Promise.resolve();

  private clone<T>(value: T): T {
    return value === null || value === undefined ? value : JSON.parse(JSON.stringify(value)) as T;
  }

  async getRun(id: string) { return this.clone(this.runs.get(id) ?? null); }
  async putRun(run: AgentRun) { this.runs.set(run.id, this.clone(run)); }
  async listRuns(filter: { conversation_id?: string; task_id?: string; status?: string[]; limit: number }) {
    return [...this.runs.values()]
      .filter((run) => (!filter.conversation_id || run.conversation_id === filter.conversation_id)
        && (!filter.task_id || run.task_id === filter.task_id)
        && (!filter.status || filter.status.includes(run.status)))
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
      .slice(0, filter.limit)
      .map((run) => this.clone(run));
  }
  async putEvent(event: AgentRunEvent) {
    const list = this.events.get(event.run_id) ?? [];
    if (list.some((item) => item.sequence === event.sequence)) throw new CoreError(`duplicate event sequence ${event.sequence}`, "conflict");
    list.push(this.clone(event));
    this.events.set(event.run_id, list);
  }
  async listEvents(runId: string, afterSequence: number, limit: number) {
    return (this.events.get(runId) ?? []).filter((event) => event.sequence > afterSequence).sort((a, b) => a.sequence - b.sequence).slice(0, limit).map((event) => this.clone(event));
  }
  async getInputRequest(id: string) { return this.clone(this.requests.get(id) ?? null); }
  async putInputRequest(request: AgentInputRequest) { this.requests.set(request.request_id, this.clone(request)); }
  async listInputRequests(runId: string) { return [...this.requests.values()].filter((item) => item.run_id === runId).map((item) => this.clone(item)); }
  async getSession(runId: string) { return this.clone(this.sessions.get(runId) ?? null); }
  async putSession(runId: string, messages: ChatMessage[]) { this.sessions.set(runId, this.clone(messages)); }
  async listConversations() { return [...this.conversations.values()].map((item) => this.clone(item)); }
  async getConversation(id: string) { return this.clone(this.conversations.get(id) ?? null); }
  async putConversation(conversation: Conversation) { this.conversations.set(conversation.id, this.clone(conversation)); }
  async deleteConversation(id: string) { return this.conversations.delete(id); }

  /** Serializes transactions (they must not nest). No rollback: memory only. */
  transaction<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn);
    this.queue = run.catch(() => undefined);
    return run;
  }
}
