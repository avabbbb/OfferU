// Model calls carried by the OfferU browser extension (extension/src/content/llm-bridge.ts →
// extension/src/background/llm-relay.ts) instead of the Cloudflare Worker's /llm-proxy.
//
// The page and the extension's content script share the window: we post
// { source: "offeru-page", ... } and listen for { source: "offeru-ext", ... }. A capability
// handshake ("llm-hello") tells us the extension is there, which protocol it speaks and which
// hosts it may reach (the same allowlist as the Worker). Each request streams back as
// head → chunk* → end, or error; `beforeHead` errors are reported as
// ExtensionUnavailableError so the caller can fall back to /llm-proxy.
// Nothing here logs request contents or keys.

export const EXT_PROTOCOL = 1;
const PAGE_SOURCE = "offeru-page";
const EXT_SOURCE = "offeru-ext";
/** No "accepted" within this window → the extension is not answering; fall back. */
const ACCEPT_TIMEOUT_MS = 4000;
const HELLO_TIMEOUT_MS = 1500;

export interface ExtensionCapabilities {
  protocol: number;
  version: string;
  stream: boolean;
  abort: boolean;
  hosts: string[];
  pathHosts: Record<string, string[]>;
}

/** The extension could not take the request (missing, refused, or failed before any byte). */
export class ExtensionUnavailableError extends Error {
  constructor(message: string, readonly code = "unavailable") {
    super(message);
    this.name = "ExtensionUnavailableError";
  }
}

export interface ExtensionWindow {
  location: { origin: string };
  addEventListener(type: "message", listener: (event: MessageEvent) => void): void;
  removeEventListener(type: "message", listener: (event: MessageEvent) => void): void;
  postMessage(message: unknown, targetOrigin: string): void;
}

export interface ExtensionLlmTransport {
  /** Handshake result (cached); null when no capable extension answered. */
  detect(): Promise<ExtensionCapabilities | null>;
  /** Last handshake result without waiting. */
  current(): ExtensionCapabilities | null;
  /** True when the extension may reach this URL (its allowlist). */
  supports(url: URL, caps: ExtensionCapabilities): boolean;
  fetch(url: string, init?: RequestInit): Promise<Response>;
  /** Subscribe to capability changes (extension installed / reloaded). */
  subscribe(listener: () => void): () => void;
}

let seq = 0;
const nextId = () => `llm-${Date.now().toString(36)}-${(seq += 1)}-${Math.random().toString(36).slice(2, 8)}`;

function capable(value: unknown): ExtensionCapabilities | null {
  const caps = value as Partial<ExtensionCapabilities> | null;
  if (!caps || caps.protocol !== EXT_PROTOCOL || !caps.stream || !caps.abort || !Array.isArray(caps.hosts)) return null;
  return { protocol: caps.protocol, version: String(caps.version || ""), stream: true, abort: true, hosts: caps.hosts.map(String), pathHosts: caps.pathHosts || {} };
}

function headerPairs(headers: HeadersInit | undefined): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  new Headers(headers).forEach((value, name) => out.push([name, value]));
  return out;
}

function abortError(): Error {
  try {
    return new DOMException("The operation was aborted.", "AbortError");
  } catch {
    const error = new Error("The operation was aborted.");
    error.name = "AbortError";
    return error;
  }
}

