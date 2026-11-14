// 做梦：离线核对职业记忆，找出前后说法对不上的地方（port of backend/app/core/reconcile.py）。
// 只出待核对的建议，不写库、不调模型。proposed 是一次 save 的参数，只由用户在档案页点「采纳」时走 save。

import type { CoreStore, Json, StoredRecord } from "../types";
import { sequenceRatio } from "./difflib";
import { pyStr } from "./job-eval";

const STALE_DAYS = 14;
const DUP_RATIO = 0.85;
const GAP_RE = /待补充?|\[gap\]|记不清/i;
const DONE_RE = /入选|已上线|上线了|已完成|完成了|已获|荣获|获得|已发表|发表了|已录用|已通过/;
const PLAN_RE = /计划|准备|打算|将要|筹备|待上线|申请中|正在申请/;
const NUM_RE = /(?<![\d.])(\d+(?:\.\d+)?)\s*(\+|万|[wWkK](?![A-Za-z])|%|％)?/g;
const UNIT: Record<string, number> = { 万: 10000, w: 10000, W: 10000, k: 1000, K: 1000 };
const AFTER_RE = /^\s*(?:个|名|位|次|人|家|条|篇|项|倍|余|多)?\s*([\u4e00-\u9fff]{2}|[A-Za-z]{2,})/;
const BEFORE_RE = /([\u4e00-\u9fff]{2}|[A-Za-z]{2,})\s*(?:约|超过|达到|达|近|共|了)?\s*$/;
const SPLIT_RE = /[\s|｜/·,，、()（）\-—:：]+/g;

type Side = { source: string; text: string; memory: StoredRecord | null; field: string | null; user_words: boolean };
type Mention = { keys: Set<string>; value: number; raw: string; snippet: string };
type Evidence = { source: string; text: string; field?: string };
export type Finding = {
  kind: "conflict" | "status_drift" | "duplicate" | "stale_gap";
  key: string;
  memory_ids: number[];
  evidence: Evidence[];
  suggestion: string;
  proposed: { type: "memory"; id: number; data: Json } | null;
};

const s = (value: unknown) => (value === null || value === undefined || value === "" ? "" : pyStr(value));
const snip = (text: string, start: number, end: number) => text.slice(Math.max(0, start - 15), end + 15).replace(/\s+/g, " ").trim();
const norm = (title: unknown) => s(title).replace(SPLIT_RE, "").toLowerCase();
const tokens = (memory: StoredRecord) => new Set(s(memory.title).split(SPLIT_RE).filter((t) => [...t].length >= 2).map((t) => t.toLowerCase()));
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function mentions(text: string): Mention[] {
  const out: Mention[] = [];
  for (const match of text.matchAll(NUM_RE)) {
    const raw = match[1];
    const unit = match[2] ?? "";
    const end = match.index! + match[0].length;
    const rest = text.slice(end);
    const whole = Math.trunc(Number.parseFloat(raw));
    if ((!unit && whole >= 1900 && whole <= 2100) || /^\s*[年月日号]/.test(rest)) continue;
    const keys = new Set<string>();
    const after = AFTER_RE.exec(rest);
    if (after) keys.add(after[1].toLowerCase());
    const before = BEFORE_RE.exec(text.slice(0, match.index));
    if (before) keys.add(before[1].toLowerCase());
    if (!keys.size) continue;
    const pct = unit === "%" || unit === "％" ? "%" : "";
    out.push({
      keys: new Set([...keys].map((k) => pct + k)),
      value: Number.parseFloat(raw) * (UNIT[unit] ?? 1),
      raw: match[0].trim(),
      snippet: snip(text, match.index!, end),
    });
  }
  return out;
}

const side = (source: string, text: string, extra: Partial<Side> = {}): Side => ({ source, text, memory: null, field: null, user_words: false, ...extra });
const body = (memory: StoredRecord) => side(`memory#${memory.id}`, `${s(memory.title)}\n${s(memory.body)}`, { memory, field: "body" });
const ev = (from: Side, text: string): Evidence => (from.field ? { source: from.source, text, field: from.field } : { source: from.source, text });

