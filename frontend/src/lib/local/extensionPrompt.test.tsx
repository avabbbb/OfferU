// When the web build suggests installing the extension, and the prompt UI.

import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/demo/keyVault", () => ({
  encryptSecret: async (value: string) => ({ v: 1, iv: "test", data: btoa(value) }),
  decryptSecret: async (secret?: { data: string }) => (secret?.data ? atob(secret.data) : ""),
}));
vi.mock("@/lib/local/mode", () => ({ LOCAL_WEB: true, OFFERU_MODE: "local-web" }));
const configData = { current: {} as Record<string, unknown> };
vi.mock("@/lib/hooks", () => ({ useConfig: () => ({ data: configData.current }) }));

import { createLlmFetch } from "./backend";
import {
  baseUrlNeedsRelay,
  createExtensionPromptStore,
  EXTENSION_INSTALL_DOCS_URL,
  extensionInstallUrl,
  isRelayQuotaResponse,
  learnedRelayHosts,
  rememberRelayHost,
  shouldShowExtensionPrompt,
  type PromptStorage,
} from "./extensionPrompt";

const memoryStorage = (): PromptStorage & { data: Map<string, string> } => {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => { data.set(k, v); } };
};
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("detection", () => {
  it("a configured provider needs the relay when learned or a known no-CORS gateway", () => {
    expect(baseUrlNeedsRelay("https://api.deepseek.com", ["api.deepseek.com"])).toBe(true);
    expect(baseUrlNeedsRelay("https://api.deepseek.com/v1", [])).toBe(false);
    expect(baseUrlNeedsRelay("https://opencode.ai/zen/v1", [])).toBe(true);
    expect(baseUrlNeedsRelay("http://localhost:11434/v1", ["localhost:11434"])).toBe(false);
    expect(baseUrlNeedsRelay("", [])).toBe(false);
    expect(baseUrlNeedsRelay("not a url", [])).toBe(false);
  });

  it("learned relay hosts persist in storage", () => {
    const storage = memoryStorage();
    rememberRelayHost("api.deepseek.com", storage);
    rememberRelayHost("api.deepseek.com", storage);
    expect(learnedRelayHosts(storage)).toEqual(["api.deepseek.com"]);
    storage.setItem("offeru.llm.relayHosts.v1", "{broken");
    expect(learnedRelayHosts(storage)).toEqual([]);
  });

  it("only the Worker's own 429 counts as relay quota", () => {
    expect(isRelayQuotaResponse(new Response("error code: 1027", { status: 429, headers: { "content-type": "text/html" } }))).toBe(true);
    expect(isRelayQuotaResponse(new Response("Too Many", { status: 429 }))).toBe(true);
    expect(isRelayQuotaResponse(new Response("{}", { status: 429, headers: { "content-type": "application/json" } }))).toBe(false);
    expect(isRelayQuotaResponse(new Response("{}", { status: 200 }))).toBe(false);
  });

  it("show rules", () => {
    const base = { localWeb: true, extensionConnected: false, neverRemind: false, dismissedThisSession: false };
    expect(shouldShowExtensionPrompt(base, "relay")).toBe(true);
    expect(shouldShowExtensionPrompt({ ...base, localWeb: false }, "relay")).toBe(false);
    expect(shouldShowExtensionPrompt({ ...base, extensionConnected: true }, "quota")).toBe(false);
    expect(shouldShowExtensionPrompt({ ...base, dismissedThisSession: true }, "configured")).toBe(false);
    expect(shouldShowExtensionPrompt({ ...base, dismissedThisSession: true }, "quota")).toBe(true);
    expect(shouldShowExtensionPrompt({ ...base, neverRemind: true }, "quota")).toBe(false);
  });

  it("install link: store page when published, else the install instructions", () => {
    expect(extensionInstallUrl("")).toBe(EXTENSION_INSTALL_DOCS_URL);
    expect(extensionInstallUrl("https://chromewebstore.google.com/detail/x")).toBe("https://chromewebstore.google.com/detail/x");
  });
});

