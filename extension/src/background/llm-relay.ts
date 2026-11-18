// LLM relay inside the extension: the OfferU web page hands model calls to the extension
// instead of the Cloudflare Worker's /llm-proxy (which spends the Workers daily quota).
//
// Same rules as backend-ts/src/worker.ts relayLlm():
//   - only https targets, no credentials in the URL, only the built-in provider hosts
//     (plus OpenCode's /zen/ and /inference/ paths) — never an open relay;
//   - POST for completions, GET only for .../models;
//   - only a fixed set of request/response headers is forwarded; body ≤ 8 MB;
//   - redirects are not followed.
// Additionally only the OfferU pages (https://offeru.avabbbb.com, localhost dev) may ask.
// Nothing here logs URLs' query strings, headers, keys or bodies.
//
// Keep LLM_RELAY_HOSTS in sync with the Worker (PROVIDER_PRESETS https hosts + Anthropic);
// llm-relay.test.ts reads packages/core/src/llm-presets.ts and fails when they drift.
// wxt.config.ts derives host_permissions from this list, so it must stay pure (no chrome.*).

export const LLM_RELAY_PROTOCOL = 1;
export const LLM_RELAY_PORT_NAME = "offeru-llm-relay";

export const LLM_RELAY_HOSTS: readonly string[] = [
  "api.anthropic.com",
  "api.deepseek.com",
  "api.openai.com",
  "dashscope.aliyuncs.com",
  "api.siliconflow.com",
  "generativelanguage.googleapis.com",
  "open.bigmodel.cn",
  "api.moonshot.cn",
  "api.groq.com",
  "openrouter.ai",
];

/** Gateways allowed only under some paths (mirrors RELAY_PATH_HOSTS in the Worker). */
export const LLM_RELAY_PATH_HOSTS: Readonly<Record<string, readonly string[]>> = {
  "opencode.ai": ["/zen/", "/inference/"],
};

/** host_permissions for the manifest: exactly the relay hosts, nothing broader. */
export function llmRelayHostPermissions(): string[] {
  return [...LLM_RELAY_HOSTS, ...Object.keys(LLM_RELAY_PATH_HOSTS)].map((host) => `https://${host}/*`);
}

export const OFFERU_WEB_ORIGINS: readonly string[] = ["https://offeru.avabbbb.com"];
const LOCAL_DEV_ORIGIN = /^http:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?$/;

/** True for the OfferU web app origins (production + localhost / 127.0.0.1 dev on any port). */
export function isOfferUOrigin(origin: string | undefined | null): boolean {
  if (!origin) return false;
  return OFFERU_WEB_ORIGINS.includes(origin) || LOCAL_DEV_ORIGIN.test(origin);
}

export function isRelayTargetAllowed(target: URL): boolean {
  if (target.protocol !== "https:" || target.username || target.password) return false;
  if (target.port && target.port !== "443") return false;
  const host = target.hostname.toLowerCase();
  if (LLM_RELAY_HOSTS.includes(host)) return true;
  const prefixes = LLM_RELAY_PATH_HOSTS[host];
  return !!prefixes && prefixes.some((prefix) => target.pathname.startsWith(prefix));
}

export const FORWARD_REQUEST_HEADERS = ["authorization", "x-api-key", "anthropic-version", "anthropic-beta", "content-type", "accept"];
export const FORWARD_RESPONSE_HEADERS = ["content-type", "cache-control", "retry-after", "x-request-id", "request-id"];
export const MAX_RELAY_BODY_CHARS = 8 * 1024 * 1024;

export interface RelayStart {
  type: "start";
  url: string;
  method?: string;
  headers?: Array<[string, string]>;
  body?: string | null;
}

export interface ValidRelayRequest {
  url: string;
  method: "GET" | "POST";
  headers: Record<string, string>;
  body: string | undefined;
}

export type RelayValidation = { ok: true; request: ValidRelayRequest } | { ok: false; code: string; error: string };

export function validateRelayRequest(start: RelayStart): RelayValidation {
  let target: URL;
  try {
    target = new URL(String(start.url || ""));
  } catch {
    return { ok: false, code: "invalid", error: "目标地址无效" };
  }
  const method = String(start.method || "POST").toUpperCase();
  if (method !== "POST" && method !== "GET") return { ok: false, code: "invalid", error: "只支持 POST / GET" };
  if (!isRelayTargetAllowed(target)) {
    return { ok: false, code: "forbidden", error: `不转发到 ${target.hostname}：只支持内置的模型服务商` };
  }
  if (method === "GET" && !/\/models\/?$/.test(target.pathname)) {
    return { ok: false, code: "invalid", error: "GET 只用于获取模型列表" };
  }
  const body = method === "POST" && typeof start.body === "string" ? start.body : undefined;
  if (body && body.length > MAX_RELAY_BODY_CHARS) return { ok: false, code: "invalid", error: "请求体太大" };
  const headers: Record<string, string> = {};
  for (const pair of Array.isArray(start.headers) ? start.headers : []) {
    if (!Array.isArray(pair) || typeof pair[0] !== "string" || typeof pair[1] !== "string") continue;
    const name = pair[0].toLowerCase();
    if (FORWARD_REQUEST_HEADERS.includes(name)) headers[name] = pair[1];
  }
  return { ok: true, request: { url: target.toString(), method, headers, body } };
}

