// Cloudflare Worker entry: static assets, the stateless model relay, no data APIs.

import { afterEach, describe, expect, it, vi } from "vitest";

import worker, { relayHosts } from "../src/worker";

const ORIGIN = "https://offeru.example.workers.dev";
const env = { ASSETS: { fetch: async (request: Request) => new Response(`asset ${new URL(request.url).pathname}`) } };

afterEach(() => vi.unstubAllGlobals());

const relay = (target: string, init: RequestInit = {}) => worker.fetch(new Request(`${ORIGIN}/llm-proxy`, {
  method: "POST",
  ...init,
  headers: { Origin: ORIGIN, "X-OfferU-LLM-URL": target, Authorization: "Bearer sk-user", ...(init.headers as Record<string, string> | undefined) },
}), env);

describe("worker", () => {
  it("serves assets, health, and 501 for data APIs", async () => {
    expect(await (await worker.fetch(new Request(`${ORIGIN}/index.html`), env)).text()).toBe("asset /index.html");
    expect(await (await worker.fetch(new Request(`${ORIGIN}/api/health`), env)).json()).toMatchObject({ runtime: "worker", storage: "none", data: "browser" });
    expect((await worker.fetch(new Request(`${ORIGIN}/api/tools/overview`), env)).status).toBe(501);
  });

  it("relays to a known provider with the user's key and nothing else", async () => {
    const upstream = vi.fn(async (_url: string, _init?: RequestInit) => new Response("data: {}\n\n", { headers: { "content-type": "text/event-stream", "set-cookie": "x=1" } }));
    vi.stubGlobal("fetch", upstream);
    const res = await relay("https://api.deepseek.com/chat/completions", { body: "{}", headers: { Cookie: "session=1", "Content-Type": "application/json" } });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    expect(res.headers.get("set-cookie")).toBeNull();
    const [url, init] = upstream.mock.calls[0];
    expect(url).toBe("https://api.deepseek.com/chat/completions");
    const sent = new Headers(init?.headers);
    expect(sent.get("authorization")).toBe("Bearer sk-user");
    expect(sent.get("cookie")).toBeNull();
  });

  it("GET only for model lists", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{\"data\":[]}")));
    expect((await relay("https://api.deepseek.com/models", { method: "GET" })).status).toBe(200);
    expect((await relay("https://api.deepseek.com/chat/completions", { method: "GET" })).status).toBe(405);
  });

  it("is not an open proxy", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("should not be called")));
    expect((await relay("https://evil.example.com/v1/chat/completions", { body: "{}" })).status).toBe(403);
    expect((await relay("http://api.deepseek.com/chat/completions", { body: "{}" })).status).toBe(400);
    expect((await relay("https://api.deepseek.com/chat/completions", { body: "{}", headers: { Origin: "https://other.example" } })).status).toBe(403);
    expect((await worker.fetch(new Request(`${ORIGIN}/llm-proxy`, { method: "POST", headers: { Origin: ORIGIN } }), env)).status).toBe(400);
    expect((await worker.fetch(new Request(`${ORIGIN}/llm-proxy`, { method: "POST", headers: { Origin: ORIGIN, "X-OfferU-LLM-URL": "https://api.deepseek.com/x" } }), { ...env, LLM_PROXY: "off" })).status).toBe(404);
  });

  it("extra hosts extend the allowlist", () => {
    expect(relayHosts().has("api.anthropic.com")).toBe(true);
    expect(relayHosts("llm.example.com, ").has("llm.example.com")).toBe(true);
  });
});
