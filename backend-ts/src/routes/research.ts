import type { Hono } from "hono";
import { stream } from "hono/streaming";
import { enrichChanges, isCoreError, nowIso, prepareEvaluation, runEvaluation, todayIso } from "@offeru/core";

import { jsonBody, type AppEnv } from "../app";
import { toolDeps } from "../tools";
import { registerBossLogin } from "./companion/boss-login";
import { toolRuntime } from "./tools";

/**
 * Job research / evaluation routes. Runtime-agnostic (Worker + Node).
 *
 * POST /api/jobs/evaluate — same SSE as Python main.py: `data: {json}\n\n` per
 * event, start → job_start / job … → done. Disconnecting cancels.
 * Differences from Python (both only on failure paths):
 * - a bad request (no model, unknown id, job without JD) is a plain 4xx JSON
 *   before the stream starts, instead of a 200 stream that breaks;
 * - a failure mid-stream ends with `{"type":"error","detail","code"}` instead of
 *   a dropped connection.
 */
export function registerResearch(app: Hono<AppEnv>): void {
  // /api/applications/boss-login* (Node companion only; 501 on the Worker).
  registerBossLogin(app);

  app.post("/api/jobs/evaluate", async (c) => {
    const deps = c.get("deps");
    const actor = c.get("actor");
    const payload = await jsonBody(c) as Record<string, unknown> | null;
    const body = payload && typeof payload === "object" && !Array.isArray(payload) ? payload : {};
    const llm = deps.llm?.() ?? null;
    const prepared = await prepareEvaluation(deps.store, llm, { ids: body.ids, redo: Boolean(body.redo) });

    c.header("Content-Type", "text/event-stream");
    c.header("Cache-Control", "no-cache");
    c.header("X-Accel-Buffering", "no");
    return stream(c, async (out) => {
      const abort = new AbortController();
      out.onAbort(() => abort.abort());
      const send = (event: unknown) => out.write(`data: ${JSON.stringify(event)}\n\n`);
      try {
        for await (const event of runEvaluation(deps.store, llm!, prepared, {
          signal: abort.signal,
          // Python evaluate_stream: split job.posting first for jobs without one (best effort).
          enrich: (ids, signal) => enrichChanges(toolDeps(toolRuntime(deps), actor, signal), ids),
          context: () => ({ actor, now: nowIso(), today: todayIso() }),
        })) {
          await send(event);
        }
      } catch (error) {
        if (abort.signal.aborted) return;
        if (!isCoreError(error)) console.error(error);
        await send({
          type: "error",
          detail: isCoreError(error) ? error.message : "评估中断了",
          code: isCoreError(error) ? error.code : "internal",
        });
      }
    });
  });
}
