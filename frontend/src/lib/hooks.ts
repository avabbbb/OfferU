// =============================================
// SWR 数据请求 Hooks — OfferU 前端统一数据获取层
// =============================================
// 封装 SWR + API 客户端，提供类型安全的 React Hooks
// 所有页面组件通过这些 hooks 获取后端数据
// 自动缓存、重验证、错误处理
// =============================================

import useSWR from "swr";

const API_BASE =
  process.env.NEXT_PUBLIC_API_URL ||
  (typeof window !== "undefined"
    ? `${window.location.protocol}//${window.location.hostname}:8765`
    : "http://127.0.0.1:8765");

function formatBackendNetworkError(error: unknown) {
  const reason = error instanceof Error ? error.message : String(error);
  return `无法连接本地后端 ${API_BASE}，请确认后端服务已启动。配置 API Key 时浏览器只会请求本地后端，不会直接连接 DeepSeek。原始错误：${reason}`;
}

/**
 * 通用 fetcher：SWR 默认请求函数
 * 自动处理 JSON 解析和错误码
 */
const fetcher = async (url: string) => {
  let res: Response;
  try {
    res = await fetch(url);
  } catch (error) {
    throw new Error(formatBackendNetworkError(error));
  }
  if (!res.ok) throw new Error(`API ${res.status}`);
  return res.json();
};

// ---- 类型定义 ----

export interface Job {
  id: number;
  title: string;
  company: string;
  location: string;
  url: string;
  apply_url: string;
  source: string;
  raw_description: string;
  posted_at: string | null;
  summary: string;
  keywords: string[];
  salary_min: number | null;
  salary_max: number | null;
  salary_text: string;
  education: string;
  experience: string;
  job_type: string;
  company_size: string;
  company_industry: string;
  company_logo: string;
  is_campus: boolean;
  triage_status: "inbox" | "picked" | "ignored";
  pool_id: number | null;
  batch_id: string;
  created_at: string;
}

export interface Pool {
  id: number;
  name: string;
  scope: "inbox" | "picked" | "ignored";
  job_count: number;
  created_at: string;
  updated_at: string;
}

export interface BatchSummary {
  batch_id: string;
  source: string;
  keywords: string[];
  location: string;
  total: number;
  inbox_count: number;
  picked_count: number;
  ignored_count: number;
  latest_created_at: string | null;
}

export interface JobsListResponse {
  total: number;
  page: number;
  page_size: number;
  items: Job[];
}

export interface JobStats {
  period: string;
  total_jobs: number;
  source_distribution: Record<string, number>;
}

export interface CalendarEvent {
  id: number;
  title: string;
  description: string;
  event_type: string;
  start_time: string;
  end_time: string | null;
  location: string;
  related_job_id: number | null;
  related_notification_id: number | null;
}

export interface Notification {
  id: number;
  email_subject: string;
  email_from: string;
  company: string;
  position: string;
  category: string;
  category_display: string;
  interview_time: string | null;
  location: string;
  action_required: string;
  parsed_at: string;
}

// ---- Hooks ----

/**
 * 获取岗位列表
 * @param page 页码
 * @param period 时间范围: today / week / month
 * @param source 数据源筛选
 */
export interface JobFilters {
  page?: number;
  page_size?: number;
  period?: string;
  source?: string;
  keyword?: string;
  job_type?: string;
  education?: string;
  is_campus?: boolean;
  triage_status?: "inbox" | "picked" | "ignored";
  pool_id?: number | "ungrouped";
  batch_id?: string;
}

export function useJobs(filters: JobFilters = {}) {
  const params = new URLSearchParams();
  params.set("page", String(filters.page ?? 1));
  if (filters.page_size) params.set("page_size", String(filters.page_size));
  if (filters.period) params.set("period", filters.period);
  if (filters.source) params.set("source", filters.source);
  if (filters.keyword) params.set("keyword", filters.keyword);
  if (filters.job_type) params.set("job_type", filters.job_type);
  if (filters.education) params.set("education", filters.education);
  if (filters.is_campus !== undefined) params.set("is_campus", String(filters.is_campus));
  if (filters.triage_status) params.set("triage_status", filters.triage_status);
  if (filters.pool_id !== undefined) params.set("pool_id", String(filters.pool_id));
  if (filters.batch_id) params.set("batch_id", filters.batch_id);
  return useSWR<JobsListResponse>(
    `${API_BASE}/api/jobs/?${params}`,
    fetcher
  );
}

/** 获取批次汇总（Inbox 分区） */
export function useJobBatches(limit = 30) {
  return useSWR<BatchSummary[]>(`${API_BASE}/api/jobs/batches?limit=${limit}`, fetcher);
}

/** 获取岗位池列表 */
export function usePools(scope?: "all" | "inbox" | "picked" | "ignored") {
  const query = scope && scope !== "all" ? `?scope=${scope}` : "";
  return useSWR<Pool[]>(`${API_BASE}/api/pools/${query}`, fetcher);
}

/** 获取单个岗位详情 */
export function useJob(id: number | null) {
  return useSWR<Job>(
    id ? `${API_BASE}/api/jobs/${id}` : null,
    fetcher
  );
}

/** 获取岗位统计数据 */
export function useJobStats(period = "week") {
  return useSWR<JobStats>(
    `${API_BASE}/api/jobs/stats?period=${period}`,
    fetcher
  );
}

/** 获取每日趋势数据 */
export interface TrendPoint { date: string; count: number; }
export function useJobTrend(period = "week") {
  return useSWR<TrendPoint[]>(
    `${API_BASE}/api/jobs/trend?period=${period}`,
    fetcher
  );
}

/** 获取周报分析数据 */
export interface WeeklyReport {
  this_week: { total: number };
  last_week: { total: number };
  source_distribution: { name: string; value: number }[];
  top_keywords: { keyword: string; count: number }[];
}
export function useWeeklyReport() {
  return useSWR<WeeklyReport>(`${API_BASE}/api/jobs/weekly-report`, fetcher);
}

/** 获取日历事件 */
export function useCalendarEvents(start?: string, end?: string) {
  const params = new URLSearchParams();
  if (start) params.set("start", start);
  if (end) params.set("end", end);
  return useSWR<CalendarEvent[]>(
    `${API_BASE}/api/calendar/events?${params}`,
    fetcher
  );
}

/** 获取面试通知列表 */
export function useNotifications() {
  return useSWR<Notification[]>(
    `${API_BASE}/api/email/notifications`,
    fetcher
  );
}

/** 获取系统配置 */
export function useConfig() {
  return useSWR(
    `${API_BASE}/api/config/`,
    fetcher
  );
}

/** 更新单个岗位分拣状态/池归属 */
export async function patchJob(
  id: number,
  data: {
    triage_status?: "inbox" | "picked" | "ignored";
    pool_id?: number;
    clear_pool?: boolean;
  }
) {
  const res = await fetch(`${API_BASE}/api/jobs/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || `更新岗位失败 (${res.status})`);
  }
  return res.json();
}

/** 批量更新岗位分拣状态/池归属 */
export async function patchJobsBatch(data: {
  job_ids: number[];
  triage_status?: "inbox" | "picked" | "ignored";
  pool_id?: number;
  clear_pool?: boolean;
}) {
  const res = await fetch(`${API_BASE}/api/jobs/batch-update`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || `批量更新失败 (${res.status})`);
  }
  return res.json();
}

/** 批量彻底删除岗位（仅回收站内） */
export async function deleteJobsBatch(data: { job_ids: number[] }) {
  const res = await fetch(`${API_BASE}/api/jobs/batch-delete`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || `批量删除失败 (${res.status})`);
  }
  return res.json();
}

/** 创建岗位池 */
export async function createPool(name: string, scope: "inbox" | "picked" | "ignored" = "picked") {
  const res = await fetch(`${API_BASE}/api/pools/`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, scope }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || `创建池失败 (${res.status})`);
  }
  return res.json();
}

/** 重命名岗位池 */
export async function updatePoolName(poolId: number, name: string, scope?: "inbox" | "picked" | "ignored") {
  const query = scope ? `?scope=${scope}` : "";
  const res = await fetch(`${API_BASE}/api/pools/${poolId}${query}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || `重命名池失败 (${res.status})`);
  }
  return res.json();
}

