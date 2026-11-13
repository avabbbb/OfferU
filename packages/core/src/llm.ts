// OpenAI-compatible (and Anthropic Messages) LLM client. Pure TS: no node:*,
// no DOM. Network goes through an injected `fetch`, so the same client runs in
// the browser with the user's own key, in a Cloudflare Worker, and in Node.
//
// Mirrors backend/app/agent/provider.py (LlmStreamProvider) and
// backend/app/agents/llm.py (chat_completion): streamed text / reasoning /
// tool-call deltas, a single retry without stream_options / reasoning_effort
// when a gateway rejects them, and json mode.

import { CoreError } from "./types";

export type LlmApiFormat = "openai" | "anthropic";

/** A fully resolved endpoint (see llm-config.ts resolveLlmClientConfig). */
export interface LlmEndpoint {
  provider: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  apiFormat?: LlmApiFormat;
  supportsJsonMode?: boolean;
  headers?: Record<string, string>;
}

export type ChatContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

export interface ChatToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | ChatContentPart[] | null;
  tool_calls?: ChatToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ChatRequest {
  messages: ChatMessage[];
  tools?: ToolSpec[];
  /** Overrides endpoint.model. */
  model?: string;
  temperature?: number;
  maxTokens?: number;
  /** response_format json_object (ignored when the endpoint says it lacks json mode). */
  json?: boolean;
  reasoningEffort?: "" | "low" | "medium" | "high";
  signal?: AbortSignal;
}

export interface LlmUsage {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  estimated: boolean;
}

export interface ParsedToolCall {
  id: string;
  name: string;
  /** Raw JSON text as streamed. */
  arguments: string;
  /** Parsed object; {_raw} when the model sent invalid JSON. */
  args: Record<string, unknown>;
}

export type FinishReason = "stop" | "tool_calls" | "length" | "error" | "aborted" | string;

export interface ChatResult {
  provider: string;
  model: string;
  content: string;
  reasoning: string;
  toolCalls: ParsedToolCall[];
  finishReason: FinishReason;
  usage: LlmUsage;
  error?: string;
}

export type LlmStreamEvent =
  | { type: "text_delta"; text: string }
  | { type: "thinking_delta"; text: string }
  | { type: "tool_call_delta"; index: number; id: string; name: string; arguments: string }
  /** Always the last event. finishReason "error"/"aborted" instead of throwing. */
  | { type: "done"; result: ChatResult };

export interface LlmClient {
  readonly provider: string;
  readonly model: string;
  /** Non-streamed completion. Throws CoreError on HTTP / auth failure. */
  chat(request: ChatRequest): Promise<ChatResult>;
  /** Streamed completion. Never throws: failures end with done{finishReason:"error"}. */
  stream(request: ChatRequest): AsyncIterable<LlmStreamEvent>;
}

// ---- fetch seam (structural, so core needs no DOM / node types) ----

export interface ByteReader {
  read(): Promise<{ done: boolean; value?: Uint8Array }>;
  cancel?(reason?: unknown): Promise<void>;
  releaseLock?(): void;
}

export interface FetchResponseLike {
  ok: boolean;
  status: number;
  body: { getReader(): ByteReader } | null;
  text(): Promise<string>;
}

export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<FetchResponseLike>;

// ---- helpers ----

const SECRET = /(sk-[A-Za-z0-9_-]{8,}|Bearer\s+\S+|api[_-]?key[=:]\s*\S+)/gi;

/** Strip keys / bearer tokens from provider error text (provider.py sanitize_error_message). */
export function sanitizeLlmError(message: unknown, limit = 500): string {
  return String(message ?? "").replace(SECRET, "[REDACTED]").slice(0, limit);
}

export function parseToolArguments(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw as Record<string, unknown>;
  if (raw === null || raw === undefined || raw === "") return {};
  if (typeof raw !== "string") return { value: raw };
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : { value: parsed };
  } catch {
    return { _raw: raw };
  }
}

