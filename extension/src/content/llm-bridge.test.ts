import { describe, expect, it, vi } from "vitest";

import type { RelayOut } from "../background/llm-relay";
import { installLlmBridge, type BridgeRuntime, type BridgeWindow } from "./llm-bridge";

const last = <T>(list: T[]): T | undefined => list[list.length - 1];

function fakeWindow(origin: string, top?: unknown) {
  const listeners: Array<(event: MessageEvent) => void> = [];
  const posted: Array<{ message: Record<string, unknown>; targetOrigin: string }> = [];
  const win: BridgeWindow & { fromPage(data: unknown, opts?: { source?: unknown; origin?: string }): void } = {
    location: { origin },
    top: undefined,
    addEventListener: (_type, listener) => { listeners.push(listener); },
    postMessage: (message, targetOrigin) => { posted.push({ message: message as Record<string, unknown>, targetOrigin }); },
    fromPage(data, opts = {}) {
      const event = { data, source: "source" in opts ? opts.source : win, origin: opts.origin ?? origin } as unknown as MessageEvent;
      listeners.forEach((listener) => listener(event));
    },
  };
  win.top = top === undefined ? win : top;
  return { win, posted };
}

function fakeRuntime() {
  const ports: Array<{
    sent: unknown[];
    disconnected: boolean;
    emit(message: RelayOut): void;
    drop(): void;
  }> = [];
  const runtime: BridgeRuntime = {
    connect: vi.fn(() => {
      let onMessage: ((m: RelayOut) => void) | null = null;
      let onDisconnect: (() => void) | null = null;
      const entry = {
        sent: [] as unknown[],
        disconnected: false,
        emit: (m: RelayOut) => onMessage?.(m),
        drop: () => onDisconnect?.(),
      };
      ports.push(entry);
      return {
        postMessage: (m: unknown) => { entry.sent.push(m); },
        disconnect: () => { entry.disconnected = true; },
        onMessage: { addListener: (l: (m: RelayOut) => void) => { onMessage = l; } },
        onDisconnect: { addListener: (l: () => void) => { onDisconnect = l; } },
      };
    }),
    sendMessage: vi.fn((_message: unknown, callback: (response: unknown) => void) => callback({ ok: true, capabilities: { protocol: 1 } })),
    lastError: () => undefined,
  };
  return { runtime, ports };
}

describe("page bridge", () => {
  it("is not installed on other sites or in iframes", () => {
    const { runtime } = fakeRuntime();
    expect(installLlmBridge(fakeWindow("https://www.zhipin.com").win, runtime)).toBe(false);
    expect(installLlmBridge(fakeWindow("https://offeru.avabbbb.com", {}).win, runtime)).toBe(false);
  });

  it("announces itself and answers the handshake to the page origin only", () => {
    const { win, posted } = fakeWindow("https://offeru.avabbbb.com");
    const { runtime } = fakeRuntime();
    expect(installLlmBridge(win, runtime)).toBe(true);
    expect(posted[0]).toEqual({ message: { source: "offeru-ext", type: "llm-ready" }, targetOrigin: "https://offeru.avabbbb.com" });
    win.fromPage({ source: "offeru-page", type: "llm-hello", id: "h1" });
    expect(posted[1].message).toEqual({ source: "offeru-ext", type: "llm-hello-ack", id: "h1", capabilities: { protocol: 1 } });
  });

  it("ignores messages from other windows / origins", () => {
    const { win, posted } = fakeWindow("http://localhost:7410");
    const { runtime } = fakeRuntime();
    installLlmBridge(win, runtime);
    win.fromPage({ source: "offeru-page", type: "llm-request", id: "r1", url: "https://api.openai.com/v1/x" }, { source: {} });
    win.fromPage({ source: "offeru-page", type: "llm-request", id: "r1", url: "https://api.openai.com/v1/x" }, { origin: "https://evil.example" });
    expect(runtime.connect).not.toHaveBeenCalled();
    expect(posted).toHaveLength(1);
  });

  it("relays a request over its own port and forwards events; abort disconnects", () => {
    const { win, posted } = fakeWindow("https://offeru.avabbbb.com");
    const { runtime, ports } = fakeRuntime();
    installLlmBridge(win, runtime);
    win.fromPage({ source: "offeru-page", type: "llm-request", id: "r1", url: "https://api.openai.com/v1/chat/completions", method: "POST", headers: [["authorization", "Bearer k"]], body: "{}" });
    expect(ports[0].sent[0]).toEqual({ type: "start", url: "https://api.openai.com/v1/chat/completions", method: "POST", headers: [["authorization", "Bearer k"]], body: "{}" });
    ports[0].emit({ type: "head", status: 200, statusText: "", headers: [] });
    ports[0].emit({ type: "chunk", data: "hi" });
    expect(posted.slice(1).map((p) => (p.message.event as RelayOut).type)).toEqual(["head", "chunk"]);
    win.fromPage({ source: "offeru-page", type: "llm-abort", id: "r1" });
    expect(last(ports[0].sent)).toEqual({ type: "abort" });
    expect(ports[0].disconnected).toBe(true);
  });

  it("a dropped port becomes an error event, flagged by whether the head arrived", () => {
    const { win, posted } = fakeWindow("https://offeru.avabbbb.com");
    const { runtime, ports } = fakeRuntime();
    installLlmBridge(win, runtime);
    win.fromPage({ source: "offeru-page", type: "llm-request", id: "a", url: "u" });
    ports[0].drop();
    expect(last(posted)?.message.event).toMatchObject({ type: "error", beforeHead: true });
    win.fromPage({ source: "offeru-page", type: "llm-request", id: "b", url: "u" });
    ports[1].emit({ type: "head", status: 200, statusText: "", headers: [] });
    ports[1].drop();
    expect(last(posted)?.message.event).toMatchObject({ type: "error", beforeHead: false });
  });
});
