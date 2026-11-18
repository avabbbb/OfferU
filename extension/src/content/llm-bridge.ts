// Page <-> extension bridge for the LLM relay (see src/background/llm-relay.ts).
//
// Runs in the content script, but only on OfferU origins (https://offeru.avabbbb.com and
// localhost dev) and only in the top frame. The page talks to it with window.postMessage on
// its own window; every request gets its own long-lived runtime port to the background so
// a streamed answer can flow chunk by chunk and an abort reaches the upstream fetch.
//
// Page -> bridge  { source: "offeru-page", type: "llm-hello", id }
//                 { source: "offeru-page", type: "llm-request", id, url, method, headers, body }
//                 { source: "offeru-page", type: "llm-abort", id }
// Bridge -> page  { source: "offeru-ext", type: "llm-ready" }            (on install)
//                 { source: "offeru-ext", type: "llm-hello-ack", id, capabilities }
//                 { source: "offeru-ext", type: "llm-event", id, event }  (RelayOut)
// Nothing here logs request contents.

import { isOfferUOrigin, LLM_RELAY_PORT_NAME, type RelayOut } from "../background/llm-relay.js";

export const PAGE_SOURCE = "offeru-page";
export const EXT_SOURCE = "offeru-ext";
const KEEPALIVE_MS = 20_000;

interface PortLike {
  postMessage(message: unknown): void;
  disconnect(): void;
  onMessage: { addListener(listener: (message: RelayOut) => void): void };
  onDisconnect: { addListener(listener: () => void): void };
}

export interface BridgeRuntime {
  connect(info: { name: string }): PortLike;
  sendMessage(message: unknown, callback: (response: unknown) => void): void;
  lastError(): unknown;
}

export interface BridgeWindow {
  location: { origin: string };
  top: unknown;
  addEventListener(type: "message", listener: (event: MessageEvent) => void): void;
  postMessage(message: unknown, targetOrigin: string): void;
}

/** Install the bridge; returns false (and does nothing) outside OfferU top frames. */
export function installLlmBridge(win: BridgeWindow, runtime: BridgeRuntime): boolean {
  const origin = win.location.origin;
  if (!isOfferUOrigin(origin) || win.top !== win) return false;
  const ports = new Map<string, { port: PortLike; timer: ReturnType<typeof setInterval> }>();
  const reply = (message: Record<string, unknown>): void => win.postMessage({ source: EXT_SOURCE, ...message }, origin);

  const close = (id: string): void => {
    const entry = ports.get(id);
    if (!entry) return;
    clearInterval(entry.timer);
    ports.delete(id);
  };

  win.addEventListener("message", (event: MessageEvent) => {
    if (event.source !== win || event.origin !== origin) return;
    const data = event.data as Record<string, unknown> | null;
    if (!data || data.source !== PAGE_SOURCE || typeof data.id !== "string") return;
    const id = data.id;

    if (data.type === "llm-hello") {
      runtime.sendMessage({ type: "OFFERU_LLM_HELLO" }, (response) => {
        void runtime.lastError();
        const caps = (response as { ok?: boolean; capabilities?: unknown } | undefined);
        if (caps?.ok && caps.capabilities) reply({ type: "llm-hello-ack", id, capabilities: caps.capabilities });
      });
      return;
    }

    if (data.type === "llm-abort") {
      const entry = ports.get(id);
      if (!entry) return;
      try { entry.port.postMessage({ type: "abort" }); } catch { /* gone */ }
      try { entry.port.disconnect(); } catch { /* gone */ }
      close(id);
      return;
    }

    if (data.type === "llm-request" && !ports.has(id)) {
      let port: PortLike;
      try {
        port = runtime.connect({ name: LLM_RELAY_PORT_NAME });
      } catch {
        reply({ type: "llm-event", id, event: { type: "error", code: "unavailable", error: "扩展不可用", beforeHead: true } });
        return;
      }
      // Messages to the service worker keep it alive during long silent model thinking.
      const timer = setInterval(() => {
        try { port.postMessage({ type: "ping" }); } catch { /* gone */ }
      }, KEEPALIVE_MS);
      ports.set(id, { port, timer });
      let finished = false;
      let headSeen = false;
      port.onMessage.addListener((event) => {
        if (event.type === "head") headSeen = true;
        reply({ type: "llm-event", id, event });
        if (event.type === "end" || event.type === "error") {
          finished = true;
          close(id);
        }
      });
      port.onDisconnect.addListener(() => {
        void runtime.lastError();
        if (!finished && ports.has(id)) {
          reply({ type: "llm-event", id, event: { type: "error", code: "unavailable", error: "扩展连接已断开", beforeHead: !headSeen } });
        }
        close(id);
      });
      port.postMessage({
        type: "start",
        url: data.url,
        method: data.method,
        headers: data.headers,
        body: data.body,
      });
    }
  });

  reply({ type: "llm-ready" });
  return true;
}