/** 删除岗位池（池内岗位转为未分组） */
export async function deletePoolById(poolId: number, scope?: "inbox" | "picked" | "ignored") {
  const query = scope ? `?scope=${scope}` : "";
  const res = await fetch(`${API_BASE}/api/pools/${poolId}${query}`, {
    method: "DELETE",
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || `删除池失败 (${res.status})`);
  }
  return res.json();
}

// ---- 写操作（非 SWR，直接 fetch） ----

/** 更新系统配置 */
export async function updateConfig(data: any) {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}/api/config/`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
  } catch (error) {
    throw new Error(formatBackendNetworkError(error));
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || `更新配置失败 (${res.status})`);
  }
  return res.json();
}

/** 创建日历事件 */
export async function createCalendarEvent(data: any) {
  const res = await fetch(`${API_BASE}/api/calendar/events`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || `创建日历事件失败 (${res.status})`);
  }
  return res.json();
}

/** 触发邮件同步 */
export async function syncEmails() {
  const res = await fetch(`${API_BASE}/api/email/sync`, { method: "POST" });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || err.message || `邮件同步失败 (${res.status})`);
  }
  return res.json();
}

/** 获取 Gmail 授权链接 */
export async function getEmailAuthUrl(): Promise<{ auth_url?: string; message?: string }> {
  const res = await fetch(`${API_BASE}/api/email/auth-url`);
  return res.json();
}

/** 获取邮箱授权状态（双通道） */
export interface EmailStatus {
  connected: boolean;
  gmail_connected: boolean;
  has_refresh: boolean;
  imap_connected: boolean;
  imap_host: string;
  imap_user: string;
}
export function useEmailStatus() {
  return useSWR<EmailStatus>(`${API_BASE}/api/email/status`, fetcher);
}

/** IMAP 直连（QQ/163/Gmail 等） */
export async function imapConnect(data: {
  user: string;
  password: string;
  provider?: string;
  host?: string;
  port?: number;
}) {
  const res = await fetch(`${API_BASE}/api/email/imap-connect`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  return { ok: res.ok, data: await res.json() };
}

/** 自动补建日历事件 */
export async function autoFillCalendar() {
  const res = await fetch(`${API_BASE}/api/calendar/auto-fill`, { method: "POST" });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || `自动补建日历失败 (${res.status})`);
  }
  return res.json();
}

/** 创建简历 */
export async function createResume(data: any) {
  const res = await fetch(`${API_BASE}/api/resume/`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || `创建简历失败 (${res.status})`);
  }
  return res.json();
}

export interface ResumeSourceJob {
  id: number;
  title: string;
  company: string;
}

export interface ResumeBrief {
  id: number;
  user_name: string;
  title: string;
  photo_url: string;
  template_id: number | null;
  is_primary: boolean;
  language: string;
  source_mode: string;
  source_job_ids: number[];
  source_jobs: ResumeSourceJob[];
  source_profile_snapshot: Record<string, any>;
  created_at: string;
  updated_at: string;
}

export interface ResumeSectionBlock {
  id: number;
  resume_id: number;
  section_type: string;
  sort_order: number;
  title: string;
  visible: boolean;
  content_json: any[];
}

export interface ResumeDetail extends ResumeBrief {
  summary: string;
  contact_json: Record<string, any>;
  style_config: Record<string, any>;
  sections: ResumeSectionBlock[];
}

/** 更新简历主信息 */
export async function updateResume(id: number, data: any) {
  const res = await fetch(`${API_BASE}/api/resume/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || `更新简历失败 (${res.status})`);
  }
  return res.json();
}

/** 删除简历 */
export async function deleteResume(id: number) {
  const res = await fetch(`${API_BASE}/api/resume/${id}`, { method: "DELETE" });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || `删除简历失败 (${res.status})`);
  }
  return res.json();
}

/** 获取简历列表 */
export function useResumes() {
  return useSWR<ResumeBrief[]>(`${API_BASE}/api/resume/`, fetcher);
}

/** 获取完整简历详情（含段落） */
export function useResume(id: number | null) {
  return useSWR<ResumeDetail>(id ? `${API_BASE}/api/resume/${id}` : null, fetcher);
}

