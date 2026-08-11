// =============================================
// SiteRulePack v1 — 类型契约
// 事实源：docs/architecture/site-rule-pack-v1.md
// 规则是数据；复杂控件行为是扩展内置 ControlDriver 代码。
// =============================================

export type RulePackStatus = "experimental" | "verified" | "disabled";

export type PageKind = "job-list" | "job-detail" | "application-form" | "submission-receipt";

export type CapabilityId =
  | "read-job-list"
  | "read-job-detail"
  | "scan-form"
  | "write-native-text"
  | "write-native-select"
  | "write-known-combobox"
  | "write-known-date"
  | "read-submission-receipt";

/** v1 允许的已知控件驱动；未知 Driver 一律 schema 失败 */
export type DriverId = "native" | "antd" | "element" | "moka" | "beisen" | "feishu";

export type NormalizerId =
  | "trim"
  | "collapse-space"
  | "absolute-url"
  | "strip-label-prefix"
  | "iso-date-if-unambiguous";

export type SelectorStability = "semantic" | "vendor-stable" | "fragile";
export type SelectorScope = "document" | "page-root" | "item" | "section" | "field";

export type ReadMode = "text" | "href" | "datetime" | "attribute" | "texts";
export type AttributeName = "content" | "data-id" | "data-job-id" | "aria-label";

// ---------- Host 与 URL ----------

export interface HostRule {
  kind: "exact" | "suffix";
  value: string;
}

// ---------- Selector ----------

export interface SelectorCandidateV1 {
  css: string;
  stability: SelectorStability;
}

export interface SelectorSetV1 {
  scope: SelectorScope;
  candidates: SelectorCandidateV1[];
  required: boolean;
  maxMatches: number;
}

// ---------- 检测信号 ----------

export type DetectionSignalType = "path-glob" | "title-token" | "meta-token" | "script-host" | "css-exists";

export interface DetectionSignalV1 {
  id: string;
  type: DetectionSignalType;
  polarity: "positive" | "negative";
  value: string;
  weight: number;
  /** 只允许 negative signal；命中即整条 page rule 拒绝 */
  veto?: boolean;
}

export interface MatchRuleV1 {
  minScore: number;
  minPositiveSignals: number;
  ambiguityMargin: number;
  signals: DetectionSignalV1[];
}

// ---------- 读取与归一化 ----------

export interface ReadRuleV1 {
  selectors: SelectorSetV1;
  mode: ReadMode;
  /** 只在 mode=attribute 时存在，且只能取白名单属性 */
  attribute?: AttributeName;
  normalize: NormalizerId[];
}

export interface JobFieldRulesV1 {
  title: ReadRuleV1;
  company: ReadRuleV1;
  description: ReadRuleV1;
  location?: ReadRuleV1;
  salary?: ReadRuleV1;
  applyUrl?: ReadRuleV1;
  postedAt?: ReadRuleV1;
  tags?: ReadRuleV1;
  companyTags?: ReadRuleV1;
  sourceId?: ReadRuleV1;
}

export interface JobListRuleV1 {
  root?: SelectorSetV1;
  /** item 是唯一跨字段边界，字段必须在 item scope 内解析 */
  item: SelectorSetV1;
  itemId?: ReadRuleV1;
  fields: JobFieldRulesV1;
}

export interface JobDetailRuleV1 {
  root?: SelectorSetV1;
  fields: JobFieldRulesV1;
}

// ---------- 表单结构 ----------

export interface SectionRuleV1 {
  section: SelectorSetV1;
  heading: SelectorSetV1;
}

export interface RepeatRuleV1 {
  item: SelectorSetV1;
  heading?: SelectorSetV1;
  countMarker?: SelectorSetV1;
  order: "dom" | "reverse-dom";
}

export interface IntentAliasRuleV1 {
  canonicalIntent: string;
  aliases: string[];
  sectionHint?: string;
}

export type ControlSelectorRole =
  | "host"
  | "display-input"
  | "popup"
  | "option"
  | "search-input"
  | "tree-root"
  | "tree-node"
  | "tree-label"
  | "tree-expander"
  | "calendar-panel"
  | "date-cell";

/**
 * 按 driverId 区分的严格 union：
 * - native：禁止任何额外 role；
 * - antd/element/moka/beisen：必需 host/popup/option，search-input 可选，其余禁止；
 * - feishu：必需 host/popup/option；声明任一 tree-* 必须集齐全部 4 个 tree role；
 *   声明 calendar-panel 或 date-cell 必须两者都有；其余禁止。
 */
