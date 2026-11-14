// LLM access for core tools. Runtime-agnostic: no node:*, no DOM.
//
// Tools never build HTTP requests to a model themselves; they receive an
// `LlmClient`. The browser builds one from the user's own key (BYOK, direct to
// the provider), the Node companion builds one from its settings, tests pass a
// fake. `createOpenAiLlm` is the stock OpenAI-compatible implementation and
// only needs an injected `fetch`.
//
// Semantics mirror Python `app.agents.llm.chat_completion`:
//   - returns the text, or `null` when the model gave nothing usable
//     (timeout, transient upstream failure, empty answer);
//   - throws `CoreError(code="forbidden")` for a rejected key, so the user
//     sees "fix your key" instead of a silent empty result;
//   - throws `CoreError(code="unsupported")` when no model is configured.
//
// The Agent loop needs more than text: streamed reasoning / tool-call deltas,
// tool calling and Anthropic Messages. Those live on the same client as the
// optional `complete` / `completeStream` methods (port of
// backend/app/agent/provider.py LlmStreamProvider). `createLlmClient` builds a
// client with every method from one resolved endpoint (llm-config.ts).

import { CoreError } from "./types";

export type LlmRole = "system" | "user" | "assistant";
export type LlmMessage = { role: LlmRole; content: string };
/** Model tier, same names as Python `resolve_model_for_tier`. */
export type LlmTier = "fast" | "standard" | "premium";

export type LlmChatOptions = {
  /** Default 0.3, like Python. */
  temperature?: number;
  /** Ask for a JSON object (response_format=json_object when supported). */
  json?: boolean;
  /** Default 4096, like Python. */
  maxTokens?: number;
  /** Default "standard". */
  tier?: LlmTier;
  signal?: AbortSignal;
};

export interface LlmClient {
  /** One chat completion. `null` = no usable answer (see module doc). */
  chat(messages: LlmMessage[], options?: LlmChatOptions): Promise<string | null>;
  /**
   * Optional token stream (Python `chat_completion_stream`). Yields text
   * deltas; ends early (no throw) on timeout/transient failure, throws
   * CoreError("forbidden") on a rejected key. Use `streamOrChat` to fall back
   * to one chunk when a client has no stream.
   */
  chatStream?(messages: LlmMessage[], options?: LlmChatOptions): AsyncIterable<string>;
  /**
   * True when the model runs on this machine (Ollama, LM Studio...). Tools
   * skip PII desensitization only for local models, like Python
   * `endpoint_is_local`. Absent = remote.
   */
  readonly local?: boolean;
  /** Provider id / default model, for run metadata. */
  readonly provider?: string;
  readonly model?: string;
  /**
   * Full completion with tool calling (OpenAI tools / Anthropic tool_use).
   * Throws CoreError on HTTP / auth failure. Present on clients built by
   * createLlmClient / createOpenAiLlm.
   */
  complete?(request: ChatRequest): Promise<ChatResult>;
  /**
   * Streamed completion with text / reasoning / tool-call deltas. Never
   * throws: failures end with done{finishReason:"error"}.
   */
  completeStream?(request: ChatRequest): AsyncIterable<LlmStreamEvent>;
}

/** A client with tool calling (what createLlmClient / createOpenAiLlm return). */
export type ToolLlmClient = LlmClient & Required<Pick<LlmClient, "complete" | "completeStream" | "chatStream">>;

/** Stream when the client can, otherwise yield the whole answer as one chunk. */
export async function* streamOrChat(llm: LlmClient, messages: LlmMessage[], options: LlmChatOptions = {}): AsyncIterable<string> {
  if (llm.chatStream) {
    yield* llm.chatStream(messages, options);
    return;
  }
  const text = await llm.chat(messages, options);
  if (text) yield text;
}

