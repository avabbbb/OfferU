import type { Context, Hono } from "hono";
import {
  AUTOMATION_GONE,
  BACKGROUND_TASKS_GONE,
  CurrentViewState,
  HOSTED_SESSIONS_GONE,
  PLUGINS_GONE,
  checkDataIntegrity,
  connectionsSnapshot,
  diagnosticBundle,
  emptyAutomation,
  emptyCareerArtifacts,
  emptyCareerTasks,
  emptyConformance,
  emptyHostedSessions,
  emptyPlugins,
  freshLocalReset,
  notFound,
  nowIso,
  privacyHygieneStatus,
  purgeSyntheticEmailTestData,
  resetDemoData,
  scrubLegacyEmailBodies,
  todayIso,
  unsupported,
  CoreError,
} from "@offeru/core";

import { jsonBody, type AppDeps, type AppEnv } from "../app";

/** What a runtime can say about its build (companion: env from the desktop shell + build metadata). */
export interface RuntimeIdentity {
  runtime_instance_id: string | null;
  version: string | null;
  commit: string | null;
  build_timestamp: string | null;
  dirty: boolean | null;
  source_fingerprint: string | null;
  data_root: string | null;
  runtime_type: string;
  build_source: "package" | "source" | "unknown";
}

export interface RuntimeInfo {
  /** App version (desktop: OFFERU_VERSION = the Tauri version). */
  appVersion: string;
  buildMode: string;
  runtimeMode: string;
  identity: () => RuntimeIdentity;
  /** One-time `#/pair/<code>` codes minted by `offeru-ts start`; null = unknown/expired. */
  exchangePairCode?: (code: string) => string | null;
  /** Mint a one-time pair code (lite `start`). */
  mintPairCode?: (ttlMs?: number) => string;
}

const views = new WeakMap<AppDeps, CurrentViewState>();
function viewState(deps: AppDeps): CurrentViewState {
  let state = views.get(deps);
  if (!state) views.set(deps, state = new CurrentViewState());
  return state;
}

function browserIdentity(deps: AppDeps): RuntimeIdentity {
  return {
    runtime_instance_id: null, version: null, commit: null, build_timestamp: null, dirty: null,
    source_fingerprint: null, data_root: null, runtime_type: deps.runtime, build_source: "unknown",
  };
}

async function boardRows(deps: AppDeps): Promise<Array<Record<string, unknown>>> {
  if (!deps.agentBoard) return [];
  const listed = await deps.agentBoard.list();
  return Array.isArray(listed.agents) ? listed.agents as Array<Record<string, unknown>> : [];
}

/** node:http remote address under @hono/node-server; undefined elsewhere (browser / Worker / app.request). */
function remoteAddress(c: Context<AppEnv>): string | undefined {
  const env = c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined;
  return env?.incoming?.socket?.remoteAddress;
}

const LOOPBACK = /^(127\.\d+\.\d+\.\d+|::1|::ffff:127\.\d+\.\d+\.\d+)$/;

/**
 * The rest of Python routes/main_agent.py + main.py that the frontend still calls:
 *   /api/agent/context                         current view for the Agent (process memory)
 *   /api/agent/runtime/connections[/:id/probe|integration]  projection of the companion Agent board
 *   /api/agent/data/{fresh-reset,privacy-hygiene*,safety/integrity,demo/reset}
 *   /api/agent/diagnostics/bundle, /api/diagnostics/runtime-identity, /api/ui/pair
 *   career-tasks / career-artifacts / automation / hosted-sessions / conformance / plugins:
 *   Python-workspace-only surfaces (ops.py, not migrated by decision) → empty lists, 404/501 on writes.
 */
