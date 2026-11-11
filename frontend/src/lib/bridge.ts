// Optional local bridge for the static showcase. The page never hosts MCP;
// it only talks to a loopback OfferU backend the user explicitly pairs with.
// The pairing token stays in memory for this tab.

import { resolveApiBase } from "./apiBase";

export const LOCAL_BRIDGE_BASE = "http://127.0.0.1:8766";

export type BridgeState = {
  active: boolean;
  checking: boolean;
  version: string;
  mcpEnabled: boolean;
  error: string;
};

let token = "";
let state: BridgeState = { active: false, checking: false, version: "", mcpEnabled: false, error: "" };
const listeners = new Set<() => void>();

function publish(next: Partial<BridgeState>): void {
  state = { ...state, ...next };
  for (const listener of listeners) listener();
}

export function subscribeBridge(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getBridgeState(): BridgeState {
  return state;
}

export function bridgeActive(): boolean {
  return state.active;
}

export function bridgeHeaders(): Record<string, string> {
  return state.active && token ? { "X-OfferU-Pairing": token } : {};
}

export async function probeLocalBridge(): Promise<{ available: boolean; version?: string; mcpEnabled?: boolean }> {
  publish({ checking: true, error: "" });
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 1800);
  try {
    const response = await fetch(`${LOCAL_BRIDGE_BASE}/api/health`, {
      cache: "no-store",
      redirect: "error",
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || payload?.service !== "OfferU" || payload?.runtime !== "python") {
      publish({ checking: false, error: "本机 8766 有响应，但不是 OfferU 后端。" });
      return { available: false };
    }
    publish({ checking: false, version: String(payload.version || ""), mcpEnabled: Boolean(payload.mcp_enabled) });
    return { available: true, version: String(payload.version || ""), mcpEnabled: Boolean(payload.mcp_enabled) };
  } catch {
    publish({ checking: false, error: "没有发现本机 OfferU。请先运行 offeru start（127.0.0.1:8766）。" });
    return { available: false };
  } finally {
    window.clearTimeout(timeout);
  }
}

export async function connectLocalBridge(pairingToken: string): Promise<void> {
  const next = pairingToken.trim();
  if (!next) throw new Error("请粘贴本机 OfferU 的配对 token。");
  publish({ checking: true, error: "" });
  try {
    const response = await fetch(`${resolveApiBase()}/api/tools/overview`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-OfferU-Pairing": next,
      },
      body: "{}",
      redirect: "error",
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw new Error(String(payload.detail || `本机后端拒绝了连接（HTTP ${response.status}）`));
    }
    token = next;
    publish({ active: true, checking: false, error: "" });
  } catch (cause) {
    token = "";
    const message = cause instanceof Error ? cause.message : "连接本机失败";
    publish({ active: false, checking: false, error: message });
    throw new Error(message);
  }
}

export function disconnectLocalBridge(): void {
  token = "";
  publish({ active: false, checking: false, error: "" });
}