/** 更新段落 */
export async function updateSection(resumeId: number, sectionId: number, data: any) {
  const res = await fetch(`${API_BASE}/api/resume/${resumeId}/sections/${sectionId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || `更新段落失败 (${res.status})`);
  }
  return res.json();
}

/** 创建段落 */
export async function createSection(resumeId: number, data: any) {
  const res = await fetch(`${API_BASE}/api/resume/${resumeId}/sections`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || `创建段落失败 (${res.status})`);
  }
  return res.json();
}

/** 删除段落 */
export async function deleteSection(resumeId: number, sectionId: number) {
  const res = await fetch(`${API_BASE}/api/resume/${resumeId}/sections/${sectionId}`, {
    method: "DELETE",
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || `删除段落失败 (${res.status})`);
  }
  return res.json();
}

// ---- Profile 档案引导 ----

export type ProfileTopic =
  | "education"
  | "experience"
  | "project"
  | "activity"
  | "skill"
  | "general";

export interface ProfileTargetRole {
  id: number;
  profile_id: number;
  role_name: string;
  role_level: string;
  fit: "primary" | "secondary" | "adjacent";
  created_at: string;
}

export interface ProfileSection {
  id: number;
  profile_id: number;
  section_type: string;
  raw_section_type?: string;
  category_key?: string;
  category_label?: string;
  is_custom_category?: boolean;
  parent_id: number | null;
  title: string;
  sort_order: number;
  content_json: Record<string, any>;
  field_values?: Record<string, any>;
  normalized?: Record<string, any>;
  source: string;
  confidence: number;
  created_at: string;
  updated_at: string;
}

export interface ProfileCategoryOption {
  key: string;
  label: string;
  is_custom: boolean;
}

export interface ProfileCategoryList {
  builtin: ProfileCategoryOption[];
  custom: ProfileCategoryOption[];
  all: ProfileCategoryOption[];
}

export interface ProfileData {
  id: number;
  name: string;
  headline: string;
  exit_story: string;
  cross_cutting_advantage: string;
  base_info_json: Record<string, any>;
  is_default: boolean;
  created_at: string;
  updated_at: string;
  target_roles: ProfileTargetRole[];
  sections: ProfileSection[];
}

export interface ProfileBulletCandidate {
  index: number;
  session_id: number;
  section_type: string;
  title: string;
  content_json: Record<string, any>;
  confidence: number;
  source_pages?: number[];
  source_ref?: string;
}

export interface ProfileStreamEvent {
  event: string;
  data: any;
}

export interface ProfileChatSessionSummary {
  id: number;
  profile_id: number;
  topic: string;
  status: string;
  extracted_bullets_count: number;
  created_at: string;
  updated_at: string;
}

export interface ProfileSessionCandidate {
  section_type: string;
  title: string;
  content_json: Record<string, any>;
  confidence: number;
}

export interface ProfileChatSessionDetail extends ProfileChatSessionSummary {
  messages_json: any[];
  latest_candidates: ProfileSessionCandidate[];
}

export type ResumeImportParseMode = "ai" | "mechanical";

export interface ResumeParseDiagnostics {
  parser: string;
  page_count: number;
  used_ocr: boolean;
  average_quality: number;
  low_quality_pages: number[];
  warnings: string[];
  ocr?: {
    configured: boolean;
    language: string;
    fallback_english_configured: boolean;
    missing_languages: string[];
    install_hint?: string | null;
  };
  pages: Array<{
    page_number: number;
    method: "native" | "ocr" | "pypdf" | "docx" | string;
    char_count: number;
    quality_score: number;
    warnings: string[];
  }>;
}

export interface ProfileImportResult {
  session_id: number;
  agent_session_id?: number;
  filename: string;
  parse_mode?: ResumeImportParseMode;
  text_length: number;
  parse_diagnostics?: ResumeParseDiagnostics;
  base_info?: {
    name?: string;
    phone?: string;
    email?: string;
    linkedin?: string;
    github?: string;
    website?: string;
    current_city?: string;
    job_intention?: string;
    summary?: string;
    personal_summary?: string;
  };
  bullets: ProfileBulletCandidate[];
}

export function useProfile() {
  return useSWR<ProfileData>(`${API_BASE}/api/profile/`, fetcher);
}

export function useProfileCategories() {
  return useSWR<ProfileCategoryList>(`${API_BASE}/api/profile/categories`, fetcher);
}

export function useProfileChatSessions(limit = 20) {
  return useSWR<ProfileChatSessionSummary[]>(
    `${API_BASE}/api/profile/chat/sessions?limit=${limit}`,
    fetcher
  );
}

export function useProfileChatSessionDetail(sessionId: number | null) {
  return useSWR<ProfileChatSessionDetail>(
    sessionId ? `${API_BASE}/api/profile/chat/sessions/${sessionId}` : null,
    fetcher
  );
}

export async function updateProfileData(data: {
  name?: string;
  headline?: string;
  exit_story?: string;
  cross_cutting_advantage?: string;
  base_info_json?: Record<string, any>;
}) {
  const res = await fetch(`${API_BASE}/api/profile/`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || `更新档案失败 (${res.status})`);
  }
  return res.json() as Promise<ProfileData>;
}

export async function createProfileTargetRole(data: {
  role_name: string;
  role_level?: string;
  fit?: "primary" | "secondary" | "adjacent";
}) {
  const res = await fetch(`${API_BASE}/api/profile/target-roles`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || `新增目标岗位失败 (${res.status})`);
  }
  return res.json() as Promise<ProfileTargetRole>;
}

export async function deleteProfileTargetRole(roleId: number) {
  const res = await fetch(`${API_BASE}/api/profile/target-roles/${roleId}`, {
    method: "DELETE",
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || `删除目标岗位失败 (${res.status})`);
  }
  return res.json();
}

export async function createProfileSection(data: {
  section_type: string;
  category_label?: string;
  title?: string;
  sort_order?: number;
  content_json?: Record<string, any>;
  source?: string;
  confidence?: number;
}) {
  const res = await fetch(`${API_BASE}/api/profile/sections`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || `创建档案条目失败 (${res.status})`);
  }
  return res.json() as Promise<ProfileSection>;
}

export async function updateProfileSectionData(
  sectionId: number,
  data: {
    section_type?: string;
    category_label?: string;
    title?: string;
    sort_order?: number;
    content_json?: Record<string, any>;
    source?: string;
    confidence?: number;
  }
) {
  const res = await fetch(`${API_BASE}/api/profile/sections/${sectionId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || `更新档案条目失败 (${res.status})`);
  }
  return res.json() as Promise<ProfileSection>;
}

export async function deleteProfileSectionData(sectionId: number) {
  const res = await fetch(`${API_BASE}/api/profile/sections/${sectionId}`, {
    method: "DELETE",
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || `删除档案条目失败 (${res.status})`);
  }
  return res.json();
}

