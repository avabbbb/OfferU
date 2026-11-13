// 结构化简历：doc.resume 是事实来源，doc.body（Markdown）由它派生。Port of backend/app/core/resume_model.py.
//
// Resume  = {version: 1, basics: {name, target, contacts: [Contact]}, sections: [Section]}
// Contact = {label, value}
// Section = {id, type, title, hidden, items: [Item]}
// Item    = {id, title, subtitle, date, location, bullets: [str], text}

import { CoreError } from "../types";
import { oneLine, pyStr, splitlines, truthy } from "./py";

export const SECTION_TYPES = ["education", "work", "internship", "project", "campus", "skills", "awards", "summary", "custom"] as const;
export type SectionType = (typeof SECTION_TYPES)[number];

export type ResumeContact = { label: string; value: string };
export type ResumeItem = { id: string; title: string; subtitle: string; date: string; location: string; bullets: string[]; text: string };
export type ResumeSection = { id: string; type: SectionType; title: string; hidden: boolean; items: ResumeItem[] };
export type Resume = { version: 1; basics: { name: string; target: string; contacts: ResumeContact[] }; sections: ResumeSection[] };

// 按顺序匹配：「实习工作经历」算实习。
const TYPE_WORDS: Array<[SectionType, string[]]> = [
  ["education", ["教育", "学历"]],
  ["internship", ["实习"]],
  ["work", ["工作", "职业经历", "任职"]],
  ["project", ["项目"]],
  ["campus", ["校园", "社团", "学生", "社会实践", "志愿"]],
  ["skills", ["技能", "证书", "语言能力"]],
  ["awards", ["荣誉", "获奖", "奖项", "奖励"]],
  ["summary", ["评价", "总结", "简介", "关于我", "个人优势"]],
];
export const TARGET_PREFIX = "求职意向：";
const TARGET_RE = /^(?:求职意向|意向岗位|求职方向)\s*[：:]\s*/u;
const CONTACT_SPLIT = /\s*(?:·|\||｜)\s*/u;
const ROW_SPLIT = /\s*(?:\||｜)\s*/u;
const LABELED = /^([^：:\s]{1,8})\s*[：:]\s*(.+)$/u;
const BULLET = /^\s*(?:[-*+]|\d+[.)])\s+/u;

export function newResumeId(): string {
  const bytes = new Uint8Array(4);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function sectionType(title: string): SectionType {
  for (const [type, words] of TYPE_WORDS) if (words.some((word) => title.includes(word))) return type;
  return "custom";
}

function text(value: unknown, where: string): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "object" || typeof value === "boolean") throw new CoreError(`doc.resume.${where} 要是文字`);
  return pyStr(value);
}

function list(value: unknown, where: string): unknown[] {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value)) throw new CoreError(`doc.resume.${where} 要是数组`);
  return value;
}

const idOf = (value: unknown): string => (typeof value === "string" && value.trim() ? value : newResumeId());
const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** 联系方式一项 {label, value}。旧数据是一行文字，能拆出标签就拆，网址不拆。 */
export function toContact(value: unknown, where = "basics.contacts"): ResumeContact {
  if (isObject(value)) return { label: text(value.label, where + ".label"), value: text(value.value, where + ".value") };
  const raw = text(value, where);
  const m = LABELED.exec(raw.trim());
  if (m && !m[2].startsWith("//")) return { label: m[1], value: m[2] };
  return { label: "", value: raw };
}

/** 纸面和 Markdown 上的一项：有标签写「标签：内容」，没有就只写内容。 */
export function contactText(item: ResumeContact): string {
  const label = item.label.trim();
  return label ? `${label}：${item.value}` : item.value;
}

export const emptyResumeItem = (): ResumeItem => ({ id: newResumeId(), title: "", subtitle: "", date: "", location: "", bullets: [], text: "" });

/** 缺的字段补空值、id 补齐、type 不认识就算 custom；类型不对直接报错（不静默丢）。不 strip。 */
export function normalizeResume(resume: unknown): Resume {
  if (!isObject(resume)) throw new CoreError("doc.resume 要是对象：{basics, sections}");
  const basics = truthy(resume.basics) ? resume.basics : {};
  if (!isObject(basics)) throw new CoreError("doc.resume.basics 要是对象：{name, target, contacts}");
  const sections = list(resume.sections, "sections").map((sec, i): ResumeSection => {
    if (!isObject(sec)) throw new CoreError(`doc.resume.sections[${i}] 要是对象`);
    const title = text(sec.title, `sections[${i}].title`);
    const items = list(sec.items, `sections[${i}].items`).map((item, j): ResumeItem => {
      if (!isObject(item)) throw new CoreError(`doc.resume.sections[${i}].items[${j}] 要是对象`);
      const where = `sections[${i}].items[${j}]`;
      return {
        id: idOf(item.id),
        title: text(item.title, `${where}.title`),
        subtitle: text(item.subtitle, `${where}.subtitle`),
        date: text(item.date, `${where}.date`),
        location: text(item.location, `${where}.location`),
        bullets: list(item.bullets, `${where}.bullets`).map((b) => text(b, `${where}.bullets`)),
        text: text(item.text, `${where}.text`),
      };
    });
    const type = (SECTION_TYPES as readonly unknown[]).includes(sec.type) ? sec.type as SectionType : sectionType(title);
    return { id: idOf(sec.id), type, title, hidden: truthy(sec.hidden), items };
  });
  return {
    version: 1,
    basics: {
      name: text(basics.name, "basics.name"),
      target: text(basics.target, "basics.target"),
      contacts: list(basics.contacts, "basics.contacts").map((c, k) => toContact(c, `basics.contacts[${k}]`)),
    },
    sections,
  };
}

