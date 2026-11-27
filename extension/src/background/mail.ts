// 插件后台：网页版「邮箱 via 插件」的中转。不碰任何邮件 API / OAuth，也不发信。
//
// - OfferU 网页（只认 isOfferUOrigin）：握手、选默认邮箱、交一份待填写的草稿、取「交给 OfferU」的邮件。
// - 邮箱网页（只认适配器里的域名、顶层 frame）：取本标签页待填的草稿、填完销账、交出一封邮件。
// 待填草稿按标签页存在 storage.session（浏览器关了就没），15 分钟过期；交出的邮件同样只在 session 里排队。
import {
  isWebmailId, MAIL_PROTOCOL, normalizeHandoff, parseComposeRequest, WEBMAIL_PROVIDERS,
  type ComposeRequest, type HandoffMessage, type MailCapabilities, type WebmailId,
} from "../mail/contract.js";
import { adapterFor, adapterForHost } from "../mail/providers/index.js";
import { isOfferUOrigin, OFFERU_WEB_ORIGINS } from "./llm-relay.js";

export const MAIL_MESSAGE_TYPES = [
  "OFFERU_MAIL_HELLO",
  "OFFERU_MAIL_SET_PROVIDER",
  "OFFERU_MAIL_COMPOSE",
  "OFFERU_MAIL_INBOX_TAKE",
  "OFFERU_MAIL_COMPOSE_TAKE",
  "OFFERU_MAIL_COMPOSE_DONE",
  "OFFERU_MAIL_HANDOFF",
] as const;
export type MailMessageType = (typeof MAIL_MESSAGE_TYPES)[number];

export function isMailMessage(message: unknown): message is { type: MailMessageType } & Record<string, unknown> {
  const type = (message as { type?: unknown } | null)?.type;
  return typeof type === "string" && (MAIL_MESSAGE_TYPES as readonly string[]).includes(type);
}

export const PROVIDER_KEY = "offeruMailProvider";
export const WEB_ORIGIN_KEY = "offeruWebOrigin";
export const INBOX_KEY = "offeruMailInbox";
export const composeKey = (tabId: number) => `offeruMailCompose:${tabId}`;
export const COMPOSE_TTL_MS = 15 * 60 * 1000;
const INBOX_LIMIT = 10;

export interface KeyValueStore {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
  remove(key: string): Promise<void>;
}

export interface MailSender {
  id?: string;
  origin?: string;
  url?: string;
  frameId?: number;
  tab?: { id?: number };
}

export interface MailBackgroundDeps {
  extensionId: string;
  version: string;
  local: KeyValueStore;
  session: KeyValueStore;
  openTab(url: string): Promise<{ id?: number }>;
  /** 打开着的 OfferU 网页标签（url 带 origin）。 */
  offeruTabs(): Promise<Array<{ id: number; url: string }>>;
  /** 给 OfferU 标签的内容脚本发消息；送达返回 true。 */
  notifyTab(tabId: number, message: unknown): Promise<boolean>;
  focusTab(tabId: number): Promise<void>;
  now(): number;
}

interface PendingCompose {
  request: ComposeRequest;
  at: number;
}

function originOf(sender: MailSender): string {
  if (sender.origin) return sender.origin;
  try { return sender.url ? new URL(sender.url).origin : ""; } catch { return ""; }
}

async function provider(deps: MailBackgroundDeps): Promise<WebmailId | null> {
  const value = await deps.local.get(PROVIDER_KEY);
  return isWebmailId(value) ? value : null;
}

export async function mailCapabilities(deps: MailBackgroundDeps): Promise<MailCapabilities> {
  return {
    protocol: MAIL_PROTOCOL,
    version: deps.version,
    providers: WEBMAIL_PROVIDERS.map((item) => ({ ...item })),
    provider: await provider(deps),
    compose: true,
    handoff: true,
  };
}