function finding(kind: Finding["kind"], ids: number[], evidence: Evidence[], suggestion: string, proposed: Finding["proposed"] = null): Finding {
  const unique = [...new Set(ids)].sort((a, b) => a - b);
  const key = `${kind}:${unique.join("-")}:` + evidence.map((e) => e.source + (e.field ?? "")).join("|");
  return { kind, key, memory_ids: unique, evidence, suggestion, proposed };
}

function numberPatch(a: Side, x: Mention, b: Side, y: Mention): Finding["proposed"] {
  for (const [mine, mention, other, theirs] of [[a, x, b, y], [b, y, a, x]] as const) {
    const memory = mine.memory;
    if (mine.field !== "body" || !memory) continue;
    if (other.user_words || (memory.source === "agent" && other.memory?.source !== "agent")) {
      const text = s(memory.body);
      const pattern = new RegExp(`(?<![\\d.])${escape(mention.raw)}`, "g");
      const hits = text.match(pattern) ?? [];
      if (hits.length === 1) {
        return { type: "memory", id: memory.id, data: { body: text.replace(new RegExp(`(?<![\\d.])${escape(mention.raw)}`), () => theirs.raw) } };
      }
    }
  }
  return null;
}

function drift(a: Side, b: Side): [RegExpExecArray, RegExpExecArray] | null {
  const done = DONE_RE.exec(a.text);
  const plan = PLAN_RE.exec(b.text);
  if (done && plan && !PLAN_RE.test(a.text) && !DONE_RE.test(b.text)) return [done, plan];
  return null;
}

const idsOf = (...sides: Side[]) => sides.filter((x) => x.memory).map((x) => x.memory!.id);
const intersects = (a: Set<string>, b: Set<string>) => [...a].some((k) => b.has(k));

function compare(a: Side, b: Side): Finding[] {
  const out: Finding[] = [];
  let hit: [Mention, Mention] | null = null;
  const right = mentions(b.text);
  outer: for (const x of mentions(a.text)) {
    for (const y of right) {
      if (intersects(x.keys, y.keys) && x.value !== y.value) {
        hit = [x, y];
        break outer;
      }
    }
  }
  if (hit) {
    const [x, y] = hit;
    out.push(finding("conflict", idsOf(a, b), [ev(a, x.snippet), ev(b, y.snippet)],
      `同一个数写法不一样：${x.raw} 和 ${y.raw}，以哪个为准？`, numberPatch(a, x, b, y)));
  }
  for (const [first, second] of [[a, b], [b, a]] as const) {
    const found = drift(first, second);
    if (found) {
      const [done, plan] = found;
      out.push(finding("status_drift", idsOf(a, b), [
        ev(first, snip(first.text, done.index, done.index + done[0].length)),
        ev(second, snip(second.text, plan.index, plan.index + plan[0].length)),
      ], `一处写「${done[0]}」，一处写「${plan[0]}」，现在到哪一步了？`));
      break;
    }
  }
  return out;
}

function dates(a: StoredRecord, b: StoredRecord): Finding[] {
  const title = norm(a.title);
  if (!title || a.kind !== b.kind || title !== norm(b.title)) return [];
  if (!["start", "end"].some((k) => s(a[k]) && s(b[k]) && a[k] !== b[k])) return [];
  const evidence = [a, b].map((m) => ({ source: `memory#${m.id}`, field: "date", text: `${pyStr(m.title ?? null)}：${s(m.start) || "?"}–${s(m.end) || "?"}` }));
  return [finding("conflict", [a.id, b.id], evidence, "同一段经历写了两个不同的时间，以哪个为准？")];
}

function duplicate(a: StoredRecord, b: StoredRecord): Finding[] {
  if ((a.kind ?? null) !== (b.kind ?? null)) return [];
  const ta = norm(a.title);
  const tb = norm(b.title);
  const ba = s(a.body).trim();
  const bb = s(b.body).trim();
  const same = Boolean(ta && ta === tb) || (Math.min([...ba].length, [...bb].length) >= 20 && sequenceRatio(ba, bb) >= DUP_RATIO);
  if (!same) return [];
  const evidence = [a, b].map((m) => ({ source: `memory#${m.id}`, text: snip(`${s(m.title)} ${s(m.body)}`, 0, 45) }));
  return [finding("duplicate", [a.id, b.id], evidence, "像是同一件事记了两次：把内容合并到一条，删掉另一条")];
}