export type ControlBindingV1 =
  | {
      id: string;
      when: SelectorSetV1;
      driverId: "native";
      selectors?: never;
    }
  | {
      id: string;
      when: SelectorSetV1;
      driverId: "antd" | "element" | "moka" | "beisen";
      selectors: {
        host: SelectorSetV1;
        popup: SelectorSetV1;
        option: SelectorSetV1;
        "search-input"?: SelectorSetV1;
      };
    }
  | {
      id: string;
      when: SelectorSetV1;
      driverId: "feishu";
      selectors: {
        host: SelectorSetV1;
        popup: SelectorSetV1;
        option: SelectorSetV1;
        "search-input"?: SelectorSetV1;
        "tree-root"?: SelectorSetV1;
        "tree-node"?: SelectorSetV1;
        "tree-label"?: SelectorSetV1;
        "tree-expander"?: SelectorSetV1;
        "calendar-panel"?: SelectorSetV1;
        "date-cell"?: SelectorSetV1;
      };
    };

export interface FormRuleV1 {
  root: SelectorSetV1;
  fieldCandidates: SelectorSetV1;
  fieldContainer?: SelectorSetV1;
  labels: SelectorSetV1[];
  sections?: SectionRuleV1;
  repeats?: RepeatRuleV1;
  ignore?: SelectorSetV1;
  aliases: IntentAliasRuleV1[];
  controls: ControlBindingV1[];
}

// ---------- 提交回执 ----------

export type ReceiptSignalV1 =
  | { type: "path-glob"; value: string; weight: number; veto?: boolean }
  | { type: "title-token"; value: string; weight: number; veto?: boolean }
  | { type: "css-exists"; value: SelectorSetV1; weight: number; veto?: boolean }
  | { type: "visible-token"; value: string; weight: number; veto?: boolean };

export interface ReceiptSignalGroupV1 {
  id: string;
  anyOf: ReceiptSignalV1[];
}

export interface ReceiptRuleV1 {
  requiresActiveFillSession: true;
  minScore: number;
  minPositiveGroups: number;
  positiveGroups: ReceiptSignalGroupV1[];
  negativeSignals: ReceiptSignalV1[];
  evidence: {
    applicationId?: ReadRuleV1;
    company?: ReadRuleV1;
    role?: ReadRuleV1;
  };
}

// ---------- PageRule ----------

export interface PageRuleV1 {
  id: string;
  kind: PageKind;
  match: MatchRuleV1;
  capabilities: CapabilityId[];
  jobList?: JobListRuleV1;
  jobDetail?: JobDetailRuleV1;
  form?: FormRuleV1;
  receipt?: ReceiptRuleV1;
}

// ---------- Fixture 与 provenance ----------

export interface FixtureRefV1 {
  id: string;
  pageKind: PageKind;
  role: "positive" | "near-negative" | "conflict";
  path: string;
  sanitized: true;
  expectedRuleId?: string;
}

export interface ProvenanceV1 {
  owner: "offeru";
  method: "first-party" | "clean-room";
  capturedFrom: "public-page" | "user-authorized-page" | "synthetic";
  notesPath: string;
  lastVerifiedAt?: string;
}

// ---------- 顶层 pack ----------

export interface SiteRulePackV1 {
  schemaVersion: "1";
  id: string;
  version: string;
  status: RulePackStatus;
  displayName: string;
  hosts: HostRule[];
  pages: PageRuleV1[];
  fixtures: FixtureRefV1[];
  provenance: ProvenanceV1;
}

// ---------- 解析结果（脱敏） ----------

export interface MatchedSignalEvidence {
  id: string;
  type: DetectionSignalType;
  polarity: "positive" | "negative";
  weight: number;
}

export interface RivalCandidateEvidence {
  packId: string;
  pageRuleId: string;
  score: number;
}

export interface DetectionEvidence {
  packId: string;
  packVersion: string;
  pageRuleId: string;
  matchedSignals: MatchedSignalEvidence[];
  score: number;
  positiveCount: number;
  rivalCandidates: RivalCandidateEvidence[];
  degradedReason?: "experimental" | "low-confidence" | "rule-error" | "budget-exceeded";
}

export interface ResolvedSiteAdapter {
  pack: SiteRulePackV1;
  pageRule: PageRuleV1;
}

export type ResolveOutcome =
  | { status: "unsupported"; evidence: DetectionEvidence | null }
  | {
      status: "ambiguous";
      evidence: DetectionEvidence;
      candidates: ResolvedSiteAdapter[];
    }
  | {
      status: "diagnostic-only";
      evidence: DetectionEvidence;
      adapter: ResolvedSiteAdapter;
      reason: "experimental" | "low-confidence" | "rule-error" | "budget-exceeded";
    }
  | {
      status: "verified";
      evidence: DetectionEvidence;
      adapter: ResolvedSiteAdapter;
    };
