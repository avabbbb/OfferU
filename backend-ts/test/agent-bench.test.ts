// Agent harness regression bench: real-task cases replayed from docs/DOGFOOD.md (desensitized),
// each scored on a routing → call → output → reply funnel. The model is scripted (the trajectory a
// model took, or should take), so the bench measures OfferU's harness — tool routing, skills,
// preflight, retries, compaction, resume, evidence checks — not model quality. The reply checks
// are written so the same functions can grade a real model's replies later.
//
//   npx vitest run test/agent-bench.test.ts            # pass/fail per case + funnel
//   OFFERU_BENCH_OUT=.tmp/agent-bench.json npx vitest run test/agent-bench.test.ts   # also write the report
//
// Not covered: "stale proposal version conflict" — the TS core has no proposal versions (Agent writes
// apply directly and are undone through the change log), so there is nothing to conflict on yet.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { afterAll, afterEach, describe, expect, it } from "vitest";

import {
  buildJobEvidenceLedger,
  createAgentRuntime,
  saveRecord,
  validateTailoredResume,
  type AgentHost,
  type ChatRequest,
  type LlmClient,
  type LlmStreamEvent,
  type ParsedToolCall,
} from "@offeru/core";

import { SqliteAgentRunStore } from "../src/agent-store";
import { SqliteCoreStore } from "../src/store";
import { at, BEFORE, seedDogfood1109 } from "./helpers/dogfood";

type Step =
  | { kind: "text"; text: string }
  | { kind: "calls"; calls: Array<{ name: string; args: Record<string, unknown> }> }
  | { kind: "http"; status: number; error: string }
  | { kind: "hang" };

const usage = { input_tokens: 10, output_tokens: 5, total_tokens: 15, estimated: false };

function stepLlm(steps: Step[], seen: ChatRequest[], model = "fake-1"): LlmClient {
  return {
    provider: "fake",
    model,
    async chat() { return null; },
    async *completeStream(request: ChatRequest): AsyncIterable<LlmStreamEvent> {
      seen.push(request);
      const step = steps.shift() ?? { kind: "text", text: "好。" };
      if (step.kind === "hang") {
        await new Promise<void>((resolve) => request.signal?.addEventListener("abort", () => resolve()));
        yield { type: "done", result: { provider: "fake", model, content: "", reasoning: "", toolCalls: [], finishReason: "aborted", usage } };
        return;
      }
      if (step.kind === "http") {
        yield { type: "done", result: { provider: "fake", model, content: "", reasoning: "", toolCalls: [], finishReason: "error", usage, error: step.error, errorStatus: step.status } };
        return;
      }
      const toolCalls: ParsedToolCall[] = step.kind === "calls" ? step.calls.map((call, index) => ({ id: `c${seen.length}_${index}`, name: call.name, arguments: JSON.stringify(call.args), args: call.args })) : [];
      const text = step.kind === "text" ? step.text : "";
      if (text) yield { type: "text_delta", text };
      yield { type: "done", result: { provider: "fake", model, content: text, reasoning: "", toolCalls, finishReason: toolCalls.length ? "tool_calls" : "stop", usage } };
    },
  };
}

const FAST = { firstByteMs: 80, idleMs: 80, retries: 2, backoffMs: [0] };

let stores: SqliteCoreStore[] = [];
afterEach(() => {
  for (const store of stores) store.close();
  stores = [];
});

function newStore(): SqliteCoreStore {
  const store = new SqliteCoreStore(":memory:");
  stores.push(store);
  return store;
}

function runtime(store: SqliteCoreStore, llm: () => LlmClient, options: { streamGuard?: typeof FAST | false; compaction?: { windowTokens: number; reserveTokens: number; keepRecentTokens: number } } = {}): AgentHost {
  return createAgentRuntime({ store, runs: new SqliteAgentRunStore(store), llm, streamGuard: options.streamGuard ?? FAST, compaction: options.compaction });
}

