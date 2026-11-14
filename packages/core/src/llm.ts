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
}

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
  body?: ReadableStream<Uint8Array> | null;
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
export function createOpenAiLlm(config: OpenAiLlmConfig): LlmClient {
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

  return {
    local: isLocalLlmUrl(config.baseUrl),

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
          reader.releaseLock();
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
