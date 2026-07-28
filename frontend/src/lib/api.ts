// =============================================
// API 客户端 — 统一的后端请求封装
// =============================================
// 所有前端组件通过此模块与后端通信
// 基于 fetch API，支持 SWR 缓存
// =============================================

const API_BASE =
  process.env.NEXT_PUBLIC_API_URL ||
  (typeof window !== "undefined"
    ? `${window.location.protocol}//${window.location.hostname}:8000`
    : "http://127.0.0.1:8000");

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
  if (!res.ok) throw new Error(`API Error: ${res.status}`);
  return res.json();
}

async function streamResult<T>(
  path: string,
  body: unknown,
  onEvent?: (event: string, data: any) => void
): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
    body: JSON.stringify(body),
  });
  if (res.status === 404 || res.status === 405) throw new Error("__SSE_UNAVAILABLE__");
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

  // 模板
  templates: () => request("/api/resume/templates"),
};

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

// ---- Harness Agent API ----
export interface HarnessAgentMessage {
  role: "user" | "assistant";
  content: string;
}

export interface HarnessAgentToolCall {
  tool: string;
  args: Record<string, unknown>;
  result: unknown;
  action_id?: string;
}

export interface HarnessAgentProposedAction {
  id: string;
  tool: string;
  summary: string;
  risk_level: "read" | "write" | "confirm";
  requires_confirmation: boolean;
  args: Record<string, unknown>;
}

export interface HarnessAgentSkill {
  id: string;
  name: string;
  group: string;
  status: "native" | "partial" | "planned" | string;
  description: string;
  featured: boolean;
  order: number;
  missing_capabilities: string[];
}

export interface HarnessAgentCareerPath {
  title: string;
  industry: string;
  fit_reason: string;
  entry_route: string;
  salary_range: string;
  search_keywords: string[];
  application_strategy: string;
}

export interface HarnessAgentJobCard {
  id: number;
  title: string;
  company: string;
  location: string;
  salary_text: string;
  source: string;
  apply_url: string;
  summary?: string;
}

export interface HarnessAgentAlert {
  code: string;
  severity: "low" | "medium" | "high" | string;
  title: string;
  message: string;
  action?: string;
}

export interface HarnessAgentProactiveSuggestion {
  title: string;
  description: string;
  prompt: string;
}

export interface HarnessAgentMemorySnapshot {
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

export interface HarnessAgentConversationSummary {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  message_count: number;
  last_message: string;
}

export interface HarnessAgentConversationDetail {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  messages: HarnessAgentMessage[];
}

export interface HarnessAgentResponse {
  assistant_message: string;
  mode: string;
  active_skill?: HarnessAgentSkill;
  requires_confirmation: boolean;
  tool_calls: HarnessAgentToolCall[];
  proposed_actions: HarnessAgentProposedAction[];
  career_paths?: HarnessAgentCareerPath[];
  job_cards?: HarnessAgentJobCard[];
  next_steps?: string[];
  transferable_skills_summary?: string;
  quick_wins?: string[];
  reality_check?: Record<string, any>;
  user_stage?: "unknown" | "campus" | "experienced" | string;
  stage_confidence?: number;
  stage_signals?: string[];
  memory_snapshot?: HarnessAgentMemorySnapshot;
  alerts?: HarnessAgentAlert[];
  proactive_suggestions?: HarnessAgentProactiveSuggestion[];
  conversation_id?: string;
  conversation_title?: string;
}

export const harnessAgentApi = {
  chat: async (data: {
    messages: HarnessAgentMessage[];
    confirmed_action_ids?: string[];
    memory?: Record<string, any>;
    conversation_id?: string | null;
    skill_id?: string | null;
  }, onEvent?: (event: string, data: any) => void) => {
    try {
      return await streamResult<HarnessAgentResponse>("/api/harness-agent/chat/stream", data, onEvent);
    } catch (error) {
      if (!(error instanceof Error) || error.message !== "__SSE_UNAVAILABLE__") throw error;
      return request<HarnessAgentResponse>("/api/harness-agent/chat", {
        method: "POST",
        body: JSON.stringify(data),
      });
    }
  },
  conversations: () =>
    request<{ conversations: HarnessAgentConversationSummary[] }>("/api/harness-agent/conversations"),
  conversation: (id: string) =>
    request<HarnessAgentConversationDetail>(`/api/harness-agent/conversations/${encodeURIComponent(id)}`),
  deleteConversation: (id: string) =>
    request<{ ok: boolean }>(`/api/harness-agent/conversations/${encodeURIComponent(id)}`, {
      method: "DELETE",
    }),
  exportMemory: (format: "json" | "markdown" = "json") =>
    request<{ format: string; content: any; memory: HarnessAgentMemorySnapshot }>(
      `/api/harness-agent/memory/export?${buildQuery({ format })}`
    ),
  importMemory: (content: Record<string, any> | string) =>
    request<{ ok: boolean; memory: HarnessAgentMemorySnapshot }>("/api/harness-agent/memory/import", {
      method: "POST",
      body: JSON.stringify({ content }),
    }),
  skills: () =>
    request<{ skills: HarnessAgentSkill[] }>("/api/harness-agent/skills"),
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
