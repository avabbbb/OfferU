import type { Hono } from "hono";

import type { AppEnv } from "../app";
import { registerResume } from "./resume";

/**
 * Route modules, one per migrated domain. Each workstream owns its own module
 * file and folder and adds exactly one import + one line below, so parallel
 * branches merge without touching each other's code.
 *
 * Rules for a module:
 * - export `register(app)`; mount under the same /api/... paths the Python
 *   backend serves so the frontend does not change.
 * - business rules live in packages/core (runtime-agnostic, no node:*);
 *   the route only parses input, calls core, and returns JSON.
 * - throw CoreError(message, code) for expected failures; app.onError maps it.
 * - read deps via c.get("deps"); never import node:* in a route that must run
 *   on the Worker. Node-only routes go under routes/companion/.
 */
export function registerRoutes(app: Hono<AppEnv>): void {
  void app;
  // register<Domain>(app);
  registerResume(app);
}
