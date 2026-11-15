// One Agent Run's trace — port of backend/app/core/trace.py (schema
// offeru.trace.v1): code version, model, prompt version, every tool call with
// args / result preview / latency / change ids, sub-model calls made inside
// tools, terminal state and stop reason. Pure TS: where the JSON goes is the
// runtime's TraceSink (the Node companion writes <OFFERU_TRACE_DIR>/<journey>/<run>.json).
// The trace is not business data: it never goes into the records / changes tables.

import type { LlmClient } from "../llm";

export const TRACE_SCHEMA = "offeru.trace.v1";
export const TRACE_TERMINAL_STATES = ["completed", "waiting_user", "partial", "failed", "cancelled"] as const;
export type TraceTerminalState = (typeof TRACE_TERMINAL_STATES)[number];

export interface TraceToolCall {
  seq: number;
  tool: string;
  args: Record<string, unknown>;
  seconds: number;
  ok: boolean;
  retry_of: number | null;
  change_ids: number[];
  error?: string;
  result_preview?: string;
}

export interface TraceLlmCall {
  seq: number;
  purpose: string;
  model: string;
  during_tool_seq: number;
  seconds: number;
  ok: boolean;
  error: string | null;
  usage_prompt: number | null;
  usage_completion: number | null;
}

export interface AgentTraceData {
  schema: string;
  run_id: string;
  journey_id: string;
  started_at: string;
  ended_at: string | null;
  code_version: string;
  model: string;
  provider: string;
  prompt_version: string;
  skill_version: string;
  step_budget: number | null;
  steps_used: number;
  job_ids: number[];
  artifacts: Array<{ doc_id: number; tool: string; kind: string; job_id: number | null }>;
  change_ids: number[];
  tool_calls: TraceToolCall[];
  llm_calls: TraceLlmCall[];
  /** Token usage of the last model turn; null when the gateway does not report it. */
  usage: { prompt: number | null; completion: number | null };
  terminal_state: TraceTerminalState | null;
  stop_reason: string | null;
  error: string | null;
  seconds?: number;
  resumed?: boolean;
  [key: string]: unknown;
}

/** Where finished traces go; `codeVersion` is stamped on every trace (git short sha on the companion). */
export interface TraceSink {
  codeVersion?: string;
  write(trace: AgentTraceData): void | Promise<void>;
}

const SECRET_KEY = /(api[_-]?key|secret|password|passwd|authorization|access[_-]?token|refresh[_-]?token|cookie|^token$|pairing)/i;

