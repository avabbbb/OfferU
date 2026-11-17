// Route coverage: every /api path the frontend and the browser extension call must be served
// by the TS app (same Hono app on the companion and inside the web page), except the paths
// listed in KNOWN_UNSERVED with the reason. A new frontend call without a TS route fails here.
// Matching asks Hono's router directly (no request is sent, so nothing runs).

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { createApp } from "../src/app";
import { registerCompanionRoutes } from "../src/routes/companion";
import { SqliteCoreStore } from "../src/store";

const ROOT = resolve(__dirname, "../..");
const SOURCES = ["frontend/src", "extension/src", "extension/background.js"];
const SKIP = /(\.test\.|\.spec\.|api-types\.generated\.ts$|\/demo\/|\/showcase\/|node_modules)/;

/** Concrete stand-ins for template segments that are an enum, not an id. */
const EXPAND: Record<string, string[]> = {
  "/api/agent/runtime/career-tasks/1/1": ["/api/agent/runtime/career-tasks/1/cancel", "/api/agent/runtime/career-tasks/1/retry", "/api/agent/runtime/career-tasks/1/resume"],
  "/api/resume/1/1": ["/api/resume/1/pdf", "/api/resume/1/png"],
  "/api/tools/1": ["/api/tools/save"],
  "/api/agent/runtime/actions/1/1": ["/api/agent/runtime/actions/1/confirm", "/api/agent/runtime/actions/1/reject", "/api/agent/runtime/actions/1/undo"],
};

/**
 * Called by the frontend but not served by the TS backend, on purpose.
 * python_never: the Python backend never had it either (dead client code from older
 *   versions; the frontend cleanup task removes it, decision 5 of 2026-11-15).
 * research_dropped: Python /api/research/* (old djm.db services), not migrated by decision.
 */
const KNOWN_UNSERVED: Record<string, "python_never" | "research_dropped"> = {
  "/api/": "python_never", // apiAsset / local backend prefix checks, not a call
  "/api/applications/records": "python_never",
  "/api/applications/records/1": "python_never",
  "/api/applications/records/delete": "python_never",
  "/api/applications/records/move": "python_never",
  "/api/applications/settings": "python_never",
  "/api/applications/tables": "python_never",
  "/api/applications/tables/1": "python_never",
  "/api/applications/tables/1/import-boss": "python_never",
  "/api/applications/tables/1/import-jobs": "python_never",
  "/api/applications/tables/1/import-latest-extension-batch": "python_never",
  "/api/applications/tables/1/schema": "python_never",
  "/api/applications/template": "python_never",
  "/api/applications/progress-board": "python_never",
  "/api/applications/workspace": "python_never",
  "/api/calendar/auto-fill": "python_never",
  "/api/calendar/events": "python_never",
  "/api/email/accounts/1/revoke": "python_never",
  "/api/email/auth": "python_never",
  "/api/email/auth-url": "python_never",
  "/api/email/imap-connect": "python_never",
  "/api/email/notifications": "python_never",
  "/api/email/progress-candidates": "python_never",
  "/api/email/status": "python_never",
  "/api/email/sync": "python_never",
  "/api/email/sync-runs": "python_never",
  "/api/jobs/": "python_never",
  "/api/jobs/1": "python_never",
  "/api/jobs/batches": "python_never",
  "/api/jobs/capture": "python_never",
  "/api/jobs/capture/draft": "python_never",
  "/api/jobs/source-search": "python_never",
  "/api/jobs/stats": "python_never",
  "/api/jobs/trend": "python_never",
  "/api/optimize/proposals": "python_never",
  "/api/pools/": "python_never",
  "/api/pools/1": "python_never",
  "/api/profile/": "python_never",
  "/api/profile/agent/apply-patch": "python_never",
  "/api/profile/agent/message": "python_never",
  "/api/profile/agent/sessions/1": "python_never",
  "/api/profile/career-questions/1": "python_never",
  "/api/profile/career-questions/1/answers": "python_never",
  "/api/profile/career-snapshot": "python_never",
  "/api/profile/chat/confirm": "python_never",
  "/api/profile/chat/sessions": "python_never",
  "/api/profile/chat/sessions/1": "python_never",
  "/api/profile/generate-narrative": "python_never",
  "/api/profile/import-resume": "python_never",
  "/api/profile/import-resume/1/undo": "python_never",
  "/api/profile/instant-draft": "python_never",
  "/api/profile/sections": "python_never",
  "/api/profile/sections/1": "python_never",
  "/api/profile/smart-fill/cache/get": "python_never",
  "/api/profile/smart-fill/cache/set": "python_never",
  "/api/profile/smart-fill/catalog": "python_never",
  "/api/profile/smart-fill/map": "python_never",
  "/api/profile/smart-fill/runs/log": "python_never",
  "/api/profile/target-roles": "python_never",
  "/api/profile/target-roles/1": "python_never",
  "/api/resume/": "python_never",
  "/api/resume/1": "python_never",
  "/api/resume/1/ai/generate-draft": "python_never",
  "/api/resume/1/design": "python_never",
  "/api/resume/1/export/pdf": "python_never",
  "/api/resume/1/logo": "python_never",
  "/api/resume/1/logo/resolve": "python_never",
  "/api/resume/1/photo": "python_never",
  "/api/resume/1/sections": "python_never",
  "/api/resume/1/sections/1": "python_never",
  "/api/resume/1/sections/reorder": "python_never",
  "/api/resume/1/versions": "python_never",
  "/api/resume/1/versions/1": "python_never",
  "/api/resume/1/versions/1/restore": "python_never",
  "/api/resume/workspace/1": "python_never",
  "/api/resume/workspace/ensure": "python_never",
  "/api/resume/workspace/proposals/1/review-item": "python_never",
  "/api/resume/workspace/proposals/1/review-items": "python_never",
  "/api/scraper/tasks": "python_never",
  "/api/applications/tables/1/records": "python_never",
  "/api/profile/chat": "python_never",
  "/api/profile/agent/start": "python_never",
  "/api/profile/1_ts=1": "python_never", // extension: /api/profile/?_ts=…
  "/api/profile/smart-fill/ping": "python_never",
  "/api/profile/smart-fill/option-match": "python_never",
  "/api/profile/smart-fill/field-map": "python_never",
  "/api/profile/smart-fill/module-count": "python_never",
  "/api/resume/1/export/image": "python_never",
  "/api/feedback": "python_never",
  "/api/extension/version": "python_never",
  "/api/research/authorized-sessions": "research_dropped",
  "/api/research/job-runs": "research_dropped",
  "/api/research/job-runs/1": "research_dropped",
  "/api/research/job-runs/1/review": "research_dropped",
  "/api/research/pre-application/1": "research_dropped",
  "/api/research/pre-application/1/manual": "research_dropped",
  "/api/research/pre-application/1/prepare": "research_dropped",
  "/api/research/pre-application/decisions/1/review": "research_dropped",
  "/api/research/role-benchmarks/1/build": "research_dropped",
  "/api/research/role-benchmarks/1/refresh": "research_dropped",
  "/api/research/role-benchmarks/job/1": "research_dropped",
};

