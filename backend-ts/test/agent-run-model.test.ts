// Model-based test of the Agent Run lifecycle. fast-check generates interleavings of
// start / model reply / Ask / model error / cancel (before or during the reply) / answer
// (incl. a duplicate answer) / process restart / resume against the real AgentHost on
// SQLite, and checks the run's invariants after every step.
//
// Replays the bug class of a3efc049, 030ffa2a, 43a550b1, 077f58af, 315754f8:
// a cancelled run later written as failed/completed, a terminal event emitted twice,
// a run left "executing" after a restart, one answer continuing a run twice.
// Seed and path are printed on failure; rerun with FC_SEED / FC_PATH to replay.

import fc from "fast-check";
import { afterEach, describe, expect, it } from "vitest";

import {
  createAgentRuntime,
  type AgentRunEvent,
  type ChatRequest,
  type LlmClient,
  type LlmStreamEvent,
  type ParsedToolCall,
} from "@offeru/core";

import { SqliteAgentRunStore } from "../src/agent-store";
import { SqliteCoreStore } from "../src/store";

type Agent = ReturnType<typeof createAgentRuntime>;
type Reply = { kind: "aborted" } | { kind: "text" } | { kind: "ask" } | { kind: "error" } | { kind: "cancel_then_text" } | { kind: "die" };

const ACTIONS = ["start", "reply", "ask", "error", "cancel", "cancel_during_reply", "answer", "answer_twice", "restart", "resume"] as const;
type Action = (typeof ACTIONS)[number];

const usage = { input_tokens: 1, output_tokens: 1, total_tokens: 2, estimated: false };
const GUARD = { firstByteMs: 600_000, idleMs: 600_000, retries: 0, backoffMs: [0] };
const TERMINAL = new Set(["run.completed", "run.failed", "run.cancelled"]);

/** An LLM whose every call waits until the test decides what it returns. */
class ScriptedLlm {
  pending: Array<(reply: Reply) => void> = [];
  agent!: Agent;

  client(): LlmClient {
    const self = this;
    return {
      provider: "fake",
      model: "fake-1",
      async chat() { return null; },
      async *completeStream(request: ChatRequest): AsyncIterable<LlmStreamEvent> {
        const reply = await new Promise<Reply>((resolve) => {
          self.pending.push(resolve);
          request.signal?.addEventListener("abort", () => resolve({ kind: "aborted" }));
        });
        if (reply.kind === "die") return new Promise<never>(() => undefined) as never;
        if (reply.kind === "aborted") throw Object.assign(new Error("This operation was aborted"), { name: "AbortError" });
        if (reply.kind === "cancel_then_text") {
          const [runId] = self.agent.activeRunIds();
          if (runId) await self.agent.abortRun(runId);
        }
        if (reply.kind === "error") {
          yield { type: "done", result: { provider: "fake", model: "fake-1", content: "", reasoning: "", toolCalls: [], finishReason: "error", usage, error: "401 invalid api key", errorStatus: 401 } };
          return;
        }
        const toolCalls: ParsedToolCall[] = reply.kind === "ask"
          ? [{ id: `ask_${Math.random().toString(16).slice(2)}`, name: "request_user_input", arguments: "{}", args: { question: "投哪个方向？", options: [{ option_id: "a", label: "数据分析" }, { option_id: "b", label: "产品" }] } }]
          : [];
        const content = reply.kind === "ask" ? "" : "好的。";
        if (content) yield { type: "text_delta", text: content };
        yield { type: "done", result: { provider: "fake", model: "fake-1", content, reasoning: "", toolCalls, finishReason: toolCalls.length ? "tool_calls" : "stop", usage } };
      },
    };
  }

  release(reply: Reply): boolean {
    const next = this.pending.shift();
    if (!next) return false;
    next(reply);
    return true;
  }
}

let cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups) cleanup();
  cleanups = [];
});

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

