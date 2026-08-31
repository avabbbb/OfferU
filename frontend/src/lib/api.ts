// =============================================
// API 客户端 — 统一的后端请求封装
// =============================================
// 所有前端组件通过此模块与后端通信
// 基于 fetch API，支持 SWR 缓存
// =============================================

import { SHOWCASE, showcaseHandle } from "./showcase/router";
import { showcaseChatResponse } from "./showcase/llm";

const API_BASE =
  process.env.NEXT_PUBLIC_API_URL ||
  (typeof window !== "undefined"
    ? `${window.location.protocol}//${window.location.hostname}:8765`
    : "http://127.0.0.1:8765");

function buildQuery(params?: Record<string, unknown>) {
  const sp = new URLSearchParams();
  if (!params) return sp.toString();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    if (typeof value === "string" && value.trim() === "") continue;
    sp.set(key, String(value));
  }
  return sp.toString();
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  if (SHOWCASE) {
    // 展示模式：全部请求由本地 IndexedDB 数据层承载（无需 Python 后端）
    return (await showcaseHandle(path, options)) as T;
  }
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      headers: { "Content-Type": "application/json" },
      ...options,
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`无法连接本地后端 ${API_BASE}，请确认后端服务已启动。原始错误：${reason}`);
  }
  if (!res.ok) {
    const payload = await res.json().catch(() => ({}));
    const detail = payload?.detail || payload?.message;
    throw new Error(detail ? String(detail) : `API Error: ${res.status}`);
  }
  return res.json();
}

async function readEventStream<T>(
  path: string,
  options: RequestInit,
  onEvent?: (event: string, data: any) => void
): Promise<T> {
  if (SHOWCASE) {
    // 展示模式：Agent 工作流端点（optimize/interviews）不接本地数据层，
    // 返回空结果避免抛错；对话式交互见 profileApi.chat 的合成 SSE。
    return {} as T;
  }
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: { Accept: "text/event-stream", ...options.headers },
  });
  if (
    (res.status === 404 || res.status === 405)
    && String(options.method || "GET").toUpperCase() === "POST"
  ) {
    throw new Error("__SSE_UNAVAILABLE__");
  }
  if (!res.ok) throw new Error(`API Error: ${res.status}`);
  if (!res.body) throw new Error("Agent 流式响应不可用");

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let result: T | undefined;

  const consume = (block: string) => {
    let event = "message";
    const dataLines: string[] = [];
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
    }
    if (dataLines.length === 0) return;
    const raw = dataLines.join("\n");
    let data: any = raw;
    try { data = JSON.parse(raw); } catch { /* keep SSE text payload */ }
    onEvent?.(event, data);
    if (event === "message" && data?.response) result = data.response as T;
    if (event === "error") throw new Error(data?.error || data?.content || "Agent 流式请求失败");
  };

  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done }).replace(/\r\n/g, "\n");
    let boundary = buffer.indexOf("\n\n");
    while (boundary >= 0) {
      consume(buffer.slice(0, boundary));
      buffer = buffer.slice(boundary + 2);
      boundary = buffer.indexOf("\n\n");
    }
    if (done) break;
  }
  if (buffer.trim()) consume(buffer);
  if (!result) throw new Error("Agent 流结束但没有返回结果");
  return result;
}

async function streamResult<T>(
  path: string,
  body: unknown,
  onEvent?: (event: string, data: any) => void
): Promise<T> {
  return readEventStream<T>(
    path,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
    onEvent
  );
}

function createAgentRunId() {
  return `run_${crypto.randomUUID().replace(/-/g, "")}`;
}

function waitForReconnect(delayMs: number) {
  return new Promise((resolve) => window.setTimeout(resolve, delayMs));
}

// ---- Jobs API ----
export const jobsApi = {
  list: (params?: {
    page?: number;
    page_size?: number;
    period?: string;
    source?: string;
    triage_status?: "inbox" | "picked" | "ignored";
    pool_id?: number | "ungrouped";
    batch_id?: string;
    keyword?: string;
    job_type?: string;
    education?: string;
    is_campus?: boolean;
  }) =>
    request(`/api/jobs/?${buildQuery(params as any)}`),
  
  get: (id: number) => request(`/api/jobs/${id}`),

  batches: (limit = 30) => request(`/api/jobs/batches?limit=${limit}`),

  patch: (
    id: number,
    data: { triage_status?: "inbox" | "picked" | "ignored"; pool_id?: number; clear_pool?: boolean }
  ) =>
    request(`/api/jobs/${id}`, { method: "PATCH", body: JSON.stringify(data) }),

  patchBatch: (data: {
    job_ids: number[];
    triage_status?: "inbox" | "picked" | "ignored";
    pool_id?: number;
    clear_pool?: boolean;
  }) =>
    request("/api/jobs/batch-update", { method: "PATCH", body: JSON.stringify(data) }),
  
  stats: (period = "week") => request(`/api/jobs/stats?period=${period}`),
};

// ---- Pools API ----
export const poolsApi = {
  list: (scope?: "inbox" | "picked" | "ignored") =>
    request(`/api/pools/?${buildQuery({ scope })}`),

  create: (data: { name: string; scope?: "inbox" | "picked" | "ignored" }) =>
    request("/api/pools/", { method: "POST", body: JSON.stringify(data) }),

  update: (id: number, data: { name: string }, scope?: "inbox" | "picked" | "ignored") =>
    request(`/api/pools/${id}?${buildQuery({ scope })}`, { method: "PUT", body: JSON.stringify(data) }),

  delete: (id: number, scope?: "inbox" | "picked" | "ignored") =>
    request(`/api/pools/${id}?${buildQuery({ scope })}`, { method: "DELETE" }),
};

