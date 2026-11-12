import type { Server } from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import { createAppServer } from "../src/server";
import { SqliteCoreStore } from "../src/store";

let store: SqliteCoreStore | null = null;
let server: Server | null = null;

afterEach(async () => {
  const closed = Promise.withResolvers<void>();
  if (server) server.close(() => closed.resolve()); else closed.resolve();
  await closed.promise;
  store?.close();
  store = null;
  server = null;
});

async function start(): Promise<{ base: string; store: SqliteCoreStore }> {
  const nextStore = new SqliteCoreStore(":memory:");
  const nextServer = createAppServer(nextStore);
  const listening = Promise.withResolvers<void>();
  nextServer.listen(0, "127.0.0.1", () => listening.resolve());
  await listening.promise;
  const address = nextServer.address();
  if (!address || typeof address === "string") throw new Error("no port");
  store = nextStore;
  server = nextServer;
  return { base: `http://127.0.0.1:${address.port}`, store: nextStore };
}

describe("TS backend HTTP", () => {
  it("serves health and the tools surface", async () => {
    const { base } = await start();
    const health = await fetch(`${base}/api/health`).then((response) => response.json()) as { status: string; service: string; runtime: string };
    expect(health).toMatchObject({ status: "ok", service: "OfferU", runtime: "node" });
    const tools = await fetch(`${base}/api/tools`).then((response) => response.json()) as { tools: string[] };
    expect(tools.tools).toContain("overview");
  });

  it("writes and reads through /api/tools", async () => {
    const { base } = await start();
    const saved = await fetch(`${base}/api/tools/save`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "http://127.0.0.1:7410" },
      body: JSON.stringify({ type: "job", data: { company: "飞书", title: "产品实习" } }),
    });
    expect(saved.status).toBe(200);
    expect(saved.headers.get("access-control-allow-origin")).toBe("http://127.0.0.1:7410");
    const listed = await fetch(`${base}/api/tools/list`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "job" }),
    }).then((response) => response.json()) as { items: Array<{ company: string; title: string; status: string }> };
    expect(listed.items[0]).toMatchObject({ company: "飞书", title: "产品实习", status: "saved" });
  });

  it("returns a useful 400 for invalid input", async () => {
    const { base } = await start();
    const response = await fetch(`${base}/api/tools/save`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "job", data: { status: "maybe" } }),
    });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { detail: string }).detail).toContain("status");
  });
});
