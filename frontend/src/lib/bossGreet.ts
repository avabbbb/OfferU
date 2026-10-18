import { request } from "@/lib/api";

export interface BossJob {
  security_id: string;
  lid: string;
  encrypt_job_id: string;
  title: string;
  company: string;
  salary: string;
  city: string;
  score: number;
  hits: string[];
  misses: string[];
  greeted: boolean;
  picked: boolean;
}

export interface BossQuota {
  today: number;
  cap: number;
  left: number;
}

export interface BossSearch extends BossQuota {
  resume_title: string;
  has_more: boolean;
  items: BossJob[];
}

export interface BossGreetItem {
  encrypt_job_id: string;
  title: string;
  company: string;
  status: "waiting" | "sending" | "done" | "failed" | "skipped";
  message: string;
}

export interface BossGreet extends BossQuota {
  running: boolean;
  items: BossGreetItem[];
}

const BASE = "/api/applications/boss-greet";
export const getBossGreet = () => request<BossGreet>(BASE);
export const searchBossJobs = (keyword: string, city: string, page = 1) =>
  request<BossSearch>(`${BASE}/search`, { method: "POST", body: JSON.stringify({ keyword, city, page }) });
export const startBossGreet = (tableId: number, jobs: BossJob[]) =>
  request<BossGreet>(`${BASE}/start`, {
    method: "POST",
    body: JSON.stringify({
      table_id: tableId,
      jobs: jobs.map(({ security_id, lid, encrypt_job_id, title, company, salary, city }) => ({ security_id, lid, encrypt_job_id, title, company, salary, city })),
    }),
  });
