// =============================================
// Showcase REST 路由 — 模拟后端 REST 语义，数据落本地 IndexedDB
// =============================================
// api.ts 在 SHOWCASE 模式下把请求转发到这里。只覆盖展示站核心
// 页面所需端点；未覆盖的路径返回空结构（页面显示空态）。

import { readTable, writeTable, SHOWCASE, type TableName } from "./db";
import { seeds } from "./seed";
import {
  validateTriageUpdate,
  validateJobUpdate,
  validateReviewStage,
} from "./rules";

export { SHOWCASE };

type Job = {
  id: number;
  title: string;
  company: string;
  location: string;
  url: string;
  source: string;
  summary: string;
  keywords: string[];
  salary_min: number | null;
  salary_max: number | null;
  salary_text: string;
  education: string;
  experience: string;
  job_type: string;
  is_campus: boolean;
  triage_status: string;
  pool_id: number | null;
  posted_at: string | null;
  created_at: string;
};

type Pool = {
  id: number;
  name: string;
  scope: string;
  description?: string;
};

type Candidate = {
  candidate_id: string;
  status: string;
  suggested_stage: string;
  match_state: string;
  channel: string;
  sender: string;
  received_at: string;
  subject: string;
  snippet: string;
  suggested_attempt_id?: number;
};

type CalendarEvent = {
  id: number;
  title: string;
  event_type: string;
  start_time: string;
  end_time: string | null;
  description: string;
  location: string;
  related_job_id?: number;
};

let sequence = 1000;

function nextId(): number {
  sequence += 1;
  return sequence;
}

function parseUrl(url: string): URL {
  return new URL(url, "http://showcase.local");
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

async function withJobs(): Promise<Job[]> {
  return readTable<Job[]>("jobs", seeds.jobs as Job[]);
}

async function withPools(): Promise<Pool[]> {
  return readTable<Pool[]>("pools", seeds.pools as Pool[]);
}

async function withCandidates(): Promise<Candidate[]> {
  return readTable<Candidate[]>("progress_candidates", seeds.progress_candidates as Candidate[]);
}

async function withEvents(): Promise<CalendarEvent[]> {
  return readTable<CalendarEvent[]>("calendar_events", seeds.calendar_events as CalendarEvent[]);
}

// ---- /api/jobs ----

async function listJobs(url: URL): Promise<unknown> {
  const jobs = await withJobs();
  const status = url.searchParams.get("triage_status") || url.searchParams.get("status");
  const keyword = (url.searchParams.get("keyword") || "").trim().toLowerCase();
  const page = Math.max(1, Number(url.searchParams.get("page") || 1));
  const pageSize = Math.max(1, Number(url.searchParams.get("page_size") || 20));

  let filtered = jobs;
  if (status) {
    const normalized = status === "screened" ? "picked" : status === "unscreened" ? "inbox" : status;
    filtered = filtered.filter((j) => j.triage_status === normalized);
  }
  if (keyword) {
    filtered = filtered.filter(
      (j) =>
        j.title.toLowerCase().includes(keyword) ||
        j.company.toLowerCase().includes(keyword) ||
        j.location.toLowerCase().includes(keyword),
    );
  }
  const start = (page - 1) * pageSize;
  return {
    total: filtered.length,
    page,
    page_size: pageSize,
    items: filtered.slice(start, start + pageSize),
  };
}

async function getJob(url: URL): Promise<unknown> {
  const id = Number(url.pathname.split("/").filter(Boolean)[1]);
  const jobs = await withJobs();
  const job = jobs.find((j) => j.id === id);
  return job ?? { detail: "Job not found" };
}

async function jobsStats(): Promise<unknown> {
  const jobs = await withJobs();
  const distribution: Record<string, number> = {};
  for (const job of jobs) {
    distribution[job.source] = (distribution[job.source] || 0) + 1;
  }
  return { period: "week", total_jobs: jobs.length, source_distribution: distribution };
}

async function triageCounts(): Promise<unknown> {
  const jobs = await withJobs();
  const count = (status: string) => jobs.filter((j) => j.triage_status === status).length;
  return { unscreened: count("inbox"), screened: count("picked"), ignored: count("ignored"), inbox: count("inbox"), picked: count("picked") };
}

async function jobsTrend(): Promise<unknown> {
  const jobs = await withJobs();
  const byDay: Record<string, number> = {};
  for (const job of jobs) {
    const day = (job.created_at || "").slice(0, 10) || today();
    byDay[day] = (byDay[day] || 0) + 1;
  }
  return Object.entries(byDay)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([date, count]) => ({ date, count }));
}

