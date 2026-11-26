// Agent Run status is a closed state machine (packages/core/src/agent/run-state.ts RUN_TRANSITIONS).
// Each case replays a lifecycle bug this repo has already shipped and fixed by hand:
// a3efc049 / 030ffa2a (a cancelled run later recorded as failed or completed),
// 43a550b1 / 077f58af (terminal state overwritten by a stale snapshot).

import { afterEach, describe, expect, it } from "vitest";

import {
  AgentRunState,
  canTransitionRun,
  isTerminalRunStatus,
  createAgentRuntime,
  RUN_STATUSES,
  RUN_TRANSITIONS,
  type ChatRequest,
  type LlmClient,
  type LlmStreamEvent,
} from "@offeru/core";

import { SqliteAgentRunStore } from "../src/agent-store";
import { SqliteCoreStore } from "../src/store";

let stores: SqliteCoreStore[] = [];
afterEach(() => {
  for (const store of stores) store.close();
  stores = [];
});

function state() {
  const store = new SqliteCoreStore(":memory:");
  stores.push(store);
  return new AgentRunState(new SqliteAgentRunStore(store));
}

describe("run status transitions", () => {
  it("cancelled is final", () => {
    expect(RUN_TRANSITIONS.cancelled).toEqual([]);
    for (const to of RUN_STATUSES) if (to !== "cancelled") expect(canTransitionRun("cancelled", to)).toBe(false);
  });

  it("every active status can still reach a terminal status", () => {
    for (const from of RUN_STATUSES) {
      if (isTerminalRunStatus(from)) continue;
      expect(RUN_TRANSITIONS[from].some((to) => to === "completed" || to === "failed" || to === "cancelled")).toBe(true);
    }
  });

  it("a stale snapshot cannot turn a cancelled run into failed or completed", async () => {
    const runs = state();
    const created = await runs.createRun({ conversation_id: "", goal: "改简历", mode: "general" });
    const executing = await runs.saveRun({ ...created, status: "executing" });
    await runs.saveRun({ ...executing, status: "cancelled", failure_reason: "cancelled_by_user" });

    await expect(runs.saveRun({ ...executing, status: "failed", failure_reason: "AbortError" })).rejects.toThrow(/cancelled → failed/);
    await expect(runs.saveRun({ ...executing, status: "completed" })).rejects.toThrow(/cancelled → completed/);

    const stored = await runs.loadRun(created.id);
    expect(stored?.status).toBe("cancelled");
    expect(stored?.failure_reason).toBe("cancelled_by_user");
    const terminalEvents = (await runs.listEvents(created.id)).filter((event) => /^run\.(completed|failed|cancelled)$/.test(event.type));
    expect(terminalEvents.map((event) => event.type)).toEqual(["run.cancelled"]);
  });

  it("same-status saves still work after cancel (turn_finished bookkeeping)", async () => {
    const runs = state();
    const created = await runs.createRun({ conversation_id: "", goal: "x", mode: "general" });
    const cancelled = await runs.saveRun({ ...created, status: "cancelled" });
    const finished = await runs.saveRun({ ...cancelled, final_result: { turn_finished: true } });
    expect(finished.final_result.turn_finished).toBe(true);
  });
});

describe("host: cancel while the model is answering", () => {
  it("a turn that finishes after abortRun ends cancelled, not completed", async () => {
    const store = new SqliteCoreStore(":memory:");
    stores.push(store);
    const runs = new SqliteAgentRunStore(store);
    let agent: ReturnType<typeof createAgentRuntime>;
    const usage = { input_tokens: 1, output_tokens: 1, total_tokens: 2, estimated: false };
    const llm: LlmClient = {
      provider: "fake",
      model: "fake-1",
      async chat() { return null; },
      async *completeStream(_request: ChatRequest): AsyncIterable<LlmStreamEvent> {
        const [runId] = agent.activeRunIds();
        await agent.abortRun(runId);
        yield { type: "text_delta", text: "好的。" };
        yield { type: "done", result: { provider: "fake", model: "fake-1", content: "好的。", reasoning: "", toolCalls: [], finishReason: "stop", usage } };
      },
    };
    agent = createAgentRuntime({ store, runs, llm: () => llm });
    const result = await agent.conversationTurn({ message: "你好" });
    expect(result.run.status).toBe("cancelled");
  });
});