// ---- Resume API ----
export const resumeApi = {
  list: () => request("/api/resume/"),

  get: (id: number) => request(`/api/resume/${id}`),

  create: (data: any) =>
    request("/api/resume/", { method: "POST", body: JSON.stringify(data) }),

  update: (id: number, data: any) =>
    request(`/api/resume/${id}`, { method: "PUT", body: JSON.stringify(data) }),

  delete: (id: number) =>
    request(`/api/resume/${id}`, { method: "DELETE" }),

  // 段落管理
  createSection: (resumeId: number, data: any) =>
    request(`/api/resume/${resumeId}/sections`, { method: "POST", body: JSON.stringify(data) }),

  updateSection: (resumeId: number, sectionId: number, data: any) =>
    request(`/api/resume/${resumeId}/sections/${sectionId}`, { method: "PUT", body: JSON.stringify(data) }),

  deleteSection: (resumeId: number, sectionId: number) =>
    request(`/api/resume/${resumeId}/sections/${sectionId}`, { method: "DELETE" }),

  reorderSections: (resumeId: number, items: { id: number; sort_order: number }[]) =>
    request(`/api/resume/${resumeId}/sections/reorder`, { method: "PUT", body: JSON.stringify({ items }) }),

  // 文件上传
  uploadPhoto: async (resumeId: number, file: File) => {
    const formData = new FormData();
    formData.append("file", file);
    const res = await fetch(`${API_BASE}/api/resume/${resumeId}/photo`, {
      method: "POST",
      body: formData,
    });
    if (!res.ok) throw new Error(`API Error: ${res.status}`);
    return res.json();
  },

  // 导出
  exportPdf: (id: number) =>
    fetch(`${API_BASE}/api/resume/${id}/export/pdf`, { method: "POST" }),

  exportPdfUrl: (id: number) => `${API_BASE}/api/resume/${id}/export/pdf`,

  workspace: (id: number) =>
    request<ResumeWorkspace>(`/api/resume/workspace/${id}`),

  ensureWorkspace: (data: {
    job_id: number;
    proposal_id?: string;
    reference_resume_id?: number;
  }) =>
    request<ResumeWorkspace>("/api/resume/workspace/ensure", {
      method: "POST",
      body: JSON.stringify(data),
    }),

  reviewProposalItem: (
    proposalId: string,
    data: {
      resume_id: number;
      change_id: string;
      action: "accept" | "reject";
      edited_text?: string;
    },
  ) =>
    request<ResumeWorkspace>(
      `/api/resume/workspace/proposals/${encodeURIComponent(proposalId)}/review-item`,
      { method: "POST", body: JSON.stringify(data) },
    ),

  createVersion: (id: number, data?: { change_summary?: string; created_by?: string }) =>
    request<ResumeVersionSummary>(`/api/resume/${id}/versions`, {
      method: "POST",
      body: JSON.stringify(data || {}),
    }),

  listVersions: (id: number) =>
    request<ResumeVersionSummary[]>(`/api/resume/${id}/versions`),

  getVersion: (id: number, versionId: number) =>
    request<ResumeVersionDetail>(`/api/resume/${id}/versions/${versionId}`),

  restoreVersion: (id: number, versionId: number) =>
    request<Record<string, any>>(`/api/resume/${id}/versions/${versionId}/restore`, {
      method: "POST",
    }),

  // 模板
  templates: () => request("/api/resume/templates"),
};

export interface ResumeVersionSummary {
  id: number;
  resume_id: number;
  version_number: number;
  change_summary: string;
  created_by: string;
  created_at: string;
  is_current?: boolean;
}

export interface ResumeVersionDetail extends ResumeVersionSummary {
  content_snapshot: Record<string, any>;
}

export interface ResumeWorkspace {
  resume: Record<string, any> & {
    id: number;
    target_job_id?: number | null;
    current_version_id?: number | null;
    workspace_revision?: number;
  };
  job: {
    id: number;
    title: string;
    company: string;
    location?: string;
    url?: string;
    apply_url?: string;
    summary?: string;
    raw_description?: string;
    keywords?: string[];
  } | null;
  workspace: {
    revision: number;
    content_hash: string;
    is_tailored: boolean;
  };
  application_packet: {
    job_id: number | null;
    resume_id: number;
    current_version_id: number | null;
    current_version_number: number | null;
    status: string;
    application_id: number | null;
    application_attempt_id: number | null;
    artifacts: Record<string, boolean>;
  };
  proposals: ResumeOptimizationProposalDetail[];
  versions: ResumeVersionSummary[];
}

// ---- Calendar API ----
export const calendarApi = {
  events: (start?: string, end?: string) => {
    const params = new URLSearchParams();
    if (start) params.set("start", start);
    if (end) params.set("end", end);
    return request(`/api/calendar/events?${params}`);
  },
  
  createEvent: (data: any) =>
    request("/api/calendar/events", { method: "POST", body: JSON.stringify(data) }),
  
  autoFill: () =>
    request("/api/calendar/auto-fill", { method: "POST" }),
};

// ---- Email API ----
export const emailApi = {
  auth: () => request("/api/email/auth", { method: "POST" }),
  
  notifications: () => request("/api/email/notifications"),
  
  sync: () => request("/api/email/sync", { method: "POST" }),
};

