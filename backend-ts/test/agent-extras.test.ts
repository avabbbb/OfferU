// The Python main_agent.py / main.py routes the frontend still calls, on the TS app.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createApp, type AppDeps } from "../src/app";
import { nodeBackupFiles } from "../src/routes/companion/backups";
import { nodeRuntimeInfo } from "../src/runtime-identity";
import { SqliteCoreStore } from "../src/store";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function setup(overrides: Partial<AppDeps> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "offeru-extras-"));
  const store = new SqliteCoreStore(":memory:");
  cleanups.push(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const app = createApp({ store, runtime: "node", storage: "sqlite", backups: nodeBackupFiles(join(dir, "offeru.db")), ...overrides });
  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const response = await app.request(path, {
      method,
      headers: { ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() as any };
  };
  return { app, store, call, dir };
}

describe("/api/agent/context", () => {
  it("stores the current view per scope and bumps the version", async () => {
    const { call } = setup();
    expect((await call("GET", "/api/agent/context")).body.outputs).toMatchObject({ scope: "default", route: "", version: 0, updated_at: null });
    const first = await call("PUT", "/api/agent/context", { route: "/jobs", title: "岗位", entity_type: "job", entity_id: 3, context: { tab: "board" } });
    expect(first.body).toMatchObject({ ok: true, outputs: { route: "/jobs", entity_id: "3", version: 1, context: { tab: "board" }, updated_by: "ui" } });
    expect((await call("PUT", "/api/agent/context", { route: "/resume" })).body.outputs.version).toBe(2);
    expect((await call("GET", "/api/agent/context")).body.outputs.route).toBe("/resume");
    expect((await call("DELETE", "/api/agent/context")).body.outputs).toEqual({ scope: "default", cleared: true });
    expect((await call("GET", "/api/agent/context")).body.outputs.version).toBe(0);
  });
});

describe("/api/agent/runtime/connections", () => {
  it("off the companion: empty list with the connect prompt; probe is 501", async () => {
    const { call } = setup();
    const snapshot = await call("GET", "/api/agent/runtime/connections");
    expect(snapshot.body).toMatchObject({ items: [], recommended_provider_id: null });
    expect(snapshot.body.connect_prompt).toContain("OfferU 桌面版");
    expect((await call("POST", "/api/agent/runtime/connections/codex/probe")).status).toBe(501);
  });

  it("projects the Agent board rows", async () => {
    const rows = [
      { id: "codex", display_name: "Codex", executable_found: true, skill_status: "INSTALLED", connected: true, hidden: false, last_check: { at: "2026-11-18T01:00:00" }, docs_url: "https://x", skill_path: "/s", error: "" },
      { id: "claude", display_name: "Claude Code", executable_found: false, skill_status: "NOT_INSTALLED", connected: false, hidden: false, last_check: {} },
      { id: "pi", display_name: "Pi", executable_found: true, skill_status: "NOT_INSTALLED", connected: false, hidden: true, last_check: {} },
    ];
    const calls: string[] = [];
    const board = {
      list: async () => ({ agents: rows }),
      check: async (id: string) => { calls.push(`check:${id}`); return {}; },
      connect: async (id: string, action: string) => { calls.push(`connect:${id}:${action}`); return {}; },
    } as unknown as AppDeps["agentBoard"];
    const { call } = setup({ agentBoard: board });
    const snapshot = (await call("GET", "/api/agent/runtime/connections")).body;
    expect(snapshot.items.map((item: any) => [item.id, item.status, item.connection_verified, item.installed])).toEqual([
      ["codex", "ready", true, true],
      ["claude", "missing", false, false],
    ]);
    expect(snapshot.recommended_provider_id).toBe("codex");
    await call("POST", "/api/agent/runtime/connections/codex/probe");
    await call("POST", "/api/agent/runtime/connections/codex/integration", { action: "repair" });
    expect((await call("POST", "/api/agent/runtime/connections/codex/integration", { action: "rm" })).status).toBe(400);
    expect(calls).toEqual(["check:codex", "connect:codex:repair"]);
  });
});

describe("Python-workspace-only surfaces", () => {
  it("answer empty lists, 404 for ids and 501 for new work", async () => {
    const { call } = setup();
    expect((await call("GET", "/api/agent/runtime/career-tasks?limit=5")).body).toMatchObject({ tasks: [] });
    expect((await call("POST", "/api/agent/runtime/career-tasks", { task_type: "x" })).status).toBe(501);
    expect((await call("POST", "/api/agent/runtime/career-tasks/t1/retry")).status).toBe(404);
    expect((await call("GET", "/api/agent/runtime/career-artifacts?related_job_id=3")).body).toEqual({ items: [], total: 0 });
    expect((await call("GET", "/api/agent/runtime/career-artifacts")).status).toBe(400);
    expect((await call("GET", "/api/agent/runtime/career-artifacts/a1")).body).toEqual({ detail: "Career artifact not found" });
    expect((await call("GET", "/api/agent/runtime/automation/inbox?status=pending")).body.items).toEqual([]);
    expect((await call("POST", "/api/agent/runtime/automation/inbox/i1", { action: "dismiss" })).status).toBe(404);
    expect((await call("POST", "/api/agent/runtime/automation/daily-review")).body.status).toBe("skipped");
    expect((await call("GET", "/api/agent/runtime/hosted-sessions?limit=20")).body).toEqual({ items: [] });
    expect((await call("GET", "/api/agent/runtime/hosted-sessions/s1")).status).toBe(404);
    expect((await call("POST", "/api/agent/runtime/hosted-sessions/s1/cancel", { confirmed: true })).status).toBe(501);
  });
});

describe("data safety", () => {
  it("integrity: SQLite checks plus dangling job_id", async () => {
    const { call, store } = setup();
    expect((await call("GET", "/api/agent/data/safety/integrity")).body).toMatchObject({ status: "ok", integrity_check: ["ok"], foreign_key_violations: [], schema: { schema_version: 1 } });
    await store.transaction(() => store.replaceAll!({ records: [{ id: 5, type: "event", job_id: 99, data: { title: "x" }, created_at: "2026-11-18T00:00:00", updated_at: "2026-11-18T00:00:00" }], changes: [] }));
    const broken = (await call("GET", "/api/agent/data/safety/integrity")).body;
    expect(broken.status).toBe("failed");
    expect(broken.foreign_key_violations).toEqual([["records", 5, "job", 99]]);
  });

  it("privacy hygiene and demo reset have nothing to do on the records store", async () => {
    const { call } = setup();
    expect((await call("GET", "/api/agent/data/privacy-hygiene")).body).toMatchObject({ status: "clear", safe_to_publish: true, legacy_email_notification_bodies: { records: 0 } });
    expect((await call("POST", "/api/agent/data/privacy-hygiene/scrub")).body.scrubbed_records).toBe(0);
    expect((await call("POST", "/api/agent/data/privacy-hygiene/purge-synthetic")).body).toEqual({ purged: {}, status: {} });
    expect((await call("POST", "/api/agent/data/demo/reset")).body).toMatchObject({ reset: false, real_data_preserved: true });
  });

  it("fresh reset: pre_reset backup, then everything is gone; agents are refused", async () => {
    const { call } = setup();
    await call("POST", "/api/tools/save", { type: "job", data: { company: "飞书", title: "产品实习" } });
    expect((await call("POST", "/api/agent/data/fresh-reset", undefined, { "x-offeru-actor": "agent" })).status).toBe(403);
    const reset = await call("POST", "/api/agent/data/fresh-reset");
    expect(reset.status).toBe(200);
    expect(reset.body).toMatchObject({ reset: true, deleted: { job: 1, changes: 1 }, deleted_total_rows: 2 });
    const backups = (await call("GET", "/api/agent/data/backups")).body.items;
    expect(backups.find((item: any) => item.backup_id === reset.body.backup.backup_id)?.reason).toBe("pre_reset");
    expect((await call("POST", "/api/tools/list", { type: "job" })).body).toMatchObject({ items: [], total: 0 });
  });

  it("fresh reset needs somewhere to back up first", async () => {
    const { call } = setup({ backups: null });
    expect((await call("POST", "/api/agent/data/fresh-reset")).status).toBe(501);
  });

  it("diagnostic bundle carries no content", async () => {
    const { call } = setup();
    await call("POST", "/api/tools/save", { type: "job", data: { company: "保密公司", title: "x" } });
    const bundle = (await call("GET", "/api/agent/diagnostics/bundle")).body;
    expect(bundle).toMatchObject({ database: { status: "ok", database_exists: true, foreign_key_violation_count: 0 }, durable_failures: { status: "ok" }, recent_errors: [] });
    expect(JSON.stringify(bundle)).not.toContain("保密公司");
  });
});

describe("runtime identity, health and lite pairing", () => {
  it("desktop sidecar: health carries the identity the shell checks", async () => {
    const env = {
      OFFERU_VERSION: "0.2.0", OFFERU_BUILD_MODE: "local-development", OFFERU_RUNTIME_MODE: "desktop-sidecar",
      OFFERU_RUNTIME_INSTANCE_ID: "123e4567-e89b-42d3-a456-426614174000", OFFERU_DATA_DIR: "/tmp/offeru-data",
      OFFERU_BUILD_COMMIT: "a".repeat(40), OFFERU_BUILD_DIRTY: "false", OFFERU_APPROVAL_TOKEN: "approval",
    };
    const info = nodeRuntimeInfo(env);
    const { call } = setup({ runtimeInfo: info });
    const health = (await call("GET", "/api/health")).body;
    expect(health).toMatchObject({
      status: "ok", service: "OfferU", runtime: "node", version: "0.2.0", build_mode: "local-development", runtime_mode: "desktop-sidecar",
      runtime_instance_id: env.OFFERU_RUNTIME_INSTANCE_ID,
      build_identity: { version: "0.2.0", commit: "a".repeat(40), dirty: false, build_timestamp: null, source_fingerprint: null, data_root: "/tmp/offeru-data", runtime_type: "desktop-sidecar", build_source: "source" },
    });
    expect((await call("GET", "/api/diagnostics/runtime-identity")).body).toEqual(health.build_identity);

    expect((await call("POST", "/api/ui/pair", { code: "nope" })).status).toBe(403);
    const code = info.mintPairCode!();
    expect((await call("POST", "/api/ui/pair", { code })).body).toEqual({ token: "approval" });
    expect((await call("POST", "/api/ui/pair", { code })).status).toBe(403);
  });

  it("packaged build: invalid metadata leaves the identity unknown", async () => {
    const info = nodeRuntimeInfo({ OFFERU_VERSION: "0.2.0", OFFERU_BUILD_IDENTITY_PATH: "/no/such/file.json", OFFERU_RUNTIME_MODE: "desktop-sidecar" });
    expect(info.identity()).toMatchObject({ build_source: "unknown", commit: null, version: null, runtime_type: "desktop-sidecar" });
  });

  it("web / Worker: identity without build facts, health unchanged", async () => {
    const { call } = setup({ runtime: "browser", storage: "indexeddb" });
    expect((await call("GET", "/api/diagnostics/runtime-identity")).body).toMatchObject({ runtime_type: "browser", build_source: "unknown", commit: null });
    const health = (await call("GET", "/api/health")).body;
    expect(health.build_identity).toBeUndefined();
    expect(health.version).toBe("0.1.0");
  });
});
