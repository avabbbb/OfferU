import { createOpenAiLlm, type LlmClient } from "@offeru/core";

/**
 * Companion model from the environment until the settings domain owns LLM config:
 * OFFERU_LLM_BASE_URL (OpenAI-compatible, e.g. https://api.deepseek.com/v1), OFFERU_LLM_API_KEY, OFFERU_LLM_MODEL.
 * Returns null when not configured; routes then answer "还没有配置模型服务".
 */
export function llmFromEnv(env: Record<string, string | undefined> = process.env): LlmClient | null {
  const baseUrl = env.OFFERU_LLM_BASE_URL;
  const model = env.OFFERU_LLM_MODEL;
  if (!baseUrl || !model) return null;
  return createOpenAiLlm({ baseUrl, model, apiKey: env.OFFERU_LLM_API_KEY, fetch: (url, init) => fetch(url, init) });
}
