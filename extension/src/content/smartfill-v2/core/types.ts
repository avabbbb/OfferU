// ===== UI State Types (preserved from V1) =====
export type SmartFillStatus = "idle" | "running" | "preview" | "success" | "partial" | "failed";

export interface SmartFillUiState {
  status: SmartFillStatus;
  statusText: string;
  subText: string;
  filledCount: number;
  pendingCount: number;
  busy: boolean;
  checklistData: ChecklistItem[];
}

export interface ChecklistItem {
  fieldId: string;
  title: string;
  resolved: boolean;
  reason: string;
}

// ===== Control Types =====
export type ControlType =
  | "input"
  | "textarea"
  | "select"
  | "checkbox"
  | "radio"
  | "contenteditable"
  | "combobox"
  | "date-picker"
  | "date-range-picker"
  | "cascader"
  | "file-upload"
  | "rich-text"
  | "custom";

export type FrameworkHint =
  | "antd"
  | "element-ui"
  | "arco"
  | "kuma"
  | "bootstrap"
  | "iview"
  | "atsx"
  | "brick"
  | "fusion-next"
  | "feishu-ud"
  | "native"
  | "unknown";

export const WEAK_FIELD_LABELS = /^(时间|日期|开始时间|结束时间|起止时间|名称|描述|职责|内容|证明人|开始|结束)$/;

// ===== Field Types =====
export interface ScannedField {
  fieldId: string;
  element: HTMLElement;
  cssPath: string;
  controlType: ControlType;
  frameworkHint: FrameworkHint;
  label: string;
  labelSource?: string;
  semanticLabel: string;
  moduleName: string;
  level1Title?: string;
  level2Title?: string;
  repeatGroupIndex?: number;
  structureToken?: string;
  qualifiedLabel?: string;
  canonicalKey: string;
  placeholder: string;
  name: string;
  options: FieldOption[];
  isRequired: boolean;
  nearbyText: string;
  groupSignature: string;
  structuralHash: string;
  qualityScore: number;
  runtime: FieldRuntime;
  repeatItemRoot?: HTMLElement;
  occurrenceKey?: string;
  occurrenceIndex?: number;
  occurrenceTotal?: number;
}

export interface FieldOption {
  text: string;
  value: string;
  selected: boolean;
}

export interface FieldRuntime {
  failureReason?: string;
  existingValue?: string;
  writable: boolean;
  editScopeOpen?: boolean;
  surfaceRole?: "native" | "complex-host" | "display-input";
  displayInput?: HTMLInputElement | HTMLTextAreaElement;
  hiddenStateInput?: HTMLInputElement;
  hostElement?: HTMLElement;
}

// ===== Field Intent Types =====
export type FieldIntent = string;

export interface IntentMatch {
  intent: FieldIntent;
  confidence: number;
  strategy: "direct-label" | "ats-alias" | "equality-group" | "semantic-bucket" | "regex" | "ai-proposal";
  moduleContext?: string;
}

// ===== Profile Types =====
export interface ProfileEntry {
  key?: string;
  path?: string;
  label: string;
  value: string;
  category: string;
  subsection: string;
  aliases: string[];
  index: number;
  itemIndex?: number;
  valueType?: ProfileValueType;
  sectionType?: string;
  sourceRef?: string;
}

export interface NormalizedProfile {
  profileVersion: string;
  entries: ProfileEntry[];
  availableCount: number;
}

export interface ProfileFieldEntry {
  intent: FieldIntent;
  value: string;
  index: number;
  key?: string;
  path?: string;
  category?: string;
  subsection?: string;
  itemIndex?: number;
  aliases?: string[];
  valueType?: ProfileValueType;
}

export type ProfileValueType =
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

export interface ProfileCatalogItem {
  key: string;
  path: string;
  label: string;
  categoryKey: string;
  categoryLabel: string;
  sectionType: string;
  itemIndex?: number;
  value: string;
  valueType: ProfileValueType;
  aliases: string[];
  sourceRef: string;
  signature: string;
}

// ===== Match Types =====
export interface MatchCandidate {
  fieldId: string;
  value: string;
  confidence: number;
  intent: FieldIntent;
  source: "rule" | "ai" | "field-map";
  occurrenceIndex: number;
  profilePath?: string;
  catalogKey?: string;
  valueType?: ProfileValueType;
  transform?: AiValueTransform;
  reason?: string;
}

export interface OccurrenceCursor {
  intent: FieldIntent;
  values: string[];
  index: number;
}

// ===== Write Types =====
export type RecoveryStep = "direct" | "cssPath" | "metadata-refind" | "open-edit-scope" | "specialized-control" | "none";

export interface WriteResult {
  fieldId: string;
  written: boolean;
  verified: boolean;
  failureReason?: string;
  recovered: boolean;
  recoveryPath: RecoveryStep[];
}

export type CriticalPlanSkipReason =
  | "not_critical"
  | "sensitive"
  | "low_confidence"
  | "existing_value"
  | "unsupported_control";

export interface CriticalPlanItem {
  field: ScannedField;
  candidate: MatchCandidate;
  label: string;
  valuePreview: string;
}

