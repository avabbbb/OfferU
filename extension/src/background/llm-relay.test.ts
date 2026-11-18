import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  handleRelayPort,
  isOfferUOrigin,
  isRelayTargetAllowed,
  LLM_RELAY_HOSTS,
  LLM_RELAY_PATH_HOSTS,
  LLM_RELAY_PORT_NAME,
  llmRelayHostPermissions,
  validateRelayRequest,
  type RelayIn,
  type RelayOut,
  type RelayPort,
} from "./llm-relay";

const last = <T>(list: T[]): T | undefined => list[list.length - 1];

const ROOT = resolve(__dirname, "../../..");

describe("relay allowlist", () => {
  it("matches the Worker: PROVIDER_PRESETS https hosts + Anthropic, OpenCode by path", () => {
    const presets = readFileSync(resolve(ROOT, "packages/core/src/llm-presets.ts"), "utf8");
    const hosts = new Set(["api.anthropic.com"]);
    for (const match of presets.matchAll(/"default_base_url":\s*"([^"]*)"/g)) {
      if (match[1].startsWith("https://")) hosts.add(new URL(match[1]).hostname);
    }
    expect(new Set(LLM_RELAY_HOSTS)).toEqual(hosts);

    const worker = readFileSync(resolve(ROOT, "backend-ts/src/worker.ts"), "utf8");
    expect(worker).toContain('"opencode.ai": ["/zen/", "/inference/"]');
    expect(LLM_RELAY_PATH_HOSTS).toEqual({ "opencode.ai": ["/zen/", "/inference/"] });
  });

  it("host_permissions are exactly the relay hosts (no wildcards)", () => {
    const perms = llmRelayHostPermissions();
    expect(perms).toContain("https://api.deepseek.com/*");
    expect(perms).toContain("https://opencode.ai/*");
    expect(perms.every((perm) => /^https:\/\/[a-z0-9.-]+\/\*$/.test(perm))).toBe(true);
    expect(perms.some((perm) => perm.includes("*.") || perm.includes("<all_urls>"))).toBe(false);
  });

  it("allows only https built-in hosts, OpenCode only under its paths", () => {
    expect(isRelayTargetAllowed(new URL("https://api.deepseek.com/chat/completions"))).toBe(true);
    expect(isRelayTargetAllowed(new URL("https://API.OpenAI.com/v1/models"))).toBe(true);
    expect(isRelayTargetAllowed(new URL("https://opencode.ai/zen/v1/chat/completions"))).toBe(true);
    expect(isRelayTargetAllowed(new URL("https://opencode.ai/auth/login"))).toBe(false);
    expect(isRelayTargetAllowed(new URL("http://api.deepseek.com/chat/completions"))).toBe(false);
    expect(isRelayTargetAllowed(new URL("https://evil.example.com/v1"))).toBe(false);
    expect(isRelayTargetAllowed(new URL("https://api.deepseek.com.evil.com/v1"))).toBe(false);
    expect(isRelayTargetAllowed(new URL("https://user:pw@api.deepseek.com/v1"))).toBe(false);
    expect(isRelayTargetAllowed(new URL("https://api.deepseek.com:8443/v1"))).toBe(false);
  });

  it("validates method, GET only for models, header allowlist, body size", () => {
    expect(validateRelayRequest({ type: "start", url: "https://api.openai.com/v1/models", method: "GET" }).ok).toBe(true);
    expect(validateRelayRequest({ type: "start", url: "https://api.openai.com/v1/chat/completions", method: "GET" })).toMatchObject({ ok: false });
    expect(validateRelayRequest({ type: "start", url: "https://api.openai.com/v1/x", method: "DELETE" })).toMatchObject({ ok: false });
    expect(validateRelayRequest({ type: "start", url: "not a url" })).toMatchObject({ ok: false, code: "invalid" });
    expect(validateRelayRequest({ type: "start", url: "https://evil.example/v1" })).toMatchObject({ ok: false, code: "forbidden" });
    const big = validateRelayRequest({ type: "start", url: "https://api.openai.com/v1/chat/completions", method: "POST", body: "x".repeat(8 * 1024 * 1024 + 1) });
    expect(big).toMatchObject({ ok: false });
    const ok = validateRelayRequest({
      type: "start",
      url: "https://api.openai.com/v1/chat/completions",
      method: "post",
      headers: [["Authorization", "Bearer k"], ["Cookie", "a=b"], ["X-Forwarded-For", "1.2.3.4"], ["Content-Type", "application/json"]],
      body: "{}",
    });
    expect(ok).toEqual({ ok: true, request: { url: "https://api.openai.com/v1/chat/completions", method: "POST", headers: { authorization: "Bearer k", "content-type": "application/json" }, body: "{}" } });
  });
});

