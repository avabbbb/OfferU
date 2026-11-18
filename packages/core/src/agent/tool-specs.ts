// Tool specs the built-in Agent shows the model, derived from the shared
// registry (tools/specs.ts TOOL_SPECS). One source: HTTP /api/tools, MCP, CLI
// and the Agent list the same names and validate against the same JSON
// schemas. The Agent gets the progressive form each turn (tools/catalog.ts:
// one-line brief + slim schema) and reads the full manual with tool_manual.

import type { LlmToolSpec } from "../llm";
import { AGENT_TOOL_SPECS, slimSchema, toolBrief, type ToolSpec } from "../tools";

/** Full registry specs the Agent can be given (manual source for tool_manual). */
export const AGENT_REGISTRY_SPECS: ToolSpec[] = AGENT_TOOL_SPECS;

/** What the model sees every turn: brief + slim schema. */
export const CORE_TOOL_SPECS: LlmToolSpec[] = AGENT_TOOL_SPECS.map((spec) => ({
  name: spec.name,
  description: toolBrief(spec),
  parameters: slimSchema(spec.inputSchema) as Record<string, unknown>,
}));

export function coreToolSpecs(names: readonly string[]): LlmToolSpec[] {
  const wanted = new Set(names);
  return CORE_TOOL_SPECS.filter((spec) => wanted.has(spec.name));
}

export function registrySpecs(names: readonly string[]): ToolSpec[] {
  const wanted = new Set(names);
  return AGENT_REGISTRY_SPECS.filter((spec) => wanted.has(spec.name));
}