/** Messages the background posts on the port. */
export type RelayOut =
  | { type: "accepted" }
  | { type: "head"; status: number; statusText: string; headers: Array<[string, string]> }
  | { type: "chunk"; data: string }
  | { type: "end" }
  | { type: "error"; code: string; error: string; beforeHead: boolean };

/** Messages the background accepts on the port (after "start"). */
export type RelayIn = RelayStart | { type: "abort" } | { type: "ping" };

export interface RelayPort {
  name: string;
  sender?: { id?: string; origin?: string; url?: string; frameId?: number };
  postMessage(message: RelayOut): void;
  disconnect(): void;
  onMessage: { addListener(listener: (message: RelayIn) => void): void };
  onDisconnect: { addListener(listener: () => void): void };
}

function senderOrigin(sender: RelayPort["sender"]): string {
  if (sender?.origin) return sender.origin;
  try {
    return sender?.url ? new URL(sender.url).origin : "";
  } catch {
    return "";
  }
}

/** Short, key-free description of a network failure. */
function networkError(error: unknown): string {
  const name = error instanceof Error ? error.name : "";
  if (name === "AbortError") return "已取消";
  return "无法连接模型服务";
}

/**
 * Serve one relay port: validate the sender and the request, fetch upstream, stream the
 * decoded text back chunk by chunk. Disconnecting the port (or an "abort" message) aborts.
 */
export function handleRelayPort(port: RelayPort, deps: { fetch: typeof fetch; extensionId: string }): void {
  if (port.name !== LLM_RELAY_PORT_NAME) return;
  const controller = new AbortController();
  let started = false;
  let closed = false;
  let headSent = false;
  const post = (message: RelayOut): void => {
    if (closed) return;
    try {
      port.postMessage(message);
    } catch {
      closed = true;
      controller.abort();
    }
  };
  const fail = (code: string, error: string): void => {
    post({ type: "error", code, error, beforeHead: !headSent });
    closed = true;
    try { port.disconnect(); } catch { /* already gone */ }
  };
  port.onDisconnect.addListener(() => {
    closed = true;
    controller.abort();
  });

  const sender = port.sender;
  if (sender?.id && sender.id !== deps.extensionId) return fail("forbidden", "来源不被允许");
  if (!isOfferUOrigin(senderOrigin(sender))) return fail("forbidden", "只接受 OfferU 网页的请求");

  port.onMessage.addListener((message) => {
    if (!message || typeof message !== "object") return;
    if (message.type === "abort") {
      controller.abort();
      closed = true;
      try { port.disconnect(); } catch { /* already gone */ }
      return;
    }
    if (message.type !== "start" || started) return;
    started = true;
    const checked = validateRelayRequest(message);
    if (!checked.ok) return fail(checked.code, checked.error);
    post({ type: "accepted" });
    void run(checked.request);
  });

  async function run(request: ValidRelayRequest): Promise<void> {
    let upstream: Response;
    try {
      upstream = await deps.fetch(request.url, {
        method: request.method,
        headers: request.headers,
        body: request.body,
        redirect: "manual",
        credentials: "omit",
        cache: "no-store",
        signal: controller.signal,
      });
    } catch (error) {
      return fail("upstream", networkError(error));
    }
    if (upstream.type === "opaqueredirect" || (upstream.status >= 300 && upstream.status < 400)) {
      return fail("upstream", "模型服务返回了重定向，未跟随");
    }
    const headers: Array<[string, string]> = [];
    for (const name of FORWARD_RESPONSE_HEADERS) {
      const value = upstream.headers.get(name);
      if (value) headers.push([name, value]);
    }
    headSent = true;
    post({ type: "head", status: upstream.status, statusText: upstream.statusText, headers });
    if (!upstream.body) {
      post({ type: "end" });
      closed = true;
      return;
    }
    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (closed) {
          void reader.cancel().catch(() => undefined);
          return;
        }
        if (done) break;
        const text = decoder.decode(value, { stream: true });
        if (text) post({ type: "chunk", data: text });
      }
      const tail = decoder.decode();
      if (tail) post({ type: "chunk", data: tail });
      post({ type: "end" });
      closed = true;
    } catch (error) {
      fail("upstream", networkError(error));
    }
  }
}

/** Capabilities answered to the page's handshake. */
export function relayCapabilities(version: string): {
  protocol: number;
  version: string;
  stream: boolean;
  abort: boolean;
  hosts: string[];
  pathHosts: Record<string, string[]>;
} {
  return {
    protocol: LLM_RELAY_PROTOCOL,
    version,
    stream: true,
    abort: true,
    hosts: [...LLM_RELAY_HOSTS],
    pathHosts: Object.fromEntries(Object.entries(LLM_RELAY_PATH_HOSTS).map(([host, paths]) => [host, [...paths]])),
  };
}