export async function streamProfileChat(
  payload: { topic: ProfileTopic; message: string; session_id?: number | null },
  options?: {
    signal?: AbortSignal;
    onEvent?: (event: ProfileStreamEvent) => void;
  }
) {
  const res = await fetch(`${API_BASE}/api/profile/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: options?.signal,
  });

  if (!res.ok || !res.body) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || `档案对话失败 (${res.status})`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";

  const findBoundary = (text: string) => {
    const unix = text.indexOf("\n\n");
    const windows = text.indexOf("\r\n\r\n");
    if (unix === -1) return windows;
    if (windows === -1) return unix;
    return Math.min(unix, windows);
  };

  const emit = (chunk: string) => {
    let eventName = "message";
    const dataLines: string[] = [];

    for (const line of chunk.split(/\r?\n/)) {
      if (line.startsWith("event:")) {
        eventName = line.slice(6).trim() || "message";
      } else if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).trim());
      }
    }

    if (dataLines.length === 0) return;
    const dataText = dataLines.join("\n");
    let data: any = dataText;
    try {
      data = JSON.parse(dataText);
    } catch {
      // keep raw text when server payload is non-json
    }
    options?.onEvent?.({ event: eventName, data });
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let boundary = findBoundary(buffer);
    while (boundary >= 0) {
      const separatorLength = buffer.slice(boundary, boundary + 4) === "\r\n\r\n" ? 4 : 2;
      const block = buffer.slice(0, boundary).trim();
      buffer = buffer.slice(boundary + separatorLength);
      if (block) emit(block);
      boundary = findBoundary(buffer);
    }
  }

  const tail = buffer.trim();
  if (tail) emit(tail);
}

export async function importProfileResume(file: File, parseMode: ResumeImportParseMode = "ai") {
  const formData = new FormData();
  formData.append("file", file);
  const params = new URLSearchParams({ parse_mode: parseMode });

  const res = await fetch(`${API_BASE}/api/profile/import-resume?${params.toString()}`, {
    method: "POST",
    body: formData,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || `导入简历失败 (${res.status})`);
  }
  return res.json() as Promise<ProfileImportResult>;
}

export async function confirmProfileCandidate(data: {
  session_id: number;
  bullet_index: number;
  edits?: Record<string, any>;
}) {
  const res = await fetch(`${API_BASE}/api/profile/chat/confirm`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || `确认条目失败 (${res.status})`);
  }
  return res.json() as Promise<ProfileSection>;
}

export async function generateProfileNarrative() {
  const res = await fetch(`${API_BASE}/api/profile/generate-narrative`, {
    method: "POST",
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || `生成叙事失败 (${res.status})`);
  }
  return res.json() as Promise<{
    headline: string;
    exit_story: string;
    cross_cutting_advantage: string;
  }>;
}

// ---- AI 简历优化 ----

/** AI 优化类型定义 */
export interface AiSuggestion {
  type: "bullet_rewrite" | "keyword_add" | "section_reorder";
  section_title?: string;
  item_label?: string;
  original: any;
  suggested: any;
  reason: string;
  // 前端追加的状态
  accepted?: boolean;
}

export interface AiOptimizeResult {
  keyword_match: {
    matched: string[];
    missing: string[];
    score: number;
  };
  suggestions: AiSuggestion[];
  summary: string;
}

/** AI 优化简历（基于已有简历 ID） */
export async function aiOptimizeResume(
  resumeId: number,
  data: { jd_text?: string; job_id?: number }
): Promise<AiOptimizeResult> {
  const res = await fetch(`${API_BASE}/api/resume/${resumeId}/ai/optimize`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || `AI 优化失败 (${res.status})`);
  }
  return res.json();
}

/** AI 优化简历（纯文本粘贴） */
export async function aiOptimizeText(
  data: { resume_text: string; jd_text: string }
): Promise<AiOptimizeResult> {
  const res = await fetch(`${API_BASE}/api/resume/ai/optimize-text`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || `AI 优化失败 (${res.status})`);
  }
  return res.json();
}

/** 应用单条 AI 建议到简历 */
export async function aiApplySuggestion(
  resumeId: number,
  suggestion: any
) {
  const res = await fetch(`${API_BASE}/api/resume/${resumeId}/ai/apply`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(suggestion),
  });
  return res.json();
}

/** 批量应用已采纳的 AI 建议（一键应用） */
export async function aiApplyBatch(
  resumeId: number,
  payload: {
    suggestions: RewriteSuggestion[];
    reorder?: { suggested_order: string[] };
  }
) {
  const res = await fetch(`${API_BASE}/api/resume/${resumeId}/ai/apply-batch`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || "批量应用失败");
  }
  return res.json();
}

/** 上传 PDF/Word 简历文件并解析为文本 */
export async function parseResumeFile(file: File): Promise<{ filename: string; text: string; length: number }> {
  const formData = new FormData();
  formData.append("file", file);
  const res = await fetch(`${API_BASE}/api/resume/parse`, {
    method: "POST",
    body: formData,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || `文件解析失败 (${res.status})`);
  }
  return res.json();
}

/** 段落排序 */
export async function reorderSections(resumeId: number, items: { id: number; sort_order: number }[]) {
  const res = await fetch(`${API_BASE}/api/resume/${resumeId}/sections/reorder`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ items }),
  });
  return res.json();
}

/** 上传头像 */
export async function uploadResumePhoto(resumeId: number, file: File) {
  const formData = new FormData();
  formData.append("file", file);
  const res = await fetch(`${API_BASE}/api/resume/${resumeId}/photo`, {
    method: "POST",
    body: formData,
  });
  return res.json();
}

/** 上传大学校徽 */
export async function uploadResumeLogo(resumeId: number, file: File) {
  const formData = new FormData();
  formData.append("file", file);
  const res = await fetch(`${API_BASE}/api/resume/${resumeId}/logo`, {
    method: "POST",
    body: formData,
  });
  return res.json();
}

/** 根据学校名称联网获取大学校徽 */
export async function resolveResumeLogo(resumeId: number, schoolName: string) {
  const res = await fetch(`${API_BASE}/api/resume/${resumeId}/logo/resolve`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ school_name: schoolName }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(text || `Logo resolve failed with ${res.status}`);
  }
  return res.json();
}

export interface ResumeTemplate {
  id: number;
  name: string;
  thumbnail_url: string;
  css_variables: Record<string, string>;
  is_builtin: boolean;
}

/** 获取模板列表 */
export function useResumeTemplates() {
  return useSWR<ResumeTemplate[]>(`${API_BASE}/api/resume/templates`, fetcher);
}

// ---- AI Skill Pipeline 深度分析 ----

/** JD 分析结果（Skill 1 输出） */
export interface JdAnalysis {
  job_title: string;
  company: string;
  is_campus: boolean;
  required_skills: string[];
  preferred_skills: string[];
  responsibilities: string[];
  experience_level: string;
  industry_tags: string[];
  culture_keywords: string[];
}

/** 段落评分明细 */
export interface SectionScore {
  section: string;
  score: number;
  feedback: string;
}

/** 匹配分析结果（Skill 2 输出） */
export interface MatchAnalysis {
  ats_score: number;
  matched_skills: string[];
  missing_skills: string[];
  section_scores: SectionScore[];
  risk_items: string[];
  summary: string;
}

/** Pipeline 聚合结果 */
export interface SkillAnalyzeResult {
  jd_analysis: JdAnalysis;
  match_analysis: MatchAnalysis;
  content_rewrite?: ContentRewriteResult;
  section_reorder?: SectionReorderResult;
}

/** 内容改写建议（Skill 3 输出） */
export interface RewriteSuggestion {
  type: "rewrite" | "inject";
  section_title: string;
  item_label: string;
  original: string;
  suggested: string;
  reason: string;
  injected_keywords: string[];
}

export interface ContentRewriteResult {
  suggestions: RewriteSuggestion[];
}

/** 模块重排建议（Skill 4 输出） */
export interface ReorderChange {
  section: string;
  action: "move_up" | "move_down" | "keep";
  reason: string;
}

export interface SectionReorderResult {
  current_order: string[];
  suggested_order: string[];
  reason: string;
  changes: ReorderChange[];
  error?: string;
}

/** Skill Pipeline 深度分析（基于已有简历 ID） */
export async function aiAnalyzeResume(
  resumeId: number,
  data: { jd_text?: string; job_id?: number }
): Promise<SkillAnalyzeResult> {
  const res = await fetch(`${API_BASE}/api/resume/${resumeId}/ai/analyze`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || `AI 分析失败 (${res.status})`);
  }
  return res.json();
}

/** Skill Pipeline 深度分析（纯文本粘贴） */
export async function aiAnalyzeText(
  data: { resume_text: string; jd_text: string }
): Promise<SkillAnalyzeResult> {
  const res = await fetch(`${API_BASE}/api/resume/ai/analyze-text`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || `AI 分析失败 (${res.status})`);
  }
  return res.json();
}

// ---- 投递管理 ----

export interface ApplicationItem {
  id: number;
  job_id: number;
  job_title: string;
  job_company: string;
  status: string;
  cover_letter: string;
  apply_url: string;
  notes: string;
  submitted_at: string | null;
  created_at: string;
}

export interface ApplicationsResponse {
  total: number;
  page: number;
  page_size: number;
  items: ApplicationItem[];
}

/** 获取投递记录列表 */
export function useApplications(page = 1, status?: string) {
  const params = new URLSearchParams({ page: String(page) });
  if (status) params.set("status", status);
  return useSWR<ApplicationsResponse>(
    `${API_BASE}/api/applications/?${params}`, fetcher
  );
}

/** 获取投递统计 */
export function useApplicationStats() {
  return useSWR<Record<string, number>>(
    `${API_BASE}/api/applications/stats`, fetcher
  );
}

/** 创建投递记录 */
export async function createApplication(jobId: number, notes = "") {
  const res = await fetch(`${API_BASE}/api/applications/auto-write`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ job_id: jobId, notes }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || `创建投递记录失败 (${res.status})`);
  }
  return res.json();
}

/** 更新投递状态 */
export async function updateApplication(id: number, data: { status?: string; notes?: string; cover_letter?: string }) {
  const res = await fetch(`${API_BASE}/api/applications/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  return res.json();
}

/** AI 生成求职信 */
export async function generateCoverLetter(jobId: number, resumeId: number) {
  const res = await fetch(`${API_BASE}/api/applications/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ job_id: jobId, resume_id: resumeId }),
  });
  return res.json();
}

export type ApplicationFieldType =
  | "text"
  | "long_text"
  | "single_select"
  | "multi_select"
  | "date"
  | "datetime"
  | "number"
  | "boolean"
  | "link";

export interface ApplicationFieldSchema {
  field_key: string;
  label: string;
  type: ApplicationFieldType;
  fixed: boolean;
  visible: boolean;
  width: number;
  options: string[];
  order: number;
}

export interface ApplicationWorkspaceTable {
  id: number;
  name: string;
  is_total: boolean;
  record_count: number;
  schema: ApplicationFieldSchema[];
  created_at: string;
  updated_at: string;
}

export interface ApplicationWorkspaceSettings {
  auto_row_height: boolean;
  auto_column_width: boolean;
  delete_subtable_sync_total_default: boolean;
  updated_at: string;
}

export interface ApplicationWorkspacePayload {
  tables: ApplicationWorkspaceTable[];
  current_table_id: number;
  settings: ApplicationWorkspaceSettings;
  template_schema: ApplicationFieldSchema[];
  stats: {
    total_records: number;
    duplicate_records: number;
  };
}

export interface ApplicationTableRecordItem {
  id: number;
  values: Record<string, any>;
  is_duplicate: boolean;
  duplicate_group: string;
  created_at: string;
  updated_at: string;
}

export interface ApplicationTableRecordsPayload {
  table: ApplicationWorkspaceTable;
  records: ApplicationTableRecordItem[];
}

export function useApplicationWorkspace() {
  return useSWR<ApplicationWorkspacePayload>(`${API_BASE}/api/applications/workspace`, fetcher);
}

export function useApplicationTableRecords(tableId: number | null, keyword = "") {
  const params = new URLSearchParams();
  if (keyword.trim()) params.set("keyword", keyword.trim());
  return useSWR<ApplicationTableRecordsPayload>(
    tableId ? `${API_BASE}/api/applications/tables/${tableId}/records?${params}` : null,
    fetcher
  );
}

export function useApplicationTemplate() {
  return useSWR<{ schema: ApplicationFieldSchema[] }>(`${API_BASE}/api/applications/template`, fetcher);
}

export function useApplicationSettings() {
  return useSWR<ApplicationWorkspaceSettings>(`${API_BASE}/api/applications/settings`, fetcher);
}

export async function createApplicationTable(name: string) {
  const res = await fetch(`${API_BASE}/api/applications/tables`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || `创建表失败 (${res.status})`);
  }
  return res.json();
}

export async function renameApplicationTable(tableId: number, name: string) {
  const res = await fetch(`${API_BASE}/api/applications/tables/${tableId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || `重命名表失败 (${res.status})`);
  }
  return res.json();
}

export async function deleteApplicationTable(tableId: number) {
  const res = await fetch(`${API_BASE}/api/applications/tables/${tableId}`, {
    method: "DELETE",
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || `删除表失败 (${res.status})`);
  }
  return res.json();
}

export async function importJobsToApplicationTable(tableId: number, jobIds: number[]) {
  const res = await fetch(`${API_BASE}/api/applications/tables/${tableId}/import-jobs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ job_ids: jobIds }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || `快捷导入失败 (${res.status})`);
  }
  return res.json();
}

export async function importLatestExtensionBatchToApplicationTable(
  tableId: number,
  options: {
    batch_id?: string;
    source?: string;
    limit?: number;
    skip_existing?: boolean;
  } = {}
) {
  const res = await fetch(`${API_BASE}/api/applications/tables/${tableId}/import-latest-extension-batch`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(options),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || `导入最近插件同步失败 (${res.status})`);
  }
  return res.json();
}

export async function createApplicationRecord(tableId: number, values: Record<string, any>, jobRefId?: number) {
  const res = await fetch(`${API_BASE}/api/applications/records`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ table_id: tableId, values, job_ref_id: jobRefId }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || `新增记录失败 (${res.status})`);
  }
  return res.json();
}

function toSerializableApplicationValue(value: any, seen = new WeakSet<object>()): any {
  if (value == null) return value;

  const primitiveType = typeof value;
  if (primitiveType === "string" || primitiveType === "number" || primitiveType === "boolean") {
    return value;
  }
  if (primitiveType === "undefined") {
    return null;
  }
  if (primitiveType === "bigint" || primitiveType === "symbol" || primitiveType === "function") {
    return String(value);
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (typeof value === "object") {
    const target = (value as any)?.target ?? (value as any)?.currentTarget;
    if (target && typeof target === "object" && "value" in target) {
      return toSerializableApplicationValue((target as any).value, seen);
    }

    if (typeof Node !== "undefined" && value instanceof Node) {
      return (value as any).value ?? (value as any).textContent ?? "";
    }

    if (seen.has(value)) {
      return null;
    }
    seen.add(value);

    if (Array.isArray(value)) {
      return value.map((item) => toSerializableApplicationValue(item, seen));
    }

    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
      if (typeof (value as any).toJSON === "function") {
        return toSerializableApplicationValue((value as any).toJSON(), seen);
      }
      return String(value);
    }

    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = toSerializableApplicationValue(v, seen);
    }
    return out;
  }

  return String(value);
}

export async function updateApplicationRecordCell(recordId: number, fieldKey: string, value: any) {
  const normalizedValue = toSerializableApplicationValue(value);
  const res = await fetch(`${API_BASE}/api/applications/records/${recordId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ field_key: fieldKey, value: normalizedValue }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || `更新记录失败 (${res.status})`);
  }
  return res.json();
}

