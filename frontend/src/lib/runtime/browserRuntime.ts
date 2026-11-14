// The browser runtime: the backend's Hono app (backend-ts/src/app.ts) running
// inside the page over IndexedDB. Same routes, same core, same JSON as the
// companion, so lib/api.ts does not care which one answers.
//
// Loaded lazily (dynamic import from lib/transport) so desktop builds never
// pay for it.

import localforage from "localforage";
import { mutate } from "swr";

import { createOpenAiLlm, staticSchoolLogos, type LlmClient, type PortableState } from "@offeru/core";
import { IdbCoreStore, IdbFileStore } from "@offeru/core/idb";
import { createApp, type AppDeps } from "@offeru/app";

import { DEMO_SEED } from "./mode";
import { buildDemoState } from "@/lib/demo/seed";
import { loadAgentConfig, subscribeAgentConfig, type AgentConfig } from "@/lib/demo/keyVault";

const DB_NAME = "offeru";
const CHANNEL = "offeru-runtime";

/** The pre-IDB showcase store kept one localforage blob: offeru-demo/records "offeru-demo-state:v1". */
export const LEGACY_DB = { name: "offeru-demo", storeName: "records", key: "offeru-demo-state:v1" } as const;

export async function readLegacyState(): Promise<PortableState | null> {
  try {
    const legacy = localforage.createInstance({ name: LEGACY_DB.name, storeName: LEGACY_DB.storeName });
    const saved = await legacy.getItem<PortableState>(LEGACY_DB.key);
    if (!saved || saved.version !== 1 || !Array.isArray(saved.records) || !Array.isArray(saved.changes)) return null;
    return saved;
  } catch {
    return null;
  }
}

let channel: BroadcastChannel | null = null;

function broadcast(rev: number): void {
  try {
    channel ??= typeof BroadcastChannel === "function" ? new BroadcastChannel(CHANNEL) : null;
    channel?.postMessage({ rev });
  } catch {
    // Cross-tab refresh is a nicety; the data is already committed.
  }
}

/** Another tab committed: revalidate every SWR key so this tab shows it. */
export function listenForOtherTabs(): () => void {
  if (typeof BroadcastChannel !== "function") return () => undefined;
  const listener = new BroadcastChannel(CHANNEL);
  listener.onmessage = () => {
    void mutate(() => true);
  };
  return () => listener.close();
}

let idb: IdbCoreStore | null = null;

export function browserStore(): IdbCoreStore {
  idb ??= new IdbCoreStore({
    name: DB_NAME,
    migrate: readLegacyState,
    seed: DEMO_SEED ? buildDemoState : undefined,
    onCommit: broadcast,
  });
  return idb;
}

// ---- model (BYOK, direct from the browser) --------------------------------

/**
 * The browser runtime's model comes from the user's own key, kept in this
 * browser (lib/demo/keyVault: encrypted with a non-extractable device key when
 * "remember" is on, memory-only otherwise). Requests go straight from the page
 * to the provider (it must allow CORS); the key never reaches OfferU or the
 * Worker. AppDeps.llm is called per request, so a changed key applies at once.
 *
 * When ts/interview-config lands its browser /api/config, the config should
 * come from there (deps.settings below is the IndexedDB key/value it can use).
 */
let llmConfig: AgentConfig | null = null;

function refreshLlmConfig(): void {
  void loadAgentConfig().then((config) => { llmConfig = config; }).catch(() => { llmConfig = null; });
}

export function browserLlm(): LlmClient | null {
  const config = llmConfig;
  if (!config?.apiKey || !config.baseUrl || !config.model) return null;
  return createOpenAiLlm({
    baseUrl: config.baseUrl,
    model: config.model,
    apiKey: config.apiKey,
    fetch: (url, init) => fetch(url, init),
  });
}

/** Bundled school emblems: the web build emits them as static files under ./school-logos/ (vite.config). */
const SCHOOL_LOGO_BASE = "./school-logos";

// ---- the app --------------------------------------------------------------

export type BrowserApp = { fetch: (request: Request) => Promise<Response> };

let app: BrowserApp | null = null;

export function browserApp(): BrowserApp {
  if (app) return app;
  refreshLlmConfig();
  subscribeAgentConfig(refreshLlmConfig);
  const store = browserStore();
  const deps: AppDeps = {
    store,
    runtime: "browser",
    storage: "indexeddb",
    llm: browserLlm,
    files: new IdbFileStore(store),
    renderer: null, // no Chromium here: PDF goes through window.print (lib/resumeExport)
    schoolLogos: staticSchoolLogos(SCHOOL_LOGO_BASE, (url) => fetch(url)),
    // Local key/value for domains that keep browser-side settings (getSetting/setSetting/deleteSetting).
    ...({ settings: store } as unknown as Partial<AppDeps>),
  };
  const hono = createApp(deps);
  app = { fetch: async (request) => hono.fetch(request) };
  return app;
}
