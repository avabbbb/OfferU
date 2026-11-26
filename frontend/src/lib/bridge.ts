// Optional local bridge for the hosted web build (offeru.avabbbb.com) and static showcase.
// When paired, every same-origin /api/* call is forwarded to the user's loopback OfferU
// companion (127.0.0.1:8766) with X-OfferU-Pairing, so CLI / external Agents and the web UI
// share the exact same local offeru.db in real time — no server storage and no S3/R2 needed.

export const LOCAL_BRIDGE_BASE = "http://127.0.0.1:8766";

const BRIDGE_TOKEN_KEY = "offeru.local_bridge_token";
const BRIDGE_AUTH_KEY = "offeru.local_bridge_auth";

export type BridgeState = {
  active: boolean;
  checking: boolean;
  version: string;
  error: string;
};

let token = "";
let authToken = "";
let state: BridgeState = { active: false, checking: false, version: "", error: "" };
const listeners = new Set<() => void>();

function storage(): Storage | null {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
}

function saveTokens(pairing: string, auth: string): void {
  const store = storage();
  if (!store) return;
  try {
    store.setItem(BRIDGE_TOKEN_KEY, pairing);
    if (auth) store.setItem(BRIDGE_AUTH_KEY, auth);
    else store.removeItem(BRIDGE_AUTH_KEY);
  } catch {
    // ignore quota / private mode restrictions
  }
}

function clearSavedTokens(): void {
  const store = storage();
  if (!store) return;
  try {
    store.removeItem(BRIDGE_TOKEN_KEY);
    store.removeItem(BRIDGE_AUTH_KEY);
  } catch {
    // ignore
  }
}

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

export function bridgeAuthToken(): string {
  return state.active ? (authToken || token) : "";
}

export function hasSavedBridgeToken(): boolean {
  return Boolean(storage()?.getItem(BRIDGE_TOKEN_KEY));
}

export function parseBridgeInput(raw: string): { kind: "code" | "token"; value: string } {
  const trimmed = raw.trim();
  const urlMatch = trimmed.match(/#\/pair\/([A-Za-z0-9_-]+)/);
  if (urlMatch) return { kind: "code", value: urlMatch[1] };
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed) as { pairing_token?: unknown; token?: unknown };
      const extracted = typeof parsed.pairing_token === "string"
        ? parsed.pairing_token.trim()
        : typeof parsed.token === "string"
          ? parsed.token.trim()
          : "";
      if (extracted) return { kind: "token", value: extracted };
    } catch {
      // fall through to raw token handling
    }
  }
  if (/^[A-Za-z0-9_-]{12,23}$/.test(trimmed)) return { kind: "code", value: trimmed };
  return { kind: "token", value: trimmed };
}

export async function probeLocalBridge(timeoutMs = 1800): Promise<{ available: boolean; version?: string }> {
  publish({ checking: true, error: "" });
  const controller = new AbortController();
  const timeout = globalThis.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${LOCAL_BRIDGE_BASE}/api/health`, {
      cache: "no-store",
      redirect: "error",
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || payload?.service !== "OfferU" || (payload?.runtime !== "python" && payload?.runtime !== "node")) {
      publish({ checking: false, error: "本机 8766 有响应，但不是 OfferU 后端。" });
      return { available: false };
    }
    const version = String(payload.version || "");
    publish({ checking: false, version });
    return { available: true, version };
  } catch {
    publish({ checking: false, error: "没有发现本机 OfferU。请先运行 offeru start --web（127.0.0.1:8766）。" });
    return { available: false };
  } finally {
    globalThis.clearTimeout(timeout);
  }
}

export async function connectLocalBridge(
  pairingToken: string,
  options: { authToken?: string; persist?: boolean } = {},
): Promise<void> {
  const next = pairingToken.trim();
  if (!next) throw new Error("请粘贴本机 OfferU 的配对链接或配对 token。");
  const nextAuth = (options.authToken ?? next).trim();
  publish({ checking: true, error: "" });
  try {
    const response = await fetch(`${LOCAL_BRIDGE_BASE}/api/tools/overview`, {
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
    authToken = nextAuth;
    if (options.persist !== false) saveTokens(next, nextAuth);
    publish({ active: true, checking: false, error: "" });
    if (!state.version) void probeVersionQuietly();
  } catch (cause) {
    token = "";
    authToken = "";
    const message = cause instanceof Error ? cause.message : "连接本机失败";
    publish({ active: false, checking: false, error: message });
    throw new Error(message);
  }
}

export async function pairLocalBridgeWithCode(code: string): Promise<void> {
  const clean = code.trim();
  if (!clean) throw new Error("配对码不能为空。");
  publish({ checking: true, error: "" });
  try {
    const response = await fetch(`${LOCAL_BRIDGE_BASE}/api/ui/pair`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: clean }),
      redirect: "error",
    });
    const payload = await response.json().catch(() => ({})) as { token?: string; pairing_token?: string; detail?: string };
    if (!response.ok) {
      throw new Error(String(payload.detail || "配对码无效或已过期，请重新运行 offeru start --web"));
    }
    const pairing = String(payload.pairing_token || payload.token || "").trim();
    const auth = String(payload.token || pairing).trim();
    if (!pairing) throw new Error("本机后端没有返回配对 token。");
    await connectLocalBridge(pairing, { authToken: auth, persist: true });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : "配对失败，请确认本机已运行 offeru start --web";
    publish({ active: false, checking: false, error: message });
    throw new Error(message);
  }
}

export async function connectLocalBridgeInput(raw: string): Promise<void> {
  const parsed = parseBridgeInput(raw);
  if (!parsed.value) throw new Error("请粘贴本机 OfferU 的配对链接、配对码或配对 token。");
  if (parsed.kind === "code") return pairLocalBridgeWithCode(parsed.value);
  return connectLocalBridge(parsed.value, { persist: true });
}

export async function restoreLocalBridge(timeoutMs = 1200): Promise<boolean> {
  const store = storage();
  const saved = store?.getItem(BRIDGE_TOKEN_KEY)?.trim() || "";
  if (!saved) return false;
  const savedAuth = store?.getItem(BRIDGE_AUTH_KEY)?.trim() || saved;
  const controller = new AbortController();
  const timeout = globalThis.setTimeout(() => controller.abort(), timeoutMs);
  publish({ checking: true, error: "" });
  try {
    const response = await fetch(`${LOCAL_BRIDGE_BASE}/api/tools/overview`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-OfferU-Pairing": saved,
      },
      body: "{}",
      redirect: "error",
      signal: controller.signal,
    });
    if (response.status === 403) {
      clearSavedTokens();
      token = "";
      authToken = "";
      publish({ active: false, checking: false, error: "本机配对 token 已变化，请重新连接。" });
      return false;
    }
    if (!response.ok) {
      publish({ active: false, checking: false });
      return false;
    }
    token = saved;
    authToken = savedAuth;
    publish({ active: true, checking: false, error: "" });
    void probeVersionQuietly();
    return true;
  } catch {
    publish({ active: false, checking: false });
    return false;
  } finally {
    globalThis.clearTimeout(timeout);
  }
}

async function probeVersionQuietly(): Promise<void> {
  try {
    const response = await fetch(`${LOCAL_BRIDGE_BASE}/api/health`, { cache: "no-store", redirect: "error" });
    const payload = await response.json().catch(() => null);
    if (response.ok && payload?.version) publish({ version: String(payload.version) });
  } catch {
    // ignore background version lookup failure
  }
}

export function disconnectLocalBridge(): void {
  token = "";
  authToken = "";
  clearSavedTokens();
  publish({ active: false, checking: false, error: "" });
}
