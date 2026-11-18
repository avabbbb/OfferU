// Reasoning effort per provider / model: which levels a model accepts and how
// each level goes into the request body.
// Copy-adapted from avabbbb/Flovart@28c79bf:services/agentThinking.ts (MIT)
// (reasoningFormatFor / buildReasoningParams / THINKING_BUDGET_TOKENS) and
// components/agent/AgentModelPicker.tsx (supportedThinkingLevels).
// OfferU differences: levels are decided here (backend) and served by
// GET /api/agent/runtime/models, so the composer never hard-codes them; the
// "known non-reasoning model" table replaces Flovart's per-browser
// unsupported list (the provider-rejection retry in llm.ts still covers the rest).

import type { LlmApiFormat } from "./llm";
import { providerPreset } from "./llm-presets";

export type ReasoningEffort = "" | "minimal" | "low" | "medium" | "high";
export type ReasoningLevel = Exclude<ReasoningEffort, "">;
export const REASONING_EFFORTS: readonly ReasoningEffort[] = ["", "minimal", "low", "medium", "high"];
const LEVELS: readonly ReasoningLevel[] = ["minimal", "low", "medium", "high"];

export function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return typeof value === "string" && (REASONING_EFFORTS as readonly string[]).includes(value);
}

/** Anthropic / Qwen budget-style providers: the budget must stay below max_tokens (8192 default here). */
export const THINKING_BUDGET_TOKENS: Record<ReasoningLevel, number> = {
  minimal: 1024,
  low: 2048,
  medium: 4096,
  high: 6144,
};

export type ReasoningBodyFormat = "openai" | "openrouter" | "anthropic" | "qwen";

export interface ReasoningTarget {
  provider: string;
  baseUrl?: string;
  apiFormat?: LlmApiFormat | string;
  model: string;
}

export function reasoningFormatFor(target: Pick<ReasoningTarget, "provider" | "baseUrl" | "apiFormat">): ReasoningBodyFormat {
  const url = String(target.baseUrl || "").toLowerCase();
  const provider = String(target.provider || "").toLowerCase();
  if (target.apiFormat === "anthropic" || provider === "anthropic" || url.includes("api.anthropic.com")) return "anthropic";
  if (provider === "openrouter" || url.includes("openrouter.ai")) return "openrouter";
  if (provider === "qwen" || url.includes("dashscope")) return "qwen";
  return "openai";
}

/**
 * Models known to reject or ignore every reasoning parameter (chat-only
 * models of the bundled presets). Matching is on the bare model id, so a
 * gateway prefix like "openai/gpt-4.1" still matches.
 */
const NON_REASONING_MODELS: RegExp[] = [
  /^gpt-4(\.1|o)?(-mini|-nano)?(-\d{4}-\d{2}-\d{2})?$/i,
  /^gpt-3\.5/i,
  /^deepseek-(chat|v4-flash)$/i,
  /^qwen-(turbo|flash|long)$/i,
  /^glm-4(-flash|-air)?$/i,
  /^gemini-1\.5/i,
];

function bareModel(model: string): string {
  const trimmed = model.trim();
  const slash = trimmed.lastIndexOf("/");
  return slash >= 0 ? trimmed.slice(slash + 1) : trimmed;
}

/** Levels the composer offers for this model; [] means "no thinking control". */
export function reasoningLevelsFor(target: ReasoningTarget): ReasoningLevel[] {
  const model = bareModel(target.model);
  if (!model || NON_REASONING_MODELS.some((pattern) => pattern.test(model))) return [];
  const format = reasoningFormatFor(target);
  // Anthropic extended thinking needs the thinking blocks replayed on every
  // tool turn; the Agent session does not keep them, so no control there.
  if (format === "anthropic") return [];
  // "minimal" is only accepted by OpenAI itself and OpenRouter; elsewhere it would be downgraded.
  const acceptsMinimal = String(target.provider).toLowerCase() === "openai" || format === "openrouter";
  return LEVELS.filter((level) => level !== "minimal" || acceptsMinimal);
}

