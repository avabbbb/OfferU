// 旧简历原文 → 一条条 memory（port of backend/app/core/resume_split.py + agents/desensitize.py）。
// 只整理不改写；非本机模型先脱敏、回来再还原。写库由调用方走 saveRecord(fromResume)。

import { extractJson, type LlmClient } from "../llm";
import { MEMORY_MODE } from "../operations";
import { CoreError, type Json } from "../types";
import { pyStr } from "../research/py";

const KINDS = ["experience", "project", "education", "skill", "award"];

export const SPLIT_PROMPT = `你是求职档案整理助手。把用户的简历原文拆成一条条经历，只输出严格 JSON：
{"items": [{"kind": "experience|project|education|skill|award", "title": "", "body": "", "start": "", "end": "", "mode": ""}]}
规则：
1. 一段实习/工作、一个项目、一段教育各是一条。PDF 的视觉换行不是新条目，同一段经历的多行合并进 body。
2. title：实习/工作写「公司 · 职位」，项目写项目名（有角色就加上），教育写「学校 · 专业 · 学位」，技能写分类，奖项/证书写名称。
3. body：保留原文的全部事实和数字；原文有分点就每点一行、以「- 」开头。不改写、不编造、不加原文没有的内容。
4. start / end：原文有时间就写成 YYYY-MM 或 YYYY，至今写「至今」，没有就留空。
5. 姓名、电话、邮箱等联系方式不要拆成条目。原文里形如占位符的内容原样保留。
6. mode：实习/工作填「全职」「实习」或「兼职」，教育填「全日制」或「非全日制」。只按原文判断（节标题「实习经历」「工作经历」、职位里的「实习生」、「全日制」字样等），看不出来就留空，不要猜。
`;

// ---- PII desensitization (agents/desensitize.py) ----
const PHONE_CN = /(?<!\d)1[3-9]\d{9}(?!\d)/g;
const PHONE_INTL = /\+\d{1,3}[\s-]?\d{6,14}/g;
const EMAIL = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
const ID_CARD = /(?<!\d)\d{17}[\dXx](?!\d)/g;
const BANK_CARD = /(?<!\d)\d{4}\s?\d{4}\s?\d{4}\s?\d{4}\s?\d{0,3}(?!\d)/g;
const LOOSE = /\[?_{0,3}PII_([A-Z]+)_(\d+)_([0-9a-f]{8})_{0,3}\]?/g;

function nonce(): string {
  const bytes = new Uint8Array(4);
  globalThis.crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** 脱敏：返回 [文本, {占位符: 原值}]。 */
export function desensitize(text: string): [string, Record<string, string>] {
  const mapping: Record<string, string> = {};
  const counter: Record<string, number> = { phone: 0, email: 0, id: 0, bank: 0 };
  const tag = nonce();
  const replace = (prefix: string) => (original: string) => {
    for (const [placeholder, value] of Object.entries(mapping)) if (value === original) return placeholder;
    counter[prefix] += 1;
    const placeholder = `[__PII_${prefix.toUpperCase()}_${counter[prefix]}_${tag}__]`;
    mapping[placeholder] = original;
    return placeholder;
  };
  const result = text
    .replace(ID_CARD, replace("id"))
    .replace(EMAIL, replace("email"))
    .replace(PHONE_INTL, replace("phone"))
    .replace(PHONE_CN, replace("phone"))
    .replace(BANK_CARD, replace("bank"));
  return [result, mapping];
}

/** 还原占位符；也认模型改写过（丢了下划线、方括号）的占位符。 */
export function restorePii(text: string, mapping: Record<string, string>): string {
  let result = text;
  for (const [placeholder, original] of Object.entries(mapping)) result = result.split(placeholder).join(original);
  if (!result.includes("PII_")) return result;
  const keys = new Map<string, string>();
  for (const [placeholder, original] of Object.entries(mapping)) {
    const match = new RegExp(`^${LOOSE.source}$`).exec(placeholder);
    if (match) keys.set(`${match[1]}|${match[2]}|${match[3]}`, original);
  }
  if (!keys.size) return result;
  return result.replace(LOOSE, (whole, kind: string, n: string, tagged: string) => keys.get(`${kind}|${n}|${tagged}`) ?? whole);
}

export function normalizeSplitItem(item: unknown): Json | null {
  if (typeof item !== "object" || item === null || Array.isArray(item)) return null;
  const data = item as Json;
  const str = (value: unknown) => (value === null || value === undefined || value === "" ? "" : pyStr(value));
  const kind = str(data.kind).trim();
  const title = [...str(data.title).trim()].slice(0, 120).join("");
  const body = str(data.body).trim();
  if (!title && !body) return null;
  const out: Json = { kind: KINDS.includes(kind) ? kind : "note", title, body };
  const mode = str(data.mode).trim();
  if ((MEMORY_MODE[out.kind as string] ?? []).includes(mode)) out.mode = mode;
  for (const key of ["start", "end"]) {
    const value = str(data[key]).trim();
    if (value) out[key] = [...value].slice(0, 20).join("");
  }
  return out;
}

export async function extractResumeItems(llm: LlmClient, text: string): Promise<Json[]> {
  let safe = text.slice(0, 30_000);
  let mapping: Record<string, string> = {};
  if (!llm.local) [safe, mapping] = desensitize(safe);
  let raw = await llm.chat([{ role: "system", content: SPLIT_PROMPT }, { role: "user", content: safe }], { temperature: 0.1, json: true, maxTokens: 6000 });
  if (Object.keys(mapping).length) raw = restorePii(raw ?? "", mapping);
  const parsed = extractJson(raw ?? "");
  const items = parsed?.items;
  if (!Array.isArray(items)) throw new CoreError("模型没返回可用的条目，档案没动");
  return items.map(normalizeSplitItem).filter((item): item is Json => item !== null);
}
