import type { CSSProperties } from "react";

/**
 * 简历只有一个模板：「纸」。两种样式——「清晰」（默认，黑体紧凑，对标超级简历）和「留白」（Kami 风格宋体）。
 * 这里把 style_config 里的字符串解析成排版数值，并转成 .resume-body 上的 CSS 变量。
 */
export type ResumePageSize = "A4" | "LETTER";

export interface ResumeTemplateSettings {
  pageSize: ResumePageSize;
  margins: { top: number; right: number; bottom: number; left: number };
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

/** 「留白」：对齐 Kami resume.html（正文 9.2pt / 行高 1.42，姓名 26.5pt，墨蓝 #1B365D）。 */
const KAMI_EXACT: ResumeTemplateSettings["exact"] = {
  bodySize: 9.2, headingSize: 12.5, nameSize: 26.5,
  lineHeight: 1.42, sectionGap: 16, itemGap: 7, paragraphGap: 1, headerGap: 12,
  headingColor: "#1B365D", ruleColor: "#E8E6DC",
  photoWidth: 23, photoHeight: 28, logoWidth: 50, logoHeight: 18,
};
/** 「清晰」：黑体略大一号，间距更紧，一页放得下更多内容。 */
const CV_EXACT: ResumeTemplateSettings["exact"] = {
  ...KAMI_EXACT,
  bodySize: 9.5, lineHeight: 1.45, sectionGap: 9, itemGap: 4.5, paragraphGap: 1, headerGap: 6,
};
export const PAPER_MARGINS = { top: 11, right: 13, bottom: 11, left: 13 };

function numeric(value: unknown, fallback: number, min: number, max: number) {
  const parsed = value == null || value === "" ? NaN : parseFloat(String(value));
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
}

function color(value: unknown, fallback: string) {
  return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value) ? value : fallback;
}

export function normalizeTemplateSettings(config: Record<string, any> = {}): ResumeTemplateSettings {
  const base = config.paperStyle === "kami" ? KAMI_EXACT : CV_EXACT;
  const margin = (value: unknown, fallback: number) => numeric(value, fallback, 3, 30);
  return {
    pageSize: config.pageSize === "LETTER" ? "LETTER" : "A4",
    margins: {
      top: margin(config.marginTop, PAPER_MARGINS.top),
      right: margin(config.marginRight, PAPER_MARGINS.right),
      bottom: margin(config.marginBottom, PAPER_MARGINS.bottom),
      left: margin(config.marginLeft, PAPER_MARGINS.left),
    },
    exact: {
      bodySize: numeric(config.bodySize, base.bodySize, 8, 20),
      headingSize: numeric(config.headingSize, base.headingSize, 8, 28),
      nameSize: numeric(config.nameSize, base.nameSize, 10, 40),
      lineHeight: numeric(config.lineHeight, base.lineHeight, 1, 2),
      sectionGap: numeric(config.sectionGap, base.sectionGap, 0, 30),
      itemGap: numeric(config.itemGap, base.itemGap, 0, 20),
      paragraphGap: numeric(config.paragraphGap, base.paragraphGap, 0, 16),
      headerGap: numeric(config.headerGap, base.headerGap, 0, 30),
      headingColor: color(config.accentColorHex, base.headingColor),
      ruleColor: color(config.ruleColor, base.ruleColor),
      photoWidth: numeric(config.photoWidth, base.photoWidth, 10, 50),
      photoHeight: numeric(config.photoHeight, base.photoHeight, 10, 60),
      logoWidth: numeric(config.logoWidth, base.logoWidth, 10, 65),
      logoHeight: numeric(config.logoHeight, base.logoHeight, 5, 40),
    },
  };
}

export function settingsToCssVars(settings: ResumeTemplateSettings): CSSProperties {
  const { exact, margins } = settings;
  const letter = settings.pageSize === "LETTER";
  return {
    "--section-gap": `${exact.sectionGap}pt`,
    "--item-gap": `${exact.itemGap}pt`,
    "--paragraph-gap": `${exact.paragraphGap}pt`,
    "--header-gap": `${exact.headerGap}pt`,
    "--line-height": exact.lineHeight,
    "--font-size-base": `${exact.bodySize}pt`,
    "--heading-size": `${exact.headingSize}pt`,
    "--name-size": `${exact.nameSize}pt`,
    "--photo-width": `${exact.photoWidth}mm`,
    "--photo-height": `${exact.photoHeight}mm`,
    "--logo-width": `${exact.logoWidth}mm`,
    "--logo-height": `${exact.logoHeight}mm`,
    "--page-width": letter ? "215.9mm" : "210mm",
    "--page-height": letter ? "279.4mm" : "297mm",
    "--rule-color": exact.ruleColor,
    "--margin-top": `${margins.top}mm`,
    "--margin-right": `${margins.right}mm`,
    "--margin-bottom": `${margins.bottom}mm`,
    "--margin-left": `${margins.left}mm`,
    "--resume-accent-primary": exact.headingColor,
  } as CSSProperties;
}
