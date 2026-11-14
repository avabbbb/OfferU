import { Hono, type Context } from "hono";
import { isCoreError, type AgentRunStore, type CoreErrorCode, type CoreStore, type LlmClient } from "@offeru/core";

import { registerRoutes } from "./routes";
import { callTool, SUPPORTED_TOOLS } from "./tools";

/**
 * Runtime-agnostic HTTP app. No node:* imports here: the same app runs under
 * @hono/node-server (local companion) and as a Cloudflare Worker. Anything
 * runtime-specific (SQLite file, pairing token file, IMAP, Playwright) is
 * injected through AppDeps.
 */
export interface AppDeps {
  store: CoreStore;
  /** Local pairing secret; undefined on runtimes with no pairing (stateless Worker proxy). */
  pairingToken?: () => string;
  runtime: "node" | "worker";
  storage: "sqlite" | "none";
  /** The user's configured model (BYOK); called per request so a changed key applies at once. Absent/null = no model. */
  llm?: () => LlmClient | null;
  /** Agent run rows (SQLite on the companion, IndexedDB in the browser); absent = in-memory. */
  agentRuns?: AgentRunStore;
}

export type AppEnv = { Variables: { deps: AppDeps; actor: string } };

export const STATUS_OF: Record<CoreErrorCode, number> = {
  invalid: 400,
  not_found: 404,
  conflict: 409,
  forbidden: 403,
  unsupported: 501,
};

const MAX_BODY = 2 * 1024 * 1024;
const BRIDGE_ORIGIN = /^https:\/\/(?:offeru\.avabbbb\.com|offeru-showcase\.pages\.dev|[a-z0-9-]+\.offeru-showcase\.pages\.dev)$/;

export function isBridgeOrigin(origin: string | undefined | null): boolean {
  return Boolean(origin && BRIDGE_ORIGIN.test(origin));
}

export function allowOrigin(origin: string | undefined | null): boolean {
  if (isBridgeOrigin(origin)) return true;
  if (!origin) return false;
  if (origin === "tauri://localhost" || origin === "http://tauri.localhost" || origin === "https://tauri.localhost") return true;
  try {
    const url = new URL(origin);
    return (url.protocol === "http:" || url.protocol === "https:")
      && (url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]");
  } catch {
    return false;
  }
}

/** Parse a JSON body with a size cap; throws CoreError-shaped errors via onError. */
export async function jsonBody(c: Context): Promise<unknown> {
  const length = Number(c.req.header("content-length") || 0);
  if (length > MAX_BODY) throw new BodyTooLarge();
  const text = await c.req.text();
  if (text.length > MAX_BODY) throw new BodyTooLarge();
  return text ? JSON.parse(text) : {};
}

class BodyTooLarge extends Error {
  constructor() {
    super("请求体超过 2 MB");
  }
}

export function createApp(deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.use("*", async (c, next) => {
    c.set("deps", deps);
    c.set("actor", c.req.header("x-offeru-actor") || "你");
    const origin = c.req.header("origin");
    if (c.req.method === "OPTIONS") {
      const headers: Record<string, string> = { Vary: "Origin" };
      if (allowOrigin(origin)) {
        Object.assign(headers, {
          "Access-Control-Allow-Origin": origin!,
          "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, X-OfferU-Actor, X-OfferU-Pairing",
          "Access-Control-Max-Age": "600",
          "Access-Control-Allow-Private-Network": "true",
        });
      }
      return c.body(null, 204, headers);
    }
    await next();
    if (allowOrigin(origin)) {
      c.res.headers.set("Access-Control-Allow-Origin", origin!);
      c.res.headers.append("Vary", "Origin");
    }
  });

  // Showcase pages may only reach the local backend with the pairing token.
  app.use("/api/*", async (c, next) => {
    const origin = c.req.header("origin");
    if (isBridgeOrigin(origin) && c.req.path !== "/api/health") {
      const supplied = c.req.header("x-offeru-pairing") || "";
      if (!deps.pairingToken || !supplied || supplied !== deps.pairingToken()) {
        return c.json({ detail: "请求被拒绝：本机 OfferU 未配对或配对 token 已变化", code: "forbidden" }, 403);
      }
    }
    await next();
  });

  app.get("/api/pairing", (c) => {
    const origin = c.req.header("origin");
    if (!deps.pairingToken || (origin && !allowOrigin(origin)) || isBridgeOrigin(origin)) {
      return c.json({ detail: "配对信息只给本机页面" }, 403);
    }
    return c.json({
      token: deps.pairingToken(),
      backend: `http://${c.req.header("host") || "127.0.0.1:8767"}`,
      mcp_stdio: "offeru-ts mcp",
    });
  });

  app.get("/api/health", (c) => c.json({
    status: "ok",
    service: "OfferU",
    runtime: deps.runtime,
    version: "0.1.0",
    storage: deps.storage,
    tools: SUPPORTED_TOOLS,
  }));

  app.get("/api/tools", (c) => c.json({ tools: SUPPORTED_TOOLS }));

  app.post("/api/tools/:name{[a-z_]+}", async (c) => {
    const result = await callTool(c.req.param("name"), await jsonBody(c), deps.store, c.get("actor"));
    return c.json(result as object);
  });

  registerRoutes(app);

  app.notFound((c) => c.json({ detail: "Not found" }, 404));

  app.onError((cause, c) => {
    if (cause instanceof SyntaxError) return c.json({ detail: "请求体不是合法 JSON", code: "invalid" }, 400);
    if (cause instanceof BodyTooLarge) return c.json({ detail: cause.message, code: "invalid" }, 413);
    if (isCoreError(cause)) return c.json({ detail: cause.message, code: cause.code }, STATUS_OF[cause.code] as 400);
    console.error(cause);
    return c.json({ detail: "服务器内部错误", code: "internal" }, 500);
  });

  return app;
}
