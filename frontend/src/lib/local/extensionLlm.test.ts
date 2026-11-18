// Model calls through the OfferU browser extension, with fallback to the Worker /llm-proxy.

import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/demo/keyVault", () => ({
  encryptSecret: async (value: string) => ({ v: 1, iv: "test", data: btoa(value) }),
  decryptSecret: async (secret?: { data: string }) => (secret?.data ? atob(secret.data) : ""),
}));

import { createLlmFetch } from "./backend";
import { createExtensionLlmTransport, ExtensionUnavailableError, type ExtensionWindow } from "./extensionLlm";

const ORIGIN = "https://offeru.avabbbb.com";
const CAPS = { protocol: 1, version: "0.1.0", stream: true, abort: true, hosts: ["api.deepseek.com"], pathHosts: { "opencode.ai": ["/zen/"] } };

type Ev = Record<string, unknown>;

/** A window whose "extension" answers page messages via the handler. */
function fakeWindow(handler?: (msg: Record<string, unknown>, emit: (data: Ev) => void) => void) {
  const listeners = new Set<(event: MessageEvent) => void>();
  const sent: Array<Record<string, unknown>> = [];
  const win: ExtensionWindow = {
    location: { origin: ORIGIN },
    addEventListener: (_t, l) => { listeners.add(l); },
    removeEventListener: (_t, l) => { listeners.delete(l); },
    postMessage: (message) => {
      const msg = message as Record<string, unknown>;
      if (msg.source !== "offeru-page") return;
      sent.push(msg);
      queueMicrotask(() => handler?.(msg, emit));
    },
  };
  function emit(data: Ev) {
    const event = { data: { source: "offeru-ext", ...data }, source: win, origin: ORIGIN } as unknown as MessageEvent;
    [...listeners].forEach((l) => l(event));
  }
  const raw = (event: unknown) => [...listeners].forEach((l) => l(event as MessageEvent));
  return { win, sent, emit, raw };
}

const helloHandler = (caps: unknown = CAPS) => (msg: Record<string, unknown>, emit: (d: Ev) => void) => {
  if (msg.type === "llm-hello") emit({ type: "llm-hello-ack", id: msg.id, capabilities: caps });
};

describe("extension handshake", () => {
  it("detects a capable extension", async () => {
    const { win } = fakeWindow(helloHandler());
    const ext = createExtensionLlmTransport(win, { helloTimeoutMs: 50 });
    expect(await ext.detect()).toMatchObject({ protocol: 1, hosts: ["api.deepseek.com"] });
    expect(ext.supports(new URL("https://api.deepseek.com/chat/completions"), ext.current()!)).toBe(true);
    expect(ext.supports(new URL("https://opencode.ai/zen/v1/x"), ext.current()!)).toBe(true);
    expect(ext.supports(new URL("https://opencode.ai/other"), ext.current()!)).toBe(false);
    expect(ext.supports(new URL("https://api.openai.com/v1"), ext.current()!)).toBe(false);
  });

  it("no extension or wrong protocol → null", async () => {
    expect(await createExtensionLlmTransport(fakeWindow().win, { helloTimeoutMs: 20 }).detect()).toBeNull();
    const old = fakeWindow(helloHandler({ ...CAPS, protocol: 0 }));
    expect(await createExtensionLlmTransport(old.win, { helloTimeoutMs: 20 }).detect()).toBeNull();
  });

  it("ignores messages from other origins", async () => {
    const { win, sent, raw } = fakeWindow();
    const ext = createExtensionLlmTransport(win, { helloTimeoutMs: 30 });
    const pending = ext.detect();
    const id = sent[0].id;
    raw({ data: { source: "offeru-ext", type: "llm-hello-ack", id, capabilities: CAPS }, source: win, origin: "https://evil.example" });
    raw({ data: { source: "offeru-ext", type: "llm-hello-ack", id, capabilities: CAPS }, source: {}, origin: ORIGIN });
    expect(await pending).toBeNull();
  });
});

