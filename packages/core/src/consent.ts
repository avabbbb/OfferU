// Logged-in platform collection consent (port of core/consent.py). The record
// itself is a small local file kept by the host; this is the policy.

import { CoreError } from "./types";

export const CONSENT_VERSION = "2026-11-03";
export const CONSENT_TITLE = "登录态平台采集（BOSS 直聘、小红书）";
export const CONSENT_RISKS = [
  "要用你自己的账号登录后读取页面。平台用户协议一般不允许自动化采集；被平台判定为异常时，账号可能被限流、要求验证甚至封禁。",
  "OfferU 不绕过验证码、不改浏览器指纹、不破解接口签名、不换 IP，也不在后台批量翻页；遇到验证要你自己处理，处理不了就停。",
  "页面里可能有别人的信息（HR 姓名、帖子作者、评论）。存下来只用于你自己求职，不要转发或公开。",
  "授权浏览用一个独立的 Chrome 资料目录，放在 OfferU 数据目录下，会在本机保留这些平台的登录状态；撤回同意或删除该目录即可清掉。",
];
export const CONSENT_DUTIES: Record<string, string[]> = {
  "你负责": [
    "决定是否使用、用哪个账号，遵守平台规则和法律法规，承担由此产生的账号后果。",
    "只采集你本来就能看到、且确实用于自己求职的内容。",
  ],
  "OfferU 负责": [
    "只读取你打开的页面、你勾选的条目，不替你点投递、发消息或改资料；授权浏览进入只读后拦截一切非 GET 请求。",
    "存下的岗位只在本机；你让它评估时，JD 会发给你在设置里配置的模型服务。",
    "条款有实质变化时改版本号，旧的同意失效，要你重新确认。",
  ],
};
export const CONSENT_NOT_AGREED = "登录态采集还没开启：先到 设置 → 登录态采集 读完风险说明并点「同意并开启」";

export type ConsentRecord = { version?: unknown; agreed_at?: unknown };

export function consentStatus(record: ConsentRecord | null, version = CONSENT_VERSION): Record<string, unknown> {
  const rec = record && typeof record === "object" ? record : {};
  return {
    version,
    title: CONSENT_TITLE,
    risks: CONSENT_RISKS,
    duties: CONSENT_DUTIES,
    agreed: rec.version === version,
    agreed_version: rec.version ?? null,
    agreed_at: rec.agreed_at ?? null,
  };
}

/** The record to persist; a stale version is a conflict (Python returns 409). */
export function consentAgreement(version: unknown, agreedAt: string, current = CONSENT_VERSION): { version: string; agreed_at: string } {
  if (typeof version !== "string") throw new CoreError("version 要是字符串");
  if (version !== current) throw new CoreError(`条款已更新到 ${current}，请刷新后重新阅读再同意`, "conflict");
  return { version: current, agreed_at: agreedAt };
}

export function requireConsent(record: ConsentRecord | null): void {
  if (!consentStatus(record).agreed) throw new CoreError(CONSENT_NOT_AGREED, "forbidden");
}
