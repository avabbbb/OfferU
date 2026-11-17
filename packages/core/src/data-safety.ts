// Settings → 数据安全 / 诊断 on the records store (Python main_agent.py /data/* and
// /diagnostics/bundle). Python ran these over the old SQLAlchemy workspace (djm.db: email
// notifications, career tasks, automation events, role benchmarks); that layer is gone,
// so what is left is answered honestly over the records/changes store:
//   - integrity: the engine's own check when the store has one, plus record-level checks
//     (every job_id points at a job, every change names a known record type);
//   - privacy hygiene: there are no legacy email bodies or synthetic mailboxes to clean;
//   - demo reset: the records store has no reserved Demo scope;
//   - fresh reset: a pre_reset backup, then every record and change is removed.

import { CoreError, type CoreContext, type CoreStore } from "./types";
import { RECORD_TYPES, dumpRows } from "./data";
import { createBackup, listBackups, type BackupFiles } from "./data-backups";
import { USER_ACTOR } from "./operations";

/** Schema version of the records/changes layout (Python core/store.py has no user_version either). */
export const RECORDS_SCHEMA_VERSION = 1;

export type IntegrityReport = {
  status: "ok" | "failed";
  integrity_check: string[];
  foreign_key_violations: unknown[][];
  schema: { user_version: number; schema_version: number };
  checked_at: string;
};

/** GET /api/agent/data/safety/integrity */
export async function checkDataIntegrity(store: CoreStore, now: string): Promise<IntegrityReport> {
  const engine = store.checkIntegrity ? await store.checkIntegrity() : { integrity_check: ["ok"], foreign_key_violations: [], user_version: 0 };
  const rows = await dumpRows(store);
  const jobs = new Set(rows.records.filter((row) => row.type === "job").map((row) => row.id));
  const violations: unknown[][] = [...engine.foreign_key_violations];
  for (const row of rows.records) {
    if (row.job_id !== null && !jobs.has(row.job_id)) violations.push(["records", row.id, "job", row.job_id]);
  }
  for (const change of rows.changes) {
    if (!RECORD_TYPES.includes(change.type)) violations.push(["changes", change.id, "type", change.type]);
  }
  const ok = engine.integrity_check.length === 1 && engine.integrity_check[0] === "ok" && violations.length === 0;
  return {
    status: ok ? "ok" : "failed",
    integrity_check: engine.integrity_check,
    foreign_key_violations: violations,
    schema: { user_version: engine.user_version, schema_version: RECORDS_SCHEMA_VERSION },
    checked_at: now,
  };
}

/** GET /api/agent/data/privacy-hygiene — nothing legacy left to scrub in the records store. */
export function privacyHygieneStatus(): Record<string, unknown> {
  return {
    status: "clear",
    legacy_email_notification_bodies: { records: 0, characters: 0 },
    synthetic_email_test_data: {},
    safe_to_publish: true,
  };
}

/** POST /api/agent/data/privacy-hygiene/scrub */
export function scrubLegacyEmailBodies(): Record<string, unknown> {
  return { scrubbed_records: 0, status: privacyHygieneStatus() };
}

/** POST /api/agent/data/privacy-hygiene/purge-synthetic */
export function purgeSyntheticEmailTestData(): Record<string, unknown> {
  return { purged: {}, status: {} };
}

/** POST /api/agent/data/demo/reset — the records store keeps no reserved Demo batch. */
export function resetDemoData(): Record<string, unknown> {
  return {
    reset: false,
    scope: { source: "demo", batch_id: "" },
    matched_jobs: 0,
    reason: "no_demo_data",
    deleted: {},
    real_data_preserved: true,
  };
}

/**
 * POST /api/agent/data/fresh-reset: back up (reason pre_reset), then remove every record and
 * change. Only the user (the settings button after typing the phrase), never an Agent.
 */
export async function freshLocalReset(store: CoreStore, files: BackupFiles | null | undefined, ctx: CoreContext): Promise<Record<string, unknown>> {
  if (ctx.actor !== USER_ACTOR) throw new CoreError("全清只能由用户本人在设置里操作", "forbidden");
  if (!files) throw new CoreError("这个运行环境不能先做备份，不提供全清", "unsupported");
  if (!store.replaceAll) throw new CoreError("这个运行环境的数据存储不支持全清", "unsupported");
  const backup = await createBackup(store, files, "pre_reset", ctx.now);
  const before = await dumpRows(store);
  await store.transaction(() => store.replaceAll!({ records: [], changes: [] }));
  const deleted: Record<string, number> = {};
  for (const row of before.records) deleted[row.type] = (deleted[row.type] ?? 0) + 1;
  if (before.changes.length) deleted.changes = before.changes.length;
  return {
    reset: true,
    scope: "active_local_business_workspace",
    deleted,
    deleted_total_rows: before.records.length + before.changes.length,
    workspace_reinitialized: true,
    file_cleanup_complete: true,
    backup: { backup_id: backup.backup_id, created_at: backup.created_at, size_bytes: backup.size_bytes },
  };
}

export type DiagnosticsInput = {
  now: string;
  version: string;
  buildMode: string;
  runtimeMode: string;
  /** "node 22.x" / "browser"; the bundle field is still called `python` for the settings page. */
  engine: string;
  platform: string;
  storage: string;
  backups: BackupFiles | null | undefined;
  /** Recent failed Agent runs (id, error, time) — no message content. */
  failedRuns?: Array<{ run_id: string; status: string; error: string; updated_at: string }>;
};

/** GET /api/agent/diagnostics/bundle — local-only, content-free. */
export async function diagnosticBundle(store: CoreStore, input: DiagnosticsInput): Promise<Record<string, unknown>> {
  const integrity = await checkDataIntegrity(store, input.now);
  const backups = input.backups ? await listBackups(input.backups).catch(() => ({ items: [], invalid: [] })) : { items: [], invalid: [] };
  return {
    schema_version: "offeru.diagnostics.v2",
    created_at: input.now,
    app: { version: input.version, build_mode: input.buildMode, runtime_mode: input.runtimeMode, python: input.engine, platform: input.platform },
    database: {
      status: integrity.status,
      database_exists: input.storage !== "none",
      backup_count: backups.items.length,
      invalid_backup_count: backups.invalid.length,
      pending_restore: false,
      storage_mode: input.storage,
      foreign_key_violation_count: integrity.foreign_key_violations.length,
    },
    startup_recovery: { status: "ok", checks: {}, failed_checks: [] },
    agent_providers: [],
    durable_failures: {
      status: "ok",
      career_tasks: [],
      automation_events: [],
      role_benchmarks: [],
      job_research: [],
      agent_runs: input.failedRuns ?? [],
      counts: { career_tasks: 0, automation_events: 0, role_benchmarks: 0, job_research: 0, agent_runs: input.failedRuns?.length ?? 0 },
    },
    recent_errors: [],
    privacy: {
      contains_user_content: false,
      contains_credentials: false,
      contains_file_paths: false,
      scope: "local_only",
    },
  };
}
