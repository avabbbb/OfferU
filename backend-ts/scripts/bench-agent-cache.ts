// Micro-benchmark: built-in Agent TTFT and prompt-prefix stability over a mock provider.
//
//   cd backend-ts && npx tsx scripts/bench-agent-cache.ts [--format openai|anthropic]
//
// No network, no real data: an in-memory store, createAgentRuntime with a real
// createLlmClient whose fetch is a mock that streams SSE with delays
// (first delta after FIRST_MS, then tool-call fragments until TOTAL_MS).
// Two runs in two conversations; between them the user's data changes (new job,
// new memory), like real use. Prints JSON:
//   ttft_ms          request start → first message.delta seen by the UI listener, per LLM call
//   stream_ms        request start → provider stream end, per LLM call
//   turn_prefix      within run 1: bytes of turn 1's request (tools + messages) that turn 2 repeats unchanged
//   run_prefix       run 1 turn 1 vs run 2 turn 1: same, across runs (what an automatic prefix cache can reuse)
// See docs/perf/agent-latency-cache.md.

import { MemoryAgentRunStore, createAgentRuntime, createLlmClient, saveRecord, type FetchLike } from "@offeru/core";

import { SqliteCoreStore } from "../src/store";

const FIRST_MS = Number(process.env.BENCH_FIRST_MS || 40);
const TOTAL_MS = Number(process.env.BENCH_TOTAL_MS || 400);
const format = process.argv.includes("--format") ? process.argv[process.argv.indexOf("--format") + 1] : "openai";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const now = () => performance.now();

type Call = { start: number; end?: number; body: Record<string, unknown> };
const calls: Call[] = [];

function sse(events: unknown[]): string[] {
  return events.map((event) => `data: ${JSON.stringify(event)}\n\n`);
}

/** Turn 1 of each run calls overview; turn 2 answers. */
function script(callIndex: number): string[] {
  const toolTurn = callIndex % 2 === 0;
  if (format === "anthropic") {
    const head = [{ type: "message_start", message: { usage: { input_tokens: 1000, cache_read_input_tokens: 0 } } }, { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "好的，" } }];
    const tail = toolTurn
      ? [
        { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: `tu_${callIndex}`, name: "overview" } },
        { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "{}" } },
        { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 5 } },
      ]
      : [{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "你现在有 1 个岗位。" } }, { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 9 } }];
    return sse([...head, ...tail]);
  }
  const head = [{ choices: [{ delta: { content: "好的，" } }] }];
  const tail = toolTurn
    ? [
      { choices: [{ delta: { tool_calls: [{ index: 0, id: `call_${callIndex}`, function: { name: "overview", arguments: "" } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "{}" } }] }, finish_reason: "tool_calls" }] },
    ]
    : [{ choices: [{ delta: { content: "你现在有 1 个岗位。" }, finish_reason: "stop" }] }];
  return [...sse([...head, ...tail, { choices: [], usage: { prompt_tokens: 1000, completion_tokens: 9, prompt_tokens_details: { cached_tokens: 0 } } }]), "data: [DONE]\n\n"];
}

const fetchMock: FetchLike = async (_url, init) => {
  const call: Call = { start: now(), body: JSON.parse(init?.body || "{}") };
  const index = calls.length;
  calls.push(call);
  const chunks = script(index).map((text) => new TextEncoder().encode(text));
  const gap = (TOTAL_MS - FIRST_MS) / Math.max(1, chunks.length - 1);
  let i = 0;
  return {
    ok: true,
    status: 200,
    text: async () => "",
    body: {
      getReader: () => ({
        async read() {
          if (i >= chunks.length) {
            call.end ??= now();
            return { done: true };
          }
          await sleep(i === 0 ? FIRST_MS : gap);
          const value = chunks[i++];
          if (i === chunks.length) call.end = now();
          return { done: false, value };
        },
      }),
    },
  };
};

/** What a provider renders in order: tools, then the messages (Anthropic: system first). */
function renderedParts(body: Record<string, unknown>): string[] {
  const parts = [JSON.stringify(body.tools ?? [])];
  if (body.system !== undefined) parts.push(JSON.stringify(body.system));
  for (const message of (body.messages as unknown[]) ?? []) parts.push(JSON.stringify(message));
  return parts;
}

/** Bytes of `a` that `b` repeats unchanged from the start (part granularity, then characters inside the first differing part). */
function sharedPrefix(a: Record<string, unknown>, b: Record<string, unknown>): { bytes: number; of: number; ratio: number } {
  const left = renderedParts(a);
  const right = renderedParts(b);
  // Anthropic cache_control markers are metadata, not prompt bytes.
  const strip = (text: string) => text.replace(/,"cache_control":\{"type":"ephemeral"\}/g, "");
  const total = left.reduce((sum, part) => sum + strip(part).length, 0);
  let bytes = 0;
  for (let index = 0; index < left.length; index += 1) {
    const x = strip(left[index]);
    const y = strip(right[index] ?? "");
    if (x === y) {
      bytes += x.length;
      continue;
    }
    let same = 0;
    while (same < x.length && x[same] === y[same]) same += 1;
    bytes += same;
    break;
  }
  return { bytes, of: total, ratio: Number((bytes / Math.max(1, total)).toFixed(3)) };
}

async function main() {
  const store = new SqliteCoreStore(":memory:");
  const ctx = { actor: "你", now: new Date().toISOString(), today: new Date().toISOString().slice(0, 10) };
  await saveRecord(store, { type: "profile", data: { school: "示例大学", major: "统计" } }, ctx);
  await saveRecord(store, { type: "memory", data: { kind: "project", title: "用户增长分析", body: "联系人 13812345678，邮箱 demo@example.com", confirmed: true } }, ctx);
  const client = createLlmClient(format === "anthropic"
    ? { provider: "anthropic", baseUrl: "https://api.anthropic.com", apiKey: "k", model: "claude-x", apiFormat: "anthropic" }
    : { provider: "openai", baseUrl: "https://api.openai.com/v1", apiKey: "k", model: "gpt-x" }, { fetch: fetchMock });
  const host = createAgentRuntime({ store, runs: new MemoryAgentRunStore(), llm: () => client });

  const firstDelta: number[] = [];
  const listener = (event: { type: string }) => {
    if (event.type === "message.delta" && firstDelta.length < calls.length) firstDelta.push(now());
  };
  await host.conversationTurn({ message: "我手机 13812345678，帮我看看现在的情况", listener });
  await saveRecord(store, { type: "job", data: { company: "飞书", title: "数据分析实习", jd: "SQL" } }, ctx);
  await saveRecord(store, { type: "memory", data: { kind: "preference", title: "不写实习时长", body: "简历里不写实习时长", confirmed: true } }, ctx);
  await host.conversationTurn({ message: "再看一下", listener });

  const report = {
    format,
    mock: { first_delta_ms: FIRST_MS, stream_ms: TOTAL_MS },
    calls: calls.length,
    ttft_ms: calls.map((call, index) => Math.round((firstDelta[index] ?? Number.NaN) - call.start)),
    stream_ms: calls.map((call) => Math.round((call.end ?? Number.NaN) - call.start)),
    turn_prefix: sharedPrefix(calls[0].body, calls[1].body),
    run_prefix: sharedPrefix(calls[0].body, calls[2].body),
  };
  console.log(JSON.stringify(report, null, 2));
  store.close();
}

await main();
