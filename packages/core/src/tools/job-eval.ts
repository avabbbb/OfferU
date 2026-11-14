// 岗位评估（port of backend/app/core/job_eval.py）：读档案、职业记忆和 JD，出固定结构的评估报告和 0–100 分。
// 不联网；「## 来源」由代码写。candidate / jobText 网申回答也用。

import { chatJson, type LlmClient } from "../llm";
import type { Json } from "../types";
import { hostOf, officialKind } from "./job-sources";

export const RUBRIC_VERSION = "v2";
export const RUBRIC: Array<[string, string, number]> = [
  ["hard", "硬门槛", 25], ["core", "核心职责", 30], ["evidence", "证据强度", 20], ["industry", "行业认知", 15], ["expression", "表达", 10],
];

/** Python round(): banker's rounding on .5. */
export function pyRound(value: number): number {
  const floor = Math.floor(value);
  const diff = value - floor;
  if (diff > 0.5) return floor + 1;
  if (diff < 0.5) return floor;
  return floor % 2 === 0 ? floor : floor + 1;
}

/** Python float(x) for the values a model returns: numbers, numeric strings, bools. NaN when not convertible. */
function pyFloat(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "string" && value.trim() && /^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(value.trim().replace(/_/g, ""))) return Number(value.trim().replace(/_/g, ""));
  return Number.NaN;
}

function breakdown(raw: unknown): Record<string, number> | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const parts: Record<string, number> = {};
  for (const [key, , cap] of RUBRIC) {
    const value = pyFloat((raw as Json)[key]);
    if (!Number.isFinite(value)) return null;
    parts[key] = Math.max(0, Math.min(cap, pyRound(value)));
  }
  return parts;
}

export function rubricSection(parts: Record<string, number>): string {
  const items = RUBRIC.map(([key, name, cap]) => `${name} ${parts[key]}/${cap}`).join("、");
  return `## 评分口径\n口径 ${RUBRIC_VERSION}：${items}，合计 ${Object.values(parts).reduce((a, b) => a + b, 0)}。`;
}

export const EVAL_PROMPT = `你是求职顾问。根据候选人的档案和职业记忆，评估一个岗位，只输出严格 JSON：
{"breakdown": {"hard": 0, "core": 0, "evidence": 0, "industry": 0, "expression": 0}, "reasons": ["", "", ""], "greeting": "", "markdown": ""}

breakdown：按固定口径分项打整数分，总分由系统相加，不要自己写 score。hard 硬门槛 0–25（学历、年限、必备技能、到岗时间这些硬性要求满足多少，有一条明确不满足最多给 10）；core 核心职责 0–30（JD 主要职责里有多少件档案里做过同类的事）；evidence 证据强度 0–20（对口经历有没有具体做法和量化结果，只写了「参与」、没有结果的算弱）；industry 行业认知 0–15（做过或接触过同行业、同类产品或业务）；expression 表达 0–10（档案里的经历能不能直接改写成 JD 的语言：信息完整、有数字）。JD 信息太少或档案是空的，各项都从低给，并在理由里说明。总分 80 以上值得优先投，60–79 可以投，60 以下不建议。
reasons：恰好三句，每句不超过 40 字：最匹配的点 / 最大的差距或风险 / 和偏好（城市、方向、公司类型）是否相符。
greeting：投递时发给 HR 的打招呼语（BOSS 直聘、内推私信这类），第一人称，80–150 字：一句我是谁（学校专业或当前身份）+ 2 条和这个岗位最对口的经历（用档案里的数字，用 JD 的词）+ 一句希望进一步沟通。只用档案和记忆里的事实，不编数字，不写「待补充」，不带口径标签和联系方式，语气得体不夸张。档案是空的就留空。
markdown：评估报告，严格按这个结构：
# 结论
一句话：这是什么岗位、建议优先投 / 可以投 / 不建议投，为什么。
> 风险：最大的一条风险。
- 3 条关键观察
## 岗位摘要
## 逐条匹配
## 来源与真假
## 职级与薪资
## 简历怎么改
## 面试准备
## 反问
每个板块第一段是一句摘要，下面每条要点一行「- …」，尽量落到「对你意味着什么」。
各板块写什么：
- 岗位摘要：做什么、核心指标、硬性要求（年限、学历、技能）。
- 逐条匹配：JD 每条要求一行，写「要求 → 强 / 中 / 弱 / 无」。强＝档案里有同类经历且有结果；中＝做过相近的事，或做过但缺结果；弱＝只有可迁移的能力；无＝档案里找不到。强和中点名档案里哪段经历，弱和无写怎么补或面试怎么讲。
- 来源与真假：照输入里的「来源可信度」和备注写；年限、薪资、编号前后不一致要点出来；官网查不到就建议投前向 HR 确认。
- 职级与薪资：只用 JD 和备注里写了的；没有就写 [gap]，不估薪资数字。
- 简历怎么改：哪段经历放前面、用 JD 的哪些词、哪些数字要突出；只用档案里的事实，没有的写「（待补充：…）」。
- 面试准备：最可能被问的 4–6 个问题，每个配一段档案里的经历当 STAR 素材。
- 反问：3 个能顺便核实岗位真实情况的反问。
口径标签：每条要点和每个板块的摘要句末尾都必须标一个。来自 JD 或备注的事实标输入里给的 JD 标签（如 [official S1] 或 [community S1]）；
引用候选人档案或记忆的判断标 [inference S2]；纯推断标 [inference]；资料里没有的标 [gap]。
硬规则：只用档案、记忆、JD 和备注里写了的事实，不编经历、数字、公司信息；不要写「## 来源」，来源由系统补。
`;