export function registerAgentExtras(app: Hono<AppEnv>): void {
  // ---- current view ----
  app.get("/api/agent/context", (c) => c.json(viewState(c.get("deps")).get(c.req.query("scope") || "default")));
  app.put("/api/agent/context", async (c) => c.json(viewState(c.get("deps")).set(await jsonBody(c), nowIso())));
  app.delete("/api/agent/context", (c) => c.json(viewState(c.get("deps")).clear(c.req.query("scope") || "default")));

  // ---- local Agent connections (Agent board) ----
  app.get("/api/agent/runtime/connections", async (c) => c.json(connectionsSnapshot(await boardRows(c.get("deps")), nowIso())));
  app.post("/api/agent/runtime/connections/:providerId/probe", async (c) => {
    const deps = c.get("deps");
    if (!deps.agentBoard) unsupported("连接本机 Agent 只在 OfferU 桌面版 / 本机伴侣里可用");
    await deps.agentBoard!.check(c.req.param("providerId"));
    return c.json(connectionsSnapshot(await boardRows(deps), nowIso()));
  });
  app.post("/api/agent/runtime/connections/:providerId/integration", async (c) => {
    const deps = c.get("deps");
    if (!deps.agentBoard) unsupported("连接本机 Agent 只在 OfferU 桌面版 / 本机伴侣里可用");
    const body = await jsonBody(c) as { action?: unknown };
    const action = body?.action === undefined ? "install" : String(body.action);
    if (!/^(install|update|repair)$/.test(action)) throw new CoreError("连接动作只支持 install、update 或 repair");
    await deps.agentBoard!.connect(c.req.param("providerId"), action);
    return c.json(connectionsSnapshot(await boardRows(deps), nowIso()));
  });
  app.get("/api/agent/runtime/conformance", (c) => c.json(emptyConformance()));
  app.post("/api/agent/runtime/conformance/codex-offeru", () => unsupported("本机 Agent 一致性检查不再提供"));
  app.post("/api/agent/runtime/conformance/:providerId/probe", () => unsupported("本机 Agent 一致性检查不再提供"));

  // ---- Python-workspace-only background surfaces ----
  app.get("/api/agent/runtime/career-tasks", (c) => c.json(emptyCareerTasks()));
  app.post("/api/agent/runtime/career-tasks", () => unsupported(BACKGROUND_TASKS_GONE));
  app.get("/api/agent/runtime/career-tasks/:taskId", () => notFound("这个后台任务"));
  app.get("/api/agent/runtime/career-tasks/:taskId/events", () => notFound("这个后台任务"));
  app.get("/api/agent/runtime/career-tasks/:taskId/result", () => notFound("这个后台任务"));
  for (const action of ["cancel", "retry", "resume"]) {
    app.post(`/api/agent/runtime/career-tasks/:taskId/${action}`, () => notFound("这个后台任务"));
  }
  app.get("/api/agent/runtime/career-artifacts", (c) => {
    const id = Number(c.req.query("related_job_id"));
    if (!Number.isInteger(id) || id <= 0) throw new CoreError("related_job_id 要是正整数");
    return c.json(emptyCareerArtifacts());
  });
  app.get("/api/agent/runtime/career-artifacts/:artifactId", (c) => c.json({ detail: "Career artifact not found" }, 404));
  app.get("/api/agent/runtime/automation/events", (c) => c.json(emptyAutomation("events")));
  app.post("/api/agent/runtime/automation/events", () => unsupported(AUTOMATION_GONE));
  app.get("/api/agent/runtime/automation/inbox", (c) => c.json(emptyAutomation("inbox")));
  app.post("/api/agent/runtime/automation/inbox/:itemId", () => notFound("这条自动化建议"));
  app.get("/api/agent/runtime/automation/rules", (c) => c.json(emptyAutomation("rules")));
  app.post("/api/agent/runtime/automation/daily-review", (c) => c.json({ status: "skipped", reason: "automation_not_available" }));
  app.get("/api/agent/runtime/hosted-sessions", (c) => c.json(emptyHostedSessions()));
  app.get("/api/agent/runtime/hosted-sessions/:sessionId", () => notFound("这个托管会话"));
  app.post("/api/agent/runtime/hosted-sessions/:sessionId/cancel", () => unsupported(HOSTED_SESSIONS_GONE));
  app.post("/api/agent/runtime/hosted-sessions/:sessionId/resume", () => unsupported(HOSTED_SESSIONS_GONE));
  app.get("/api/agent/runtime/plugins", (c) => c.json(emptyPlugins()));
  app.get("/api/agent/runtime/plugins/capabilities", (c) => c.json(emptyPlugins()));
  app.post("/api/agent/runtime/plugins/:plugin/install", () => unsupported(PLUGINS_GONE));
  app.delete("/api/agent/runtime/plugins/:plugin", () => unsupported(PLUGINS_GONE));

  // ---- data safety ----
  app.post("/api/agent/data/fresh-reset", async (c) => {
    const deps = c.get("deps");
    const ctx = { actor: c.get("actor"), now: nowIso(), today: todayIso() };
    return c.json(await freshLocalReset(deps.store, deps.backups, ctx));
  });
  app.post("/api/agent/data/demo/reset", (c) => c.json(resetDemoData()));
  app.get("/api/agent/data/privacy-hygiene", (c) => c.json(privacyHygieneStatus()));
  app.post("/api/agent/data/privacy-hygiene/scrub", (c) => c.json(scrubLegacyEmailBodies()));
  app.post("/api/agent/data/privacy-hygiene/purge-synthetic", (c) => c.json(purgeSyntheticEmailTestData()));
  app.get("/api/agent/data/safety/integrity", async (c) => c.json(await checkDataIntegrity(c.get("deps").store, nowIso())));

  // ---- diagnostics ----
  app.get("/api/agent/diagnostics/bundle", async (c) => {
    const deps = c.get("deps");
    const info = deps.runtimeInfo;
    const engine = typeof globalThis.process?.versions?.node === "string" ? `node ${globalThis.process.versions.node}` : deps.runtime;
    const platform = typeof globalThis.process?.platform === "string" ? `${globalThis.process.platform}-${globalThis.process.arch}` : deps.runtime;
    return c.json(await diagnosticBundle(deps.store, {
      now: nowIso(),
      version: info?.appVersion ?? "",
      buildMode: info?.buildMode ?? (deps.runtime === "browser" ? "web" : "local-development"),
      runtimeMode: info?.runtimeMode ?? deps.runtime,
      engine,
      platform,
      storage: deps.storage,
      backups: deps.backups,
    }));
  });

  app.get("/api/diagnostics/runtime-identity", (c) => {
    const deps = c.get("deps");
    const remote = remoteAddress(c);
    if (remote !== undefined && !LOOPBACK.test(remote)) return c.json({ detail: "本地诊断信息仅供本机查看" }, 403);
    return c.json(deps.runtimeInfo ? deps.runtimeInfo.identity() : browserIdentity(deps));
  });

  // `offeru-ts start` opens #/pair/<code>: trade the one-time code for the workbench token.
  app.post("/api/ui/pair", async (c) => {
    const deps = c.get("deps");
    const body = await jsonBody(c) as { code?: unknown };
    if (typeof body?.code !== "string") throw new CoreError("code 要是字符串");
    const token = deps.runtimeInfo?.exchangePairCode?.(body.code) ?? null;
    if (!token) return c.json({ detail: "配对码无效或已过期，请重新运行 offeru start" }, 403);
    return c.json({ token });
  });
}
