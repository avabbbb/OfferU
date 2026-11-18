// Built-in Agent system prompt — port of backend/app/core/agent.py
// (system_prompt / memory_index / memory_full), core/tailor.py rules(), plus
// the host suffix from services/embedded_agent_host.py _system_prompt.
// The rule text is copied verbatim from Python.

import { MEMORY_KIND } from "../labels";
import { overview } from "../operations";
import { capabilityIndex } from "../tools/catalog";
import { CORE_RULES, matchSkills, skillPrompt } from "./skills";
import type { CoreContext, CoreStore, MemoryKind, StoredRecord } from "../types";

export const AGENT_ACTOR = "助手";
export const MAX_STEPS = 6;
const INDEX_LINES = 60;
const INDEX_CHARS = 3000;
export type MemoryArm = "none" | "index" | "full";


export const HOST_PROMPT_SUFFIX = "\n缺少只有用户能定的偏好或取舍时，用 request_user_input 问一句。";

/** json.dumps(value, ensure_ascii=False) with Python's default ", " / ": " separators. */
export function pyJson(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) return `[${value.map(pyJson).join(", ")}]`;
  if (typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).map(([key, item]) => `${JSON.stringify(key)}: ${pyJson(item)}`).join(", ")}}`;
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  return JSON.stringify(value);
}

function head(memory: StoredRecord): string {
  const title = String(memory.title ?? "").split(/\s+/).filter(Boolean).join(" ") || "（无标题）";
  const line = `#${memory.id} [${MEMORY_KIND[memory.kind as MemoryKind] ?? "其他"}] ${title}`;
  return memory.confirmed === false ? `${line} · 待确认` : line;
}

export async function memoryIndex(store: CoreStore): Promise<string> {
  const memories = [...await store.all("memory")].sort((a, b) => b.id - a.id);
  const lines: string[] = [];
  let size = 0;
  for (const memory of memories) {
    const line = head(memory);
    if (lines.length >= INDEX_LINES || size + line.length + 1 > INDEX_CHARS) break;
    lines.push(line);
    size += line.length + 1;
  }
  if (memories.length > lines.length) lines.push(`……还有 ${memories.length - lines.length} 条更早的没列出，要找就 search`);
  return lines.join("\n") || "（还没有记忆）";
}

export async function memoryFull(store: CoreStore): Promise<string> {
  const blocks = [...await store.all("memory")].sort((a, b) => b.id - a.id).map((memory) => {
    const quote = memory.quote ? `（用户原话：${String(memory.quote)}）` : "";
    return [head(memory), String(memory.body ?? "").trim(), quote].filter(Boolean).join("\n");
  });
  return blocks.join("\n\n") || "（还没有记忆）";
}

/** core/tailor.py rules(): confirmed kind=preference memories, one "- title：body" line each. */
export async function preferenceRules(store: CoreStore): Promise<string> {
  const usable = [...await store.all("memory")].sort((a, b) => a.id - b.id).filter((memory) => memory.confirmed !== false);
  return usable
    .filter((memory) => memory.kind === "preference")
    .map((memory) => [String(memory.title ?? "").trim(), String(memory.body ?? "").trim()].filter(Boolean).join("："))
    .filter(Boolean)
    .map((line) => `- ${line}`)
    .join("\n");
}

export interface PromptOptions {
  maxSteps?: number;
  memoryArm?: MemoryArm;
  /** Tool names this run has; adds the capability index (tools/catalog.ts). */
  tools?: readonly string[];
  /** The user's message and recent conversation: skills whose triggers match are loaded up front. */
  skillTexts?: readonly string[];
}

export async function agentSystemPrompt(store: CoreStore, ctx: CoreContext, options: PromptOptions = {}): Promise<string> {
  const view = await overview(store, ctx);
  const summary: Record<string, unknown> = {
    stage: view.stage,
    next_step: view.next_step,
    jobs: Object.fromEntries(Object.entries(view.jobs).filter(([, count]) => count)),
    todos: Object.fromEntries(Object.entries(view.todos).filter(([, items]) => items.length).map(([key, items]) => [key, items.length])),
  };
  if (view.mail) summary.mail = view.mail;
  const arm = options.memoryArm ?? "index";
  let memory = "";
  if (arm === "index") {
    const ruled = await preferenceRules(store);
    memory = `用户的记忆索引（只有标题，新的在前）：\n${await memoryIndex(store)}\n`
      + (ruled ? `用户的口径和偏好（必须遵守，不当作事实）：\n${ruled}\n` : "");
  } else if (arm === "full") {
    memory = `用户的记忆（全文，新的在前；标「待确认」的还不能当事实）：\n${await memoryFull(store)}\n`;
  }
  return `你是 OfferU 里的求职助手。今天是 ${view.today}。\n`
    + `用户现在的情况（overview 摘要）：${pyJson(summary)}\n`
    + memory
    + (options.tools?.length ? capabilityIndex(options.tools) : "")
    + CORE_RULES
    + `- 最多调用 ${options.maxSteps || MAX_STEPS} 轮工具，先用 overview / search / get 查清楚再写。\n`
    + skillPrompt(matchSkills(options.skillTexts ?? []));
}
