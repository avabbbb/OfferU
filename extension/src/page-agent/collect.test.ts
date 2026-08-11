// =============================================
// Page Agent 采集与结果转换测试
// =============================================

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { collectFromDocument } from "./collect.js";
import { sourceFromPackId, toExtractedJob } from "../background/page-agent-collect.js";
import type { CollectResult } from "./collect.js";

function fixtureDoc(name: string): Document {
  const html = readFileSync(resolve(process.cwd(), `src/rule-packs/fixtures/boss/${name}.html`), "utf8");
  return new DOMParser().parseFromString(html, "text/html");
}

const DETAIL_URL = "https://www.zhipin.com/job_detail/12345.html";

describe("collectFromDocument - boss detail", () => {
  it("collects a job from the detail fixture", () => {
    const result = collectFromDocument(DETAIL_URL, fixtureDoc("detail"));
    expect(result.status).toBe("collected");
    expect(result.missing).toEqual([]);
    expect(result.packId).toBe("portal.boss-job-detail");
    expect(result.packVersion).toBe("0.1.0");
    expect(result.pageRuleId).toBe("job-detail");
    expect(result.reason).toBe("experimental"); // pack 尚未真实浏览器验收
    expect(result.job?.title).toBe("资深前端工程师");
  });

  it("returns unsupported on the list page (veto)", () => {
    const result = collectFromDocument(DETAIL_URL, fixtureDoc("list"));
    expect(result.status).toBe("unsupported");
    expect(result.job).toBeUndefined();
  });

  it("returns unsupported on the conflict fixture (veto)", () => {
    const result = collectFromDocument(DETAIL_URL, fixtureDoc("conflict"));
    expect(result.status).toBe("unsupported");
  });

  it("returns unsupported on unrelated hosts", () => {
    const result = collectFromDocument("https://elsewhere.invalid/job_detail/1.html", fixtureDoc("detail"));
    expect(result.status).toBe("unsupported");
  });
});

describe("toExtractedJob", () => {
  const collected: CollectResult = {
    status: "collected",
    packId: "portal.boss-job-detail",
    packVersion: "0.1.0",
    pageRuleId: "job-detail",
    missing: [],
    job: {
      title: "资深前端工程师",
      company: "Example Co",
      description: "岗位职责：测试",
      salary: "25-40K",
      location: "北京",
      sourceUrl: DETAIL_URL,
    },
  };

  it("maps a collected result into the local job store shape", () => {
    const job = toExtractedJob(collected, DETAIL_URL);
    expect(job).not.toBeNull();
    expect(job!.title).toBe("资深前端工程师");
    expect(job!.source).toBe("boss");
    expect(job!.status).toBe("ready_to_sync");
    expect(job!.salary_text).toBe("25-40K");
    expect(job!.salary_min).toBe(25000);
    expect(job!.salary_max).toBe(40000);
    expect(job!.url).toBe(DETAIL_URL);
    expect(job!.hash_key).toMatch(/^offeru-boss-/);
    const meta = JSON.parse(job!.source_page_meta);
    expect(meta.collectedVia).toBe("page-agent");
    expect(meta.packId).toBe("portal.boss-job-detail");
  });

  it("downgrades to draft when description is missing", () => {
    const draft = toExtractedJob(
      { ...collected, job: { ...collected.job!, description: "" } },
      DETAIL_URL,
    );
    expect(draft!.status).toBe("draft_pending_jd");
  });

  it("returns null without a job payload", () => {
    expect(toExtractedJob({ status: "unsupported", missing: [] }, DETAIL_URL)).toBeNull();
  });
});

describe("sourceFromPackId", () => {
  it("maps portal pack ids to job sources", () => {
    expect(sourceFromPackId("portal.boss-job-detail")).toBe("boss");
    expect(sourceFromPackId("portal.liepin-jobs")).toBe("liepin");
    expect(sourceFromPackId("portal.zhaopin-x")).toBe("zhaopin");
    expect(sourceFromPackId("portal.shixiseng-x")).toBe("shixiseng");
    expect(sourceFromPackId("portal.linkedin-x")).toBe("linkedin");
    expect(sourceFromPackId("ats.moka.x")).toBe("unknown");
    expect(sourceFromPackId(undefined)).toBe("unknown");
  });
});
