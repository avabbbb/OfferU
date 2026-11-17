import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { RuntimeIdentity, RuntimeInfo } from "./routes/agent-extras";

const COMMIT = /^[0-9a-f]{40}$/;
const FINGERPRINT = /^sha256:[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RUNTIME_TYPES = new Set(["local", "desktop-sidecar", "lite"]);
const PACKAGE_VERSION = "0.2.0";

const text = (value: string | undefined): string | null => (value && value.trim() && value !== "unknown" ? value.trim() : null);

function knownDirty(value: string | undefined): boolean | null {
  const normalized = (value || "").trim().toLowerCase();
  if (normalized === "true" || normalized === "1") return true;
  if (normalized === "false" || normalized === "0") return false;
  return null;
}

/** The checkout this file lives in (source runs only); never the process cwd. */
function git(...args: string[]): string | null {
  try {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
    return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", timeout: 1500, stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

type BuildMetadata = { schema_version: number; version: string; commit: string; build_timestamp: string; dirty: boolean; source_fingerprint: string };

/** offeru-build-identity.json written by scripts/build_identity.mjs and shipped with the desktop package. */
function packagedMetadata(path: string, appVersion: string): BuildMetadata | null {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as BuildMetadata;
    const stamp = typeof value.build_timestamp === "string" ? new Date(value.build_timestamp) : null;
    const utc = typeof value.build_timestamp === "string" && /(?:Z|\+00:00)$/.test(value.build_timestamp) && stamp && !Number.isNaN(stamp.getTime());
    if (value.schema_version === 1 && value.version === appVersion && COMMIT.test(value.commit) && utc
      && typeof value.dirty === "boolean" && FINGERPRINT.test(value.source_fingerprint)) return value;
  } catch {
    // unreadable or invalid: identity stays unknown, like Python
  }
  return null;
}

/**
 * Port of Python services/runtime_identity.py for the Node companion. Packaged builds read
 * OFFERU_BUILD_IDENTITY_PATH (the desktop shell points it at the bundled metadata); source runs
 * take the commit the shell passed (OFFERU_BUILD_COMMIT / _DIRTY) or ask git.
 */
export function nodeRuntimeInfo(env: NodeJS.ProcessEnv = process.env, workbenchToken: () => string | null = () => env.OFFERU_APPROVAL_TOKEN || null): RuntimeInfo {
  const appVersion = text(env.OFFERU_VERSION) ?? PACKAGE_VERSION;
  const runtimeMode = text(env.OFFERU_RUNTIME_MODE) ?? "local";
  const buildMode = text(env.OFFERU_BUILD_MODE) ?? "local-development";
  const pairCodes = new Map<string, number>();
  let identityCache: RuntimeIdentity | null = null;
  const identity = (): RuntimeIdentity => {
    if (identityCache) return identityCache;
    const instance = text(env.OFFERU_RUNTIME_INSTANCE_ID);
    const runtime_instance_id = instance && UUID.test(instance) ? instance.toLowerCase() : null;
    const runtime_type = RUNTIME_TYPES.has(runtimeMode) ? runtimeMode : "unknown";
    const dataDir = text(env.OFFERU_DATA_DIR);
    const data_root = dataDir ? resolve(dataDir) : null;
    if (env.OFFERU_BUILD_IDENTITY_PATH) {
      const meta = packagedMetadata(env.OFFERU_BUILD_IDENTITY_PATH, appVersion);
      identityCache = meta
        ? { runtime_instance_id, version: meta.version, commit: meta.commit, build_timestamp: meta.build_timestamp, dirty: meta.dirty, source_fingerprint: meta.source_fingerprint, data_root, runtime_type, build_source: "package" }
        : { runtime_instance_id, version: null, commit: null, build_timestamp: null, dirty: null, source_fingerprint: null, data_root, runtime_type, build_source: "unknown" };
      return identityCache;
    }
    let commit: string | null;
    let dirty: boolean | null;
    if (runtime_instance_id && "OFFERU_BUILD_COMMIT" in env) {
      const value = (env.OFFERU_BUILD_COMMIT || "").trim().toLowerCase();
      commit = COMMIT.test(value) ? value : null;
    } else {
      const value = (git("rev-parse", "HEAD") || "").toLowerCase();
      commit = COMMIT.test(value) ? value : null;
    }
    if (runtime_instance_id && "OFFERU_BUILD_DIRTY" in env) dirty = knownDirty(env.OFFERU_BUILD_DIRTY);
    else {
      const status = git("status", "--porcelain", "--untracked-files=normal");
      dirty = status === null ? null : status !== "";
    }
    identityCache = { runtime_instance_id, version: appVersion, commit, build_timestamp: null, dirty, source_fingerprint: null, data_root, runtime_type, build_source: "source" };
    return identityCache;
  };
  return {
    appVersion,
    buildMode,
    runtimeMode,
    identity,
    exchangePairCode(code: string) {
      const expires = pairCodes.get(code);
      pairCodes.delete(code);
      if (!expires || expires < Date.now()) return null;
      return workbenchToken();
    },
    mintPairCode(ttlMs = 10 * 60_000): string {
      const code = randomBytes(12).toString("base64url");
      pairCodes.set(code, Date.now() + ttlMs);
      return code;
    },
  };
}
