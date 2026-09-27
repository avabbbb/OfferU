import { useCallback, useEffect, useSyncExternalStore } from "react";
import { SHOWCASE } from "./showcase/router";
import { resolveApiBase } from "./apiBase";

export type LocalRuntimeStatus = "connected" | "disconnected";

const STORAGE_KEY = "offeru_web_local_runtime";
const API_BASE = resolveApiBase();

let status: LocalRuntimeStatus = SHOWCASE ? "disconnected" : "connected";
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

function setStatus(next: LocalRuntimeStatus) {
  if (status === next) return;
  status = next;
  emit();
}

function remembered(): boolean {
  if (!SHOWCASE || typeof localStorage === "undefined") return false;
  return localStorage.getItem(STORAGE_KEY) === "connected";
}

function remember(next: LocalRuntimeStatus) {
  if (!SHOWCASE || typeof localStorage === "undefined") return;
  if (next === "connected") localStorage.setItem(STORAGE_KEY, "connected");
  else localStorage.removeItem(STORAGE_KEY);
}

export function isLocalRuntimeConnected(): boolean {
  return !SHOWCASE || status === "connected";
}

export async function connectLocalRuntime(timeoutMs = 2500): Promise<boolean> {
  if (!SHOWCASE) {
    setStatus("connected");
    return true;
  }

  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const init = {
      method: "GET",
      mode: "cors",
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
      signal: controller.signal,
      targetAddressSpace: "loopback",
    } as RequestInit & { targetAddressSpace: "loopback" };

    const response = await fetch(new Request(`${API_BASE}/api/health`, init));
    const payload = response.ok ? await response.json().catch(() => ({})) : {};
    const ok = response.ok && payload?.status === "ok";
    setStatus(ok ? "connected" : "disconnected");
    remember(ok ? "connected" : "disconnected");
    return ok;
  } catch {
    setStatus("disconnected");
    remember("disconnected");
    return false;
  } finally {
    window.clearTimeout(timer);
  }
}

export function disconnectLocalRuntime() {
  if (!SHOWCASE) return;
  remember("disconnected");
  setStatus("disconnected");
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function snapshot() {
  return status;
}

export function useLocalRuntime() {
  const current = useSyncExternalStore(subscribe, snapshot, snapshot);
  const connect = useCallback(() => connectLocalRuntime(), []);
  const disconnect = useCallback(() => disconnectLocalRuntime(), []);

  useEffect(() => {
    if (SHOWCASE && current === "disconnected" && remembered()) {
      void connectLocalRuntime();
    }
  }, [current]);

  return {
    status: current,
    connected: !SHOWCASE || current === "connected",
    connect,
    disconnect,
    apiBase: API_BASE,
  };
}
