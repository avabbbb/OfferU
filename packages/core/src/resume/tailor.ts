// 按岗位改简历（port of backend/app/core/tailor.py）：起草 → 审稿 → 修订，整个流程跑完才写一次库。
//
// 起草是一次流式调用，边写边推给前端；审稿是另一次独立的模型调用，输出 {old, new, reason, category} 修改清单，
// 修订按 old 精确替换。只有跑完才写库（一条可撤销的「Agent」改动）；超时、取消、起草出错、格式不对都不动简历。
// 主简历（没关联岗位）不被覆盖：结果写进这个岗位的定制简历，没有就新建一份。同一份简历同时只跑一个改写。
//
// Everything runtime-specific is injected (TailorDeps): the store, the LLM, an optional streaming draft,
// and an optional page measurer (Playwright on the companion, an offscreen iframe in the browser).

import { label, MEMORY_KIND } from "../labels";
import type { LlmClient, LlmMessage } from "../llm";
import { saveRecord } from "../operations";
import type { CoreContext, CoreStore, Json, StoredRecord } from "../types";
import { resumeFromMarkdown, type Resume } from "./model";
import { pyStr, truthy } from "./py";
import { resumeDocHtml, type FileSource } from "./render";
import { REVIEW_PROMPT, REVIEW_RETRY, TAILOR_PROMPT } from "./tailor-prompts";
import { checkResumeFacts, omittedMemories, retainedFacts, type CheckLine, type DroppedFacts } from "./verify";

export const ROUNDS = 1; // 2026-11-05 由 2 轮砍到 1 轮
export const CATEGORIES = ["grounding", "keyword", "depth", "length", "tone"] as const;
export const NOTE_KEYS = ["关键词", "岗位角度", "动作和结果", "语气"] as const;
export const MAX_ASKS = 3;
const ASK_KEYS = ["old", "why", "question"] as const;
const EVAL_SECTIONS = ["逐条匹配", "简历怎么改"];
const FENCE = "```";
export const NO_MODEL = "还没有配置模型服务，请先在设置里添加一个。";
export const DEFAULT_DEADLINE_MS = 180_000; // Python: llm_timeout (60 s) × 3

export type TailorEdit = { old: string; new: string; reason: string; category: (typeof CATEGORIES)[number]; why?: string };
export type TailorAsk = { old: string; why: string; question: string };
export type TailorRound = {
  round: number; pages: number | null; applied: TailorEdit[]; skipped: TailorEdit[];
  seconds: Record<string, number>; error?: string;
};
export type TailorChecks = { block: CheckLine[]; warn: CheckLine[]; unchecked: string; dropped: DroppedFacts[]; omitted: string[] };
export type TailorEvent =
  | { type: "start"; job: string }
  | { type: "delta"; text: string }
  | { type: "review"; round: number; pages: number | null }
  | {
    type: "done"; doc_id: number; body: string; resume: Resume; change_id: number | null; pages: number | null;
    rounds: TailorRound[]; notes: Record<string, string>; asks: TailorAsk[]; checks: TailorChecks;
    timings: Record<string, number>; grounding: TailorEdit[];
  }
  | { type: "error"; message: string };

export type DraftStream = (messages: LlmMessage[], signal?: AbortSignal) => AsyncIterable<string>;

export interface TailorDeps {
  store: CoreStore;
  /** Reviews (JSON) and, without `stream`, the draft as one piece. */
  llm?: LlmClient | null;
  /** Streaming draft; defaults to one llm.chat call yielded as a single delta. */
  stream?: DraftStream | null;
  /** Pages of an A4 render of the given HTML; null/undefined or a throw = can't measure (the review is told so). */
  measure?: ((html: string) => Promise<number | null>) | null;
  files?: FileSource | null;
  deadlineMs?: number;
  actor?: string;
  /** Aborted = client gone: stop, write nothing. */
  signal?: AbortSignal;
  context?: () => CoreContext;
}

// ---------- prompt pieces ----------

const str = (value: unknown): string => (truthy(value) ? pyStr(value) : "");
const byId = (a: StoredRecord, b: StoredRecord) => a.id - b.id;

