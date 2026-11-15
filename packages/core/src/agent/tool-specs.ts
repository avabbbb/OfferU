// Tool specs the built-in Agent shows the model, derived from the shared
// registry (tools/specs.ts TOOL_SPECS, generated from Python
// backend/app/core/tools.py TOOLS). One source: HTTP /api/tools, MCP, CLI and
// the Agent list the same names, descriptions and JSON schemas.

import type { LlmToolSpec } from "../llm";
import { AGENT_TOOL_SPECS } from "../tools";

export const CORE_TOOL_SPECS: LlmToolSpec[] = AGENT_TOOL_SPECS.map((spec) => ({
  name: spec.name,
  description: spec.description,
  parameters: spec.inputSchema as Record<string, unknown>,
}));

export function coreToolSpecs(names: readonly string[]): LlmToolSpec[] {
  const wanted = new Set(names);
  return CORE_TOOL_SPECS.filter((spec) => wanted.has(spec.name));
}