// ---- Config API ----
export const configApi = {
  get: () => request("/api/config/"),
  
  update: (data: any) =>
    request("/api/config/", { method: "PUT", body: JSON.stringify(data) }),
};

// ---- Main Agent support records ----
export interface AgentConversationMessage {
  role: "user" | "assistant";
  content: string;
}

export interface AgentToolCall {
  tool: string;
  args: Record<string, unknown>;
  result: unknown;
  action_id?: string;
}

export interface AgentProposedAction {
  id: string;
  tool: string;
  summary: string;
  risk_level: "read" | "write" | "confirm";
  requires_confirmation: boolean;
  args: Record<string, unknown>;
}

export interface AgentSkill {
  id: string;
  name: string;
  group: string;
  status: "native" | "partial" | "planned" | string;
  description: string;
  featured: boolean;
  order: number;
  missing_capabilities: string[];
}

export interface AgentCareerPath {
  title: string;
  industry: string;
  fit_reason: string;
  entry_route: string;
  salary_range: string;
  search_keywords: string[];
  application_strategy: string;
}

export interface AgentJobCard {
  id: number;
  title: string;
  company: string;
  location: string;
  salary_text: string;
  source: string;
  apply_url: string;
  summary?: string;
}

export interface GuardianAlert {
  code: string;
  severity: "low" | "medium" | "high" | string;
  title: string;
  message: string;
  action?: string;
}

export interface GuardianSuggestion {
  title: string;
  description: string;
  prompt: string;
}

export interface AgentMemorySnapshot {
  schema_version: string;
  user_stage: "unknown" | "campus" | "experienced" | string;
  confidence: number;
  facts: string[];
  preferences: string[];
  goals: string[];
  risks: string[];
  events: string[];
  updated_at: string;
}

export interface AgentConversationSummary {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  message_count: number;
  last_message: string;
}

export interface AgentConversationDetail {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  messages: AgentConversationMessage[];
}

export interface AgentResponse {
  assistant_message: string;
  mode: string;
  active_skill?: AgentSkill;
  requires_confirmation: boolean;
  tool_calls: AgentToolCall[];
  proposed_actions: AgentProposedAction[];
  career_paths?: AgentCareerPath[];
  job_cards?: AgentJobCard[];
  next_steps?: string[];
  transferable_skills_summary?: string;
  quick_wins?: string[];
  reality_check?: Record<string, any>;
  user_stage?: "unknown" | "campus" | "experienced" | string;
  stage_confidence?: number;
  stage_signals?: string[];
  memory_snapshot?: AgentMemorySnapshot;
  alerts?: GuardianAlert[];
  proactive_suggestions?: GuardianSuggestion[];
  conversation_id?: string;
  conversation_title?: string;
}

export interface AgentRunStep extends AgentProposedAction {
  idempotency_key: string;
  status: string;
  attempts: number;
  result?: unknown;
  error?: string | null;
}

export interface AgentRunRecord {
  id: string;
  task_id: string;
  conversation_id: string;
  goal: string;
  mode: string;
  skill_id: string;
  skill_version: string;
  skill_snapshot: Record<string, any>;
  status: string;
  steps: AgentRunStep[];
  llm_runtime: Record<string, any>;
  final_result: Record<string, any>;
  failure_reason: string;
  event_sequence: number;
  created_at?: string;
  updated_at?: string;
  harness_name?: string;
  harness_version?: string;
  adapter_name?: string;
  adapter_version?: string;
  lease_id?: string;
  context_version?: number;
}

export interface AgentRunResponse {
  ok: boolean;
  run: AgentRunRecord;
  assistant_message: string;
  pending_actions: AgentProposedAction[];
  active_skill: AgentSkill;
  guardian?: {
    user_stage?: string;
    stage_confidence?: number;
    stage_signals?: string[];
    alerts?: GuardianAlert[];
    proactive_suggestions?: GuardianSuggestion[];
  };
  errors?: string[];
  conversation_id?: string;
  conversation_title?: string;
}

export interface AgentConfirmationResponse {
  ok: boolean;
  run: AgentRunRecord;
  tool_calls: AgentToolCall[];
  errors?: string[];
  warnings?: string[];
}

export interface HostedExecutorEvent {
  event_id: string;
  sequence: number;
  type: string;
  provider_event: string;
  payload: Record<string, any>;
  created_at: string;
}

export interface HostedExecutorSession {
  session_id: string;
  task_type: string;
  task_id: string;
  executor_id: string;
  protocol: string;
  external_session_id: string;
  external_turn_id: string;
  status: string;
  capability_grant: Record<string, any>;
  recovery_cursor: Record<string, any>;
  error: string;
  event_sequence: number;
  created_at: string;
  updated_at: string;
  started_at?: string | null;
  completed_at?: string | null;
}

export interface HostedExecutorSessionDetail extends HostedExecutorSession {
  result: Record<string, any>;
  events: HostedExecutorEvent[];
}

export interface JobResearchRunSummary {
  run_id: string;
  job_id: number;
  runtime_id: string;
  runtime_version?: string | null;
  data_mode?: "fixture" | "live" | string;
  status: string;
  review_status: "pending" | "candidate" | "accepted" | "rejected" | "not_available";
  review_note: string;
  reviewed_at?: string | null;
  attempts: number;
  source_count: number;
  finding_count: number;
  error?: string | null;
  created_at: string;
  updated_at: string;
  started_at?: string | null;
  completed_at?: string | null;
}

