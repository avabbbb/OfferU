// =============================================
// resolver 测试：site-rule-pack-v1.md 第 17 节 EXT-FRAME-001 最小验收
// =============================================

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { SiteRuleRegistry } from "./registry.js";
import { resolveSite } from "./resolver.js";
import { resolvePackOnHtml, resolvePacksOnHtml } from "./fixture-harness.js";
import { PageSnapshotImpl, type PageSnapshot } from "../framework/page-snapshot.js";
import type { SiteRulePackV1 } from "./contracts.js";
import rawJobDetailPack from "./packs/fixture.acme-job-detail.json";
import rawApplicationFormPack from "./packs/fixture.acme-application-form.json";

// JSON 推断为宽类型；框架边界处收窄为规范类型
const JOB_DETAIL_PACK: SiteRulePackV1 = rawJobDetailPack as unknown as SiteRulePackV1;
const FORM_PACK: SiteRulePackV1 = rawApplicationFormPack as unknown as SiteRulePackV1;

function clone<T>(value: T): T {
  return structuredClone(value);
}

function fixture(name: string): string {
  return readFileSync(resolve(process.cwd(), `src/rule-packs/fixtures/acme/${name}.html`), "utf8");
}

function loadPacks(): SiteRulePackV1[] {
  const registry = new SiteRuleRegistry();
  const summary = registry.loadPacks([clone(JOB_DETAIL_PACK), clone(FORM_PACK)]);
  expect(summary.failures).toEqual([]);
  return [...summary.loaded, ...summary.disabled];
}

const DETAIL_URL = "https://jobs.acme.invalid/jobs/1";
const FORM_URL = "https://apply.acme.invalid/applications/1";

describe("resolveSite - verified positive hit (case 4)", () => {
  it("returns a unique resolved adapter with redacted evidence", () => {
    const outcome = resolvePackOnHtml(JOB_DETAIL_PACK, fixture("detail"), DETAIL_URL);
    expect(outcome.status).toBe("verified");
    if (outcome.status !== "verified") return;
    expect(outcome.adapter.pack.id).toBe("fixture.acme-job-detail");
    expect(outcome.adapter.pageRule.id).toBe("detail");
    expect(outcome.evidence.score).toBe(80);
    expect(outcome.evidence.positiveCount).toBe(2);
    const ids = outcome.evidence.matchedSignals.map((s) => s.id).sort();
    expect(ids).toEqual(["detail-path", "detail-root"]);
    // 脱敏：evidence 不含页面正文
    expect(JSON.stringify(outcome.evidence)).not.toContain("Senior Frontend Engineer");
  });

  it("runs through the registry path", () => {
    const outcome = resolvePackOnHtml(loadPacks()[0], fixture("detail"), DETAIL_URL);
    expect(outcome.status).toBe("verified");
  });
});

describe("resolveSite - low score (case 5)", () => {
  it("returns unsupported when below minPositiveSignals", () => {
    // host 命中但 path 不匹配：只剩 css 信号 → positiveCount 1 < 2
    const outcome = resolvePackOnHtml(JOB_DETAIL_PACK, fixture("detail"), "https://jobs.acme.invalid/other/1");
    expect(outcome.status).toBe("unsupported");
  });
});

describe("resolveSite - negative veto (case 8)", () => {
  it("rejects a candidate whose negative veto fires", () => {
    const outcome = resolvePackOnHtml(JOB_DETAIL_PACK, fixture("search"), DETAIL_URL);
    expect(outcome.status).toBe("unsupported");
  });

  it("rejects conflict fixture that mixes detail and search", () => {
    const outcome = resolvePackOnHtml(JOB_DETAIL_PACK, fixture("conflict"), DETAIL_URL);
    expect(outcome.status).toBe("unsupported");
  });
});

describe("resolveSite - experimental (case 7)", () => {
  it("returns diagnostic-only for experimental packs", () => {
    const outcome = resolvePackOnHtml(FORM_PACK, fixture("form"), FORM_URL);
    expect(outcome.status).toBe("diagnostic-only");
    if (outcome.status !== "diagnostic-only") return;
    expect(outcome.reason).toBe("experimental");
    expect(outcome.evidence.degradedReason).toBe("experimental");
  });
});

describe("resolveSite - ambiguity (case 6)", () => {
  function rivalPack(id: string): SiteRulePackV1 {
    const pack = clone(JOB_DETAIL_PACK);
    pack.id = id;
    pack.version = "2.0.0";
    pack.displayName = "Rival acme pack";
    return pack;
  }

  it("returns ambiguous when top two scores are within margin", () => {
    // 两个 pack 同 host、同信号、同分（80），分差 0 < ambiguityMargin 20
    const outcome = resolvePacksOnHtml(
      [JOB_DETAIL_PACK, rivalPack("fixture.acme-job-detail-rival")],
      fixture("detail"),
      DETAIL_URL,
    );
    expect(outcome.status).toBe("ambiguous");
    if (outcome.status !== "ambiguous") return;
    expect(outcome.candidates).toHaveLength(2);
    expect(outcome.evidence.rivalCandidates.length).toBeGreaterThanOrEqual(1);
  });
});

describe("resolveSite - selector error and budget (case 9)", () => {
  function throwingSnapshot(): PageSnapshot {
    return new PageSnapshotImpl(
      DETAIL_URL,
      "Senior Frontend Engineer - Acme Fixtures Ltd",
      {},
      [],
      { maxQueries: 200 },
      () => {
        throw new Error("query-failed");
      },
    );
  }

  it("degrades to diagnostic-only on selector query failure", () => {
    const outcome = resolveSite([JOB_DETAIL_PACK], throwingSnapshot());
    expect(outcome.status).toBe("diagnostic-only");
    if (outcome.status !== "diagnostic-only") return;
    expect(outcome.reason).toBe("rule-error");
  });

  it("degrades to diagnostic-only when budget is exhausted", () => {
    const outcome = resolvePackOnHtml(JOB_DETAIL_PACK, fixture("detail"), DETAIL_URL, { maxQueries: 0 });
    expect(outcome.status).toBe("diagnostic-only");
    if (outcome.status !== "diagnostic-only") return;
    expect(outcome.reason).toBe("budget-exceeded");
  });
});

describe("resolveSite - host prefilter", () => {
  it("does not match suffix across label boundaries", () => {
    // 构造 suffix 规则：jobs.invalid 不应匹配 eviljobs.invalid
    const pack = clone(JOB_DETAIL_PACK);
    pack.hosts = [{ kind: "suffix", value: "acme.invalid" }];
    const outcome = resolvePackOnHtml(pack, fixture("detail"), "https://jobs.acme.invalid/jobs/1");
    expect(outcome.status).toBe("verified");
    const cross = resolvePackOnHtml(pack, fixture("detail"), "https://xacme.invalid/jobs/1");
    expect(cross.status).toBe("unsupported");
  });

  it("skips packs whose host does not match", () => {
    const outcome = resolvePackOnHtml(JOB_DETAIL_PACK, fixture("detail"), "https://elsewhere.invalid/jobs/1");
    expect(outcome.status).toBe("unsupported");
  });
});

describe("resolveSite - disabled packs", () => {
  it("never participates in resolution", () => {
    const disabled = clone(JOB_DETAIL_PACK);
    disabled.status = "disabled";
    const outcome = resolvePackOnHtml(disabled, fixture("detail"), DETAIL_URL);
    expect(outcome.status).toBe("unsupported");
  });
});
