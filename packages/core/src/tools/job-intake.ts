// 贴进来的岗位链接正文或 JD 文本 → job 字段（port of backend/app/core/job_intake.py）。
// 调模型；没配模型时只做不会错的拆分（岗位名、截止日期），正文整段当 JD。只整理不编造。

import { chatJson, type LlmClient } from "../llm";
import { CoreError, type Json } from "../types";

export const INTAKE_PROMPT = `你是岗位信息整理助手。从岗位页面文字或 JD 里拆字段，只输出严格 JSON：
{"company": "", "title": "", "city": "", "deadline": "", "apply": "", "jd": "",
 "team": "", "hire_type": "", "years": "", "education": "", "salary": "", "job_code": "", "posted_at": "",
 "responsibilities": [], "hard_reqs": [], "soft_reqs": [], "keywords": [], "essence": "",
 "collaborators": [], "evidence": [{"req": "", "need": ""}], "tags": []}
规则：
1. 只用原文里有的信息，没有就留空，不猜。
2. title 是岗位名称，不带公司名。
3. deadline：原文写了投递截止日期就写成 YYYY-MM-DD，没有就留空。
4. apply：投递方式的原话，比如投递邮箱、邮件标题格式、附件要求；在官网投递就留空。
5. jd：岗位职责和要求的原文，去掉导航、页脚、其他岗位推荐等无关文字，不改写。
6. team：部门、事业群或产品线（如「百度搭子」「抖音电商」），原文没写就留空。
7. hire_type：校招 / 实习 / 社招 三选一，原文看不出就留空。
8. years、education、salary、job_code：原文怎么写就怎么写（如「3 年以上」「本科及以上」「20-35K」「J102408」），没写就留空，不估。
9. posted_at：原文写了发布或更新日期就写成 YYYY-MM-DD，没有就留空。
10. responsibilities：岗位职责，一条一项，保留原文措辞，最多 12 条。
11. hard_reqs：必须满足的要求（年限、学历、专业、技能门槛）；soft_reqs：加分项、优先条件。一条一项，原文措辞，各最多 12 条。
12. keywords：5–15 个技能、工具、领域词，必须是原文里出现过的词，按重要程度排。
13. essence：一句话（不超过 60 字）说清这个岗位实际在做什么，可以概括，但不能加入原文没有的事实。
14. collaborators：这个岗位日常要对接的上游、下游和协作方（如「产品经理」「销售团队」「外部 KOL」），按 JD 合理推断，最多 8 个，每个不超过 20 字；看不出就留空。
15. evidence：给每条 hard_reqs 写一条，req 原样抄 hard_reqs 里那一句，need 写候选人要准备哪类真实经历或材料来证明（不超过 50 字，只说类型，不编具体经历）。
16. tags：给岗位打 1–4 个短标签（每个不超过 8 字），属于推断：1–3 个岗位方向（如 产品、算法、前端、数据分析、运营），再加最多 1 个公司属性（大厂 / 外企 / 国企 / 央企 / 独角兽 / 初创，看不准就不打）。不要重复招聘类型和城市。用户消息开头给了「已有标签」时，意思相同就沿用已有的写法，不另造同义词。
`;

const LIMITS: Record<string, number> = { company: 80, title: 120, city: 40, apply: 500, jd: 20_000 };
const TEXTS: Record<string, number> = { team: 80, years: 40, education: 40, salary: 60, job_code: 40, essence: 80 };
const LISTS: Record<string, number> = { responsibilities: 12, hard_reqs: 12, soft_reqs: 12, keywords: 15, collaborators: 8 };
const ITEM_SIZE: Record<string, number> = { keywords: 40, collaborators: 30 };
const HIRE_TYPES = ["校招", "实习", "社招"];
const URL_HIRE: Record<string, string> = { social: "社招", experienced: "社招", campus: "校招", graduate: "校招", intern: "实习", internship: "实习" };
const TAG_SIZE = 8;
const MODEL_TAGS = 4;
const AUTO_TAGS = 6;

const cut = (value: string, size: number) => [...value].slice(0, size).join("");
const str = (value: unknown) => (value === null || value === undefined ? "" : String(value));

/** 模型没拆出招聘类型时的兜底：按链接路径段定。实习优先。 */
export function hireFromUrl(url: unknown): string {
  let path = "";
  try {
    path = new URL(str(url)).pathname;
  } catch {
    path = "";
  }
  const found = new Set(path.split("/").filter(Boolean).map((part) => URL_HIRE[part.toLowerCase()]).filter(Boolean));
  return ["实习", "校招", "社招"].find((name) => found.has(name)) ?? "";
}

function cityTag(city: unknown): string {
  let first = str(city).trim().split(/[、,，/／|\s]+/)[0] ?? "";
  if (first.endsWith("市")) first = first.slice(0, -1);
  const size = [...first].length;
  return size >= 1 && size <= 6 ? first : "";
}

/** Agent 自动标签：招聘类型、城市由代码定；方向、公司属性来自模型（推断）。最多 6 个。 */
export function autoTags(fields: Json, url?: unknown): string[] {
  const posting = (fields.posting ?? {}) as Json;
  const hire = str(posting.hire_type) || hireFromUrl(url);
  const out = [hire, cityTag(fields.city)].filter(Boolean);
  for (const tag of Array.isArray(fields.tags) ? fields.tags : []) {
    if (typeof tag === "string" && !out.includes(tag)) out.push(tag);
  }
  return out.slice(0, AUTO_TAGS);
}