/** Server-sent events → {event, data} blocks. Works on any byte reader. */
export async function* readSse(reader: ByteReader): AsyncGenerator<{ event: string; data: string; id?: string }> {
  const decoder = new TextDecoder();
  let buffer = "";
  const parse = (block: string) => {
    let event = "message";
    let id: string | undefined;
    const data: string[] = [];
    for (const line of block.split("\n")) {
      if (line.startsWith(":")) continue;
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
      else if (line.startsWith("id:")) id = line.slice(3).trim();
    }
    return data.length ? { event, data: data.join("\n"), id } : null;
  };
  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done }).replace(/\r\n?/g, "\n");
      let boundary = buffer.indexOf("\n\n");
      while (boundary >= 0) {
        const item = parse(buffer.slice(0, boundary));
        buffer = buffer.slice(boundary + 2);
        if (item) yield item;
        boundary = buffer.indexOf("\n\n");
      }
      if (done) break;
    }
    if (buffer.trim()) {
      const item = parse(buffer);
      if (item) yield item;
    }
  } finally {
    try { await reader.cancel?.(); } catch { /* already closed */ }
    try { reader.releaseLock?.(); } catch { /* not locked */ }
  }
}

function joinUrl(base: string, path: string): string {
  return base.replace(/\/+$/, "") + path;
}

function isLocal(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname.toLowerCase().replace(/\.$/, "");
    return host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1" || host.startsWith("127.");
  } catch {
    return false;
  }
}

function estimatedUsage(text: string): LlmUsage {
  const out = text ? Math.max(1, Math.floor(text.length / 4)) : 0;
  return { input_tokens: 0, output_tokens: out, total_tokens: out, estimated: true };
}

function usageOf(raw: Record<string, unknown> | undefined, text: string): LlmUsage {
  if (!raw || !Object.keys(raw).length) return estimatedUsage(text);
  const input = Number(raw.prompt_tokens ?? raw.input_tokens ?? 0) || 0;
  const output = Number(raw.completion_tokens ?? raw.output_tokens ?? 0) || 0;
  return { input_tokens: input, output_tokens: output, total_tokens: Number(raw.total_tokens ?? input + output) || input + output, estimated: false };
}

type Slot = { id: string; name: string; arguments: string };

/** provider.py _tool_call_slot: which accumulator a streamed tool_call delta extends. */
function toolCallSlot(slots: Slot[], delta: Record<string, unknown>): number {
  if (delta.index !== undefined && delta.index !== null) {
    const index = Number(delta.index);
    while (slots.length <= index) slots.push({ id: "", name: "", arguments: "" });
    return index;
  }
  const id = String(delta.id || "");
  if (id) {
    const found = slots.findIndex((slot) => slot.id === id);
    if (found >= 0) return found;
    slots.push({ id: "", name: "", arguments: "" });
    return slots.length - 1;
  }
  if (!slots.length) slots.push({ id: "", name: "", arguments: "" });
  return slots.length - 1;
}

function finalToolCalls(slots: Slot[]): ParsedToolCall[] {
  // Empty-name slots are stream noise; never surface them as executable calls.
  return slots
    .filter((slot) => slot.name.trim())
    .map((slot, index) => ({
      id: slot.id || `call_${index + 1}`,
      name: slot.name,
      arguments: slot.arguments,
      args: parseToolArguments(slot.arguments),
    }));
}

export class LlmHttpError extends CoreError {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message, status === 401 || status === 403 ? "forbidden" : "invalid");
    this.status = status;
  }
}

async function errorText(response: FetchResponseLike): Promise<string> {
  const text = await response.text().catch(() => "");
  try {
    const body = JSON.parse(text) as { error?: { message?: string } | string; message?: string };
    const message = typeof body.error === "string" ? body.error : body.error?.message || body.message;
    if (message) return sanitizeLlmError(message);
  } catch { /* not json */ }
  return sanitizeLlmError(text || `HTTP ${response.status}`);
}

function authHint(status: number, provider: string, model: string, detail: string): string {
  if (status === 401 || status === 403) {
    return `LLM 认证失败（${provider} / ${model}）：请检查 API Key 是否正确、是否过期。${detail ? `（${detail}）` : ""}`;
  }
  return `LLM 请求失败（HTTP ${status}，${provider} / ${model}）：${detail}`;
}

// ---- OpenAI-compatible ----

function openAiBody(endpoint: LlmEndpoint, request: ChatRequest, stream: boolean, full: boolean): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: request.model || endpoint.model,
    messages: request.messages,
  };
  if (request.tools?.length) {
    body.tools = request.tools.map((tool) => ({ type: "function", function: { name: tool.name, description: tool.description, parameters: tool.parameters } }));
  }
  if (request.temperature !== undefined) body.temperature = request.temperature;
  if (request.maxTokens) body.max_tokens = request.maxTokens;
  if (request.json && endpoint.supportsJsonMode !== false) body.response_format = { type: "json_object" };
  if (stream) body.stream = true;
  if (full) {
    if (stream) body.stream_options = { include_usage: true };
    if (request.reasoningEffort) body.reasoning_effort = request.reasoningEffort;
  }
  return body;
}