/** 用户确认过的记忆，按 id 排；Agent 推断、还没确认的不算，老记录没 confirmed 字段算确认过。 */
async function usable(store: CoreStore): Promise<StoredRecord[]> {
  return (await store.all("memory")).sort(byId).filter((m) => m.confirmed !== false);
}

/** 口径：kind=preference 的记忆是用户定的写法规则，单列出来让模型遵守，不当事实。 */
export async function tailorRules(store: CoreStore): Promise<string> {
  const lines = (await usable(store)).filter((m) => m.kind === "preference")
    .map((m) => [str(m.title).trim(), str(m.body).trim()].filter(Boolean).join("："));
  return lines.filter(Boolean).map((line) => `- ${line}`).join("\n");
}

const PROFILE_KEYS = ["name", "school", "major", "degree", "grad_year", "phone", "email", "city", "target", "about"];

export async function tailorFacts(store: CoreStore): Promise<string> {
  const profile = (await store.first("profile")) ?? {};
  const lines = PROFILE_KEYS.filter((key) => truthy((profile as Json)[key])).map((key) => `${key}: ${pyStr((profile as Json)[key])}`);
  for (const memory of await usable(store)) {
    if (memory.kind === "preference") continue;
    const span = [memory.start, memory.end].filter(truthy).map(pyStr).join(" – ");
    const kind = MEMORY_KIND[str(memory.kind) as keyof typeof MEMORY_KIND] ?? "其他";
    const headLine = [`[${kind}]`, memory.title, memory.mode, span].filter(truthy).map(pyStr).join(" ");
    let body = str(memory.body);
    if (truthy(memory.quote)) {
      const said = truthy(memory.said_at) ? `用户 ${pyStr(memory.said_at)} 亲口说` : "用户亲口说";
      body += `\n（${said}：${pyStr(memory.quote)}）`;
    }
    lines.push(`${headLine}\n${body}`.trim());
  }
  return lines.join("\n\n") || "（空）";
}

