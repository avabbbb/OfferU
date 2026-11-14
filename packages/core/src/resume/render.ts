// The one resume renderer (port of backend/app/core/resume.py). Pure string → string: the browser can put the
// result in an iframe and window.print() it; the Node companion prints the very same HTML with Playwright.
//
// HTML 结构（模板 CSS 只认这些）：
//   h1 名字 → p.contact 联系方式 / 求职意向 → section > h2 节标题 → div.item > h3、p 正文、ul > li 要点
// 每个可编辑的元素带 data-path（如 sections.1.items.0.bullets.2），预览里点哪儿就改哪儿。

import type { CoreStore, Json } from "../types";
import { contactText, resumeOf, TARGET_PREFIX, type Resume, type ResumeItem } from "./model";
import { escapeHtml, pyStr, truthy } from "./py";
import { baseName, LEGACY_TEMPLATE, resolveStyle, styleVars, type ResumeStyle } from "./style";
import { BASE_CSS, TEMPLATE_CSS } from "./templates";

/** Read-only access to the user's uploaded files (ID photo, school logo). Node: <data>/files; browser: OPFS/IndexedDB. */
export interface FileSource {
  read(name: string): Promise<{ bytes: Uint8Array; type?: string } | null>;
}

/** Where uploads (old resumes, ID photos, school logos) are kept; names are bare file names, never paths. */
export interface FileStore extends FileSource {
  write(name: string, bytes: Uint8Array): Promise<void>;
}

/** In-memory FileStore: tests, and a stand-in on the web until the browser store keeps files in IndexedDB/OPFS. */
export function memoryFileStore(seed: Record<string, Uint8Array> = {}): FileStore & { files: Map<string, Uint8Array> } {
  const files = new Map(Object.entries(seed));
  const safe = (name: string): string => name.split(/[\\/]/).pop() ?? "";
  return {
    files,
    async read(name) {
      const bytes = files.get(safe(name));
      return bytes ? { bytes, type: guessMime(safe(name)) ?? "application/octet-stream" } : null;
    },
    async write(name, bytes) {
      const key = safe(name);
      if (!key || key === "." || key === "..") throw new Error("bad file name");
      files.set(key, bytes);
    },
  };
}

/** Prints the renderer's HTML (A4). Companion: Playwright + local Chromium; absent elsewhere. */
export interface PageRenderer {
  pdf(html: string): Promise<Uint8Array>;
  /** 2× pixels, only main.resume; longer than a page = one tall image. */
  png(html: string): Promise<Uint8Array>;
  /** main.resume height at A4 width, in A4 pages (1123 px each), 2 decimals. */
  pageCount(html: string): Promise<number>;
}

export function sheet(style: ResumeStyle): string {
  return BASE_CSS + TEMPLATE_CSS[style.template] + styleVars(style);
}

/** A template's stylesheet with its default style. Old names (single / photo) still resolve; unknown → classic. */
export function templateCss(template: string): string {
  return sheet(template in LEGACY_TEMPLATE ? resolveStyle(null, template) : resolveStyle({ template }));
}

const LINE = /^( *)(?:\{(center|right|justify)\} )?(- |\d+\. )?/;
export type MarkupLine = { indent: number; align: "" | "center" | "right" | "justify"; list: "" | "ul" | "ol"; text: string };

/** 一行标记拆成缩进、对齐、列表和正文，和前端 lib/richMarkup 的 parseLine 一致。 */
export function parseLine(raw: string): MarkupLine {
  const m = LINE.exec(raw)!;
  const mark = m[3] ?? "";
  return {
    indent: Math.min(Math.floor(m[1].length / 2), 4),
    align: (m[2] ?? "") as MarkupLine["align"],
    list: mark === "- " ? "ul" : mark ? "ol" : "",
    text: raw.slice(m[0].length),
  };
}

