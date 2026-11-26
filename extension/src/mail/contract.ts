// 网页版「邮箱 via 插件」的消息契约：OfferU 网页 ⇄ 插件内容脚本 ⇄ 插件后台 ⇄ 邮箱网页。
//
// 不用任何邮件 API / OAuth：插件只在用户已经登录的邮箱网页里填写写信页（收件人、主题、正文、附件），
// 发送永远由用户自己在邮箱里点；读信只在用户在一封已打开的邮件上点「交给 OfferU」时读这一封。
//
// 网页 → 桥（window.postMessage，source = "offeru-page"）
//   { type: "mail-hello", id }
//   { type: "mail-set-provider", id, provider }
//   { type: "mail-compose", id, compose: ComposeRequest }
//   { type: "mail-inbox-take", id }
// 桥 → 网页（source = "offeru-ext"）
//   { type: "mail-ready" }                                   桥装好时
//   { type: "mail-hello-ack", id, mail: MailCapabilities }
//   { type: "mail-set-provider-ack", id, ok, provider }
//   { type: "mail-compose-ack", id, ok, provider?, error? }
//   { type: "mail-inbox-ack", id, messages: HandoffMessage[] }
//   { type: "mail-incoming" }                                有新的「交给 OfferU」，网页再发 mail-inbox-take 取
// 前端镜像：frontend/src/lib/local/extensionMail.ts（改这里要一起改，契约测试两边各一份）。

export const MAIL_PROTOCOL = 1;

export type WebmailId = "gmail" | "qq" | "163";

export const WEBMAIL_PROVIDERS: ReadonlyArray<{ id: WebmailId; label: string }> = [
  { id: "gmail", label: "Gmail" },
  { id: "qq", label: "QQ 邮箱" },
  { id: "163", label: "网易 163 邮箱" },
];

export function isWebmailId(value: unknown): value is WebmailId {
  return value === "gmail" || value === "qq" || value === "163";
}

export interface MailCapabilities {
  protocol: number;
  version: string;
  providers: Array<{ id: WebmailId; label: string }>;
  /** 用户选过的默认邮箱；没选过是 null。 */
  provider: WebmailId | null;
  /** v1 只填写写信页 + 手动交出一封邮件；不读收件箱、不发送。 */
  compose: true;
  handoff: true;
}

export interface ComposeAttachment {
  name: string;
  type: string;
  /** 文件内容 base64（不带 data: 前缀）。 */
  base64: string;
}

export interface ComposeRequest {
  provider: WebmailId;
  to: string;
  cc: string[];
  subject: string;
  body: string;
  attachment: ComposeAttachment | null;
}

/** 一封「交给 OfferU」的邮件：只含用户点开的这一封的可见文字。 */
export interface HandoffMessage {
  provider: WebmailId;
  from: string;
  subject: string;
  date: string;
  text: string;
  links: string[];
  url: string;
}

/** 附件上限：插件会话存储 10 MB，base64 再膨胀 4/3。 */
export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
export const MAX_HANDOFF_TEXT = 8000;
export const MAX_HANDOFF_LINKS = 30;

const EMAIL_RE = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/;

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

/** 校验网页发来的写信请求；不合法给一句中文原因。 */
export function parseComposeRequest(raw: unknown): Parsed<ComposeRequest> {
  const data = raw as Partial<ComposeRequest> | null;
  if (!data || typeof data !== "object") return { ok: false, error: "写信请求是空的" };
  if (!isWebmailId(data.provider)) return { ok: false, error: "先选一个邮箱（Gmail / QQ / 163）" };
  const to = String(data.to ?? "").trim();
  if (!EMAIL_RE.test(to)) return { ok: false, error: "收件人邮箱不对" };
  const cc = Array.isArray(data.cc) ? data.cc.map((item) => String(item).trim()).filter(Boolean) : [];
  if (cc.some((item) => !EMAIL_RE.test(item))) return { ok: false, error: "抄送里有不对的邮箱" };
  const subject = String(data.subject ?? "").trim();
  if (!subject) return { ok: false, error: "标题是空的" };
  const body = String(data.body ?? "");
  let attachment: ComposeAttachment | null = null;
  if (data.attachment) {
    const att = data.attachment as Partial<ComposeAttachment>;
    const name = String(att.name ?? "").trim();
    const base64 = String(att.base64 ?? "");
    if (!name || !base64 || !/^[A-Za-z0-9+/]+=*$/.test(base64)) return { ok: false, error: "附件读不出来" };
    if (Math.floor((base64.length * 3) / 4) > MAX_ATTACHMENT_BYTES) return { ok: false, error: "附件超过 5 MB，请在邮箱里手动添加" };
    attachment = { name, type: String(att.type || "application/pdf"), base64 };
  }
  return { ok: true, value: { provider: data.provider, to, cc, subject, body, attachment } };
}

/** 交出的邮件：截断正文和链接，只留 http(s) 链接。 */
export function normalizeHandoff(raw: HandoffMessage): HandoffMessage {
  const links = [...new Set(raw.links.filter((link) => /^https?:\/\//i.test(link)))].slice(0, MAX_HANDOFF_LINKS);
  return {
    provider: raw.provider,
    from: raw.from.trim().slice(0, 300),
    subject: raw.subject.trim().slice(0, 300),
    date: raw.date.trim().slice(0, 100),
    text: raw.text.replace(/\n{3,}/g, "\n\n").trim().slice(0, MAX_HANDOFF_TEXT),
    links,
    url: raw.url,
  };
}

export function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