/** 岗位下 evaluation 文档里的「逐条匹配」「简历怎么改」两段；没有就返回空串。 */
export async function evaluationNotes(store: CoreStore, jobId: number): Promise<string> {
  const report = (await store.all("doc", jobId)).find((d) => d.kind === "evaluation");
  if (!report) return "";
  const found: string[] = [];
  for (const block of str(report.body).split(/^(?=## )/m)) {
    const headLine = block.split("\n", 1)[0].slice(3).trim();
    if (block.startsWith("## ") && EVAL_SECTIONS.includes(headLine)) found.push("### " + block.slice(3).trim());
  }
  return found.join("\n\n");
}

const POSTING_META: Array<[string, string]> = [["hire_type", "招聘类型"], ["team", "部门"], ["years", "年限"], ["education", "学历"],
  ["salary", "薪资"], ["job_code", "编号"], ["posted_at", "发布日"]];
const POSTING_LISTS: Array<[string, string]> = [["responsibilities", "职责"], ["hard_reqs", "硬性要求"], ["soft_reqs", "加分项"]];

/** job.posting 拆好的要求和关键词（Python job_eval.posting_block）；没拆过返回空串。 */
export function postingBlock(job: Json): string {
  const p = truthy(job.posting) ? job.posting : {};
  if (typeof p !== "object" || p === null || Array.isArray(p)) return "";
  const posting = p as Json;
  const parts: string[] = [];
  const meta = POSTING_META.filter(([key]) => truthy(posting[key])).map(([key, name]) => `${name}：${pyStr(posting[key])}`).join("；");
  if (meta) parts.push(meta);
  const listOf = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
  for (const [key, name] of POSTING_LISTS) {
    const items = listOf(posting[key]).map(pyStr).filter((x) => x.trim());
    if (items.length) parts.push(`${name}：\n` + items.map((x, i) => `${i + 1}. ${x}`).join("\n"));
  }
  if (truthy(posting.keywords)) parts.push("关键词：" + listOf(posting.keywords).map(pyStr).join("、"));
  if (parts.length && truthy(posting.collaborators)) parts.push("协作对象（推断，非原文）：" + listOf(posting.collaborators).map(pyStr).join("、"));
  const evidence = listOf(posting.evidence).filter((e): e is Json => typeof e === "object" && e !== null && truthy((e as Json).req) && truthy((e as Json).need));
  if (parts.length && evidence.length) parts.push("证明硬性要求要准备的经历（推断）：\n" + evidence.map((e) => `- ${pyStr(e.req)} → ${pyStr(e.need)}`).join("\n"));
  if (parts.length && truthy(posting.essence)) parts.push(`岗位本质（推断，非原文）：${pyStr(posting.essence)}`);
  return parts.join("\n");
}

const cut = (text: string, n: number): string => Array.from(text).slice(0, n).join("");

function jdBlock(job: StoredRecord): string {
  const jd = str(job.jd);
  const block = postingBlock(job);
  if (!block) return `## 岗位：${label(job)}\n${cut(jd, 8000)}`;
  return `## 岗位：${label(job)}\n### 拆好的要求和关键词\n${block}\n\n### JD 原文\n${cut(jd, 4000)}`;
}

export async function tailorMessages(store: CoreStore, doc: Json, job: StoredRecord): Promise<LlmMessage[]> {
  const notes = await evaluationNotes(store, job.id);
  const ruled = await tailorRules(store);
  const user = jdBlock(job) + "\n\n"
    + (notes ? `## 岗位评估（参考，事实仍以档案为准）\n${notes}\n\n` : "")
    + (ruled ? `## 用户的口径和偏好（必须遵守）\n${ruled}\n\n` : "")
    + `## 档案和经历（唯一的事实来源）\n${await tailorFacts(store)}\n\n`
    + `## 现在的简历\n${str(doc.body) || "（空）"}`;
  return [{ role: "system", content: TAILOR_PROMPT }, { role: "user", content: user }];
}

export async function reviewMessages(store: CoreStore, doc: Json, job: StoredRecord, body: string, pages: number | null): Promise<LlmMessage[]> {
  const measured = pages ? `按导出 PDF 的版式量，预计 ${pages.toFixed(2)} 页` : "量不了（本机没有可用的 Chromium），篇幅只按内容判断";
  const ruled = await tailorRules(store);
  const user = jdBlock(job) + "\n\n"
    + (ruled ? `## 用户的口径和偏好（必须遵守）\n${ruled}\n\n` : "")
    + `## 档案和经历（事实来源）\n${await tailorFacts(store)}\n\n`
    + `## 原简历（事实来源）\n${str(doc.body) || "（空）"}\n\n`
    + `## 页数\n${measured}\n\n`
    + `## 待审简历\n${body}`;
  return [{ role: "system", content: REVIEW_PROMPT }, { role: "user", content: user }];
}

// ---------- pure steps ----------

const isResumeMarkdown = (body: string): boolean => (body.startsWith("# ") || body.startsWith("#\n")) && body.includes("\n## ");

export class TailorFailure extends Error {}

/** 去掉模型偶尔包的代码块围栏；不像简历就报错，不写库。 */
export function cleanDraft(text: string): string {
  let body = text.trim();
  const fence = new RegExp(`^${FENCE}[\\w-]*\\n([\\s\\S]*?)\\n?${FENCE}$`).exec(body);
  if (fence) body = fence[1].trim();
  if (!body) throw new TailorFailure("模型没有返回内容，检查设置里的模型配置后再试。简历没动");
  if (!isResumeMarkdown(body)) throw new TailorFailure("模型返回的不是简历格式（要以 # 名字 开头、有 ## 分节）。简历没动");
  return body + "\n";
}

export type ReviewVerdict = { edits: TailorEdit[]; notes: Record<string, string>; asks: TailorAsk[] };

/** 审稿输出 → {edits, notes, asks}；不是 JSON 对象就抛 TailorFailure。category 不认识的归到 tone。 */
export function parseReview(raw: string | null | undefined): ReviewVerdict {
  const text = (raw ?? "").trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < start) throw new TailorFailure("审稿没有返回 JSON");
  let data: unknown;
  try {
    data = JSON.parse(text.slice(start, end + 1));
  } catch (cause) {
    throw new TailorFailure((cause as Error).message);
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) throw new TailorFailure("审稿返回的不是 JSON 对象");
  const obj = data as Json;
  const listOf = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
  const isObj = (item: unknown): item is Json => typeof item === "object" && item !== null && !Array.isArray(item);
  const edits = listOf(obj.edits).filter(isObj)
    .filter((item) => typeof item.old === "string" && item.old.trim())
    .map((item): TailorEdit => ({
      old: item.old as string,
      new: str(item.new),
      reason: str(item.reason),
      category: (CATEGORIES as readonly unknown[]).includes(item.category) ? item.category as TailorEdit["category"] : "tone",
    }));
  const rawNotes = isObj(obj.notes) ? obj.notes : {};
  const notes = Object.fromEntries(NOTE_KEYS.map((key) => [key, str(rawNotes[key]) || "无"]));
  const asks = listOf(obj.asks).filter(isObj)
    .map((item) => Object.fromEntries(ASK_KEYS.map((key) => [key, str(item[key]).trim()])) as TailorAsk)
    .filter((ask) => ask.old && ask.question);
  return { edits, notes, asks };
}

const count = (body: string, needle: string): number => (needle ? body.split(needle).length - 1 : body.length + 1);

/** 只留终稿里一字不差、只出现一次的句子，去重，最多 MAX_ASKS 条。 */
export function pickAsks(asks: TailorAsk[], body: string): TailorAsk[] {
  const seen = new Set<string>();
  const out: TailorAsk[] = [];
  for (const ask of asks) {
    if (seen.has(ask.old) || count(body, ask.old) !== 1) continue;
    seen.add(ask.old);
    out.push(ask);
  }
  return out.slice(0, MAX_ASKS);
}

/** 按 old 精确替换，按顺序一条条来；old 找不到或出现不止一次就跳过并写明原因。 */
export function applyEdits(body: string, edits: TailorEdit[]): { body: string; applied: TailorEdit[]; skipped: TailorEdit[] } {
  const applied: TailorEdit[] = [];
  const skipped: TailorEdit[] = [];
  let text = body;
  for (const edit of edits) {
    const n = count(text, edit.old);
    if (n !== 1) {
      skipped.push({ ...edit, why: n === 0 ? "原文里找不到" : `原文出现 ${n} 次，不唯一` });
      continue;
    }
    const at = text.indexOf(edit.old);
    text = text.slice(0, at) + edit.new + text.slice(at + edit.old.length);
    applied.push(edit);
  }
  return { body: text.replace(/\n{3,}/g, "\n\n").trim() + "\n", applied, skipped };
}

/** 审稿一次：没返回或不是 JSON，就带上原回复再要一次；第二次还不行才失败。 */
export async function review(complete: (messages: LlmMessage[]) => Promise<string | null>, messages: LlmMessage[]): Promise<ReviewVerdict> {
  const parse = (raw: string | null): ReviewVerdict => {
    if (raw === null || !raw.trim()) throw new TailorFailure("审稿调用没有返回内容（网关报错或超时，详见后端日志）");
    return parseReview(raw);
  };
  const raw = await complete(messages);
  try {
    return parse(raw);
  } catch (first) {
    if (!(first instanceof TailorFailure)) throw first;
    const retry: LlmMessage[] = [...messages, ...(raw && raw.trim() ? [{ role: "assistant" as const, content: raw }] : []),
      { role: "user", content: REVIEW_RETRY }];
    try {
      return parse(await complete(retry));
    } catch (second) {
      if (!(second instanceof TailorFailure)) throw second;
      throw new TailorFailure(`${second.message}（已重试一次）`);
    }
  }
}

// ---------- the run ----------

class Timeout extends Error {}

function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Timeout()), ms); });
  return Promise.race([promise, expired]).finally(() => clearTimeout(timer));
}