async function weeklyReport(): Promise<unknown> {
  const jobs = await withJobs();
  return {
    this_week: { total: jobs.length },
    last_week: { total: 0 },
    source_distribution: Object.entries(
      jobs.reduce<Record<string, number>>((acc, job) => {
        acc[job.source] = (acc[job.source] || 0) + 1;
        return acc;
      }, {}),
    ).map(([name, value]) => ({ name, value })),
    top_keywords: [
      { keyword: "React", count: 3 },
      { keyword: "大模型", count: 2 },
      { keyword: "TypeScript", count: 2 },
    ],
  };
}

async function batchUpdateJobs(body: unknown): Promise<unknown> {
  const payload = body as {
    job_ids?: number[];
    triage_status?: string;
    pool_id?: number | null;
    clear_pool?: boolean;
  };
  const validation = validateTriageUpdate({
    job_ids: payload.job_ids,
    triage_status: payload.triage_status,
    pool_id: payload.pool_id,
    clear_pool: payload.clear_pool,
  });
  if (validation) return { error: validation.error };

  const jobIds = payload.job_ids || [];
  const jobs = await withJobs();
  if (payload.pool_id !== undefined && payload.pool_id !== null) {
    const pools = await withPools();
    const pool = pools.find((p) => p.id === payload.pool_id);
    if (!pool) return { error: "Pool not found" };
  }
  let updated = 0;
  for (const job of jobs) {
    if (!jobIds.includes(job.id)) continue;
    if (payload.triage_status) {
      job.triage_status = payload.triage_status;
      // 离开 picked 时清池；picked 且未指定池保留原池（对齐 Python 语义）
      if (payload.triage_status !== "picked") job.pool_id = null;
    }
    if (payload.pool_id !== undefined && payload.pool_id !== null) {
      job.pool_id = payload.pool_id;
      if (!payload.triage_status) job.triage_status = "picked";
    }
    if (payload.clear_pool) job.pool_id = null;
    updated += 1;
  }
  await writeTable("jobs", jobs);
  return { updated, requested: jobIds.length, pool_name: null };
}

async function updateJob(url: URL, body: unknown): Promise<unknown> {
  const id = Number(url.pathname.split("/").filter(Boolean)[1]);
  const payload = body as {
    triage_status?: string;
    pool_id?: number | null;
    clear_pool?: boolean;
  };
  const validation = validateJobUpdate({
    triage_status: payload.triage_status,
    pool_id: payload.pool_id,
    clear_pool: payload.clear_pool,
  });
  if (validation) return { error: validation.error };

  const jobs = await withJobs();
  const job = jobs.find((j) => j.id === id);
  if (!job) return { detail: "Job not found" };
  if (payload.pool_id !== undefined && payload.pool_id !== null) {
    const pools = await withPools();
    if (!pools.some((p) => p.id === payload.pool_id)) return { error: "Pool not found" };
  }
  if (payload.triage_status !== undefined) {
    job.triage_status = payload.triage_status;
    if (payload.triage_status !== "picked") job.pool_id = null;
  }
  if (payload.pool_id !== undefined && payload.pool_id !== null) {
    job.pool_id = payload.pool_id;
    if (!payload.triage_status) job.triage_status = "picked";
  }
  if (payload.clear_pool) job.pool_id = null;
  await writeTable("jobs", jobs);
  return job;
}

// ---- /api/pools ----

async function listPools(): Promise<unknown> {
  return withPools();
}

async function createPool(body: unknown): Promise<unknown> {
  const payload = body as { name?: string; scope?: string; description?: string };
  const pools = await withPools();
  const pool: Pool = {
    id: nextId(),
    name: payload.name || "新池",
    scope: payload.scope || "picked",
    description: payload.description,
  };
  pools.push(pool);
  await writeTable("pools", pools);
  return pool;
}

async function deletePool(url: URL): Promise<unknown> {
  const id = Number(url.pathname.split("/").filter(Boolean)[1]);
  const pools = await withPools();
  await writeTable("pools", pools.filter((p) => p.id !== id));
  const jobs = await withJobs();
  for (const job of jobs) {
    if (job.pool_id === id) job.pool_id = null;
  }
  await writeTable("jobs", jobs);
  return { deleted: 1 };
}

// ---- /api/profile ----

async function getProfile(): Promise<unknown> {
  return readTable("profile", seeds.profile);
}

// ---- /api/resume ----

async function listResumes(): Promise<unknown> {
  return readTable("resumes", seeds.resumes);
}

async function getResume(url: URL): Promise<unknown> {
  const id = Number(url.pathname.split("/").filter(Boolean)[1]);
  const resumes = (await readTable<unknown[]>("resumes", seeds.resumes as unknown[])) as Array<
    Record<string, unknown>
  >;
  return resumes.find((r) => r.id === id) ?? { detail: "Resume not found" };
}

// ---- /api/applications ----

