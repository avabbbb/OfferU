// 网页版的「邮箱 via 浏览器插件」：不用任何邮件 API / OAuth，插件在用户已经登录的邮箱网页里填好写信页，
// 由用户自己点发送；读信只收用户在一封邮件上点「交给 OfferU」交过来的那一封。
//
// 和 extensionLlm.ts 共用同一条 window.postMessage 通道（source "offeru-page" / "offeru-ext"），消息契约见
// extension/src/mail/contract.ts（改那边要一起改这里，两边各有一条契约测试）。

import { useEffect, useState } from "react";

export type WebmailId = "gmail" | "qq" | "163";

export const WEBMAIL_LABEL: Record<WebmailId, string> = { gmail: "Gmail", qq: "QQ 邮箱", "163": "网易 163 邮箱" };
export const WEBMAIL_OPTIONS = (Object.keys(WEBMAIL_LABEL) as WebmailId[]).map((id) => ({ value: id, label: WEBMAIL_LABEL[id] }));

export const MAIL_PROTOCOL = 1;
const PAGE_SOURCE = "offeru-page";
const EXT_SOURCE = "offeru-ext";
const HELLO_TIMEOUT_MS = 1500;
const REQUEST_TIMEOUT_MS = 8000;
/** 和插件的上限一致（storage.session 10 MB，base64 再膨胀 4/3）。 */
export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;

export interface ExtensionMailCapabilities {
  protocol: number;
  version: string;
  providers: Array<{ id: WebmailId; label: string }>;
  provider: WebmailId | null;
}

export interface ComposeAttachment { name: string; type: string; base64: string }
export interface ComposeRequest { provider: WebmailId; to: string; cc: string[]; subject: string; body: string; attachment: ComposeAttachment | null }
export interface HandoffMessage { provider: WebmailId; from: string; subject: string; date: string; text: string; links: string[]; url: string }

export interface ExtensionMailWindow {
  location: { origin: string };
  addEventListener(type: "message", listener: (event: MessageEvent) => void): void;
  removeEventListener(type: "message", listener: (event: MessageEvent) => void): void;
  postMessage(message: unknown, targetOrigin: string): void;
}

export interface ExtensionMail {
  /** 握手（每次都问，便于拿到最新的默认邮箱）；没有插件或插件太旧回 null。 */
  detect(): Promise<ExtensionMailCapabilities | null>;
  setProvider(provider: WebmailId): Promise<WebmailId>;
  /** 让插件打开邮箱写信页并填好；返回后草稿还没发，由用户在邮箱里点发送。 */
  compose(request: ComposeRequest): Promise<void>;
  /** 取走用户「交给 OfferU」的邮件。 */
  takeInbox(): Promise<HandoffMessage[]>;
  /** 插件装好 / 有新邮件交过来时通知。 */
  onIncoming(listener: () => void): () => void;
}

let seq = 0;
const nextId = () => `mail-${Date.now().toString(36)}-${(seq += 1)}`;

function capable(value: unknown): ExtensionMailCapabilities | null {
  const caps = value as Partial<ExtensionMailCapabilities> | null;
  if (!caps || caps.protocol !== MAIL_PROTOCOL || !Array.isArray(caps.providers)) return null;
  const provider = caps.provider && caps.provider in WEBMAIL_LABEL ? caps.provider : null;
  return { protocol: caps.protocol, version: String(caps.version ?? ""), providers: caps.providers, provider };
}

