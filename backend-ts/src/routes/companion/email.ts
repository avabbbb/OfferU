import { dirname } from "node:path";

import type { Hono } from "hono";
import { emailSyncTool } from "@offeru/core";

import { jsonBody, type AppEnv } from "../../app";
import { NodeMailService } from "../../mail-node";
import { dbPath } from "../../paths";

/**
 * Companion mailbox (IMAP only). Python had no HTTP router for these (the
 * frontend's /api/email/* calls went to the removed ops layer); the paths below
 * follow the frontend's existing calls so the settings page works unchanged.
 * The web app has no IMAP (browsers cannot open raw TCP) and shows a hint.
 */
export function registerEmailCompanion(app: Hono<AppEnv>, service = new NodeMailService(dirname(dbPath()))): void {
  app.get("/api/email/status", (c) => c.json(service.status()));
  app.post("/api/email/imap-connect", async (c) => c.json(await service.connect(await jsonBody(c) as Record<string, unknown>)));
  app.delete("/api/email/accounts/:id", (c) => c.json(service.disconnect(c.req.param("id"))));
  app.get("/api/email/sync-runs", (c) => {
    const limit = Math.max(1, Math.min(100, Math.round(Number(c.req.query("limit") || 20)) || 20));
    const items = service.runs().slice(0, limit);
    return c.json({ total: items.length, items });
  });
  /** Same output as the `email_sync` tool (Python core/tools.email_sync). */
  app.post("/api/email/sync", async (c) => {
    const deps = c.get("deps");
    const body = await jsonBody(c) as Record<string, unknown>;
    return c.json(await emailSyncTool(deps.store, service.port(deps.store, () => deps.llm?.() ?? null), { action: "sync", account: body.account }));
  });
  app.get("/api/email/sync", async (c) => {
    const deps = c.get("deps");
    return c.json(await emailSyncTool(deps.store, service.port(deps.store, () => deps.llm?.() ?? null), { action: "status", account: c.req.query("account") }));
  });
}
