// Job evaluation: profile + career memory + JD → fixed-structure report and a
// 0–100 score from a fixed rubric. Port of Python app/core/job_eval.py.
// No network besides the injected LLM; "## 来源" is always written by code.

import type { LlmClient } from "../llm";
import { extractJson } from "../llm";
import { officialKind } from "./official-sources";
import { cut, hostnameOf, pyIntRound, pyIter, pyStr, truthy } from "./py";

type Rec = Record<string, unknown>;

export const JOB_EVAL_SECTIONS = ["岗位摘要", "逐条匹配", "来源与真假", "职级与薪资", "简历怎么改", "面试准备", "反问"] as const;

/** Rubric v2: the model scores fixed parts, code adds them. v1 scores (model total) are not comparable and are not re-scored. */
export const RUBRIC_VERSION = "v2";
export const RUBRIC: ReadonlyArray<readonly [key: string, name: string, cap: number]> = [
  ["hard", "硬门槛", 25], ["core", "核心职责", 30], ["evidence", "证据强度", 20],
  ["industry", "行业认知", 15], ["expression", "表达", 10],
];

/** Third-party platforms behind a login: JDs from these are community signals. */
export const PLATFORMS: Record<string, string> = {
  boss: "BOSS 直聘", xhs: "小红书", liepin: "猎聘", maimai: "脉脉", lagou: "拉勾", nowcoder: "牛客",
};

export const PROFILE_KEYS = ["school", "major", "degree", "grad_year", "city", "target", "stage", "about"] as const;

const POSTING_META: ReadonlyArray<readonly [string, string]> = [
  ["hire_type", "招聘类型"], ["team", "部门"], ["years", "年限"], ["education", "学历"],
  ["salary", "薪资"], ["job_code", "编号"], ["posted_at", "发布日"],
];
const POSTING_LISTS: ReadonlyArray<readonly [string, string]> = [
  ["responsibilities", "职责"], ["hard_reqs", "硬性要求"], ["soft_reqs", "加分项"],
];

const isObject = (value: unknown): value is Rec => typeof value === "object" && value !== null && !Array.isArray(value);
const strOr = (value: unknown): string => (truthy(value) ? pyStr(value) : "");

export type RubricParts = Record<string, number>;

/** Parts capped to their limits; a missing / non-numeric part means "no breakdown" (fall back to the model's score). */
export function rubricBreakdown(raw: unknown): RubricParts | null {
  if (!isObject(raw)) return null;
  const parts: RubricParts = {};
  for (const [key, , cap] of RUBRIC) {
    if (!(key in raw)) return null;
    const value = pyIntRound(raw[key]);
    if (value === null) return null;
    parts[key] = Math.max(0, Math.min(cap, value));
  }
  return parts;
}

export function rubricSection(parts: RubricParts): string {
  const items = RUBRIC.map(([key, name, cap]) => `${name} ${parts[key]}/${cap}`).join("、");
  const total = RUBRIC.reduce((sum, [key]) => sum + parts[key], 0);
  return `## 评分口径\n口径 ${RUBRIC_VERSION}：${items}，合计 ${total}。`;
}