/** ### 标题 | 副标题 | (城市 |) 时间 → item 头。只有一段就是标题。 */
function row(heading: string): ResumeItem {
  const parts = heading.trim().split(ROW_SPLIT);
  const item = emptyResumeItem();
  item.title = parts[0];
  if (parts.length > 1) {
    item.date = parts[parts.length - 1];
    const middle = parts.slice(1, -1);
    if (middle.length === 1) item.subtitle = middle[0];
    else if (middle.length) {
      item.subtitle = middle.slice(0, -1).filter(Boolean).join(" · ");
      item.location = middle[middle.length - 1];
    }
  }
  return item;
}

type RawSection = { id: string; type: SectionType; title: string; hidden: boolean; items: ResumeItem[] };

/** 旧数据、agent、模型给的 Markdown → Resume。认不出来的行都当正文，不丢字。 */
export function resumeFromMarkdown(body: string): Resume {
  let name = "";
  let target = "";
  let contacts: string[] = [];
  const sections: RawSection[] = [];
  let section: RawSection | null = null;
  let item: ResumeItem | null = null;
  const para: string[] = [];
  let seenName = false;

  const currentItem = (): ResumeItem => {
    if (section === null) {
      section = { id: newResumeId(), type: "custom", title: "", hidden: false, items: [] };
      sections.push(section);
    }
    if (item === null) {
      item = emptyResumeItem();
      section.items.push(item);
    }
    return item;
  };

  const flush = (): void => {
    if (!para.length) return;
    const joined = para.join("\n");
    para.length = 0;
    if (section === null) {
      if (TARGET_RE.test(joined)) target = joined.replace(TARGET_RE, "").trim();
      else if (!contacts.length) contacts = joined.split("\n").flatMap((line) => line.split(CONTACT_SPLIT)).filter(Boolean);
      else target = target || joined;
      return;
    }
    const it = currentItem();
    it.text = (it.text + "\n" + joined).replace(/^\n+|\n+$/g, "");
  };

  for (const raw of splitlines(body || "")) {
    const line = raw.replace(/\s+$/u, "");
    const stripped = line.trim();
    if (stripped === "" || stripped === "&nbsp;") {
      flush();
      continue;
    }
    if ((line === "#" || line.startsWith("# ")) && !seenName && section === null) {
      flush();
      name = line.slice(2).trim();
      seenName = true;
    } else if (line.startsWith("## ") || line.startsWith("# ")) {
      flush();
      const title = line.replace(/^#+/, "").trim();
      section = { id: newResumeId(), type: sectionType(title), title, hidden: false, items: [] };
      sections.push(section);
      item = null;
    } else if (line.startsWith("### ")) {
      flush();
      item = row(line.slice(4));
      currentItem(); // 没有 ## 时挂到一个无标题节
      const sec = section as RawSection | null;
      if (sec && !sec.items.includes(item)) sec.items.push(item);
    } else if (BULLET.test(line)) {
      flush();
      currentItem().bullets.push(line.replace(BULLET, "").trim());
    } else if ((raw.startsWith(" ") || raw.startsWith("\t")) && item !== null && (item as ResumeItem).bullets.length && !para.length) {
      const bullets = (item as ResumeItem).bullets;
      bullets[bullets.length - 1] += " " + line.trim(); // 要点的续行
    } else {
      para.push(line.trim());
    }
  }
  flush();
  return normalizeResume({ basics: { name, target, contacts }, sections });
}

/** Resume → Markdown（隐藏的节不写）。resumeFromMarkdown 能原样读回来。 */
export function resumeToMarkdown(input: unknown): string {
  const resume = normalizeResume(input);
  const basics = resume.basics;
  const out = [`# ${oneLine(basics.name)}`.replace(/\s+$/u, "")];
  const contacts = basics.contacts.filter((c) => c.value.trim()).map((c) => oneLine(contactText(c)));
  if (contacts.length) out.push("", contacts.join(" · "));
  if (basics.target.trim()) out.push("", TARGET_PREFIX + oneLine(basics.target));
  for (const sec of resume.sections) {
    if (sec.hidden) continue;
    out.push("", `## ${oneLine(sec.title) || "未命名"}`);
    for (const it of sec.items) {
      const [title, subtitle, location, date] = [it.title, it.subtitle, it.location, it.date].map(oneLine);
      if (subtitle || location || date) {
        const middle = location ? [subtitle, location] : subtitle ? [subtitle] : [];
        out.push("", "### " + [title, ...middle, date].join(" | "));
      } else if (title) {
        out.push("", `### ${title}`);
      }
      const body = it.text.split("\n").map((line) => line.trim()).filter(Boolean).join("\n");
      if (body) out.push("", body);
      const bullets = it.bullets.filter((b) => b.trim()).map(oneLine);
      if (bullets.length) out.push("", ...bullets.map((b) => `- ${b}`));
    }
  }
  return out.join("\n").trim() + "\n";
}

/** 读简历：有 doc.resume 用它，旧 doc 只有 body 就从 Markdown 解析（不写库）。 */
export function resumeOf(doc: Record<string, unknown>): Resume {
  if (isObject(doc.resume)) return normalizeResume(doc.resume);
  return resumeFromMarkdown(truthy(doc.body) ? pyStr(doc.body) : "");
}

/** 至少有名字和一个有内容的节，才算一份简历。 */
export function isResumeFilled(resume: Resume): boolean {
  return Boolean(resume.basics.name.trim()) && resume.sections.some((sec) =>
    sec.items.some((it) => it.title.trim() || it.text.trim() || it.bullets.some((b) => b.trim())));
}
