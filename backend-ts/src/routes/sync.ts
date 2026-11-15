import type { Context, Hono } from "hono";

import type { AppEnv } from "../app";
import { jsonBody } from "../app";

/**
 * S3/R2 sync endpoints. The route only parses and maps errors; the engine is
 * @offeru/sync and the runtime-specific part (where config and state live) is
 * injected as AppDeps.sync, so this module stays Worker-safe.
 *
 *   GET  /api/sync/status      -> SyncStatusView
 *   POST /api/sync/configure   { endpoint, bucket, region, accessKeyId, secretAccessKey, prefix, pathStyle, passphrase } | { clear: true }
 *   POST /api/sync/now         -> { result, status }
 */
export type SyncConfigView = {
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
  syncing: boolean;
  device: string | null;
  last_sync_at: string | null;
  pending: number | null;
  last_result: unknown;
  last_error: { code: string; message: string; at: string } | null;
};

export interface SyncController {
  status(): Promise<SyncStatusView>;
  configure(input: Record<string, unknown>): Promise<SyncStatusView>;
  syncNow(): Promise<{ result: unknown; status: SyncStatusView }>;
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

function controller(c: Context<AppEnv>): SyncController | null {
  return (c.get("deps") as { sync?: SyncController }).sync ?? null;
}

async function guarded(c: Context<AppEnv>, run: (sync: SyncController) => Promise<unknown>) {
  const sync = controller(c);
  if (!sync) return c.json({ detail: "这个运行环境没有开启同步", code: "unsupported" }, 501);
  try {
    return c.json(await run(sync) as object);
  } catch (error) {
    const code = (error as { name?: string; code?: string }).name === "SyncError" ? (error as { code: string }).code : "";
    if (!code) throw error;
    return c.json({ detail: (error as Error).message, code: `sync_${code}` }, (STATUS_OF_SYNC[code] ?? 500) as 400);
  }
}

export function registerSync(app: Hono<AppEnv>): void {
  app.get("/api/sync/status", (c) => guarded(c, (sync) => sync.status()));
  app.post("/api/sync/configure", async (c) => {
    const body = await jsonBody(c);
    return guarded(c, (sync) => sync.configure(typeof body === "object" && body !== null ? body as Record<string, unknown> : {}));
  });
  app.post("/api/sync/now", (c) => guarded(c, (sync) => sync.syncNow()));
}
