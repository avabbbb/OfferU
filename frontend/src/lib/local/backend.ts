// The web build's backend, running inside the page.
//
// In local-web mode (VITE_OFFERU_MODE=local-web, the Cloudflare Worker deploy) there is no
// server holding user data. installLocalBackend() wraps window.fetch so every same-origin
// /api/* request is answered by backend-ts's runtime-agnostic Hono app (createApp), wired
// to browser adapters:
//   store        BrowserDemoStore over IndexedDB "offeru-local" (starts empty)
//   files        IndexedDB file stores (uploads, Agent attachments, named backups)
//   config       /api/config model settings, keys encrypted at rest (config.ts)
//   agentRuns    IndexedDB (agentRuns.ts)
//   llmFetch     direct to the provider; when the provider sends no CORS headers, through the
//                OfferU browser extension if it is installed and capable (extensionLlm.ts),
//                otherwise (or when the extension fails before the first byte) the Worker's
//                /llm-proxy
// Companion-only capabilities (local files, Playwright PDF, poppler, BOSS login, Agent board,
// the offeru CLI) are simply not wired, so their routes answer 501 like on any runtime without them.
// Nothing here may import node:* (scripts/check-browser-bundle.mjs guards the build).

import { createApp, type AppDeps } from "@offeru/backend/app";
import { agentHost } from "@offeru/backend/routes/agent";
import { ConfigRuntime } from "@offeru/backend/routes/config";
import { staticSchoolLogos } from "@offeru/core";

import { BrowserDemoStore } from "@/lib/demo/store";

import { IndexedDbAgentRunStore } from "./agentRuns";
import { requestPersistentStorage } from "./persist";
import { indexedDbConfigStore, indexedDbConsentStore } from "./config";
import { indexedDbBackupFiles, indexedDbFileStore } from "./files";
import { getExtensionLlmTransport, getExtensionPromptStore } from "./llmTransport";
import { isRelayQuotaResponse, rememberRelayHost } from "./extensionPrompt";
import { ExtensionUnavailableError, type ExtensionLlmTransport } from "./extensionLlm";

type Fetch = typeof globalThis.fetch;

const LOCAL_HOST = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\])$/i;

/**
 * Model calls from the page. Most providers allow browser CORS; for those that do not, the
 * OfferU extension carries the call when it is installed and allows the host (no Worker quota
 * spent), else the Worker relays (POST /llm-proxy, target in X-OfferU-LLM-URL). The first CORS
 * failure per host switches that host off the direct path for the rest of the session. An
 * extension failure before the first response byte falls back to the Worker relay; once the
 * response has started, errors surface as-is (the call is not replayed).
 */
export interface LlmRelayObserver {
  /** A host failed CORS and moves off the direct path for this session. */
  relayHost?(host: string): void;
  /** A call is about to go through the Worker's /llm-proxy. */
  workerRelay?(host: string): void;
  /** The Worker's answer (status / headers only; the body is untouched). */
  workerResponse?(response: Response): void;
}

export function createLlmFetch(
  baseFetch: Fetch,
  relayPath = "/llm-proxy",
  extension: ExtensionLlmTransport | null = null,
  observer: LlmRelayObserver = {},
): (input: string, init?: RequestInit) => Promise<Response> {
  const viaRelay = new Set<string>();
  const notify = (fn: () => void) => { try { fn(); } catch { /* observers never break a call */ } };
  const workerRelay = async (url: string, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    headers.set("X-OfferU-LLM-URL", url);
    notify(() => observer.workerRelay?.(new URL(url).host));
    const response = await baseFetch(relayPath, { ...init, headers });
    notify(() => observer.workerResponse?.(response));
    return response;
  };
  const relay = async (url: string, init?: RequestInit) => {
    if (extension) {
      const caps = extension.current() ?? await extension.detect();
      if (caps && extension.supports(new URL(url), caps)) {
        try {
          return await extension.fetch(url, init);
        } catch (cause) {
          if (init?.signal?.aborted || !(cause instanceof ExtensionUnavailableError)) throw cause;
        }
      }
    }
    return workerRelay(url, init);
  };
  return async (input, init) => {
    const url = new URL(input);
    if (LOCAL_HOST.test(url.hostname) || url.protocol !== "https:") return baseFetch(input, init);
    if (viaRelay.has(url.host)) return relay(input, init);
    try {
      return await baseFetch(input, init);
    } catch (cause) {
      if (init?.signal?.aborted) throw cause;
      viaRelay.add(url.host);
      notify(() => observer.relayHost?.(url.host));
      return relay(input, init);
    }
  };
}

export interface LocalBackend {
  deps: AppDeps;
  fetch: (request: Request) => Promise<Response>;
}

export function createLocalBackend(
  baseFetch: Fetch = globalThis.fetch.bind(globalThis),
  extension: ExtensionLlmTransport | null = null,
  observer: LlmRelayObserver = {},
): LocalBackend {
  const llmFetch = createLlmFetch(baseFetch, "/llm-proxy", extension, observer);
  const config = new ConfigRuntime(indexedDbConfigStore(), llmFetch);
  void config.get().catch(() => undefined);
  const logoBase = new URL("school-logos/", globalThis.location?.href ?? "http://localhost/").toString();
  const store = new BrowserDemoStore(() => ({ version: 1, nextRecordId: 1, nextChangeId: 1, records: [], changes: [] }), "offeru-local");
  const ready = store.ready().then(() => undefined);
  // All user data lives in this IndexedDB: ask the browser not to evict it (Settings → 数据 shows the answer).
  void requestPersistentStorage();
  const deps: AppDeps = {
    store,
    runtime: "browser",
    storage: "indexeddb",
    config,
    llm: (choice) => config.llm(choice),
    llmFetch,
    fetch: (input, init) => baseFetch(input, init),
    files: indexedDbFileStore("offeru-local-files"),
    attachmentFiles: indexedDbFileStore("offeru-local-attachments"),
    backups: indexedDbBackupFiles("offeru-local-backups"),
    schoolLogos: staticSchoolLogos(logoBase, (url) => baseFetch(url)),
    renderer: null,
    agentRuns: new IndexedDbAgentRunStore(),
    consent: indexedDbConsentStore(),
  };
  const app = createApp(deps);
  void ready.then(() => agentHost(deps).state.recoverInterrupted()).catch(() => undefined);
  return { deps, fetch: async (request) => { await ready; return app.fetch(request); } };
}

/** Same-origin /api/* only; everything else (assets, /llm-proxy, other sites) passes through. */
export function isLocalApiRequest(url: URL, origin: string): boolean {
  return url.origin === origin && url.pathname.startsWith("/api/");
}

let installed: LocalBackend | null = null;

export function installLocalBackend(): LocalBackend {
  if (installed) return installed;
  const original = globalThis.fetch.bind(globalThis);
  const extension = getExtensionLlmTransport();
  void extension?.detect();
  const prompt = getExtensionPromptStore();
  const backend = createLocalBackend(original, extension, {
    relayHost: (host) => rememberRelayHost(host),
    workerRelay: () => prompt.report("relay"),
    workerResponse: (response) => { if (isRelayQuotaResponse(response)) prompt.report("quota"); },
  });
  const origin = globalThis.location.origin;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input), globalThis.location.href);
    if (!isLocalApiRequest(url, origin)) return original(input, init);
    if (input instanceof Request) return backend.fetch(init ? new Request(input, init) : input);
    return backend.fetch(new Request(url, init));
  }) as Fetch;
  installed = backend;
  return backend;
}