async function getWorkspace(): Promise<unknown> {
  return readTable("workspace", seeds.workspace);
}

async function getTableRecords(url: URL): Promise<unknown> {
  const parts = url.pathname.split("/").filter(Boolean);
  const tableId = Number(parts[3]);
  const workspace = (await readTable("workspace", seeds.workspace)) as {
    tables: Array<{ id: number; name: string; is_total: boolean }>;
  };
  const table = workspace.tables.find((t) => t.id === tableId) || workspace.tables[0];
  const records = await readTable<Array<Record<string, unknown>>>(
    "app_records",
    seeds.app_records as Array<Record<string, unknown>>,
  );
  const keyword = url.searchParams.get("keyword") || "";
  const filtered = keyword
    ? records.filter((record) => {
        const values = (record.values || {}) as Record<string, unknown>;
        return Object.values(values).some((v) => String(v || "").includes(keyword));
      })
    : records;
  return { table, records: filtered };
}

async function updateRecord(url: URL, body: unknown): Promise<unknown> {
  const parts = url.pathname.split("/").filter(Boolean);
  const recordId = Number(parts[3]);
  const payload = body as { field_key?: string; value?: unknown };
  const records = await readTable<Array<Record<string, unknown>>>(
    "app_records",
    seeds.app_records as Array<Record<string, unknown>>,
  );
  const record = records.find((r) => r.id === recordId);
  if (!record) return { detail: "Record not found" };
  const values = (record.values || {}) as Record<string, unknown>;
  // 工作区 current_stage 是中文自由标签（待投递/已投递/面试中…），
  // 不做枚举迁移校验（对齐 Python：迁移校验属阶段事件流，不在此表）。
  if (payload.field_key) values[payload.field_key] = payload.value;
  record.values = values;
  record.updated_at = new Date().toISOString();
  await writeTable("app_records", records);
  return record;
}

// ---- /api/calendar ----

async function listEvents(url: URL): Promise<unknown> {
  const events = await withEvents();
  const start = url.searchParams.get("start");
  const end = url.searchParams.get("end");
  return events.filter((event) => {
    if (start && event.start_time < start) return false;
    if (end && event.start_time > end) return false;
    return true;
  });
}

async function createEvent(body: unknown): Promise<unknown> {
  const payload = body as Partial<CalendarEvent>;
  const events = await withEvents();
  const event: CalendarEvent = {
    id: nextId(),
    title: payload.title || "新事件",
    event_type: payload.event_type || "event",
    start_time: payload.start_time || new Date().toISOString(),
    end_time: payload.end_time ?? null,
    description: payload.description || "",
    location: payload.location || "",
    related_job_id: payload.related_job_id,
  };
  events.push(event);
  await writeTable("calendar_events", events);
  return event;
}

async function updateEvent(url: URL, body: unknown): Promise<unknown> {
  const id = Number(url.pathname.split("/").filter(Boolean)[2]);
  const payload = body as Partial<CalendarEvent>;
  const events = await withEvents();
  const event = events.find((e) => e.id === id);
  if (!event) return { detail: "Event not found" };
  Object.assign(event, payload);
  await writeTable("calendar_events", events);
  return event;
}

async function deleteEvent(url: URL): Promise<unknown> {
  const id = Number(url.pathname.split("/").filter(Boolean)[2]);
  const events = await withEvents();
  await writeTable("calendar_events", events.filter((e) => e.id !== id));
  return { deleted: 1 };
}

// ---- /api/email (progress candidates) ----

// 把种子候选映射为邮箱通知卡片（对齐 email 页 notification 字段契约）
async function listNotifications(): Promise<unknown> {
  const candidates = await withCandidates();
  return candidates.map((candidate, index) => {
    const stage = candidate.suggested_stage;
    const category = stage === "rejected" ? "rejected" : stage === "written_test" ? "written_test" : "interview";
    const companyMatch = /([^：:，, ]+)/.exec(candidate.subject || "")?.[1] || "招聘方";
    return {
      id: `notification_${index + 1}`,
      category,
      category_display:
        category === "rejected" ? "已拒绝" : category === "written_test" ? "笔试" : "面试",
      position: candidate.subject || "岗位进展通知",
      company: companyMatch,
      location: "",
      interview_time:
        candidate.received_at && category !== "rejected" ? candidate.received_at : null,
      action_required:
        candidate.status === "pending"
          ? `确认「${candidate.subject}」的进展（建议阶段：${stage}）`
          : "",
      email_from: candidate.sender,
      parsed_at: candidate.received_at,
    };
  });
}

async function listCandidates(url: URL): Promise<unknown> {
  const candidates = await withCandidates();
  const status = url.searchParams.get("status");
  const filtered = status && status !== "all" ? candidates.filter((c) => c.status === status) : candidates;
  return { total: filtered.length, items: filtered, disclosure: "summary" };
}