export type FetchLike = (input: string, init?: {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
  /** Needed only for chatStream. */
  body?: { getReader(): ByteReader } | null;
}>;

/** Throw the standard "no model" error when a tool needs an LLM and none was injected. */
export function requireLlm(llm: LlmClient | null | undefined, message = "没配模型，没法调用模型"): LlmClient {
  if (!llm) throw new CoreError(message, "unsupported");
  return llm;
}

/**
 * Pull a JSON object out of model output: plain JSON, a ```json fenced block,
 * or the first complete {...} object in surrounding prose. Mirrors Python
 * `extract_json`. Returns null when nothing parses to an object.
 */
export function extractJson(text: string | null | undefined): Record<string, unknown> | null {
  if (!text) return null;
  const trimmed = text.trim();
  const asObject = (value: unknown) =>
    typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
  try {
    const direct = JSON.parse(trimmed);
    // Python returns whatever json.loads gives; callers only use dicts.
    if (asObject(direct)) return asObject(direct);
  } catch { /* fall through */ }
  const fenced = /```(?:json)?\s*\n([\s\S]*?)\n```/.exec(trimmed);
  if (fenced) {
    try {
      const value = asObject(JSON.parse(fenced[1]));
      if (value) return value;
    } catch { /* fall through */ }
  }
  for (let start = trimmed.indexOf("{"); start >= 0; start = trimmed.indexOf("{", start + 1)) {
    const end = matchingBrace(trimmed, start);
    if (end < 0) continue;
    try {
      const value = asObject(JSON.parse(trimmed.slice(start, end + 1)));
      if (value) return value;
    } catch { /* try next brace */ }
  }
  return null;
}

function matchingBrace(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (ch === "\\") i += 1;
      else if (ch === "\"") inString = false;
      continue;
    }
    if (ch === "\"") inString = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** chat() + extractJson(); null when the model returned nothing or no JSON object. */
export async function chatJson(
  llm: LlmClient,
  messages: LlmMessage[],
  options: LlmChatOptions = {},
): Promise<Record<string, unknown> | null> {
  return extractJson(await llm.chat(messages, { ...options, json: true }));
}

export type OpenAiLlmConfig = {
  /** e.g. https://api.openai.com/v1 or https://api.deepseek.com/v1 (".../chat/completions" is appended). */
  baseUrl: string;
  apiKey?: string;
  /** Default model; `models` overrides it per tier. */
  model: string;
  models?: Partial<Record<LlmTier, string>>;
  /** Local / gateways that reject response_format set this false. Default true. */
  supportsJsonMode?: boolean;
  /** Per attempt. Default 120000 ms. */
  timeoutMs?: number;
  fetch: FetchLike;
  extraHeaders?: Record<string, string>;
  /** Wait between retries; injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Provider id for run metadata. Default "custom". */
  provider?: string;
};

class HttpFailure extends Error {
  constructor(readonly status: number, readonly body: string) {
    super(`HTTP ${status}`);
  }
}

/** True for loopback / LAN model endpoints (Python `_is_local_llm`). */
export function isLocalLlmUrl(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname.toLowerCase().replace(/^\[|\]$/g, "");
    return host === "localhost" || host === "::1" || host.endsWith(".local")
      || /^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host)
      || /^172\.(1[6-9]|2\d|3[01])\./.test(host) || host === "0.0.0.0" || host === "host.docker.internal";
  } catch {
    return false;
  }
}

type Response = Awaited<ReturnType<FetchLike>>;

