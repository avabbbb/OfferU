// Injected LLM access for the portable core. The core never reads a key or a
// config file: the host (browser key vault, local companion config file) builds
// an LlmClient and passes it in. Keys therefore never reach a Worker or a log.
//
// Minimal definition: no shared LlmClient existed on origin when this was
// written (origin/ts/core-tools and origin/ts/agent were absent). If another
// branch lands a richer one, keep `chat` / `runtime` / `transcribe` compatible.

import { CoreError } from "./types";

export type LlmTier = "fast" | "standard" | "premium";
export type LlmRole = "system" | "user" | "assistant";
export type LlmMessage = { role: LlmRole; content: string };
export type LlmApiFormat = "openai" | "anthropic";

export type LlmChatOptions = {
  tier?: LlmTier;
  temperature?: number;
  jsonMode?: boolean;
  maxTokens?: number;
};

/** What the next chat call will use; mirrors Python get_llm_runtime_info + is_local. */
export type LlmRuntimeInfo = {
  provider: string;
  model: string;
  tier: LlmTier;
  source: string;
  model_source: "provider_models" | "llm_model";
  is_local: boolean;
};

export interface LlmClient {
  /** Endpoint is on this machine (loopback): callers may skip PII masking. */
  readonly local?: boolean;
  runtime(tier?: LlmTier): LlmRuntimeInfo;
  /** Text of the first choice; null when the call failed or returned nothing (Python returns None). */
  chat(messages: LlmMessage[], options?: LlmChatOptions): Promise<string | null>;
  /** Speech to text through the provider's /audio/transcriptions; absent when unsupported. */
  transcribe?(audio: Blob, fileName: string): Promise<string>;
}

/** One resolved provider endpoint. api_key lives only in the host's local storage. */
export type LlmEndpoint = {
  provider_id: string;
  service_name: string;
  base_url: string;
  api_key: string;
  model: string;
  models: Record<string, string>;
  api_format: LlmApiFormat;
  supports_json_mode: boolean;
  default_headers: Record<string, string>;
  source: string;
  tier_model_map?: Record<string, string>;
};

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export const NO_ASR_HINT = "当前模型服务不支持语音转写。可以先用飞书妙记、通义听悟等工具转成文字，再粘贴进来。";

/** Port of agents/llm.extract_json: whole text, ```json fence, then the first decodable {...}. */
export function extractJson(text: string | null | undefined): Record<string, unknown> | null {
  if (!text) return null;
  const trimmed = text.trim();
  const asObject = (value: unknown) => (value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null);
  try {
    return asObject(JSON.parse(trimmed));
  } catch {
    // fall through
  }
  const fence = /```(?:json)?\s*\n([\s\S]*?)\n```/.exec(trimmed);
  if (fence) {
    try {
      const parsed = asObject(JSON.parse(fence[1]));
      if (parsed) return parsed;
    } catch {
      // fall through
    }
  }
  for (let start = trimmed.indexOf("{"); start >= 0; start = trimmed.indexOf("{", start + 1)) {
    const end = matchingBrace(trimmed, start);
    if (end < 0) continue;
    try {
      const parsed = asObject(JSON.parse(trimmed.slice(start, end + 1)));
      if (parsed) return parsed;
    } catch {
      // try the next brace
    }
  }
  return null;
}

function matchingBrace(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (char === "\\") index += 1;
      else if (char === "\"") inString = false;
      continue;
    }
    if (char === "\"") inString = true;
    else if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

export function isLocalLlmUrl(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
    return host === "localhost" || host === "::1" || /^127\.\d+\.\d+\.\d+$/.test(host);
  } catch {
    return false;
  }
}

/** Port of resolve_model_for_tier for a resolved endpoint. */
export function modelForTier(endpoint: LlmEndpoint, tier: LlmTier = "standard"): string {
  return endpoint.models[tier] || endpoint.tier_model_map?.[tier] || endpoint.model;
}

export function asrModel(baseUrl: string): string {
  const host = baseUrl.toLowerCase();
  if (host.includes("siliconflow")) return "FunAudioLLM/SenseVoiceSmall";
  if (host.includes("groq")) return "whisper-large-v3-turbo";
  if (host.includes("api.openai.com")) return "gpt-4o-mini-transcribe";
  return "whisper-1";
}

