import type { Context, Hono } from "hono";
import { handleInterviewApi, INTERVIEW_API_PREFIXES, type ApiRequest } from "@offeru/core";

import { jsonBody, type AppEnv } from "../app";

/**
 * /api/interviews (mock interviews, reviews, scoring), /api/interview (question bank),
 * /api/consent (logged-in platform collection), /api/connections (job sources).
 * Thin Hono glue over core's handleInterviewApi: paths, validation and response
 * shapes live in packages/core, so the companion and the in-page web backend answer
 * the same way. The model comes from deps.llm (built per request from the saved config).
 */
export function registerInterviews(app: Hono<AppEnv>): void {
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
    const result = await handleInterviewApi(request, {
      store: deps.store,
      llm: () => deps.llm?.() ?? null,
      consent: deps.consent ?? null,
      actor: c.get("actor"),
    });
    if (!result) return c.json({ detail: "Not found" }, 404);
    return c.json(result.body as object);
  };
  for (const prefix of INTERVIEW_API_PREFIXES) {
    app.all(prefix, handle);
    app.all(`${prefix}/*`, handle);
  }
}
