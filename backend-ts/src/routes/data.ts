import type { Hono } from "hono";
import {
  CoreError,
  createBackup,
  dataSafetyStatus,
  exportData,
  importData,
  listBackups,
  nowIso,
  parseSnapshot,
  restoreBackup,
  todayIso,
  type BackupFiles,
} from "@offeru/core";

import type { AppDeps, AppEnv } from "../app";

/** Restore bodies are whole stores: allow more than the 2 MB JSON default. */
const MAX_SNAPSHOT_BYTES = 64 * 1024 * 1024;

function backups(deps: AppDeps): BackupFiles {
  if (!deps.backups) throw new CoreError("这个运行环境不保存备份文件；请用「导出数据」下载 JSON 备份", "unsupported");
  return deps.backups;
}

const ctxOf = (actor: string) => ({ actor, now: nowIso(), today: todayIso() });

/**
 * Data backup / restore. Runtime-agnostic: export / import need only the store
 * (they run in the browser app too); named backups need AppDeps.backups
 * (companion: <data>/backups), else 501.
 *
 * GET  /api/data/export                    → offeru-data v1 snapshot (download)
 * POST /api/data/import  {snapshot}        → replace everything (user only), pre-import backup when backups exist
 * GET  /api/agent/data/export              → offeru-data v1 snapshot + legacy settings-page fields
 * GET  /api/agent/data/backups             → {items, invalid}       (Python data_safety shape)
 * POST /api/agent/data/backups             → new backup item
 * POST /api/agent/data/restore {backup_id} → restored now (pending_restart false)
 * POST /api/agent/data/restore/cancel      → nothing is ever staged
 * GET  /api/agent/data/safety/status
 */
export function registerData(app: Hono<AppEnv>): void {
  app.get("/api/data/export", async (c) => {
    const snapshot = await exportData(c.get("deps").store, nowIso());
    const day = snapshot.exported_at.slice(0, 10).replace(/-/g, "");
    c.header("Content-Disposition", `attachment; filename="offeru-data-${day}.json"`);
    return c.json(snapshot);
  });

  app.post("/api/data/import", async (c) => {
    const deps = c.get("deps");
    const text = await c.req.text();
    if (text.length > MAX_SNAPSHOT_BYTES) throw new CoreError("备份文件太大（超过 64 MB）");
    const body = text ? JSON.parse(text) as Record<string, unknown> : {};
    const ctx = ctxOf(c.get("actor"));
    // Check permission and shape before touching anything (importData checks again).
    if (ctx.actor !== "你") throw new CoreError("恢复数据会替换全部记录，只能由用户本人在设置里操作", "forbidden");
    const snapshot = body.snapshot ?? body;
    parseSnapshot(snapshot);
    const pre = deps.backups ? await createBackup(deps.store, deps.backups, "pre_restore", ctx.now) : null;
    const result = await importData(deps.store, snapshot, ctx);
    return c.json({ ...result, pre_restore_backup_id: pre?.backup_id ?? null });
  });

  // Settings page「导出数据」still calls the Python route; serve it from the same snapshot so the
  // web build and the TS companion do not 404. The body is an offeru-data v1 snapshot (importable
  // as-is via /api/data/import) plus the legacy fields the page reads; counts are records only.
  app.get("/api/agent/data/export", async (c) => {
    const snapshot = await exportData(c.get("deps").store, nowIso());
    const { changes: _changes, ...recordCounts } = snapshot.counts;
    return c.json({
      ...snapshot,
      schema_version: "offeru.internal-beta.export.v1",
      scope: "local_core_career_state",
      redactions: ["provider and connection credentials", "sync credentials and passphrase"],
      counts: recordCounts,
    });
  });

  app.get("/api/agent/data/backups", async (c) => c.json(await listBackups(backups(c.get("deps")))));

  app.post("/api/agent/data/backups", async (c) => {
    const deps = c.get("deps");
    return c.json(await createBackup(deps.store, backups(deps), "user", nowIso()));
  });

  app.post("/api/agent/data/restore", async (c) => {
    const deps = c.get("deps");
    const body = (await c.req.json().catch(() => ({}))) as { backup_id?: unknown };
    return c.json(await restoreBackup(deps.store, backups(deps), String(body.backup_id ?? ""), ctxOf(c.get("actor"))));
  });

  app.post("/api/agent/data/restore/cancel", (c) => c.json({ cancelled: false }));

  app.get("/api/agent/data/safety/status", async (c) => {
    const deps = c.get("deps");
    return c.json(await dataSafetyStatus(backups(deps), { exists: deps.storage !== "none", filename: "offeru.db" }, deps.storage === "sqlite" ? "managed_local" : deps.storage));
  });
}
