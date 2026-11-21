// Bind the record tools (core TOOLS) as Agent loop tools — port of
// backend/app/core/agent.py loop_tools / execute: results go back to the
// model as JSON text; validation / business errors become "ERROR: ..." text
// instead of failing the run.

import type { ToolSpec } from "../llm";
import { isCoreError } from "../types";
import type { AgentTool } from "./loop";

export type ToolExecutor = (name: string, args: Record<string, unknown>) => Promise<unknown>;

export function bindAgentTools(specs: ToolSpec[], execute: ToolExecutor): AgentTool[] {
  return specs.map((spec) => ({
    ...spec,
    async execute(args) {
      try {
        const result = await execute(spec.name, args && typeof args === "object" ? args : {});
        return { text: JSON.stringify(result ?? null), isError: false };
      } catch (cause) {
        if (isCoreError(cause) || cause instanceof TypeError || cause instanceof RangeError) {
          return { text: `ERROR: ${(cause as Error).message}`, isError: true };
        }
        throw cause;
      }
    },
  }));
}