describe("origin check", () => {
  it("accepts OfferU production and localhost dev only", () => {
    expect(isOfferUOrigin("https://offeru.avabbbb.com")).toBe(true);
    expect(isOfferUOrigin("http://localhost:7410")).toBe(true);
    expect(isOfferUOrigin("http://127.0.0.1:8787")).toBe(true);
    expect(isOfferUOrigin("http://localhost")).toBe(true);
    expect(isOfferUOrigin("http://offeru.avabbbb.com")).toBe(false);
    expect(isOfferUOrigin("https://evil.avabbbb.com")).toBe(false);
    expect(isOfferUOrigin("https://offeru.avabbbb.com.evil.com")).toBe(false);
    expect(isOfferUOrigin("http://localhost.evil.com")).toBe(false);
    expect(isOfferUOrigin("https://localhost:7410")).toBe(false);
    expect(isOfferUOrigin("")).toBe(false);
    expect(isOfferUOrigin(undefined)).toBe(false);
  });
});

function fakePort(sender: RelayPort["sender"], name = LLM_RELAY_PORT_NAME) {
  const out: RelayOut[] = [];
  let onMessage: ((message: RelayIn) => void) | null = null;
  let onDisconnect: (() => void) | null = null;
  const port: RelayPort & { disconnected: boolean } = {
    name,
    sender,
    disconnected: false,
    postMessage: (message) => { out.push(message); },
    disconnect: () => { port.disconnected = true; },
    onMessage: { addListener: (listener) => { onMessage = listener; } },
    onDisconnect: { addListener: (listener) => { onDisconnect = listener; } },
  };
  return {
    port,
    out,
    send: (message: RelayIn) => onMessage?.(message),
    drop: () => onDisconnect?.(),
  };
}

const OFFERU_SENDER = { id: "ext", origin: "https://offeru.avabbbb.com", url: "https://offeru.avabbbb.com/settings", frameId: 0 };
const until = async (check: () => boolean) => {
  for (let i = 0; i < 100 && !check(); i += 1) await new Promise((r) => setTimeout(r, 2));
};