export interface JobResearchEvidence {
  id: number;
  source_ref: string;
  url: string;
  title: string;
  publisher: string;
  source_class: string;
  published_at?: string | null;
  retrieved_at: string;
  excerpt: string;
}

export interface JobResearchFinding {
  id: number;
  finding_type: string;
  statement: string;
  details: Record<string, any>;
  source_refs: string[];
  evidence_level: string;
}

export interface JobResearchRunDetail extends JobResearchRunSummary {
  report_markdown: string;
  result: {
    schema?: string;
    gaps?: string[];
    [key: string]: any;
  };
  trace: Record<string, any>;
  evidence: JobResearchEvidence[];
  findings: JobResearchFinding[];
}

export interface ResumeOptimizationProposalSummary {
  proposal_id: string;
  status: string;
  job_id: number;
  job_title: string;
  company: string;
  profile_id: number;
  research_run_id: string;
  reference_resume_id?: number | null;
  change_count: number;
  fact_gate_status: string;
  fact_gate_warnings_count: number;
  accepted_resume_id?: number | null;
  accepted_resume_version_id?: number | null;
  review_note: string;
  created_at: string;
  updated_at: string;
  reviewed_at?: string | null;
  workspace_resume_id?: number | null;
  workspace_snapshot_hash?: string;
  item_reviews?: Record<string, { action: "accept" | "reject"; edited_text?: string; reviewed_at?: string }>;
}

export interface ResumeOptimizationProposalDetail extends ResumeOptimizationProposalSummary {
  source_section_ids: number[];
  source_snapshot_hash: string;
  research_snapshot_hash: string;
  original_summary: string;
  proposed_summary: string;
  original_rows: Array<Record<string, any>>;
  proposed_rows: Array<Record<string, any>>;
  diff: Array<Record<string, any>>;
  strategy: Record<string, any>;
  presentation: Record<string, any>;
  fact_gates: Record<string, any>;
  trace: Record<string, any>;
  workspace_resume_id?: number | null;
  workspace_snapshot_hash?: string;
  item_reviews?: Record<string, { action: "accept" | "reject"; edited_text?: string; reviewed_at?: string }>;
}

export type RoleBenchmarkDirection =
  | "common"
  | "distinctive"
  | "highly_distinctive"
  | "missing_common";

export interface RoleBenchmarkObservation {
  id: number;
  capability_id: string;
  raw_capability: string;
  category: string;
  importance: "must_have" | "strong" | "nice_to_have";
  evidence_text: string;
  source_section: string;
  confidence: number;
  canonicalization_status: string;
}

export interface RoleBenchmarkEvidenceGap {
  schema: string;
  role_distinctiveness: number;
  evidence_strength: number;
  evidence_gap: number;
  training_priority: number;
  status: "missing" | "partial" | "supported" | string;
  matched_evidence: Array<{
    profile_section_id: number;
    section_type: string;
    title: string;
    tier: string;
    confidence: number;
    excerpt: string;
  }>;
}

export interface RoleBenchmarkDocument {
  id: number;
  job_id: number | null;
  document_kind: "target" | "comparator" | string;
  source_ref: string;
  source: string;
  url: string;
  title: string;
  company: string;
  location: string;
  industry: string;
  raw_description: string;
  role_profile: Record<string, any>;
  inclusion_status: string;
  exclusion_reason: string;
  created_at: string;
  capability_observations: RoleBenchmarkObservation[];
}

export interface RoleBenchmarkSignal {
  id: number;
  capability_id: string;
  category: string;
  target_importance: "must_have" | "strong" | "nice_to_have" | "not_present" | string;
  target_occurrence_count: number;
  comparator_count: number;
  comparator_total: number;
  market_frequency: number;
  direction: RoleBenchmarkDirection;
  confidence: number;
  priority: number;
  evidence_refs: string[];
  target_evidence: RoleBenchmarkObservation[];
  market_evidence: Array<{
    source_ref: string;
    url: string;
    company: string;
    title: string;
    observation: RoleBenchmarkObservation;
  }>;
  evidence_gap: RoleBenchmarkEvidenceGap;
}

export interface RoleBenchmarkSummary {
  found?: boolean;
  run_id?: string | null;
  target_job_id: number | null;
  cohort?: Record<string, string>;
  requested_sample_count?: number;
  minimum_sample_count?: number;
  maximum_sample_count?: number;
  valid_sample_count?: number;
  company_count?: number;
  source_summary?: Record<string, any>;
  schema_version?: string;
  algorithm_version?: string;
  taxonomy_version?: string;
  runtime_id?: string;
  runtime_version?: string | null;
  data_mode?: "fixture" | "live" | string;
  status?: string;
  benchmark_status?: "READY" | "INSUFFICIENT_SAMPLE" | "BLOCKED_EXTERNAL" | string;
  sample_sufficient?: boolean;
  last_error?: string | null;
  provider_blocked?: boolean;
  latest_attempt?: RoleBenchmarkSummary | null;
  attempts?: number;
  created_at?: string;
  updated_at?: string;
  started_at?: string | null;
  completed_at?: string | null;
  scheduled?: boolean;
  reused_active_run?: boolean;
}

export interface RoleBenchmarkDetail extends RoleBenchmarkSummary {
  target_job?: {
    id: number;
    title: string;
    company: string;
    url: string;
  } | null;
  target_profile?: Record<string, any>;
  documents?: RoleBenchmarkDocument[];
  signals?: RoleBenchmarkSignal[];
}

