// Minimal LLM port for the portable core. The browser (user's own key) and the
// Node companion both inject an implementation; core code never reads config,
// env vars, or keys itself.
//
// Contract mirrors Python app.agents.llm.chat_completion: resolve to the model's
// text, or null when the call failed / timed out / returned nothing. Only an
// abort (caller disconnected) rejects.

export type ChatRole = "system" | "user" | "assistant";
export type ChatMessage = { role: ChatRole; content: string };

export type ChatOptions = {
  temperature?: number;
  /** Ask for a JSON object (OpenAI response_format json_object). */
  jsonMode?: boolean;
  maxTokens?: number;
  /** Model tier hint ("standard" by default); implementations may ignore it. */
  tier?: string;
  signal?: AbortSignal;
};

export interface LlmClient {
  chat(messages: ChatMessage[], options?: ChatOptions): Promise<string | null>;
}

export type OpenAiCompatibleConfig = {
  /** e.g. https://api.deepseek.com/v1 — "/chat/completions" is appended. */
  baseUrl: string;
  apiKey: string;
  model: string;
  /** Injected so the same client runs in the browser, Workers, and Node. Defaults to globalThis.fetch. */
  fetch?: typeof fetch;
  /** Some providers reject response_format; default true like Python supports_json_mode. */
  supportsJsonMode?: boolean;
  timeoutMs?: number;
  headers?: Record<string, string>;
};

function isAbort(error: unknown, signal?: AbortSignal): boolean {
  return Boolean(signal?.aborted) || (error instanceof Error && error.name === "AbortError" && Boolean(signal?.aborted));
}

/** OpenAI-compatible /chat/completions client (DeepSeek, Qwen, SiliconFlow, Ollama, OpenAI ...). */
export function openAiCompatibleClient(config: OpenAiCompatibleConfig): LlmClient {
  const doFetch = config.fetch ?? globalThis.fetch.bind(globalThis);
  const url = `${config.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  return {
    async chat(messages, options = {}) {
      const body: Record<string, unknown> = {
        model: config.model,
        messages,
        temperature: options.temperature ?? 0.3,
        max_tokens: options.maxTokens ?? 4096,
      };
      if (options.jsonMode && config.supportsJsonMode !== false) body.response_format = { type: "json_object" };
      const timeout = AbortSignal.timeout(config.timeoutMs ?? 120_000);
      const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
      try {
        const response = await doFetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.apiKey}`, ...config.headers },
          body: JSON.stringify(body),
          signal,
        });
        if (!response.ok) return null;
        const data = await response.json() as { choices?: Array<{ message?: { content?: unknown } }> };
        const content = data.choices?.[0]?.message?.content;
        return typeof content === "string" && content ? content : null;
      } catch (error) {
        if (isAbort(error, options.signal)) throw error;
        return null;
      }
    },
  };
}

function balancedObjectEnd(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (ch === "\\") i += 1;
      else if (ch === "\"") inString = false;
    } else if (ch === "\"") {
      inString = true;
    } else if (ch === "{") {
      depth += 1;
    } else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Same fallbacks as Python extract_json: whole text, then a ```json fence,
 * then the first complete {...} object that parses.
 */
export function extractJson(text: string | null | undefined): unknown {
  if (!text) return null;
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch { /* fall through */ }
  const fenced = /```(?:json)?\s*\n([\s\S]*?)\n```/.exec(trimmed);
  if (fenced) {
    try {
      return JSON.parse(fenced[1]);
    } catch { /* fall through */ }
  }
  for (let i = trimmed.indexOf("{"); i >= 0; i = trimmed.indexOf("{", i + 1)) {
    const end = balancedObjectEnd(trimmed, i);
    if (end < 0) continue;
    try {
      const value = JSON.parse(trimmed.slice(i, end + 1));
      if (value && typeof value === "object" && !Array.isArray(value)) return value;
    } catch { /* next brace */ }
  }
  return null;
}
