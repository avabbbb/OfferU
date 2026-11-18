// Which way the web build's model calls leave the page when the provider has no CORS:
// "extension" (直连（扩展）) when the OfferU extension answered the handshake, else "proxy"
// (the Worker's /llm-proxy). Only meaningful in local-web mode; elsewhere model calls run
// in the backend and this stays "proxy".

import { useEffect, useState } from "react";

import { createExtensionLlmTransport, type ExtensionLlmTransport } from "./extensionLlm";
import { createExtensionPromptStore, type ExtensionPromptStore } from "./extensionPrompt";
import { LOCAL_WEB } from "./mode";

export type LlmTransportMode = "extension" | "proxy";

let transport: ExtensionLlmTransport | null | undefined;

/** The page's single extension transport (null outside a browser window). */
export function getExtensionLlmTransport(): ExtensionLlmTransport | null {
  if (transport !== undefined) return transport;
  transport = typeof window !== "undefined" && typeof window.postMessage === "function"
    ? createExtensionLlmTransport(window)
    : null;
  return transport;
}

export function llmTransportMode(): LlmTransportMode {
  return transport?.current() ? "extension" : "proxy";
}

/** React view of llmTransportMode(); re-runs the handshake once when mounted. */
export function useLlmTransportMode(enabled: boolean): LlmTransportMode {
  const [mode, setMode] = useState<LlmTransportMode>(() => (enabled ? llmTransportMode() : "proxy"));
  useEffect(() => {
    if (!enabled) return undefined;
    const ext = getExtensionLlmTransport();
    if (!ext) return undefined;
    const update = () => setMode(llmTransportMode());
    const unsubscribe = ext.subscribe(update);
    void ext.detect().then(update);
    return () => { unsubscribe(); };
  }, [enabled]);
  return mode;
}

let promptStore: ExtensionPromptStore | null = null;

/** The page's single "install the extension" prompt state (local-web only ever shows it). */
export function getExtensionPromptStore(): ExtensionPromptStore {
  if (promptStore) return promptStore;
  promptStore = createExtensionPromptStore({
    localWeb: LOCAL_WEB,
    isExtensionConnected: async () => !!(await getExtensionLlmTransport()?.detect()),
  });
  return promptStore;
}