function profileCheck(memory: StoredRecord, profile: Json): Finding[] {
  const school = s(profile.school);
  const grad = s(profile.grad_year).slice(0, 4);
  const end = s(memory.end).slice(0, 4);
  if (memory.kind !== "education" || !(school && grad && /^\d+$/.test(end)) || !s(memory.title).includes(school) || end === grad) return [];
  const evidence = [
    { source: `memory#${memory.id}`, field: "date", text: `${pyStr(memory.title ?? null)}：${pyStr(memory.end ?? null)} 毕业` },
    { source: "profile", text: `毕业年份 ${pyStr(profile.grad_year ?? null)}` },
  ];
  return [finding("conflict", [memory.id], evidence, "毕业时间和档案里的毕业年份对不上，以哪个为准？")];
}

function daysBetween(fromIso: string, toIso: string): number {
  return Math.round((Date.UTC(+toIso.slice(0, 4), +toIso.slice(5, 7) - 1, +toIso.slice(8, 10))
    - Date.UTC(+fromIso.slice(0, 4), +fromIso.slice(5, 7) - 1, +fromIso.slice(8, 10))) / 86_400_000);
}

function validDate(text: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!match) return false;
  const date = new Date(Date.UTC(+match[1], +match[2] - 1, +match[3]));
  return date.getUTCMonth() === +match[2] - 1 && date.getUTCDate() === +match[3];
}

function stale(memory: StoredRecord, today: string, days: number): Finding[] {
  const text = `${s(memory.title)}\n${s(memory.body)}`;
  const gap = GAP_RE.exec(text);
  if (!gap) return [];
  const since = (s(memory.said_at) || s(memory.created_at)).slice(0, 10);
  if (!validDate(since)) return [];
  const age = daysBetween(since, today);
  if (age < days) return [];
  return [finding("stale_gap", [memory.id], [{ source: `memory#${memory.id}`, text: snip(text, gap.index, gap.index + gap[0].length) }],
    `「${gap[0]}」放了 ${age} 天还没补：补上具体内容，或删掉这句`)];
}

/** 只读：冲突（数字、时间）、进度对不上、重复、待补太久。 */
export async function reconcileScan(store: CoreStore, today: string, staleDays = STALE_DAYS): Promise<Finding[]> {
  const memories = [...await store.all("memory")].sort((a, b) => a.id - b.id);
  const profile = (await store.first("profile")) ?? {};
  const master = (await store.all("doc")).find((d) => d.kind === "resume" && !d.job_id);
  const others: Side[] = master
    ? s(master.body).split(/\n(?=#)/).filter((block) => block.trim()).map((block) => side(`doc#${master.id}`, block, { user_words: true }))
    : [];
  if ((profile as Json).about) others.push(side("profile", s((profile as Json).about), { user_words: true }));

  const findings: Finding[] = [];
  for (const memory of memories) {
    if (memory.quote) {
      findings.push(...compare(body(memory), side(`memory#${memory.id}`, s(memory.quote), { memory, field: "quote", user_words: true })));
    }
    const own = tokens(memory);
    for (const other of others) {
      if (own.size && [...own].some((t) => other.text.toLowerCase().includes(t))) findings.push(...compare(body(memory), other));
    }
    findings.push(...profileCheck(memory, profile as Json), ...stale(memory, today, staleDays));
  }
  for (let i = 0; i < memories.length; i += 1) {
    for (let j = i + 1; j < memories.length; j += 1) {
      const [a, b] = [memories[i], memories[j]];
      if (intersects(tokens(a), tokens(b))) findings.push(...compare(body(a), body(b)));
      findings.push(...dates(a, b), ...duplicate(a, b));
    }
  }
  const unique = new Map<string, Finding>();
  for (const item of findings) if (!unique.has(item.key)) unique.set(item.key, item);
  return [...unique.values()];
}
