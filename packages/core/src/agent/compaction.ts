// Context compaction for one Agent Run (idea from Flovart
// services/agentCompaction.ts: window, reserve, keep-recent, one aggressive
// retry on overflow), done deterministically without a model call.
//
// What it keeps: the user's goal, every message's role / tool_call pairing
// (providers reject orphaned tool results), the recent turns verbatim, and in
// older tool results the references the Agent works from — record ids, job
// ids, doc ids, change ids, confirmed career evidence (memory title / body /
// quote), errors, unfinished markers (remaining, asks, input requests).
// What it drops: raw page bodies, search snippets, long JD / resume text in
// old results — all can be read again with get / fetch_page.

import type { ChatMessage } from "../llm";

export interface CompactionPolicy {
  /** Model context window, tokens. */
  windowTokens: number;
  /** Kept free for the reply and tool calls. */
  reserveTokens: number;
  /** The newest messages up to this many tokens stay verbatim. */
  keepRecentTokens: number;
}

export const DEFAULT_COMPACTION: CompactionPolicy = { windowTokens: 64_000, reserveTokens: 8_000, keepRecentTokens: 16_000 };

/** Rough token count: ~4 ASCII chars per token, ~0.7 token per CJK / other char. */
export function estimateTokens(text: string): number {
  let ascii = 0;
  let other = 0;
  for (const char of text) {
    if (char.charCodeAt(0) < 128) ascii += 1;
    else other += 1;
  }
  return Math.ceil(ascii / 4 + other * 0.7);
}

function messageText(message: ChatMessage): string {
  const content = typeof message.content === "string"
    ? message.content
    : Array.isArray(message.content)
      ? message.content.map((part) => (part.type === "text" ? part.text : "[图片]")).join("")
      : "";
  return content + (message.tool_calls ? JSON.stringify(message.tool_calls) : "");
}

export function estimateMessages(messages: readonly ChatMessage[]): number {
  return messages.reduce((sum, message) => sum + estimateTokens(messageText(message)) + 4, 0);
}

/** Keys whose values are references or evidence: always kept (strings shortened). */
const KEEP_KEYS = new Set([
  "ok", "error", "code", "message", "retryable", "suggestedAction", "errors",
  "id", "type", "kind", "job_id", "doc_id", "resume_id", "change_id", "change_ids", "ids", "record_id",
  "company", "title", "status", "stage", "url", "source", "source_url", "confirmed", "mode",
  "quote", "said_at", "start", "end", "score", "reasons",
  "remaining", "asks", "input_request", "requires_input", "terminate", "created", "deleted", "path", "at", "done",
]);
/** Raw bodies: dropped from old results (they can be fetched again). */
const RAW_KEYS = new Set(["text", "html", "content", "markdown", "snippet", "snippets", "results", "jd", "posting", "body", "resume", "raw", "items"]);

const short = (value: string, limit: number) => (value.length > limit ? `${value.slice(0, limit)}…[省略 ${value.length - limit} 字]` : value);

/** Memory records that are the user's confirmed evidence keep their body. */
function isConfirmedEvidence(node: Record<string, unknown>): boolean {
  return node.confirmed === true && (node.type === "memory" || typeof node.kind === "string") && typeof node.body === "string";
}

function digest(value: unknown, limit: number, depth = 0): unknown {
  if (typeof value === "string") return short(value, limit);
  if (Array.isArray(value)) {
    const items = value.slice(0, 20).map((item) => digest(item, limit, depth + 1));
    return value.length > 20 ? [...items, `…另有 ${value.length - 20} 项`] : items;
  }
  if (!value || typeof value !== "object") return value;
  const node = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  const evidence = isConfirmedEvidence(node);
  for (const [key, item] of Object.entries(node)) {
    if (evidence && key === "body") out[key] = short(String(item), Math.max(limit, 600));
    else if (KEEP_KEYS.has(key)) out[key] = digest(item, limit, depth + 1);
    else if (RAW_KEYS.has(key)) {
      if (Array.isArray(item) && depth < 3) out[key] = digest(item, limit, depth + 1);
      else if (typeof item === "string" && item.length > limit) out[key] = `[已压缩：原文 ${item.length} 字，需要时重新 get / fetch_page]`;
      else out[key] = digest(item, limit, depth + 1);
    } else if (item && typeof item === "object") out[key] = digest(item, limit, depth + 1);
    else if (typeof item !== "string") out[key] = item;
    else if (item.length <= limit) out[key] = item;
  }
  return out;
}

/** Shrink one old tool result; keeps it valid JSON when it was JSON. */
export function compactToolResult(text: string, limit = 160): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return short(text, limit * 2);
  try {
    return JSON.stringify(digest(JSON.parse(trimmed), limit));
  } catch {
    return short(text, limit * 2);
  }
}