export const JOB_EVAL_PROMPT = "你是求职顾问。根据候选人的档案和职业记忆，评估一个岗位，只输出严格 JSON：\n{\"breakdown\": {\"hard\": 0, \"core\": 0, \"evidence\": 0, \"industry\": 0, \"expression\": 0}, \"reasons\": [\"\", \"\", \"\"], \"greeting\": \"\", \"markdown\": \"\"}\n\nbreakdown：按固定口径分项打整数分，总分由系统相加，不要自己写 score。hard 硬门槛 0–25（学历、年限、必备技能、到岗时间这些硬性要求满足多少，有一条明确不满足最多给 10）；core 核心职责 0–30（JD 主要职责里有多少件档案里做过同类的事）；evidence 证据强度 0–20（对口经历有没有具体做法和量化结果，只写了「参与」、没有结果的算弱）；industry 行业认知 0–15（做过或接触过同行业、同类产品或业务）；expression 表达 0–10（档案里的经历能不能直接改写成 JD 的语言：信息完整、有数字）。JD 信息太少或档案是空的，各项都从低给，并在理由里说明。总分 80 以上值得优先投，60–79 可以投，60 以下不建议。\nreasons：恰好三句，每句不超过 40 字：最匹配的点 / 最大的差距或风险 / 和偏好（城市、方向、公司类型）是否相符。\ngreeting：投递时发给 HR 的打招呼语（BOSS 直聘、内推私信这类），第一人称，80–150 字：一句我是谁（学校专业或当前身份）+ 2 条和这个岗位最对口的经历（用档案里的数字，用 JD 的词）+ 一句希望进一步沟通。只用档案和记忆里的事实，不编数字，不写「待补充」，不带口径标签和联系方式，语气得体不夸张。档案是空的就留空。\nmarkdown：评估报告，严格按这个结构：\n# 结论\n一句话：这是什么岗位、建议优先投 / 可以投 / 不建议投，为什么。\n> 风险：最大的一条风险。\n- 3 条关键观察\n## 岗位摘要\n## 逐条匹配\n## 来源与真假\n## 职级与薪资\n## 简历怎么改\n## 面试准备\n## 反问\n每个板块第一段是一句摘要，下面每条要点一行「- …」，尽量落到「对你意味着什么」。\n各板块写什么：\n- 岗位摘要：做什么、核心指标、硬性要求（年限、学历、技能）。\n- 逐条匹配：JD 每条要求一行，写「要求 → 强 / 中 / 弱 / 无」。强＝档案里有同类经历且有结果；中＝做过相近的事，或做过但缺结果；弱＝只有可迁移的能力；无＝档案里找不到。强和中点名档案里哪段经历，弱和无写怎么补或面试怎么讲。\n- 来源与真假：照输入里的「来源可信度」和备注写；年限、薪资、编号前后不一致要点出来；官网查不到就建议投前向 HR 确认。\n- 职级与薪资：只用 JD 和备注里写了的；没有就写 [gap]，不估薪资数字。\n- 简历怎么改：哪段经历放前面、用 JD 的哪些词、哪些数字要突出；只用档案里的事实，没有的写「（待补充：…）」。\n- 面试准备：最可能被问的 4–6 个问题，每个配一段档案里的经历当 STAR 素材。\n- 反问：3 个能顺便核实岗位真实情况的反问。\n口径标签：每条要点和每个板块的摘要句末尾都必须标一个。来自 JD 或备注的事实标输入里给的 JD 标签（如 [official S1] 或 [community S1]）；\n引用候选人档案或记忆的判断标 [inference S2]；纯推断标 [inference]；资料里没有的标 [gap]。\n硬规则：只用档案、记忆、JD 和备注里写了的事实，不编经历、数字、公司信息；不要写「## 来源」，来源由系统补。\n";

/** Candidate block for the prompt (profile keys + memories), capped at 12k code points. Also used by apply answers. */
export function candidateText(profile: Rec | null | undefined, memories: Iterable<Rec>): string {
  const lines: string[] = [];
  if (truthy(profile)) {
    const p = profile as Rec;
    lines.push(`档案：${PROFILE_KEYS.filter((key) => truthy(p[key])).map((key) => `${key}=${pyStr(p[key])}`).join("；")}`);
  }
  for (const memory of memories) {
    const kind = strOr(memory.kind) || "note";
    lines.push(`[${kind}] ${strOr(memory.title)} ${cut(strOr(memory.body), 300)}`.trim());
  }
  return cut(lines.join("\n"), 12_000);
}

/** job.posting (split requirements and keywords) for evaluation and tailoring; "" when never split. */
export function postingBlock(job: Rec): string {
  const posting = truthy(job.posting) ? job.posting : {};
  if (!isObject(posting)) return "";
  const p = posting;
  const parts: string[] = [];
  const meta = POSTING_META.filter(([key]) => truthy(p[key])).map(([key, name]) => `${name}：${pyStr(p[key])}`).join("；");
  if (meta) parts.push(meta);
  for (const [key, name] of POSTING_LISTS) {
    const items = pyIter(truthy(p[key]) ? p[key] : []).map(pyStr).filter((item) => item.trim());
    if (items.length) parts.push(`${name}：\n${items.map((item, index) => `${index + 1}. ${item}`).join("\n")}`);
  }
  if (truthy(p.keywords)) parts.push(`关键词：${pyIter(p.keywords).map(pyStr).join("、")}`);
  if (parts.length && truthy(p.collaborators)) {
    parts.push(`协作对象（推断，非原文）：${pyIter(p.collaborators).map(pyStr).join("、")}`);
  }
  const evidence = pyIter(truthy(p.evidence) ? p.evidence : []).filter((e): e is Rec => isObject(e) && truthy(e.req) && truthy(e.need));
  if (parts.length && evidence.length) {
    parts.push(`证明硬性要求要准备的经历（推断）：\n${evidence.map((e) => `- ${pyStr(e.req)} → ${pyStr(e.need)}`).join("\n")}`);
  }
  if (parts.length && truthy(p.essence)) parts.push(`岗位本质（推断，非原文）：${pyStr(p.essence)}`);
  return parts.join("\n");
}

