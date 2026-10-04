import { invoke, isTauri } from "@tauri-apps/api/core";
import { resolveApiBase } from "@/lib/apiBase";

export type DesktopRuntimeIdentity = {
  runtime_instance_id: string | null;
  version: string | null;
  commit: string | null;
  build_timestamp: string | null;
  dirty: boolean | null;
  source_fingerprint: string | null;
  data_root: string | null;
  runtime_type: string | null;
};

export type RuntimeIdentity = DesktopRuntimeIdentity & {
  build_source: "package" | "source" | "unknown";
};

type HealthPayload = {
  status?: unknown;
  service?: unknown;
  runtime?: unknown;
  build_mode?: unknown;
  runtime_mode?: unknown;
  version?: unknown;
  runtime_instance_id?: unknown;
  build_identity?: unknown;
};

const API_BASE = resolveApiBase();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const COMMIT = /^[0-9a-f]{40}$/;
const FINGERPRINT = /^sha256:[0-9a-f]{64}$/;

export type DesktopBackendStatus = {
  state: "starting" | "ready" | "failed";
  reason: string | null;
  pid: number | null;
  exit_code: number | null;
};

export async function getDesktopBackendStatus(timeoutMs = 1_000): Promise<DesktopBackendStatus | null> {
  if (!isTauri()) return null;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const result = await Promise.race([
    invoke<unknown>("get_desktop_backend_status").catch(() => null),
    new Promise<null>((resolve) => { timeout = setTimeout(() => resolve(null), timeoutMs); }),
  ]).finally(() => clearTimeout(timeout));
  if (!result || typeof result !== "object") return null;
  const value = result as Record<string, unknown>;
  if (value.state !== "starting" && value.state !== "ready" && value.state !== "failed") return null;
  return {
    state: value.state,
    reason: typeof value.reason === "string" ? value.reason : null,
    pid: typeof value.pid === "number" && Number.isInteger(value.pid) ? value.pid : null,
    exit_code: typeof value.exit_code === "number" && Number.isInteger(value.exit_code) ? value.exit_code : null,
  };
}

function nullableText(value: unknown): string | null {
  return typeof value === "string" && value.trim() && value !== "unknown" ? value : null;
}

function nullableBool(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function identityFields(value: unknown): DesktopRuntimeIdentity | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Record<string, unknown>;
  return {
    runtime_instance_id: nullableText(item.runtime_instance_id),
    version: nullableText(item.version),
    commit: nullableText(item.commit),
    build_timestamp: nullableText(item.build_timestamp),
    dirty: nullableBool(item.dirty),
    source_fingerprint: nullableText(item.source_fingerprint),
    data_root: nullableText(item.data_root),
    runtime_type: nullableText(item.runtime_type),
  };
}

export async function getDesktopRuntimeIdentity(timeoutMs = 1_000): Promise<DesktopRuntimeIdentity | null> {
  if (!isTauri()) return null;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    invoke<unknown>("get_desktop_runtime_identity").then(identityFields, () => null),
    new Promise<null>((resolve) => {
      timeout = setTimeout(() => resolve(null), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timeout));
}

export async function getRuntimeIdentity(): Promise<RuntimeIdentity> {
  const response = await fetch(`${API_BASE}/api/diagnostics/runtime-identity`, {
    cache: "no-store",
    redirect: "error",
    headers: { Accept: "application/json" },
  });
  if (!response.ok) throw new Error("OfferU runtime identity is unavailable.");
  const payload = await response.json();
  const fields = identityFields(payload);
  if (!fields) throw new Error("OfferU runtime identity response is invalid.");
  const rawSource = (payload as Record<string, unknown>).build_source;
  const build_source = rawSource === "package" || rawSource === "source" ? rawSource : "unknown";
  return { ...fields, build_source };
}

function normalizePath(value: string | null): string | null {
  return value?.replaceAll("\\", "/").replace(/\/+$/, "").toLocaleLowerCase() || null;
}

export function matchesDesktopRuntimeIdentity(
  expected: DesktopRuntimeIdentity | null,
  payload: unknown,
  mode: "release" | "source",
): boolean {
  if (!expected?.runtime_instance_id || !UUID.test(expected.runtime_instance_id)) return false;
  if (!payload || typeof payload !== "object") return false;
  const health = payload as HealthPayload;
  if (
    health.status !== "ok" ||
    health.service !== "OfferU" ||
    health.runtime !== "python" ||
    health.runtime_instance_id !== expected.runtime_instance_id ||
    health.version !== expected.version ||
    health.runtime_mode !== expected.runtime_type
  ) return false;

  const actual = identityFields(health.build_identity);
  if (!actual) return false;
  const rawBuildSource = (health.build_identity as Record<string, unknown>).build_source;
  if (
    !expected.version ||
    actual.version !== expected.version ||
    !expected.data_root ||
    normalizePath(actual.data_root) !== normalizePath(expected.data_root) ||
    !expected.runtime_type ||
    actual.runtime_type !== expected.runtime_type
  ) return false;

  if (mode === "release") {
    return health.build_mode === "release" &&
      rawBuildSource === "package" &&
      !!expected.commit && COMMIT.test(expected.commit) && actual.commit === expected.commit &&
      !!expected.build_timestamp && actual.build_timestamp === expected.build_timestamp &&
      typeof expected.dirty === "boolean" && actual.dirty === expected.dirty &&
      !!expected.source_fingerprint && FINGERPRINT.test(expected.source_fingerprint) &&
      actual.source_fingerprint === expected.source_fingerprint;
  }

  return health.build_mode === "local-development" &&
    rawBuildSource === "source" &&
    expected.build_timestamp === null && actual.build_timestamp === null &&
    expected.source_fingerprint === null && actual.source_fingerprint === null &&
    (expected.commit ? actual.commit === expected.commit : actual.commit === null) &&
    (expected.dirty === null || actual.dirty === expected.dirty);
}

export function isDesktopRuntime(): boolean {
  return isTauri();
}