const toolReplies = (request: ChatRequest | undefined) => (request?.messages ?? []).filter((message) => message.role === "tool").map((message) => JSON.parse(String(message.content)));
const okCalls = (request: ChatRequest | undefined) => toolReplies(request).every((reply) => reply?.ok !== false);

async function until(check: () => Promise<boolean>, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed out waiting");
}

/** Reply check for a vague mock-interview answer (DOGFOOD 2026-11-07 s5 C11b / C11d). */
export function singleFollowUp(reply: string): boolean {
  const questions = (reply.match(/[？?]/gu) ?? []).length;
  return questions === 1 && !/第\s*\d+\s*题/u.test(reply) && !/框架|示范|STAR|参考回答/u.test(reply) && !/档案/u.test(reply);
}

type Funnel = { routing: boolean; call: boolean; output: boolean; reply: boolean };
const results: Array<{ id: string; source: string } & Funnel> = [];
function record(id: string, source: string, funnel: Funnel) {
  results.push({ id, source, ...funnel });
  expect(funnel, id).toEqual({ routing: true, call: true, output: true, reply: true });
}

afterAll(() => {
  const stages = ["routing", "call", "output", "reply"] as const;
  const funnel = Object.fromEntries(stages.map((stage, index) => [stage, results.filter((row) => stages.slice(0, index + 1).every((s) => row[s])).length / Math.max(1, results.length)]));
  const report = { cases: results, funnel, total: results.length };
  const out = process.env.OFFERU_BENCH_OUT;
  if (out) {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, JSON.stringify(report, null, 2));
  }
});

