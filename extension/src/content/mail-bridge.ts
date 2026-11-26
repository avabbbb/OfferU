// OfferU 网页 ⇄ 插件后台的邮箱桥（契约见 src/mail/contract.ts）。
// 和 llm-bridge 一样：只在 OfferU 顶层页面安装，网页用 window.postMessage 发 { source: "offeru-page" }，
// 桥转成 runtime 消息交给后台，再把回答以 { source: "offeru-ext" } 发回同一个 origin。不记录邮件内容。
import { isOfferUOrigin } from "../background/llm-relay.js";

import { EXT_SOURCE, PAGE_SOURCE, type BridgeWindow } from "./llm-bridge.js";

export interface MailBridgeRuntime {
  sendMessage(message: unknown, callback: (response: unknown) => void): void;
  lastError(): unknown;
  /** 后台推来的消息（有新的「交给 OfferU」）；监听器处理了返回 true，后台据此知道送达了。 */
  onMessage(listener: (message: unknown) => boolean): void;
}

const ROUTES: Record<string, { runtime: string; ack: string; payload: (data: Record<string, unknown>) => Record<string, unknown> }> = {
  "mail-hello": { runtime: "OFFERU_MAIL_HELLO", ack: "mail-hello-ack", payload: () => ({}) },
  "mail-set-provider": { runtime: "OFFERU_MAIL_SET_PROVIDER", ack: "mail-set-provider-ack", payload: (data) => ({ provider: data.provider }) },
  "mail-compose": { runtime: "OFFERU_MAIL_COMPOSE", ack: "mail-compose-ack", payload: (data) => ({ compose: data.compose }) },
  "mail-inbox-take": { runtime: "OFFERU_MAIL_INBOX_TAKE", ack: "mail-inbox-ack", payload: () => ({}) },
};

/** 装桥；不在 OfferU 顶层页面时什么都不做并返回 false。 */
export function installMailBridge(win: BridgeWindow, runtime: MailBridgeRuntime): boolean {
  const origin = win.location.origin;
  if (!isOfferUOrigin(origin) || win.top !== win) return false;
  const reply = (message: Record<string, unknown>): void => win.postMessage({ source: EXT_SOURCE, ...message }, origin);

  win.addEventListener("message", (event: MessageEvent) => {
    if (event.source !== win || event.origin !== origin) return;
    const data = event.data as Record<string, unknown> | null;
    if (!data || data.source !== PAGE_SOURCE || typeof data.id !== "string" || typeof data.type !== "string") return;
    const route = ROUTES[data.type];
    if (!route) return;
    const id = data.id;
    try {
      runtime.sendMessage({ type: route.runtime, ...route.payload(data) }, (response) => {
        void runtime.lastError();
        const body = (response && typeof response === "object" ? response : { ok: false, error: "插件没有回应" }) as Record<string, unknown>;
        reply({ ...body, type: route.ack, id });
      });
    } catch {
      reply({ type: route.ack, id, ok: false, error: "插件已更新，请刷新这个页面" });
    }
  });

  runtime.onMessage((message) => {
    if ((message as { type?: string } | null)?.type !== "OFFERU_MAIL_INCOMING") return false;
    reply({ type: "mail-incoming" });
    return true;
  });

  reply({ type: "mail-ready" });
  return true;
}