/** References the Agent should not lose, collected from the whole session. */
export function referenceLedger(messages: readonly ChatMessage[]): string {
  const refs = { job: new Set<number>(), doc: new Set<number>(), memory: new Set<number>(), confirmed: new Set<number>(), change: new Set<number>() };
  const pending: string[] = [];
  const visit = (value: unknown, parentType?: string) => {
    if (Array.isArray(value)) return value.forEach((item) => visit(item, parentType));
    if (!value || typeof value !== "object") return;
    const node = value as Record<string, unknown>;
    const type = typeof node.type === "string" ? node.type : parentType;
    if (typeof node.id === "number" && (type === "job" || type === "doc" || type === "memory")) refs[type].add(node.id);
    if (typeof node.id === "number" && type === "memory" && node.confirmed === true) refs.confirmed.add(node.id);
    if (typeof node.job_id === "number") refs.job.add(node.job_id);
    if (typeof node.doc_id === "number") refs.doc.add(node.doc_id);
    if (typeof node.change_id === "number") refs.change.add(node.change_id);
    if (Array.isArray(node.change_ids)) node.change_ids.forEach((id) => typeof id === "number" && refs.change.add(id));
    if (typeof node.remaining === "number" && node.remaining > 0) pending.push(`还有 ${node.remaining} 个岗位没评估（再调 evaluate_jobs）`);
    if (Array.isArray(node.asks) && node.asks.length) pending.push(`有 ${node.asks.length} 句 asks 待问用户`);
    for (const [key, item] of Object.entries(node)) {
      if (key === "jobs" || key === "job") visit(item, "job");
      else if (key === "docs" || key === "doc") visit(item, "doc");
      else if (key === "memories" || key === "memory") visit(item, "memory");
      else visit(item, type);
    }
  };
  for (const message of messages) {
    if (message.role !== "tool" || typeof message.content !== "string") continue;
    try {
      visit(JSON.parse(message.content));
    } catch { /* not JSON */ }
  }
  const list = (label: string, ids: Set<number>) => (ids.size ? `${label} ${[...ids].sort((a, b) => a - b).slice(0, 40).map((id) => `#${id}`).join(" ")}` : "");
  const lines = [list("岗位", refs.job), list("文档", refs.doc), list("记忆", refs.memory), list("已确认的证据（记忆）", refs.confirmed), list("本轮改动", refs.change)].filter(Boolean);
  return [
    "较早的工具结果已压缩（网页正文、长 JD / 简历原文已去掉，需要时重新 get / fetch_page；不要据此认为已做的事没做）。",
    lines.length ? `保留的引用：${lines.join("；")}` : "",
    pending.length ? `未完成：${[...new Set(pending)].join("；")}` : "",
  ].filter(Boolean).join("\n");
}

export interface CompactionResult {
  messages: ChatMessage[];
  compacted: boolean;
  before: number;
  after: number;
  /** Tool results shrunk. */
  shrunk: number;
  ledger: string;
}

/**
 * Compact when `fixedTokens` (system prompt + tool specs) + session exceeds
 * window − reserve. `aggressive` (after a provider overflow error) keeps half
 * as much recent context and shortens harder.
 */
export function compactSession(messages: readonly ChatMessage[], fixedTokens: number, policy: CompactionPolicy = DEFAULT_COMPACTION, aggressive = false): CompactionResult {
  const before = fixedTokens + estimateMessages(messages);
  const budget = policy.windowTokens - policy.reserveTokens;
  if (!aggressive && before <= budget) return { messages: [...messages], compacted: false, before, after: before, shrunk: 0, ledger: "" };

  const keepRecent = aggressive ? Math.floor(policy.keepRecentTokens / 2) : policy.keepRecentTokens;
  // Messages from `boundary` on stay verbatim (walk back from the end).
  let boundary = messages.length;
  let recent = 0;
  while (boundary > 1) {
    const cost = estimateMessages([messages[boundary - 1]]);
    if (recent + cost > keepRecent) break;
    recent += cost;
    boundary -= 1;
  }
  // Never split an assistant tool_calls message from its tool results.
  while (boundary < messages.length && messages[boundary].role === "tool") boundary += 1;

  let shrunk = 0;
  const pass = (limit: number, from: readonly ChatMessage[]) => from.map((message, index) => {
    if (index === 0 || index >= boundary) return message;
    if (message.role === "tool" && typeof message.content === "string") {
      const next = compactToolResult(message.content, limit);
      if (next.length < message.content.length) shrunk += 1;
      return { ...message, content: next };
    }
    if (message.role === "assistant" && typeof message.content === "string" && message.content.length > limit * 4) {
      return { ...message, content: short(message.content, limit * 4) };
    }
    if (message.role === "user" && Array.isArray(message.content)) {
      // Old images: keep the words, drop the pixels.
      return { ...message, content: message.content.map((part) => (part.type === "image_url" ? { type: "text" as const, text: "[较早的图片已省略]" } : part)) };
    }
    return message;
  });
  let next = pass(aggressive ? 80 : 160, messages);
  if (fixedTokens + estimateMessages(next) > budget) {
    shrunk = 0;
    next = pass(60, next);
  }
  return { messages: next, compacted: true, before, after: fixedTokens + estimateMessages(next), shrunk, ledger: referenceLedger(messages) };
}

/** Provider said the request is too long for the model. */
export function isContextOverflow(error: string | undefined): boolean {
  return Boolean(error) && /context[_ ]length|maximum context|context window|too many tokens|prompt is too long|token limit|reduce the length|超出.{0,6}(长度|上下文)|上下文.{0,4}(过长|超)/i.test(String(error));
}
