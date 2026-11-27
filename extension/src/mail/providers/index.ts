import type { WebmailId } from "../contract.js";
import { gmailAdapter } from "./gmail.js";
import { neteaseAdapter } from "./netease.js";
import { qqAdapter } from "./qq.js";
import { matchesHost, type WebmailAdapter } from "./types.js";

export const WEBMAIL_ADAPTERS: readonly WebmailAdapter[] = [gmailAdapter, qqAdapter, neteaseAdapter];

export function adapterFor(id: WebmailId): WebmailAdapter {
  return WEBMAIL_ADAPTERS.find((adapter) => adapter.id === id)!;
}

export function adapterForHost(hostname: string): WebmailAdapter | null {
  return WEBMAIL_ADAPTERS.find((adapter) => matchesHost(adapter, hostname)) ?? null;
}

/** 内容脚本的 matches：只在这几个邮箱域名上运行。 */
export const WEBMAIL_MATCHES: readonly string[] = WEBMAIL_ADAPTERS.flatMap((adapter) => adapter.hosts.map((host) => `https://${host}/*`));

export type { ComposeFields, OpenMessage, WebmailAdapter } from "./types.js";
