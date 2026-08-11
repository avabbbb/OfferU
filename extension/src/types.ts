// =============================================
// OfferU Extension — 共享类型定义
// =============================================

export type JobSource = "boss" | "liepin" | "zhaopin" | "shixiseng" | "linkedin" | "unknown";

export type JobStatus = "draft_pending_jd" | "ready_to_sync";

/** 从 DOM 中提取的单个岗位数据（插件本地结构） */
export interface ExtractedJob {
  version?: number;
  title: string;
  company: string;
  location: string;
  salary_text: string;
  salary_min: number | null;
  salary_max: number | null;
  raw_description: string;
  posted_at?: string | null;
  url: string;
  apply_url: string;
  source: JobSource;
  source_page_meta: string; // JSON 字符串，记录页面来源与采集上下文
  education: string;
  experience: string;
  job_type: string;
  company_size: string;
  company_industry: string;
  hash_key: string;
  status: JobStatus;
  created_at: string;
}

/** 插件设置 */
export interface ExtensionSettings {
  serverUrl: string; // OfferU 后端地址，默认 http://127.0.0.1:8765
}

export interface SmartFillAiSettings {
  enabled: boolean;
  provider: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  enableFallback: boolean;
  cacheTtlSeconds?: number;
  cacheMaxEntries?: number;
  cacheCrossDomainReuse?: boolean;
}

export interface SmartFillRuntimeStats {
  filledCount: number;
  pendingCount: number;
  failedCount: number;
  usedAi: boolean;
  channel: "plugin-direct" | "backend" | "none";
  updatedAt: string;
  errorCode?: string;
}

export interface SmartFillFieldCandidate {
  fieldId: string;
  label: string;
  semanticLabel?: string;
  moduleName?: string;
  level1Title?: string;
  level2Title?: string;
  repeatGroupIndex?: number;
  structureToken?: string;
  qualifiedLabel?: string;
  canonicalFieldKey?: string;
  placeholder: string;
  name: string;
  inputType: string;
  options: string[];
  required: boolean;
  nearbyText: string;
}

export type SmartFillProfileValueType =
  | "text"
  | "long-text"
  | "date"
  | "date-range"
  | "email"
  | "phone"
  | "url"
  | "id-number"
  | "number"
  | "choice"
  | "multi-choice"
  | "boolean";

export interface SmartFillCatalogItem {
  key: string;
  path: string;
  label: string;
  categoryKey: string;
  categoryLabel: string;
  sectionType: string;
  itemIndex?: number;
  valueType: SmartFillProfileValueType;
  aliases: string[];
  sourceRef: string;
  signature: string;
  value?: string;
}

export type SmartFillAiTransform =
  | { type: "none" }
  | { type: "date_part"; part: "year" | "month" | "day" }
  | { type: "phone_part"; part: "countryCode" | "nationalNumber" }
  | { type: "boolean_choice"; trueValue: string; falseValue: string }
  | { type: "join"; separator: string };

export interface SmartFillAiMapping {
  fieldId: string;
  profilePath?: string;
  catalogKey?: string;
  sourcePath?: string;
  resumePath?: string;
  value?: string;
  confidence: number;
  intent?: string;
  category?: string;
  itemIndex?: number;
  reason?: string;
  transform?: SmartFillAiTransform;
  source: "plugin-direct" | "backend";
}

export type SmartFillPipelineStage =
  | "scan"
  | "rule-seed"
  | "ai-map"
  | "write"
  | "recover"
  | "summary";

export type SmartFillLogSeverity = "info" | "warn" | "error";
export type SmartFillLogScope = "run" | "field" | "control";

export interface SmartFillRunLogEntry {
  stage: SmartFillPipelineStage;
  severity: SmartFillLogSeverity;
  scope: SmartFillLogScope;
  message: string;
  payload?: Record<string, unknown>;
  fieldId?: string;
  ts: string;
}

export interface StatusResponse {
  total: number;
  ready: number;
  draft: number;
  serverUrl: string;
}

export interface MergeResponse {
  added: number;
  upgraded: number;
  skipped: number;
}

export interface SyncResponse {
  ok: boolean;
  synced: number;
  skippedDraft: number;
  error?: string;
}