export const REASONING_LEVEL_COPY: Record<ReasoningLevel, { label: string; hint: string }> = {
  minimal: { label: "极简", hint: "几乎不思考，最快" },
  low: { label: "低", hint: "更快" },
  medium: { label: "中", hint: "多数任务" },
  high: { label: "高", hint: "想得更深" },
};

/**
 * Effort → request body fields of an OpenAI-compatible /chat/completions call.
 * "" sends nothing. The anthropic branch serves Anthropic's OpenAI-compatible
 * endpoint; thinking there forbids a custom temperature (dropTemperature).
 */
export function buildReasoningParams(
  effort: ReasoningEffort,
  target: Pick<ReasoningTarget, "provider" | "baseUrl" | "apiFormat">,
): { params: Record<string, unknown>; dropTemperature: boolean } {
  if (!effort) return { params: {}, dropTemperature: false };
  const format = reasoningFormatFor(target);
  const acceptsMinimal = String(target.provider).toLowerCase() === "openai" || format === "openrouter";
  const level: ReasoningLevel = effort === "minimal" && !acceptsMinimal ? "low" : effort;
  switch (format) {
    case "openrouter":
      return { params: { reasoning: { effort: level } }, dropTemperature: false };
    case "anthropic":
      return { params: { thinking: { type: "enabled", budget_tokens: THINKING_BUDGET_TOKENS[level] } }, dropTemperature: true };
    case "qwen":
      return { params: { enable_thinking: true, thinking_budget: THINKING_BUDGET_TOKENS[level] }, dropTemperature: false };
    default:
      return { params: { reasoning_effort: level }, dropTemperature: false };
  }
}

// ---- the composer's model catalog (GET /api/agent/runtime/models) ----

export interface ModelCatalogLevel { id: ReasoningLevel; label: string; hint: string }
export interface ModelCatalogModel { id: string; name: string; efforts: ModelCatalogLevel[] }
export interface ModelCatalogService {
  config_id: string;
  service_name: string;
  provider_id: string;
  active: boolean;
  /** The model this service uses when the composer picks no model. */
  default_model: string;
  models: ModelCatalogModel[];
}

interface CatalogConfigLike {
  id?: unknown;
  provider_id?: unknown;
  service_name?: unknown;
  base_url?: unknown;
  api_format?: unknown;
  model?: unknown;
  models?: unknown;
  is_active?: unknown;
}

/**
 * Every configured service with the models it can run and, per model, the
 * reasoning levels to offer. Models = the configured one, its tier models and
 * the bundled preset list for its provider (in that order, de-duplicated).
 */
export function llmModelCatalog(
  settings: { llm_api_configs?: unknown; active_llm_config_id?: unknown },
  presetModels: (providerId: string) => Array<{ id: string; name: string }> = (providerId) => providerPreset(providerId)?.models ?? [],
): ModelCatalogService[] {
  const configs = Array.isArray(settings.llm_api_configs) ? settings.llm_api_configs as CatalogConfigLike[] : [];
  const activeId = String(settings.active_llm_config_id || "");
  return configs.filter((item) => item && typeof item === "object" && item.id).map((item) => {
    const provider = String(item.provider_id || "");
    const target = { provider, baseUrl: String(item.base_url || ""), apiFormat: String(item.api_format || "openai") };
    const presets = presetModels(provider);
    const presetName = new Map(presets.map((preset) => [preset.id, preset.name]));
    const names = new Map<string, string>();
    const add = (id: unknown) => {
      const model = String(id || "").trim();
      if (model && !names.has(model)) names.set(model, presetName.get(model) || model);
    };
    add(item.model);
    if (item.models && typeof item.models === "object") for (const value of Object.values(item.models as Record<string, unknown>)) add(value);
    for (const preset of presets) add(preset.id);
    const id = String(item.id);
    return {
      config_id: id,
      service_name: String(item.service_name || provider || "模型"),
      provider_id: provider,
      active: id === activeId || Boolean(item.is_active),
      default_model: String(item.model || ""),
      models: [...names].map(([model, name]) => ({
        id: model,
        name,
        efforts: reasoningLevelsFor({ ...target, model }).map((level) => ({ id: level, ...REASONING_LEVEL_COPY[level] })),
      })),
    };
  });
}
