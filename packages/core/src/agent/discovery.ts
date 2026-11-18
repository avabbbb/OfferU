// tool_manual: the built-in Agent's schema discovery (Flovart
// workflow.node.tool.list pattern). Read-only, touches no record, never
// counts as a write; the full text comes from the shared registry.

import { TOOL_MANUAL_SPEC, toolManual, type ToolSpec } from "../tools";
import type { AgentTool } from "./loop";
import { readSkill, SKILL_READ_SPEC } from "./skills";

export function toolManualTool(specs: () => ToolSpec[]): AgentTool {
  return {
    name: TOOL_MANUAL_SPEC.name,
    description: TOOL_MANUAL_SPEC.description,
    parameters: TOOL_MANUAL_SPEC.inputSchema as Record<string, unknown>,
    async execute(args) {
      const result = toolManual(specs(), args ?? {});
      return { text: JSON.stringify(result), isError: !result.ok, details: null };
    },
  };
}

/** skill_read: one skill's full method (agent/skills.ts). Read-only. */
export function skillReadTool(): AgentTool {
  return {
    ...SKILL_READ_SPEC,
    async execute(args) {
      const result = readSkill(args?.id);
      return { text: JSON.stringify(result), isError: !result.ok, details: null };
    },
  };
}
