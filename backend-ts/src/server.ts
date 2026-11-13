import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { pathToFileURL } from "node:url";

import { pairingToken } from "./pairing";
import { dbPath } from "./paths";
import { callTool, openStore, SUPPORTED_TOOLS } from "./tools";
import { isCoreError, type CoreErrorCode } from "@offeru/core";
import type { SqliteCoreStore } from "./store";

const STATUS_OF: Record<CoreErrorCode, number> = {
  invalid: 400,
  not_found: 404,
  conflict: 409,
  forbidden: 403,
  unsupported: 501,
};

const MAX_BODY = 2 * 1024 * 1024;
const BRIDGE_ORIGIN = /^https:\/\/(?:offeru\.avabbbb\.com|offeru-showcase\.pages\.dev|[a-z0-9-]+\.offeru-showcase\.pages\.dev)$/;

function isBridgeOrigin(origin: string | undefined): boolean {
  return Boolean(origin && BRIDGE_ORIGIN.test(origin));
}

function allowOrigin(origin: string | undefined): boolean {
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

function json(res: ServerResponse, status: number, payload: unknown, origin?: string): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    ...(allowOrigin(origin) ? { "Access-Control-Allow-Origin": origin!, Vary: "Origin" } : {}),
  });
  res.end(body);
}

async function bodyOf(req: IncomingMessage): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY) throw new Error("请求体超过 2 MB");
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}

export function createAppServer(store: SqliteCoreStore): Server {
  return createServer(async (req, res) => {
    const origin = req.headers.origin;
    const method = req.method || "GET";
    const url = new URL(req.url || "/", "http://127.0.0.1");

    if (method === "OPTIONS") {
      res.writeHead(204, {
        ...(allowOrigin(origin) ? {
          "Access-Control-Allow-Origin": origin!,
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, X-OfferU-Actor, X-OfferU-Pairing",
          "Access-Control-Max-Age": "600",
          "Access-Control-Allow-Private-Network": "true",
        } : {}),
        Vary: "Origin",
      });
      res.end();
      return;
    }

    if (method === "GET" && url.pathname === "/api/pairing") {
      if (origin && !allowOrigin(origin)) {
        json(res, 403, { detail: "配对信息只给本机页面" }, origin);
        return;
      }
      if (isBridgeOrigin(origin)) {
        json(res, 403, { detail: "配对信息只给本机页面" }, origin);
        return;
      }
      json(res, 200, {
        token: pairingToken(),
        backend: `http://${req.headers.host || "127.0.0.1:8767"}`,
        mcp_stdio: "offeru-ts mcp",
      }, origin);
      return;
    }

    if (isBridgeOrigin(origin) && url.pathname.startsWith("/api/") && url.pathname !== "/api/health") {
      const supplied = String(req.headers["x-offeru-pairing"] || "");
      if (!supplied || supplied !== pairingToken()) {
        json(res, 403, { detail: "请求被拒绝：本机 OfferU 未配对或配对 token 已变化" }, origin);
        return;
      }
    }

    if (method === "GET" && url.pathname === "/api/health") {
      json(res, 200, {
        status: "ok",
        service: "OfferU",
        runtime: "node",
        version: "0.1.0",
        storage: "sqlite",
        tools: SUPPORTED_TOOLS,
      }, origin);
      return;
    }

    if (method === "GET" && url.pathname === "/api/tools") {
      json(res, 200, { tools: SUPPORTED_TOOLS }, origin);
      return;
    }

    const match = url.pathname.match(/^\/api\/tools\/([a-z_]+)$/);
    if (method === "POST" && match) {
      try {
        const actor = String(req.headers["x-offeru-actor"] || "你");
        const result = await callTool(match[1], await bodyOf(req), store, actor);
        json(res, 200, result, origin);
      } catch (cause) {
        if (cause instanceof SyntaxError) {
          json(res, 400, { detail: "请求体不是合法 JSON", code: "invalid" }, origin);
        } else if (isCoreError(cause)) {
          json(res, STATUS_OF[cause.code], { detail: cause.message, code: cause.code }, origin);
        } else {
          console.error(cause);
          json(res, 500, { detail: "服务器内部错误", code: "internal" }, origin);
        }
      }
      return;
    }

    json(res, 404, { detail: "Not found" }, origin);
  });
}

export function startHttpServer(store: SqliteCoreStore, port = Number(process.env.OFFERU_TS_PORT || 8767)): Server {
  const server = createAppServer(store);
  server.listen(port, "127.0.0.1", () => {
    console.log(`OfferU TS backend on http://127.0.0.1:${port} (${dbPath()})`);
  });
  return server;
}

function main(): void {
  const store = openStore(dbPath());
  const server = startHttpServer(store);
  const shutdown = () => {
    server.close(() => {
      store.close();
      process.exit(0);
    });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