async function reviewCandidate(url: URL, body: unknown): Promise<unknown> {
  const candidateId = url.pathname.split("/").filter(Boolean)[2];
  const payload = body as { action?: string; stage?: string; note?: string };
  const candidates = await withCandidates();
  const candidate = candidates.find((c) => c.candidate_id === candidateId);
  if (!candidate) return { ok: false, errors: ["candidate not found"] };
  if (payload.action === "reject") {
    candidate.status = "rejected";
  } else if (payload.action === "accept") {
    // 接受候选进展必须选择合法枚举阶段（移植自 Python review_application_progress）
    const stage = String(payload.stage || candidate.suggested_stage || "");
    const violation = validateReviewStage(stage);
    if (violation) return { ok: false, errors: [violation.error] };
    candidate.status = "confirmed";
    candidate.match_state = "assigned";
  } else {
    return { ok: false, errors: ["action must be accept or reject"] };
  }
  await writeTable("progress_candidates", candidates);
  return { candidate_id: candidate.candidate_id, status: candidate.status, duplicate: false };
}

// ---- /api/agent ----

async function listAgentRuns(): Promise<unknown> {
  return readTable("agent_runs", seeds.agent_runs);
}

// ---- 入口 ----

export async function showcaseHandle(path: string, options?: RequestInit): Promise<unknown> {
  const url = parseUrl(path);
  const method = String((options?.method || "GET").toUpperCase());
  const bodyText = typeof options?.body === "string" ? options.body : null;
  const body = bodyText ? (JSON.parse(bodyText) as unknown) : null;
  const segments = url.pathname.split("/").filter(Boolean);

  if (segments[0] !== "api") return {};

  const [, resource, sub] = segments;
  const isNumericSub = sub !== undefined && /^\d+$/.test(sub);

  switch (resource) {
    case "jobs":
      if (method === "GET" && isNumericSub) return getJob(url);
      if (method === "GET" && sub === "stats") return jobsStats();
      if (method === "GET" && sub === "triage-counts") return triageCounts();
      if (method === "GET" && sub === "trend") return jobsTrend();
      if (method === "GET" && sub === "weekly-report") return weeklyReport();
      if (method === "GET") return listJobs(url);
      if (method === "PATCH" && sub === "batch-update") return batchUpdateJobs(body);
      if (method === "PATCH" && isNumericSub) return updateJob(url, body);
      return {};
    case "pools":
      if (method === "GET") return listPools();
      if (method === "POST") return createPool(body);
      if (method === "DELETE" && isNumericSub) return deletePool(url);
      return {};
    case "profile":
      if (method === "GET" && (sub === undefined || sub === "")) return getProfile();
      return {};
    case "resume":
      if (method === "GET" && isNumericSub) return getResume(url);
      if (method === "GET") return listResumes();
      return {};
    case "applications": {
      const subId = segments[3];
      const subIdNumeric = subId !== undefined && /^\d+$/.test(subId);
      if (method === "GET" && sub === "workspace") return getWorkspace();
      if (method === "GET" && sub === "tables" && subIdNumeric) return getTableRecords(url);
      if (method === "PATCH" && sub === "records" && subIdNumeric) return updateRecord(url, body);
      return {};
    }
    case "calendar":
      if (method === "GET" && sub === "events") return listEvents(url);
      if (method === "POST" && sub === "events") return createEvent(body);
      if (method === "PATCH" && sub === "events" && isNumericSub) return updateEvent(url, body);
      if (method === "DELETE" && sub === "events" && isNumericSub) return deleteEvent(url);
      return {};
    case "email":
      if (method === "GET" && sub === "progress-candidates") return listCandidates(url);
      if (method === "GET" && sub === "notifications") return listNotifications();
      if (method === "POST" && sub === "progress-candidates" && isNumericSub) return {};
      if (method === "POST" && segments[3] === "review") return reviewCandidate(url, body);
      return {};
    case "studio":
      if (method === "GET" && sub === "templates") {
        return [
          { id: 1, name: "modern-minimal", display_name: "现代简约", category: "professional", preview_image: "" },
          { id: 2, name: "creative-gradient", display_name: "创意渐变", category: "creative", preview_image: "" },
          { id: 3, name: "tech-dark", display_name: "技术暗黑", category: "technical", preview_image: "" },
        ];
      }
      return {};
    case "agent":
      if (
        method === "GET"
        && segments[1] === "agent"
        && segments[2] === "runtime"
        && segments[3] === "automation"
        && segments[4] === "inbox"
      ) return { items: [] };
      if (method === "GET" && sub === "runs") return listAgentRuns();
      return {};
    default:
      return {};
  }
}