export function createExtensionMail(win: ExtensionMailWindow, options: { helloTimeoutMs?: number; requestTimeoutMs?: number } = {}): ExtensionMail {
  const origin = win.location.origin;
  const listeners = new Set<() => void>();
  const fromExtension = (event: MessageEvent): Record<string, unknown> | null => {
    if (event.source !== (win as unknown) || event.origin !== origin) return null;
    const data = event.data as Record<string, unknown> | null;
    return data && data.source === EXT_SOURCE ? data : null;
  };
  win.addEventListener("message", (event) => {
    const type = fromExtension(event)?.type;
    if (type === "mail-incoming" || type === "mail-ready") listeners.forEach((listener) => listener());
  });

  /** 发一条请求等它的 ack；超时回 null。 */
  function ask(type: string, ack: string, payload: Record<string, unknown>, timeout: number): Promise<Record<string, unknown> | null> {
    return new Promise((resolve) => {
      const id = nextId();
      const done = (value: Record<string, unknown> | null) => {
        win.removeEventListener("message", onMessage);
        clearTimeout(timer);
        resolve(value);
      };
      const onMessage = (event: MessageEvent) => {
        const data = fromExtension(event);
        if (data?.type === ack && data.id === id) done(data);
      };
      const timer = setTimeout(() => done(null), timeout);
      win.addEventListener("message", onMessage);
      win.postMessage({ source: PAGE_SOURCE, type, id, ...payload }, origin);
    });
  }

  const requestTimeout = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
  const fail = (data: Record<string, unknown> | null, fallback: string): never => {
    throw new Error(String(data?.error || fallback));
  };

  return {
    async detect() {
      const data = await ask("mail-hello", "mail-hello-ack", {}, options.helloTimeoutMs ?? HELLO_TIMEOUT_MS);
      return data?.ok ? capable(data.mail) : null;
    },
    async setProvider(provider) {
      const data = await ask("mail-set-provider", "mail-set-provider-ack", { provider }, requestTimeout);
      if (!data?.ok) fail(data, "插件没有回应，确认插件已启用后刷新页面");
      return provider;
    },
    async compose(request) {
      const data = await ask("mail-compose", "mail-compose-ack", { compose: request }, requestTimeout);
      if (!data?.ok) fail(data, "插件没有回应，确认插件已启用后刷新页面");
    },
    async takeInbox() {
      const data = await ask("mail-inbox-take", "mail-inbox-ack", {}, requestTimeout);
      return data?.ok && Array.isArray(data.messages) ? (data.messages as HandoffMessage[]) : [];
    },
    onIncoming(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}

let instance: ExtensionMail | null | undefined;

/** 页面唯一的邮箱插件通道（不在浏览器里时为 null）。 */
export function getExtensionMail(): ExtensionMail | null {
  if (instance !== undefined) return instance;
  instance = typeof window !== "undefined" && typeof window.postMessage === "function" ? createExtensionMail(window) : null;
  return instance;
}

export type ExtensionMailState = { status: "checking" } | { status: "missing" } | { status: "ready"; caps: ExtensionMailCapabilities };

/** React：插件在不在、默认邮箱是哪个。插件晚于页面装好（mail-ready）时会自动重查。 */
export function useExtensionMail(enabled = true): [ExtensionMailState, (provider: WebmailId) => Promise<void>] {
  const [state, setState] = useState<ExtensionMailState>({ status: enabled ? "checking" : "missing" });
  useEffect(() => {
    const ext = enabled ? getExtensionMail() : null;
    if (!ext) { setState({ status: "missing" }); return undefined; }
    let cancelled = false;
    const check = () => void ext.detect().then((caps) => {
      if (!cancelled) setState(caps ? { status: "ready", caps } : { status: "missing" });
    });
    check();
    const off = ext.onIncoming(check);
    return () => { cancelled = true; off(); };
  }, [enabled]);
  const choose = async (provider: WebmailId) => {
    const ext = getExtensionMail();
    if (!ext) return;
    await ext.setProvider(provider);
    setState((current) => (current.status === "ready" ? { status: "ready", caps: { ...current.caps, provider } } : current));
  };
  return [state, choose];
}

/** 本地文件（用户选的简历 PDF）转成插件能带过去的附件。 */
export async function fileToAttachment(file: File): Promise<ComposeAttachment> {
  if (file.size > MAX_ATTACHMENT_BYTES) throw new Error("PDF 超过 5 MB，请在邮箱里手动添加附件");
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return { name: file.name, type: file.type || "application/pdf", base64: btoa(binary) };
}

/** 交过来的邮件写成一段给 Agent 的话：和用户手动贴邀约邮件走同一条流程。 */
export function handoffPrompt(message: HandoffMessage): string {
  const lines = [
    `这是我在${WEBMAIL_LABEL[message.provider] ?? "邮箱"}里打开的一封邮件，请按邀约邮件处理：找到对应岗位，推进投递状态，有时间或链接就记成事项（带上链接）。`,
    "",
    `发件人：${message.from || "（未读到）"}`,
    `主题：${message.subject || "（无主题）"}`,
  ];
  if (message.date) lines.push(`时间：${message.date}`);
  if (message.links.length) lines.push("链接：", ...message.links.map((link) => `- ${link}`));
  lines.push("", "正文：", message.text);
  return lines.join("\n");
}
