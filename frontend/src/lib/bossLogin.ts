import { request } from "@/lib/api";

export interface BossLogin {
  installed: boolean;
  status: "idle" | "starting" | "waiting" | "scanned" | "ok" | "expired" | "error";
  message: string;
  qr: string | null;
  logged_in: boolean | null;
  /** sync：能同步投递/面试/沟通；search：能搜索、打招呼、补职位描述（要 __zp_stoken__，扫码登录拿不到）。 */
  capabilities: { sync: boolean; search: boolean };
}

const BASE = "/api/applications/boss-login";
export const getBossLogin = () => request<BossLogin>(BASE);
export const bossLoginAction = (action: "start" | "cancel" | "logout") => request<BossLogin>(`${BASE}/${action}`, { method: "POST" });
