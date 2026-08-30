import type { CSSProperties } from "react";

export type ResumeTemplateType =
  | "reference"
  | "reference-compact"
  | "swiss-single"
  | "swiss-two-column"
  | "modern"
  | "modern-two-column";
export type ResumePageSize = "A4" | "LETTER";
export type ResumeAccentColor = "blue" | "green" | "orange" | "red";
export type SpacingLevel = 1 | 2 | 3 | 4 | 5;

export interface ResumeTemplateSettings {
  template: ResumeTemplateType;
  pageSize: ResumePageSize;
  margins: {
    top: number;
    right: number;
    bottom: number;
    left: number;
  };
  spacing: {
    section: SpacingLevel;
    item: SpacingLevel;
    lineHeight: SpacingLevel;
  };
  fontSize: {
    base: SpacingLevel;
    headerScale: SpacingLevel;
    headerFont: "serif" | "sans-serif" | "mono";
    bodyFont: "serif" | "sans-serif" | "mono";
  };
  compactMode: boolean;
  showContactIcons: boolean;
  accentColor: ResumeAccentColor;
}

export interface NormalizedResumeItem {
  id: string;
  title: string;
  subtitle?: string;
  organization?: string;
  location?: string;
  date?: string;
  url?: string;
  descriptionHtml?: string;
  bullets: string[];
  tags?: string[];
}

export interface NormalizedResumeSection {
  id: number | string;
  key: string;
  title: string;
  visible: boolean;
  sortOrder: number;
  items: NormalizedResumeItem[];
}

export interface NormalizedResumeData {
  userName: string;
  title: string;
  photoUrl?: string;
  summary: string;
  summaryHtml?: string;
  contact: Record<string, string>;
  sections: NormalizedResumeSection[];
}

export const TEMPLATE_OPTIONS: Array<{
  id: ResumeTemplateType;
  name: string;
  description: string;
}> = [
  {
    id: "reference",
    name: "附件同款",
    description: "和你提供的 PDF 一致：照片、校徽、黑色正文、横线分区。",
  },
  {
    id: "reference-compact",
    name: "附件同款·紧凑",
    description: "保持附件样式，压缩段落间距，适合内容较多的简历。",
  },
  {
    id: "modern",
    name: "Modern",
    description: "清晰的现代单栏布局，适合 ATS 阅读。",
  },
  {
    id: "swiss-single",
    name: "Classic",
    description: "克制的经典单栏布局，突出经历层级。",
  },
  {
    id: "modern-two-column",
    name: "Compact",
    description: "双栏紧凑布局，适合信息密度较高的岗位版本。",
  },
];

export const DEFAULT_TEMPLATE_SETTINGS: ResumeTemplateSettings = {
  template: "reference",
  pageSize: "A4",
  margins: { top: 8, right: 8, bottom: 8, left: 8 },
  spacing: { section: 3, item: 2, lineHeight: 3 },
  fontSize: { base: 2, headerScale: 3, headerFont: "sans-serif", bodyFont: "sans-serif" },
  compactMode: false,
  showContactIcons: false,
  accentColor: "blue",
};

const SECTION_SPACING_MAP: Record<SpacingLevel, string> = {
  1: "0.375rem",
  2: "0.625rem",
  3: "1rem",
  4: "1.25rem",
  5: "1.5rem",
};

const ITEM_SPACING_MAP: Record<SpacingLevel, string> = {
  1: "0.125rem",
  2: "0.25rem",
  3: "0.5rem",
  4: "0.75rem",
  5: "1rem",
};

const LINE_HEIGHT_MAP: Record<SpacingLevel, number> = {
  1: 1.15,
  2: 1.25,
  3: 1.35,
  4: 1.45,
  5: 1.55,
};

const FONT_SIZE_MAP: Record<SpacingLevel, string> = {
  1: "10pt",
  2: "12pt",
  3: "14pt",
  4: "15pt",
  5: "16pt",
};

const HEADER_SCALE_MAP: Record<SpacingLevel, number> = {
  1: 1.5,
  2: 1.75,
  3: 2,
  4: 2.25,
  5: 2.5,
};