export async function moveApplicationRecords(sourceTableId: number, targetTableId: number, recordIds: number[]) {
  const res = await fetch(`${API_BASE}/api/applications/records/move`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      source_table_id: sourceTableId,
      target_table_id: targetTableId,
      record_ids: recordIds,
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || `批量移动失败 (${res.status})`);
  }
  return res.json();
}

export async function deleteApplicationRecords(tableId: number, recordIds: number[], deleteFromTotal = false) {
  const res = await fetch(`${API_BASE}/api/applications/records/delete`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      table_id: tableId,
      record_ids: recordIds,
      delete_from_total: deleteFromTotal,
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || `批量删除失败 (${res.status})`);
  }
  return res.json();
}

export async function updateApplicationTableSchema(tableId: number, schema: ApplicationFieldSchema[]) {
  const res = await fetch(`${API_BASE}/api/applications/tables/${tableId}/schema`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ schema }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || `更新表结构失败 (${res.status})`);
  }
  return res.json();
}

export async function updateApplicationTemplate(
  schema: ApplicationFieldSchema[],
  purgeNonTemplateFields = false
) {
  const res = await fetch(`${API_BASE}/api/applications/template`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ schema, purge_non_template_fields: purgeNonTemplateFields }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || `更新默认模板失败 (${res.status})`);
  }
  return res.json();
}

export async function applyApplicationTemplateToAll(purgeNonTemplateFields = false) {
  const res = await fetch(`${API_BASE}/api/applications/template/apply-to-all`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ purge_non_template_fields: purgeNonTemplateFields }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || `覆盖全部表结构失败 (${res.status})`);
  }
  return res.json();
}

export async function updateApplicationWorkspaceSettings(data: {
  auto_row_height?: boolean;
  auto_column_width?: boolean;
  delete_subtable_sync_total_default?: boolean;
}) {
  const res = await fetch(`${API_BASE}/api/applications/settings`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || `更新投递设置失败 (${res.status})`);
  }
  return res.json();
}

// ---- 简历模板 ----

/** 将模板应用到简历（覆盖 style_config） */
export async function applyTemplate(resumeId: number, templateId: number) {
  const res = await fetch(`${API_BASE}/api/resume/${resumeId}/apply-template/${templateId}`, {
    method: "POST",
  });
  if (!res.ok) throw new Error(`Apply template failed: ${res.status}`);
  return res.json();
}

// ---- 爬虫管理 ----

export interface ScraperSource {
  key: string;
  name: string;
  status: string;  // "ready" | "skeleton" | "planned"
  description: string;
  registered: boolean;
}

export interface ScraperTask {
  id: string;
  source: string;
  keywords: string[];
  location: string;
  status: string;  // "running" | "completed" | "failed"
  created_at: string;
  result: {
    created?: number;
    skipped?: number;
    total?: number;
    error?: string;
    warning?: string;
    batch_id?: string;
    pool_id?: number | null;
    pool_name?: string;
  } | null;
}

/** 获取所有数据源状态 */
export function useScraperSources() {
  return useSWR<ScraperSource[]>(`${API_BASE}/api/scraper/sources`, fetcher);
}

/** 获取爬取任务列表 */
export function useScraperTasks() {
  return useSWR<ScraperTask[]>(`${API_BASE}/api/scraper/tasks`, fetcher, {
    refreshInterval: 3000,  // 运行中自动刷新
  });
}

/** 触发爬取任务 */
export async function runScraper(source: string, keywords: string[], location = "", maxResults = 50) {
  const res = await fetch(`${API_BASE}/api/scraper/run`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ source, keywords, location, max_results: maxResults }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || "启动爬取失败");
  }
  return res.json();
}

// ---- BOSS直聘 Cookie 管理 ----

export interface BossStatus {
  configured: boolean;
  has_wt2: boolean;
  has_zp_token: boolean;
  message: string;
}

/** 获取 BOSS直聘 Cookie 配置状态 */
export function useBossStatus() {
  return useSWR<BossStatus>(`${API_BASE}/api/config/boss-status`, fetcher);
}

