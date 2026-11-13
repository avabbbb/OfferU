// 改写时追问成果：用户的回答 → 记忆草稿（port of backend/app/core/impact.py）。
// 一次模型调用，只出草稿、不写库；用户确认后前端逐条走 save(actor=你)。代码只在草稿上标出要留意的地方。

import type { LlmClient, LlmMessage } from "../llm";
import { CoreError, type CoreStore, type StoredRecord } from "../types";
import { head, pyStr, truthy } from "./py";

export const MAX_ANSWERS = 3;
// 用户原话里出现这些词，算「说的是大概」；草稿里要留下后一组里的至少一个。
export const VAGUE_SAID = ["大概", "大约", "约", "左右", "差不多", "估计", "将近", "记不清", "印象中", "上下"];
export const VAGUE_KEPT = ["约", "大概", "左右", "将近", "余", "上下"];
const HEDGE_RE = /大概|大约|差不多|将近|左右|约/g;
// 原话没说、草稿却加上的程度词，算拔高。
export const INTENSE = ["明显", "显著", "大幅", "极大", "大大", "全面", "彻底", "成倍"];
// 汉字数字：带「成」「倍」「个百分点」的，和「百分之……」。
export const CN_NUMBER_RE = /百分之[零〇一二两三四五六七八九十百几]+|[零〇一二两三四五六七八九十百千万几半]+(?:成|倍|个百分点)/g;

export const IMPACT_PROMPT = `你是求职档案整理助手。用户改简历时回答了几个「做出了什么结果」的问题。把每个回答整理成一句能写进档案的话，只输出严格 JSON：
{"drafts": [{"index": 0, "memory_id": 12, "title": "", "add": "整理后的一句话"}]}
规则：
1. 每个回答出一条，index 用回答的序号。
2. memory_id：这句简历原句对应「已有记忆」里的哪一条，填它的数字 id；对不上就填 null（会新建一条记忆），这时 title 写一个简短标题。
3. add 只写用户回答里的结果，一句话，书面一点；数字、比例、时间、奖项名称只能用用户原话里有的，原话没有的一个也不能加。
4. 程度跟原话走：原话说「快多了」就写「更快」，不要自己加「明显」「显著」「大幅」。
5. 用户说了「大概」「左右」「记不清」这类话，add 里保留一个约数词就够，不要写成「约三成左右」。
6. 用户说没有数据，就只写定性的结果，不出现数字。
7. 回答和问题对不上也照实整理，不要硬套问题里的说法。
`;

export type ImpactAnswerIn = { old?: unknown; question?: unknown; answer?: unknown };
export type ImpactItem = { index: number; old: string; question: string; quote: string };
export type ImpactDraftAnswer = ImpactItem & { add: string; flags: string[] };
export type ImpactDraft = { memory_id: number | null; title: string; data: Record<string, unknown>; answers: ImpactDraftAnswer[] };
export type ImpactResult = { drafts: ImpactDraft[]; dropped: Array<ImpactItem & { why: string }> };

const uniq = <T>(items: T[]): T[] => [...new Set(items)];

/** 文字里的数字，千分位逗号去掉；汉字数字按原样算。 */
export function impactNumbers(text: string): string[] {
  const plain = text.replace(/(?<=\p{Nd}),(?=\p{Nd}{3}(?!\p{Nd}))/gu, "");
  return [...(plain.match(/\p{Nd}+(?:\.\p{Nd}+)?/gu) ?? []), ...(plain.match(CN_NUMBER_RE) ?? [])];
}

/** 草稿这句话要用户留意的地方；空列表就是没什么要提醒的。 */
export function impactFlags(add: string, said: string): string[] {
  const out: string[] = [];
  const known = new Set(impactNumbers(said));
  const missing = uniq(impactNumbers(add)).filter((n) => !known.has(n));
  if (missing.length) out.push("原话里没有这个数字：" + missing.join("、"));
  if (VAGUE_SAID.some((w) => said.includes(w)) && !VAGUE_KEPT.some((w) => add.includes(w))) out.push("原话是「大概」，草稿没带约数词");
  const hedges = uniq(add.match(HEDGE_RE) ?? []);
  if (hedges.length > 1) out.push("约数词叠用了：" + hedges.join("、"));
  const louder = INTENSE.filter((w) => add.includes(w) && !said.includes(w));
  if (louder.length) out.push("原话没有这个程度：" + louder.join("、"));
  return out;
}

const field = (value: unknown): string => (truthy(value) ? pyStr(value) : "").trim();

/** 只要有内容的回答（空的就是「先不答」），index 保留原序号。 */
export function impactItems(answers: ImpactAnswerIn[]): ImpactItem[] {
  const out: ImpactItem[] = [];
  answers.slice(0, MAX_ANSWERS).forEach((item, index) => {
    const said = field(item.answer);
    if (said) out.push({ index, old: field(item.old), question: field(item.question), quote: said });
  });
  return out;
}

