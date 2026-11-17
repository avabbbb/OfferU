// The user's saved model config (BYOK) turned into the shared LlmClient.
//
// Resolution is llm-config.ts (port of resolve_llm_client_config, with the
// per-run llm_config_id) and the client is llm.ts createLlmClient. This file
// adds what the settings / interview domains need on top:
//   - `createConfiguredLlm`: settings -> LlmClient + runtime info (+ ASR);
//   - `probeLlmEndpoint`: POST /api/config/test-llm;
//   - `llmRuntime`: what the next call will use (Python get_llm_runtime_info).
// Hosts (browser vault, companion config file) own the settings and inject
// the client; the key never leaves the host except to the provider itself.

import { CoreError } from "./types";
import { createLlmClient, type FetchLike, type LlmApiFormat, type LlmClient, type LlmTier } from "./llm";
import { endpointFromSettings, resolveLlmClientConfig, resolveModelForTier, type LlmSettings, type ResolveOptions } from "./llm-config";

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

export type ProbeTarget = {
  base_url: string;
  api_key: string;
  model: string;
  provider_id: string;
  api_format: LlmApiFormat;
  default_headers?: Record<string, string>;
};

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
 * (tests, other hosts) is described from its provider/model fields.
 */
export function llmRuntime(llm: LlmClient, tier: LlmTier = "standard"): LlmRuntimeInfo {
  const configured = (llm as Partial<ConfiguredLlm>).runtime;
  if (typeof configured === "function") return configured.call(llm, tier);
  return { provider: llm.provider || "custom", model: llm.model || "", tier, source: "injected", model_source: "llm_model", is_local: Boolean(llm.local) };
}

/**
 * Build the client from saved settings (active entry, or `llmConfigId` for an
 * Agent run's per-run choice). Throws CoreError when the chosen entry is
 * incomplete or disabled, like Python resolve_llm_client_config.
 */
export function createConfiguredLlm(
  settings: LlmSettings,
  options: { fetch: WebFetch; timeoutMs?: number; asrModel?: string; llmConfigId?: string; env?: ResolveOptions["env"] },
): ConfiguredLlm {
  const resolveOptions: ResolveOptions = { llmConfigId: options.llmConfigId, env: options.env };
  const resolved = resolveLlmClientConfig(settings, resolveOptions);
  const endpoint = endpointFromSettings(settings, "standard", resolveOptions);
  const client = createLlmClient(endpoint, { fetch: options.fetch as unknown as FetchLike, timeoutMs: options.timeoutMs });
  const active = (settings.llm_api_configs ?? []).find((item) => item && String(item.id || "") === (options.llmConfigId || settings.active_llm_config_id))
    ?? (settings.llm_api_configs ?? []).find((item) => item?.is_active);
  const hasProviderModels = Boolean(active?.models && Object.keys(active.models).length);
  const base = resolved.base_url.replace(/\/+$/, "");
  const runtime = (tier: LlmTier = "standard"): LlmRuntimeInfo => ({
    provider: resolved.provider,
    model: resolveModelForTier(settings, tier, resolveOptions) || resolved.model,
    tier,
    source: resolved.source,
    model_source: hasProviderModels ? "provider_models" : "llm_model",
    is_local: resolved.provider === "ollama",
  });
  const configured: ConfiguredLlm = Object.assign(client, { runtime });
  if (resolved.api_format === "openai") {
    configured.transcribe = async (audio: Blob, fileName: string): Promise<string> => {
      const form = new FormData();
      form.append("model", options.asrModel || asrModel(base));
      form.append("file", audio, fileName);
      let response: Response;
      try {
        response = await options.fetch(`${base}/audio/transcriptions`, {
          method: "POST",
          headers: { Authorization: `Bearer ${resolved.api_key}`, ...resolved.default_headers },
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
    };
  }
  return configured;
}

export type ProbeResult = { success: boolean; provider: string; model: string; message: string };

/** Port of llm_config_store.probe_llm_endpoint: one tiny real completion, errors kept readable and key-free. */
export async function probeLlmEndpoint(
  endpoint: ProbeTarget,
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