const PLATFORMS: Record<string, string> = { boss: "BOSS 直聘", xhs: "小红书", liepin: "猎聘", maimai: "脉脉", lagou: "拉勾", nowcoder: "牛客" };
const PROFILE_KEYS = ["school", "major", "degree", "grad_year", "city", "target", "stage", "about"];

/** Python str() of a JSON value, for prompt text. */
export function pyStr(value: unknown): string {
  if (value === null || value === undefined) return "None";
  if (typeof value === "boolean") return value ? "True" : "False";
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  return JSON.stringify(value);
}

const truthy = (value: unknown) => value !== null && value !== undefined && value !== "" && value !== false && value !== 0
  && !(Array.isArray(value) && !value.length) && !(typeof value === "object" && !Array.isArray(value) && value !== null && !Object.keys(value).length);

export function candidate(profile: Json | null | undefined, memories: Json[]): string {
  const lines: string[] = [];
  if (profile) lines.push("档案：" + PROFILE_KEYS.filter((key) => truthy(profile[key])).map((key) => `${key}=${pyStr(profile[key])}`).join("；"));
  for (const memory of memories) {
    const body = truthy(memory.body) ? pyStr(memory.body) : "";
    lines.push(`[${truthy(memory.kind) ? pyStr(memory.kind) : "note"}] ${truthy(memory.title) ? pyStr(memory.title) : ""} ${body.slice(0, 300)}`.trim());
  }
  return lines.join("\n").slice(0, 12_000);
}

const POSTING_META: Array<[string, string]> = [["hire_type", "招聘类型"], ["team", "部门"], ["years", "年限"], ["education", "学历"],
  ["salary", "薪资"], ["job_code", "编号"], ["posted_at", "发布日"]];
const POSTING_LISTS: Array<[string, string]> = [["responsibilities", "职责"], ["hard_reqs", "硬性要求"], ["soft_reqs", "加分项"]];

/** job.posting 拆好的要求和关键词；没拆过返回空串。 */
export function postingBlock(job: Json): string {
  const p = job.posting;
  if (typeof p !== "object" || p === null || Array.isArray(p)) return "";
  const posting = p as Json;
  const parts: string[] = [];
  const meta = POSTING_META.filter(([key]) => truthy(posting[key])).map(([key, name]) => `${name}：${pyStr(posting[key])}`).join("；");
  if (meta) parts.push(meta);
  for (const [key, name] of POSTING_LISTS) {
    const list = (Array.isArray(posting[key]) ? posting[key] as unknown[] : []).map(pyStr).filter((x) => x.trim());
    if (list.length) parts.push(`${name}：\n` + list.map((x, i) => `${i + 1}. ${x}`).join("\n"));
  }
  if (truthy(posting.keywords) && Array.isArray(posting.keywords)) parts.push("关键词：" + posting.keywords.map(pyStr).join("、"));
  if (parts.length && truthy(posting.collaborators) && Array.isArray(posting.collaborators)) {
    parts.push("协作对象（推断，非原文）：" + posting.collaborators.map(pyStr).join("、"));
  }
  const evidence = (Array.isArray(posting.evidence) ? posting.evidence : [])
    .filter((e): e is Json => typeof e === "object" && e !== null && truthy((e as Json).req) && truthy((e as Json).need));
  if (parts.length && evidence.length) {
    parts.push("证明硬性要求要准备的经历（推断）：\n" + evidence.map((e) => `- ${pyStr(e.req)} → ${pyStr(e.need)}`).join("\n"));
  }
  if (parts.length && truthy(posting.essence)) parts.push(`岗位本质（推断，非原文）：${pyStr(posting.essence)}`);
  return parts.join("\n");
}