const BOLD = /\*\*(.+?)\*\*/g;
const ITALIC = /(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g;
// 下划线 ++词++：前面不能紧挨字母数字或 +（「C++、C++11」不算），两头不能是空白；\w 只认 ASCII，与 Python re.ASCII、前端 richMarkup 一致。
const UNDER = /(?<![A-Za-z0-9_+])\+\+(?=[^ \t\n\r\f\v])(.+?)(?<=[^ \t\n\r\f\v])\+\+(?![A-Za-z0-9_+])/g;
const LINK = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g;

/** 转义，行内认加粗、斜体、++下划线++ 和 [文字](链接)。 */
export function inlineHtml(text: string): string {
  const out = escapeHtml(text, false).replace(BOLD, "<strong>$1</strong>").replace(ITALIC, "<em>$1</em>").replace(UNDER, "<u>$1</u>");
  return out.replace(LINK, (_m, label: string, href: string) => `<a href="${href.replaceAll('"', "%22")}">${label}</a>`);
}

function blockStyle(indent: number, align: string): string {
  const rules = [...(indent ? [`margin-left:${2 * indent}em`] : []), ...(align ? [`text-align:${align}`] : [])];
  return rules.length ? ` style="${rules.join(";")}"` : "";
}

/** 正文，一行一块：缩进、对齐；连续的 "- " 行成无序列表，"1. " 行成有序列表。 */
function textHtml(text: string, path: string): string[] {
  const out: string[] = [];
  let kind = "";
  let rows: string[] = [];
  const flush = () => {
    if (rows.length) out.push(`<${kind} data-path="${path}">` + rows.join("") + `</${kind}>`);
    kind = "";
    rows = [];
  };
  for (const raw of text.split("\n")) {
    const line = parseLine(raw);
    const body = line.text.trim();
    const attrs = blockStyle(line.indent, line.align);
    if (!line.list) {
      flush();
      if (body) out.push(`<p data-path="${path}"${attrs}>${inlineHtml(body)}</p>`);
      continue;
    }
    if (line.list !== kind) {
      flush();
      kind = line.list;
    }
    rows.push(`<li${attrs}>${inlineHtml(body)}</li>`);
  }
  flush();
  return out;
}

/** 标题 · 副标题 · 城市 ······ 时间（时间靠右）。 */
function itemHead(item: ResumeItem, path: string): string {
  const [title, subtitle, location, date] = [item.title, item.subtitle, item.location, item.date].map((s) => s.trim());
  const middle = [subtitle, location].filter(Boolean).map((p) => `<span class="sep">|</span><span class="seg">${inlineHtml(p)}</span>`).join("");
  const right = date ? `<span class="sep-r">|</span><span class="r">${inlineHtml(date)}</span>` : "";
  if (!(title || middle || right)) return "";
  return `<h3 data-path="${path}">${inlineHtml(title)}${middle}${right}</h3>`;
}

/** 结构化简历 → 纸面 HTML。隐藏的节不出；元素带 data-path。resume 要先过 normalizeResume。 */
export function resumeHtml(resume: Resume): string {
  const basics = resume.basics;
  const lines: string[] = [];
  const contacts = basics.contacts.filter((c) => c.value.trim()).map((c) => contactText(c).trim());
  for (let i = 0; i < contacts.length; i += 2) lines.push(contacts.slice(i, i + 2).map(inlineHtml).join(" | "));
  if (basics.target.trim()) lines.push(inlineHtml(TARGET_PREFIX + basics.target.trim()));
  const out: string[] = [];
  const name = basics.name.trim();
  if (name) out.push(`<h1 data-path="basics.name">${inlineHtml(name)}</h1>`);
  if (lines.length) out.push(`<p class="contact" data-path="basics.contacts">${lines.join("<br>")}</p>`);
  resume.sections.forEach((sec, i) => {
    if (sec.hidden) return;
    const path = `sections.${i}`;
    out.push(`<section data-path="${path}"><h2 data-path="${path}.title">${inlineHtml(sec.title.trim()) || "未命名"}</h2>`);
    sec.items.forEach((item, j) => {
      const ip = `${path}.items.${j}`;
      out.push(`<div class="item" data-path="${ip}">${itemHead(item, ip + ".head")}`);
      out.push(...textHtml(item.text, ip + ".text"));
      const bullets = item.bullets.map((b, k) => (b.trim() ? `<li data-path="${ip}.bullets.${k}">${inlineHtml(b.trim())}</li>` : "")).filter(Boolean);
      if (bullets.length) out.push("<ul>" + bullets.join("") + "</ul>");
      out.push("</div>");
    });
    out.push("</section>");
  });
  return out.join("");
}

export type Figures = { photo?: string | null; logo?: string | null };

/** The one renderer: the preview iframe shows this page and the PDF prints it. figures are data: URIs (see figuresFor). */
export function renderResumeHtml(resume: Resume, style?: unknown, figures: Figures = {}, title = "简历"): string {
  const resolved = resolveStyle(style);
  const shown: Array<[string, string]> = [];
  if (resolved.photo && figures.photo) shown.push(["photo", figures.photo]);
  if (figures.logo) shown.push(["logo", figures.logo]);
  const tags = shown.map(([cls, uri]) => `<img class="${cls}" src="${escapeHtml(uri, true)}" alt="">`).join("");
  const classes = ["resume", `t-${resolved.template}`, ...shown.map(([cls]) => `${cls}-on`)].join(" ");
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>`
    + `<style>@page { size: A4; margin: 0; } html, body { margin: 0; }${sheet(resolved)}</style></head>`
    + `<body><main class="${classes}">${tags}${resumeHtml(resume)}</main></body></html>`;
}

const MIME: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", jpe: "image/jpeg", gif: "image/gif", webp: "image/webp",
  svg: "image/svg+xml", bmp: "image/bmp", ico: "image/vnd.microsoft.icon", tif: "image/tiff", tiff: "image/tiff", avif: "image/avif",
  pdf: "application/pdf", txt: "text/plain", md: "text/markdown", markdown: "text/markdown", json: "application/json",
  doc: "application/msword", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};

export function guessMime(name: string): string | null {
  const dot = name.lastIndexOf(".");
  return dot < 0 ? null : MIME[name.slice(dot + 1).toLowerCase()] ?? null;
}

export function base64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/** A stored file as a data: URI, or null when there is no such file (Python resume._file_uri). */
export async function fileDataUri(files: FileSource | null | undefined, name: unknown): Promise<string | null> {
  if (!files || typeof name !== "string" || !name) return null;
  const file = await files.read(baseName(name));
  if (!file) return null;
  return `data:${guessMime(baseName(name)) ?? "image/jpeg"};base64,${base64(file.bytes)}`;
}

/** ID photo only when style.photo is on; logo whenever style.logo names a file. */
export async function figuresFor(style: ResumeStyle, photo: unknown, files?: FileSource | null): Promise<Figures> {
  return {
    photo: style.photo ? await fileDataUri(files, photo) : null,
    logo: await fileDataUri(files, style.logo),
  };
}

/** 文件名只替换 Windows 不允许的字符；空白压成一个空格。 */
export function safeStem(name: string): string {
  const stem = (name || "").replace(/[\\/:*?"<>|]+/g, "_").replace(/\s+/gu, " ");
  return stem.replace(/^[ _.]+|[ _.]+$/g, "");
}

export function resumeFileName(doc: Json, profile: Json | null): string {
  const name = [profile?.name, truthy(doc.title) ? doc.title : "简历"].filter(truthy).map(pyStr).join("-");
  return (safeStem(name) || "简历") + ".pdf";
}

/** The page a stored resume doc prints as (Python resume.doc_html). */
export async function resumeDocHtml(store: CoreStore, doc: Json, files?: FileSource | null): Promise<string> {
  const profile = await store.first("profile");
  const style = resolveStyle(doc.style, doc.template);
  const figures = await figuresFor(style, profile?.photo, files);
  return renderResumeHtml(resumeOf(doc), style, figures, resumeFileName(doc, profile).slice(0, -4));
}
