import { describe, expect, it } from "vitest";

import { CoreError, createOpenAiLlm, extractJson, type FetchLike } from "@offeru/core";

function fakeFetch(replies: Array<{ status: number; body: unknown }>, seen: Array<Record<string, unknown>> = []): FetchLike {
  return async (_url, init) => {
    seen.push(JSON.parse(init?.body ?? "{}"));
    const next = replies.shift() ?? { status: 500, body: {} };
    return { ok: next.status < 400, status: next.status, text: async () => typeof next.body === "string" ? next.body : JSON.stringify(next.body) };
  };
}

const answer = (content: string) => ({ status: 200, body: { choices: [{ message: { content } }] } });

describe("extractJson (Python extract_json parity)", () => {
  it("parses plain, fenced and embedded objects", () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
    expect(extractJson('看：\n```json\n{"a":2}\n```')).toEqual({ a: 2 });
    expect(extractJson('前言 {"a":"}"} 后记 {"b":1}')).toEqual({ a: "}" });
    expect(extractJson("没有 json")).toBeNull();
    expect(extractJson("")).toBeNull();
  });
});

describe("createOpenAiLlm", () => {
  it("sends json mode, appends the json hint, uses tier model", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const llm = createOpenAiLlm({ baseUrl: "https://x/v1/", model: "m", models: { fast: "f" }, fetch: fakeFetch([answer("{}")], seen) });
    expect(await llm.chat([{ role: "user", content: "hi" }], { json: true, tier: "fast", maxTokens: 10 })).toBe("{}");
    expect(seen[0].model).toBe("f");
    expect(seen[0].response_format).toEqual({ type: "json_object" });
    expect(seen[0].max_completion_tokens).toBe(30);
    expect((seen[0].messages as Array<{ content: string }>)[0].content).toContain("Return JSON only.");
  });

  it("retries 429/5xx, falls back to max_tokens, null on failure, throws on bad key", async () => {
    const sleep = async () => {};
    const retry = createOpenAiLlm({ baseUrl: "https://x", model: "m", sleep, fetch: fakeFetch([{ status: 429, body: "" }, answer("ok")]) });
    expect(await retry.chat([{ role: "user", content: "q" }])).toBe("ok");

    const seen: Array<Record<string, unknown>> = [];
    const old = createOpenAiLlm({ baseUrl: "https://x", model: "m", sleep, fetch: fakeFetch([{ status: 400, body: "unknown max_completion_tokens" }, answer("ok")], seen) });
    expect(await old.chat([{ role: "user", content: "q" }], { maxTokens: 7 })).toBe("ok");
    expect(seen[1].max_tokens).toBe(7);

    const down = createOpenAiLlm({ baseUrl: "https://x", model: "m", sleep, fetch: fakeFetch([{ status: 500, body: "" }, { status: 500, body: "" }, { status: 500, body: "" }]) });
    expect(await down.chat([{ role: "user", content: "q" }])).toBeNull();

    const bad = createOpenAiLlm({ baseUrl: "https://x", model: "m", sleep, fetch: fakeFetch([{ status: 401, body: "" }]) });
    await expect(bad.chat([{ role: "user", content: "q" }])).rejects.toBeInstanceOf(CoreError);
  });
});
