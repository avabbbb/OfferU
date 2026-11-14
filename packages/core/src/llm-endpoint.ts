// A user-configured model endpoint (BYOK) turned into the shared LlmClient.
//
// The client itself is packages/core/src/llm.ts (`createOpenAiLlm`). This file
// adds what the settings domain needs on top of it:
//   - `LlmEndpoint`: one resolved provider entry from /api/config;
//   - `createConfiguredLlm`: endpoint -> LlmClient + runtime info (+ ASR);
//   - `probeLlmEndpoint`: POST /api/config/test-llm;
//   - `llmRuntime`: what the next call will use (Python get_llm_runtime_info).
// Hosts (browser vault, companion config file) resolve the endpoint and inject
// the client; the key never leaves the host except to the provider itself.

import { CoreError } from "./types";
import { createOpenAiLlm, isLocalLlmUrl, type FetchLike, type LlmChatOptions, type LlmClient, type LlmMessage, type LlmTier } from "./llm";

export type LlmApiFormat = "openai" | "anthropic";

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

/** What the next chat call will use; mirrors Python get_llm_runtime_info + is_local. */
export type LlmRuntimeInfo = {
  provider: string;
  model: string;
  tier: LlmTier;
  source: string;
  model_source: "provider_models" | "llm_model";
  is_local: boolean;
};

/** Full Fetch API (FormData bodies, Response.json); global fetch satisfies it. */
export type WebFetch = (input: string, init?: RequestInit) => Promise<Response>;

/** LlmClient built from settings: also reports its runtime and may transcribe audio. */
export interface ConfiguredLlm extends LlmClient {
  runtime(tier?: LlmTier): LlmRuntimeInfo;
  /** Speech to text through /audio/transcriptions; absent when the protocol has none. */
  transcribe?(audio: Blob, fileName: string): Promise<string>;
}

/** Python resolve_llm_client_config text when no model is configured. */
export const NO_MODEL_HINT = "还没有配置模型服务，请先在设置里添加一个。";

export const NO_ASR_HINT = "当前模型服务不支持语音转写。可以先用飞书妙记、通义听悟等工具转成文字，再粘贴进来。";

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

/** Port of resolve_model_for_tier for a resolved endpoint. */
export function modelForTier(endpoint: Pick<LlmEndpoint, "models" | "tier_model_map" | "model">, tier: LlmTier = "standard"): string {
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
 * Runtime of any client: a ConfiguredLlm reports its own; a bare LlmClient
 * (tests, other hosts) is described as well as it can be.
 */
export function llmRuntime(llm: LlmClient, tier: LlmTier = "standard"): LlmRuntimeInfo {
  const configured = (llm as Partial<ConfiguredLlm>).runtime;
  if (typeof configured === "function") return configured.call(llm, tier);
  return { provider: "custom", model: "", tier, source: "injected", model_source: "llm_model", is_local: Boolean(llm.local) };
}

/**
 * Minimal Anthropic Messages chat (non-streaming). TEMPORARY: ts/agent lands
 * Anthropic in llm.ts as a superset; switch to it then and delete this.
 */
function createAnthropicChat(endpoint: LlmEndpoint, fetchImpl: FetchLike, timeoutMs: number): LlmClient["chat"] {
  const base = endpoint.base_url.replace(/\/+$/, "");
  return async (messages: LlmMessage[], options: LlmChatOptions = {}) => {
    if (!messages.length) throw new CoreError("消息不能为空");
    const model = modelForTier(endpoint, options.tier ?? "standard");
    const system = messages.filter((m) => m.role === "system").map((m) => m.content);
    const rest = messages.filter((m) => m.role !== "system").map((m) => ({ role: m.role, content: m.content }));
    if (options.json) rest.push({ role: "user", content: "Return JSON only." });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const onAbort = () => controller.abort();
    options.signal?.addEventListener("abort", onAbort);
    try {
      const response = await fetchImpl(`${base}/messages`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": endpoint.api_key,
          "anthropic-version": "2023-06-01",
          ...endpoint.default_headers,
        },
        body: JSON.stringify({
          model,
          max_tokens: options.maxTokens ?? 4096,
          temperature: options.temperature ?? 0.3,
          messages: rest,
          ...(system.length ? { system: system.join("\n\n") } : {}),
        }),
        signal: controller.signal,
      });
      if (response.status === 401 || response.status === 403) {
        throw new CoreError(`模型 API Key 无效或没有权限（${model}，HTTP ${response.status}）；请在设置里检查 Key`, "forbidden");
      }
      if (!response.ok) return null;
      const body = JSON.parse(await response.text()) as { content?: Array<{ type?: string; text?: string }> };
      const text = (body.content ?? []).filter((block) => block.type === "text").map((block) => block.text ?? "").join("");
      return text || null;
    } catch (cause) {
      if (cause instanceof CoreError) throw cause;
      return null;
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
    }
  };
}

/** Build the client chat calls use from a resolved endpoint (OpenAI-compatible or Anthropic). */
export function createConfiguredLlm(endpoint: LlmEndpoint, options: { fetch: WebFetch; timeoutMs?: number; asrModel?: string }): ConfiguredLlm {
  const timeoutMs = options.timeoutMs ?? 120_000;
  const fetchImpl = options.fetch as unknown as FetchLike;
  const local = isLocalLlmUrl(endpoint.base_url);
  const key = endpoint.api_key || (local ? "local" : "");
  const base = endpoint.base_url.replace(/\/+$/, "");
  const models: Partial<Record<LlmTier, string>> = {};
  for (const tier of ["fast", "standard", "premium"] as const) models[tier] = modelForTier(endpoint, tier);

  const runtime = (tier: LlmTier = "standard"): LlmRuntimeInfo => ({
    provider: endpoint.provider_id,
    model: modelForTier(endpoint, tier),
    tier,
    source: endpoint.source,
    model_source: Object.keys(endpoint.models).length ? "provider_models" : "llm_model",
    is_local: endpoint.provider_id === "ollama",
  });

  if (endpoint.api_format === "anthropic") {
    return { local, runtime, chat: createAnthropicChat({ ...endpoint, api_key: key }, fetchImpl, timeoutMs) };
  }

  const client = createOpenAiLlm({
    baseUrl: base,
    apiKey: key,
    model: endpoint.model,
    models,
    supportsJsonMode: endpoint.supports_json_mode,
    timeoutMs,
    fetch: fetchImpl,
    extraHeaders: endpoint.default_headers,
  });

  return {
    local: client.local,
    runtime,
    chat: (messages, chatOptions) => client.chat(messages, chatOptions),
    chatStream: client.chatStream ? (messages, chatOptions) => client.chatStream!(messages, chatOptions) : undefined,
    async transcribe(audio: Blob, fileName: string): Promise<string> {
      const form = new FormData();
      form.append("model", options.asrModel || asrModel(base));
      form.append("file", audio, fileName);
      let response: Response;
      try {
        response = await options.fetch(`${base}/audio/transcriptions`, {
          method: "POST",
          headers: { Authorization: `Bearer ${key}`, ...endpoint.default_headers },
          body: form,
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
  fetchImpl: WebFetch,
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
