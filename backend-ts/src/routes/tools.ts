import type { Hono } from "hono";

import { jsonBody, type AppDeps, type AppEnv } from "../app";
import { callTool, TOOL_LIST, type ToolRuntime } from "../tools";

/** The runtime pieces of AppDeps the shared tools use. */
export function toolRuntime(deps: AppDeps): ToolRuntime {
  return { store: deps.store, llm: deps.llm, search: deps.search, fetch: deps.fetch, companion: deps.companion };
}

/**
 * The workbench calls the same tools as agents (Python main.py /api/tools).
 * GET  /api/tools        → {tools: [{name, description, input}]}
 * POST /api/tools/{name} → the tool's result; expected errors → {detail, code} via app.onError.
 * A disconnect aborts long tools (evaluate_jobs stops between jobs).
 */
export function registerTools(app: Hono<AppEnv>): void {
  app.get("/api/tools", (c) => c.json({ tools: TOOL_LIST }));

  app.post("/api/tools/:name{[a-z_]+}", async (c) => {
    const args = await jsonBody(c);
    const result = await callTool(c.req.param("name"), args ?? {}, toolRuntime(c.get("deps")), c.get("actor"), c.req.raw.signal);
    return c.json(result as object);
  });
}
