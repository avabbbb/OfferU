// When the web build should suggest installing the OfferU browser extension.
//
// Model providers without browser CORS can only be reached through the shared Worker relay
// (/llm-proxy), which spends a daily request quota shared by every user. With the extension
// installed those calls go straight from the browser (extensionLlm.ts). So we suggest it —
// non-blocking, dismissible, with "不再提醒" — when, and the extension is not connected:
//   "configured" the active model config points at a host known to need the relay
//                (learned from an earlier CORS failure in this browser, or known gateways);
//   "relay"      a request is about to go through /llm-proxy;
//   "quota"      /llm-proxy answered with the Worker's own 429 (quota / rate limit). This one
//                shows even after a plain dismiss this session, but never after "不再提醒".
// The request itself always keeps working through the relay meanwhile.

/** Store listing once published (Chrome Web Store / Edge Add-ons). Empty until then. */
export const EXTENSION_STORE_URL = "";
/** Install-from-source instructions used while there is no store listing. */
export const EXTENSION_INSTALL_DOCS_URL = "https://github.com/avabbbb/OfferU/tree/main/extension#readme";

export function extensionInstallUrl(storeUrl: string = EXTENSION_STORE_URL): string {
  return storeUrl.trim() || EXTENSION_INSTALL_DOCS_URL;
}

export type ExtensionPromptTrigger = "configured" | "relay" | "quota";

/** Gateways known to send no CORS (OpenCode Zen answers the preflight with 404; see worker.ts). */
export const KNOWN_RELAY_HOSTS: readonly string[] = ["opencode.ai"];

const LEARNED_KEY = "offeru.llm.relayHosts.v1";
const NEVER_KEY = "offeru.extensionPrompt.never.v1";
const LOCAL_HOST = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\])$/i;

export interface PromptStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function safeStorage(): PromptStorage | null {
  try {
    return typeof localStorage !== "undefined" ? localStorage : null;
  } catch {
    return null;
  }
}

export function learnedRelayHosts(storage: PromptStorage | null = safeStorage()): string[] {
  try {
    const parsed = JSON.parse(storage?.getItem(LEARNED_KEY) || "[]");
    return Array.isArray(parsed) ? parsed.filter((h): h is string => typeof h === "string") : [];
  } catch {
    return [];
  }
}

export function rememberRelayHost(host: string, storage: PromptStorage | null = safeStorage()): void {
  if (!storage) return;
  const hosts = new Set(learnedRelayHosts(storage));
  if (hosts.has(host)) return;
  hosts.add(host);
  try { storage.setItem(LEARNED_KEY, JSON.stringify([...hosts].slice(-20))); } catch { /* quota / private mode */ }
}

/** True when model calls to this base URL go through /llm-proxy from the page. */
export function baseUrlNeedsRelay(baseUrl: string | undefined | null, learned: readonly string[]): boolean {
  if (!baseUrl) return false;
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || LOCAL_HOST.test(url.hostname)) return false;
  const host = url.hostname.toLowerCase();
  return learned.includes(url.host.toLowerCase()) || learned.includes(host) || KNOWN_RELAY_HOSTS.includes(host);
}

/**
 * The Worker relay's own throttling: Cloudflare answers an exhausted Workers quota / rate limit
 * with 429 and an HTML (or plain) error page. A provider's own 429 passes through the relay as
 * JSON and is not the relay's fault, so it does not count.
 */
export function isRelayQuotaResponse(response: Pick<Response, "status" | "headers">): boolean {
  if (response.status !== 429) return false;
  const type = (response.headers.get("content-type") || "").toLowerCase();
  return !type.includes("json") && !type.includes("event-stream");
}

export interface PromptState {
  localWeb: boolean;
  extensionConnected: boolean;
  neverRemind: boolean;
  dismissedThisSession: boolean;
}

export function shouldShowExtensionPrompt(state: PromptState, trigger: ExtensionPromptTrigger): boolean {
  if (!state.localWeb || state.extensionConnected || state.neverRemind) return false;
  if (trigger === "quota") return true;
  return !state.dismissedThisSession;
}

export interface ExtensionPromptView {
  visible: boolean;
  trigger: ExtensionPromptTrigger | null;
}

export interface ExtensionPromptStore {
  /** Something happened that the extension would avoid; shows the prompt if appropriate. */
  report(trigger: ExtensionPromptTrigger): void;
  dismiss(): void;
  neverRemind(): void;
  view(): ExtensionPromptView;
  subscribe(listener: () => void): () => void;
}

export function createExtensionPromptStore(options: {
  localWeb: boolean;
  /** Resolves true when the extension answered the handshake. */
  isExtensionConnected: () => Promise<boolean>;
  storage?: PromptStorage | null;
}): ExtensionPromptStore {
  const storage = options.storage === undefined ? safeStorage() : options.storage;
  let view: ExtensionPromptView = { visible: false, trigger: null };
  let dismissed = false;
  const listeners = new Set<() => void>();
  const set = (next: ExtensionPromptView) => {
    view = next;
    listeners.forEach((listener) => { try { listener(); } catch { /* ignore */ } });
  };
  const never = () => storage?.getItem(NEVER_KEY) === "1";

  return {
    report(trigger) {
      if (!options.localWeb || never() || (view.visible && view.trigger === "quota")) return;
      void options.isExtensionConnected().catch(() => false).then((connected) => {
        const state = { localWeb: options.localWeb, extensionConnected: connected, neverRemind: never(), dismissedThisSession: dismissed };
        if (shouldShowExtensionPrompt(state, trigger)) set({ visible: true, trigger });
        else if (connected && view.visible) set({ visible: false, trigger: null });
      });
    },
    dismiss() {
      dismissed = true;
      set({ visible: false, trigger: null });
    },
    neverRemind() {
      try { storage?.setItem(NEVER_KEY, "1"); } catch { /* private mode: session dismiss still applies */ }
      dismissed = true;
      set({ visible: false, trigger: null });
    },
    view: () => view,
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}
