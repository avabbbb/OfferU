// Progressive tool disclosure: the built-in Agent gets one-line briefs + slim schemas each turn
// and reads the full registry manual with tool_manual (packages/core/src/tools/catalog.ts).

import { afterEach, describe, expect, it } from "vitest";

import {
  AGENT_TOOL_SPECS,
  CAPABILITIES,
  TOOL_BRIEFS,
  TOOL_GROUPS,
  slimSchema,
  validateArgs,
  type ChatRequest,
  type LlmClient,
  type LlmStreamEvent,
  type ParsedToolCall,
} from "@offeru/core";

import { SqliteAgentRunStore } from "../src/agent-store";
import { createApp } from "../src/app";
import { SqliteCoreStore } from "../src/store";

type Turn = { text?: string; calls?: Array<{ name: string; args: Record<string, unknown> }> };

function scriptedLlm(turns: Turn[], seen: ChatRequest[]): LlmClient {
  return {
    provider: "fake",
    model: "fake-1",
    async chat() { return null; },
    async *completeStream(request: ChatRequest): AsyncIterable<LlmStreamEvent> {
      seen.push(request);
      const turn = turns.shift() ?? { text: "（没有更多脚本）" };
      const toolCalls: ParsedToolCall[] = (turn.calls || []).map((call, index) => ({ id: `call_${index}`, name: call.name, arguments: JSON.stringify(call.args), args: call.args }));
      if (turn.text) yield { type: "text_delta", text: turn.text };
      yield { type: "done", result: { provider: "fake", model: "fake-1", content: turn.text || "", reasoning: "", toolCalls, finishReason: toolCalls.length ? "tool_calls" : "stop", usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15, estimated: false } } };
    },
  };
}

let stores: SqliteCoreStore[] = [];
afterEach(() => {
  for (const store of stores) store.close();
  stores = [];
});

describe("tool catalog", () => {
  it("every Agent tool has a short brief and sits in one index group; capabilities only use real tools", () => {
    const names = AGENT_TOOL_SPECS.map((spec) => spec.name);
    for (const name of names) {
      expect(TOOL_BRIEFS[name], name).toBeTruthy();
      expect([...TOOL_BRIEFS[name]].length, name).toBeLessThanOrEqual(260);
      expect(TOOL_GROUPS.filter((group) => group.tools.includes(name)), name).toHaveLength(1);
    }
    // read_file / find_files / tailor_resume / export_resume_pdf / email_sync are registry tools too
    const toolish = /\b(overview|search|list|get|save|delete|undo|changes|[a-z]+_[a-z_]+)\(/g;
    for (const capability of CAPABILITIES) {
      for (const step of capability.steps) {
        for (const match of step.matchAll(toolish)) expect(names, `${capability.id}: ${step}`).toContain(match[1]);
      }
    }
  });

  it("slim schemas accept and reject the same arguments as the full ones", () => {
    const samples: Array<[string, unknown]> = [
      ["save", { type: "memory", data: { title: "x" } }],
      ["save", { type: "nope", data: {} }],
      ["save", { type: "job" }],
      ["search", { query: "", limit: 5 }],
      ["search", { query: "产品", types: ["job", "memory"] }],
      ["evaluate_jobs", { ids: [1], limit: 2 }],
      ["evaluate_jobs", { limit: 0 }],
      ["list", { type: "job", extra: 1 }],
    ];
    const outcome = (fn: () => unknown) => { try { fn(); return "ok"; } catch (cause) { return (cause as Error).message; } };
    for (const [name, args] of samples) {
      const spec = AGENT_TOOL_SPECS.find((item) => item.name === name)!;
      expect(outcome(() => validateArgs(slimSchema(spec.inputSchema), args)), `${name} ${JSON.stringify(args)}`)
        .toBe(outcome(() => validateArgs(spec.inputSchema, args)));
    }
  });
});

describe("built-in Agent: brief tools each turn, full manual on demand", () => {
  it("sends briefs + the capability index, and tool_manual returns the full registry text", async () => {
    const store = new SqliteCoreStore(":memory:");
    stores.push(store);
    const seen: ChatRequest[] = [];
    const llm = scriptedLlm([
      { calls: [{ name: "tool_manual", args: { names: ["save"] } }] },
      { calls: [{ name: "tool_manual", args: { capability: "resume.tailor" } }] },
      { calls: [{ name: "tool_manual", args: { names: ["send_offer"] } }] },
      { text: "好的。" },
    ], seen);
    const app = createApp({ store, runtime: "node", storage: "sqlite", agentRuns: new SqliteAgentRunStore(store), llm: () => llm });
    const response = await app.request("/api/agent/runtime/runs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message: "帮我记一条经历" }) });
    expect(response.status).toBe(200);

    const first = seen[0];
    const save = first.tools?.find((tool) => tool.name === "save");
    const full = AGENT_TOOL_SPECS.find((spec) => spec.name === "save")!;
    expect(save?.description).toBe(TOOL_BRIEFS.save);
    expect(JSON.stringify(save?.parameters)).not.toContain("\"title\":\"SaveIn\"");
    expect(first.tools?.map((tool) => tool.name)).toContain("tool_manual");
    expect(String(first.messages[0].content)).toContain("工具索引");
    expect(String(first.messages[0].content)).toContain("resume.tailor");
    // the per-turn tool payload is much smaller than the registry
    expect(JSON.stringify(first.tools).length).toBeLessThan(JSON.stringify(AGENT_TOOL_SPECS).length / 2);

    const replies = seen[3].messages.filter((message) => message.role === "tool").map((message) => JSON.parse(String(message.content).replace(/^ERROR: /, "")));
    expect(replies[0]).toMatchObject({ ok: true, tools: [{ name: "save", description: full.description, inputSchema: full.inputSchema }] });
    expect(replies[1]).toMatchObject({ ok: true, capability: { id: "resume.tailor" } });
    expect(replies[1].capability.steps.join("\n")).toContain("review_only=true");
    expect(replies[2]).toMatchObject({ ok: false, error: { code: "not_found", retryable: false } });
    expect(replies[2].error.suggestedAction).toContain("save");
    expect(await store.changes(5)).toEqual([]);
  });
});

