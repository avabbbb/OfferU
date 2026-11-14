import type { Hono } from "hono";

import type { AppEnv } from "../../app";
import { registerResumeCompanion } from "./resume";

/**
 * Node-only route modules (disk, local Chromium, IMAP...). The Node entry (server.ts) calls this after createApp;
 * the Worker never imports this file. One import + one line per domain, like routes/index.ts.
 */
export function registerCompanionRoutes(app: Hono<AppEnv>): void {
  registerResumeCompanion(app);
}