function headersFor(endpoint: LlmEndpoint): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json", ...(endpoint.headers || {}) };
  const key = endpoint.apiKey || (isLocal(endpoint.baseUrl) ? "local" : "");
  if ((endpoint.apiFormat || "openai") === "anthropic") {
    headers["x-api-key"] = key;
    headers["anthropic-version"] = "2023-06-01";
    // Browser direct calls need this opt-in header; harmless elsewhere.
    headers["anthropic-dangerous-direct-browser-access"] = "true";
  } else if (key) {
    headers.Authorization = `Bearer ${key}`;
  }
  return headers;
}

async function postWithRetry(
  fetchFn: FetchLike,
  url: string,
  endpoint: LlmEndpoint,
  build: (full: boolean) => Record<string, unknown>,
  signal: AbortSignal | undefined,
): Promise<FetchResponseLike> {
  const send = (full: boolean) => fetchFn(url, { method: "POST", headers: headersFor(endpoint), body: JSON.stringify(build(full)), signal });
  let response = await send(true);
  // Some OpenAI-compatible gateways reject stream_options / reasoning_effort with 400: retry once without.
  if (response.status === 400 && JSON.stringify(build(true)) !== JSON.stringify(build(false))) {
    await response.text().catch(() => "");
    response = await send(false);
  }
  return response;
}

// ---- Anthropic Messages ----

function anthropicBody(endpoint: LlmEndpoint, request: ChatRequest, stream: boolean): Record<string, unknown> {
  let system = "";
  const native: Array<{ role: "user" | "assistant"; content: Array<Record<string, unknown>> }> = [];
  for (const message of request.messages) {
    let role: "user" | "assistant";
    let blocks: Array<Record<string, unknown>>;
    if (message.role === "system") {
      system += (system ? "\n" : "") + (typeof message.content === "string" ? message.content : "");
      continue;
    }
    if (message.role === "tool") {
      role = "user";
      blocks = [{ type: "tool_result", tool_use_id: message.tool_call_id, content: typeof message.content === "string" ? message.content : JSON.stringify(message.content) }];
    } else {
      role = message.role === "assistant" ? "assistant" : "user";
      const content = message.content;
      if (Array.isArray(content)) {
        blocks = content.map((part) => {
          if (part.type === "text") return { type: "text", text: part.text };
          const match = /^data:([^;]+);base64,(.*)$/s.exec(part.image_url.url);
          return match
            ? { type: "image", source: { type: "base64", media_type: match[1], data: match[2] } }
            : { type: "image", source: { type: "url", url: part.image_url.url } };
        });
      } else {
        blocks = content ? [{ type: "text", text: content }] : [];
      }
      for (const call of message.tool_calls || []) {
        blocks.push({ type: "tool_use", id: call.id, name: call.function.name, input: parseToolArguments(call.function.arguments) });
      }
    }
    if (!blocks.length) continue;
    const last = native[native.length - 1];
    if (last && last.role === role) last.content.push(...blocks);
    else native.push({ role, content: blocks });
  }
  const body: Record<string, unknown> = {
    model: request.model || endpoint.model,
    max_tokens: request.maxTokens || 8192,
    system,
    messages: native,
  };
  if (request.temperature !== undefined) body.temperature = request.temperature;
  if (request.tools?.length) body.tools = request.tools.map((tool) => ({ name: tool.name, description: tool.description, input_schema: tool.parameters }));
  if (stream) body.stream = true;
  return body;
}

const ANTHROPIC_STOP: Record<string, string> = { end_turn: "stop", tool_use: "tool_calls", max_tokens: "length" };