export interface RoleBenchmarkBuildRequest {
  runtime_id?: "codex" | "claude" | "gemini" | "omp" | "pi" | "opencode" | "fixture" | "replay" | "boss-fixture" | `plugin:${string}`;
  role_family?: string;
  specialization?: string;
  seniority?: string;
  region?: string;
  industry?: string;
}

export const roleBenchmarkApi = {
  forJob: (jobId: number) =>
    request<RoleBenchmarkDetail>(`/api/research/role-benchmarks/job/${jobId}`),
  build: (jobId: number, data: RoleBenchmarkBuildRequest = {}) =>
    request<RoleBenchmarkSummary>(`/api/research/role-benchmarks/${jobId}/build`, {
      method: "POST",
      body: JSON.stringify(data),
    }),
  refresh: (jobId: number, data: RoleBenchmarkBuildRequest = {}) =>
    request<RoleBenchmarkSummary>(`/api/research/role-benchmarks/${jobId}/refresh`, {
      method: "POST",
      body: JSON.stringify(data),
    }),
};

export type PreApplicationDecisionChoice =
  | "go"
  | "conditional_go"
  | "no_go"
  | "insufficient_evidence";

export interface PreApplicationDecisionEvidence {
  source_refs: string[];
  claim: string;
  kind: "candidate_fact" | "job_requirement" | "research_fact" | "inference";
}

export interface PreApplicationDecisionRecord {
  id: string;
  job_id: number;
  status: "ready_for_review" | "reviewed" | string;
  agent_recommendation: PreApplicationDecisionChoice;
  final_decision: PreApplicationDecisionChoice | null;
  review_note: string;
  reviewed_at?: string | null;
  created_at: string;
  updated_at: string;
  decision: {
    recommendation: PreApplicationDecisionChoice;
    rationale: string;
    strengths: string[];
    gaps: string[];
    conditions: string[];
    missing_evidence: string[];
    evidence: PreApplicationDecisionEvidence[];
  };
}

export interface PreApplicationState {
  stage: string;
  job: Record<string, any>;
  profile_id: number;
  profile_evidence_count: number;
  research_run?: {
    run_id: string;
    status: string;
    finding_count?: number;
    source_count?: number;
    error?: string;
    attempts?: number;
  } | null;
  stale_decision_id?: string | null;
  decision?: PreApplicationDecisionRecord | null;
  resume_proposal?: {
    proposal_id: string;
    status: string;
    created_at: string;
  } | null;
}

export interface AgentProviderHealth {
  provider_id: string;
  available: boolean;
  authenticated: boolean | null;
  blocked: boolean;
  status: "ready" | "blocked" | "auth_required" | "unavailable" | "unprobed" | string;
  version: string;
  auth_mode: string;
  protocol_version: string;
  capabilities: Record<string, any>;
  last_error: string;
  checked_at?: string | null;
}

export const agentRuntimeApi = {
  skills: () =>
    request<{ skills: AgentSkill[] }>("/api/agent/skills"),
  runtime: () =>
    request<Record<string, any> & { available: boolean; runtime: string }>("/api/agent/runtime"),
  providerHealth: () =>
    request<{ providers: AgentProviderHealth[] }>("/api/agent/runtime/providers/health"),
  start: async (data: {
    message: string;
    skill_id: string;
    conversation_id?: string | null;
    task_id?: string | null;
    runtime_provider?: string;
  }, onEvent?: (event: string, data: any) => void) => {
    const runId = createAgentRunId();
    const requestData = { ...data, run_id: runId };
    let lastSequence = 0;
    let nextDeltaIndex = 0;

    const forwardEvent = (event: string, eventData: any) => {
      const sequence = Number(eventData?.sequence);
      if (Number.isInteger(sequence) && sequence > lastSequence) {
        lastSequence = sequence;
      }

      if (event !== "assistant.delta" && event !== "message.delta") {
        onEvent?.(event, eventData);
        return;
      }

      const payload = eventData?.payload || {};
      const parts = Array.isArray(payload.parts) ? payload.parts : null;
      if (parts) {
        for (const part of parts) {
          const deltaIndex = Number(part?.delta_index);
          if (!Number.isInteger(deltaIndex) || deltaIndex < nextDeltaIndex) continue;
          nextDeltaIndex = deltaIndex + 1;
          onEvent?.("assistant.delta", {
            ...eventData,
            payload: {
              ...payload,
              parts: undefined,
              delta: String(part?.delta || ""),
              delta_index: deltaIndex,
            },
          });
        }
        return;
      }

      const deltaIndex = Number(payload.delta_index);
      if (Number.isInteger(deltaIndex)) {
        if (deltaIndex < nextDeltaIndex) return;
        nextDeltaIndex = deltaIndex + 1;
      }
      onEvent?.("assistant.delta", eventData);
    };

    const followExistingRun = async () => {
      let failures = 0;
      while (true) {
        try {
          return await readEventStream<AgentRunResponse>(
            `/api/agent/runtime/runs/${encodeURIComponent(runId)}/events/stream?${buildQuery({
              after_sequence: lastSequence,
            })}`,
            { method: "GET" },
            forwardEvent
          );
        } catch (error) {
          failures += 1;
          if (failures >= 8) throw error;
          const delayMs = Math.min(250 * (2 ** (failures - 1)), 2000);
          onEvent?.("stream.reconnecting", {
            run_id: runId,
            after_sequence: lastSequence,
            attempt: failures,
          });
          await waitForReconnect(delayMs);
        }
      }
    };

    try {
      return await streamResult<AgentRunResponse>(
        "/api/agent/runtime/runs/stream",
        requestData,
        forwardEvent
      );
    } catch (error) {
      if (error instanceof Error && error.message === "__SSE_UNAVAILABLE__") {
        return request<AgentRunResponse>("/api/agent/runtime/runs", {
          method: "POST",
          body: JSON.stringify(requestData),
        });
      }
      try {
        onEvent?.("stream.reconnecting", {
          run_id: runId,
          after_sequence: lastSequence,
          attempt: 0,
        });
        return await followExistingRun();
      } catch (followError) {
        if (
          followError instanceof Error
          && followError.message === "API Error: 404"
        ) {
          throw error;
        }
        throw followError;
      }
    }
  },
  confirm: (runId: string, actionId: string) =>
    request<AgentConfirmationResponse>(
      `/api/agent/runtime/runs/${encodeURIComponent(runId)}/confirm`,
      {
        method: "POST",
        body: JSON.stringify({ action_id: actionId }),
      }
    ),
  resume: (runId: string) =>
    request<AgentRunResponse>(
      `/api/agent/runtime/runs/${encodeURIComponent(runId)}/resume`,
      { method: "POST" }
    ),
  abort: (runId: string) =>
    request<{ ok: boolean; run: AgentRunRecord }>(
      `/api/agent/runtime/runs/${encodeURIComponent(runId)}/abort`,
      { method: "POST" }
    ),
  run: (runId: string) =>
    request<{ run: AgentRunRecord }>(`/api/agent/runs/${encodeURIComponent(runId)}`),
  runs: (params?: { conversation_id?: string; task_id?: string; limit?: number }) =>
    request<{ runs: AgentRunRecord[] }>(
      `/api/agent/runs?${buildQuery(params)}`
    ),
  events: (runId: string, afterSequence = 0) =>
    request<{
      run_id: string;
      events: Array<{
        event_id: string;
        run_id: string;
        sequence: number;
        type: string;
        timestamp: string;
        payload: Record<string, any>;
      }>;
      last_sequence: number;
    }>(
      `/api/agent/runs/${encodeURIComponent(runId)}/events?${buildQuery({
        after_sequence: afterSequence,
      })}`
    ),
};

