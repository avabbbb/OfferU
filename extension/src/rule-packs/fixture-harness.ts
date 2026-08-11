// =============================================
// 最小 fixture harness：把脱敏 fixture HTML 跑过检测/解析
// 只用于测试与规则包开发，不进入运行时页面链路。
// =============================================

import type { ResolveOutcome, SiteRulePackV1 } from "./contracts.js";
import { createSnapshotFromDom, type SnapshotBudget } from "../framework/page-snapshot.js";
import { resolveSite } from "./resolver.js";

/** 用 fixture HTML 解析单个 pack；url 必须与 pack host 匹配（测试负责） */
export function resolvePackOnHtml(
  pack: SiteRulePackV1,
  html: string,
  url: string,
  budget?: SnapshotBudget,
): ResolveOutcome {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const snapshot = createSnapshotFromDom(url, doc, budget);
  return resolveSite([pack], snapshot);
}

/** 用 fixture HTML 解析多个 pack（冲突/歧义用例） */
export function resolvePacksOnHtml(
  packs: SiteRulePackV1[],
  html: string,
  url: string,
  budget?: SnapshotBudget,
): ResolveOutcome {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const snapshot = createSnapshotFromDom(url, doc, budget);
  return resolveSite(packs, snapshot);
}
