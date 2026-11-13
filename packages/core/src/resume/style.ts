// doc.style：校验（tools.check_style）、模板默认值和合并（resume.resolve_style）、CSS 变量（resume.style_vars）。

import { CoreError } from "../types";

export const RESUME_TEMPLATE = { classic: "经典", clear: "清晰", kami: "留白", compact: "紧凑" } as const;
export const RESUME_FONT = { sans: "黑体", serif: "宋体", kai: "楷体" } as const;
export type ResumeTemplate = keyof typeof RESUME_TEMPLATE;
export type ResumeFont = keyof typeof RESUME_FONT;
export type MarginSide = "top" | "right" | "bottom" | "left";
export type ResumeStyle = {
  template: ResumeTemplate; font: ResumeFont; bodySize: number; lineHeight: number; sectionGap: number; itemGap: number;
  margin: Record<MarginSide, number>; accent: string; photo: boolean; logo: string | null;
};

/** Old docs carry doc.template; resolveStyle reads it as style. */
export const LEGACY_TEMPLATE: Record<string, Record<string, unknown>> = {
  single: { template: "clear" }, compact: { template: "compact" }, photo: { template: "clear", photo: true },
};
export const STYLE_RANGE = { bodySize: [8, 14], lineHeight: [1.0, 2.0], sectionGap: [0, 30], itemGap: [0, 20] } as const;
export const MARGIN_RANGE = [3, 30] as const;
export const STYLE_KEYS = ["template", "font", ...Object.keys(STYLE_RANGE), "margin", "accent", "photo", "logo"] as const;
const SIDES: MarginSide[] = ["top", "right", "bottom", "left"];

export const FONTS: Record<ResumeFont, string> = {
  sans: '"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans SC", "Noto Sans CJK SC", system-ui, sans-serif',
  serif: '"Source Han Serif SC", "Noto Serif SC", "Noto Serif CJK SC", "Songti SC", "STSong", "SimSun", Georgia, serif',
  kai: '"Kaiti SC", "STKaiti", "KaiTi", "Noto Serif SC", serif',
};

type Typography = Omit<ResumeStyle, "template" | "photo" | "logo">;
// classic 照用户留档简历量；clear 对标超级简历；kami 沿用 Kami 版式；compact 给内容多的人。
export const STYLE_DEFAULTS: Record<ResumeTemplate, Typography> = {
  classic: { font: "sans", bodySize: 10.5, lineHeight: 1.3, sectionGap: 10, itemGap: 3, margin: { top: 7, right: 8, bottom: 7, left: 8 }, accent: "#000000" },
  clear: { font: "sans", bodySize: 9.5, lineHeight: 1.45, sectionGap: 9, itemGap: 4.5, margin: { top: 11, right: 13, bottom: 11, left: 13 }, accent: "#141413" },
  kami: { font: "serif", bodySize: 9.2, lineHeight: 1.42, sectionGap: 16, itemGap: 7, margin: { top: 11, right: 13, bottom: 11, left: 13 }, accent: "#1B365D" },
  compact: { font: "sans", bodySize: 9.2, lineHeight: 1.4, sectionGap: 7, itemGap: 3, margin: { top: 10, right: 12, bottom: 10, left: 12 }, accent: "#1D1D1F" },
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** doc.style: unknown keys and out-of-range values are errors, never clamped. */
export function checkStyle(style: unknown): void {
  if (!isObject(style)) throw new CoreError("doc.style 要是对象");
  const unknown = Object.keys(style).filter((k) => !(STYLE_KEYS as readonly string[]).includes(k)).sort();
  if (unknown.length) throw new CoreError(`doc.style 没有 ${unknown.join(", ")}；可用：${STYLE_KEYS.join(", ")}`);
  const number = (key: string, value: unknown, low: number, high: number): void => {
    if (typeof value !== "number" || !Number.isFinite(value) || value < low || value > high) {
      throw new CoreError(`doc.style.${key} 要在 ${RANGE_TEXT[key] ?? `${low}–${high}`} 之间`);
    }
  };
  for (const [key, value] of Object.entries(style)) {
    if (value === null || value === undefined) continue;
    if (key === "template" && !(typeof value === "string" && value in RESUME_TEMPLATE)) {
      throw new CoreError(`doc.style.template 只能是 ${Object.keys(RESUME_TEMPLATE).join(", ")}`);
    }
    if (key === "font" && !(typeof value === "string" && value in RESUME_FONT)) {
      throw new CoreError(`doc.style.font 只能是 ${Object.keys(RESUME_FONT).join(", ")}`);
    }
    if (key in STYLE_RANGE) {
      const [low, high] = STYLE_RANGE[key as keyof typeof STYLE_RANGE];
      number(key, value, low, high);
    }
    if (key === "margin") {
      if (!isObject(value) || Object.keys(value).some((side) => !(SIDES as string[]).includes(side))) {
        throw new CoreError("doc.style.margin 是 {top, right, bottom, left}，单位 mm");
      }
      for (const [side, mm] of Object.entries(value)) number(`margin.${side}`, mm, ...MARGIN_RANGE);
    }
    if (key === "accent" && !(typeof value === "string" && /^#[0-9A-Fa-f]{6}$/.test(value))) {
      throw new CoreError("doc.style.accent 要是 #RRGGBB");
    }
    if (key === "photo" && typeof value !== "boolean") throw new CoreError("doc.style.photo 是 true / false");
    if (key === "logo" && !(typeof value === "string" && value && baseName(value) === value)) {
      throw new CoreError("doc.style.logo 是上传（POST /api/files）返回的文件名");
    }
  }
}

/** Bounds as Python prints them (lineHeight's are floats: 1.0–2.0). */
const RANGE_TEXT: Record<string, string> = { lineHeight: "1.0–2.0" };

/** Path(name).name: last component, either separator (the Windows-safe reading). */
export const baseName = (name: string): string => name.split(/[\\/]/).pop() ?? "";

/** Template defaults < old doc.template < doc.style. Always returns every key. */
export function resolveStyle(style?: unknown, legacyTemplate?: unknown): ResumeStyle {
  const given: Record<string, unknown> = { ...(typeof legacyTemplate === "string" ? LEGACY_TEMPLATE[legacyTemplate] : undefined) };
  if (isObject(style)) for (const [k, v] of Object.entries(style)) if (v !== null && v !== undefined) given[k] = v;
  const template: ResumeTemplate = typeof given.template === "string" && given.template in RESUME_TEMPLATE ? given.template as ResumeTemplate : "classic";
  const base = STYLE_DEFAULTS[template];
  const margin = { ...base.margin, ...(isObject(given.margin) ? given.margin : {}) } as Record<MarginSide, number>;
  return { ...base, photo: false, logo: null, ...given, template, margin } as ResumeStyle;
}

export function styleVars(style: ResumeStyle): string {
  const margin = SIDES.map((side) => `--margin-${side}: ${style.margin[side]}mm;`).join(" ");
  return `.resume { --font: ${FONTS[style.font]}; --body-size: ${style.bodySize}pt; `
    + `--line-height: ${style.lineHeight}; --section-gap: ${style.sectionGap}pt; `
    + `--item-gap: ${style.itemGap}pt; --accent: ${style.accent}; ${margin} }`;
}
