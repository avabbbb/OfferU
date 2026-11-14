import type { Context, Hono } from "hono";
import { CoreError, type SyncConfigInput, type SyncService } from "@offeru/core";

import { jsonBody, type AppEnv } from "../app";

/**
 * S3 data sync (new in the TS backend; Python has no equivalent).
 *   GET    /api/sync/config   masked config (no secret, no passphrase)
 *   PUT    /api/sync/config   save (POST accepted too); empty secret/passphrase = keep saved
 *   DELETE /api/sync/config   forget credentials on this device
 *   GET    /api/sync/status
 *   POST   /api/sync/run      {"gc"?: boolean}
 * Runs only where the data lives (companion, or the in-browser app). The
 * stateless Worker has no deps.sync and answers 501, so credentials never reach it.
 */
function service(sync: SyncService | null | undefined): SyncService {
  if (!sync) throw new CoreError("这里不做数据同步：网页版在浏览器里直接同步，本机版在伴侣程序里同步", "unsupported");
  return sync;
}

function asInput(body: unknown): SyncConfigInput {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new CoreError("请求体要是 JSON 对象");
  const out: SyncConfigInput = {};
  const source = body as Record<string, unknown>;
  for (const key of ["endpoint", "region", "bucket", "prefix", "access_key_id", "secret_access_key", "session_token", "passphrase", "device_name"] as const) {
    if (source[key] === undefined || source[key] === null) continue;
    if (typeof source[key] !== "string") throw new CoreError(`${key} 要是字符串`);
    out[key] = source[key] as string;
  }
  for (const key of ["force_path_style", "sync_on_start"] as const) {
    if (source[key] === undefined || source[key] === null) continue;
    if (typeof source[key] !== "boolean") throw new CoreError(`${key} 要是 true/false`);
    out[key] = source[key] as boolean;
  }
  if (source.auto_minutes !== undefined && source.auto_minutes !== null) {
    if (typeof source.auto_minutes !== "number") throw new CoreError("auto_minutes 要是数字");
    out.auto_minutes = source.auto_minutes;
  }
  return out;
}

export function registerSync(app: Hono<AppEnv>): void {
  app.get("/api/sync/config", async (c) => c.json(await service(c.get("deps").sync).getConfig()));

  const save = async (c: Context<AppEnv>) =>
    c.json(await service(c.get("deps").sync).saveConfig(asInput(await jsonBody(c))));
  app.put("/api/sync/config", save);
  app.post("/api/sync/config", save);

  app.delete("/api/sync/config", async (c) => {
    await service(c.get("deps").sync).clearConfig();
    return c.json({ ok: true });
  });

  app.get("/api/sync/status", async (c) => c.json(await service(c.get("deps").sync).status()));

  app.post("/api/sync/run", async (c) => {
    const body = await jsonBody(c) as { gc?: unknown };
    return c.json(await service(c.get("deps").sync).run({ gc: body?.gc === true }));
  });
}
