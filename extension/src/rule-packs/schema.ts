// =============================================
// SiteRulePack v1 — schema 常量与格式约束
// =============================================

export const SCHEMA_VERSION = "1" as const;

/** pack id：^(portal|ats|employer|fixture)\.[a-z0-9-]+(\.[a-z0-9-]+)*$ */
export const PACK_ID_PATTERN = /^(portal|ats|employer|fixture)\.[a-z0-9-]+(\.[a-z0-9-]+)*$/;

/** 严格 SemVer（允许预发布与构建元数据） */
export const SEMVER_PATTERN = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;

/** host：小写 ASCII hostname，无 scheme/port/path/wildcard */
export const HOST_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;

/**
 * path-glob 只允许 /、字母数字、-_.、单段 * 与多段 **。
 * 不得包含正则元字符或空白。
 */
export const PATH_GLOB_PATTERN = /^[A-Za-z0-9/_*.\-]+$/;

export const HOST_MIN = 1;
export const HOST_MAX = 20;
export const PAGES_MIN = 1;
export const PAGES_MAX = 8;
export const SIGNALS_MAX = 12;
export const FIXTURES_MIN = 1;
export const CANDIDATES_MAX = 8;
export const CSS_MAX_LENGTH = 300;
export const MAX_MATCHES_MIN = 1;
export const MAX_MATCHES_MAX = 500;
export const WEIGHT_MIN = 1;
export const WEIGHT_MAX = 100;
export const DISPLAY_NAME_MAX = 80;
export const TOKEN_MAX_LENGTH = 200;
export const ALIASES_MAX = 20;
export const CONTROLS_MAX = 24;
export const LABELS_MAX = 8;
export const FIXTURES_PER_PAGEKIND_MAX = 12;

export const CAPABILITIES: Record<string, true> = {
  "read-job-list": true,
  "read-job-detail": true,
  "scan-form": true,
  "write-native-text": true,
  "write-native-select": true,
  "write-known-combobox": true,
  "write-known-date": true,
  "read-submission-receipt": true,
};

export const DRIVER_IDS: Record<string, true> = {
  native: true,
  antd: true,
  element: true,
  moka: true,
  beisen: true,
  feishu: true,
};

export const NORMALIZER_IDS: Record<string, true> = {
  trim: true,
  "collapse-space": true,
  "absolute-url": true,
  "strip-label-prefix": true,
  "iso-date-if-unambiguous": true,
};

export const SELECTOR_STABILITIES: Record<string, true> = {
  semantic: true,
  "vendor-stable": true,
  fragile: true,
};
export const SELECTOR_SCOPES: Record<string, true> = {
  document: true,
  "page-root": true,
  item: true,
  section: true,
  field: true,
};
export const READ_MODES: Record<string, true> = {
  text: true,
  href: true,
  datetime: true,
  attribute: true,
  texts: true,
};
export const ATTRIBUTE_NAMES: Record<string, true> = {
  content: true,
  "data-id": true,
  "data-job-id": true,
  "aria-label": true,
};

/** 每个 page kind 允许且只允许对应配置字段 */
export const PAGE_KIND_FIELD: Record<string, { must: string; forbid: string[] }> = {
  "job-list": { must: "jobList", forbid: ["jobDetail", "form", "receipt"] },
  "job-detail": { must: "jobDetail", forbid: ["jobList", "form", "receipt"] },
  "application-form": { must: "form", forbid: ["jobList", "jobDetail", "receipt"] },
  "submission-receipt": { must: "receipt", forbid: ["jobList", "jobDetail", "form"] },
};

/**
 * driverId → 允许的 selector role 集。
 * native 无额外 role；antd/element/moka/beisen 必需 host/popup/option（search-input 可选）；
 * feishu 另有 tree-*（集齐 4 个）与 calendar-panel/date-cell（成对出现）。
 */
export const DRIVER_ROLE_REQUIREMENTS: Record<
  string,
  { required: string[]; optional: string[] }
> = {
  native: { required: [], optional: [] },
  antd: { required: ["host", "popup", "option"], optional: ["search-input"] },
  element: { required: ["host", "popup", "option"], optional: ["search-input"] },
  moka: { required: ["host", "popup", "option"], optional: ["search-input"] },
  beisen: { required: ["host", "popup", "option"], optional: ["search-input"] },
  feishu: {
    required: ["host", "popup", "option"],
    optional: [
      "search-input",
      "tree-root",
      "tree-node",
      "tree-label",
      "tree-expander",
      "calendar-panel",
      "date-cell",
    ],
  },
};

/** feishu tree/date 的角色完整性约束 */
export const FEISHU_TREE_ROLES = ["tree-root", "tree-node", "tree-label", "tree-expander"] as const;
export const FEISHU_DATE_ROLES = ["calendar-panel", "date-cell"] as const;

/** 疑似 secret 检测（错误输出不回显原文） */
export const SECRET_PATTERNS: ReadonlyArray<RegExp> = [
  /\bsk-[A-Za-z0-9_-]{8,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /-----BEGIN [A-Z ]+-----/,
  /\bapi[_-]?key\s*[:=]\s*\S+/i,
  /\bpassword\s*[:=]\s*\S+/i,
  /\bsecret\s*[:=]\s*\S+/i,
];
