// =============================================
// SiteRuleResolver：检测评分与裁决
// 算法见 site-rule-pack-v1.md 第 12 节。
// 输出只含脱敏 detection evidence，不含页面正文。
// =============================================

import type {
  DetectionEvidence,
  PageRuleV1,
  ResolveOutcome,
  ResolvedSiteAdapter,
  SiteRulePackV1,
  DetectionSignalV1,
} from "./contracts.js";
import type { PageSnapshot } from "../framework/page-snapshot.js";
import { compilePathGlob } from "./path-glob.js";
import { normalizeToken } from "./normalizers.js";

interface ScoredCandidate {
  adapter: ResolvedSiteAdapter;
  score: number;
  positiveCount: number;
  matched: DetectionEvidence["matchedSignals"];
}

/** 是否命中 host 规则；suffix 按 label 边界匹配（jobs.invalid 不匹配 eviljobs.invalid） */
function hostMatches(rule: { kind: "exact" | "suffix"; value: string }, host: string): boolean {
  if (rule.kind === "exact") return host === rule.value;
  return host === rule.value || host.endsWith(`.${rule.value}`);
}

function signalMatches(signal: DetectionSignalV1, snapshot: PageSnapshot): boolean | "error" {
  switch (signal.type) {
    case "path-glob":
      return compilePathGlob(signal.value).test(snapshot.pathname);
    case "title-token": {
      const token = normalizeToken(signal.value);
      return token.length > 0 && normalizeToken(snapshot.title).includes(token);
    }
    case "meta-token": {
      const token = normalizeToken(signal.value);
      if (token.length === 0) return false;
      return Object.values(snapshot.meta).some((content) => normalizeToken(content).includes(token));
    }
    case "script-host":
      return snapshot.scriptHosts.includes(signal.value);
    case "css-exists":
      try {
        return snapshot.cssExists(signal.value);
      } catch {
        return "error";
      }
  }
}

function evidenceFor(
  pack: SiteRulePackV1,
  pageRule: PageRuleV1,
  matched: DetectionEvidence["matchedSignals"],
  score: number,
  positiveCount: number,
  rivals: DetectionEvidence["rivalCandidates"],
  degradedReason?: DetectionEvidence["degradedReason"],
): DetectionEvidence {
  return {
    packId: pack.id,
    packVersion: pack.version,
    pageRuleId: pageRule.id,
    matchedSignals: matched,
    score,
    positiveCount,
    rivalCandidates: rivals,
    ...(degradedReason ? { degradedReason } : {}),
  };
}

export function resolveSite(packs: readonly SiteRulePackV1[], snapshot: PageSnapshot): ResolveOutcome {
  const candidates: ScoredCandidate[] = [];

  for (const pack of packs) {
    if (pack.status === "disabled") continue;
    const hostHit = pack.hosts.some((rule) => hostMatches(rule, snapshot.host));
    if (!hostHit) continue;

    for (const pageRule of pack.pages) {
      const matched: DetectionEvidence["matchedSignals"] = [];
      let score = 0;
      let positiveCount = 0;
      let vetoed = false;

      for (const signal of pageRule.match.signals) {
        const hit = signalMatches(signal, snapshot);
        if (hit === "error") {
          // selector 语法错误/结构漂移：立即降级，不能放宽规则重试
          const evidence = evidenceFor(pack, pageRule, matched, score, positiveCount, [], "rule-error");
          return { status: "diagnostic-only", evidence, reason: "rule-error", adapter: { pack, pageRule } };
        }
        if (snapshot.budgetExceeded()) {
          const evidence = evidenceFor(pack, pageRule, matched, score, positiveCount, [], "budget-exceeded");
          return { status: "diagnostic-only", evidence, reason: "budget-exceeded", adapter: { pack, pageRule } };
        }
        if (!hit) continue;
        matched.push({ id: signal.id, type: signal.type, polarity: signal.polarity, weight: signal.weight });
        if (signal.polarity === "positive") {
          score += signal.weight;
          positiveCount++;
        } else {
          score -= signal.weight;
          if (signal.veto === true) vetoed = true;
        }
      }

      if (vetoed) continue;
      if (positiveCount < pageRule.match.minPositiveSignals) continue;
      if (score < pageRule.match.minScore) continue;

      candidates.push({
        adapter: { pack, pageRule },
        score,
        positiveCount,
        matched,
      });
    }
  }

  if (candidates.length === 0) {
    return { status: "unsupported", evidence: null };
  }

  candidates.sort(
    (a, b) => b.score - a.score || b.positiveCount - a.positiveCount,
  );

  const winner = candidates[0];
  const rivals = candidates.slice(1).map((c) => ({
    packId: c.adapter.pack.id,
    pageRuleId: c.adapter.pageRule.id,
    score: c.score,
  }));

  if (candidates.length >= 2) {
    const second = candidates[1];
    if (winner.score - second.score < winner.adapter.pageRule.match.ambiguityMargin) {
      const evidence = evidenceFor(
        winner.adapter.pack,
        winner.adapter.pageRule,
        winner.matched,
        winner.score,
        winner.positiveCount,
        rivals,
      );
      return {
        status: "ambiguous",
        evidence,
        candidates: candidates.map((c) => c.adapter),
      };
    }
  }

  const evidence = evidenceFor(
    winner.adapter.pack,
    winner.adapter.pageRule,
    winner.matched,
    winner.score,
    winner.positiveCount,
    rivals,
  );

  if (winner.adapter.pack.status === "experimental") {
    return {
      status: "diagnostic-only",
      evidence: { ...evidence, degradedReason: "experimental" },
      reason: "experimental",
      adapter: winner.adapter,
    };
  }
  return { status: "verified", evidence, adapter: winner.adapter };
}
