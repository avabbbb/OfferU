// Bind the registry tools as Agent loop tools: results go back to the model
// as JSON text; every failure (preflight, schema, business rule, upstream)
// comes back as {ok:false, error:{code, message, retryable, suggestedAction}}
// (tools/preflight.ts) instead of failing the run.

import type { LlmToolSpec } from "../llm";
import { classifyToolError, type ToolFailure } from "../tools/preflight";
import type { AgentTool } from "./loop";

export type ToolExecutor = (name: string, args: Record<string, unknown>) => Promise<unknown>;
export type ToolPreflight = (name: string, args: Record<string, unknown>) => Promise<ToolFailure | null>;

export function failureResult(failure: ToolFailure) {
  return { text: JSON.stringify(failure), isError: true, details: failure };
}

export function bindAgentTools(specs: LlmToolSpec[], execute: ToolExecutor, preflight?: ToolPreflight): AgentTool[] {
  return specs.map((spec) => ({
    ...spec,
    async execute(args) {
      const input = args && typeof args === "object" ? args : {};
      try {
        const blocked = await preflight?.(spec.name, input);
        if (blocked) return failureResult(blocked);
        const result = await execute(spec.name, input);
        return { text: JSON.stringify(result ?? null), isError: false };
      } catch (cause) {
        return failureResult(classifyToolError(cause, spec.name));
      }
    },
  }));
}
