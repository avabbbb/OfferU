import { request } from "@/lib/api";

export interface BossLogin {
  installed: boolean;
  status: "idle" | "starting" | "waiting" | "scanned" | "ok" | "expired" | "error";
  message: string;
  qr: string | null;
  logged_in: boolean | null;
}

const BASE = "/api/applications/boss-login";
export const getBossLogin = () => request<BossLogin>(BASE);
export const bossLoginAction = (action: "start" | "cancel" | "logout") => request<BossLogin>(`${BASE}/${action}`, { method: "POST" });