const running = new WeakMap<CoreStore, Set<number>>();
const busy = (store: CoreStore): Set<number> => {
  let set = running.get(store);
  if (!set) running.set(store, (set = new Set()));
  return set;
};

const seconds = (ms: number): string => String(Math.round(ms / 10) / 100).replace(/\.0+$/, "");
const since = (mark: number): number => Math.round((Date.now() - mark) / 10) / 100;

/** 写到哪份简历：本身就是岗位简历就原地改；主简历就写进这个岗位已有的定制简历，没有就新建，主简历不动。 */
async function target(store: CoreStore, doc: StoredRecord, job: StoredRecord): Promise<[number | undefined, Json]> {
  if (doc.job_id) return [doc.id, {}];
  const existing = (await store.all("doc", job.id)).sort((a, b) => b.id - a.id).find((d) => d.kind === "resume");
  if (existing) return [existing.id, {}];
  const fresh: Json = { kind: "resume", job_id: job.id, title: `${str(doc.title) || "简历"} · ${label(job)}` };
  if (truthy(doc.style)) fresh.style = doc.style;
  return [undefined, fresh];
}

async function measureBody(deps: TailorDeps, body: string, doc: Json): Promise<number | null> {
  if (!deps.measure) return null;
  try {
    const record: Json = { body, resume: resumeFromMarkdown(body), style: doc.style, template: doc.template, title: doc.title };
    const pages = await deps.measure(await resumeDocHtml(deps.store, record, deps.files));
    return typeof pages === "number" && Number.isFinite(pages) ? pages : null;
  } catch {
    return null; // 量不了不影响改写，审稿 prompt 里会写明
  }
}

