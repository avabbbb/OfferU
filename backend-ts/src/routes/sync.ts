import type { Context, Hono } from "hono";

import type { AppEnv } from "../app";
import { jsonBody } from "../app";

/**
 * S3/R2 sync endpoints. The route only parses and maps errors; the engine is
 * @offeru/sync and the runtime-specific part (where config and state live) is
 * injected as AppDeps.sync (backend-ts/src/syncService.ts on both the companion
 * and the web build), so this module stays Worker-safe.
 *
 *   GET  /api/sync/status                    -> SyncStatusView (progress while a sync runs)
 *   POST /api/sync/configure                 { provider, endpoint, bucket, region, accessKeyId, secretAccessKey, prefix, pathStyle, passphrase, remember } | { clear: true }
 *   POST /api/sync/test                      same body as configure, saves nothing -> Diagnosis
 *   POST /api/sync/now                       -> { result, status }
 *   GET  /api/sync/conflicts                 -> { conflicts: ConflictView[] }
 *   POST /api/sync/conflicts/:id/resolve     { keep: "mine" | "theirs" } -> { applied, conflicts }
 *   POST /api/sync/export                    { passphrase } -> application/vnd.offeru.backup (.offeru file)
 *   POST /api/sync/import                    multipart: file, passphrase -> { result }
 */
export type SyncConfigView = {
  provider: string;
  endpoint: string;
  bucket: string;
  region: string;
  prefix: string;
  pathStyle: boolean;
  accessKeyId: string; // masked
};

export type SyncStatusView = {
  configured: boolean;
  config: SyncConfigView | null;
  /** stored = persisted (companion file / browser encrypted at rest); session = until reload; missing = re-enter */
  secrets: "stored" | "session" | "missing" | null;
  needs_secret: boolean;
  syncing: boolean;
  progress: unknown;
  device: string | null;
  last_sync_at: string | null;
  pending: number | null;
  last_result: unknown;
  last_error: { code: string; message: string; at: string } | null;
};

export interface SyncController {
  status(): Promise<SyncStatusView>;
  configure(input: Record<string, unknown>): Promise<SyncStatusView>;
  test(input: Record<string, unknown>): Promise<unknown>;
  syncNow(): Promise<{ result: unknown; status: SyncStatusView }>;
  conflicts(): Promise<unknown>;
  resolveConflict(id: number, keep: "mine" | "theirs", actor: string): Promise<unknown>;
  exportBackup(passphrase: string): Promise<{ bytes: Uint8Array; filename: string; records: number }>;
  importBackup(bytes: Uint8Array, passphrase: string): Promise<unknown>;
}

const STATUS_OF_SYNC: Record<string, number> = {
  config: 400,
  passphrase: 400,
  format: 422,
  decrypt: 422,
  auth: 401,
  network: 502,
  http: 502,
  locked: 409,
  conflict: 409,
};

/** Backups are the whole dataset; far above the 2 MB JSON cap, still bounded. */
const MAX_BACKUP_BYTES = 256 * 1024 * 1024;

function controller(c: Context<AppEnv>): SyncController | null {
  return (c.get("deps") as { sync?: SyncController }).sync ?? null;
}

function syncErrorResponse(c: Context<AppEnv>, error: unknown) {
  const code = (error as { name?: string; code?: string }).name === "SyncError" ? (error as { code: string }).code : "";
  if (!code) throw error;
  return c.json({ detail: (error as Error).message, code: `sync_${code}` }, (STATUS_OF_SYNC[code] ?? 500) as 400);
}

async function guarded(c: Context<AppEnv>, run: (sync: SyncController) => Promise<unknown>) {
  const sync = controller(c);
  if (!sync) return c.json({ detail: "这个运行环境没有开启同步", code: "unsupported" }, 501);
  try {
    return c.json(await run(sync) as object);
  } catch (error) {
    return syncErrorResponse(c, error);
  }
}

async function objectBody(c: Context<AppEnv>): Promise<Record<string, unknown>> {
  const body = await jsonBody(c);
  return typeof body === "object" && body !== null ? body as Record<string, unknown> : {};
}

export function registerSync(app: Hono<AppEnv>): void {
  app.get("/api/sync/status", (c) => guarded(c, (sync) => sync.status()));
  app.post("/api/sync/configure", async (c) => {
    const body = await objectBody(c);
    return guarded(c, (sync) => sync.configure(body));
  });
  app.post("/api/sync/test", async (c) => {
    const body = await objectBody(c);
    return guarded(c, (sync) => sync.test(body));
  });
  app.post("/api/sync/now", (c) => guarded(c, (sync) => sync.syncNow()));
  app.get("/api/sync/conflicts", (c) => guarded(c, (sync) => sync.conflicts()));
  app.post("/api/sync/conflicts/:id/resolve", async (c) => {
    const body = await objectBody(c);
    const id = Number(c.req.param("id"));
    return guarded(c, (sync) => sync.resolveConflict(id, body.keep as "mine" | "theirs", c.get("actor")));
  });

  app.post("/api/sync/export", async (c) => {
    const body = await objectBody(c);
    const sync = controller(c);
    if (!sync) return c.json({ detail: "这个运行环境没有开启同步", code: "unsupported" }, 501);
    try {
      const { bytes, filename, records } = await sync.exportBackup(typeof body.passphrase === "string" ? body.passphrase : "");
      return c.body(bytes as Uint8Array<ArrayBuffer>, 200, {
        "Content-Type": "application/vnd.offeru.backup",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "X-OfferU-Records": String(records),
        "Access-Control-Expose-Headers": "Content-Disposition, X-OfferU-Records",
      });
    } catch (error) {
      return syncErrorResponse(c, error);
    }
  });

  app.post("/api/sync/import", async (c) => {
    const length = Number(c.req.header("content-length") || 0);
    if (length > MAX_BACKUP_BYTES) return c.json({ detail: "备份文件超过 256 MB", code: "invalid" }, 413);
    const form = await c.req.formData().catch(() => null);
    const file = form?.get("file");
    if (!form || !file || typeof file === "string") return c.json({ detail: "请选择备份文件（.offeru）", code: "invalid" }, 400);
    const passphrase = String(form.get("passphrase") ?? "");
    const bytes = new Uint8Array(await file.arrayBuffer());
    return guarded(c, (sync) => sync.importBackup(bytes, passphrase));
  });
}
