import { useEffect, useSyncExternalStore } from "react";
import { resolveApiBase } from "./apiBase";
import { SHOWCASE } from "./showcase/router";

const LOCAL_RUNTIME_KEY = "offeru.web.runtime";
const LOCAL_RUNTIME_VALUE = "local";
const LOCAL_RUNTIME_TIMEOUT_MS = 1600;
const EXPECTED_RUNTIME_VERSION = import.meta.env.VITE_APP_VERSION || "";

export interface LocalRuntimeProbe {
  ok: boolean;
  status?: string;
  service?: string;
  runtime?: string;
  version?: string;
  build_mode?: string;
  error?: string;
}

export interface LocalRuntimeState {
  /** A remembered connection choice, not proof that the runtime is reachable. */
  selected: boolean;
  /** True only after the current page session has verified the OfferU runtime. */
  connected: boolean;
  probing: boolean;
  error: string;
}

function hasRememberedConnection(): boolean {
  if (!SHOWCASE || typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(LOCAL_RUNTIME_KEY) === LOCAL_RUNTIME_VALUE;
  } catch {
    return false;
  }
}

const serverSnapshot: LocalRuntimeState = {
  selected: false,
  connected: !SHOWCASE,
  probing: false,
  error: "",
};

let runtimeSnapshot: LocalRuntimeState = {
  ...serverSnapshot,
  selected: SHOWCASE ? hasRememberedConnection() : true,
};

const listeners = new Set<() => void>();
let probeGeneration = 0;

export function subscribeLocalRuntime(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getLocalRuntimeSnapshot(): LocalRuntimeState {
  return runtimeSnapshot;
}

function getServerRuntimeSnapshot(): LocalRuntimeState {
  return serverSnapshot;
}

function publishRuntimeState(next: LocalRuntimeState): void {
  runtimeSnapshot = next;
  listeners.forEach((listener) => listener());
}

function clearRememberedConnection(): void {
  if (!SHOWCASE || typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(LOCAL_RUNTIME_KEY);
  } catch {
    // A failed storage cleanup never upgrades the in-memory state to connected.
  }
}

export function isLocalRuntimeSelected(): boolean {
  return runtimeSnapshot.selected;
}

export function isDemoRuntime(): boolean {
  return SHOWCASE && !runtimeSnapshot.connected;
}

export async function probeLocalRuntime(): Promise<LocalRuntimeProbe> {
  if (typeof window === "undefined") {
    return { ok: false, error: "只能在浏览器中检查本地 OfferU Runtime。" };
  }

  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), LOCAL_RUNTIME_TIMEOUT_MS);
  try {
    // Chromium implements targetAddressSpace for Private Network Access. Keep
    // it optional in the local type so this remains compatible with DOM lib
    // versions that have not added the field to RequestInit yet.
    const requestInit: RequestInit & { targetAddressSpace?: "loopback" } = {
      mode: "cors",
      credentials: "omit",
      cache: "no-store",
      redirect: "error",
      signal: controller.signal,
      targetAddressSpace: "loopback",
    };
    const response = await fetch(`${resolveApiBase()}/api/health`, requestInit);
    if (!response.ok) {
      return { ok: false, error: `HTTP ${response.status}` };
    }
    const payload = await response.json().catch(() => ({}));
    const identityMatches = (
      payload?.status === "ok"
      && payload?.service === "OfferU"
      && payload?.runtime === "python"
    );
    const versionMatches = !EXPECTED_RUNTIME_VERSION || payload?.version === EXPECTED_RUNTIME_VERSION;
    const ok = identityMatches && versionMatches;
    return {
      ok,
      status: String(payload?.status || ""),
      service: String(payload?.service || ""),
      runtime: String(payload?.runtime || ""),
      version: String(payload?.version || ""),
      build_mode: String(payload?.build_mode || ""),
      error: ok ? "" : !identityMatches
        ? "检测到的本地服务不是 OfferU Runtime。"
        : `本地 OfferU 版本不匹配（预期 ${EXPECTED_RUNTIME_VERSION}，实际 ${String(payload?.version || "未知")}）。`,
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
  const generation = ++probeGeneration;
  publishRuntimeState({
    ...runtimeSnapshot,
    connected: false,
    probing: true,
    error: "",
  });

  const probe = await probeLocalRuntime();
  if (generation !== probeGeneration) {
    return { ...probe, ok: false, error: "本地连接检查已取消。" };
  }
  if (!probe.ok) {
    clearRememberedConnection();
    publishRuntimeState({ selected: false, connected: !SHOWCASE, probing: false, error: probe.error || "连接检查失败。" });
    return probe;
  }

  if (SHOWCASE) {
    try {
      window.localStorage.setItem(LOCAL_RUNTIME_KEY, LOCAL_RUNTIME_VALUE);
    } catch {
      clearRememberedConnection();
      const error = "浏览器无法保存本地连接状态。";
      publishRuntimeState({ selected: false, connected: false, probing: false, error });
      return { ...probe, ok: false, error };
    }
  }

  publishRuntimeState({ selected: true, connected: true, probing: false, error: "" });
  return probe;
}

export function selectDemoRuntime(): void {
  if (!SHOWCASE || typeof window === "undefined") return;
  probeGeneration += 1;
  clearRememberedConnection();
  publishRuntimeState({ selected: false, connected: false, probing: false, error: "" });
}

/**
 * Subscribe UI to runtime connection changes. A remembered choice is only an
 * intent: on mount it is rechecked and discarded if the local service is gone
 * or does not identify itself as the OfferU Python runtime.
 */
export function useLocalRuntime() {
  const state = useSyncExternalStore(
    subscribeLocalRuntime,
    getLocalRuntimeSnapshot,
    getServerRuntimeSnapshot,
  );

  useEffect(() => {
    if (SHOWCASE && !state.connected && !state.probing && hasRememberedConnection()) {
      void selectLocalRuntime();
    }
  }, [state.connected, state.probing, state.selected]);

  return {
    ...state,
    connect: selectLocalRuntime,
    disconnect: selectDemoRuntime,
    recheck: selectLocalRuntime,
  };
}