function defaultContext(actor: string): CoreContext {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  return { actor, now: now.toISOString(), today };
}

/**
 * 事件：start → delta…（起草）→ review…（每轮审稿开始）→ done（已保存）；任何一步失败是 error，之后不再有事件。
 * 审稿某一轮出错或超时只停在那一轮，写进 done 的 rounds，初稿和已修订的部分照常保存。
 * reviewOnly：不重新起草，拿这个岗位已有的定制简历直接审稿，没有 delta 事件。
 */
export async function* runTailor(deps: TailorDeps, docId: number, jobId?: number | null, options: { reviewOnly?: boolean } = {}): AsyncGenerator<TailorEvent> {
  const { store } = deps;
  const reviewOnly = Boolean(options.reviewOnly);
  const actor = deps.actor ?? "Agent";
  const doc = await store.get("doc", Number(docId));
  if (!doc || doc.kind !== "resume") {
    yield { type: "error", message: `简历 #${docId} 不存在` };
    return;
  }
  const wanted = Number(jobId || doc.job_id || 0);
  const job = wanted ? await store.get("job", wanted) : null;
  if (!job) {
    yield { type: "error", message: "先给这份简历选一个岗位" };
    return;
  }
  if (!str(job.jd).trim()) {
    yield { type: "error", message: `「${label(job)}」还没有 JD，先在岗位页贴上` };
    return;
  }
  const locks = busy(store);
  if (locks.has(doc.id)) {
    yield { type: "error", message: "这份简历正在改写，等它写完或取消" };
    return;
  }
  let base: StoredRecord | null = null;
  let stream: DraftStream | null = deps.stream ?? null;
  if (reviewOnly) {
    const [baseId] = await target(store, doc, job);
    base = baseId !== undefined ? await store.get("doc", baseId) : null;
    if (!base || !str(base.body).trim()) {
      yield { type: "error", message: "这个岗位还没有定制简历，先完整改写一次" };
      return;
    }
    const replay = base.body as string;
    stream = async function* () { yield replay; };
  }
  const llm = deps.llm ?? null;
  if (!stream) {
    if (!llm) {
      yield { type: "error", message: NO_MODEL };
      return;
    }
    stream = async function* (messages, signal) {
      const text = await llm.chat(messages, { temperature: 0.3, maxTokens: 4096, signal });
      if (text) yield text;
    };
  }
  const complete = (messages: LlmMessage[]): Promise<string | null> => {
    if (!llm) return Promise.resolve(null);
    return llm.chat(messages, { temperature: 0.2, json: true, maxTokens: 4096, signal: deps.signal });
  };
  const deadline = deps.deadlineMs ?? DEFAULT_DEADLINE_MS;
  const aborted = () => Boolean(deps.signal?.aborted);

  locks.add(doc.id);
  try {
    yield { type: "start", job: label(job) };
    const started = Date.now();
    const timings: Record<string, number> = {};
    // 核对来源里的原简历；只审稿且审的就是这份时不算
    const origin = reviewOnly && base && base.id === doc.id ? "" : str(doc.body);
    const parts: string[] = [];
    const iterator = stream(await tailorMessages(store, doc, job), deps.signal)[Symbol.asyncIterator]();
    const stop = started + deadline;
    try {
      for (;;) {
        const left = stop - Date.now();
        if (left <= 0) throw new Timeout();
        const next = await withDeadline(iterator.next(), left);
        if (next.done) break;
        parts.push(next.value);
        if (!reviewOnly) yield { type: "delta", text: next.value };
        if (aborted()) return;
      }
    } catch (cause) {
      void iterator.return?.();
      if (cause instanceof Timeout) {
        yield { type: "error", message: `超过 ${seconds(deadline)} 秒没写完，已停下。简历没动` };
        return;
      }
      if (aborted()) return;
      yield { type: "error", message: cause instanceof Error ? cause.message : String(cause) };
      return;
    }
    timings.draft = since(started);
    let body: string;
    try {
      body = cleanDraft(parts.join(""));
    } catch (cause) {
      yield { type: "error", message: (cause as Error).message };
      return;
    }

    const rounds: TailorRound[] = [];
    let notes: Record<string, string> = Object.fromEntries(NOTE_KEYS.map((key) => [key, "无"]));
    let asks: TailorAsk[] = [];
    for (let number = 1; number <= ROUNDS; number += 1) {
      let mark = Date.now();
      const pages = await measureBody(deps, body, doc);
      const spent: Record<string, number> = { measure: since(mark) };
      yield { type: "review", round: number, pages };
      if (aborted()) return;
      const entry: TailorRound = { round: number, pages, applied: [], skipped: [], seconds: spent };
      rounds.push(entry);
      mark = Date.now();
      let calls = 0;
      let verdict: ReviewVerdict;
      try {
        verdict = await withDeadline(review((msgs) => { calls += 1; return complete(msgs); },
          await reviewMessages(store, doc, job, body, pages)), deadline);
      } catch (cause) {
        if (cause instanceof Timeout) entry.error = `超过 ${seconds(deadline)} 秒没审完`;
        else if (cause instanceof TailorFailure) entry.error = cause.message;
        else throw cause;
        break;
      } finally {
        Object.assign(spent, { review: since(mark), calls });
      }
      if (aborted()) return;
      notes = verdict.notes;
      if (number === 1) asks = verdict.asks;
      const revised = applyEdits(body, verdict.edits);
      let { applied, skipped } = revised;
      if (applied.length && !isResumeMarkdown(revised.body)) {
        skipped = [...applied.map((edit) => ({ ...edit, why: "改完不像简历了，这一轮整轮作废" })), ...skipped];
        applied = [];
      }
      entry.applied = applied;
      entry.skipped = skipped;
      if (!applied.length) break;
      body = revised.body;
    }

    asks = pickAsks(asks, body);
    let mark = Date.now();
    const sources = ((await tailorFacts(store)) + "\n\n" + origin).trim();
    const memories = await store.all("memory");
    const checks: TailorChecks = { ...checkResumeFacts(body, sources), dropped: retainedFacts(body, memories), omitted: omittedMemories(body, memories) };
    timings.verify = since(mark);
    if (aborted()) return; // 客户端断开 = 取消，不写库
    mark = Date.now();
    const [targetId, extra] = await target(store, doc, job);
    const ctx = deps.context ? deps.context() : defaultContext(actor);
    const result = await saveRecord(store, {
      type: "doc", id: targetId ?? null, data: { ...extra, body, pending_asks: reviewOnly ? null : asks },
    }, { ...ctx, actor });
    const record = result.record;
    timings.save = since(mark);
    mark = Date.now();
    const pages = await measureBody(deps, str(record.body), record);
    timings.final_measure = since(mark);
    timings.total = since(started);
    yield {
      type: "done", doc_id: record.id, body: str(record.body), resume: record.resume as Resume, change_id: result.change_id, pages,
      rounds, notes, asks, checks, timings,
      grounding: rounds.flatMap((entry) => entry.applied.filter((edit) => edit.category === "grounding")),
    };
  } finally {
    locks.delete(doc.id);
  }
}
