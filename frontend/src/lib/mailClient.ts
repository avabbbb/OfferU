// 设置 › 邮箱 和岗位详情的「确认发送」只通过这里连邮箱。
// 邮箱（IMAP / SMTP + 授权码）只在桌面版：账号存在本机伴侣的配置文件里，浏览器拿不到授权码；
// 网页版的 /api/mail/* 回 501 unsupported，界面改走浏览器插件（lib/local/extensionMail.ts）。读信、存草稿、发信走 mail 工具（lib/core.ts）。

import { request } from "@/lib/api";

export type MailServer = { host: string; port: number; secure: boolean };
export type MailProviderId = "qq" | "163" | "gmail" | "outlook" | "custom";

export type MailProvider = {
  id: MailProviderId;
  label: string;
  domains: string[];
  imap: MailServer | null;
  smtp: MailServer | null;
  secret: string;
  help: string | null;
  note: string;
  warning?: boolean;
};

export type MailAccountView = { provider: MailProviderId; address: string; imap: MailServer; smtp: MailServer };
export type MailStatusView = { connected: boolean; account: MailAccountView | null; providers: MailProvider[] };
export type MailCheck = { ok: boolean; error: string | null };
export type MailTestResult = { ok: boolean; imap: MailCheck; smtp: MailCheck };

export type MailForm = {
  provider: MailProviderId;
  address: string;
  password: string;
  imap: MailServer;
  smtp: MailServer;
};

/** 网页版 / 展示站：后端没有邮箱能力。 */
export function isMailUnsupported(cause: unknown): boolean {
  const error = cause as { status?: number; code?: string; message?: string };
  return error?.code === "unsupported" || error?.status === 501 || /仅桌面版|只在 OfferU 桌面版|展示/.test(String(error?.message ?? ""));
}

const post = <T>(path: string, body: unknown) => request<T>(path, { method: "POST", body: JSON.stringify(body) });

export const mailApi = {
  status: () => request<MailStatusView>("/api/mail/status"),
  /** form 不传就测已保存的账号。 */
  test: (form?: MailForm) => post<MailTestResult>("/api/mail/test", form ?? {}),
  /** 先登录 IMAP 和 SMTP，两边都通才保存。 */
  configure: (form: MailForm) => post<MailStatusView>("/api/mail/configure", form),
  disconnect: () => post<MailStatusView>("/api/mail/configure", { clear: true }),
};

/** 地址的域名对上预设就选它，否则「其他邮箱」。 */
export function providerFor(address: string, providers: MailProvider[]): MailProviderId {
  const domain = address.split("@")[1]?.toLowerCase() ?? "";
  return providers.find((item) => item.domains.includes(domain))?.id ?? "custom";
}
