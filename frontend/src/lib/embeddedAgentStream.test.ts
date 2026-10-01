import { describe, expect, it } from "vitest";
import { applyRuntimeToolEvent, createInitialAgentStreamState } from "./embeddedAgentStream";

describe("migrated tool stream", () => {
  it("keeps each call distinct and preserves failure on completion", () => {
    let state = createInitialAgentStreamState();
    const payload = { tool_call_id: "call-1", operation: "list_jobs" };
    state = applyRuntimeToolEvent(state, "tool.started", { payload });
    state = applyRuntimeToolEvent(state, "tool.completed", { payload: { ...payload, is_error: true } });
    state = applyRuntimeToolEvent(state, "tool.started", { payload: { ...payload, tool_call_id: "call-2" } });
    expect(state.toolExecutions["call-1"].status).toBe("error");
    expect(state.toolExecutions["call-2"].status).toBe("running");
  });

  it("ignores governance events without inventing duplicate model calls", () => {
    const state = createInitialAgentStreamState();
    expect(applyRuntimeToolEvent(state, "operation.started", { payload: { operation: "list_jobs" } })).toBe(state);
  });
});