export interface RemoveResponse {
  ok: boolean;
  removed: number;
  remaining: number;
}

export interface ClipboardCopyResponse {
  ok: boolean;
  error?: string;
}

export interface ResumeListItem {
  id: number;
  user_name: string;
  title: string;
  photo_url?: string | null;
  source_mode?: string;
  created_at: string;
  updated_at: string;
}

export interface ResumeDetailSection {
  section_type: string;
  title: string;
  visible: boolean;
  content_json: Array<Record<string, unknown>>;
}

export interface ResumeDetail {
  id: number;
  user_name: string;
  title: string;
  summary: string;
  photo_url?: string | null;
  created_at: string;
  updated_at: string;
  sections: ResumeDetailSection[];
}

/** 消息类型：content script ↔ background */
export type Message =
  | { type: "JOBS_COLLECTED"; jobs: ExtractedJob[] }
  | { type: "SYNC_TO_SERVER" }
  | { type: "GET_STATUS" }
  | { type: "GET_JOBS" }
  | { type: "GET_SMART_FILL_PROFILE"; scope?: "full" | "critical" }
  | { type: "GET_SMART_FILL_SETTINGS" }
  | { type: "SAVE_SMART_FILL_SETTINGS"; settings: SmartFillAiSettings }
  | { type: "REQUEST_SMART_FILL_HOST_PERMISSION"; baseUrl: string }
  | { type: "CHECK_SMART_FILL_AI_CONNECTION" }
  | { type: "SMART_FILL_AI_MAP"; fields: SmartFillFieldCandidate[]; pageUrl?: string; catalog?: SmartFillCatalogItem[]; profileValues?: unknown[]; adapterHint?: string }
  | { type: "SMART_FILL_OPTION_MATCH"; candidates: string[]; resumeValue: string; level1Title: string; level2Title: string }
  | { type: "SMART_FILL_FIELD_MAP"; fragments: Array<{ module_name: string; field_label: string; item_index: number }> }
  | { type: "SMART_FILL_MODULE_COUNT" }
  | { type: "SMART_FILL_RUN_LOG"; runId: string; logs: SmartFillRunLogEntry[] }
  | { type: "COPY_IMAGE_TO_CLIPBOARD"; imageUrl: string }
  | { type: "OFFSCREEN_WRITE_IMAGE"; requestId: string; imageUrl: string }
  | { type: "OFFSCREEN_WRITE_IMAGE_RESULT"; requestId: string; ok: boolean; error?: string }
  | { type: "OPEN_DRAWER"; tab?: "cart" | "resumes" | "settings" }
  | { type: "REMOVE_JOB"; hashKey: string }
  | { type: "REMOVE_JOBS"; hashKeys: string[] }
  | { type: "CLEAR_JOBS" }
  | { type: "COLLECT_VIA_PAGE_AGENT" }
  | { type: "PAGE_AGENT_COLLECT"; url: string };

/** popup → background：规则包采集响应（fallback=true 表示可回退旧路径） */
export interface PageAgentCollectViaResponse {
  ok: boolean;
  message: string;
  status?: "collected" | "unsupported" | "ambiguous" | "diagnostic" | "error";
  fallback?: boolean;
}

/** 后端 /api/jobs/ingest 单条岗位结构 */
export interface IngestJobPayload {
  title: string;
  company: string;
  location: string;
  url: string;
  apply_url: string;
  source: string;
  raw_description: string;
  posted_at?: string | null;
  hash_key: string;
  salary_min: number | null;
  salary_max: number | null;
  salary_text: string;
  education: string;
  experience: string;
  job_type: string;
  company_size: string;
  company_industry: string;
}

/** 后端 /api/jobs/ingest 请求体 */
export interface IngestPayload {
  jobs: IngestJobPayload[];
  source: string;
  batch_id: string;
}

/** 鍚庣 /api/jobs/ingest 鍝嶅簲浣?*/
export interface IngestResponse {
  created?: number;
  skipped?: number;
  batch_id?: string;
  accepted_hash_keys?: string[];
  created_hash_keys?: string[];
  skipped_hash_keys?: string[];
  failed?: Array<{ hash_key?: string; error: string }>;
}