export interface CriticalPlanSkippedItem {
  field: ScannedField;
  label: string;
  reason: CriticalPlanSkipReason;
}

export interface CriticalSmartFillPlan {
  pageUrl: string;
  createdAt: number;
  adapterId: string;
  adapterName: string;
  adapterConfidence: number;
  aiUsed: boolean;
  scannedFields: ScannedField[];
  items: CriticalPlanItem[];
  skipped: CriticalPlanSkippedItem[];
}

// ===== Result Types =====
export interface SmartFillOutcome {
  scannedFields: ScannedField[];
  results: WriteResult[];
  filledCount: number;
  matchedCount: number;
  pendingFields: ScannedField[];
  pendingCount: number;
  skippedCount: number;
  protectedCount: number;
  requiredTotal: number;
  requiredFilled: number;
  submitReadiness: boolean;
  aiUsed: boolean;
  aiChannel: "plugin-direct" | "backend" | "none";
}

// ===== Pipeline Types =====
export type PipelineStage = "detect" | "expand" | "addEntries" | "scan" | "profile" | "match" | "write" | "verify";

export interface PipelineProgress {
  stage: PipelineStage;
  detail: string;
  percent: number;
}

export interface PipelineOptions {
  signal?: AbortSignal;
  onProgress?: (progress: PipelineProgress) => void;
}

export interface CriticalPlanResult {
  plan: CriticalSmartFillPlan;
  outcome?: SmartFillOutcome;
}

export interface PipelineResult {
  fields: ScannedField[];
  outcome: SmartFillOutcome;
  adapterId: string;
  adapterName: string;
  adapterConfidence: number;
  aiUsed: boolean;
  runId?: string;
}

// ===== ATS Types =====
export interface DetectionSignal {
  type: "url-pattern" | "meta-tag" | "dom-signature" | "script-src" | "css-class";
  value: string;
  weight: number;
}

export interface DetectionResult {
  adapterId: string;
  adapterName: string;
  confidence: number;
  matchedSignals: DetectionSignal[];
  capabilities: AtsCapabilities;
}

export interface AtsCapabilities {
  enableCssPathRecovery: boolean;
  enableMetadataRefind: boolean;
  enableEditScopeRecovery: boolean;
  enableSpecializedControlRetry: boolean;
  supportedFrameworks: FrameworkHint[];
  datePickerInteraction: boolean;
  cascaderInteraction: boolean;
  fileUploadAutomation: boolean;
  enableDynamicSectionExpansion: boolean;
  sectionExpandSelectors: Record<string, string>;
  forceNativeWrite: boolean;
  prototypeWritePreferred: boolean;
  verificationDelayMs: number;
  useCustomVerifier: boolean;
}

// ===== AI Types =====
export interface AiFieldMapping {
  fieldId: string;
  intent?: FieldIntent;
  category?: string;
  itemIndex?: number;
  profilePath?: string;
  catalogKey?: string;
  sourcePath?: string;
  resumePath?: string;
  value?: string;
  confidence: number;
  reason?: string;
  transform?: AiValueTransform;
}

export type AiValueTransform =
  | { type: "none" }
  | { type: "date_part"; part: "year" | "month" | "day" }
  | { type: "phone_part"; part: "countryCode" | "nationalNumber" }
  | { type: "boolean_choice"; trueValue: string; falseValue: string }
  | { type: "join"; separator: string };

export interface AiMappingRequest {
  fields: AiFieldCandidate[];
  pageUrl: string;
  profileSignature: string;
  adapterHint: string;
}

export interface AiFieldCandidate {
  fieldId: string;
  label: string;
  controlType: string;
  moduleName: string;
  level1Title?: string;
  level2Title?: string;
  repeatGroupIndex?: number;
  structureToken?: string;
  qualifiedLabel?: string;
  nearbyText: string;
  options: string[];
  isRequired: boolean;
}

export interface CacheKeyData {
  host: string;
  fieldStructureHash: string;
  profileSignature: string;
  modelSignature: string;
}

export interface CacheEntry {
  key: CacheKeyData;
  mappings: AiFieldMapping[];
  channel: string;
  createdAt: number;
  ttl: number;
}

// ===== Configuration =====
export interface SmartFillConfig {
  scan: {
    retryLimit: number;
    retryDelayMs: number;
    maxEditExpansions: number;
    expansionDelayMs: number;
    maxShadowDepth: number;
    maxDedupeCandidates: number;
  };
  match: {
    ruleConfidenceThreshold: number;
    aiConfidenceThreshold: number;
    minAcceptableConfidence: number;
    maxOccurrenceLookahead: number;
  };
  write: {
    comboBoxOptionLookupAttempts: number;
    comboBoxOptionRetryDelayMs: number;
    searchInputAttempts: number;
    searchInputDelayMs: number;
    cascaderLevelDelayMs: number;
    datePanelOpenDelayMs: number;
    verificationDelayMs: number;
    throttleBetweenWritesMs: number;
  };
  ai: {
    slowHintTimeoutMs: number;
    requestTimeoutMs: number;
    cacheTtlMs: number;
    cacheMaxEntries: number;
  };
  ats: {
    detectionStrategy: "layered" | "url-only" | "html-scan";
    htmlScanMaxBytes: number;
  };
}