export const hostedExecutorApi = {
  sessions: (params?: { task_type?: string; task_id?: string; limit?: number }) =>
    request<{ items: HostedExecutorSession[] }>(
      `/api/agent/runtime/hosted-sessions?${buildQuery(params)}`
    ),
  session: (sessionId: string) =>
    request<HostedExecutorSessionDetail>(
      `/api/agent/runtime/hosted-sessions/${encodeURIComponent(sessionId)}`
    ),
  cancel: (sessionId: string) =>
    request<Record<string, any>>(
      `/api/agent/runtime/hosted-sessions/${encodeURIComponent(sessionId)}/cancel`,
      {
        method: "POST",
        body: JSON.stringify({ confirmed: true }),
      }
    ),
  resume: (sessionId: string) =>
    request<Record<string, any>>(
      `/api/agent/runtime/hosted-sessions/${encodeURIComponent(sessionId)}/resume`,
      {
        method: "POST",
        body: JSON.stringify({ confirmed: true }),
      }
  ),
};

export const jobResearchApi = {
  runs: (params?: { job_id?: number; status?: string; limit?: number }) =>
    request<{ total: number; items: JobResearchRunSummary[] }>(
      `/api/research/job-runs?${buildQuery(params)}`
    ),
  run: (runId: string) =>
    request<JobResearchRunDetail>(
      `/api/research/job-runs/${encodeURIComponent(runId)}`
    ),
  review: (
    runId: string,
    data: { action: "accept" | "reject"; note?: string }
  ) =>
    request<JobResearchRunDetail>(
      `/api/research/job-runs/${encodeURIComponent(runId)}/review`,
      {
        method: "POST",
        body: JSON.stringify(data),
      }
  ),
};

export const resumeOptimizationApi = {
  list: (jobId: number, params?: { status?: string; limit?: number }) =>
    request<{ total: number; items: ResumeOptimizationProposalSummary[] }>(
      `/api/optimize/proposals?${buildQuery({ job_id: jobId, ...params })}`
    ),
  detail: (proposalId: string) =>
    request<ResumeOptimizationProposalDetail>(
      `/api/optimize/proposals/${encodeURIComponent(proposalId)}`
    ),
  review: (
    proposalId: string,
    data: { action: "accept" | "reject"; note?: string }
  ) =>
    request<ResumeOptimizationProposalDetail>(
      `/api/optimize/proposals/${encodeURIComponent(proposalId)}/review`,
      {
        method: "POST",
        body: JSON.stringify(data),
      }
    ),
};

export const preApplicationApi = {
  state: (jobId: number) =>
    request<PreApplicationState>(`/api/research/pre-application/${jobId}`),
  prepare: (jobId: number, researchRunId?: string | null) =>
    request<PreApplicationDecisionRecord>(
      `/api/research/pre-application/${jobId}/prepare`,
      {
        method: "POST",
        body: JSON.stringify({ research_run_id: researchRunId || null }),
      }
    ),
  review: (
    decisionId: string,
    data: {
      final_decision: PreApplicationDecisionChoice;
      note?: string;
    }
  ) =>
    request<PreApplicationDecisionRecord>(
      `/api/research/pre-application/decisions/${encodeURIComponent(decisionId)}/review`,
      {
        method: "POST",
        body: JSON.stringify(data),
      }
    ),
};

