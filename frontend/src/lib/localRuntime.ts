import { resolveApiBase } from "./apiBase";
import { SHOWCASE } from "./showcase/router";

const LOCAL_RUNTIME_KEY = "offeru.web.runtime";
const LOCAL_RUNTIME_VALUE = "local";
const LOCAL_RUNTIME_TIMEOUT_MS = 1600;

export interface LocalRuntimeProbe {
  ok: boolean;
  status?: string;
  service?: string;
  runtime?: string;
  version?: string;
  build_mode?: string;
  error?: string;
}

export function isLocalRuntimeSelected(): boolean {
  if (!SHOWCASE) return true;
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(LOCAL_RUNTIME_KEY) === LOCAL_RUNTIME_VALUE;
  } catch {
    return false;
  }
}

export function isDemoRuntime(): boolean {
  return SHOWCASE && !isLocalRuntimeSelected();
}

export async function probeLocalRuntime(): Promise<LocalRuntimeProbe> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), LOCAL_RUNTIME_TIMEOUT_MS);
  try {
    const response = await fetch(`${resolveApiBase()}/api/health`, {
      cache: "no-store",
      redirect: "error",
      signal: controller.signal,
    });
    if (!response.ok) {
      return { ok: false, error: `HTTP ${response.status}` };
    }
    const payload = await response.json().catch(() => ({}));
    const ok = (
      payload?.status === "ok"
      && payload?.service === "OfferU"
      && payload?.runtime === "python"
    );
    return {
      ok,
      status: String(payload?.status || ""),
      service: String(payload?.service || ""),
      runtime: String(payload?.runtime || ""),
      version: String(payload?.version || ""),
      build_mode: String(payload?.build_mode || ""),
      error: ok ? "" : "检测到的本地服务不是 OfferU Runtime。",
    };
  } catch (cause) {
    return {
      ok: false,
      error: cause instanceof Error && cause.name === "AbortError"
        ? "连接本地 OfferU 超时。"
        : "未检测到本地 OfferU Runtime。",
    };
  } finally {
    window.clearTimeout(timeout);
  }
}

export async function selectLocalRuntime(): Promise<LocalRuntimeProbe> {
  const probe = await probeLocalRuntime();
  if (!probe.ok) return probe;
  try {
    window.localStorage.setItem(LOCAL_RUNTIME_KEY, LOCAL_RUNTIME_VALUE);
  } catch {
    return { ...probe, ok: false, error: "浏览器无法保存本地连接状态。" };
  }
  return probe;
}

export function selectDemoRuntime(): void {
  if (!SHOWCASE || typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(LOCAL_RUNTIME_KEY);
  } catch {
    // Demo remains the safe fallback if storage is unavailable.
  }
}