/** Drop secret-looking keys and cut long strings (Python redact_secret_value). */
export function redactTraceValue(value: unknown, maxLength = 1500, depth = 0): unknown {
  if (typeof value === "string") return value.length > maxLength ? `${value.slice(0, maxLength)}…` : value;
  if (value === null || typeof value !== "object") return value;
  if (depth > 8) return "…";
  if (Array.isArray(value)) return value.slice(0, 200).map((item) => redactTraceValue(item, maxLength, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SECRET_KEY.test(key) ? "[redacted]" : redactTraceValue(item, maxLength, depth + 1);
  }
  return out;
}

function ids(value: unknown): number[] {
  if (typeof value === "number" && Number.isInteger(value)) return [value];
  if (Array.isArray(value)) return value.filter((item): item is number => typeof item === "number" && Number.isInteger(item));
  return [];
}

function preview(value: unknown, limit = 2000): string {
  const text = JSON.stringify(redactTraceValue(value, limit)) ?? "null";
  return text.length <= limit ? text : `${text.slice(0, limit)}…`;
}

/** Short content hash for the prompt version (sha256, first 12 hex chars; "" without WebCrypto). */
export async function textVersion(text: string): Promise<string> {
  const subtle = (globalThis as { crypto?: { subtle?: { digest(algorithm: string, data: Uint8Array): Promise<ArrayBuffer> } } }).crypto?.subtle;
  if (!text || !subtle) return "";
  const digest = await subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("").slice(0, 12);
}

/** Tools that return a doc_id without the record: the kind of doc they write. */
const TOOL_DOC_KIND: Record<string, string> = { tailor_resume: "resume", draft_email: "email" };

const round3 = (seconds: number) => Math.round(seconds * 1000) / 1000;

export class RunTrace {
  readonly data: AgentTraceData;
  private readonly started = Date.now();

  constructor(runId: string, meta: { journeyId?: string; codeVersion?: string } = {}) {
    this.data = {
      schema: TRACE_SCHEMA,
      run_id: runId,
      journey_id: meta.journeyId || "",
      started_at: new Date().toISOString(),
      ended_at: null,
      code_version: meta.codeVersion || "",
      model: "",
      provider: "",
      prompt_version: "",
      skill_version: "core",
      step_budget: null,
      steps_used: 0,
      job_ids: [],
      artifacts: [],
      change_ids: [],
      tool_calls: [],
      llm_calls: [],
      usage: { prompt: null, completion: null },
      terminal_state: null,
      stop_reason: null,
      error: null,
    };
  }

  update(fields: Partial<AgentTraceData>): void {
    Object.assign(this.data, fields);
  }

  private job(value: unknown): void {
    for (const id of ids(value)) if (!this.data.job_ids.includes(id)) this.data.job_ids.push(id);
  }

  /** One tool call. `resultText` is what the model read (JSON text or "ERROR: ..."). */
  tool(name: string, rawArgs: unknown, seconds: number, resultText: string, isError: boolean): void {
    const calls = this.data.tool_calls;
    const previous = calls.at(-1);
    const args = rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs) ? rawArgs as Record<string, unknown> : {};
    const entry: TraceToolCall = {
      seq: calls.length + 1,
      tool: name,
      args: redactTraceValue(args) as Record<string, unknown>,
      seconds: round3(seconds),
      ok: !isError,
      retry_of: previous && previous.tool === name && !previous.ok ? previous.seq : null,
      change_ids: [],
    };
    this.job(args.job_id);
    this.job(args.job_ids);
    if (args.type === "job") this.job(args.id);
    if (isError) {
      entry.error = resultText.replace(/^ERROR:\s*/, "").slice(0, 1000);
    } else {
      let result: unknown = null;
      try {
        result = JSON.parse(resultText);
      } catch {
        result = resultText;
      }
      if (result && typeof result === "object" && !Array.isArray(result)) {
        const value = result as Record<string, unknown>;
        const changes = [...ids(value.change_id), ...ids(value.change_ids)];
        entry.change_ids = changes;
        for (const change of changes) if (!this.data.change_ids.includes(change)) this.data.change_ids.push(change);
        const record = value.record && typeof value.record === "object" ? value.record as Record<string, unknown> : {};
        if ((name === "save" && args.type === "job") || name === "add_job") this.job(record.id);
        const docId = value.doc_id ?? (args.type === "doc" ? record.id : null);
        if (typeof docId === "number") {
          const data = args.data && typeof args.data === "object" ? args.data as Record<string, unknown> : {};
          const jobId = (data.job_id ?? record.job_id ?? args.job_id ?? null) as number | null;
          this.job(jobId);
          this.data.artifacts.push({ doc_id: docId, tool: name, kind: String(data.kind || record.kind || TOOL_DOC_KIND[name] || ""), job_id: jobId });
        }
      }
      entry.result_preview = preview(result);
    }
    calls.push(entry);
  }

  llm(call: { purpose: string; model: string; seconds: number; ok: boolean; error?: string; usagePrompt?: number | null; usageCompletion?: number | null }): void {
    this.data.llm_calls.push({
      seq: this.data.llm_calls.length + 1,
      purpose: call.purpose,
      model: call.model,
      during_tool_seq: this.data.tool_calls.length + 1,
      seconds: round3(call.seconds),
      ok: call.ok,
      error: call.error || null,
      usage_prompt: call.usagePrompt ?? null,
      usage_completion: call.usageCompletion ?? null,
    });
  }

  get finished(): boolean {
    return this.data.terminal_state !== null;
  }

  finish(terminalState: TraceTerminalState, stopReason = "", error = ""): AgentTraceData {
    if (!TRACE_TERMINAL_STATES.includes(terminalState)) throw new Error(`未知终态 ${terminalState}`);
    if (this.data.terminal_state !== null) throw new Error(`这次运行已经是 ${this.data.terminal_state}，不能再结束一次`);
    Object.assign(this.data, {
      terminal_state: terminalState,
      stop_reason: stopReason || null,
      error: error || null,
      ended_at: new Date().toISOString(),
      seconds: round3((Date.now() - this.started) / 1000),
    });
    return this.data;
  }
}

/** Sub-model calls made inside tools (tailor draft / review, evaluate, intake...), timed into the run trace. */
export type LlmObserver = (call: { purpose: string; model: string; seconds: number; ok: boolean; error?: string }) => void;

export function observeLlm(client: LlmClient, observe: LlmObserver): LlmClient {
  const model = client.model || "";
  const since = (start: number) => (Date.now() - start) / 1000;
  const wrapped: LlmClient = {
    provider: client.provider,
    model: client.model,
    local: client.local,
    async chat(messages, options) {
      const start = Date.now();
      try {
        const text = await client.chat(messages, options);
        observe({ purpose: options?.json ? "chat_json" : "chat", model, seconds: since(start), ok: text !== null, error: text === null ? "no answer" : undefined });
        return text;
      } catch (cause) {
        observe({ purpose: "chat", model, seconds: since(start), ok: false, error: cause instanceof Error ? cause.message : String(cause) });
        throw cause;
      }
    },
  };
  if (client.chatStream) {
    const stream = client.chatStream.bind(client);
    wrapped.chatStream = async function* (messages, options) {
      const start = Date.now();
      let ok = false;
      try {
        yield* stream(messages, options);
        ok = true;
      } finally {
        observe({ purpose: "chat_stream", model, seconds: since(start), ok, error: ok ? undefined : "stream ended early" });
      }
    };
  }
  if (client.complete) wrapped.complete = client.complete.bind(client);
  if (client.completeStream) wrapped.completeStream = client.completeStream.bind(client);
  return wrapped;
}
