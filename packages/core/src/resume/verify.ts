// 改写结果核对（port of backend/app/core/verify.py）：终稿每一行对照事实来源，分 block / warn 两档，只提示不改稿。
// 只靠代码，不调模型。

import { CN_NUMBER_RE, VAGUE_SAID } from "./impact";
import { digitsToAscii, intStr, splitlines } from "./py";

export const WEAK_VERBS = ["参与", "协助", "配合", "支持", "跟进", "辅助"];
export const STRONG_VERBS = ["主导", "牵头", "负责", "带领", "独立完成", "主持", "统筹"];
export const CLAIMS = ["全网", "行业领先", "业内领先", "国内领先", "全国首个", "首个", "首创", "唯一", "爆款", "刷屏", "顶尖", "头部"];
export const HEDGES = ["约", "大概", "大约", "左右", "将近", "差不多", "余", "上下"];
const UNIT: Record<string, number> = { 万: 10_000, 千: 1_000, 百: 100, 亿: 100_000_000 };
const NUM_RE = /(\p{Nd}+(?:\.\p{Nd}+)?)\s*([万千百亿]?)/gu;
const LIST_MARK = /^\s*(?:[-+*]|\p{Nd}+[、)]|\p{Nd}+\.(?!\p{Nd}))\s*/u; // 「2023.06」开头的行是日期，不是序号

export type CheckLine = { line: string; kind: string; detail: string };
export type CheckResult = { block: CheckLine[]; warn: CheckLine[]; unchecked: string };
export type DroppedFacts = { memory_id: unknown; title: string; missing: string[] };

export const plainNumbers = (text: string): string => text.replace(/(?<=\p{Nd}),(?=\p{Nd}{3}(?!\p{Nd}))/gu, "");

function scaled(value: string, unit: string): string {
  const out = Number(digitsToAscii(value)) * UNIT[unit];
  return Number.isInteger(out) ? BigInt(Math.round(out)).toString() : String(out);
}

const stripZeros = (value: string): string => value.replace(/0+$/, "").replace(/\.$/, "");

/** 来源里一个数字算哪些写法：每一段（2023.06 → 2023、6）、乘上单位后的值（2万 → 20000）、去尾零的整串。 */
function forms(value: string, unit: string): Set<string> {
  const out = new Set(value.split(".").filter(Boolean).map(intStr));
  if (unit) out.add(scaled(value, unit));
  if (value.includes(".")) out.add(stripZeros(value));
  return out;
}

function traced(value: string, unit: string, known: Set<string>): boolean {
  if (unit) return known.has(scaled(value, unit));
  if (value.includes(".") && known.has(stripZeros(value))) return true;
  return value.split(".").filter(Boolean).every((part) => known.has(intStr(part)));
}

export function knownNumbers(text: string): Set<string> {
  const plain = plainNumbers(text);
  const out = new Set<string>(plain.match(CN_NUMBER_RE) ?? []);
  for (const m of plain.matchAll(NUM_RE)) for (const form of forms(m[1], m[2])) out.add(form);
  return out;
}

function missingIn(line: string, known: Set<string>): string[] {
  const plain = plainNumbers(line.replace(LIST_MARK, ""));
  const out = [...plain.matchAll(NUM_RE)].filter((m) => !traced(m[1], m[2], known)).map((m) => m[0].trim());
  out.push(...(plain.match(CN_NUMBER_RE) ?? []).filter((word) => !known.has(word)));
  return [...new Set(out)];
}

/** 来源里说成约数的数字：和「大概」「左右」这类词在同一个分句里。 */
function hedgedNumbers(sources: string): Set<string> {
  const out = new Set<string>();
  for (const clause of plainNumbers(sources).split(/[，,。；;！!？?\n]/u)) {
    if (VAGUE_SAID.some((word) => clause.includes(word))) {
      for (const n of clause.match(CN_NUMBER_RE) ?? []) out.add(n);
      for (const n of clause.match(/\p{Nd}+(?:\.\p{Nd}+)?/gu) ?? []) out.add(n);
    }
  }
  return out;
}

const escapeRe = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** 返回 {block, warn, unchecked}；每条 {line, kind, detail}。 */
export function checkResumeFacts(body: string, sources: string): CheckResult {
  if (!sources.trim()) return { block: [], warn: [], unchecked: "档案和原简历都是空的，没法核对，这份没检查" };
  const known = knownNumbers(sources);
  const hedged = hedgedNumbers(sources);
  const block: CheckLine[] = [];
  const warn: CheckLine[] = [];
  for (const raw of splitlines(body)) {
    const line = raw.trim();
    if (!line) continue;
    const missing = missingIn(line, known);
    if (missing.length) block.push({ line, kind: "number", detail: "档案和原简历里找不到：" + missing.join("、") });
    const louder = STRONG_VERBS.filter((v) => line.includes(v) && !sources.includes(v));
    if (louder.length && WEAK_VERBS.some((v) => sources.includes(v))) {
      warn.push({ line, kind: "verb", detail: "来源里没有这个说法：" + louder.join("、") + "（来源写的是参与/协助一类）" });
    }
    const dropped = [...hedged].filter((n) => new RegExp(`(?<![\\p{Nd}.])${escapeRe(n)}(?![\\p{Nd}.])`, "u").test(line)
      && !HEDGES.some((h) => line.includes(h)));
    if (dropped.length) warn.push({ line, kind: "hedge", detail: "来源里是约数，这里没带约数词：" + dropped.join("、") });
    const claims = CLAIMS.filter((c) => line.includes(c) && !sources.includes(c));
    if (claims.length) warn.push({ line, kind: "claim", detail: "来源里没有这个说法：" + claims.join("、") });
  }
  return { block, warn, unchecked: "" };
}

type MemoryLike = Record<string, unknown>;
const str = (value: unknown): string => (value === null || value === undefined || value === false || value === "" ? "" : String(value));

function kept(memories: MemoryLike[]): MemoryLike[] {
  return memories.filter((m) => m.confirmed !== false && m.kind !== "preference" && str(m.title).trim());
}

function named(title: string, body: string): boolean {
  const head = title.split(/[\s·|｜/,，（(]+/u)[0];
  return body.includes(title) || (Array.from(head).length >= 2 && body.includes(head));
}

/** 终稿留下的经历有没有悄悄丢事实：[{memory_id, title, missing}]。只提示，不拦保存。 */
export function retainedFacts(body: string, memories: MemoryLike[]): DroppedFacts[] {
  const known = knownNumbers(body);
  const out: DroppedFacts[] = [];
  for (const memory of kept(memories)) {
    const title = str(memory.title).trim();
    if (!named(title, body)) continue;
    const source = [str(memory.body), str(memory.quote)].filter(Boolean).join("\n");
    const missing = splitlines(source).flatMap((line) => missingIn(line, known));
    missing.push(...STRONG_VERBS.filter((v) => source.includes(v) && !body.includes(v)));
    if (missing.length) out.push({ memory_id: memory.id ?? null, title, missing: [...new Set(missing)] });
  }
  return out;
}

/** 终稿里整条没出现的确认经历，只给标题。 */
export function omittedMemories(body: string, memories: MemoryLike[]): string[] {
  return kept(memories).map((m) => str(m.title).trim()).filter((title) => !named(title, body));
}

