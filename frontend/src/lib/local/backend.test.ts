// The web build's in-page backend: backend-ts's Hono app over browser adapters.

import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/demo/keyVault", () => ({
  encryptSecret: async (value: string) => ({ v: 1, iv: "test", data: btoa(value) }),
  decryptSecret: async (secret?: { data: string }) => (secret?.data ? atob(secret.data) : ""),
}));

import { createLlmFetch, createLocalBackend, forwardToLocalBridge, isLocalApiRequest } from "./backend";
import { connectLocalBridge, disconnectLocalBridge } from "@/lib/bridge";

const KEY = "sk-abcdefghijklmnop1234";
const json = async (res: Response) => res.json() as Promise<Record<string, any>>;

describe("in-page backend", () => {
  it("answers /api/* in the page with the browser runtime and an empty local store", async () => {
    const backend = createLocalBackend(vi.fn(async () => new Response("no network in tests", { status: 599 })) as never);
    const health = await json(await backend.fetch(new Request("http://localhost/api/health")));
    expect(health).toMatchObject({ status: "ok", runtime: "browser", storage: "indexeddb" });

    const saved = await backend.fetch(new Request("http://localhost/api/tools/save", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "memory", data: { title: "网页版记一条" } }),
    }));
    expect(saved.status).toBe(200);
    expect((await json(saved)).record.title).toBe("网页版记一条");
  });

  it("companion-only routes are 501, not fake successes", async () => {
    const backend = createLocalBackend(vi.fn() as never);
    expect((await backend.fetch(new Request("http://localhost/api/agent-board"))).status).toBe(501);
    // 邮箱（IMAP / SMTP）只在桌面伴侣：设置页显示「仅桌面版」，mail 工具回 unsupported。
    const mail = await backend.fetch(new Request("http://localhost/api/mail/status"));
    expect(mail.status).toBe(501);
    expect((await json(mail)).code).toBe("unsupported");
    const tool = await backend.fetch(new Request("http://localhost/api/tools/mail", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "list" }),
    }));
    expect(await json(tool)).toMatchObject({ code: "unsupported" });
  });

  it("model settings: saved in the browser, key masked on the way out", async () => {
    const backend = createLocalBackend(vi.fn() as never);
    const put = await backend.fetch(new Request("http://localhost/api/config/", {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ llm_api_configs: [{ id: "c1", service_name: "GW", base_url: "https://api.example.com/v1", model: "m", api_key: KEY }] }),
    }));
    expect(put.status).toBe(200);
    const config = await json(await backend.fetch(new Request("http://localhost/api/config/")));
    expect(config.llm_api_configs[0].api_key).not.toBe(KEY);
    expect(config.active_llm_summary).toMatchObject({ service_name: "GW", model: "m" });
    expect(backend.deps.llm?.()).not.toBeNull();

    // A fresh page load reads the same settings back from IndexedDB.
    const again = createLocalBackend(vi.fn() as never);
    expect((await json(await again.fetch(new Request("http://localhost/api/config/")))).active_llm_config_id).toBe("c1");
  });

  it("only same-origin /api/* is intercepted", () => {
    expect(isLocalApiRequest(new URL("http://localhost/api/health"), "http://localhost")).toBe(true);
    expect(isLocalApiRequest(new URL("http://localhost/llm-proxy"), "http://localhost")).toBe(false);
    expect(isLocalApiRequest(new URL("https://api.deepseek.com/api/x"), "http://localhost")).toBe(false);
  });

  it("forwards /api/* to the paired local companion with X-OfferU-Pairing", async () => {
    const prevFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })) as never;
    try {
      await connectLocalBridge("pair-token-abcdefghijklmnopqrstuvwxyz", { persist: false });
      const original = vi.fn(async () => new Response(JSON.stringify({ items: [] }), { status: 200 }));
      await forwardToLocalBridge(
        original as never,
        new URL("https://offeru.avabbbb.com/api/tools/list?x=1"),
        "/api/tools/list?x=1",
        { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" },
      );
      expect(original).toHaveBeenCalledTimes(1);
      const [target, init] = original.mock.calls[0] as unknown as [string, RequestInit];
      expect(target).toBe("http://127.0.0.1:8766/api/tools/list?x=1");
      const headers = new Headers(init.headers);
      expect(headers.get("x-offeru-pairing")).toBe("pair-token-abcdefghijklmnopqrstuvwxyz");
      expect(headers.get("content-type")).toBe("application/json");
    } finally {
      disconnectLocalBridge();
      globalThis.fetch = prevFetch;
    }
  });
});

describe("model fetch from the page", () => {
  it("goes direct when the provider allows CORS", async () => {
    const base = vi.fn(async () => new Response("ok"));
    await createLlmFetch(base as never)("https://api.example.com/v1/chat/completions", { method: "POST", body: "{}" });
    expect(base).toHaveBeenCalledWith("https://api.example.com/v1/chat/completions", expect.anything());
  });

  it("switches a host to the Worker relay after a CORS failure", async () => {
    const base = vi.fn(async (input: string) => {
      if (input.startsWith("https://")) throw new TypeError("Failed to fetch");
      return new Response("relayed");
    });
    const llmFetch = createLlmFetch(base as never);
    const res = await llmFetch("https://api.deepseek.com/chat/completions", { method: "POST", body: "{}", headers: { Authorization: "Bearer k" } });
    expect(await res.text()).toBe("relayed");
    const [path, init] = base.mock.calls[1] as unknown as [string, RequestInit];
    expect(path).toBe("/llm-proxy");
    expect(new Headers(init.headers).get("x-offeru-llm-url")).toBe("https://api.deepseek.com/chat/completions");
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer k");
    await llmFetch("https://api.deepseek.com/chat/completions", { method: "POST", body: "{}" });
    expect(base).toHaveBeenCalledTimes(3); // second call skips the direct attempt
  });

  it("local models are always direct", async () => {
    const base = vi.fn(async () => { throw new TypeError("refused"); });
    await expect(createLlmFetch(base as never)("http://localhost:11434/v1/chat/completions")).rejects.toThrow("refused");
    expect(base).toHaveBeenCalledTimes(1);
  });
});
