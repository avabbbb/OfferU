import { describe, expect, it } from "vitest";
import { contextUsageFromEvent } from "./agentContextUsage";

describe("contextUsageFromEvent", () => {
  it("reads context_usage from a turn event payload", () => {
    expect(contextUsageFromEvent({ payload: { context_usage: { used: 9000, window: 64000, compact_at: 56000, estimated: false } } }))
      .toEqual({ used: 9000, window: 64000, compactAt: 56000, estimated: false });
  });
  it("returns null when the event carries no usage", () => {
    expect(contextUsageFromEvent({ payload: { operation: "jobs.list" } })).toBeNull();
    expect(contextUsageFromEvent(null)).toBeNull();
  });
  it("rejects nonsense numbers instead of inventing them", () => {
    expect(contextUsageFromEvent({ payload: { context_usage: { used: "x", window: 64000 } } })).toBeNull();
    expect(contextUsageFromEvent({ payload: { context_usage: { used: 10, window: 0 } } })).toBeNull();
  });
  it("treats missing estimated flag as estimated and falls back compactAt to window", () => {
    expect(contextUsageFromEvent({ payload: { context_usage: { used: 10, window: 100 } } }))
      .toEqual({ used: 10, window: 100, compactAt: 100, estimated: true });
  });
});
