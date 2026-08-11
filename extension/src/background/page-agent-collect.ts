// =============================================
// Page Agent 采集结果 → 本地岗位篮（ExtractedJob）转换
// 纯函数，可单测；业务事实仍由 background 的 mergeJobs 统一入库。
// =============================================

import type { ExtractedJob, JobSource } from "../types.js";
import type { CollectResult } from "../page-agent/collect.js";
import { buildHashKey, parseSalary } from "../lib/collect-utils.js";

export function sourceFromPackId(packId: string | undefined): JobSource {
  if (!packId) return "unknown";
  if (packId.startsWith("portal.boss")) return "boss";
  if (packId.startsWith("portal.liepin")) return "liepin";
  if (packId.startsWith("portal.zhaopin")) return "zhaopin";
  if (packId.startsWith("portal.shixiseng")) return "shixiseng";
  if (packId.startsWith("portal.linkedin")) return "linkedin";
  return "unknown";
}

/** 采集结果转 ExtractedJob；无岗位数据返回 null */
export function toExtractedJob(result: CollectResult, pageUrl: string): ExtractedJob | null {
  const job = result.job;
  if (!job) return null;
  const salary = parseSalary(job.salary ?? "");
  const source = sourceFromPackId(result.packId);
  const hashKey = buildHashKey(source, job.title, job.company, pageUrl);
  return {
    title: job.title,
    company: job.company,
    location: job.location ?? "",
    salary_text: job.salary ?? "",
    salary_min: salary.min,
    salary_max: salary.max,
    raw_description: job.description,
    posted_at: job.postedAt ?? null,
    url: pageUrl,
    apply_url: job.applyUrl ?? "",
    source,
    source_page_meta: JSON.stringify({
      packId: result.packId,
      packVersion: result.packVersion,
      pageRuleId: result.pageRuleId,
      collectedVia: "page-agent",
    }),
    education: "",
    experience: "",
    job_type: "",
    company_size: "",
    company_industry: "",
    hash_key: hashKey,
    status: job.description.trim() ? "ready_to_sync" : "draft_pending_jd",
    created_at: new Date().toISOString(),
  };
}
