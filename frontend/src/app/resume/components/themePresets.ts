// =============================================
// 简历主题预设包（M5b）
// =============================================
// 每套预设 = 5 个 CSS 变量色值（与 StyleConfig 对齐）
// 选中后整包覆盖 styleConfig 并 setDirty。
// sectionOrder 留位，M5+ 排序约束时再启用。
// 参见 docs/RESUME_PUCK_MIGRATION_PLAN.md
// =============================================

import type { StyleConfig } from "./StyleToolbar";

export interface ThemePreset {
  id: string;
  name: string;
  description: string;
  config: StyleConfig;
  /** 缩略图主色：用于 chip 视觉表达，无需完整 5 色 */
  swatch: { primary: string; secondary: string; accent: string };
}

export const THEME_PRESETS: ThemePreset[] = [
  {
    id: "notion",
    name: "Notion",
    description: "极简墨色，默认值。衬 Inter，适合通用求职场景。",
    config: {
      primaryColor: "#37352f",
      secondaryColor: "#666666",
      tertiaryColor: "#999999",
      linkColor: "#5b9cd6",
      borderColor: "#e5e5e5",
    },
    swatch: { primary: "#37352f", secondary: "#666666", accent: "#5b9cd6" },
  },
  {
    id: "linear",
    name: "Linear",
    description: "深紫主黑，强对比。适合国内投递互联网/技术岗。",
    config: {
      primaryColor: "#1c1b22",
      secondaryColor: "#5b59a0",
      tertiaryColor: "#8a89a8",
      linkColor: "#6e6ad0",
      borderColor: "#e7e6f2",
    },
    swatch: { primary: "#1c1b22", secondary: "#5b59a0", accent: "#6e6ad0" },
  },
  {
    id: "swiss",
    name: "Swiss",
    description: "经典黑红双栏，结构对称。投递咨询/外向岗位。",
    config: {
      primaryColor: "#111111",
      secondaryColor: "#444444",
      tertiaryColor: "#888888",
      linkColor: "#b3372e",
      borderColor: "#000000",
    },
    swatch: { primary: "#111111", secondary: "#444444", accent: "#b3372e" },
  },
  {
    id: "modern",
    name: "Modern",
    description: "靛蓝主色，工程岗友好。强列分隔。",
    config: {
      primaryColor: "#0f2e4e",
      secondaryColor: "#3b6a96",
      tertiaryColor: "#7fa4c4",
      linkColor: "#1a73e8",
      borderColor: "#cfd8e3",
    },
    swatch: { primary: "#0f2e4e", secondary: "#3b6a96", accent: "#1a73e8" },
  },
  {
    id: "classic",
    name: "Classic",
    description: "深绿衬底色，温和与传统。教育/学术岗适配。",
    config: {
      primaryColor: "#1f3a2e",
      secondaryColor: "#4a6a5a",
      tertiaryColor: "#8aa39a",
      linkColor: "#2e7d32",
      borderColor: "#d4ded8",
    },
    swatch: { primary: "#1f3a2e", secondary: "#4a6a5a", accent: "#2e7d32" },
  },
];

export function applyPreset(
  preset: ThemePreset,
  current: StyleConfig
): StyleConfig {
  return { ...current, ...preset.config };
}