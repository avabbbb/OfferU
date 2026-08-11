// =============================================
// DOM reader 测试：boss fixture 字段提取
// =============================================

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { readJobDetail, resolveSelectorSet } from "./dom-reader.js";
import { SiteRuleRegistry } from "../rule-packs/registry.js";
import bossPackJson from "../rule-packs/packs/portal.boss-job-detail.json";
import type { SiteRulePackV1 } from "../rule-packs/contracts.js";

const BOSS_PACK = bossPackJson as unknown as SiteRulePackV1;
const DETAIL_URL = "https://www.zhipin.com/job_detail/12345.html";

function fixture(name: string): Document {
  const html = readFileSync(resolve(process.cwd(), `src/rule-packs/fixtures/boss/${name}.html`), "utf8");
  return new DOMParser().parseFromString(html, "text/html");
}

function adapterOf(pack: SiteRulePackV1) {
  return { pack, pageRule: pack.pages[0] };
}

describe("resolveSelectorSet", () => {
  it("picks the first candidate within maxMatches", () => {
    const doc = fixture("detail");
    const set = {
      scope: "page-root" as const,
      candidates: [
        { css: ".missing-selector", stability: "fragile" as const },
        { css: ".info-primary .name", stability: "fragile" as const },
      ],
      required: true,
      maxMatches: 1,
    };
    const result = resolveSelectorSet(doc, set);
    expect(result).toHaveLength(1);
    expect(result![0].textContent).toContain("资深前端工程师");
  });

  it("skips candidates exceeding maxMatches without truncating", () => {
    const doc = fixture("detail");
    const set = {
      scope: "page-root" as const,
      candidates: [{ css: ".tag-item", stability: "fragile" as const }],
      required: false,
      maxMatches: 2,
    };
    expect(resolveSelectorSet(doc, set)).toBeNull(); // 3 个 tag-item > 2
  });

  it("returns null when nothing matches", () => {
    const doc = fixture("detail");
    const set = {
      scope: "page-root" as const,
      candidates: [{ css: ".nope", stability: "fragile" as const }],
      required: false,
      maxMatches: 1,
    };
    expect(resolveSelectorSet(doc, set)).toBeNull();
  });
});

describe("readJobDetail - boss detail fixture", () => {
  it("extracts all declared fields", () => {
    const outcome = readJobDetail(adapterOf(BOSS_PACK), fixture("detail"), DETAIL_URL);
    expect(outcome.missing).toEqual([]);
    expect(outcome.job).not.toBeNull();
    const job = outcome.job!;
    expect(job.title).toBe("资深前端工程师");
    expect(job.company).toBe("Example Co");
    expect(job.description).toContain("岗位职责");
    expect(job.description).toContain("任职要求");
    expect(job.salary).toBe("25-40K·14薪");
    expect(job.location).toBe("北京·海淀区");
    expect(job.postedAt).toBe("2026-07-30");
    expect(job.tags).toEqual(["React", "TypeScript", "前端架构"]);
    expect(job.companyTags).toEqual(["100-499人", "企业服务"]);
    expect(job.sourceUrl).toBe(DETAIL_URL);
  });

  it("reports missing mandatory fields when selectors do not match", () => {
    const doc = fixture("list");
    const outcome = readJobDetail(adapterOf(BOSS_PACK), doc, "https://www.zhipin.com/job_detail/9.html");
    // 列表页没有详情结构：root 缺失
    expect(outcome.missing).toContain("root");
    expect(outcome.job).toBeNull();
  });

  it("resolves href to absolute url when present", () => {
    const doc = fixture("detail");
    const applyLink = doc.createElement("a");
    applyLink.className = "btn-startchat";
    applyLink.href = "/job_detail/12345.html";
    doc.querySelector(".job-detail")!.appendChild(applyLink);
    const outcome = readJobDetail(adapterOf(BOSS_PACK), doc, DETAIL_URL);
    expect(outcome.job!.applyUrl).toBe(DETAIL_URL);
  });
});

describe("boss pack loadability", () => {
  it("passes the registry validator", () => {
    const registry = new SiteRuleRegistry();
    const summary = registry.loadPacks([BOSS_PACK]);
    expect(summary.failures).toEqual([]);
    expect(summary.loaded).toHaveLength(1);
  });
});
