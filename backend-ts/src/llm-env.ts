import { createOpenAiLlm, type LlmClient } from "@offeru/core";

/**
 * DEV FALLBACK ONLY. The real model comes from the user's saved config through AppDeps.llm (config domain:
 * /api/config, key in the local data dir / IndexedDB). This reads OFFERU_LLM_BASE_URL / OFFERU_LLM_API_KEY /
 * OFFERU_LLM_MODEL so a developer can try tailor/impact before that lands; null when unset (= "没配模型").
 * Never used on the web or the Worker.
 */
export function devLlmFromEnv(env: Record<string, string | undefined> = process.env): LlmClient | null {
  const baseUrl = env.OFFERU_LLM_BASE_URL?.trim();
  const model = env.OFFERU_LLM_MODEL?.trim();
  if (!baseUrl || !model) return null;
  return createOpenAiLlm({ baseUrl, model, apiKey: env.OFFERU_LLM_API_KEY?.trim(), fetch: (url, init) => fetch(url, init) });
}
