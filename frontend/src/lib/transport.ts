// One door to the backend for the whole data layer.
//
//   memory  web builds (lib/runtime/mode WEB_RUNTIME) with no paired companion:
//           the request is handed to the Hono app running in this page
//           (lib/runtime/browserRuntime) — no network, data in IndexedDB.
//   http    desktop/dev builds, or a web build paired with the local companion
//           (lib/bridge): fetch to 127.0.0.1:8766 with the pairing header.
//
// apiFetch(path, init) returns a real Response either way, so callers keep
// their JSON / SSE handling. Route modules merged into backend-ts/src/routes
// later are served by the memory transport automatically.
//
// Web builds also install a fetch shim: component code that still calls
// fetch(`${API_BASE}/api/...`) directly is routed the same way.

import { resolveApiBase } from "./apiBase";
import { activateLoopbackBridge, bridgeActive, bridgeHeaders, getBridgeState, probeLocalBridge } from "./bridge";
import { DEMO_SEED, WEB_RUNTIME } from "./runtime/mode";
import { nativeFetch } from "./runtime/net";

export type TransportKind = "memory" | "http";

export { nativeFetch };

const MEMORY_ORIGIN = "http://offeru.local";
export const WEB_UNSUPPORTED = "网页版暂时不支持这个功能：它需要本机 OfferU（伴侣）。在设置里连接本机 OfferU 后再试。";

export function transportKind(): TransportKind {
  return WEB_RUNTIME && !bridgeActive() ? "memory" : "http";
}

/** "/api/x?y" for any of: "/api/x?y", "api/x", "http://127.0.0.1:8766/api/x?y". Null for foreign URLs. */
export function apiPathOf(input: string): string | null {
  const base = resolveApiBase();
  if (input.startsWith(base)) return input.slice(base.length) || "/";
  if (/^[a-z][a-z0-9+.-]*:/i.test(input)) return null;
  return input.startsWith("/") ? input : `/${input}`;
}

// ---- companion auto-detect -------------------------------------------------

function isLoopbackPage(): boolean {
  if (typeof window === "undefined") return false;
  const host = window.location.hostname;
  return host === "127.0.0.1" || host === "localhost" || host === "[::1]";
}

let detection: Promise<void> | null = null;

/**
 * Web builds look for a local companion once at startup.
 * - Page served from loopback (dev, or the companion serving the static site):
 *   the companion trusts loopback origins, so switch to HTTP right away and
 *   hold the first requests until the probe answers (≤ 1.8 s).
 * - Public page (Cloudflare Pages): only record that one is reachable; using it
 *   needs the pairing token (lib/bridge connectLocalBridge), and until then the
 *   page keeps using its own browser data.
 */
export function detectCompanion(): Promise<void> {
  if (!WEB_RUNTIME || typeof window === "undefined") return Promise.resolve();
  detection ??= (async () => {
    const found = await probeLocalBridge({ quiet: true }).catch(() => ({ available: false }));
    if (found.available && isLoopbackPage()) activateLoopbackBridge();
  })();
  return detection;
}

// ---- memory transport ------------------------------------------------------

async function memoryFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const { browserApp } = await import("./runtime/browserRuntime");
  const headers = new Headers(init.headers);
  if (!headers.has("Content-Type") && typeof init.body === "string") headers.set("Content-Type", "application/json");
  const request = new Request(MEMORY_ORIGIN + path, { ...init, headers, redirect: "manual" });
  const response = await browserApp().fetch(request);
  if (response.status !== 404) return response;
  const payload = await response.clone().json().catch(() => null) as { code?: string } | null;
  if (payload?.code !== "no_route") return response;
  return unsupportedRoute(path, init);
}

/** No such route in the browser runtime: recorded replay on the showcase, a clear 501 otherwise. */
async function unsupportedRoute(path: string, init: RequestInit): Promise<Response> {
  if (DEMO_SEED) {
    const { showcaseHandle } = await import("./showcase");
    try {
      const data = await showcaseHandle(path, init);
      return Response.json(data ?? {});
    } catch (cause) {
      return Response.json({ detail: cause instanceof Error ? cause.message : WEB_UNSUPPORTED, code: "unsupported" }, { status: 501 });
    }
  }
  return Response.json({ detail: WEB_UNSUPPORTED, code: "unsupported" }, { status: 501 });
}

// ---- the door --------------------------------------------------------------

/**
 * Call the OfferU backend, wherever it runs. `input` is an API path or a URL
 * under resolveApiBase(). Network failures reject (like fetch); HTTP errors
 * resolve with the error Response.
 */
export async function apiFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const path = apiPathOf(input);
  if (path === null) return nativeFetch(input, init);
  if (WEB_RUNTIME && isLoopbackPage()) await detectCompanion();
  if (transportKind() === "memory") return memoryFetch(path, init);
  const headers = new Headers(init.headers);
  for (const [key, value] of Object.entries(bridgeHeaders())) headers.set(key, value);
  return nativeFetch(`${resolveApiBase()}${path}`, { ...init, headers, redirect: "error" });
}

/** Where the data of this page lives right now (for status text). */
export function runtimeLabel(): string {
  if (transportKind() === "http") return getBridgeState().active && WEB_RUNTIME ? "本机 OfferU" : "本地后端";
  return "这个浏览器";
}

// ---- fetch shim for web builds -------------------------------------------

let shimmed = false;

/** Route stray fetch(`${API_BASE}/api/...`) calls (components, SWR keys) through apiFetch. */
export function installFetchShim(): void {
  if (shimmed || !WEB_RUNTIME || typeof window === "undefined") return;
  shimmed = true;
  const base = resolveApiBase();
  window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith(base) || transportKind() !== "memory") return nativeFetch(input, init);
    if (input instanceof Request) {
      return input.clone().text().then((body) => apiFetch(url, {
        method: input.method,
        headers: input.headers,
        body: ["GET", "HEAD"].includes(input.method) ? undefined : body,
        signal: input.signal,
        ...init,
      }));
    }
    return apiFetch(url, init);
  }) as typeof fetch;
}

if (WEB_RUNTIME && typeof window !== "undefined") {
  installFetchShim();
  void detectCompanion();
  void import("./runtime/browserRuntime").then(({ listenForOtherTabs }) => listenForOtherTabs()).catch(() => undefined);
}