export function impactMessages(items: ImpactItem[], jobTitle: string, memories: StoredRecord[]): LlmMessage[] {
  const known = memories.map((m) => `#${m.id} ${truthy(m.title) ? pyStr(m.title) : ""}：${(truthy(m.body) ? pyStr(m.body) : "").split("\n").join(" / ")}`)
    .join("\n") || "（没有）";
  const asked = items.map((i) => `### 回答 ${i.index}\n简历原句：${i.old}\n问题：${i.question}\n用户原话：${i.quote}`).join("\n\n");
  const user = `## 岗位\n${jobTitle || "（没写）"}\n\n## 已有记忆\n${known}\n\n## 用户的回答\n${asked}`;
  return [{ role: "system", content: IMPACT_PROMPT }, { role: "user", content: user }];
}

export function parseImpactDrafts(raw: string | null | undefined): Array<Record<string, unknown>> {
  const text = (raw ?? "").trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  let data: unknown = null;
  if (start >= 0 && start < end) {
    try { data = JSON.parse(text.slice(start, end + 1)); } catch { data = null; }
  }
  const drafts = data && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>).drafts : null;
  if (!Array.isArray(drafts)) throw new CoreError("整理回答的模型没返回可用的草稿，档案没动");
  return drafts.filter((d): d is Record<string, unknown> => typeof d === "object" && d !== null && !Array.isArray(d));
}

/** Python int(value) or None. */
function toInt(value: unknown): number | null {
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "number") return Number.isFinite(value) ? Math.trunc(value) : null;
  if (typeof value === "string" && /^\s*[+-]?\d+\s*$/.test(value)) return Number.parseInt(value, 10);
  return null;
}

const BULLET_HEAD = /^[-*·•]\s*/u;

/**
 * answers：[{old, question, answer}]，最多 3 条。返回 {drafts, dropped}，不写库。
 * data 就是要传给 save("memory", data, memory_id) 的内容：补到已有记忆就是整条新 body，对不上就新建 kind=note。
 */
export async function captureImpact(
  store: CoreStore,
  llm: LlmClient,
  answers: ImpactAnswerIn[],
  jobTitle = "",
  today: string,
): Promise<ImpactResult> {
  const items = impactItems(answers);
  if (!items.length) throw new CoreError("没有要整理的回答，档案没动");
  const all = await store.all("memory");
  const memories = new Map(all.map((m) => [m.id, m]));
  const raw = await llm.chat(impactMessages(items, jobTitle, all), { temperature: 0.1, json: true, maxTokens: 2048 });
  const byIndex = new Map(items.map((item) => [item.index, item]));
  const groups = new Map<number | string, { memory: StoredRecord | null; title: string; answers: ImpactDraftAnswer[] }>();
  const seen = new Set<number>();
  for (const draft of parseImpactDrafts(raw)) {
    const index = toInt(draft.index);
    const item = index === null ? undefined : byIndex.get(index);
    const add = field(draft.add).replace(BULLET_HEAD, "");
    if (!item || seen.has(item.index) || !add) continue;
    seen.add(item.index);
    const memoryId = toInt(draft.memory_id);
    const memory = memoryId === null ? null : memories.get(memoryId) ?? null;
    const key = memory ? memory.id : `new-${item.index}`;
    const title = (memory && truthy(memory.title) ? pyStr(memory.title) : "") || field(draft.title) || item.old.replace(BULLET_HEAD, "");
    if (!groups.has(key)) groups.set(key, { memory, title: head(title, 120), answers: [] });
    groups.get(key)!.answers.push({ ...item, add, flags: impactFlags(add, item.quote) });
  }
  const dropped = items.filter((item) => !seen.has(item.index)).map((item) => ({ ...item, why: "模型没整理这条回答" }));

  const drafts: ImpactDraft[] = [];
  for (const group of groups.values()) {
    const memory = group.memory;
    const lines = group.answers.map((a) => "- " + a.add).join("\n");
    // 同一句原话答了两个问题，或和档案里已有的一样，只记一次
    const quote = uniq([memory?.quote, ...group.answers.map((a) => a.quote)].filter(truthy).map(pyStr)).join("；");
    const data: Record<string, unknown> = memory
      ? { body: ((truthy(memory.body) ? pyStr(memory.body) : "").replace(/\s+$/u, "") + "\n" + lines).trim() }
      : { kind: "note", title: group.title, body: lines };
    data.quote = quote;
    data.said_at = today;
    drafts.push({ memory_id: memory ? memory.id : null, title: group.title, data, answers: group.answers });
  }
  return { drafts, dropped };
}