/** 保存 BOSS Cookie 到后端配置（先读取当前配置再合并，避免覆盖其他字段） */
export async function saveBossCookie(cookie: string) {
  // 先拿当前完整配置
  const current = await fetcher(`${API_BASE}/api/config/`);
  // 合并 boss_cookie，其余字段原值回传
  const res = await fetch(`${API_BASE}/api/config/`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...current, boss_cookie: cookie }),
  });
  if (!res.ok) throw new Error("保存 Cookie 失败");
  return res.json();
}

// ---- 批量 AI 简历定制 (SSE 流式) ----

export interface BatchOptimizeEntry {
  job_id: number;
  job_title: string;
  company: string;
  new_resume_id: number | null;
  ats_score: number | null;
  suggestions_applied: number;
  status: "success" | "skipped" | "failed" | "pending" | "review_required";
  error: string | null;
  index: number;
  total: number;
}

export interface BatchOptimizeResponse {
  total: number;
  success: number;
  results: BatchOptimizeEntry[];
}

/**
 * 批量 AI 简历定制 — SSE 流式版本
 * 通过 onProgress 回调实时接收每个岗位的处理结果
 */
export async function batchOptimizeResume(
  resumeId: number,
  jobIds: number[],
  autoApply = false,
  onProgress?: (entry: BatchOptimizeEntry) => void,
  signal?: AbortSignal
): Promise<BatchOptimizeResponse> {
  const res = await fetch(`${API_BASE}/api/resume/${resumeId}/ai/batch-optimize`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ job_ids: jobIds, auto_apply: autoApply }),
    signal,
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || `批量优化失败 (${res.status})`);
  }

  // 解析 SSE 流
  const reader = res.body?.getReader();
  if (!reader) throw new Error("浏览器不支持流式响应");

  const decoder = new TextDecoder();
  let buffer = "";
  let finalResult: BatchOptimizeResponse | null = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    // 按双换行分割 SSE 事件
    const parts = buffer.split("\n\n");
    buffer = parts.pop() || "";

    for (const part of parts) {
      const lines = part.trim().split("\n");
      let eventType = "";
      let data = "";

      for (const line of lines) {
        if (line.startsWith("event: ")) eventType = line.slice(7);
        else if (line.startsWith("data: ")) data = line.slice(6);
      }

      if (!data) continue;

      try {
        const parsed = JSON.parse(data);
        if (eventType === "progress" && onProgress) {
          onProgress(parsed as BatchOptimizeEntry);
        } else if (eventType === "done") {
          finalResult = parsed as BatchOptimizeResponse;
        }
      } catch {
        // 跳过无法解析的行
      }
    }
  }

  return finalResult || { total: jobIds.length, success: 0, results: [] };
}

// ---- Optimize 工作区（Profile -> JD 生成）----

export interface OptimizeGenerateRequest {
  job_ids: number[];
  mode: "per_job" | "combined";
  reference_resume_id?: number;
}

export interface OptimizeGenerateResult {
  mode: "per_job";
  proposal_id: string;
  proposal_status: string;
  fact_gate_status: string;
  change_count: number;
  reference_resume_id?: number | null;
  job_id: number;
  job_title: string;
  company: string;
  index?: number;
  total?: number;
}

export interface OptimizeProgressEvent {
  index: number;
  total: number;
  status: "prepared" | "failed";
  job_id?: number;
  job_title?: string;
  mode?: "per_job" | "combined";
}

export interface OptimizeDoneEvent {
  mode: "per_job";
  total: number;
  prepared: number;
  failed: number;
  proposal_ids: string[];
}

export interface OptimizeStreamEvent {
  event: string;
  data: any;
}

// =============================================
// Optimize Agent Chat Stream
// =============================================

export interface OptimizeAgentStreamEvent {
  /** token-level streaming event */
  token?: string;
  /** progress events from skill pipeline */
  progress?: string;
  label?: string;
  /** error event */
  error?: string;
  message?: string;
  /** done event */
  done?: boolean;
  /** final response event */
  assistant_message?: string;
  suggestions?: any[];
  resume_id?: number;
  resume_title?: string;
  proposal_id?: string;
  proposal_status?: string;
  /** confirm request event — agent asks user to approve a tool call */
  confirm_request?: {
    tool: string;
    args: Record<string, any>;
    summary: string;
  };
  /** section confirmed event */
  section_confirmed?: {
    section_index: number;
    section_title: string;
    all_confirmed: boolean;
  };
  /** common fields */
  phase?: string;
  session_id?: string;
}

export async function streamOptimizeAgentChat(
  payload: { session_id: string; message: string; action?: string; feedback?: string },
  options?: {
    signal?: AbortSignal;
    onEvent?: (event: OptimizeAgentStreamEvent) => void;
  }
) {
  const res = await fetch(`${API_BASE}/api/optimize/agent/chat/stream`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: options?.signal,
  });

  if (!res.ok || !res.body) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || `请求失败 (${res.status})`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";

  const findBoundary = (text: string) => {
    const unix = text.indexOf("\n\n");
    const windows = text.indexOf("\r\n\r\n");
    if (unix === -1) return windows;
    if (windows === -1) return unix;
    return Math.min(unix, windows);
  };

  const emit = (chunk: string) => {
    const dataLines: string[] = [];
    for (const line of chunk.split(/\r?\n/)) {
      if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).trim());
      }
    }
    if (dataLines.length === 0) return;
    const dataText = dataLines.join("\n");
    try {
      const raw = JSON.parse(dataText);
      const eventType = raw.event as string | undefined;

      // Transform backend SSE format {"event": "type", ...data} → frontend OptimizeAgentStreamEvent
      const transformed: OptimizeAgentStreamEvent = {};

      switch (eventType) {
        case "thinking":
          transformed.progress = "thinking";
          transformed.label = "AI 正在思考...";
          break;
        case "assistant_message":
          transformed.assistant_message = raw.content;
          if (raw.suggestions) transformed.suggestions = raw.suggestions;
          if (raw.resume_id) transformed.resume_id = raw.resume_id;
          if (raw.proposal_id) transformed.proposal_id = raw.proposal_id;
          break;
        case "phase":
          transformed.phase = raw.phase;
          if (raw.session_id) transformed.session_id = raw.session_id;
          break;
        case "error":
          transformed.error = raw.message;
          transformed.message = raw.message;
          break;
        case "confirm_request":
          transformed.confirm_request = {
            tool: raw.tool,
            args: raw.args,
            summary: raw.summary,
          };
          break;
        case "tool_call":
          transformed.progress = "tool_call";
          transformed.label = raw.status === "executing"
            ? `执行 ${raw.tool}...`
            : `${raw.tool} 完成`;
          break;
        case "resume_generated":
          transformed.resume_id = raw.resume_id;
          transformed.resume_title = raw.resume_title;
          break;
        case "resume_proposal_prepared":
          transformed.proposal_id = raw.proposal_id;
          transformed.proposal_status = raw.status;
          break;
        case "section_confirmed":
          transformed.section_confirmed = {
            section_index: raw.section_index,
            section_title: raw.section_title,
            all_confirmed: raw.all_confirmed,
          };
          break;
        default:
          // Pass through unknown events as-is
          Object.assign(transformed, raw);
      }

      options?.onEvent?.(transformed);
    } catch {
      // ignore malformed JSON
    }
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let boundary = findBoundary(buffer);
    while (boundary >= 0) {
      const separatorLength = buffer.slice(boundary, boundary + 4) === "\r\n\r\n" ? 4 : 2;
      const block = buffer.slice(0, boundary).trim();
      buffer = buffer.slice(boundary + separatorLength);
      if (block) emit(block);
      boundary = findBoundary(buffer);
    }
  }

  const tail = buffer.trim();
  if (tail) emit(tail);
}