/** OpenAI-compatible /chat/completions client over an injected fetch. */
export function createOpenAiLlm(config: OpenAiLlmConfig): ToolLlmClient {
  const url = `${config.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  const sleep = config.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const timeoutMs = config.timeoutMs ?? 120_000;

  /** POST with retry on 408/429/5xx; returns the open response (body unread on success). */
  async function post(body: Record<string, unknown>, signal: AbortSignal): Promise<Response> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        const response = await config.fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
            ...config.extraHeaders,
          },
          body: JSON.stringify(body),
          signal,
        });
        if (!response.ok) throw new HttpFailure(response.status, await response.text());
        return response;
      } catch (cause) {
        const status = cause instanceof HttpFailure ? cause.status : 0;
        const retryable = status === 408 || status === 429 || status >= 500;
        if (!retryable || attempt === 2 || signal.aborted) throw cause;
        await sleep(500 * 2 ** attempt);
      }
    }
  }

  function request(messages: LlmMessage[], options: LlmChatOptions): { body: Record<string, unknown>; model: string; maxTokens: number } {
    if (!messages.length) throw new CoreError("消息不能为空");
    const model = config.models?.[options.tier ?? "standard"] || config.model;
    let sent = messages;
    const body: Record<string, unknown> = { model, temperature: options.temperature ?? 0.3 };
    if (options.json && config.supportsJsonMode !== false) {
      body.response_format = { type: "json_object" };
      // Some gateways only accept json_object when the prompt says "json".
      if (!messages.map((m) => m.content).join(" ").toLowerCase().includes("json")) {
        const last = messages[messages.length - 1];
        sent = [...messages.slice(0, -1), { ...last, content: `${last.content}\n\nReturn JSON only.` }];
      }
    }
    body.messages = sent;
    return { body, model, maxTokens: options.maxTokens ?? 4096 };
  }

  /** Reasoning models spend max_tokens on thinking: send a total budget, fall back for old endpoints. */
  async function open(body: Record<string, unknown>, maxTokens: number, signal: AbortSignal): Promise<Response> {
    try {
      return await post({ ...body, max_completion_tokens: maxTokens * 3 }, signal);
    } catch (cause) {
      if (!(cause instanceof HttpFailure) || !cause.body.toLowerCase().includes("max_completion_tokens")) throw cause;
      return post({ ...body, max_tokens: maxTokens }, signal);
    }
  }

  function authError(cause: unknown, model: string): CoreError | null {
    return cause instanceof HttpFailure && (cause.status === 401 || cause.status === 403)
      ? new CoreError(`模型 API Key 无效或没有权限（${model}，HTTP ${cause.status}）；请在设置里检查 Key`, "forbidden")
      : null;
  }

  function deadline(signal?: AbortSignal): { signal: AbortSignal; done(): void } {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const onAbort = () => controller.abort();
    signal?.addEventListener("abort", onAbort);
    return {
      signal: controller.signal,
      done() {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      },
    };
  }

  const provider = config.provider || "custom";
  const tools = toolCallingMethods({
    provider,
    baseUrl: config.baseUrl,
    apiKey: config.apiKey ?? "",
    model: config.model,
    models: config.models,
    apiFormat: "openai",
    supportsJsonMode: config.supportsJsonMode,
    headers: config.extraHeaders,
  }, config.fetch);

  return {
    local: isLocalLlmUrl(config.baseUrl),
    provider,
    model: config.model,
    ...tools,

    async chat(messages, options = {}) {
      const { body, model, maxTokens } = request(messages, options);
      const timer = deadline(options.signal);
      try {
        const response = await open(body, maxTokens, timer.signal);
        const data = JSON.parse(await response.text()) as { choices?: Array<{ message?: { content?: unknown } }> };
        const content = data.choices?.[0]?.message?.content;
        return typeof content === "string" && content ? content : null;
      } catch (cause) {
        const auth = authError(cause, model);
        if (auth) throw auth;
        return null;
      } finally {
        timer.done();
      }
    },

    async *chatStream(messages, options = {}) {
      const { body, model, maxTokens } = request(messages, options);
      const timer = deadline(options.signal);
      try {
        const response = await open({ ...body, stream: true }, maxTokens, timer.signal);
        if (!response.body) {
          // Endpoint ignored stream=true: treat the whole reply as one chunk.
          const data = JSON.parse(await response.text()) as { choices?: Array<{ message?: { content?: unknown } }> };
          const content = data.choices?.[0]?.message?.content;
          if (typeof content === "string" && content) yield content;
          return;
        }
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        try {
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            let newline: number;
            while ((newline = buffer.indexOf("\n")) >= 0) {
              const line = buffer.slice(0, newline).trim();
              buffer = buffer.slice(newline + 1);
              if (!line.startsWith("data:")) continue;
              const payload = line.slice(5).trim();
              if (payload === "[DONE]") return;
              try {
                const chunk = JSON.parse(payload) as { choices?: Array<{ delta?: { content?: unknown } }> };
                const text = chunk.choices?.[0]?.delta?.content;
                if (typeof text === "string" && text) yield text;
              } catch { /* keep-alive or partial line */ }
            }
          }
        } finally {
          reader.releaseLock?.();
        }
      } catch (cause) {
        const auth = authError(cause, model);
        if (auth) throw auth;
        // Timeout / upstream failure: end the stream like Python does.
      } finally {
        timer.done();
      }
    },
  };
}

// ======== Agent: tool calling, streamed deltas, Anthropic ========

export type LlmApiFormat = "openai" | "anthropic";

/** A fully resolved endpoint (see llm-config.ts resolveLlmClientConfig). */
export interface LlmEndpoint {
  provider: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  /** Per-tier models for chat()/chatStream() `tier`. */
  models?: Partial<Record<LlmTier, string>>;
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
  /** HTTP status behind `error`, when there was one. */
  errorStatus?: number;
}

export type LlmStreamEvent =
  | { type: "text_delta"; text: string }
  | { type: "thinking_delta"; text: string }
  | { type: "tool_call_delta"; index: number; id: string; name: string; arguments: string }
  /** Always the last event. finishReason "error"/"aborted" instead of throwing. */
  | { type: "done"; result: ChatResult };

// ---- helpers ----

/** Minimal byte reader (ReadableStreamDefaultReader fits). */
export interface ByteReader {
  read(): Promise<{ done: boolean; value?: Uint8Array }>;
  cancel?(reason?: unknown): Promise<void>;
  releaseLock?(): void;
}


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

async function errorText(response: Response): Promise<string> {
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
  const key = endpoint.apiKey || (isLocalLlmUrl(endpoint.baseUrl) ? "local" : "");
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
): Promise<Response> {
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

/** complete / completeStream for one endpoint (provider.py LlmStreamProvider). */
function toolCallingMethods(endpoint: LlmEndpoint, fetchFn: FetchLike): Required<Pick<LlmClient, "complete" | "completeStream">> {
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
    let errorStatus: number | undefined;
    try {
      const response = format === "anthropic"
        ? await fetchFn(joinUrl(endpoint.baseUrl, "/v1/messages").replace(/\/v1\/v1\//, "/v1/"), {
          method: "POST", headers: headersFor(endpoint), body: JSON.stringify(anthropicBody(endpoint, request, true)), signal: request.signal,
        })
        : await postWithRetry(fetchFn, joinUrl(endpoint.baseUrl, "/chat/completions"), endpoint, (full) => openAiBody(endpoint, request, true, full), request.signal);
      if (!response.ok) throw new LlmHttpError(authHint(response.status, provider, model, await errorText(response)), response.status);
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
        if (cause instanceof LlmHttpError) errorStatus = cause.status;
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
        ...(errorStatus ? { errorStatus } : {}),
      },
    };
  }

  async function complete(request: ChatRequest): Promise<ChatResult> {
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

  return { complete, completeStream: stream };
}

export type CreateLlmOptions = {
  fetch: FetchLike;
  /** Per attempt for chat()/chatStream(). Default 120000 ms. */
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
};

/**
 * One client with every method for a resolved endpoint. OpenAI-compatible
 * endpoints get createOpenAiLlm's chat/chatStream (retry, json hint,
 * max_completion_tokens); Anthropic endpoints answer chat/chatStream through
 * the Messages API.
 */
export function createLlmClient(endpoint: LlmEndpoint, options: CreateLlmOptions): ToolLlmClient {
  const provider = endpoint.provider || "custom";
  if ((endpoint.apiFormat || "openai") === "openai") {
    return createOpenAiLlm({
      baseUrl: endpoint.baseUrl,
      apiKey: endpoint.apiKey || (isLocalLlmUrl(endpoint.baseUrl) ? "local" : ""),
      model: endpoint.model,
      models: endpoint.models,
      supportsJsonMode: endpoint.supportsJsonMode,
      extraHeaders: endpoint.headers,
      timeoutMs: options.timeoutMs,
      sleep: options.sleep,
      fetch: options.fetch,
      provider,
    });
  }
  const methods = toolCallingMethods(endpoint, options.fetch);
  const toRequest = (messages: LlmMessage[], chatOptions: LlmChatOptions): ChatRequest => {
    if (!messages.length) throw new CoreError("消息不能为空");
    return {
      messages,
      model: endpoint.models?.[chatOptions.tier ?? "standard"] || endpoint.model,
      temperature: chatOptions.temperature ?? 0.3,
      maxTokens: chatOptions.maxTokens ?? 4096,
      json: chatOptions.json,
      signal: chatOptions.signal,
    };
  };
  return {
    local: isLocalLlmUrl(endpoint.baseUrl),
    provider,
    model: endpoint.model,
    ...methods,
    async chat(messages, chatOptions = {}) {
      try {
        const result = await methods.complete(toRequest(messages, chatOptions));
        return result.content || null;
      } catch (cause) {
        if (cause instanceof CoreError && cause.code === "forbidden") throw cause;
        if (cause instanceof CoreError && !(cause instanceof LlmHttpError)) throw cause;
        return null;
      }
    },
    async *chatStream(messages, chatOptions = {}) {
      for await (const event of methods.completeStream(toRequest(messages, chatOptions))) {
        if (event.type === "text_delta") yield event.text;
        else if (event.type === "done" && (event.result.errorStatus === 401 || event.result.errorStatus === 403)) {
          throw new CoreError(event.result.error || "模型 API Key 无效", "forbidden");
        }
      }
    },
  };
}

/** Stream one Agent turn; clients without completeStream fall back to complete, then fail. */
export async function* streamCompletion(llm: LlmClient, request: ChatRequest): AsyncIterable<LlmStreamEvent> {
  if (llm.completeStream) {
    yield* llm.completeStream(request);
    return;
  }
  if (!llm.complete) throw new CoreError("当前模型客户端不支持工具调用", "unsupported");
  const result = await llm.complete(request);
  if (result.reasoning) yield { type: "thinking_delta", text: result.reasoning };
  if (result.content) yield { type: "text_delta", text: result.content };
  yield { type: "done", result };
}

