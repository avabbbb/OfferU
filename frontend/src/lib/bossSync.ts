import { request } from "@/lib/api";

export interface BossSync {
  installed: boolean;
  enabled: boolean;
  table_id: number | null;
  next_run_at: string | null;
  last_run_at: string | null;
  last_ok: boolean | null;
  last_message: string;
}

const BASE = "/api/applications/boss-sync";
export const getBossSync = () => request<BossSync>(BASE);
export const setBossSync = (enabled: boolean, tableId: number | null) =>
  request<BossSync>(BASE, { method: "PUT", body: JSON.stringify({ enabled, table_id: tableId }) });
export const runBossSync = () => request<BossSync>(`${BASE}/run`, { method: "POST" });
