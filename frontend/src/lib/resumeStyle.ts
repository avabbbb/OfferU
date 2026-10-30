// doc.style 的前端镜像：默认值和范围要和 backend/app/core/resume.py（DEFAULTS）、tools.py（check_style）一致。
// 排版面板和智能一页只在这些范围里取值；越界由后端报 400。

export type ResumeTemplate = "clear" | "kami" | "compact";
export type ResumeFont = "sans" | "serif" | "kai";
export type Side = "top" | "right" | "bottom" | "left";
export type Margin = Record<Side, number>;
export type ResumeStyle = {
  template: ResumeTemplate; font: ResumeFont; bodySize: number; lineHeight: number; sectionGap: number; itemGap: number;
  margin: Margin; accent: string; photo: boolean; logo: string | null;
};
export type StyleInput = Partial<Omit<ResumeStyle, "margin">> & { margin?: Partial<Margin> };

export const RESUME_TEMPLATES: Record<ResumeTemplate, string> = { clear: "清晰", kami: "留白", compact: "紧凑" };
export const RESUME_FONTS: Record<ResumeFont, string> = { sans: "黑体", serif: "宋体", kai: "楷体" };
export const ACCENTS = ["#141413", "#1B365D", "#2F5D50", "#7A2E2E", "#4B3F72"] as const;
export const SIDES: Side[] = ["top", "right", "bottom", "left"];
export const RANGE = { bodySize: [8, 14], lineHeight: [1, 2], sectionGap: [0, 30], itemGap: [0, 20], margin: [3, 30] } as const;

type Typography = Omit<ResumeStyle, "template" | "photo" | "logo">;
const DEFAULTS: Record<ResumeTemplate, Typography> = {
  clear: { font: "sans", bodySize: 9.5, lineHeight: 1.45, sectionGap: 9, itemGap: 4.5, margin: { top: 11, right: 13, bottom: 11, left: 13 }, accent: "#141413" },
  kami: { font: "serif", bodySize: 9.2, lineHeight: 1.42, sectionGap: 16, itemGap: 7, margin: { top: 14, right: 16, bottom: 14, left: 16 }, accent: "#1B365D" },
  compact: { font: "sans", bodySize: 9.2, lineHeight: 1.4, sectionGap: 7, itemGap: 3, margin: { top: 10, right: 12, bottom: 10, left: 12 }, accent: "#1D1D1F" },
};
const LEGACY: Record<string, StyleInput> = { single: { template: "clear" }, compact: { template: "compact" }, photo: { template: "clear", photo: true } };

const present = <T extends object>(o: T): Partial<T> =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== undefined)) as Partial<T>;

// 模板默认 < 旧 doc.template < doc.style，和 resume.resolve_style 同一规则；永远返回全部键。
export function resolveStyle(style?: StyleInput | null, legacyTemplate?: string | null): ResumeStyle {
  const given: StyleInput = { ...(legacyTemplate ? LEGACY[legacyTemplate] : undefined), ...present(style ?? {}) };
  const template: ResumeTemplate = given.template && given.template in DEFAULTS ? given.template : "clear";
  const base = DEFAULTS[template];
  return { ...base, photo: false, logo: null, ...given, template, margin: { ...base.margin, ...present(given.margin ?? {}) } } as ResumeStyle;
}

// 换模板：字体、字号、间距、边距、颜色回到新模板的默认，照片和校徽保留。
export const withTemplate = (style: ResumeStyle, template: ResumeTemplate): ResumeStyle =>
  resolveStyle({ template, photo: style.photo, logo: style.logo });

// 智能一页（沿用 #108）：超一页向下限插值，取第一个放得下的；不到 90% 向上限插值，最多放大到 94%。
export const PAGE_PX = 1123; // A4 297mm @ 96dpi
const STEPS = 12;
type Num = "bodySize" | "lineHeight" | "sectionGap" | "itemGap";
const NUMS: Num[] = ["bodySize", "lineHeight", "sectionGap", "itemGap"];
const LOW: Record<Num, number> & { margin: Margin } = { bodySize: 8.5, lineHeight: 1.25, sectionGap: 5, itemGap: 2, margin: { top: 7, right: 9, bottom: 7, left: 9 } };
const HIGH: Record<Num, number> = { bodySize: 10.5, lineHeight: 1.55, sectionGap: 10, itemGap: 5 };
const PER: Record<Num, number> = { bodySize: 10, lineHeight: 100, sectionGap: 2, itemGap: 2 };
const round = (v: number, per: number) => Math.round(v * per) / per;
// 只朝目标方向走：已经比下限还小（或比上限还大）的量保持不动。
const toward = (from: number, to: number, f: number, shrink: boolean) => ((shrink ? to < from : to > from) ? from + (to - from) * f : from);

export function blend(base: ResumeStyle, f: number, shrink: boolean): ResumeStyle {
  const out: ResumeStyle = { ...base, margin: { ...base.margin } };
  for (const key of NUMS) out[key] = round(toward(base[key], shrink ? LOW[key] : HIGH[key], f, shrink), PER[key]);
  if (shrink) for (const side of SIDES) out.margin[side] = round(toward(base.margin[side], LOW.margin[side], f, true), 2);
  return out;
}

export type FitOutcome = "fits" | "shrunk" | "grown" | "overflow";
export async function fitOnePage(
  base: ResumeStyle, measure: (style: ResumeStyle) => number | Promise<number>, page = PAGE_PX,
): Promise<{ style: ResumeStyle; outcome: FitOutcome }> {
  const height = await measure(base);
  if (height > page) {
    for (let i = 1; i <= STEPS; i += 1) {
      const style = blend(base, i / STEPS, true);
      if ((await measure(style)) <= page) return { style, outcome: "shrunk" };
    }
    return { style: base, outcome: "overflow" };
  }
  if (height >= page * 0.9) return { style: base, outcome: "fits" };
  let best = base;
  for (let i = 1; i <= STEPS; i += 1) {
    const style = blend(base, i / STEPS, false);
    if ((await measure(style)) > page * 0.94) break;
    best = style;
  }
  return { style: best, outcome: best === base ? "fits" : "grown" };
}