export function createExtensionLlmTransport(win: ExtensionWindow, options: { helloTimeoutMs?: number; acceptTimeoutMs?: number } = {}): ExtensionLlmTransport {
  const helloTimeout = options.helloTimeoutMs ?? HELLO_TIMEOUT_MS;
  const acceptTimeout = options.acceptTimeoutMs ?? ACCEPT_TIMEOUT_MS;
  const origin = win.location.origin;
  let caps: ExtensionCapabilities | null = null;
  let pending: Promise<ExtensionCapabilities | null> | null = null;
  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach((listener) => { try { listener(); } catch { /* ignore */ } });

  const post = (message: Record<string, unknown>) => win.postMessage({ source: PAGE_SOURCE, ...message }, origin);
  const fromExtension = (event: MessageEvent): Record<string, unknown> | null => {
    if (event.source !== (win as unknown) || event.origin !== origin) return null;
    const data = event.data as Record<string, unknown> | null;
    return data && data.source === EXT_SOURCE ? data : null;
  };

  // The content script announces itself when it loads (possibly after our first hello).
  win.addEventListener("message", (event) => {
    const data = fromExtension(event);
    if (data?.type !== "llm-ready") return;
    pending = null;
    void detect();
  });

  function detect(): Promise<ExtensionCapabilities | null> {
    if (pending) return pending;
    pending = new Promise((resolve) => {
      const id = nextId();
      const done = (result: ExtensionCapabilities | null) => {
        win.removeEventListener("message", onMessage);
        clearTimeout(timer);
        const changed = (result === null) !== (caps === null);
        caps = result;
        if (changed) notify();
        resolve(result);
      };
      const onMessage = (event: MessageEvent) => {
        const data = fromExtension(event);
        if (data?.type === "llm-hello-ack" && data.id === id) done(capable(data.capabilities));
      };
      const timer = setTimeout(() => done(null), helloTimeout);
      win.addEventListener("message", onMessage);
      post({ type: "llm-hello", id });
    });
    return pending;
  }

  function supports(url: URL, current: ExtensionCapabilities): boolean {
    if (url.protocol !== "https:") return false;
    const host = url.hostname.toLowerCase();
    if (current.hosts.includes(host)) return true;
    return (current.pathHosts[host] || []).some((prefix) => url.pathname.startsWith(prefix));
  }

  function fetchViaExtension(url: string, init: RequestInit = {}): Promise<Response> {
    const signal = init.signal;
    if (signal?.aborted) return Promise.reject(abortError());
    const body = init.body;
    if (body != null && typeof body !== "string") {
      return Promise.reject(new ExtensionUnavailableError("扩展只转发文本请求体", "unsupported"));
    }
    const id = nextId();
    return new Promise<Response>((resolve, reject) => {
      let settled = false;
      let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
      const encoder = new TextEncoder();
      const cleanup = () => {
        win.removeEventListener("message", onMessage);
        signal?.removeEventListener("abort", onAbort);
        clearTimeout(acceptTimer);
      };
      const failBeforeHead = (error: Error) => {
        cleanup();
        if (!settled) { settled = true; reject(error); }
      };
      const onAbort = () => {
        post({ type: "llm-abort", id });
        const error = abortError();
        if (!settled) { settled = true; cleanup(); reject(error); return; }
        cleanup();
        try { controller?.error(error); } catch { /* closed */ }
      };
      const acceptTimer = setTimeout(() => {
        post({ type: "llm-abort", id });
        failBeforeHead(new ExtensionUnavailableError("扩展未响应"));
      }, acceptTimeout);

      const onMessage = (event: MessageEvent) => {
        const data = fromExtension(event);
        if (!data || data.type !== "llm-event" || data.id !== id) return;
        const ev = data.event as { type: string; [key: string]: unknown };
        if (ev.type === "accepted") { clearTimeout(acceptTimer); return; }
        if (ev.type === "head") {
          clearTimeout(acceptTimer);
          const stream = new ReadableStream<Uint8Array>({
            start(c) { controller = c; },
            cancel() { post({ type: "llm-abort", id }); cleanup(); },
          });
          const status = Number(ev.status) || 502;
          const nullBody = status === 204 || status === 205 || status === 304;
          settled = true;
          resolve(new Response(nullBody ? null : stream, {
            status,
            statusText: String(ev.statusText || ""),
            headers: new Headers((ev.headers as Array<[string, string]>) || []),
          }));
          return;
        }
        if (ev.type === "chunk") {
          try { controller?.enqueue(encoder.encode(String(ev.data ?? ""))); } catch { /* cancelled */ }
          return;
        }
        if (ev.type === "end") {
          cleanup();
          try { controller?.close(); } catch { /* cancelled */ }
          return;
        }
        if (ev.type === "error") {
          const message = String(ev.error || "扩展转发失败");
          if (!settled) {
            failBeforeHead(new ExtensionUnavailableError(message, String(ev.code || "unavailable")));
            return;
          }
          cleanup();
          try { controller?.error(new TypeError(message)); } catch { /* cancelled */ }
        }
      };
      win.addEventListener("message", onMessage);
      signal?.addEventListener("abort", onAbort, { once: true });
      post({
        type: "llm-request",
        id,
        url,
        method: (init.method || "GET").toUpperCase(),
        headers: headerPairs(init.headers),
        body: typeof body === "string" ? body : null,
      });
    });
  }

  return {
    detect,
    current: () => caps,
    supports,
    fetch: fetchViaExtension,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
