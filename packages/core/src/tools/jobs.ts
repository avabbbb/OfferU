// add_job / enrich_jobs (evaluate_jobs lives in ../research/evaluate.ts),
// ported from backend/app/core/tools.py. Writes go through saveRecord, one undoable change each.

import { label, stable } from "../labels";
import { findJobByUrl, knownTags, mergeAutoTags, saveRecord } from "../operations";
import { CoreError, isCoreError, type Json, type StoredRecord } from "../types";
import { autoTags, extractIntake, guessIntake, hireFromUrl } from "./job-intake";
import { officialKind } from "../research/official-sources";
import { API_COMPANIES, findViaApi, hostOf, splitName, type OfficialPosting } from "./job-sources";
import { fetchPage, hostIn, NO_SEARCH, PASTE_ONLY_DOMAINS, RESTRICTED_DOMAINS, type FetchPageResult, type SearchResult } from "./net";
import { guard as runGuard, guardCounts, guardWarning, type GuardCounts } from "./posting-guard";
import type { ToolDeps } from "./deps";

const truthy = (value: unknown) => value !== null && value !== undefined && value !== "" && value !== false && value !== 0
  && !(Array.isArray(value) && !value.length)
  && !(typeof value === "object" && !Array.isArray(value) && value !== null && !Object.keys(value as object).length);
const compact = (data: Json): Json => Object.fromEntries(Object.entries(data).filter(([, value]) => truthy(value)));
const NO_MODEL_SPLIT = "没配模型，没法拆 JD";

/** 一行、很短、不是链接：当成「公司 岗位」去联网找。 */
function isJobName(text: string): boolean {
  return !text.includes("\n") && [...text].length <= 60 && !/https?:\/\//.test(text);
}

type Page = (FetchPageResult | OfficialPosting) & { guard?: GuardCounts | null; warning?: string | null };

/** 只有「公司 岗位」时拿官方 JD：腾讯、百度、字节先查官网接口；其余联网搜，只认官方招聘域名和托管招聘系统。 */
async function findOfficialPosting(deps: ToolDeps, name: string): Promise<[string, Page]> {
  const [company, rest] = splitName(name);
  if (company && API_COMPANIES.includes(company) && deps.fetch) {
    let posting: OfficialPosting | null = null;
    let similar: string[] | null = null;
    try {
      [posting, similar] = await findViaApi(deps.fetch, company, rest);
    } catch {
      // 接口不通就退回联网搜，不当成「官网没有」
      posting = null;
      similar = null;
    }
    if (posting) return [posting.url, posting];
    if (similar !== null) {
      const near = similar.length ? `官网上名字相近的有：${similar.join("、")}，要的是其中一个就贴它的链接。` : "";
      throw new CoreError(`${company}招聘官网没找到「${rest}」，没存。${near}这个岗位可能只挂在 BOSS 等平台上：把 JD 文字贴进来就行`);
    }
  }
  if (!deps.search?.available) {
    throw new CoreError(`只有「${name}」要联网找官方岗位页，但没配搜索服务：在设置里填 Bocha / Tavily / Serper 的 key`
      + "（或装 ddgs）。也可以直接贴岗位链接或 JD", "unsupported");
  }
  const blocked = [...RESTRICTED_DOMAINS, ...PASTE_ONLY_DOMAINS];
  const tokens = name.split(/[\s·|/,，、]+/).filter(Boolean);
  const owner = (company || tokens[0] || "").toLowerCase();
  const seen = new Set<string>();
  const skipped: string[] = [];
  const ranked: Array<[number, string]> = [];
  for (const query of [`${name} 招聘 官网`, `${name} 岗位详情 投递`]) {
    let results: SearchResult[] = [];
    try {
      results = await deps.search.search(query, 8);
    } catch {
      results = [];
    }
    for (const result of results) {
      const url = String(result.url ?? "").trim();
      const host = hostOf(url);
      if (!url || seen.has(url) || !host || hostIn(host, blocked)) continue;
      seen.add(url);
      const kind = officialKind(url, company);
      if (!kind) {
        skipped.push(host);
        continue;
      }
      const title = String(result.title ?? "").toLowerCase();
      ranked.push([(kind === "own" ? 4 : 2) + tokens.filter((t) => title.includes(t.toLowerCase())).length * 2, url]);
    }
  }
  ranked.sort((a, b) => b[0] - a[0]);
  const tried: string[] = [];
  for (const [, url] of ranked.slice(0, 4)) {
    let page: FetchPageResult;
    try {
      page = await fetchPage(deps.fetch, url);
    } catch {
      tried.push(hostOf(url) || url);
      continue;
    }
    const body = `${page.title}\n${page.text}`.toLowerCase();
    const matched = tokens.filter((t) => body.includes(t.toLowerCase())).length;
    if (page.text.length >= 200 && owner && body.includes(owner) && matched * 2 >= tokens.length) return [url, page];
    tried.push(hostOf(url) || url);
  }
  const where = tried.length ? `（试过：${[...new Set(tried)].join("、")}）` : "";
  const other = skipped.length ? `搜到的 ${[...new Set(skipped)].slice(0, 4).join("、")} 不是官方招聘站，没采用。` : "";
  throw new CoreError(`联网没找到「${name}」能直接读到正文的官方岗位页${where}，没存。${other}把官网岗位链接或 JD 文字贴进来`);
}