export const agentSupportApi = {
  conversations: () =>
    request<{ conversations: AgentConversationSummary[] }>("/api/agent/conversations"),
  conversation: (id: string) =>
    request<AgentConversationDetail>(`/api/agent/conversations/${encodeURIComponent(id)}`),
  deleteConversation: (id: string) =>
    request<{ ok: boolean }>(`/api/agent/conversations/${encodeURIComponent(id)}`, {
      method: "DELETE",
    }),
  exportMemory: (format: "json" | "markdown" = "json") =>
    request<{ format: string; content: any; memory: AgentMemorySnapshot }>(
      `/api/agent/memory/export?${buildQuery({ format })}`
    ),
  importMemory: (content: Record<string, any> | string) =>
    request<{ ok: boolean; memory: AgentMemorySnapshot }>("/api/agent/memory/import", {
      method: "POST",
      body: JSON.stringify({ content }),
    }),
  skills: () =>
    request<{ skills: AgentSkill[] }>("/api/agent/skills"),
};

export interface UserDataExport {
  schema_version: string;
  exported_at: string;
  scope: string;
  redactions: string[];
  counts: Record<string, number>;
  data: Record<string, unknown[]>;
}

export interface DataSafetyStatus {
  database: { exists: boolean; filename: string };
  backup_count: number;
  invalid_backup_count: number;
  pending_restore: {
    backup_id: string;
    staged_at: string;
    pending_restart: boolean;
  } | null;
  storage_mode: "managed_local" | string;
}

export interface DataIntegrityReport {
  status: "ok" | "failed" | string;
  integrity_check: string[];
  foreign_key_violations: unknown[][];
  schema: { user_version: number; schema_version: number };
  checked_at: string;
}

export interface DataBackupItem {
  backup_id: string;
  version: string;
  schema: { user_version: number; schema_version: number };
  hash: string;
  created_at: string;
  reason: "user" | "pre_restore" | "pre_migration" | string;
  size_bytes: number;
}

export interface DataBackupList {
  items: DataBackupItem[];
  invalid: { backup_id: string; error: string }[];
}

export const dataSafetyApi = {
  exportUserData: () => request<UserDataExport>("/api/agent/data/export"),
  resetDemoData: (confirmed: boolean) =>
    request<{
      reset: boolean;
      scope: { source: string; batch_id: string };
      matched_jobs?: number;
      reason?: string;
      deleted: Record<string, number>;
      real_data_preserved: boolean;
    }>("/api/agent/data/demo/reset", {
      method: "POST",
      body: JSON.stringify({ confirmed }),
    }),
  status: () => request<DataSafetyStatus>("/api/agent/data/safety/status"),
  checkIntegrity: () => request<DataIntegrityReport>("/api/agent/data/safety/integrity"),
  listBackups: () => request<DataBackupList>("/api/agent/data/backups"),
  createBackup: () => request<DataBackupItem & { archive_sha256: string }>("/api/agent/data/backups", {
    method: "POST",
  }),
  stageRestore: (backupId: string, confirmed: boolean) =>
    request<{ backup_id: string; staged_at: string; pending_restart: boolean; database_replaced: boolean }>(
      "/api/agent/data/restore",
      { method: "POST", body: JSON.stringify({ backup_id: backupId, confirmed }) },
    ),
  cancelRestore: (confirmed: boolean) =>
    request<{ cancelled: boolean; backup_id?: string; backup_preserved?: boolean }>(
      "/api/agent/data/restore/cancel",
      { method: "POST", body: JSON.stringify({ confirmed }) },
    ),
};

// ---- Profile API ----
export interface ProfileAgentPatch {
  action: "ask_user" | "propose_patch" | "apply_patch" | "generate_resume" | "finish";
  assistant_message: string;
  base_info: Record<string, string>;
  target_roles: string[];
  sections: {
    section_type: string;
    category_label?: string;
    title: string;
    content_json: Record<string, any>;
    confidence: number;
  }[];
  next_question?: string;
  confidence?: number;
}

export interface ProfileAgentResponse {
  session_id: number;
  state: Record<string, any>;
  assistant_message: string;
  patch: ProfileAgentPatch;
  agent_trace?: Record<string, any>[];
  stop_reason?: string;
}

export interface ProfileAgentSessionDetail {
  id: number;
  status: string;
  state: Record<string, any>;
  pending_patch?: ProfileAgentPatch | null;
  messages_json: Record<string, any>[];
}

