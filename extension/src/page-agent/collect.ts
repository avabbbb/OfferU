// =============================================
// Page Agent 采集核心：检测 → 读取岗位
// 纯 DOM 同步逻辑，可被单元测试直接调用。
// =============================================

import type { JobCandidate } from "../framework/workflow.js";
import type { ResolveOutcome } from "../rule-packs/contracts.js";
import { createSnapshotFromDom } from "../framework/page-snapshot.js";
import { readJobDetail } from "../framework/dom-reader.js";
import { SiteRuleRegistry } from "../rule-packs/registry.js";
import { resolveSite } from "../rule-packs/resolver.js";
import { fetchRemoteRulePacks } from "../rule-packs/remote.js";
import bossJobDetailPack from "../rule-packs/packs/portal.boss-job-detail.json";

export type CollectStatus = "collected" | "unsupported" | "ambiguous" | "diagnostic" | "error";

export interface CollectResult {
  status: CollectStatus;
  reason?: string;
  packId?: string;
  packVersion?: string;
  pageRuleId?: string;
  job?: JobCandidate;
  /** 缺失的必填字段（title/company/description） */
  missing: string[];
}

const registry = new SiteRuleRegistry();
registry.loadPacks([bossJobDetailPack]);

// 异步拉取签名远程规则包（ADR-0050）：失败静默，内置规则兜底；
// 成功则按 bundleVersion 递增合并，新站点/选择器修复无需发版。
void fetchRemoteRulePacks(registry);

/** 从当前文档采集岗位；experimental 规则仍允许读能力（read-job-detail） */
export function collectFromDocument(url: string, doc: Document): CollectResult {
  let outcome: ResolveOutcome;
  try {
    const snapshot = createSnapshotFromDom(url, doc);
    outcome = resolveSite(registry.all(), snapshot);
  } catch (error: unknown) {
    return {
      status: "error",
      missing: [],
      reason: error instanceof Error ? error.message : String(error),
    };
  }

  switch (outcome.status) {
    case "unsupported":
      return { status: "unsupported", missing: [] };
    case "ambiguous":
      return {
        status: "ambiguous",
        missing: [],
        reason: outcome.candidates.map((c) => `${c.pack.id}#${c.pageRule.id}`).join(","),
      };
    case "diagnostic-only": {
      if (outcome.reason === "experimental") {
        return finishRead(outcome, doc, url, "experimental");
      }
      return { status: "diagnostic", missing: [], reason: outcome.reason };
    }
    case "verified":
      return finishRead(outcome, doc, url);
  }
}

function finishRead(
  outcome: Extract<ResolveOutcome, { status: "verified" | "diagnostic-only" }>,
  doc: Document,
  url: string,
  reason?: string,
): CollectResult {
  const read = readJobDetail(outcome.adapter, doc, url);
  const base: CollectResult = {
    status: "collected",
    missing: read.missing,
    packId: outcome.adapter.pack.id,
    packVersion: outcome.adapter.pack.version,
    pageRuleId: outcome.adapter.pageRule.id,
    job: read.job ?? undefined,
    ...(reason ? { reason } : {}),
  };
  return base;
}
