// Contract tests for the web-search providers ported from oh-my-pi (parallel / exa / firecrawl /
// keenable): exact request URL / headers / body, response parsing, the auto fallback order and
// explicit provider selection. Fake fetch only; no network.

import { describe, expect, it } from "vitest";

import { callTool } from "../src/tools";
import { createSearchClient, type SearchKeys } from "@offeru/core";
import { searchFromEnv } from "../src/node-runtime";

type Call = { url: string; method: string; headers: Record<string, string>; body: any };

function headersOf(init?: RequestInit): Record<string, string> {
  const out: Record<string, string> = {};
  new Headers(init?.headers).forEach((value, key) => { out[key] = value; });
  return out;
}

/** Fake fetch: routes by URL prefix; records every call. */
function fakeFetch(routes: Record<string, (call: Call) => Response | Promise<Response>>) {
  const calls: Call[] = [];
  const fetcher = async (input: string, init?: RequestInit) => {
    const call: Call = { url: input, method: init?.method ?? "GET", headers: headersOf(init), body: init?.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(call);
    const route = Object.keys(routes).find((prefix) => input.startsWith(prefix));
    if (!route) return new Response("no route", { status: 404 });
    return routes[route](call);
  };
  return { calls, fetcher };
}

const json = (body: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" }, ...init });
const sse = (body: unknown) => new Response(`event: message\ndata: ${JSON.stringify(body)}\n\n`, { status: 200, headers: { "content-type": "text/event-stream" } });

const PARALLEL_PAYLOAD = {
  search_id: "search_1",
  results: [
    { url: "https://campus-talent.alibaba.com/campus/position/1", title: "AI产品经理", publish_date: null, excerpts: ["负责AI应用", "了解AIGC"] },
    { url: "https://example.com/news", title: "校招资讯", publish_date: "2026-10-08", excerpts: ["阿里校招"] },
    { url: "http://10.0.0.1/internal", title: "内网", excerpts: ["x"] },
  ],
};

const EXA_TEXT = [
  "Title: Alibaba Campus Recruitment",
  "URL: https://campus-talent.alibaba.com/campus/position/2",
  "Published: N/A",
  "Author: N/A",
  "Highlights:",
  "AI应用产品经理",
  "",
  "了解AIGC相关知识",
  "",
  "Title: AIGC 产品经理实习生 · 阿里巴巴",
  "URL: https://offerdao.ai/j/1",
  "Published: 2026-09-01T00:00:00.000Z",
  "Author: N/A",
  "Highlights:",
  "淘天集团",
].join("\n");

const Q = "阿里巴巴 AIGC 产品经理 校招 JD";

async function run(keys: SearchKeys, routes: Record<string, (call: Call) => Response | Promise<Response>>, limit = 5) {
  const fake = fakeFetch(routes);
  const client = createSearchClient(keys, fake.fetcher as never);
  const items = await client.search(Q, limit);
  return { ...fake, items, client };
}

describe("parallel", () => {
  it("keyless: JSON-RPC tools/call web_search on the public MCP; parses content[].text JSON and publish_date", async () => {
    const { calls, items } = await run({ provider: "parallel" }, {
      "https://search.parallel.ai/mcp": (call) => json({ jsonrpc: "2.0", id: call.body.id, result: { content: [{ type: "text", text: JSON.stringify(PARALLEL_PAYLOAD) }] } }),
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ url: "https://search.parallel.ai/mcp", method: "POST" });
    expect(calls[0].headers).toMatchObject({ "content-type": "application/json", accept: "application/json, text/event-stream" });
    expect(calls[0].headers["user-agent"]).toBeUndefined();
    expect(calls[0].body).toMatchObject({ jsonrpc: "2.0", method: "tools/call", params: { name: "web_search", arguments: { objective: Q, search_queries: [Q] } } });
    expect(items).toEqual([
      { title: "AI产品经理", url: "https://campus-talent.alibaba.com/campus/position/1", snippet: "负责AI应用\n\n了解AIGC", engine: "parallel" },
      { title: "校招资讯", url: "https://example.com/news", snippet: "阿里校招", engine: "parallel", published: "2026-10-08" },
    ]);
  });

  it("keyless: structuredContent wins; isError surfaces as a provider error", async () => {
    const ok = await run({ provider: "parallel" }, {
      "https://search.parallel.ai/mcp": (call) => json({ jsonrpc: "2.0", id: call.body.id, result: { structuredContent: PARALLEL_PAYLOAD, content: [{ type: "text", text: "ignored" }] } }),
    });
    expect(ok.items).toHaveLength(2);
    const fake = fakeFetch({ "https://search.parallel.ai/mcp": (call) => json({ jsonrpc: "2.0", id: call.body.id, result: { isError: true, content: [{ type: "text", text: "quota" }] } }) });
    const out = await createSearchClient({ provider: "parallel" }, fake.fetcher as never).searchDetailed!(Q, 5);
    expect(out).toEqual({ items: [], errors: ["parallel(免 Key): quota"] });
  });

  it("keyed: POST api.parallel.ai/v1beta/search with x-api-key + parallel-beta", async () => {
    const { calls, items } = await run({ provider: "parallel", parallelApiKey: "pk" }, { "https://api.parallel.ai/v1beta/search": () => json(PARALLEL_PAYLOAD) });
    expect(calls[0].headers).toMatchObject({ "x-api-key": "pk", "parallel-beta": "search-extract-2025-10-10", accept: "application/json", "content-type": "application/json" });
    expect(calls[0].body).toEqual({ objective: Q, search_queries: [Q], mode: "fast", excerpts: { max_chars_per_result: 10_000 } });
    expect(items.map((i) => i.engine)).toEqual(["parallel", "parallel"]);
  });
});

describe("exa", () => {
  it("keyless: mcp.exa.ai/mcp?tools=web_search_exa, x-exa-source, SSE response, Title/URL/Published/Highlights text", async () => {
    const { calls, items } = await run({ provider: "exa" }, {
      "https://mcp.exa.ai/mcp": (call) => sse({ result: { content: [{ type: "text", text: EXA_TEXT }] }, jsonrpc: "2.0", id: call.body.id }),
    });
    expect(calls[0].url).toBe("https://mcp.exa.ai/mcp?tools=web_search_exa");
    expect(calls[0].headers).toMatchObject({ "x-exa-source": "offeru", accept: "application/json, text/event-stream" });
    expect(calls[0].body.params).toEqual({ name: "web_search_exa", arguments: { query: Q, numResults: 5 } });
    expect(items).toEqual([
      { title: "Alibaba Campus Recruitment", url: "https://campus-talent.alibaba.com/campus/position/2", snippet: "AI应用产品经理\n\n了解AIGC相关知识", engine: "exa" },
      { title: "AIGC 产品经理实习生 · 阿里巴巴", url: "https://offerdao.ai/j/1", snippet: "淘天集团", engine: "exa", published: "2026-09-01T00:00:00.000Z" },
    ]);
  });

  it("keyless: omp's 'Published Date:' / 'Text:' labels still parse", async () => {
    const text = "Title: A\nURL: https://a.cn/1\nPublished Date: 2026-01-02\nText: body a\n\nTitle: B\nURL: https://b.cn/2\nText: body b";
    const { items } = await run({ provider: "exa" }, { "https://mcp.exa.ai/mcp": (call) => json({ jsonrpc: "2.0", id: call.body.id, result: { content: [{ type: "text", text }] } }) });
    expect(items).toEqual([
      { title: "A", url: "https://a.cn/1", snippet: "body a", engine: "exa", published: "2026-01-02" },
      { title: "B", url: "https://b.cn/2", snippet: "body b", engine: "exa" },
    ]);
  });

  it("keyed: POST api.exa.ai/search with x-api-key and summary contents", async () => {
    const { calls, items } = await run({ provider: "exa", exaApiKey: "ek" }, {
      "https://api.exa.ai/search": () => json({ results: [{ title: "T", url: "https://t.cn/", summary: "S", text: "X", publishedDate: "2026-03-04" }] }),
    }, 3);
    expect(calls[0].headers).toMatchObject({ "x-api-key": "ek", "content-type": "application/json" });
    expect(calls[0].body).toEqual({ query: Q, numResults: 3, type: "auto", contents: { summary: { query: Q } } });
    expect(items).toEqual([{ title: "T", url: "https://t.cn/", snippet: "S", engine: "exa", published: "2026-03-04" }]);
  });
});

describe("firecrawl", () => {
  it("keyless: POST api.firecrawl.dev/v2/search without Authorization; parses data.web", async () => {
    const { calls, items } = await run({ provider: "firecrawl" }, {
      "https://api.firecrawl.dev/v2/search": () => json({ success: true, data: { web: [
        { url: "https://campus-talent.alibaba.com/x", title: "日常实习生-AI产品经理", description: "深度参与AIGC产品", position: 1 },
        { url: "https://talent.alibaba.com/", title: "阿里巴巴集团招聘官网", snippet: "官网", position: 2 },
      ] } }),
    });
    expect(calls[0].headers.authorization).toBeUndefined();
    expect(calls[0].body).toEqual({ query: Q, limit: 5, sources: [{ type: "web" }] });
    expect(items).toEqual([
      { title: "日常实习生-AI产品经理", url: "https://campus-talent.alibaba.com/x", snippet: "深度参与AIGC产品", engine: "firecrawl" },
      { title: "阿里巴巴集团招聘官网", url: "https://talent.alibaba.com/", snippet: "官网", engine: "firecrawl" },
    ]);
  });

  it("keyed: Bearer token; success=false is an error; legacy data[] shape parses", async () => {
    const keyed = await run({ provider: "firecrawl", firecrawlApiKey: "fk" }, { "https://api.firecrawl.dev/v2/search": () => json({ success: true, data: [{ url: "https://a.cn/", title: "A", markdown: "md" }] }) });
    expect(keyed.calls[0].headers.authorization).toBe("Bearer fk");
    expect(keyed.items).toEqual([{ title: "A", url: "https://a.cn/", snippet: "md", engine: "firecrawl" }]);
    const fake = fakeFetch({ "https://api.firecrawl.dev/v2/search": () => json({ success: false, error: "Insufficient credits" }) });
    expect(await createSearchClient({ provider: "firecrawl" }, fake.fetcher as never).searchDetailed!(Q, 5))
      .toEqual({ items: [], errors: ["firecrawl(免 Key): Insufficient credits"] });
  });
});

describe("keenable", () => {
  it("keyless: /v1/search/public with X-Keenable-Title; dedups URLs, reads published_at", async () => {
    const { calls, items } = await run({ provider: "keenable" }, {
      "https://api.keenable.ai/v1/search/public": () => json({ query: Q, mode: "pro", results: [
        { title: "Alibaba Campus Recruitment", url: "https://campus-talent.alibaba.com/campus/position/1", snippet: "Updated on 2026-08-06\n  Beijing", published_at: "2026-08-06" },
        { title: "dup", url: "https://campus-talent.alibaba.com/campus/position/1", snippet: "dup" },
        { title: "", url: "https://nowcoder.com/jobs/detail/439336?", snippet: "产品经理" },
        { title: "bad", url: "ftp://x" },
      ] }),
    });
    expect(calls[0].url).toBe("https://api.keenable.ai/v1/search/public");
    expect(calls[0].headers).toMatchObject({ "x-keenable-title": "offeru", accept: "application/json", "content-type": "application/json" });
    expect(calls[0].headers["x-api-key"]).toBeUndefined();
    expect(calls[0].body).toEqual({ query: Q, max_results: 5 });
    expect(items).toEqual([
      { title: "Alibaba Campus Recruitment", url: "https://campus-talent.alibaba.com/campus/position/1", snippet: "Updated on 2026-08-06 Beijing", engine: "keenable", published: "2026-08-06" },
      { title: "https://nowcoder.com/jobs/detail/439336?", url: "https://nowcoder.com/jobs/detail/439336?", snippet: "产品经理", engine: "keenable" },
    ]);
  });

  it("keyed: /v1/search with X-API-Key, no title header", async () => {
    const { calls } = await run({ provider: "keenable", keenableApiKey: "kk" }, { "https://api.keenable.ai/v1/search": () => json({ results: [{ title: "A", url: "https://a.cn/", snippet: "s" }] }) });
    expect(calls[0].url).toBe("https://api.keenable.ai/v1/search");
    expect(calls[0].headers).toMatchObject({ "x-api-key": "kk" });
    expect(calls[0].headers["x-keenable-title"]).toBeUndefined();
  });

  it("keyless 429 says it is rate-limited", async () => {
    const fake = fakeFetch({ "https://api.keenable.ai/": () => new Response("slow down", { status: 429 }) });
    const out = await createSearchClient({ provider: "keenable" }, fake.fetcher as never).searchDetailed!(Q, 5);
    expect(out.errors[0]).toMatch(/^keenable\(免 Key\): keenable: 免 Key 接口限流 \(429\)/);
  });
});

describe("chain", () => {
  const fail = () => new Response("boom", { status: 500 });
  const every = {
    "https://api.tavily.com/search": () => json({ results: [{ title: "tv", url: "https://tv.cn/", content: "c" }] }),
    "https://api.exa.ai/search": () => json({ results: [{ title: "exa", url: "https://exa.cn/" }] }),
    "https://search.parallel.ai/mcp": (call: Call) => json({ jsonrpc: "2.0", id: call.body.id, result: { structuredContent: PARALLEL_PAYLOAD } }),
    "https://mcp.exa.ai/mcp": fail,
    "https://api.firecrawl.dev/v2/search": fail,
    "https://api.keenable.ai/v1/search/public": fail,
  };

  it("auto: keyed providers first (python ones, then new keyed), then keyless parallel → exa → keenable (keyless firecrawl explicit-only)", async () => {
    const fake = fakeFetch({ ...every, "https://api.tavily.com/search": fail, "https://api.exa.ai/search": fail, "https://search.parallel.ai/mcp": fail });
    const out = await createSearchClient({ tavilyApiKey: "t", exaApiKey: "e" }, fake.fetcher as never).searchDetailed!(Q, 5);
    expect(fake.calls.map((c) => c.url)).toEqual([
      "https://api.tavily.com/search",
      "https://api.exa.ai/search",
      "https://search.parallel.ai/mcp",
      "https://api.keenable.ai/v1/search/public",
    ]);
    // exa has a key, so its keyless MCP is not tried again
    expect(out.errors.map((e) => e.split(":")[0])).toEqual(["tavily", "exa", "parallel(免 Key)", "keenable(免 Key)"]);
  });

  it("auto: first non-empty wins; no keys at all still searches keyless", async () => {
    const keyed = await run({ tavilyApiKey: "t" }, every);
    expect(keyed.items.map((i) => i.engine)).toEqual(["tavily"]);
    const keyless = await run({}, every);
    expect(keyless.client.available).toBe(true);
    expect(keyless.calls.map((c) => c.url)).toEqual(["https://search.parallel.ai/mcp"]);
    expect(keyless.items[0].engine).toBe("parallel");
  });

  it("explicit provider runs only that one; keyless=false disables public endpoints; unknown provider is invalid", async () => {
    const only = await run({ provider: "firecrawl", tavilyApiKey: "t" }, { ...every, "https://api.firecrawl.dev/v2/search": () => json({ data: { web: [{ url: "https://f.cn/", title: "f" }] } }) });
    expect(only.calls.map((c) => c.url)).toEqual(["https://api.firecrawl.dev/v2/search"]);
    expect(createSearchClient({ keyless: false }, fakeFetch({}).fetcher as never).available).toBe(false);
    expect(createSearchClient({ provider: "bocha" }, fakeFetch({}).fetcher as never).available).toBe(false);
    expect(() => createSearchClient({ provider: "ddgs" as never }, fakeFetch({}).fetcher as never)).toThrow("未知 search_provider");
  });

  it("web_search tool: carries published; errors only when everything failed", async () => {
    const ok = createSearchClient({ provider: "parallel" }, fakeFetch(every).fetcher as never);
    const out = await callTool("web_search", { query: Q, limit: 3 }, { store: null as never, search: () => ok }) as any;
    expect(out.items[1]).toEqual({ title: "校招资讯", url: "https://example.com/news", snippet: "阿里校招", engine: "parallel", published: "2026-10-08" });
    expect(out.errors).toBeUndefined();
    const bad = createSearchClient({ provider: "keenable" }, fakeFetch(every).fetcher as never);
    expect(await callTool("web_search", { query: Q }, { store: null as never, search: () => bad })).toEqual({ query: Q, items: [], errors: ["keenable(免 Key): keenable HTTP 500: boom"] });
  });

  it("node companion env: keys and SEARCH_PROVIDER from env, keyless on by default, OFFERU_SEARCH_KEYLESS=0 turns it off", () => {
    expect(searchFromEnv({})?.available).toBe(true);
    expect(searchFromEnv({ OFFERU_SEARCH_KEYLESS: "0" })).toBeNull();
    expect(searchFromEnv({ OFFERU_SEARCH_KEYLESS: "0", EXA_API_KEY: "e" })?.available).toBe(true);
    expect(searchFromEnv({ SEARCH_PROVIDER: "serper" })).toBeNull();
  });
});