// ---- Optimize Agent Session Management ----

export interface OptimizeSessionSummary {
  session_id: string;
  title: string;
  phase: string;
  resume_id: number | null;
  reference_resume_id: number | null;
  resume_optimization_proposal_id: string | null;
  research_run_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface OptimizeSessionDetail extends OptimizeSessionSummary {
  messages: any[];
  pending_action: Record<string, any> | null;
}

export async function fetchOptimizeSessions(): Promise<OptimizeSessionSummary[]> {
  const res = await fetch(`${API_BASE}/api/optimize/agent/sessions`);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || `获取会话列表失败 (${res.status})`);
  }
  const data = await res.json();
  return Array.isArray(data?.sessions) ? data.sessions : [];
}

export async function fetchOptimizeSessionDetail(sessionId: string): Promise<OptimizeSessionDetail> {
  const res = await fetch(`${API_BASE}/api/optimize/agent/sessions/${sessionId}`);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || `获取会话详情失败 (${res.status})`);
  }
  return res.json();
}

export async function deleteOptimizeSession(sessionId: string): Promise<void> {
  const res = await fetch(`${API_BASE}/api/optimize/agent/sessions/${sessionId}`, {
    method: "DELETE",
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || `删除会话失败 (${res.status})`);
  }
}

export async function streamOptimizeGenerate(
  payload: OptimizeGenerateRequest,
  options?: {
    signal?: AbortSignal;
    onEvent?: (event: OptimizeStreamEvent) => void;
  }
) {
  const res = await fetch(`${API_BASE}/api/optimize/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: options?.signal,
  });

  if (!res.ok || !res.body) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || `定制生成失败 (${res.status})`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";

  const findBoundary = (text: string) => {
    const unix = text.indexOf("\n\n");
    const windows = text.indexOf("\r\n\r\n");
    if (unix === -1) return windows;
    if (windows === -1) return unix;
    return Math.min(unix, windows);
  };

  const emit = (chunk: string) => {
    let eventName = "message";
    const dataLines: string[] = [];

    for (const line of chunk.split(/\r?\n/)) {
      if (line.startsWith("event:")) {
        eventName = line.slice(6).trim() || "message";
      } else if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).trim());
      }
    }

    if (dataLines.length === 0) return;
    const dataText = dataLines.join("\n");
    let data: any = dataText;
    try {
      data = JSON.parse(dataText);
    } catch {
      // server may send raw text payload in exceptional cases
    }
    options?.onEvent?.({ event: eventName, data });
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let boundary = findBoundary(buffer);
    while (boundary >= 0) {
      const separatorLength = buffer.slice(boundary, boundary + 4) === "\r\n\r\n" ? 4 : 2;
      const block = buffer.slice(0, boundary).trim();
      buffer = buffer.slice(boundary + separatorLength);
      if (block) emit(block);
      boundary = findBoundary(buffer);
    }
  }

  const tail = buffer.trim();
  if (tail) emit(tail);
}

// =============================================
// Interview 面经题库 hooks
// =============================================

export interface InterviewQuestion {
  id: number;
  experience_id: number;
  question_text: string;
  round_type: string;
  category: string;
  difficulty: number;
  frequency: number;
  suggested_answer: string | null;
  job_id: number | null;
  created_at: string | null;
}

export interface InterviewExperience {
  id: number;
  company: string;
  role: string;
  source_platform: string;
  source_url: string | null;
  collected_at: string | null;
  questions_count: number;
}

export function useInterviewQuestions(params?: {
  company?: string;
  role?: string;
  job_id?: number;
  category?: string;
}) {
  const searchParams = new URLSearchParams();
  if (params?.company) searchParams.set("company", params.company);
  if (params?.role) searchParams.set("role", params.role);
  if (params?.job_id) searchParams.set("job_id", String(params.job_id));
  if (params?.category) searchParams.set("category", params.category);
  const qs = searchParams.toString();
  return useSWR<InterviewQuestion[]>(
    `${API_BASE}/api/interview/questions${qs ? `?${qs}` : ""}`,
    fetcher
  );
}

export function useInterviewExperiences(company?: string) {
  const qs = company ? `?company=${encodeURIComponent(company)}` : "";
  return useSWR<InterviewExperience[]>(
    `${API_BASE}/api/interview/experiences${qs}`,
    fetcher
  );
}

export async function collectExperience(body: {
  company: string;
  role: string;
  raw_text: string;
  source_url?: string;
  source_platform?: string;
  job_id?: number;
}) {
  const res = await fetch(`${API_BASE}/api/interview/collect`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || `提交面经失败 (${res.status})`);
  }
  return res.json();
}

export async function extractQuestions(experienceId: number) {
  const res = await fetch(`${API_BASE}/api/interview/extract`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ experience_id: experienceId }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || `提炼问题失败 (${res.status})`);
  }
  return res.json();
}

export async function generateAnswer(questionId: number) {
  const res = await fetch(`${API_BASE}/api/interview/generate-answer`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ question_id: questionId }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || `生成回答失败 (${res.status})`);
  }
  return res.json();
}

// =============================================
// AI 模拟面试
// =============================================

export interface AIInterviewQuestion {
  question: string;
  type: "behavioral" | "technical" | "case" | string;
  focus: string;
  tips: string;
}

export interface AIInterviewEvaluation {
  content_score: number;
  score_band: string;
  dimensions: Record<string, {
    score: number;
    evidence: string[];
    missing_evidence: boolean;
    not_applicable: boolean;
    strength: string;
    improvement: string;
  }>;
  strengths: string[];
  improvements: string[];
  suggestion: string;
  aggregation: "weighted_mean";
  skill_id: string;
  skill_version: number;
}

export interface AIInterviewReport {
  overall_score: number;
  content_score: number;
  score_scope: "content_only";
  dimension_scores: Record<string, number>;
  summary: string;
  highlights: string[];
  areas_for_improvement: string[];
  recommendations: string[];
  delivery_feedback: Record<string, unknown>;
  combined_score: null;
  boundary: string;
}

export interface AIInterviewSession {
  id: number;
  title: string;
  target_company: string;
  target_position: string;
  interview_type: string;
  difficulty: string;
  questions: AIInterviewQuestion[];
  status: string;
  current_question_index: number;
  total_questions: number;
  scoring_skill: { skill_id: string; version: number };
  model_runtime: AIInterviewRuntime["runtime"];
  data_consent: Record<string, unknown>;
  behavior_summary: Record<string, unknown>;
  created_at: string;
}

export interface AIInterviewRuntime {
  runtime: {
    provider: string;
    model: string;
    tier: string;
    source: string;
    model_source: string;
    is_local: boolean;
    consent_policy: "local_runtime_notice" | "explicit_cloud_consent";
  };
  available_data_categories: string[];
  privacy: {
    raw_camera_data_sent_to_backend: false;
    derived_behavior_events_only: true;
    raw_audio_stored_by_default: false;
  };
  evaluation_boundary: {
    content_and_delivery_are_separate: true;
    combined_score: null;
    prohibited_inferences: string[];
  };
}

export interface AIInterviewBehaviorEvent {
  event_id: string;
  event_type: string;
  started_ms: number;
  ended_ms: number;
  occurrence_count: number;
  confidence: number;
  detector_id: string;
  detector_version: string;
  metadata: { question_index?: number };
}

export interface AIInterviewAnswerResult {
  success: boolean;
  evaluation: AIInterviewEvaluation;
  next_question?: AIInterviewQuestion;
  progress?: { current: number; total: number };
  completed?: boolean;
  report?: AIInterviewReport;
}

export async function getAIInterviewRuntime(): Promise<AIInterviewRuntime> {
  const res = await fetch(`${API_BASE}/api/interviews/runtime`, { cache: "no-store" });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || `读取面试模型配置失败 (${res.status})`);
  }
  return res.json();
}

export async function createAIInterview(body: {
  title: string;
  target_company: string;
  target_position: string;
  interview_type: "behavioral" | "technical" | "case" | "mixed";
  difficulty: "easy" | "medium" | "hard";
  question_count: number;
  scoring_skill_id?: string;
  scoring_skill_version?: number;
  model_provider: string;
  data_consent: boolean;
  consented_data_categories: string[];
  user_confirmed: boolean;
}): Promise<AIInterviewSession> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}/api/interviews/`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (error) {
    throw new Error(formatBackendNetworkError(error));
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || `创建模拟面试失败 (${res.status})`);
  }
  return res.json();
}

