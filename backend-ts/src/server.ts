import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { callTool, openStore, SUPPORTED_TOOLS } from "./tools";
import type { SqliteCoreStore } from "./store";

const MAX_BODY = 2 * 1024 * 1024;

function allowOrigin(origin: string | undefined): boolean {
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
          "Access-Control-Allow-Headers": "Content-Type, X-OfferU-Actor",
          "Access-Control-Max-Age": "600",
        } : {}),
        Vary: "Origin",
      });
      res.end();
      return;
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
        const result = callTool(match[1], await bodyOf(req), store, actor);
        json(res, 200, result, origin);
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : "请求失败";
        const status = /不存在|只能是|要有|不能为空/.test(message) ? 400 : 422;
        json(res, status, { detail: message }, origin);
      }
      return;
    }

    json(res, 404, { detail: "Not found" }, origin);
  });
}

export function dbPath(): string {
  if (process.env.OFFERU_DB_PATH) return process.env.OFFERU_DB_PATH;
  const dir = process.env.OFFERU_DATA_DIR || resolve("backend-ts/.data");
  mkdirSync(dir, { recursive: true });
  return join(dir, "offeru.db");
}

function main(): void {
  const store = openStore(dbPath());
  const server = createAppServer(store);
  const port = Number(process.env.OFFERU_TS_PORT || 8767);
  server.listen(port, "127.0.0.1", () => {
    console.log(`OfferU TS backend on http://127.0.0.1:${port} (${dbPath()})`);
  });
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
