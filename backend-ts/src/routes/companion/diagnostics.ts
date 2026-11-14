import { dirname, resolve } from "node:path";

import type { Hono } from "hono";
import { getConnInfo } from "@hono/node-server/conninfo";
import { CoreError } from "@offeru/core";

import type { AppEnv } from "../../app";
import { dbPath } from "../../paths";

const COMMIT = /^[0-9a-f]{40}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RUNTIME_TYPES = new Set(["local", "desktop-sidecar", "lite"]);

function isLoopback(address: string | undefined): boolean {
  if (!address) return false;
  const ip = address.replace(/^::ffff:/, "");
  return ip === "::1" || /^127\./.test(ip);
}

/** Python services/runtime_identity.get_runtime_identity (source run): only nonsecret fields. */
export function runtimeIdentity(env: NodeJS.ProcessEnv = process.env, version = "0.1.0"): Record<string, unknown> {
  const instance = String(env.OFFERU_RUNTIME_INSTANCE_ID || "").trim();
  const commit = String(env.OFFERU_BUILD_COMMIT || "").trim().toLowerCase();
  const dirty = String(env.OFFERU_BUILD_DIRTY ?? "").trim().toLowerCase();
  const type = String(env.OFFERU_RUNTIME_MODE || env.OFFERU_INTERVIEW_RUNTIME || "local").trim();
  return {
    runtime_instance_id: UUID.test(instance) ? instance.toLowerCase() : null,
    version,
    commit: COMMIT.test(commit) ? commit : null,
    build_timestamp: null,
    dirty: dirty === "true" || dirty === "1" ? true : dirty === "false" || dirty === "0" ? false : null,
    source_fingerprint: null,
    data_root: resolve(env.OFFERU_DATA_DIR || dirname(dbPath())),
    runtime_type: RUNTIME_TYPES.has(type) ? type : "unknown",
    build_source: "source",
  };
}

/** GET /api/diagnostics/runtime-identity — loopback callers only, like Python. */
export function registerDiagnosticsCompanion(app: Hono<AppEnv>): void {
  app.get("/api/diagnostics/runtime-identity", (c) => {
    let address: string | undefined;
    try {
      address = getConnInfo(c).remote.address;
    } catch {
      address = undefined;
    }
    if (!isLoopback(address)) throw new CoreError("本地诊断信息仅供本机查看", "forbidden");
    return c.json(runtimeIdentity());
  });
}
