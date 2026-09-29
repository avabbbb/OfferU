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
  exact: {
    bodySize: number;
    headingSize: number;
    nameSize: number;
    lineHeight: number;
    sectionGap: number;
    itemGap: number;
    paragraphGap: number;
    headerGap: number;
    headingColor: string;
    ruleColor: string;
    photoWidth: number;
    photoHeight: number;
    logoWidth: number;
    logoHeight: number;
  };
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
    name: "中文经典",
    description: "照片、校徽与横线分区，支持精确调整字号和间距。",
  },
  {
    id: "reference-compact",
    name: "中文经典·紧凑",
    description: "较紧凑的单栏排版，适合内容较多的简历。",
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
  exact: {
    bodySize: 10.5, headingSize: 12, nameSize: 16.5,
    lineHeight: 1.2, sectionGap: 6, itemGap: 2, paragraphGap: 0, headerGap: 9,
    headingColor: "#1D4ED8", ruleColor: "#000000",
    photoWidth: 23, photoHeight: 28, logoWidth: 50, logoHeight: 18,
  },
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
  const parsed = parseFloat(String(value));
  if (!Number.isFinite(parsed)) return fallback;
  const mm = String(value).endsWith("cm") ? parsed * 10 : parsed;
  return Math.max(3, Math.min(30, mm));
}

function numeric(value: unknown, fallback: number, min: number, max: number) {
  const parsed = value == null || value === "" ? NaN : parseFloat(String(value));
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
}

function color(value: unknown, fallback: string) {
  return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value) ? value : fallback;
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
  const reference = template === "reference" || template === "reference-compact";
  const accent = asAccent(config.accentColorName || config.accentColor);
  const base = DEFAULT_TEMPLATE_SETTINGS.exact;
  return {
    template,
    pageSize: config.pageSize === "LETTER" ? "LETTER" : "A4",
    margins: {
      top: parseMarginMm(config.marginTop ?? config.pageMargin, DEFAULT_TEMPLATE_SETTINGS.margins.top),
      right: parseMarginMm(config.marginRight ?? config.pageMargin, DEFAULT_TEMPLATE_SETTINGS.margins.right),
      bottom: parseMarginMm(config.marginBottom ?? config.pageMargin, DEFAULT_TEMPLATE_SETTINGS.margins.bottom),
      left: parseMarginMm(config.marginLeft ?? config.pageMargin, DEFAULT_TEMPLATE_SETTINGS.margins.left),
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
    accentColor: accent,
    exact: {
      bodySize: numeric(config.bodySize, config.fontSize ? parseFloat(FONT_SIZE_MAP[asSpacingLevel(config.fontSize, 2)]) : reference ? base.bodySize : 12, 8, 20),
      headingSize: numeric(config.headingSize, base.headingSize, 8, 28),
      nameSize: numeric(config.nameSize, base.nameSize, 10, 40),
      lineHeight: numeric(config.lineHeight, config.lineHeightLevel ? LINE_HEIGHT_MAP[asSpacingLevel(config.lineHeightLevel, 3)] : base.lineHeight, 1, 2),
      sectionGap: numeric(config.sectionGap, config.sectionSpacing ? parseFloat(SECTION_SPACING_MAP[asSpacingLevel(config.sectionSpacing, 3)]) * 12 : base.sectionGap, 0, 30),
      itemGap: numeric(config.itemGap, config.itemSpacing ? parseFloat(ITEM_SPACING_MAP[asSpacingLevel(config.itemSpacing, 2)]) * 12 : base.itemGap, 0, 20),
      paragraphGap: numeric(config.paragraphGap, base.paragraphGap, 0, 16),
      headerGap: numeric(config.headerGap, base.headerGap, 0, 30),
      headingColor: color(config.accentColorHex, color(config.accentColor, ACCENT_COLOR_MAP[accent].primary)),
      ruleColor: color(config.ruleColor, base.ruleColor),
      photoWidth: numeric(config.photoWidth, base.photoWidth, 10, 50),
      photoHeight: numeric(config.photoHeight, base.photoHeight, 10, 60),
      logoWidth: numeric(config.logoWidth, base.logoWidth, 10, 65),
      logoHeight: numeric(config.logoHeight, base.logoHeight, 5, 40),
    },
  };
}

export function settingsToCssVars(settings: ResumeTemplateSettings): CSSProperties {
  const compact = settings.compactMode ? 0.6 : 1;
  const accent = ACCENT_COLOR_MAP[settings.accentColor];
  return {
    "--section-gap": `${settings.exact.sectionGap * compact}pt`,
    "--item-gap": `${settings.exact.itemGap * compact}pt`,
    "--paragraph-gap": `${settings.exact.paragraphGap}pt`,
    "--header-gap": `${settings.exact.headerGap}pt`,
    "--line-height": settings.exact.lineHeight,
    "--font-size-base": `${settings.exact.bodySize}pt`,
    "--heading-size": `${settings.exact.headingSize}pt`,
    "--name-size": `${settings.exact.nameSize}pt`,
    "--photo-width": `${settings.exact.photoWidth}mm`,
    "--photo-height": `${settings.exact.photoHeight}mm`,
    "--logo-width": `${settings.exact.logoWidth}mm`,
    "--logo-height": `${settings.exact.logoHeight}mm`,
    "--page-width": settings.pageSize === "LETTER" ? "215.9mm" : "210mm",
    "--page-height": settings.pageSize === "LETTER" ? "279.4mm" : "297mm",
    "--rule-color": settings.exact.ruleColor,
    "--header-scale": HEADER_SCALE_MAP[settings.fontSize.headerScale],
    "--section-header-scale": SECTION_HEADER_SCALE_MAP[settings.fontSize.headerScale],
    "--header-font": FONT_MAP[settings.fontSize.headerFont],
    "--body-font": FONT_MAP[settings.fontSize.bodyFont],
    "--margin-top": `${settings.margins.top}mm`,
    "--margin-right": `${settings.margins.right}mm`,
    "--margin-bottom": `${settings.margins.bottom}mm`,
    "--margin-left": `${settings.margins.left}mm`,
    "--resume-accent-primary": settings.exact.headingColor,
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
    bodySize: String(settings.exact.bodySize),
    headingSize: String(settings.exact.headingSize),
    nameSize: String(settings.exact.nameSize),
    lineHeight: String(settings.exact.lineHeight),
    sectionGap: String(settings.exact.sectionGap),
    itemGap: String(settings.exact.itemGap),
    paragraphGap: String(settings.exact.paragraphGap),
    headerGap: String(settings.exact.headerGap),
    accentColorHex: settings.exact.headingColor,
    ruleColor: settings.exact.ruleColor,
    photoWidth: String(settings.exact.photoWidth),
    photoHeight: String(settings.exact.photoHeight),
    logoWidth: String(settings.exact.logoWidth),
    logoHeight: String(settings.exact.logoHeight),
  };
}