const field = (job: Json, key: string) => (truthy(job[key]) ? pyStr(job[key]) : "");

/** 有 posting 就给拆条 + JD 原文节选；没有就截 JD 前 3000 字。 */
export function jobText(job: Json): string {
  const head = `id=${pyStr(job.id)} 公司：${field(job, "company")} 岗位：${field(job, "title")} 城市：${field(job, "city")}`;
  const jd = field(job, "jd");
  const block = postingBlock(job);
  if (!block) return `${head}\n${jd.slice(0, 3000)}`;
  return `${head}\n${block}\n\nJD 原文（节选，要求以上面拆条为准）：\n${jd.slice(0, 1500)}`;
}

/** [口径标签, 来源说明]：官网或托管招聘系统是 official，其余都是 community。 */
export function sourceFact(job: Json): ["official" | "community", string] {
  const url = field(job, "url");
  const host = url ? hostOf(url) : "";
  if (url) {
    const kind = officialKind(url, field(job, "company"));
    if (kind === "own") return ["official", `公司自有招聘官网（${host}）`];
    if (kind) return ["official", `公司开通的托管招聘系统（${host}）`];
  }
  const platform = PLATFORMS[field(job, "source").toLowerCase()];
  if (platform) return ["community", `第三方平台（${platform}），没在招聘官网核实`];
  if (host) return ["community", `非官方页面（${host}），没在招聘官网核实`];
  return ["community", "用户粘贴的 JD，没有链接，来源未核实"];
}

export function sources(job: Json, where: string): string {
  const url = field(job, "url");
  const jd = `- S1 岗位 JD · ${where}` + (url ? ` · ${url}` : "");
  return `## 来源\n${jd}\n- S2 你的档案和职业记忆 · OfferU\n`;
}

export type Evaluation = { score: number; reasons: string[]; greeting: string; markdown: string };

export function normalizeEvaluation(parsed: unknown, job: Json, where: string): Evaluation | null {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const data = parsed as Json;
  let markdown = (truthy(data.markdown) ? pyStr(data.markdown) : "").trim();
  if (!markdown.includes("# 结论")) return null;
  const parts = breakdown(data.breakdown);
  let score: number;
  if (parts) score = Object.values(parts).reduce((a, b) => a + b, 0);
  else {
    const raw = pyFloat(data.score);
    if (!Number.isFinite(raw)) return null;
    score = pyRound(raw);
  }
  // 模型自己写的来源不采用，由 sources() 重写。
  markdown = markdown.split(/^##\s*(?:来源|sources?)\s*$/im)[0].trimEnd();
  if (parts) markdown = `${markdown}\n\n${rubricSection(parts)}`;
  const reasons = (Array.isArray(data.reasons) ? data.reasons : [])
    .map((r) => pyStr(r).trim()).filter(Boolean).map((r) => [...r].slice(0, 80).join("")).slice(0, 3);
  const greeting = [...(truthy(data.greeting) ? pyStr(data.greeting) : "").trim()].slice(0, 300).join("");
  return { score: Math.max(0, Math.min(100, score)), reasons, greeting, markdown: `${markdown}\n\n${sources(job, where)}` };
}

export async function evaluateJob(llm: LlmClient, profileText: string, job: Json): Promise<Evaluation | null> {
  const [tag, where] = sourceFact(job);
  const user = "候选人：\n" + (profileText || "（档案是空的）")
    + "\n\n岗位：\n" + jobText(job)
    + "\n备注：" + ((truthy(job.notes) ? pyStr(job.notes) : "").trim() || "无")
    + `\n来源可信度：${where}。JD 里的事实标 [${tag} S1]。`;
  const parsed = await chatJson(llm, [{ role: "system", content: EVAL_PROMPT }, { role: "user", content: user }], { temperature: 0.2, maxTokens: 6000 });
  return normalizeEvaluation(parsed, job, where);
}