export async function submitAIInterviewAnswer(
  interviewId: number,
  questionIndex: number,
  content: string,
  modelProvider: string
): Promise<AIInterviewAnswerResult> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}/api/interviews/${interviewId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        question_index: questionIndex,
        content,
        model_provider: modelProvider,
        user_confirmed: true,
      }),
    });
  } catch (error) {
    throw new Error(formatBackendNetworkError(error));
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || `提交回答失败 (${res.status})`);
  }
  return res.json();
}

export async function ingestAIInterviewBehaviorEvents(
  interviewId: number,
  events: AIInterviewBehaviorEvent[]
): Promise<{ accepted: number; duplicates: number; summary: Record<string, unknown> }> {
  const res = await fetch(`${API_BASE}/api/interviews/${interviewId}/behavior-events`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ events, user_confirmed: true }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || `上传派生表达行为事件失败 (${res.status})`);
  }
  return res.json();
}

// ---- AI Generate Draft (SSE) ----

export interface DraftResultSection {
  id: number;
  section_type: string;
  title: string;
  sort_order: number;
  visible: boolean;
  content_json: any[];
}

export interface DraftResult {
  summary: string;
  sections: DraftResultSection[];
}

export interface DraftStreamEvent {
  progress?: { stage: string; message: string };
  result?: DraftResult;
  error?: string;
  done?: boolean;
}

export async function streamGenerateResumeDraft(
  resumeId: number,
  payload: { jd_text: string },
  options?: {
    signal?: AbortSignal;
    onEvent?: (event: DraftStreamEvent) => void;
  }
) {
  const res = await fetch(`${API_BASE}/api/resume/${resumeId}/ai/generate-draft`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: options?.signal,
  });
  if (!res.ok || !res.body) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || `生成初稿失败 (${res.status})`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  const findBoundary = (text: string) => {
    const u = text.indexOf("\n\n");
    const w = text.indexOf("\r\n\r\n");
    if (u === -1) return w;
    if (w === -1) return u;
    return Math.min(u, w);
  };
  const emit = (chunk: string) => {
    const lines = chunk.split(/\r?\n/);
    let event = "";
    const dataLines: string[] = [];
    for (const line of lines) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
    }
    if (dataLines.length === 0) return;
    try {
      const data = JSON.parse(dataLines.join("\n"));
      const ev: DraftStreamEvent = {};
      if (event === "progress") ev.progress = { stage: data.stage, message: data.message };
      else if (event === "result") ev.result = data as DraftResult;
      else if (event === "error") ev.error = data.message;
      else if (event === "done") ev.done = true;
      options?.onEvent?.(ev);
    } catch {
      // ignore malformed JSON
    }
  };
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let boundary = findBoundary(buffer);
    while (boundary >= 0) {
      const sepLen = buffer.slice(boundary, boundary + 4) === "\r\n\r\n" ? 4 : 2;
      const block = buffer.slice(0, boundary).trim();
      buffer = buffer.slice(boundary + sepLen);
      if (block) emit(block);
      boundary = findBoundary(buffer);
    }
  }
  const tail = buffer.trim();
  if (tail) emit(tail);
}

// =============================================
// 进度看板（公司 × 岗位 渐进披露）
// =============================================

export interface ProgressBoardRecord {
  application_attempt_id: number;
  job_id: number;
  company: string;
  job_title: string;
  location: string;
  current_stage: string;
  next_action: string;
  last_event_at: string | null;
  timeline_count: number;
  pending_candidates: number;
  upcoming_interview: {
    calendar_event_id: number;
    title: string;
    start_time: string;
    location: string;
  } | null;
  attempt_created_at: string;
}

export interface ProgressBoardCompany {
  company: string;
  records: ProgressBoardRecord[];
  max_stage: string;
  pending_candidates: number;
  last_event_at: string | null;
}

export interface ProgressBoardPayload {
  status: string;
  total_companies: number;
  total_records: number;
  companies: ProgressBoardCompany[];
  unlinked_candidates: ProgressUnlinkedCandidate[];
  summary: {
    by_stage: Record<string, number>;
    pending_review: number;
    unlinked_review: number;
  };
}

export interface ProgressTimelineEntry {
  event_id: string;
  previous_stage: string;
  stage: string;
  occurred_at: string | null;
  source_channel: string;
  snippet: string;
}

export interface ProgressPendingCandidate {
  candidate_id: string;
  status: string;
  match_state: string;
  suggested_stage: string;
  selected_stage: string | null;
  classification_conflict: boolean;
  rule_stage: string;
  llm_stage: string;
  application: {
    application_attempt_id: number;
    job_id: number;
    company: string;
    job_title: string;
  } | null;
  signal: {
    signal_id: string;
    channel: string;
    sender: string;
    received_at: string | null;
    subject: string;
    status: string;
    snippet?: string;
  };
  llm_extracted?: {
    interview_time?: string | null;
  };
  created_at: string;
}

export interface ProgressCandidateMatch {
  application_attempt_id: number;
  job_id: number;
  company: string;
  job_title: string;
  match_basis: string[];
}

export interface ProgressUnlinkedCandidate extends ProgressPendingCandidate {
  extracted: {
    company: string;
    job_title: string;
    interview_time: string | null;
  };
  evidence: {
    snippet: string;
    evidence_span: string;
    rule_stage: string;
    llm_stage: string;
    llm_confidence: number | null;
    classification_conflict: boolean;
  };
  match_candidates: ProgressCandidateMatch[];
  reasons: string[];
  can_create_record: boolean;
}

export interface ProgressTimelinePayload {
  application_attempt_id: number;
  job_id: number;
  company: string;
  job_title: string;
  current_stage: string;
  next_action: string;
  timeline: ProgressTimelineEntry[];
  pending_candidates: ProgressPendingCandidate[];
}

export interface ProgressReviewResult {
  candidate_id: string;
  status: string;
  duplicate: boolean;
  workspace_record?: {
    record_id: number;
    created: boolean;
    total_table_id: number | null;
    previous_status: string | null;
    status: string;
    event_warning?: string;
  } | null;
  created_record?: {
    job_id: number;
    application_attempt_id: number;
    application_attempt_created: boolean;
    company: string;
    job_title: string;
    workspace?: ProgressReviewResult["workspace_record"];
  } | null;
}

export function useProgressBoard(status: "active" | "closed" | "all" = "active") {
  return useSWR<ProgressBoardPayload>(
    `${API_BASE}/api/applications/progress-board?status=${status}`,
    fetcher
  );
}

export function useProgressTimeline(attemptId: number | null) {
  return useSWR<ProgressTimelinePayload>(
    attemptId
      ? `${API_BASE}/api/applications/progress-board/${attemptId}/timeline`
      : null,
    fetcher
  );
}

export async function reviewProgressCandidate(
  candidateId: string,
  payload: {
    action: "accept" | "reject";
    application_attempt_id?: number | null;
    stage?: string;
    note?: string;
    add_calendar?: boolean;
    create_record?: boolean;
  }
) {
  const res = await fetch(
    `${API_BASE}/api/email/progress-candidates/${encodeURIComponent(candidateId)}/review`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }
  );
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || `审核候选进展失败 (${res.status})`);
  }
  return (await res.json()) as ProgressReviewResult;
}
