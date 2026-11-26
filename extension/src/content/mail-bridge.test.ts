// 网页 ⇄ 插件邮箱桥的消息契约。前端那一侧在 frontend/src/lib/local/extensionMail.test.ts 用同样的消息形状。
import { describe, expect, it } from "vitest";

import { installMailBridge } from "./mail-bridge.js";

function harness(origin = "http://localhost:7410", responses: Record<string, unknown> = {}) {
  const posted: Array<Record<string, unknown>> = [];
  const sent: Array<Record<string, unknown>> = [];
  let listener: ((event: MessageEvent) => void) | null = null;
  let pushed: ((message: unknown) => boolean) | null = null;
  const win = {
    location: { origin },
    top: null as unknown,
    addEventListener: (_type: "message", l: (event: MessageEvent) => void) => { listener = l; },
    postMessage: (message: unknown) => { posted.push(message as Record<string, unknown>); },
  };
  win.top = win;
  const installed = installMailBridge(win, {
    sendMessage: (message, callback) => { sent.push(message as Record<string, unknown>); callback(responses[(message as { type: string }).type]); },
    lastError: () => undefined,
    onMessage: (l) => { pushed = l; },
  });
  const fromPage = (data: Record<string, unknown>) => listener?.({ source: win, origin, data: { source: "offeru-page", ...data } } as unknown as MessageEvent);
  return { installed, posted, sent, fromPage, push: (message: unknown) => pushed?.(message), win };
}

describe("mail bridge contract", () => {
  it("is installed only on OfferU top frames and announces itself", () => {
    expect(harness("https://evil.example").installed).toBe(false);
    const ok = harness();
    expect(ok.installed).toBe(true);
    expect(ok.posted).toEqual([{ source: "offeru-ext", type: "mail-ready" }]);
  });

  it("maps page requests to runtime messages and replies with the matching ack and id", () => {
    const capabilities = { protocol: 1, version: "0.1.0", providers: [], provider: "gmail", compose: true, handoff: true };
    const h = harness("http://localhost:7410", {
      OFFERU_MAIL_HELLO: { ok: true, mail: capabilities },
      OFFERU_MAIL_SET_PROVIDER: { ok: true, provider: "163" },
      OFFERU_MAIL_COMPOSE: { ok: true, provider: "gmail" },
      OFFERU_MAIL_INBOX_TAKE: { ok: true, messages: [] },
    });
    h.fromPage({ type: "mail-hello", id: "1" });
    h.fromPage({ type: "mail-set-provider", id: "2", provider: "163" });
    h.fromPage({ type: "mail-compose", id: "3", compose: { to: "a@b.co" } });
    h.fromPage({ type: "mail-inbox-take", id: "4" });
    expect(h.sent).toEqual([
      { type: "OFFERU_MAIL_HELLO" },
      { type: "OFFERU_MAIL_SET_PROVIDER", provider: "163" },
      { type: "OFFERU_MAIL_COMPOSE", compose: { to: "a@b.co" } },
      { type: "OFFERU_MAIL_INBOX_TAKE" },
    ]);
    expect(h.posted.slice(1)).toEqual([
      { source: "offeru-ext", type: "mail-hello-ack", id: "1", ok: true, mail: capabilities },
      { source: "offeru-ext", type: "mail-set-provider-ack", id: "2", ok: true, provider: "163" },
      { source: "offeru-ext", type: "mail-compose-ack", id: "3", ok: true, provider: "gmail" },
      { source: "offeru-ext", type: "mail-inbox-ack", id: "4", ok: true, messages: [] },
    ]);
  });

  it("answers with an error ack when the background is silent, and ignores other sources", () => {
    const h = harness();
    h.fromPage({ type: "mail-compose", id: "9" });
    expect(h.posted[h.posted.length - 1]).toEqual({ source: "offeru-ext", type: "mail-compose-ack", id: "9", ok: false, error: "插件没有回应" });
    h.fromPage({ type: "llm-hello", id: "10" });
    expect(h.sent).toHaveLength(1);
  });

  it("turns a background push into mail-incoming and confirms delivery", () => {
    const h = harness();
    expect(h.push({ type: "OFFERU_MAIL_INCOMING" })).toBe(true);
    expect(h.posted[h.posted.length - 1]).toEqual({ source: "offeru-ext", type: "mail-incoming" });
    expect(h.push({ type: "OTHER" })).toBe(false);
  });
});
