// Cloudflare Worker entry: static frontend + an optional, stateless LLM relay.
//
// Zero server state by design: no D1 / KV / Durable Objects / R2. The user's
// data lives in their browser (the in-page Hono app over IndexedDB, see
// frontend/src/lib/local) or in the desktop companion's SQLite. The Worker
// only:
//   1. serves frontend/dist through the ASSETS binding (SPA fallback is
//      configured in wrangler.toml);
//   2. relays model calls the browser cannot make itself because the provider
//      sends no CORS headers: POST /llm-proxy (GET only for .../models), the target URL in
//      X-OfferU-LLM-URL, the user's own key in the request's Authorization /
//      x-api-key header. The response streams straight back. Nothing is
//      logged or stored; the target host must be a known provider endpoint so
//      this is not an open proxy;
//   3. answers /api/health, and 501 for any other /api/* (data APIs run in the
//      page, never here).
//
// No node:* imports: this bundles for workerd without nodejs_compat.

import { PROVIDER_PRESETS } from "@offeru/core";

export interface Env {
  ASSETS: { fetch(request: Request): Promise<Response> };
  /** Optional comma-separated extra hosts the relay may reach (e.g. a self-hosted gateway). */
  LLM_PROXY_EXTRA_HOSTS?: string;
  /** "off" disables the relay entirely. */
  LLM_PROXY?: string;
}

const FORWARD_REQUEST_HEADERS = ["authorization", "x-api-key", "anthropic-version", "anthropic-beta", "content-type", "accept"];
const FORWARD_RESPONSE_HEADERS = ["content-type", "cache-control", "retry-after", "x-request-id", "request-id"];
const MAX_BODY_BYTES = 8 * 1024 * 1024;

/**
 * Gateways that are not built-in presets but are common for user keys and send no CORS on
 * their completion endpoints (OpenCode Zen answers the preflight with 404). Path-restricted,
 * mirroring Flovart's server/llmProxy.ts allowlist.
 */
export const RELAY_PATH_HOSTS: Record<string, readonly string[]> = {
  "opencode.ai": ["/zen/", "/inference/"],
};

/** True when the relay may reach this https URL (preset host, extra host, or an allowed gateway path). */
export function relayAllowed(target: URL, extra = ""): boolean {
  const host = target.hostname.toLowerCase();
  if (relayHosts(extra).has(host)) return true;
  const prefixes = RELAY_PATH_HOSTS[host];
  return !!prefixes && prefixes.some((prefix) => target.pathname.startsWith(prefix));
}

/** Hosts of the built-in provider presets (https only; local endpoints never go through the Worker). */
export function relayHosts(extra = ""): Set<string> {
  const hosts = new Set<string>(["api.anthropic.com"]);
  for (const preset of PROVIDER_PRESETS) {
    try {
      const url = new URL(preset.default_base_url);
      if (url.protocol === "https:") hosts.add(url.hostname);
    } catch { /* custom preset has no default URL */ }
  }
  for (const host of extra.split(",").map((h) => h.trim().toLowerCase()).filter(Boolean)) hosts.add(host);
  return hosts;
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), {
  status,
  headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
});

export async function relayLlm(request: Request, env: Env): Promise<Response> {
  if (env.LLM_PROXY === "off") return json(404, { detail: "模型转发已关闭", code: "unsupported" });
  // POST for completions; GET only for the model list (settings → 获取模型).
  if (request.method !== "POST" && request.method !== "GET") return json(405, { detail: "只支持 POST / GET", code: "invalid" });
  // Same-origin only: the page served by this Worker. Browsers send Origin on POST fetches.
  const origin = request.headers.get("origin");
  const self = new URL(request.url).origin;
  if (origin && origin !== self) return json(403, { detail: "只转发本站页面的请求", code: "forbidden" });

  let target: URL;
  try {
    target = new URL(request.headers.get("x-offeru-llm-url") || "");
  } catch {
    return json(400, { detail: "缺少 X-OfferU-LLM-URL", code: "invalid" });
  }
  if (target.protocol !== "https:" || target.username || target.password) return json(400, { detail: "只转发 https 模型接口", code: "invalid" });
  if (request.method === "GET" && !/\/models\/?$/.test(target.pathname)) return json(405, { detail: "GET 只用于获取模型列表", code: "invalid" });
  if (!relayAllowed(target, env.LLM_PROXY_EXTRA_HOSTS)) {
    return json(403, { detail: `不转发到 ${target.hostname}：只支持内置的模型服务商`, code: "forbidden" });
  }
  const length = Number(request.headers.get("content-length") || 0);
  if (length > MAX_BODY_BYTES) return json(413, { detail: "请求体太大", code: "invalid" });

  const headers = new Headers();
  for (const name of FORWARD_REQUEST_HEADERS) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  const upstream = await fetch(target.toString(), {
    method: request.method,
    headers,
    body: request.method === "POST" ? request.body : undefined,
    redirect: "manual",
  });
  const out = new Headers({ "Cache-Control": "no-store", "X-Accel-Buffering": "no" });
  for (const name of FORWARD_RESPONSE_HEADERS) {
    const value = upstream.headers.get(name);
    if (value) out.set(name, value);
  }
  return new Response(upstream.body, { status: upstream.status, headers: out });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/llm-proxy") return relayLlm(request, env);
    if (url.pathname === "/api/health") {
      return json(200, { status: "ok", service: "OfferU", runtime: "worker", storage: "none", data: "browser" });
    }
    if (url.pathname.startsWith("/api/")) {
      return json(501, { detail: "网页版的数据在你的浏览器里，由页面内的本地后端处理；服务器不保存任何数据", code: "unsupported" });
    }
    return env.ASSETS.fetch(request);
  },
};
