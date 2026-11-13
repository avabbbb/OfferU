import { openAiCompatibleClient, type LlmClient } from "@offeru/core";

/**
 * Node companion's model, from env until the config domain ports Python's
 * config.json / secret-vault resolution (resolve_llm_client_config):
 *   OFFERU_LLM_BASE_URL, OFFERU_LLM_API_KEY, OFFERU_LLM_MODEL
 *   OFFERU_LLM_JSON_MODE=0 for providers that reject response_format.
 * Read per call so the process picks up a changed env-backed key without restart logic here.
 */
export function llmFromEnv(env: NodeJS.ProcessEnv = process.env): LlmClient | null {
  const baseUrl = env.OFFERU_LLM_BASE_URL?.trim();
  const model = env.OFFERU_LLM_MODEL?.trim();
  if (!baseUrl || !model) return null;
  return openAiCompatibleClient({
    baseUrl,
    model,
    apiKey: env.OFFERU_LLM_API_KEY?.trim() ?? "",
    supportsJsonMode: env.OFFERU_LLM_JSON_MODE !== "0",
  });
}