describe("relay port", () => {
  it("rejects ports from non-OfferU pages before any fetch", () => {
    const fetchMock = vi.fn();
    const { port, out } = fakePort({ id: "ext", origin: "https://evil.example", url: "https://evil.example/" });
    handleRelayPort(port, { fetch: fetchMock as never, extensionId: "ext" });
    expect(out).toEqual([{ type: "error", code: "forbidden", error: "只接受 OfferU 网页的请求", beforeHead: true }]);
    expect(port.disconnected).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects other extensions and ignores foreign port names", () => {
    const fetchMock = vi.fn();
    const other = fakePort({ ...OFFERU_SENDER, id: "someone-else" });
    handleRelayPort(other.port, { fetch: fetchMock as never, extensionId: "ext" });
    expect(other.out[0]).toMatchObject({ type: "error", code: "forbidden" });
    const foreign = fakePort(OFFERU_SENDER, "something-else");
    handleRelayPort(foreign.port, { fetch: fetchMock as never, extensionId: "ext" });
    expect(foreign.out).toEqual([]);
  });

  it("refuses disallowed targets with an error before head", () => {
    const fetchMock = vi.fn();
    const p = fakePort(OFFERU_SENDER);
    handleRelayPort(p.port, { fetch: fetchMock as never, extensionId: "ext" });
    p.send({ type: "start", url: "https://evil.example/v1/chat/completions", method: "POST", body: "{}" });
    expect(p.out[0]).toMatchObject({ type: "error", code: "forbidden", beforeHead: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("streams the upstream body back chunk by chunk with filtered headers", async () => {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("data: {\"a\":1}\n\n"));
        // a multi-byte character split across chunks must survive decoding
        const bytes = encoder.encode("data: 你好\n\n");
        controller.enqueue(bytes.slice(0, 8));
        controller.enqueue(bytes.slice(8));
        controller.close();
      },
    });
    const fetchMock = vi.fn(async () => new Response(body, { status: 200, headers: { "content-type": "text/event-stream", "set-cookie": "x=y", "x-request-id": "r1" } }));
    const p = fakePort(OFFERU_SENDER);
    handleRelayPort(p.port, { fetch: fetchMock as never, extensionId: "ext" });
    p.send({ type: "start", url: "https://api.deepseek.com/chat/completions", method: "POST", headers: [["authorization", "Bearer k"]], body: "{}" });
    await until(() => p.out.some((m) => m.type === "end"));
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(init).toMatchObject({ method: "POST", redirect: "manual", credentials: "omit", body: "{}" });
    expect(p.out[0]).toEqual({ type: "accepted" });
    expect(p.out[1]).toEqual({ type: "head", status: 200, statusText: "", headers: [["content-type", "text/event-stream"], ["x-request-id", "r1"]] });
    const text = p.out.filter((m) => m.type === "chunk").map((m) => (m as { data: string }).data).join("");
    expect(text).toBe("data: {\"a\":1}\n\ndata: 你好\n\n");
    expect(last(p.out)).toEqual({ type: "end" });
  });

  it("aborts the upstream fetch when the page disconnects or sends abort", async () => {
    for (const how of ["drop", "abort"] as const) {
      let signal: AbortSignal | undefined;
      const fetchMock = vi.fn((_url: string, init: RequestInit) => {
        signal = init.signal ?? undefined;
        return new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        });
      });
      const p = fakePort(OFFERU_SENDER);
      handleRelayPort(p.port, { fetch: fetchMock as never, extensionId: "ext" });
      p.send({ type: "start", url: "https://api.openai.com/v1/chat/completions", method: "POST", body: "{}" });
      await until(() => fetchMock.mock.calls.length > 0);
      if (how === "drop") p.drop();
      else p.send({ type: "abort" });
      expect(signal?.aborted).toBe(true);
    }
  });

  it("reports network failures before head without leaking details", async () => {
    const fetchMock = vi.fn(async () => { throw new TypeError("Failed to fetch https://api.openai.com/?key=sk-secretsecret"); });
    const p = fakePort(OFFERU_SENDER);
    handleRelayPort(p.port, { fetch: fetchMock as never, extensionId: "ext" });
    p.send({ type: "start", url: "https://api.openai.com/v1/chat/completions", method: "POST", body: "{}" });
    await until(() => p.out.some((m) => m.type === "error"));
    expect(last(p.out)).toEqual({ type: "error", code: "upstream", error: "无法连接模型服务", beforeHead: true });
    expect(JSON.stringify(p.out)).not.toContain("sk-secret");
  });

  it("does not follow redirects", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 302, headers: { location: "https://evil.example/" } }));
    const p = fakePort(OFFERU_SENDER);
    handleRelayPort(p.port, { fetch: fetchMock as never, extensionId: "ext" });
    p.send({ type: "start", url: "https://api.openai.com/v1/chat/completions", method: "POST", body: "{}" });
    await until(() => p.out.some((m) => m.type === "error"));
    expect(last(p.out)).toMatchObject({ type: "error", beforeHead: true });
  });
});
