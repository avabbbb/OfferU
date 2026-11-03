import type { PageSnapshot } from "./background/save-page-job.js";
// =============================================
// OfferU Extension — 共享类型定义
// =============================================

/** 插件设置 */
export interface ExtensionSettings {
  serverUrl: string; // OfferU 后端地址，默认 http://127.0.0.1:8766
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
  | { type: "SAVE_PAGE_AS_JOB"; page?: PageSnapshot };