/** 处理一条邮箱相关消息；不是邮箱消息返回 undefined（交给别的监听器）。 */
export async function handleMailMessage(message: unknown, sender: MailSender, deps: MailBackgroundDeps): Promise<unknown> {
  if (!isMailMessage(message)) return undefined;
  if (sender.id !== deps.extensionId) return { ok: false, error: "forbidden" };
  const origin = originOf(sender);

  switch (message.type) {
    case "OFFERU_MAIL_HELLO":
    case "OFFERU_MAIL_SET_PROVIDER":
    case "OFFERU_MAIL_COMPOSE":
    case "OFFERU_MAIL_INBOX_TAKE":
      if (!isOfferUOrigin(origin) || sender.frameId) return { ok: false, error: "只接受 OfferU 网页的请求" };
      break;
    default: {
      const host = (() => { try { return new URL(sender.url ?? "").hostname; } catch { return ""; } })();
      if (!adapterForHost(host) || sender.frameId || sender.tab?.id === undefined) return { ok: false, error: "只接受邮箱网页的请求" };
    }
  }

  switch (message.type) {
    case "OFFERU_MAIL_HELLO":
      await deps.local.set(WEB_ORIGIN_KEY, origin);
      return { ok: true, mail: await mailCapabilities(deps) };

    case "OFFERU_MAIL_SET_PROVIDER": {
      if (!isWebmailId(message.provider)) return { ok: false, error: "不认识这个邮箱" };
      await deps.local.set(PROVIDER_KEY, message.provider);
      return { ok: true, provider: message.provider };
    }

    case "OFFERU_MAIL_COMPOSE": {
      const parsed = parseComposeRequest(message.compose);
      if (!parsed.ok) return { ok: false, error: parsed.error };
      const request = parsed.value;
      const tab = await deps.openTab(adapterFor(request.provider).composeUrl(request));
      if (tab.id === undefined) return { ok: false, error: "没能打开邮箱标签页" };
      const pending: PendingCompose = { request, at: deps.now() };
      await deps.session.set(composeKey(tab.id), pending);
      return { ok: true, provider: request.provider };
    }

    case "OFFERU_MAIL_INBOX_TAKE": {
      const inbox = ((await deps.session.get(INBOX_KEY)) as HandoffMessage[] | undefined) ?? [];
      await deps.session.remove(INBOX_KEY);
      return { ok: true, messages: inbox };
    }

    case "OFFERU_MAIL_COMPOSE_TAKE": {
      const key = composeKey(sender.tab!.id!);
      const pending = (await deps.session.get(key)) as PendingCompose | undefined;
      if (!pending) return { ok: true, compose: null };
      if (deps.now() - pending.at > COMPOSE_TTL_MS) {
        await deps.session.remove(key);
        return { ok: true, compose: null };
      }
      // 只交给同一个邮箱：用户中途跳去别的邮箱不填。
      const host = new URL(sender.url!).hostname;
      if (adapterForHost(host)?.id !== pending.request.provider) return { ok: true, compose: null };
      return { ok: true, compose: pending.request };
    }

    case "OFFERU_MAIL_COMPOSE_DONE":
      await deps.session.remove(composeKey(sender.tab!.id!));
      return { ok: true };

    case "OFFERU_MAIL_HANDOFF": {
      const host = new URL(sender.url!).hostname;
      const raw = message.message as Partial<HandoffMessage> | undefined;
      if (!raw || typeof raw.text !== "string" || typeof raw.subject !== "string") return { ok: false, error: "没读到这封邮件" };
      const item = normalizeHandoff({
        provider: adapterForHost(host)!.id,
        from: String(raw.from ?? ""),
        subject: raw.subject,
        date: String(raw.date ?? ""),
        text: raw.text,
        links: Array.isArray(raw.links) ? raw.links.map(String) : [],
        url: sender.url!,
      });
      if (!item.text && !item.subject) return { ok: false, error: "这封邮件是空的" };
      const inbox = ((await deps.session.get(INBOX_KEY)) as HandoffMessage[] | undefined) ?? [];
      await deps.session.set(INBOX_KEY, [...inbox, item].slice(-INBOX_LIMIT));

      const known = await deps.local.get(WEB_ORIGIN_KEY);
      const webOrigin = typeof known === "string" && isOfferUOrigin(known) ? known : OFFERU_WEB_ORIGINS[0];
      const tabs = (await deps.offeruTabs()).filter((tab) => {
        try { return new URL(tab.url).origin === webOrigin; } catch { return false; }
      });
      for (const tab of tabs) {
        if (await deps.notifyTab(tab.id, { type: "OFFERU_MAIL_INCOMING" })) {
          await deps.focusTab(tab.id);
          return { ok: true, delivered: "tab" };
        }
      }
      await deps.openTab(`${webOrigin}/`);
      return { ok: true, delivered: "opened" };
    }
  }
  return undefined;
}