function streamingHandler(chunks: string[], opts: { failBeforeHead?: boolean; failAfterHead?: boolean } = {}) {
  return (msg: Record<string, unknown>, emit: (d: Ev) => void) => {
    if (msg.type === "llm-hello") return emit({ type: "llm-hello-ack", id: msg.id, capabilities: CAPS });
    if (msg.type !== "llm-request") return;
    const id = msg.id;
    const ev = (event: Ev) => emit({ type: "llm-event", id, event });
    ev({ type: "accepted" });
    if (opts.failBeforeHead) return ev({ type: "error", code: "upstream", error: "无法连接模型服务", beforeHead: true });
    ev({ type: "head", status: 200, statusText: "OK", headers: [["content-type", "text/event-stream"]] });
    chunks.forEach((data) => ev({ type: "chunk", data }));
    if (opts.failAfterHead) return ev({ type: "error", code: "upstream", error: "断了", beforeHead: false });
    ev({ type: "end" });
  };
}

describe("extension fetch", () => {
  it("streams the response and passes method/headers/body", async () => {
    const { win, sent } = fakeWindow(streamingHandler(["data: a\n\n", "data: 你好\n\n"]));
    const ext = createExtensionLlmTransport(win);
    const res = await ext.fetch("https://api.deepseek.com/chat/completions", { method: "post", headers: { Authorization: "Bearer k" }, body: "{}" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    expect(await res.text()).toBe("data: a\n\ndata: 你好\n\n");
    expect(sent[0]).toMatchObject({ type: "llm-request", method: "POST", headers: [["authorization", "Bearer k"]], body: "{}" });
  });

  it("error before head rejects with ExtensionUnavailableError", async () => {
    const { win } = fakeWindow(streamingHandler([], { failBeforeHead: true }));
    await expect(createExtensionLlmTransport(win).fetch("https://api.deepseek.com/x", { method: "POST", body: "{}" })).rejects.toBeInstanceOf(ExtensionUnavailableError);
  });

  it("no answer → ExtensionUnavailableError after the accept timeout", async () => {
    const { win, sent } = fakeWindow();
    await expect(createExtensionLlmTransport(win, { acceptTimeoutMs: 20 }).fetch("https://api.deepseek.com/x", { method: "POST", body: "{}" })).rejects.toBeInstanceOf(ExtensionUnavailableError);
    expect(sent.map((m) => m.type)).toEqual(["llm-request", "llm-abort"]);
  });

  it("error after head errors the stream (no fallback, no replay)", async () => {
    const { win } = fakeWindow(streamingHandler(["part"], { failAfterHead: true }));
    const res = await createExtensionLlmTransport(win).fetch("https://api.deepseek.com/x", { method: "POST", body: "{}" });
    await expect(res.text()).rejects.toThrow("断了");
  });

  it("abort before head rejects with AbortError and tells the extension", async () => {
    const { win, sent } = fakeWindow((msg, emit) => {
      if (msg.type === "llm-request") emit({ type: "llm-event", id: msg.id, event: { type: "accepted" } });
    });
    const controller = new AbortController();
    const pending = createExtensionLlmTransport(win).fetch("https://api.deepseek.com/x", { method: "POST", body: "{}", signal: controller.signal });
    await new Promise((r) => setTimeout(r, 5));
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(sent.at(-1)).toMatchObject({ type: "llm-abort" });
  });

  it("abort mid-stream errors the body and tells the extension", async () => {
    let emitLater: ((d: Ev) => void) | null = null;
    let reqId: unknown;
    const { win, sent } = fakeWindow((msg, emit) => {
      if (msg.type !== "llm-request") return;
      reqId = msg.id;
      emitLater = emit;
      emit({ type: "llm-event", id: msg.id, event: { type: "head", status: 200, statusText: "", headers: [] } });
    });
    const controller = new AbortController();
    const res = await createExtensionLlmTransport(win).fetch("https://api.deepseek.com/x", { method: "POST", body: "{}", signal: controller.signal });
    const reader = res.body!.getReader();
    emitLater!({ type: "llm-event", id: reqId, event: { type: "chunk", data: "x" } });
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("x");
    controller.abort();
    await expect(reader.read()).rejects.toMatchObject({ name: "AbortError" });
    expect(sent.at(-1)).toMatchObject({ type: "llm-abort" });
  });

  it("non-text bodies are not sent through the extension", async () => {
    const { win } = fakeWindow(streamingHandler([]));
    await expect(createExtensionLlmTransport(win).fetch("https://api.deepseek.com/x", { method: "POST", body: new Blob(["x"]) })).rejects.toBeInstanceOf(ExtensionUnavailableError);
  });
});

describe("llmFetch with the extension", () => {
  const corsFailing = () => vi.fn(async (input: string) => {
    if (String(input).startsWith("https://")) throw new TypeError("Failed to fetch");
    return new Response("relayed");
  });

  it("a no-CORS host goes through the extension, not /llm-proxy", async () => {
    const base = corsFailing();
    const { win } = fakeWindow(streamingHandler(["via extension"]));
    const llmFetch = createLlmFetch(base as never, "/llm-proxy", createExtensionLlmTransport(win));
    const res = await llmFetch("https://api.deepseek.com/chat/completions", { method: "POST", body: "{}" });
    expect(await res.text()).toBe("via extension");
    expect(base.mock.calls.map((c) => c[0])).toEqual(["https://api.deepseek.com/chat/completions"]);
    // later calls skip the direct attempt and still avoid the Worker
    expect(await (await llmFetch("https://api.deepseek.com/chat/completions", { method: "POST", body: "{}" })).text()).toBe("via extension");
    expect(base).toHaveBeenCalledTimes(1);
  });

  it("falls back to /llm-proxy when the extension fails before the first byte", async () => {
    const base = corsFailing();
    const { win } = fakeWindow(streamingHandler([], { failBeforeHead: true }));
    const llmFetch = createLlmFetch(base as never, "/llm-proxy", createExtensionLlmTransport(win));
    expect(await (await llmFetch("https://api.deepseek.com/chat/completions", { method: "POST", body: "{}" })).text()).toBe("relayed");
    expect(base.mock.calls[1][0]).toBe("/llm-proxy");
  });

  it("falls back to /llm-proxy without an extension, or for hosts outside its allowlist", async () => {
    const base = corsFailing();
    const none = createExtensionLlmTransport(fakeWindow().win, { helloTimeoutMs: 10 });
    expect(await (await createLlmFetch(base as never, "/llm-proxy", none)("https://api.deepseek.com/x", { method: "POST", body: "{}" })).text()).toBe("relayed");
    const base2 = corsFailing();
    const { win, sent } = fakeWindow(streamingHandler(["x"]));
    const llmFetch = createLlmFetch(base2 as never, "/llm-proxy", createExtensionLlmTransport(win));
    expect(await (await llmFetch("https://api.openai.com/v1/chat/completions", { method: "POST", body: "{}" })).text()).toBe("relayed");
    expect(sent.some((m) => m.type === "llm-request")).toBe(false);
  });

  it("a user abort does not fall back", async () => {
    const base = corsFailing();
    const { win } = fakeWindow((msg, emit) => {
      if (msg.type === "llm-hello") emit({ type: "llm-hello-ack", id: msg.id, capabilities: CAPS });
      if (msg.type === "llm-request") emit({ type: "llm-event", id: msg.id, event: { type: "accepted" } });
    });
    const controller = new AbortController();
    const llmFetch = createLlmFetch(base as never, "/llm-proxy", createExtensionLlmTransport(win));
    const pending = llmFetch("https://api.deepseek.com/x", { method: "POST", body: "{}", signal: controller.signal });
    await new Promise((r) => setTimeout(r, 10));
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(base.mock.calls.some((c) => c[0] === "/llm-proxy")).toBe(false);
  });
});