function redactKey(text: string, key: string): string {
  return key && key.length >= 6 ? text.split(key).join("[redacted]") : text;
}

/**
 * OpenAI- or Anthropic-compatible client over an injected fetch. Runs the same
 * in the browser (direct, user's own key) and on the local companion.
 */
export function createLlmClient(endpoint: LlmEndpoint, options: { fetch: FetchLike; timeoutMs?: number; asrModel?: string }): LlmClient {
  const timeoutMs = options.timeoutMs ?? 60_000;
  const local = isLocalLlmUrl(endpoint.base_url);
  const base = endpoint.base_url.replace(/\/+$/, "");
  const key = endpoint.api_key || (local ? "local" : "");

  async function post(path: string, body: unknown, headers: Record<string, string>): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await options.fetch(`${base}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers, ...endpoint.default_headers },
        body: JSON.stringify(body),
        signal: controller.signal,
        redirect: "error",
      });
    } finally {
      clearTimeout(timer);
    }
  }

  function authFailure(status: number, model: string): never {
    throw new CoreError(`模型服务拒绝了请求（HTTP ${status}，${endpoint.service_name}/${model}）：检查设置里的 API Key`, "invalid");
  }

  return {
    local,
    runtime(tier: LlmTier = "standard"): LlmRuntimeInfo {
      return {
        provider: endpoint.provider_id,
        model: modelForTier(endpoint, tier),
        tier,
        source: endpoint.source,
        model_source: Object.keys(endpoint.models).length ? "provider_models" : "llm_model",
        is_local: endpoint.provider_id === "ollama",
      };
    },

    async chat(messages: LlmMessage[], chatOptions: LlmChatOptions = {}): Promise<string | null> {
      if (!messages.length) throw new CoreError("消息不能为空");
      const model = modelForTier(endpoint, chatOptions.tier ?? "standard");
      const maxTokens = chatOptions.maxTokens ?? 4096;
      try {
        if (endpoint.api_format === "anthropic") {
          const system = messages.filter((m) => m.role === "system").map((m) => m.content);
          const rest = messages.filter((m) => m.role !== "system").map((m) => ({ role: m.role, content: m.content }));
          if (chatOptions.jsonMode) rest.push({ role: "user", content: "Return JSON only." });
          const response = await post("/messages", {
            model,
            max_tokens: maxTokens,
            messages: rest,
            ...(system.length ? { system: system.join("\n\n") } : {}),
          }, { "x-api-key": key, "anthropic-version": "2023-06-01" });
          if (response.status === 401 || response.status === 403) authFailure(response.status, model);
          if (!response.ok) return null;
          const body = await response.json() as { content?: Array<{ type?: string; text?: string }> };
          const text = (body.content ?? []).filter((block) => block.type === "text").map((block) => block.text ?? "").join("");
          return text || null;
        }
        let sent = messages;
        const payload: Record<string, unknown> = {
          model,
          messages: sent,
          temperature: chatOptions.temperature ?? 0.3,
          max_tokens: maxTokens,
        };
        if (chatOptions.jsonMode && endpoint.supports_json_mode) {
          payload.response_format = { type: "json_object" };
          if (!sent.map((m) => m.content).join(" ").toLowerCase().includes("json")) {
            sent = [...sent.slice(0, -1), { ...sent[sent.length - 1], content: `${sent[sent.length - 1].content}\n\nReturn JSON only.` }];
            payload.messages = sent;
          }
        }
        for (let attempt = 0; attempt < 3; attempt += 1) {
          const response = await post("/chat/completions", payload, { Authorization: `Bearer ${key}` });
          if (response.status === 401 || response.status === 403) authFailure(response.status, model);
          if (response.ok) {
            const body = await response.json() as { choices?: Array<{ message?: { content?: unknown } }> };
            const content = body.choices?.[0]?.message?.content;
            return typeof content === "string" ? content : null;
          }
          const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
          if (!retryable || attempt === 2) return null;
          await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
        }
        return null;
      } catch (cause) {
        if (cause instanceof CoreError) throw cause;
        return null;
      }
    },

    async transcribe(audio: Blob, fileName: string): Promise<string> {
      if (endpoint.api_format === "anthropic") throw new CoreError(NO_ASR_HINT);
      const form = new FormData();
      form.append("model", options.asrModel || asrModel(base));
      form.append("file", audio, fileName);
      let response: Response;
      try {
        response = await options.fetch(`${base}/audio/transcriptions`, {
          method: "POST",
          headers: { Authorization: `Bearer ${key}`, ...endpoint.default_headers },
          body: form,
          redirect: "error",
        });
      } catch {
        throw new CoreError(NO_ASR_HINT);
      }
      if (!response.ok) throw new CoreError(NO_ASR_HINT);
      const body = await response.json().catch(() => ({})) as { text?: unknown };
      const text = typeof body.text === "string" ? body.text.trim() : "";
      if (!text) throw new CoreError("没有识别出文字，录音可能太短或没有声音");
      return text;
    },
  };
}

export type ProbeResult = { success: boolean; provider: string; model: string; message: string };

/** Port of llm_config_store.probe_llm_endpoint: one tiny real completion, errors kept readable and key-free. */
export async function probeLlmEndpoint(
  endpoint: Pick<LlmEndpoint, "base_url" | "api_key" | "model" | "provider_id" | "api_format" | "default_headers">,
  fetchImpl: FetchLike,
  timeoutMs = 15_000,
): Promise<ProbeResult> {
  const provider = endpoint.provider_id || "custom";
  const model = endpoint.model;
  const local = isLocalLlmUrl(endpoint.base_url);
  const key = endpoint.api_key || (local ? "local" : "");
  const fail = (message: string): ProbeResult => ({ success: false, provider, model, message });
  if (!key || PLACEHOLDER_API_KEYS.has(key.toLowerCase())) return fail("API Key 未配置或仍为占位符，请先填写有效的 API Key。");
  const base = endpoint.base_url.trim().replace(/\/+$/, "");
  if (!base) return fail("Base URL 未配置。");
  const anthropic = endpoint.api_format === "anthropic";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`${base}${anthropic ? "/messages" : "/chat/completions"}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(anthropic ? { "x-api-key": key, "anthropic-version": "2023-06-01" } : { Authorization: `Bearer ${key}` }),
        ...(endpoint.default_headers ?? {}),
      },
      body: JSON.stringify(anthropic
        ? { model, max_tokens: 5, messages: [{ role: "user", content: "Hi" }] }
        : { model, messages: [{ role: "user", content: "Hi" }], max_tokens: 5 }),
      signal: controller.signal,
      redirect: "error",
    });
    if (response.status === 200) {
      const body = await response.json().catch(() => ({})) as Record<string, any>;
      if (anthropic) {
        const text = Array.isArray(body.content) ? body.content.map((block: any) => String(block?.text ?? "")).join("").trim() : "";
        return text ? { success: true, provider, model, message: "连接成功，Anthropic 服务返回了文本。" } : fail("服务返回空文本。");
      }
      const content = body?.choices?.[0]?.message?.content;
      if (typeof content !== "string" || !content.trim()) return fail("服务返回了无效或空的文本响应。");
      const used = typeof body.model === "string" && body.model ? body.model : model;
      return { success: true, provider, model: used, message: `连接成功！模型 ${used} 可正常使用。` };
    }
    let message = "";
    const raw = await response.text().catch(() => "");
    try {
      const parsed = JSON.parse(raw) as Record<string, any>;
      message = String(parsed?.error?.message || parsed?.message || "");
    } catch {
      message = raw.slice(0, 200);
    }
    return fail(`API 返回错误 (${response.status}): ${redactKey(message, key).slice(0, 300)}`);
  } catch (cause) {
    const aborted = cause instanceof Error && cause.name === "AbortError";
    return fail(aborted ? `连接超时 (${base})，请检查网络或更换 Base URL。` : `无法连接到 ${base}，请检查 Base URL 是否正确以及网络是否畅通。`);
  } finally {
    clearTimeout(timer);
  }
}

export const PLACEHOLDER_API_KEYS = new Set([
  "sk-your-openai-key-here",
  "your-openai-api-key",
  "your-deepseek-api-key",
  "your-gemini-api-key",
  "your-api-key",
  "replace-with-your-api-key",
  "api-key-here",
  "sk-your-key",
]);

/** The host has no model configured: the same error the Python resolver raises. */
export function requireLlm(llm: LlmClient | null | undefined): LlmClient {
  if (!llm) throw new CoreError("还没有配置模型服务，请先在设置里添加一个。", "invalid");
  return llm;
}