/** 贴链接、JD 或只写「公司 岗位」建岗位。 */
export async function addJob(deps: ToolDeps, rawText: string): Promise<Json> {
  const { store, ctx } = deps;
  const text = rawText.trim();
  if (!text) throw new CoreError("要给岗位链接或 JD 文本");
  let url: string | null = /^https?:\/\/\S+$/.test(text) ? text : null;
  let page: Page | null = null;
  if (!url && isJobName(text)) [url, page] = await findOfficialPosting(deps, text);
  let source = text;
  let guardInfo: GuardCounts | null;
  let warn: string | null;
  if (url) {
    page = page ?? await fetchPage(deps.fetch, url);
    if (page.text.length < 200) throw new CoreError("这个页面要登录或靠 JS 渲染，抓不到正文，没存。用插件「存为岗位」，或者把 JD 文字贴进来");
    source = `${page.title}\n${page.text}`;
    guardInfo = page.guard ?? null;
    warn = page.warning ?? null;
  } else {
    const [clean, findings] = runGuard(text, false);
    source = clean;
    guardInfo = guardCounts(findings);
    warn = guardWarning(findings);
  }
  const known = await knownTags(store);
  const fields: Json = deps.llm ? await extractIntake(deps.llm, source, known) : guessIntake(source);
  const posting = (fields.posting ?? {}) as Json;
  const hire = url && !posting.hire_type ? hireFromUrl(url) : "";
  if (hire) fields.posting = { ...posting, hire_type: hire };
  const auto = autoTags(fields, url);
  delete fields.tags;
  const deadline = fields.deadline as string | undefined;
  delete fields.deadline;
  const how = fields.apply as string | undefined;
  delete fields.apply;
  const data: Json = {
    ...fields,
    jd: fields.jd || source,
    url,
    source: url ? hostOf(url) || null : null,
    notes: [warn, how ? `投递方式：${how}` : null].filter(Boolean).join("\n") || null,
  };
  if (!data.company && !data.title) data.title = guessIntake(source).title;
  Object.assign(data, mergeAutoTags(url ? await findJobByUrl(store, url) : null, auto));
  const saved = await saveRecord(store, { type: "job", data: compact(data) }, ctx);
  const out: Json = {
    record: saved.record,
    change_ids: saved.change_id ? [saved.change_id] : [],
    existed: saved.existed,
    guard: guardInfo,
  };
  if (warn) out.warning = warn;
  if (deadline && !saved.existed) {
    const event = await saveRecord(store, {
      type: "event",
      data: { title: `截止：${label(saved.record)}`, kind: "deadline", at: deadline, job_id: saved.record.id },
    }, ctx);
    (out.change_ids as number[]).push(event.change_id!);
  }
  return out;
}

/** 给已存的岗位补 job.posting；只写 posting，顶层字段只补空的，不动 JD 和投递状态。 */
export async function enrichJobs(deps: ToolDeps, ids?: number[] | null, redo = false): Promise<Json> {
  const { store, ctx } = deps;
  if (!deps.llm) throw new CoreError(NO_MODEL_SPLIT, "unsupported");
  let jobs: StoredRecord[];
  if (ids?.length) {
    const found = await Promise.all(ids.map((id) => store.get("job", id)));
    const missing = ids.filter((_, index) => !found[index]).map(String);
    if (missing.length) throw new CoreError("岗位不存在：#" + missing.join("、#"), "not_found");
    jobs = found as StoredRecord[];
  } else {
    jobs = (await store.all("job")).filter((job) => redo || !truthy(job.posting));
  }
  jobs = jobs.filter((job) => String(job.jd ?? "").trim());
  const known = await knownTags(store);
  const changeIds: number[] = [];
  const items: Json[] = [];
  const failed: string[] = [];
  for (const job of jobs) {
    const source = [job.company, job.title, job.city, String(job.jd)].filter(truthy).map(String).join("\n");
    let fields: Json;
    try {
      fields = await extractIntake(deps.llm, source, known);
    } catch (cause) {
      if (isCoreError(cause) && cause.code === "invalid") {
        failed.push(label(job));
        continue;
      }
      throw cause;
    }
    const data: Json = Object.fromEntries(["company", "title", "city"].filter((key) => truthy(fields[key]) && !truthy(job[key])).map((key) => [key, fields[key]]));
    const detail: Json = { ...((fields.posting ?? {}) as Json) };
    if (!detail.hire_type) {
      const hire = hireFromUrl(job.url);
      if (hire) detail.hire_type = hire;
    }
    if (Object.keys(detail).length) data.posting = detail;
    const auto = autoTags({ city: job.city || fields.city, posting: detail, tags: fields.tags }, job.url);
    const merged = mergeAutoTags(job, auto);
    if (stable([merged.tags, merged.auto_tags]) !== stable([job.tags ?? null, job.auto_tags ?? null])) Object.assign(data, merged);
    if (!Object.keys(data).length) {
      failed.push(label(job));
      continue;
    }
    const saved = await saveRecord(store, { type: "job", id: job.id, data }, ctx);
    changeIds.push(saved.change_id!);
    items.push({ id: job.id, label: label(job), keywords: ((data.posting ?? {}) as Json).keywords ?? [] });
  }
  return { count: items.length, change_ids: changeIds, items, failed };
}