async function runScenario(actions: Action[]): Promise<void> {
  const store = new SqliteCoreStore(":memory:");
  const runs = new SqliteAgentRunStore(store);
  const dead: ScriptedLlm[] = [];
  cleanups.push(() => store.close());

  let llm = new ScriptedLlm();
  const boot = (scripted: ScriptedLlm) => {
    const agent = createAgentRuntime({ store, runs, llm: () => scripted.client(), streamGuard: GUARD });
    scripted.agent = agent;
    return agent;
  };
  let agent = boot(llm);
  let runId = "";
  let inFlight: Array<Promise<unknown>> = [];
  let sawCancelled = false;
  const trace: string[] = [];

  /** Let the host run until every in-flight call has settled or is parked on the model. */
  const settle = async () => {
    for (let i = 0; i < 200; i += 1) {
      await tick();
      const states = await Promise.all(inFlight.map((p) => Promise.race([p.then(() => "done", () => "done"), tick().then(() => "open")])));
      inFlight = inFlight.filter((_, index) => states[index] === "open");
      if (!inFlight.length) return;
      if (llm.pending.length) return;
    }
  };
  const track = (promise: Promise<unknown>) => {
    inFlight.push(promise.catch((cause) => trace.push(`rejected: ${cause instanceof Error ? cause.message : String(cause)}`)));
  };

  const check = async (step: string) => {
    if (!runId) return;
    const run = await agent.state.loadRun(runId);
    const events: AgentRunEvent[] = await agent.state.listEvents(runId, 0, 1000);
    const context = `${trace.join(" → ")} | after ${step}: status=${run?.status} events=${events.map((e) => e.type).join(",")}`;

    expect(events.map((event) => event.sequence), `gap-free sequences ${context}`).toEqual(events.map((_, index) => index + 1));

    if (sawCancelled) expect(run?.status, `cancelled is final ${context}`).toBe("cancelled");
    if (run?.status === "cancelled") sawCancelled = true;

    const firstCancel = events.findIndex((event) => event.type === "run.cancelled");
    if (firstCancel >= 0) {
      const after = events.slice(firstCancel + 1).filter((event) => event.type === "run.completed" || event.type === "run.failed");
      expect(after.map((event) => event.type), `no terminal event after run.cancelled ${context}`).toEqual([]);
    }

    const terminal = events.filter((event) => TERMINAL.has(event.type));
    for (let i = 1; i < terminal.length; i += 1) {
      const between = events.filter((event) => event.sequence > terminal[i - 1].sequence && event.sequence < terminal[i].sequence);
      const reopened = between.some((event) => event.type === "recovery.started" || event.type === "input.answered");
      expect(reopened || terminal[i].type !== terminal[i - 1].type, `terminal event repeated without reopening ${context}`).toBe(true);
    }
    if (run && ["completed", "failed", "cancelled"].includes(run.status)) {
      expect(terminal.at(-1)?.type, `status matches last terminal event ${context}`).toBe(`run.${run.status}`);
    }

    const answered = events.filter((event) => event.type === "input.answered").map((event) => String(event.payload.request_id));
    expect(new Set(answered).size, `one continuation per answer ${context}`).toBe(answered.length);

    expect(trace.filter((item) => item.startsWith("rejected:")), `no call fails with an internal error ${context}`).toEqual([]);

    if (!inFlight.length && run) {
      expect(["planning", "executing"].includes(run.status), `nothing left executing when idle ${context}`).toBe(false);
    }
  };

  for (const action of actions) {
    trace.push(action);
    const run = runId ? await agent.state.loadRun(runId) : null;
    switch (action) {
      case "start":
        if (inFlight.length || runId) continue;
        track(agent.conversationTurn({ message: "帮我改简历" }));
        await settle();
        runId = (await agent.state.listRuns({ limit: 1 }))[0]?.id || "";
        break;
      case "reply":
      case "ask":
      case "error":
      case "cancel_during_reply": {
        const kind = action === "reply" ? "text" : action === "cancel_during_reply" ? "cancel_then_text" : action;
        if (!llm.release({ kind } as Reply)) continue;
        await settle();
        break;
      }
      case "cancel":
        if (!runId) continue;
        track(agent.abortRun(runId));
        await settle();
        break;
      case "answer":
      case "answer_twice": {
        if (!runId || inFlight.length) continue;
        const pending = (await agent.state.store.listInputRequests(runId)).find((request) => request.status === "pending");
        if (!pending) continue;
        const body = { answer_id: `ans_${pending.request_id}`, selected_option_ids: ["a"] };
        track(agent.answerInput(runId, pending.request_id, body));
        if (action === "answer_twice") track(agent.answerInput(runId, pending.request_id, body));
        await settle();
        break;
      }
      case "restart":
        if (!runId || !llm.pending.length) continue;
        // The process dies mid-turn: its model call never returns and its host never writes again.
        llm.release({ kind: "die" });
        dead.push(llm);
        inFlight = [];
        llm = new ScriptedLlm();
        agent = boot(llm);
        await agent.state.recoverInterrupted();
        break;
      case "resume":
        if (!run || run.status !== "interrupted" || inFlight.length) continue;
        track(agent.resumeRun(runId));
        await settle();
        break;
    }
    await check(action);
  }
}

describe("Agent Run lifecycle model", () => {
  it("holds its invariants under any interleaving", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(fc.constantFrom(...ACTIONS), { minLength: 1, maxLength: 14 }), async (actions) => {
        await runScenario(["start", ...actions]);
        for (const cleanup of cleanups) cleanup();
        cleanups = [];
      }),
      {
        numRuns: Number(process.env.FC_RUNS || 150),
        seed: process.env.FC_SEED ? Number(process.env.FC_SEED) : undefined,
        path: process.env.FC_PATH || undefined,
      },
    );
  }, 120_000);

  it("replays a3efc049: cancel arrives while the model is answering", async () => {
    await runScenario(["start", "cancel_during_reply", "reply", "resume"]);
  });

  it("replays 43a550b1 / 315754f8: restart mid-turn, resume, then cancel", async () => {
    await runScenario(["start", "restart", "resume", "cancel", "reply"]);
  });

  it("replays the duplicate-answer continuation", async () => {
    await runScenario(["start", "ask", "answer_twice", "reply"]);
  });
});