describe("agent regression bench (DOGFOOD replays)", () => {
  it("429/503 mid-task: retried before output, the memory is saved exactly once", async () => {
    const store = newStore();
    const seen: ChatRequest[] = [];
    const agent = runtime(store, () => stepLlm([
      { kind: "http", status: 429, error: "429 rate limit" },
      { kind: "calls", calls: [{ name: "save", args: { type: "memory", data: { kind: "skill", title: "SQL", body: "会写窗口函数", mode: "实习" } } }] },
      { kind: "http", status: 503, error: "503 overloaded" },
      { kind: "text", text: "记下了「SQL」，待你在档案页确认，可在最近改动撤销。" },
    ], seen));
    const result = await agent.conversationTurn({ message: "记一下我会 SQL 窗口函数" });
    const retries = (await agent.state.listEvents(result.run.id)).filter((event) => event.type === "runtime.retry_started");
    record("retry-no-duplicate-save", "2026-11-07 runtime / upstream 5xx", {
      routing: Boolean(seen[0].tools?.some((tool) => tool.name === "save")),
      call: okCalls(seen.at(-1)) && retries.length === 2,
      output: (await store.all("memory")).length === 1 && (await store.changes(10)).length === 1,
      reply: result.ok && /撤销/u.test(result.assistant_message),
    });
  });

  it("long research run: compacts, survives a restart, resumes and keeps the job / evidence references", async () => {
    const store = newStore();
    const { jobId } = await seedDogfood1109(store);
    await saveRecord(store, { type: "job", id: jobId, data: { jd: "岗位要求很长".repeat(4000) } }, at("09"));
    const compaction = { windowTokens: 16_000, reserveTokens: 2_000, keepRecentTokens: 300 };
    const seen1: ChatRequest[] = [];
    const first = runtime(store, () => stepLlm([{ kind: "calls", calls: [{ name: "get", args: { type: "job", id: jobId } }] }, { kind: "hang" }], seen1), { streamGuard: false, compaction });
    void first.conversationTurn({ message: `调研一下岗位 #${jobId}，准备面试` });
    await until(async () => seen1.length >= 2);
    const runId = first.activeRunIds()[0];

    // process restart: a new runtime on the same database marks the run interrupted, then resumes it
    const seen2: ChatRequest[] = [];
    const second = runtime(store, () => stepLlm([
      { kind: "calls", calls: [{ name: "save", args: { type: "doc", data: { kind: "research", job_id: jobId, title: "调研", body: "# 结论\n运营管培生 [inference]" } } }] },
      { kind: "text", text: `调研已存到岗位 #${jobId}，可在最近改动撤销。` },
    ], seen2), { compaction });
    await second.state.recoverInterrupted();
    const resumed = await second.startRun({ message: "", resumeRunId: runId });
    const system = String(seen2[0]?.messages[0].content ?? "");
    record("long-research-resume", "2026-11-06 evaluate 152s / long runs", {
      routing: String(seen1[0].messages[0].content).includes("技能 role-research"),
      call: okCalls(seen2.at(-1)),
      output: (await store.all("doc", jobId)).some((doc) => doc.kind === "research")
        && !JSON.stringify(seen2[0].messages).includes("岗位要求很长".repeat(100))
        && system.includes(`岗位 #${jobId}`),
      reply: resumed.ok && resumed.assistant_message.includes(`#${jobId}`),
    });
  });

  it("compacted run: a fact the user confirms mid-run still reaches the next tailor, and the context shrinks", async () => {
    const store = newStore();
    const { jobId } = await seedDogfood1109(store);
    await saveRecord(store, { type: "job", id: jobId, data: { jd: `要求跨部门协作；英语流利。${"岗位职责很长".repeat(3000)}` } }, at("09"));
    const compaction = { windowTokens: 16_000, reserveTokens: 2_000, keepRecentTokens: 300 };
    const seen: ChatRequest[] = [];
    const drafts: string[] = [];
    const steps = stepLlm([
      { kind: "calls", calls: [{ name: "get", args: { type: "job", id: jobId } }] },
      { kind: "calls", calls: [{ name: "get", args: { type: "job", id: jobId } }] },
      { kind: "calls", calls: [{ name: "tailor_resume", args: { job_id: jobId } }] },
      { kind: "text", text: `改好了，用上了雅思 7.5。` },
    ], seen);
    const llm: LlmClient = {
      ...steps,
      async chat(messages, options) {
        if (options?.json) return JSON.stringify({ edits: [], notes: {}, asks: [] });
        drafts.push(JSON.stringify(messages));
        return `${BEFORE}\n- 英语：雅思 7.5`;
      },
    };
    const agent = createAgentRuntime({ store, runs: new SqliteAgentRunStore(store), llm: () => llm, toolDeps: () => ({ store, llm }), streamGuard: false, compaction });
    const events: string[] = [];
    // the user confirms a new achievement in the UI while the run is going (between model turns)
    let confirmed = false;
    const run = agent.conversationTurn({ message: `按岗位 #${jobId} 改简历`, listener: async (event) => {
      events.push(event.type);
      if (!confirmed && seen.length === 2) {
        confirmed = true;
        await saveRecord(store, { type: "memory", data: { kind: "skill", title: "英语", body: "雅思 7.5", quote: "我雅思考了 7.5", said_at: "2026-11-09" } }, at("09"));
      }
    } });
    const result = await run;
    const sizes = seen.map((request) => JSON.stringify(request.messages).length);
    record("compaction-fact-reuse", "P2 上下文策略：压缩后事实走存储", {
      routing: String(seen[0].messages[0].content).includes("技能 resume-tailoring"),
      call: okCalls(seen.at(-1)),
      output: drafts.some((draft) => draft.includes("雅思 7.5"))
        && Math.max(...sizes.slice(2)) < JSON.stringify("岗位职责很长".repeat(3000)).length * 2,
      reply: result.ok && result.assistant_message.includes("雅思"),
    });
  });

  it("stop mid-run, switch model: the saved evidence stays and the next model reads it", async () => {
    const store = newStore();
    const seen1: ChatRequest[] = [];
    const first = runtime(store, () => stepLlm([
      { kind: "calls", calls: [{ name: "save", args: { type: "memory", data: { kind: "project", title: "留存分析", body: "30 日留存提升 2.1 个百分点", mode: "实习" } } }] },
      { kind: "hang" },
    ], seen1));
    const pending = first.conversationTurn({ message: "记一下留存分析这段经历" });
    await until(async () => seen1.length >= 2);
    await first.abortRun(first.activeRunIds()[0]);
    const stopped = await pending;
    const seen2: ChatRequest[] = [];
    const second = runtime(store, () => stepLlm([
      { kind: "calls", calls: [{ name: "search", args: { query: "留存" } }] },
      { kind: "text", text: "找到了：留存分析，30 日留存提升 2.1 个百分点（待确认）。" },
    ], seen2, "fake-2"));
    const next = await second.conversationTurn({ message: "我之前那段留存分析写了什么？", conversation_id: stopped.conversation_id });
    const found = toolReplies(seen2.at(-1))[0];
    record("stop-switch-keeps-evidence", "2026-11-07 abort → 500, run lost", {
      routing: Boolean(seen2[0].tools?.some((tool) => tool.name === "search")),
      call: okCalls(seen2.at(-1)),
      output: stopped.run.status === "cancelled" && (await store.all("memory")).length === 1 && JSON.stringify(found).includes("留存分析"),
      reply: next.ok && next.assistant_message.includes("2.1"),
    });
  });

  it("re-tailor keeps confirmed achievements and refuses self-scores (evidence ledger)", async () => {
    const store = newStore();
    const { jobId, talkId } = await seedDogfood1109(store);
    const ledger = (await buildJobEvidenceLedger(store, jobId))!;
    const bad = `${BEFORE.split("\n").slice(0, 4).join("\n")}\n- 综合分从 5.8 提升到 6.4`;
    const issues = await validateTailoredResume({ ledger, job: (await store.get("job", jobId))!, before: BEFORE, after: bad, memories: await store.all("memory") });
    const clean = await validateTailoredResume({ ledger, job: (await store.get("job", jobId))!, before: BEFORE, after: BEFORE, memories: await store.all("memory") });
    record("confirmed-achievement-preserved", "2026-11-09 tailor_resume #29", {
      routing: ledger.requirements.length === 2 && ledger.resumeClaims.every((claim) => claim.confirmed),
      call: true,
      output: issues.some((issue) => issue.code === "confirmed_dropped" && issue.memoryId === talkId) && issues.some((issue) => issue.code === "self_score_as_achievement"),
      reply: clean.length === 0,
    });
  });

  it("vague mock-interview answer: interview rules are loaded and the reply is one follow-up question", async () => {
    const store = newStore();
    const seen: ChatRequest[] = [];
    const interviewer = stepLlm([
      { kind: "text", text: "第 1 题：讲一个你用数据推动决策的经历。" },
      { kind: "text", text: "你具体用 SQL 查了哪些数据，最后结论改变了什么决定？" },
    ], seen);
    const agent = runtime(store, () => interviewer);
    const first = await agent.conversationTurn({ message: "帮我模拟面试数据分析岗" });
    const second = await agent.conversationTurn({ message: "就是用 SQL 查了一些数据……", conversation_id: first.conversation_id });
    // negative control: the 11-07 failure (critique + framework + next question) must fail the check
    const failing = "回答有点笼统。可以用 STAR 框架：情境、任务、行动、结果。第 2 题：说说你的优势？";
    record("vague-answer-one-follow-up", "2026-11-07 s5-a3 C11b / full-a8", {
      routing: String(seen[1].messages[0].content).includes("这条回复只用一个问题追问"),
      call: true,
      output: (await store.changes(10)).length === 0,
      reply: singleFollowUp(second.assistant_message) && !singleFollowUp(failing),
    });
  });
});