/** Translate Anthropic stream events into OpenAI-style chunks (provider.py _anthropic_chunks). */
function anthropicChunk(event: Record<string, unknown>): Record<string, unknown> | null {
  const kind = event.type;
  if (kind === "content_block_start") {
    const block = event.content_block as Record<string, unknown>;
    if (block?.type === "tool_use") {
      return { choices: [{ delta: { tool_calls: [{ index: event.index, id: block.id, function: { name: block.name } }] } }] };
    }
    return null;
  }
  if (kind === "content_block_delta") {
    const part = event.delta as Record<string, unknown>;
    if (part.type === "text_delta") return { choices: [{ delta: { content: part.text } }] };
    if (part.type === "thinking_delta") return { choices: [{ delta: { reasoning_content: part.thinking } }] };
    if (part.type === "input_json_delta") return { choices: [{ delta: { tool_calls: [{ index: event.index, function: { arguments: part.partial_json } }] } }] };
    return null;
  }
  if (kind === "message_start") {
    const usage = (event.message as Record<string, unknown> | undefined)?.usage as Record<string, unknown> | undefined;
    return usage ? { choices: [], usage } : null;
  }
  if (kind === "message_delta") {
    const reason = String((event.delta as Record<string, unknown> | undefined)?.stop_reason || "");
    return { choices: [{ delta: {}, finish_reason: ANTHROPIC_STOP[reason] || reason || null }], usage: event.usage };
  }
  if (kind === "error") {
    const message = (event.error as Record<string, unknown> | undefined)?.message;
    throw new Error(sanitizeLlmError(message || "Anthropic stream failed"));
  }
  return null;
}

// ---- client ----

