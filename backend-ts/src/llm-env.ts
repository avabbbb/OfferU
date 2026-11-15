import { createOpenAiLlm, type FetchLike, type LlmClient } from "@offeru/core";

/**
 * Development fallback only (decision 2026-11-15): the real per-request model
 * comes from the config domain (ts/interview-config) via AppDeps.llm.
 *   OFFERU_LLM_BASE_URL, OFFERU_LLM_API_KEY, OFFERU_LLM_MODEL
 *   OFFERU_LLM_JSON_MODE=0 for providers that reject response_format.
 */
export function llmFromEnv(env: NodeJS.ProcessEnv = process.env): LlmClient | null {
  const baseUrl = env.OFFERU_LLM_BASE_URL?.trim();
  const model = env.OFFERU_LLM_MODEL?.trim();
  if (!baseUrl || !model) return null;
  return createOpenAiLlm({
    baseUrl,
    model,
    apiKey: env.OFFERU_LLM_API_KEY?.trim() || undefined,
    supportsJsonMode: env.OFFERU_LLM_JSON_MODE !== "0",
    fetch: globalThis.fetch.bind(globalThis) as unknown as FetchLike,
  });
}
