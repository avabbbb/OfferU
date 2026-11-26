import type { ComposeRequest, HandoffMessage, WebmailId } from "../contract.js";

/** 写信页里找到的字段；找不到的是 null，由填写流程退回「复制 + 提示」。 */
export interface ComposeFields {
  root: Document | Element;
  to: HTMLInputElement | HTMLTextAreaElement | null;
  cc: HTMLInputElement | HTMLTextAreaElement | null;
  subject: HTMLInputElement | null;
  body: HTMLElement | null;
  file: HTMLInputElement | null;
}

export type OpenMessage = Omit<HandoffMessage, "provider" | "url">;

/**
 * 一个邮箱网页的适配器。选择器都放在各自文件里，邮箱改版时只改这一个文件；
 * 每个都先试稳定属性（name / aria-label），再退回按标签文字找。
 */
export interface WebmailAdapter {
  id: WebmailId;
  label: string;
  hosts: string[];
  /** 打开写信页的地址（Gmail 直接带上收件人 / 标题 / 正文）。 */
  composeUrl(request: ComposeRequest): string;
  /** 页面上有写信表单就返回字段；还没有（在收件箱、没登录）返回 null。 */
  findCompose(doc: Document): ComposeFields | null;
  /** 点「写信」按钮打开写信页；只点写信，从不点发送。没找到按钮返回 false。 */
  openCompose(doc: Document): boolean;
  /** 当前打开的这一封邮件；不在读信页返回 null。 */
  readOpen(doc: Document): OpenMessage | null;
}

export function matchesHost(adapter: WebmailAdapter, hostname: string): boolean {
  const host = hostname.toLowerCase();
  return adapter.hosts.some((item) => host === item || host.endsWith(`.${item}`));
}
