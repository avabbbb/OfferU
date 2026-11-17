// What the interview / settings domains need on top of the shared LlmClient:
// the "no model" hints, the runtime description of the next call (Python
// get_llm_runtime_info) and optional speech-to-text. Hosts build the client
// (ConfigRuntime in backend-ts) and attach `runtime` / `transcribe` with
// `configureLlm`; the key never leaves the host except to the provider.

import { CoreError } from "./types";
import type { LlmClient, LlmTier } from "./llm";
import { resolveLlmClientConfig, resolveModelForTier, type LlmSettings, type ResolveOptions } from "./llm-config";

/** What the next chat call will use; mirrors Python get_llm_runtime_info + is_local. */
export type LlmRuntimeInfo = {
  provider: string;
  model: string;
  tier: LlmTier;
  source: string;
  model_source: "provider_models" | "llm_model";
  is_local: boolean;
};

/** LlmClient built from settings: also reports its runtime and may transcribe audio. */
export interface ConfiguredLlm extends LlmClient {
  runtime(tier?: LlmTier): LlmRuntimeInfo;
  /** Speech to text through /audio/transcriptions; absent when the protocol has none. */
  transcribe?(audio: Blob, fileName: string): Promise<string>;
}

/** Full Fetch API (FormData bodies, Response.json); global fetch satisfies it. */
export type WebFetch = (input: string, init?: RequestInit) => Promise<Response>;

/** Python resolve_llm_client_config text when no model is configured. */
export const NO_MODEL_HINT = "还没有配置模型服务，请先在设置里添加一个。";

export const NO_ASR_HINT = "当前模型服务不支持语音转写。可以先用飞书妙记、通义听悟等工具转成文字，再粘贴进来。";

export function asrModel(baseUrl: string): string {
  const host = baseUrl.toLowerCase();
  if (host.includes("siliconflow")) return "FunAudioLLM/SenseVoiceSmall";
  if (host.includes("groq")) return "whisper-large-v3-turbo";
  if (host.includes("api.openai.com")) return "gpt-4o-mini-transcribe";
  return "whisper-1";
}

/**
 * Runtime of any client: a ConfiguredLlm reports its own; a bare LlmClient
 * (tests, other hosts) is described from its provider/model fields.
 */
export function llmRuntime(llm: LlmClient, tier: LlmTier = "standard"): LlmRuntimeInfo {
  const configured = (llm as Partial<ConfiguredLlm>).runtime;
  if (typeof configured === "function") return configured.call(llm, tier);
  const bare = llm as LlmClient & { provider?: string; model?: string };
  return { provider: bare.provider || "custom", model: bare.model || "", tier, source: "injected", model_source: "llm_model", is_local: Boolean(llm.local) };
}

/**
 * Attach `runtime()` and (OpenAI-format endpoints) `transcribe()` to a client
 * built from the same settings. Mutates and returns the client.
 */
export function configureLlm<T extends LlmClient>(
  client: T,
  settings: LlmSettings,
  options: { fetch: WebFetch; asrModel?: string } & ResolveOptions,
): T & ConfiguredLlm {
  const resolveOptions: ResolveOptions = { llmConfigId: options.llmConfigId, env: options.env };
  const resolved = resolveLlmClientConfig(settings, resolveOptions);
  const configs = Array.isArray(settings.llm_api_configs) ? settings.llm_api_configs : [];
  const active = configs.find((item) => item && String(item.id || "") === (options.llmConfigId || settings.active_llm_config_id))
    ?? configs.find((item) => item?.is_active);
  const hasProviderModels = Boolean(active?.models && Object.keys(active.models).length);
  const base = resolved.base_url.replace(/\/+$/, "");
  const configured = Object.assign(client, {
    runtime: (tier: LlmTier = "standard"): LlmRuntimeInfo => ({
      provider: resolved.provider,
      model: resolveModelForTier(settings, tier, resolveOptions) || resolved.model,
      tier,
      source: resolved.source,
      model_source: hasProviderModels ? "provider_models" : "llm_model",
      is_local: resolved.provider === "ollama",
    }),
  }) as T & ConfiguredLlm;
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
