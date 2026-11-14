import { createLlmClient, type LlmClient } from "@offeru/core";

/**
 * Dev fallback only: the companion's model from env until ts/interview-config
 * resolves it from the user's saved config (AppDeps.llm per request).
 *   OFFERU_LLM_BASE_URL, OFFERU_LLM_API_KEY, OFFERU_LLM_MODEL
 *   OFFERU_LLM_FORMAT=anthropic for the Anthropic Messages API
 *   OFFERU_LLM_JSON_MODE=0 for providers that reject response_format.
 */
export function llmFromEnv(env: NodeJS.ProcessEnv = process.env): LlmClient | null {
  const baseUrl = env.OFFERU_LLM_BASE_URL?.trim();
  const model = env.OFFERU_LLM_MODEL?.trim();
  if (!baseUrl || !model) return null;
  return createLlmClient({
    provider: "custom",
    baseUrl,
    model,
    apiKey: env.OFFERU_LLM_API_KEY?.trim() ?? "",
    apiFormat: env.OFFERU_LLM_FORMAT === "anthropic" ? "anthropic" : "openai",
    supportsJsonMode: env.OFFERU_LLM_JSON_MODE !== "0",
  }, { fetch: globalThis.fetch as never });
}
