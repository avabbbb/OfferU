// Context window per model for the built-in Agent: how many tokens one request
// (system prompt + tools + session) may use before compaction kicks in.
//
// The default is 256K (262144). It can be set globally (config
// `agent_context_window`) or per service (`llm_api_configs[].context_window`),
// and is always capped at the model's real limit when OfferU knows it, so a
// 256K default never overflows a 128K / 32K / 8K model. Unknown models get the
// configured value unchanged (the provider's overflow error still triggers one
// aggressive compaction + retry in agent/loop.ts).

export const DEFAULT_CONTEXT_WINDOW_TOKENS = 262_144;
/** Accepted range for a configured window; out of range = not configured. */
export const MIN_CONTEXT_WINDOW_TOKENS = 4_096;
export const MAX_CONTEXT_WINDOW_TOKENS = 2_097_152;

/**
 * Known limits (total context, input + output), matched on the bare model id
 * (lower-cased, gateway prefix like "openai/" or "Qwen/" removed). First match
 * wins, so specific patterns come before family patterns. Sources: provider
 * model pages, checked 2026-11-19 (see docs/DESIGN.md §8).
 */
export const KNOWN_CONTEXT_LIMITS: ReadonlyArray<readonly [RegExp, number]> = [
  // DeepSeek V4 / V4.1 (official API and SiliconFlow): 1M.
  [/^deepseek-(v4|flash)/, 1_048_576],
  // DeepSeek V3.x on SiliconFlow: 160K.
  [/^deepseek-v3/, 163_840],
  // Legacy DeepSeek aliases (deprecated 2026-07-24): the V3.2 window, conservative.
  [/^deepseek-(chat|reasoner)$/, 131_072],
  // OpenAI
  [/^gpt-4\.1/, 1_047_576],
  [/^gpt-4o/, 128_000],
  [/^gpt-3\.5/, 16_385],
  // Qwen (DashScope / Model Studio): Qwen3.5+ hosted and qwen-flash are 1M.
  [/^qwen3\.[5-9]-(plus|flash|max)/, 1_000_000],
  [/^qwen-flash/, 1_000_000],
  [/^qwen3-32b$/, 131_072],
  // Zhipu / Z.ai
  [/^glm-5/, 200_000],
  [/^glm-4\.6/, 200_000],
  [/^glm-4\.5/, 131_072],
  [/^glm-4-plus$/, 128_000],
  // Google
  [/^gemini-2\.5/, 1_048_576],
  // Moonshot: the K2 series is 256K; moonshot-v1-<n>k says it in the name.
  [/^kimi-k2/, 262_144],
  [/^moonshot-v1-8k/, 8_192],
  [/^moonshot-v1-32k/, 32_768],
  [/^moonshot-v1-128k/, 131_072],
  // Anthropic
  [/^claude-/, 200_000],
  // Llama 3.1 / 3.3 (Groq, OpenRouter) and Ollama tags.
  [/^llama-3\.[13]-/, 131_072],
  [/^llama3\.[13](:|$)/, 131_072],
  [/^qwen2\.5(:|$)/, 32_768],
  [/^gemma2(:|$)/, 8_192],
];

function bareModel(model: string): string {
  const trimmed = String(model || "").trim().toLowerCase();
  const slash = trimmed.lastIndexOf("/");
  return slash >= 0 ? trimmed.slice(slash + 1) : trimmed;
}

/** The model's real context limit when OfferU knows it; null = unknown. */
export function modelContextLimit(model: string): number | null {
  const bare = bareModel(model);
  if (!bare) return null;
  for (const [pattern, limit] of KNOWN_CONTEXT_LIMITS) if (pattern.test(bare)) return limit;
  return null;
}

/** A configured window: an integer in range, else 0 (= not configured). */
export function normalizeContextWindow(value: unknown): number {
  const number = Math.trunc(Number(value));
  return Number.isFinite(number) && number >= MIN_CONTEXT_WINDOW_TOKENS && number <= MAX_CONTEXT_WINDOW_TOKENS ? number : 0;
}

export interface ContextWindow {
  /** Window the Agent uses: min(configured or default, model limit). */
  tokens: number;
  /** What was asked for (configured value, or the 256K default). */
  requested: number;
  /** The model's known limit, null when unknown. */
  limit: number | null;
  /** true when the model limit cut the requested window. */
  capped: boolean;
}

/**
 * Pick the window for one model. `configured` values are tried in order
 * (per-service, then global); the first valid one wins over the default.
 */
export function resolveContextWindow(input: { model: string; configured?: unknown[] }): ContextWindow {
  const requested = (input.configured ?? []).map(normalizeContextWindow).find((value) => value > 0) || DEFAULT_CONTEXT_WINDOW_TOKENS;
  const limit = modelContextLimit(input.model);
  const tokens = limit ? Math.min(requested, limit) : requested;
  return { tokens, requested, limit, capped: tokens < requested };
}

interface ContextSettingsLike {
  llm_api_configs?: unknown;
  active_llm_config_id?: unknown;
  agent_context_window?: unknown;
}

/**
 * The window a run uses in these settings: the service's own `context_window`
 * (the picked llm_config_id, else the active service), then the global
 * `agent_context_window`, then 256K — capped at the model's known limit.
 */
export function agentContextWindow(settings: ContextSettingsLike | null | undefined, model: string, llmConfigId = ""): ContextWindow {
  const configs = Array.isArray(settings?.llm_api_configs) ? settings.llm_api_configs as Array<Record<string, unknown>> : [];
  const wanted = llmConfigId || String(settings?.active_llm_config_id || "");
  const service = configs.find((item) => item && String(item.id || "") === wanted)
    ?? configs.find((item) => item && item.is_active)
    ?? (llmConfigId ? undefined : configs[0]);
  return resolveContextWindow({ model, configured: [service?.context_window, settings?.agent_context_window] });
}
