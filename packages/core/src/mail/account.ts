// Mail account rules (desktop only: the companion keeps the account in a local 0600 file).
// Provider presets, input normalisation and the redacted view the settings page shows.
// The password (QQ / 163「授权码」, Gmail「应用专用密码」) never leaves the companion:
// mailAccountView drops it, the mail tool never returns it.

import { CoreError } from "../types";

/** secure = implicit TLS (993 / 465); false = plain connect + STARTTLS (587). */
export type MailServer = { host: string; port: number; secure: boolean };

export type MailProviderId = "qq" | "163" | "gmail" | "outlook" | "custom";

export type MailProvider = {
  id: MailProviderId;
  label: string;
  /** Domains that pick this preset from the address. */
  domains: string[];
  imap: MailServer | null;
  smtp: MailServer | null;
  /** What the password field holds for this provider. */
  secret: string;
  /** Official page on getting the auth code / app password (verified 2026-11-26). */
  help: string | null;
  /** One line under the form; warning = may not work at all. */
  note: string;
  warning?: boolean;
};

export const MAIL_PROVIDERS: MailProvider[] = [
  {
    id: "qq",
    label: "QQ 邮箱",
    domains: ["qq.com", "foxmail.com", "vip.qq.com"],
    imap: { host: "imap.qq.com", port: 993, secure: true },
    smtp: { host: "smtp.qq.com", port: 465, secure: true },
    secret: "授权码",
    help: "https://help.mail.qq.com/detail/0/1087",
    note: "先在 QQ 邮箱网页版 设置 › 账号与安全 开启 IMAP/SMTP 服务，再生成 16 位授权码。",
  },
  {
    id: "163",
    label: "网易 163 邮箱",
    domains: ["163.com"],
    imap: { host: "imap.163.com", port: 993, secure: true },
    smtp: { host: "smtp.163.com", port: 465, secure: true },
    secret: "授权码",
    help: "https://help.mail.163.com/faqDetail.do?code=d7a5dc8471cd0c0e8b4b8f4f8e49998b374173cfe9171305fa1ce630d7f67ac2a5feb28b66796d3b",
    note: "先在 163 网页版 设置 › POP3/SMTP/IMAP 开启 IMAP/SMTP，再新增授权密码。",
  },
  {
    id: "gmail",
    label: "Gmail",
    domains: ["gmail.com", "googlemail.com"],
    imap: { host: "imap.gmail.com", port: 993, secure: true },
    smtp: { host: "smtp.gmail.com", port: 465, secure: true },
    secret: "应用专用密码",
    help: "https://support.google.com/accounts/answer/185833?hl=zh-Hans",
    note: "要先开两步验证，再创建 16 位应用专用密码；国内网络可能连不上。",
  },
  {
    id: "outlook",
    label: "Outlook / Hotmail",
    domains: ["outlook.com", "hotmail.com", "live.com", "msn.com"],
    imap: { host: "outlook.office365.com", port: 993, secure: true },
    smtp: { host: "smtp-mail.outlook.com", port: 587, secure: false },
    secret: "密码或应用密码",
    help: "https://support.microsoft.com/zh-cn/office/outlook-com-%E7%9A%84-pop-imap-%E5%92%8C-smtp-%E8%AE%BE%E7%BD%AE-d088b986-291d-42b8-9564-9c414e2aa040",
    note: "微软已要求 Outlook.com 用 OAuth 登录，用密码连接多半会被拒绝，可能用不了。",
    warning: true,
  },
  {
    id: "custom",
    label: "其他邮箱",
    domains: [],
    imap: null,
    smtp: null,
    secret: "密码或授权码",
    help: null,
    note: "填你的邮箱服务商给的 IMAP / SMTP 地址和端口。",
  },
];

export type MailAccount = {
  provider: MailProviderId;
  address: string;
  password: string;
  imap: MailServer;
  smtp: MailServer;
};

export type MailAccountView = Omit<MailAccount, "password">;

const ADDRESS = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const HOST = /^[a-z0-9.-]+$/i;

export function mailProvider(id: unknown): MailProvider {
  const found = MAIL_PROVIDERS.find((item) => item.id === id);
  if (!found) throw new CoreError(`邮箱服务商只能是 ${MAIL_PROVIDERS.map((item) => item.id).join(" / ")}`);
  return found;
}

/** The preset an address belongs to (qq.com → qq); unknown domains → custom. */
export function providerForAddress(address: string): MailProviderId {
  const domain = address.split("@")[1]?.toLowerCase() ?? "";
  return MAIL_PROVIDERS.find((item) => item.domains.includes(domain))?.id ?? "custom";
}

function server(raw: unknown, preset: MailServer | null, what: string): MailServer {
  const value = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const host = typeof value.host === "string" && value.host.trim() ? value.host.trim() : preset?.host ?? "";
  const port = typeof value.port === "number" ? value.port : preset?.port;
  const secure = typeof value.secure === "boolean" ? value.secure : preset?.secure ?? port !== 587;
  if (!host || !HOST.test(host)) throw new CoreError(`${what} 服务器地址不对`);
  if (!port || !Number.isInteger(port) || port < 1 || port > 65535) throw new CoreError(`${what} 端口要是 1–65535 的整数`);
  return { host, port, secure };
}

/**
 * Settings form → account. Presets fill the servers (an explicit imap / smtp overrides them).
 * `previous` keeps the saved password when the form leaves it empty (editing hosts only).
 */
export function mailAccount(input: Record<string, unknown>, previous: MailAccount | null = null): MailAccount {
  const address = typeof input.address === "string" ? input.address.trim() : "";
  if (!ADDRESS.test(address)) throw new CoreError("邮箱地址不对");
  const provider = mailProvider(input.provider ?? providerForAddress(address));
  // 授权码 / 应用专用密码常被分组显示（「abcd efgh …」），去掉空格；自定义邮箱的密码只去首尾空白。
  const raw = typeof input.password === "string" ? input.password : "";
  const typed = provider.id === "custom" ? raw.trim() : raw.replace(/\s+/g, "");
  const password = typed || (previous && previous.address === address ? previous.password : "");
  if (!password) throw new CoreError(`要填${provider.secret}`);
  return {
    provider: provider.id,
    address,
    password,
    imap: server(input.imap, provider.imap, "IMAP"),
    smtp: server(input.smtp, provider.smtp, "SMTP"),
  };
}

export function mailAccountView(account: MailAccount | null): MailAccountView | null {
  if (!account) return null;
  const { password: _password, ...view } = account;
  return view;
}
