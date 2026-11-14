import type { Context, Hono } from "hono";
import { handleInterviewConfigApi, INTERVIEW_CONFIG_PREFIXES, type ApiRequest } from "@offeru/core";

import { jsonBody, type AppEnv } from "../app";

/**
 * /api/interviews, /api/interview, /api/config, /api/consent, /api/connections.
 * Thin Hono glue over core's handleInterviewConfigApi (the browser transport
 * calls the same dispatcher). The model comes from deps.llm (built per request
 * from the saved config); keys come from deps.settings, which the Worker lacks.
 */
export function registerInterviewConfig(app: Hono<AppEnv>): void {
  const handle = async (c: Context<AppEnv>) => {
    const url = new URL(c.req.url);
    const request: ApiRequest = { method: c.req.method, path: url.pathname, query: url.searchParams, body: {} };
    if ((c.req.header("content-type") || "").toLowerCase().startsWith("multipart/form-data")) {
      const form = await c.req.parseBody();
      const file = form.file;
      request.file = file instanceof Blob ? { blob: file, name: (file as File).name || "audio.webm" } : null;
    } else if (c.req.method !== "GET" && c.req.method !== "HEAD") {
      request.body = await jsonBody(c);
    }
    const deps = c.get("deps");
    const result = await handleInterviewConfigApi(request, {
      store: deps.store,
      llm: () => deps.llm?.() ?? null,
      settings: deps.settings ?? null,
      actor: c.get("actor"),
    });
    if (!result) return c.json({ detail: "Not found" }, 404);
    return c.json(result.body as object);
  };
  for (const prefix of INTERVIEW_CONFIG_PREFIXES) {
    app.all(prefix, handle);
    app.all(`${prefix}/*`, handle);
  }
}
