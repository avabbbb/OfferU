/**
 * 把一条段落级 AI 建议拆成「哪几句话变了」，并判断它是否和用户的手动修改冲突。
 * 纯函数，不调用模型，也不改数据；画布用它在原位置画出行内 diff。
 */

import { splitBullets, textFromHtml } from "@/lib/resumeText";

export interface ProposalTextChange {
  /** 人能看懂的位置，例如「示例科技 · 要点 2」 */
  label: string;
  before: string;
  after: string;
}

export interface DiffSegment {
  kind: "same" | "added" | "removed";
  text: string;
}

type Row = { section_type?: string; title?: string; content_json?: unknown; source_section_ids?: number[] } | null | undefined;
type SectionLike = { id: number; section_type: string; title: string; content_json: any[]; source_section_ids?: number[] };

const LABEL_KEYS = ["company", "school", "name", "awardName", "experienceTitle", "category", "title", "position"];

function itemLabel(item: Record<string, any> | undefined, index: number) {
  for (const key of LABEL_KEYS) {
    const value = item?.[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return `第 ${index + 1} 条`;
}

function asText(value: unknown): string {
  if (Array.isArray(value)) return value.map(asText).filter(Boolean).join("、");
  if (value == null) return "";
  return typeof value === "string" ? value : String(value);
}

function fieldLines(key: string, value: unknown): string[] {
  if (key === "description") return splitBullets(asText(value));
  const text = textFromHtml(asText(value)).trim();
  return text ? [text] : [];
}

const FIELD_LABELS: Record<string, string> = {
  position: "职位", company: "公司", school: "学校", degree: "学历", major: "专业", role: "角色",
  name: "名称", items: "技能", category: "类别", startDate: "开始", endDate: "结束", location: "城市",
};

/** 段落里每一句真正变了的文字；顺序与页面一致。 */
export function proposalTextChanges(change: { before?: Row; after?: Row }): ProposalTextChange[] {
  const beforeItems = Array.isArray(change.before?.content_json) ? (change.before!.content_json as any[]) : [];
  const afterItems = Array.isArray(change.after?.content_json) ? (change.after!.content_json as any[]) : [];
  const result: ProposalTextChange[] = [];
  const count = Math.max(beforeItems.length, afterItems.length);
  for (let index = 0; index < count; index += 1) {
    const before = (beforeItems[index] || {}) as Record<string, any>;
    const after = (afterItems[index] || {}) as Record<string, any>;
    const label = itemLabel(afterItems[index] || beforeItems[index], index);
    const keys = Array.from(new Set([...Object.keys(before), ...Object.keys(after)]))
      .filter((key) => !key.startsWith("_") && key !== "hidden_bullet_indexes" && key !== "id");
    for (const key of keys) {
      const oldLines = fieldLines(key, before[key]);
      const newLines = fieldLines(key, after[key]);
      if (oldLines.join("\n") === newLines.join("\n")) continue;
      if (key === "description") {
        const lines = Math.max(oldLines.length, newLines.length);
        for (let line = 0; line < lines; line += 1) {
          if ((oldLines[line] || "") === (newLines[line] || "")) continue;
          result.push({ label: `${label} · 要点 ${line + 1}`, before: oldLines[line] || "", after: newLines[line] || "" });
        }
      } else {
        result.push({ label: `${label} · ${FIELD_LABELS[key] || key}`, before: oldLines.join(" "), after: newLines.join(" ") });
      }
    }
  }
  return result;
}

/** 与后端 _find_section 相同的定位规则：先按来源证据，再按类型 + 标题。 */
export function findTargetSection<T extends SectionLike>(sections: T[], change: { before?: Row; after?: Row }): T | undefined {
  const row = change.before || change.after;
  if (!row) return undefined;
  const wanted = new Set((row.source_section_ids || []).map(Number));
  if (wanted.size) {
    const bySource = sections.find((section) => (section.source_section_ids || []).some((id) => wanted.has(Number(id))));
    if (bySource) return bySource;
  }
  return sections.find((section) => section.section_type === row.section_type && section.title === row.title);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>).sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

/** 建议生成后，用户是否亲手改过它要改的那一段（与后端冲突判断一致）。 */
export function conflictsWithManualEdit(section: SectionLike | undefined, change: { change_type?: string; before?: Row }) {
  if (change.change_type === "added" || !change.before) return false;
  if (!section) return true;
  return stableJson(section.content_json || []) !== stableJson(change.before.content_json || []);
}

/** 字符级 LCS diff：中文没有空格，按字比较才看得清改了哪几个字。 */
export function diffText(before: string, after: string): DiffSegment[] {
  const a = Array.from(before);
  const b = Array.from(after);
  if (a.length * b.length > 250_000) {
    return [
      ...(before ? [{ kind: "removed" as const, text: before }] : []),
      ...(after ? [{ kind: "added" as const, text: after }] : []),
    ];
  }
  const table: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  const segments: DiffSegment[] = [];
  const push = (kind: DiffSegment["kind"], text: string) => {
    const last = segments[segments.length - 1];
    if (last && last.kind === kind) last.text += text;
    else segments.push({ kind, text });
  };
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { push("same", a[i]); i += 1; j += 1; }
    else if (table[i + 1][j] >= table[i][j + 1]) { push("removed", a[i]); i += 1; }
    else { push("added", b[j]); j += 1; }
  }
  while (i < a.length) { push("removed", a[i]); i += 1; }
  while (j < b.length) { push("added", b[j]); j += 1; }
  return segments;
}

