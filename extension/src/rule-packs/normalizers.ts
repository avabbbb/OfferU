// =============================================
// 内置 normalizer 纯函数
// 规则包只能引用这些内置函数，不能携带参数化代码。
// =============================================

import type { NormalizerId } from "./contracts.js";

/** 规范化 token：小写、折叠空白、去首尾标点，用于 title/meta literal 匹配 */
export function normalizeToken(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\s\u3000]+/g, " ")
    .trim()
    .replace(/^[\s\-_·.:：，。、'"“”‘’()[\]{}!?！？]+|[\s\-_·.:：，。、'"“”‘’()[\]{}!?！？]+$/g, "");
}

export const NORMALIZERS: Record<NormalizerId, (value: string, baseUrl?: string) => string> = {
  trim: (value) => value.trim(),

  "collapse-space": (value) => value.replace(/\s+/g, " ").trim(),

  /** href 只能变为当前页面 origin 可解析的绝对 URL，不跟随请求 */
  "absolute-url": (value, baseUrl = "") => {
    if (!value) return "";
    try {
      return new URL(value, baseUrl || undefined).href;
    } catch {
      return value;
    }
  },

  /** 去掉 "职位："、"Job Title:" 之类的 label 前缀 */
  "strip-label-prefix": (value) =>
    value.replace(/^\s*[^:：\n]{0,24}[:：]\s*/, "").trim(),

  /** ISO 日期且无歧义时输出 YYYY-MM-DD；否则保留原文（unresolved 由读取器标记） */
  "iso-date-if-unambiguous": (value) => {
    const text = value.trim();
    const match = text.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
    if (!match) return text;
    const [, y, m, d] = match;
    const month = Number(m);
    const day = Number(d);
    if (month < 1 || month > 12 || day < 1 || day > 31) return text;
    return `${y}-${month.toString().padStart(2, "0")}-${day.toString().padStart(2, "0")}`;
  },
};

/** 按顺序应用 normalizer；未知 id 返回原值（validator 会拒绝未知 id） */
export function applyNormalizers(value: string, ids: NormalizerId[], baseUrl = ""): string {
  let result = value;
  for (const id of ids) {
    result = NORMALIZERS[id](result, baseUrl);
  }
  return result;
}