const SECTION_HEADER_SCALE_MAP: Record<SpacingLevel, number> = {
  1: 1,
  2: 1.1,
  3: 1.2,
  4: 1.3,
  5: 1.4,
};

const FONT_MAP = {
  serif: 'ui-serif, Georgia, Cambria, "Times New Roman", Times, serif',
  "sans-serif": '"Microsoft YaHei", "SimHei", "Noto Sans CJK SC", Arial, sans-serif',
  mono: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
};

const ACCENT_COLOR_MAP: Record<ResumeAccentColor, { primary: string; light: string }> = {
  blue: { primary: "#1D4ED8", light: "#DBEAFE" },
  green: { primary: "#15803D", light: "#DCFCE7" },
  orange: { primary: "#EA580C", light: "#FED7AA" },
  red: { primary: "#DC2626", light: "#FEE2E2" },
};

function asSpacingLevel(value: unknown, fallback: SpacingLevel): SpacingLevel {
  const parsed = Number(value);
  if ([1, 2, 3, 4, 5].includes(parsed)) return parsed as SpacingLevel;
  return fallback;
}

function asTemplate(value: unknown): ResumeTemplateType {
  if (
    value === "reference" ||
    value === "reference-compact" ||
    value === "swiss-single" ||
    value === "swiss-two-column" ||
    value === "modern" ||
    value === "modern-two-column"
  ) {
    return value;
  }
  return DEFAULT_TEMPLATE_SETTINGS.template;
}

function asAccent(value: unknown): ResumeAccentColor {
  if (value === "blue" || value === "green" || value === "orange" || value === "red") return value;
  return DEFAULT_TEMPLATE_SETTINGS.accentColor;
}

function parseMarginMm(value: unknown, fallback: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(5, Math.min(25, parsed));
}

function bodySizeToLevel(value: unknown, fallback: SpacingLevel): SpacingLevel {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  if (parsed <= 11) return 1;
  if (parsed <= 13) return 2;
  if (parsed <= 14) return 3;
  if (parsed <= 15) return 4;
  return 5;
}

function headingSizeToLevel(value: unknown, fallback: SpacingLevel): SpacingLevel {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  if (parsed <= 11) return 1;
  if (parsed <= 13) return 2;
  if (parsed <= 15) return 3;
  if (parsed <= 17) return 4;
  return 5;
}

function gapToLevel(value: unknown, fallback: SpacingLevel): SpacingLevel {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  if (parsed <= 8) return 1;
  if (parsed <= 12) return 2;
  if (parsed <= 18) return 3;
  if (parsed <= 22) return 4;
  return 5;
}

function lineHeightToLevel(value: unknown, fallback: SpacingLevel): SpacingLevel {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  if (parsed <= 1.2) return 1;
  if (parsed <= 1.35) return 2;
  if (parsed <= 1.5) return 3;
  if (parsed <= 1.7) return 4;
  return 5;
}