function files(path: string): string[] {
  const full = join(ROOT, path);
  let stat;
  try { stat = statSync(full); } catch { return []; }
  if (stat.isFile()) return [full];
  return readdirSync(full).flatMap((name) => files(join(path, name)));
}

/** Every /api/... literal (string or template; `${x}` → 1, query dropped) with where it appears. */
export function frontendCalls(): Map<string, Set<string>> {
  const calls = new Map<string, Set<string>>();
  for (const file of SOURCES.flatMap(files)) {
    if (!/\.(ts|tsx|js|mjs)$/.test(file) || SKIP.test(file)) continue;
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(/(?:["'`]|\})(\/api\/(?:[^"'`\s$?]|\$\{[^}]*\})*)/g)) {
      const path = match[1].replace(/\$\{[^}]*\}/g, "1");
      if (!calls.has(path)) calls.set(path, new Set());
      calls.get(path)!.add(relative(ROOT, file));
    }
  }
  return calls;
}

function served(app: ReturnType<typeof createApp>, path: string): boolean {
  return ["GET", "POST", "PUT", "PATCH", "DELETE"].some((method) => {
    const baseline = (app.router.match(method, "/api/__no_such_route__")[0] as unknown[]).length;
    return (app.router.match(method, path)[0] as unknown[]).length > baseline;
  });
}

describe("route coverage (frontend → TS backend)", () => {
  const store = new SqliteCoreStore(":memory:");
  const app = createApp({ store, runtime: "node", storage: "sqlite" });
  registerCompanionRoutes(app);
  const calls = frontendCalls();

  it("finds the frontend's calls", () => {
    expect(calls.size).toBeGreaterThan(100);
    expect(calls.has("/api/interviews/reviews")).toBe(true);
  });

  it("serves every called path except the known, documented ones", () => {
    const missing: string[] = [];
    for (const [path, where] of calls) {
      // "/api/files/" + name: a prefix concatenated at runtime.
      const variants = EXPAND[path] ?? (path.endsWith("/") && path !== "/api/" && !served(app, path) ? [`${path}1`] : [path]);
      if (variants.every((variant) => served(app, variant))) continue;
      if (path in KNOWN_UNSERVED) continue;
      missing.push(`${path}  (${[...where].join(", ")})`);
    }
    expect(missing).toEqual([]);
  });

  it("keeps KNOWN_UNSERVED honest: nothing listed is actually served", () => {
    const stale = Object.keys(KNOWN_UNSERVED).filter((path) => path !== "/api/" && served(app, path));
    expect(stale).toEqual([]);
  });
});
