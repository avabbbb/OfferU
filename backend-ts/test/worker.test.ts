import { describe, expect, it } from "vitest";

import worker from "../src/worker";

const call = (path: string, init: RequestInit = {}) => worker.fetch(new Request(`https://offeru-api.example.workers.dev${path}`, init));

describe("stateless Worker", () => {
  it("reports itself as worker with no storage", async () => {
    const response = await call("/api/health");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ service: "OfferU", runtime: "worker", storage: "none" });
  });

  it("refuses data tools with 501 instead of pretending to store", async () => {
    const response = await call("/api/tools/list", { method: "POST", body: JSON.stringify({ type: "job" }) });
    expect(response.status).toBe(501);
    expect(await response.json()).toMatchObject({ code: "unsupported" });
  });

  it("Pages origins get CORS without a pairing token", async () => {
    const origin = "https://offeru-showcase.pages.dev";
    const preflight = await call("/api/tools/list", { method: "OPTIONS", headers: { Origin: origin } });
    expect(preflight.headers.get("access-control-allow-origin")).toBe(origin);
    const response = await call("/api/health", { headers: { Origin: origin } });
    expect(response.headers.get("access-control-allow-origin")).toBe(origin);
    const tools = await call("/api/tools/list", { method: "POST", headers: { Origin: origin }, body: JSON.stringify({ type: "job" }) });
    expect(tools.status).toBe(501);
  });

  it("unknown paths say no_route", async () => {
    const response = await call("/api/nope");
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: "no_route" });
  });

  it("pairing info is never served by the Worker", async () => {
    expect((await call("/api/pairing")).status).toBe(403);
  });
});