export function normalizeTemplateSettings(config: Record<string, any> = {}): ResumeTemplateSettings {
  const rawTemplate = config.template || config.templateType;
  const template = asTemplate(rawTemplate);
  const isLegacyTemplate = rawTemplate !== "reference" && rawTemplate !== "reference-compact";
  return {
    template,
    pageSize: config.pageSize === "LETTER" ? "LETTER" : "A4",
    margins: {
      top: isLegacyTemplate ? DEFAULT_TEMPLATE_SETTINGS.margins.top : parseMarginMm(config.marginTop ?? config.pageMargin, DEFAULT_TEMPLATE_SETTINGS.margins.top),
      right: isLegacyTemplate ? DEFAULT_TEMPLATE_SETTINGS.margins.right : parseMarginMm(config.marginRight ?? config.pageMargin, DEFAULT_TEMPLATE_SETTINGS.margins.right),
      bottom: isLegacyTemplate ? DEFAULT_TEMPLATE_SETTINGS.margins.bottom : parseMarginMm(config.marginBottom ?? config.pageMargin, DEFAULT_TEMPLATE_SETTINGS.margins.bottom),
      left: isLegacyTemplate ? DEFAULT_TEMPLATE_SETTINGS.margins.left : parseMarginMm(config.marginLeft ?? config.pageMargin, DEFAULT_TEMPLATE_SETTINGS.margins.left),
    },
    spacing: {
      section: asSpacingLevel(
        config.sectionSpacing,
        gapToLevel(config.sectionGap, DEFAULT_TEMPLATE_SETTINGS.spacing.section),
      ),
      item: asSpacingLevel(config.itemSpacing, DEFAULT_TEMPLATE_SETTINGS.spacing.item),
      lineHeight: asSpacingLevel(
        config.lineHeightLevel,
        lineHeightToLevel(config.lineHeight, DEFAULT_TEMPLATE_SETTINGS.spacing.lineHeight),
      ),
    },
    fontSize: {
      base: asSpacingLevel(config.fontSize, bodySizeToLevel(config.bodySize, DEFAULT_TEMPLATE_SETTINGS.fontSize.base)),
      headerScale: asSpacingLevel(
        config.headerScale,
        headingSizeToLevel(config.headingSize, DEFAULT_TEMPLATE_SETTINGS.fontSize.headerScale),
      ),
      headerFont: config.headerFont === "sans-serif" || config.headerFont === "mono" ? config.headerFont : "serif",
      bodyFont: config.bodyFont === "serif" || config.bodyFont === "mono" ? config.bodyFont : "sans-serif",
    },
    compactMode: config.compactMode === true || config.compactMode === "true",
    showContactIcons: config.showContactIcons === true || config.showContactIcons === "true",
    accentColor: asAccent(config.accentColorName || config.accentColor),
  };
}

export function settingsToCssVars(settings: ResumeTemplateSettings): CSSProperties {
  const compact = settings.compactMode ? 0.6 : 1;
  const accent = ACCENT_COLOR_MAP[settings.accentColor];
  return {
    "--section-gap": settings.compactMode ? `calc(${SECTION_SPACING_MAP[settings.spacing.section]} * ${compact})` : SECTION_SPACING_MAP[settings.spacing.section],
    "--item-gap": settings.compactMode ? `calc(${ITEM_SPACING_MAP[settings.spacing.item]} * ${compact})` : ITEM_SPACING_MAP[settings.spacing.item],
    "--line-height": settings.compactMode ? LINE_HEIGHT_MAP[settings.spacing.lineHeight] * 0.92 : LINE_HEIGHT_MAP[settings.spacing.lineHeight],
    "--font-size-base": FONT_SIZE_MAP[settings.fontSize.base],
    "--header-scale": HEADER_SCALE_MAP[settings.fontSize.headerScale],
    "--section-header-scale": SECTION_HEADER_SCALE_MAP[settings.fontSize.headerScale],
    "--header-font": FONT_MAP[settings.fontSize.headerFont],
    "--body-font": FONT_MAP[settings.fontSize.bodyFont],
    "--margin-top": `${settings.margins.top}mm`,
    "--margin-right": `${settings.margins.right}mm`,
    "--margin-bottom": `${settings.margins.bottom}mm`,
    "--margin-left": `${settings.margins.left}mm`,
    "--resume-accent-primary": accent.primary,
    "--resume-accent-light": accent.light,
    "--reference-scale": settings.template === "reference-compact" ? 0.92 : 1,
  } as CSSProperties;
}

export function styleConfigFromSettings(settings: ResumeTemplateSettings): Record<string, string> {
  return {
    template: settings.template,
    pageSize: settings.pageSize,
    marginTop: String(settings.margins.top),
    marginRight: String(settings.margins.right),
    marginBottom: String(settings.margins.bottom),
    marginLeft: String(settings.margins.left),
    pageMargin: String(settings.margins.left),
    sectionSpacing: String(settings.spacing.section),
    itemSpacing: String(settings.spacing.item),
    lineHeightLevel: String(settings.spacing.lineHeight),
    fontSize: String(settings.fontSize.base),
    headerScale: String(settings.fontSize.headerScale),
    headerFont: settings.fontSize.headerFont,
    bodyFont: settings.fontSize.bodyFont,
    compactMode: String(settings.compactMode),
    showContactIcons: String(settings.showContactIcons),
    accentColorName: settings.accentColor,
  };
}