describe("prompt store", () => {
  it("shows on relay, hides on dismiss, quota re-shows, never-remind sticks", async () => {
    const storage = memoryStorage();
    const store = createExtensionPromptStore({ localWeb: true, isExtensionConnected: async () => false, storage });
    store.report("relay");
    await flush();
    expect(store.view()).toEqual({ visible: true, trigger: "relay" });
    store.dismiss();
    store.report("relay");
    await flush();
    expect(store.view().visible).toBe(false);
    store.report("quota");
    await flush();
    expect(store.view()).toEqual({ visible: true, trigger: "quota" });
    store.neverRemind();
    store.report("quota");
    await flush();
    expect(store.view().visible).toBe(false);
    // a fresh page load remembers "不再提醒"
    const again = createExtensionPromptStore({ localWeb: true, isExtensionConnected: async () => false, storage });
    again.report("quota");
    await flush();
    expect(again.view().visible).toBe(false);
  });

  it("never shows with the extension connected or outside the web build", async () => {
    const connected = createExtensionPromptStore({ localWeb: true, isExtensionConnected: async () => true, storage: memoryStorage() });
    connected.report("quota");
    const desktop = createExtensionPromptStore({ localWeb: false, isExtensionConnected: async () => false, storage: memoryStorage() });
    desktop.report("quota");
    await flush();
    expect(connected.view().visible).toBe(false);
    expect(desktop.view().visible).toBe(false);
  });
});

describe("llmFetch reports relay use", () => {
  it("notifies before /llm-proxy, records the host, and passes the Worker response; requests still succeed", async () => {
    const base = vi.fn(async (input: string) => {
      if (String(input).startsWith("https://")) throw new TypeError("Failed to fetch");
      return new Response("quota", { status: 429, headers: { "content-type": "text/html" } });
    });
    const events: string[] = [];
    const llmFetch = createLlmFetch(base as never, "/llm-proxy", null, {
      relayHost: (host) => events.push(`host:${host}`),
      workerRelay: (host) => events.push(`relay:${host}`),
      workerResponse: (res) => events.push(`quota:${isRelayQuotaResponse(res)}`),
    });
    const res = await llmFetch("https://api.deepseek.com/chat/completions", { method: "POST", body: "{}" });
    expect(res.status).toBe(429);
    expect(events).toEqual(["host:api.deepseek.com", "relay:api.deepseek.com", "quota:true"]);
  });

  it("a throwing observer never breaks the call", async () => {
    const base = vi.fn(async (input: string) => {
      if (String(input).startsWith("https://")) throw new TypeError("Failed to fetch");
      return new Response("ok");
    });
    const llmFetch = createLlmFetch(base as never, "/llm-proxy", null, { workerRelay: () => { throw new Error("boom"); } });
    expect(await (await llmFetch("https://api.deepseek.com/x", { method: "POST", body: "{}" })).text()).toBe("ok");
  });
});

describe("prompt UI", () => {
  it("appears for a configured no-CORS provider and can be dismissed", async () => {
    window.postMessage = vi.fn() as never; // no extension answers the handshake
    configData.current = { active_llm_config_id: "c1", llm_api_configs: [{ id: "c1", base_url: "https://opencode.ai/zen/v1" }] };
    const { ExtensionInstallPrompt } = await import("@/components/settings/ExtensionInstallPrompt");
    render(<ExtensionInstallPrompt />);
    expect(await screen.findByTestId("extension-install-prompt", {}, { timeout: 4000 })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "查看安装方法" })).toHaveAttribute("href", EXTENSION_INSTALL_DOCS_URL);
    act(() => { fireEvent.click(screen.getByRole("button", { name: "稍后" })); });
    expect(screen.queryByTestId("extension-install-prompt")).toBeNull();
  }, 20_000);
});