export function createLlmClient(endpoint: LlmEndpoint, options: { fetch: FetchLike }): LlmClient {
  const fetchFn = options.fetch;
  const format: LlmApiFormat = endpoint.apiFormat || "openai";
  const provider = endpoint.provider || "custom";

  async function* stream(request: ChatRequest): AsyncGenerator<LlmStreamEvent> {
    const model = request.model || endpoint.model;
    let text = "";
    let reasoning = "";
    const slots: Slot[] = [];
    let finish: FinishReason = "stop";
    let usageRaw: Record<string, unknown> | undefined;
    let usageMerged: Record<string, unknown> = {};
    let error: string | undefined;
    try {
      const response = format === "anthropic"
        ? await fetchFn(joinUrl(endpoint.baseUrl, "/v1/messages").replace(/\/v1\/v1\//, "/v1/"), {
          method: "POST", headers: headersFor(endpoint), body: JSON.stringify(anthropicBody(endpoint, request, true)), signal: request.signal,
        })
        : await postWithRetry(fetchFn, joinUrl(endpoint.baseUrl, "/chat/completions"), endpoint, (full) => openAiBody(endpoint, request, true, full), request.signal);
      if (!response.ok) throw new Error(authHint(response.status, provider, model, await errorText(response)));
      if (!response.body) throw new Error("LLM 流式响应为空");
      for await (const item of readSse(response.body.getReader())) {
        if (request.signal?.aborted) {
          finish = "aborted";
          break;
        }
        if (item.data === "[DONE]") break;
        let chunk: Record<string, unknown> | null;
        try {
          chunk = JSON.parse(item.data) as Record<string, unknown>;
        } catch {
          continue;
        }
        if (format === "anthropic") chunk = anthropicChunk(chunk);
        if (!chunk) continue;
        if (chunk.error) throw new Error(sanitizeLlmError((chunk.error as { message?: string }).message || JSON.stringify(chunk.error)));
        if (chunk.usage && typeof chunk.usage === "object") {
          usageMerged = { ...usageMerged, ...(chunk.usage as Record<string, unknown>) };
          usageRaw = usageMerged;
        }
        const choice = ((chunk.choices as unknown[]) || [])[0] as Record<string, unknown> | undefined;
        if (!choice) continue;
        if (choice.finish_reason) finish = String(choice.finish_reason);
        const delta = (choice.delta || {}) as Record<string, unknown>;
        const thinking = String(delta.reasoning_content || delta.reasoning || "");
        if (thinking) {
          reasoning += thinking;
          yield { type: "thinking_delta", text: thinking };
        }
        const content = typeof delta.content === "string" ? delta.content : "";
        if (content) {
          text += content;
          yield { type: "text_delta", text: content };
        }
        for (const toolDelta of (delta.tool_calls as Array<Record<string, unknown>>) || []) {
          const index = toolCallSlot(slots, toolDelta);
          const slot = slots[index];
          if (toolDelta.id) slot.id = String(toolDelta.id);
          const fn = (toolDelta.function || {}) as Record<string, unknown>;
          const name = String(fn.name || "");
          // Some providers repeat the full name on every fragment.
          if (name && name !== slot.name) slot.name += name;
          if (fn.arguments) slot.arguments += String(fn.arguments);
          yield { type: "tool_call_delta", index, id: slot.id, name: slot.name, arguments: slot.arguments };
        }
      }
    } catch (cause) {
      if (request.signal?.aborted || (cause instanceof Error && cause.name === "AbortError")) finish = "aborted";
      else {
        error = sanitizeLlmError(cause instanceof Error ? cause.message : cause);
        finish = "error";
      }
    }
    if (usageRaw && format === "anthropic") {
      usageRaw = { input_tokens: usageRaw.input_tokens, output_tokens: usageRaw.output_tokens };
    }
    yield {
      type: "done",
      result: {
        provider, model, content: text, reasoning,
        toolCalls: finalToolCalls(slots),
        finishReason: finish,
        usage: usageOf(usageRaw, text),
        ...(error ? { error } : {}),
      },
    };
  }

  async function chat(request: ChatRequest): Promise<ChatResult> {
    const model = request.model || endpoint.model;
    if (format === "anthropic") {
      const response = await fetchFn(joinUrl(endpoint.baseUrl, "/v1/messages").replace(/\/v1\/v1\//, "/v1/"), {
        method: "POST", headers: headersFor(endpoint), body: JSON.stringify(anthropicBody(endpoint, request, false)), signal: request.signal,
      });
      if (!response.ok) {
        const detail = await errorText(response);
        throw new LlmHttpError(authHint(response.status, provider, model, detail), response.status);
      }
      const body = JSON.parse(await response.text()) as { content?: Array<Record<string, unknown>>; stop_reason?: string; usage?: Record<string, unknown> };
      const blocks = body.content || [];
      const content = blocks.filter((block) => block.type === "text").map((block) => String(block.text || "")).join("");
      const toolCalls = blocks.filter((block) => block.type === "tool_use").map((block) => ({
        id: String(block.id), name: String(block.name), arguments: JSON.stringify(block.input || {}), args: parseToolArguments(block.input),
      }));
      return { provider, model, content, reasoning: "", toolCalls, finishReason: ANTHROPIC_STOP[body.stop_reason || ""] || body.stop_reason || "stop", usage: usageOf(body.usage, content) };
    }
    const response = await postWithRetry(fetchFn, joinUrl(endpoint.baseUrl, "/chat/completions"), endpoint, (full) => openAiBody(endpoint, request, false, full), request.signal);
    if (!response.ok) {
      const detail = await errorText(response);
      throw new LlmHttpError(authHint(response.status, provider, model, detail), response.status);
    }
    const body = JSON.parse(await response.text()) as { choices?: Array<{ message?: Record<string, unknown>; finish_reason?: string }>; usage?: Record<string, unknown> };
    const choice = body.choices?.[0] || {};
    const message = choice.message || {};
    const content = typeof message.content === "string" ? message.content : "";
    const toolCalls = ((message.tool_calls as ChatToolCall[] | undefined) || []).map((call, index) => ({
      id: call.id || `call_${index + 1}`, name: call.function?.name || "", arguments: call.function?.arguments || "", args: parseToolArguments(call.function?.arguments),
    })).filter((call) => call.name);
    return {
      provider, model, content,
      reasoning: String(message.reasoning_content || message.reasoning || ""),
      toolCalls,
      finishReason: choice.finish_reason || "stop",
      usage: usageOf(body.usage, content),
    };
  }

  return { provider, model: endpoint.model, chat, stream };
}

/** End index (exclusive) of the balanced JSON object starting at `start`, or -1. */
function objectEnd(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (ch === "\\") i += 1;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

/** agents/llm.py extract_json: whole text, then a ```json fence, then the first complete {...} object. */
export function extractJson(text: string): Record<string, unknown> | null {
  if (!text) return null;
  const trimmed = text.trim();
  const asObject = (candidate: string): Record<string, unknown> | null => {
    try {
      const parsed: unknown = JSON.parse(candidate);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
    } catch {
      return null;
    }
  };
  const direct = asObject(trimmed);
  if (direct) return direct;
  const fence = /```(?:json)?\s*\n([\s\S]*?)\n```/.exec(trimmed);
  if (fence) {
    const fenced = asObject(fence[1]);
    if (fenced) return fenced;
  }
  for (let i = trimmed.indexOf("{"); i >= 0; i = trimmed.indexOf("{", i + 1)) {
    const end = objectEnd(trimmed, i);
    if (end < 0) continue;
    const found = asObject(trimmed.slice(i, end));
    if (found) return found;
  }
  return null;
}
