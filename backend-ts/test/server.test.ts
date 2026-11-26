import type { Server } from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import type { AppDeps } from "../src/app";
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

async function start(overrides: Partial<AppDeps> = {}): Promise<{ base: string; store: SqliteCoreStore }> {
  const nextStore = new SqliteCoreStore(":memory:");
  const nextServer = createAppServer(nextStore, overrides);
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
    const tools = await fetch(`${base}/api/tools`).then((response) => response.json()) as { tools: Array<{ name: string; description: string; input: object }> };
    expect(tools.tools.map((tool) => tool.name)).toContain("overview");
    expect(tools.tools[0]).toEqual({ name: "overview", description: expect.stringContaining("先调这个"), input: expect.any(Object) });
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

  it("maps core error codes to HTTP status", async () => {
    const { base } = await start({ search: () => null });
    const missing = await fetch(`${base}/api/tools/get`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "job", id: 404 }),
    });
    expect(missing.status).toBe(404);
    const unconfigured = await fetch(`${base}/api/tools/web_search`, { method: "POST", body: JSON.stringify({ query: "飞书" }) });
    expect(unconfigured.status).toBe(501);
    expect(await unconfigured.json()).toMatchObject({ code: "not_configured" });
    const broken = await fetch(`${base}/api/tools/list`, { method: "POST", body: "{nope" });
    expect(broken.status).toBe(400);
  });

  it("pairs the hosted web app over CORS + PNA with a one-time code and shares the same store", async () => {
    const webOrigin = "https://offeru.avabbbb.com";
    const { base } = await start();
    const pairCode = (server as unknown as { offeruRuntime?: { mintPairCode?: () => string } })?.offeruRuntime?.mintPairCode?.();
    expect(pairCode).toBeTruthy();

    // Preflight allows the hosted web origin, Private Network Access, pairing and Authorization headers.
    const preflight = await fetch(`${base}/api/tools/overview`, {
      method: "OPTIONS",
      headers: { Origin: webOrigin },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe(webOrigin);
    expect(preflight.headers.get("access-control-allow-private-network")).toBe("true");
    expect(preflight.headers.get("access-control-allow-headers")).toContain("X-OfferU-Pairing");
    expect(preflight.headers.get("access-control-allow-headers")).toContain("Authorization");

    // Unpaired web requests to data endpoints are rejected.
    const denied = await fetch(`${base}/api/tools/overview`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: webOrigin },
      body: "{}",
    });
    expect(denied.status).toBe(403);

    // Trading the one-time pair code succeeds from the hosted web origin and cannot be replayed.
    const paired = await fetch(`${base}/api/ui/pair`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: webOrigin },
      body: JSON.stringify({ code: pairCode }),
    });
    expect(paired.status).toBe(200);
    const { token, pairing_token } = await paired.json() as { token: string; pairing_token: string };
    expect(token).toBeTruthy();
    expect(pairing_token).toBeTruthy();

    const replay = await fetch(`${base}/api/ui/pair`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: webOrigin },
      body: JSON.stringify({ code: pairCode }),
    });
    expect(replay.status).toBe(403);

    // Paired web requests read/write the same SQLite database and reach the local Agent board.
    const saved = await fetch(`${base}/api/tools/save`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: webOrigin, "X-OfferU-Pairing": pairing_token },
      body: JSON.stringify({ type: "memory", data: { kind: "note", title: "网页直连本机" } }),
    });
    expect(saved.status).toBe(200);
    const listed = await fetch(`${base}/api/tools/list`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "memory" }),
    }).then((response) => response.json()) as { items: Array<{ title: string }> };
    expect(listed.items[0]?.title).toBe("网页直连本机");

    const board = await fetch(`${base}/api/agent-board`, {
      headers: { Origin: webOrigin, "X-OfferU-Pairing": pairing_token },
    });
    expect(board.status).toBe(200);
  });
});