/** With a posting: split items + a JD excerpt; without: the first 3000 code points of the JD. */
export function jobText(job: Rec): string {
  const head = `id=${pyStr(job.id)} 公司：${strOr(job.company)} 岗位：${strOr(job.title)} 城市：${strOr(job.city)}`;
  const jd = strOr(job.jd);
  const block = postingBlock(job);
  if (!block) return `${head}\n${cut(jd, 3000)}`;
  return `${head}\n${block}\n\nJD 原文（节选，要求以上面拆条为准）：\n${cut(jd, 1500)}`;
}

/** [label, where]: the company's own site or its hosted ATS is "official", everything else "community". */
export function sourceFact(job: Rec): [label: "official" | "community", where: string] {
  const url = strOr(job.url);
  const host = url ? hostnameOf(url) : "";
  if (url) {
    const kind = officialKind(url, strOr(job.company));
    if (kind === "own") return ["official", `公司自有招聘官网（${host}）`];
    if (kind) return ["official", `公司开通的托管招聘系统（${host}）`];
  }
  const source = strOr(job.source).toLowerCase();
  const platform = Object.hasOwn(PLATFORMS, source) ? PLATFORMS[source] : "";
  if (platform) return ["community", `第三方平台（${platform}），没在招聘官网核实`];
  if (host) return ["community", `非官方页面（${host}），没在招聘官网核实`];
  return ["community", "用户粘贴的 JD，没有链接，来源未核实"];
}

export function sourcesSection(job: Rec, where: string): string {
  const url = strOr(job.url);
  const jd = `- S1 岗位 JD · ${where}${url ? ` · ${url}` : ""}`;
  return `## 来源\n${jd}\n- S2 你的档案和职业记忆 · OfferU\n`;
}

export type JobEvaluation = { score: number; reasons: string[]; greeting: string; markdown: string };

/** Validate and normalize the model's JSON. Returns null when unusable (no "# 结论", no score). */
export function normalizeEvaluation(parsed: unknown, job: Rec, where: string): JobEvaluation | null {
  if (!isObject(parsed)) return null;
  let markdown = strOr(parsed.markdown).trim();
  if (!markdown.includes("# 结论")) return null;
  const parts = rubricBreakdown(parsed.breakdown);
  let score: number;
  if (parts !== null) {
    score = RUBRIC.reduce((sum, [key]) => sum + parts[key], 0);
  } else {
    const fallback = pyIntRound(parsed.score);
    if (fallback === null) return null;
    score = fallback;
  }
  // Sources written by the model are dropped; sourcesSection() rewrites them.
  markdown = markdown.split(/^##\s*(?:来源|sources?)\s*$/im)[0].trimEnd();
  if (parts !== null) markdown = `${markdown}\n\n${rubricSection(parts)}`;
  const reasons = pyIter(truthy(parsed.reasons) ? parsed.reasons : [])
    .map((reason) => pyStr(reason).trim())
    .filter(Boolean)
    .map((reason) => cut(reason, 80))
    .slice(0, 3);
  const greeting = cut(strOr(parsed.greeting).trim(), 300);
  return {
    score: Math.max(0, Math.min(100, score)),
    reasons,
    greeting,
    markdown: `${markdown}\n\n${sourcesSection(job, where)}`,
  };
}

/** The user message sent with JOB_EVAL_PROMPT. */
export function jobEvalUserMessage(profileText: string, job: Rec): string {
  const [label, where] = sourceFact(job);
  return `候选人：\n${profileText || "（档案是空的）"}`
    + `\n\n岗位：\n${jobText(job)}`
    + `\n备注：${strOr(job.notes).trim() || "无"}`
    + `\n来源可信度：${where}。JD 里的事实标 [${label} S1]。`;
}

/** One LLM call → normalized evaluation, or null when the model gave nothing usable. */
export async function evaluateJob(llm: LlmClient, profileText: string, job: Rec, signal?: AbortSignal): Promise<JobEvaluation | null> {
  const [, where] = sourceFact(job);
  const raw = await llm.chat(
    [{ role: "system", content: JOB_EVAL_PROMPT }, { role: "user", content: jobEvalUserMessage(profileText, job) }],
    { temperature: 0.2, json: true, maxTokens: 6000, signal },
  );
  return normalizeEvaluation(extractJson(raw ?? ""), job, where);
}