const BULLET = /^\s*(?:[-•·●]|\d{1,2}\s*[.、)）])\s*/;

export function isoDate(value: unknown): string {
  const text = str(value).trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text) ?? /^(\d{4})(\d{2})(\d{2})$/.exec(text);
  if (!match) return "";
  const [y, m, d] = match.slice(1).map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d || y < 1) return "";
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function items(value: unknown, cap: number, size: number): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    const text = cut(str(item).trim().replace(BULLET, "").trim(), size);
    if (text && !out.includes(text)) out.push(text);
  }
  return out.slice(0, cap);
}

function evidence(value: unknown, reqs: string[]): Array<{ req: string; need: string }> {
  if (!Array.isArray(value) || !reqs.length) return [];
  const found = new Map<string, string>();
  for (const item of value) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) continue;
    const entry = item as Json;
    const req = cut(str(entry.req).trim().replace(BULLET, "").trim(), 200);
    const need = cut(str(entry.need).trim(), 120);
    if (reqs.includes(req) && need && !found.has(req)) found.set(req, need);
  }
  return reqs.filter((req) => found.has(req)).map((req) => ({ req, need: found.get(req)! }));
}

/** job.posting：不在取值范围内的丢掉；给了原文就只留原文里出现过的关键词和编号。 */
export function postingOf(parsed: Json, text = ""): Json {
  const out: Json = {};
  for (const [key, size] of Object.entries(TEXTS)) out[key] = cut(str(parsed[key]).trim(), size);
  const hire = str(parsed.hire_type).trim();
  out.hire_type = HIRE_TYPES.includes(hire) ? hire : "";
  out.posted_at = isoDate(parsed.posted_at);
  for (const [key, cap] of Object.entries(LISTS)) out[key] = items(parsed[key], cap, ITEM_SIZE[key] ?? 200);
  out.evidence = evidence(parsed.evidence, out.hard_reqs as string[]);
  if (text) {
    const low = text.toLowerCase();
    out.keywords = (out.keywords as string[]).filter((keyword) => low.includes(keyword.toLowerCase()));
    if (out.job_code && !low.includes(String(out.job_code).toLowerCase())) out.job_code = "";
  }
  return Object.fromEntries(Object.entries(out).filter(([, value]) => (Array.isArray(value) ? value.length : value)));
}

export function normalizeIntake(parsed: Json, text = ""): Json {
  const out: Json = {};
  for (const [key, limit] of Object.entries(LIMITS)) out[key] = cut(str(parsed[key]).trim(), limit);
  out.deadline = isoDate(parsed.deadline);
  const kept: Json = Object.fromEntries(Object.entries(out).filter(([, value]) => value));
  const detail = postingOf(parsed, text);
  if (Object.keys(detail).length) kept.posting = detail;
  const tags = items(parsed.tags, MODEL_TAGS, TAG_SIZE + 1)
    .map((tag) => tag.replace(/^#+/, "").trim())
    .filter(Boolean)
    .slice(0, MODEL_TAGS)
    .map((tag) => cut(tag, TAG_SIZE));
  if (tags.length) kept.tags = [...new Set(tags)];
  return kept;
}

const TITLE_HINT = /实习|工程师|开发|产品|运营|设计|分析|经理|助理|专员|顾问|研究员|管培|算法|测试|销售|市场/;
const DEADLINE_RE = /截止[^0-9\n]{0,8}(20\d{2})\s*[-./年]\s*(\d{1,2})\s*[-./月]\s*(\d{1,2})/;

/** 没模型时的兜底：取像岗位名的一段，认出「截止 2026-11-30」，整段当 JD。 */
export function guessIntake(text: string): Json {
  const first = text.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? "";
  const head = first.split(/[，,。；;：:！!？?]/)[0].trim();
  const parts = head.split(/[·|｜]/).map((part) => part.trim()).filter(Boolean);
  const title = parts.find((part) => TITLE_HINT.test(part)) ?? (parts[0] ?? head);
  const out: Json = { title: cut(title, 40), jd: cut(text.trim(), 20_000) };
  const found = DEADLINE_RE.exec(text);
  if (found) {
    const iso = isoDate(`${found[1]}-${found[2].padStart(2, "0")}-${found[3].padStart(2, "0")}`);
    if (iso) out.deadline = iso;
  }
  return out;
}

/** known：库里已有的标签（按使用次数排），让模型沿用同一套写法。 */
export async function extractIntake(llm: LlmClient, text: string, known: string[] = []): Promise<Json> {
  const parsed = await chatJson(llm, [
    { role: "system", content: INTAKE_PROMPT },
    { role: "user", content: (known.length ? `已有标签：${known.slice(0, 60).join("、")}\n\n` : "") + text.slice(0, 20_000) },
  ], { temperature: 0.1, maxTokens: 8000 });
  if (!parsed) throw new CoreError("模型没返回可用的岗位字段，没存");
  return normalizeIntake(parsed, text);
}