export const profileApi = {
  get: () => request("/api/profile/"),

  update: (data: any) =>
    request("/api/profile/", { method: "PUT", body: JSON.stringify(data) }),

  listTargetRoles: () => request("/api/profile/target-roles"),

  createTargetRole: (data: { role_name: string; role_level?: string; fit?: string }) =>
    request("/api/profile/target-roles", { method: "POST", body: JSON.stringify(data) }),

  // 兼容旧组件调用签名
  addTargetRole: (data: { title: string; fit_level?: string; role_level?: string }) =>
    request("/api/profile/target-roles", {
      method: "POST",
      body: JSON.stringify({
        role_name: data.title,
        role_level: data.role_level,
        fit: data.fit_level || "primary",
      }),
    }),

  deleteTargetRole: (id: number) =>
    request(`/api/profile/target-roles/${id}`, { method: "DELETE" }),

  createSection: (data: any) =>
    request("/api/profile/sections", { method: "POST", body: JSON.stringify(data) }),

  updateSection: (id: number, data: any) =>
    request(`/api/profile/sections/${id}`, { method: "PUT", body: JSON.stringify(data) }),

  deleteSection: (id: number) =>
    request(`/api/profile/sections/${id}`, { method: "DELETE" }),

  chat: async (data: { topic: string; message: string; session_id?: number }) => {
    if (SHOWCASE) {
      // 展示模式：合成 SSE 流（本地模板或浏览器直连 LLM），不依赖 Python 后端
      return showcaseChatResponse(data.topic || "general", data.message || "");
    }
    const res = await fetch(`${API_BASE}/api/profile/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
    if (!res.ok) throw new Error(`API Error: ${res.status}`);
    return res;
  },

  importResume: async (file: File, parseMode: "ai" | "mechanical" = "ai") => {
    const formData = new FormData();
    formData.append("file", file);
    const params = new URLSearchParams({ parse_mode: parseMode });
    const res = await fetch(`${API_BASE}/api/profile/import-resume?${params.toString()}`, {
      method: "POST",
      body: formData,
    });
    if (!res.ok) throw new Error(`API Error: ${res.status}`);
    return res.json();
  },

  listChatSessions: (limit = 20) =>
    request(`/api/profile/chat/sessions?limit=${limit}`),

  getChatSession: (sessionId: number) =>
    request(`/api/profile/chat/sessions/${sessionId}`),

  confirmBullet: (data: { session_id: number; bullet_index: number; edits?: Record<string, any> }) =>
    request("/api/profile/chat/confirm", { method: "POST", body: JSON.stringify(data) }),

  instantDraft: (data: { experiences: string[]; target_roles?: string[] }) =>
    request("/api/profile/instant-draft", { method: "POST", body: JSON.stringify(data) }),

  generateNarrative: () =>
    request("/api/profile/generate-narrative", { method: "POST" }),

  startProfileAgent: async (data: {
    file?: File | null;
    resume_text?: string;
    target_role?: string;
    target_city?: string;
    job_goal?: string;
  }): Promise<ProfileAgentResponse> => {
    const formData = new FormData();
    if (data.file) formData.append("file", data.file);
    formData.append("resume_text", data.resume_text || "");
    formData.append("target_role", data.target_role || "");
    formData.append("target_city", data.target_city || "");
    formData.append("job_goal", data.job_goal || "");

    const res = await fetch(`${API_BASE}/api/profile/agent/start`, {
      method: "POST",
      body: formData,
    });
    if (!res.ok) throw new Error(`API Error: ${res.status}`);
    return res.json();
  },

  sendProfileAgentMessage: (data: { session_id: number; message: string }) =>
    request<ProfileAgentResponse>("/api/profile/agent/message", {
      method: "POST",
      body: JSON.stringify(data),
    }),

  getProfileAgentSession: (sessionId: number) =>
    request<ProfileAgentSessionDetail>(`/api/profile/agent/sessions/${sessionId}`),

  applyProfileAgentPatch: (data: { session_id: number; patch?: ProfileAgentPatch }) =>
    request("/api/profile/agent/apply-patch", {
      method: "POST",
      body: JSON.stringify(data),
    }),
};

// ---- Career Model & Memory Ledger API（ADR-0048）----
export interface CareerModelEntry {
  id: number;
  section_type: string;
  title: string;
  content_json: Record<string, any>;
  tier: string | null;
  sort_order: number;
  status: string;
  invalidated_at: string | null;
  superseded_by_id: number | null;
  source_status: string;
  source_count: number;
  created_at: string;
  updated_at: string;
}

export interface MemoryInboxItem {
  id: number;
  proposal_key: string;
  target_tier: string;
  section_type: string;
  title: string;
  before: Record<string, any>;
  after: Record<string, any>;
  reason: string;
  impact: string[];
  status: string;
  applied_profile_section_id: number | null;
  supersedes_proposal_id: number | null;
  applied_at: string | null;
  review_note: string;
  evidence: Array<{
    link_id: number;
    active: boolean;
    observation: {
      id: number;
      observation_type: string;
      content: Record<string, any>;
      status: string;
      source: { id: number; source_type: string; title: string; status: string; locator: string };
    };
  }>;
  created_at: string;
  updated_at: string;
  reviewed_at: string | null;
  invalidated_at: string | null;
}

export interface CareerLedgerEntry extends MemoryInboxItem {
  applied_section: {
    id: number;
    section_type: string;
    title: string;
    tier: string | null;
    status: string;
    invalidated_at: string | null;
    superseded_by_id: number | null;
  } | null;
}

export const memoryApi = {
  inbox: (params?: { status?: string; limit?: number }) =>
    request<{ items: MemoryInboxItem[] }>(
      `/api/memory/inbox?${buildQuery(params)}`
    ),

  ledger: (params?: { status?: string; limit?: number }) =>
    request<{ entries: CareerLedgerEntry[] }>(
      `/api/memory/ledger?${buildQuery(params)}`
    ),

  careerModel: () =>
    request<{
      profile_id: number | null;
      derived_at: string;
      entries: CareerModelEntry[];
      by_tier: Record<string, CareerModelEntry[]>;
      invalidated_entries: CareerModelEntry[];
    }>("/api/memory/career-model"),

  reviewProposal: (proposalId: number, action: string, note = "") =>
    request<MemoryInboxItem>(`/api/memory/proposals/${proposalId}/review`, {
      method: "POST",
      body: JSON.stringify({ action, note }),
    }),
};
