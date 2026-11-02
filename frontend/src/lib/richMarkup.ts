// 正文的存储格式：带轻量标记的纯文本，和后端 backend/app/core/resume.py 的 _text_html / _inline 一一对应。
// 一行一块：行首每 2 个空格缩进一级（最多 4 级），接着可选 {center} / {right} / {justify} 对齐，再可选 "- " / "1. " 列表；
// 行内 **粗体**、*斜体*、[文字](https://链接)。编辑框（components/resume/RichText）显示成 HTML，改完再从 DOM 读回这种标记。
// 前后端共用用例在 richMarkup.cases.json，vitest 和 backend/tests/test_rich_markup_cases.py 都跑。

export type Align = "" | "center" | "right" | "justify";
export type Line = { indent: number; align: Align; list: "" | "ul" | "ol"; text: string };

// 只用到 DOM 的这一小部分，单测可以直接拼假节点。
type StyleLike = { textAlign?: string; marginLeft?: string; paddingLeft?: string; fontWeight?: string; fontStyle?: string };
export type NodeLike = {
  nodeType: number; nodeName: string; nodeValue: string | null; childNodes: ArrayLike<NodeLike>;
  getAttribute?: (name: string) => string | null; style?: StyleLike;
};

const MAX_INDENT = 4;
const LINE = /^( *)(?:\{(center|right|justify)\} )?(- |\d+\. )?/;

export function parseLine(raw: string): Line {
  const m = LINE.exec(raw)!;
  return {
    indent: Math.min(Math.floor(m[1].length / 2), MAX_INDENT),
    align: (m[2] ?? "") as Align,
    list: m[3] ? (m[3] === "- " ? "ul" : "ol") : "",
    text: raw.slice(m[0].length),
  };
}

export function formatLines(lines: Line[]): string {
  let n = 0;
  const rows = lines.map((l) => {
    n = l.list === "ol" ? n + 1 : 0;
    const mark = l.list === "ul" ? "- " : l.list === "ol" ? n + ". " : "";
    return "  ".repeat(Math.min(l.indent, MAX_INDENT)) + (l.align ? "{" + l.align + "} " : "") + mark + l.text;
  });
  while (rows.length && !rows[rows.length - 1].trim()) rows.pop();
  return rows.join("\n");
}

// 引号不转义（和后端 html.escape(quote=False) 一致），链接里的引号换成 %22。
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const BOLD = /\*\*(.+?)\*\*/g;
// 后行断言用构造函数写，免得 tsc 按 target 卡正则语法。
const ITALIC = new RegExp("(?<!\\*)\\*(?!\\*)(.+?)(?<!\\*)\\*(?!\\*)", "g");
const LINK = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g;

export function inlineHtml(text: string): string {
  return esc(text).replace(BOLD, "<strong>$1</strong>").replace(ITALIC, "<em>$1</em>")
    .replace(LINK, (_m, label: string, url: string) => '<a href="' + url.replace(/"/g, "%22") + '">' + label + "</a>");
}

const styleAttr = (l: Line) => {
  const rules = [l.indent ? "margin-left: " + 2 * l.indent + "em" : "", l.align ? "text-align: " + l.align : ""].filter(Boolean);
  return rules.length ? ' style="' + rules.join("; ") + '"' : "";
};

// 标记 → 编辑框里的 HTML：普通行一个 div，连续的同类列表行合成一个 ul / ol。
export function markupToHtml(text: string): string {
  if (!text) return "";
  const out: string[] = [];
  let kind = "";
  let rows: string[] = [];
  const flush = () => {
    if (rows.length) out.push("<" + kind + ">" + rows.join("") + "</" + kind + ">");
    kind = "";
    rows = [];
  };
  for (const raw of text.split("\n")) {
    const l = parseLine(raw);
    const body = inlineHtml(l.text) || "<br>";
    if (!l.list) {
      flush();
      out.push("<div" + styleAttr(l) + ">" + body + "</div>");
      continue;
    }
    if (l.list !== kind) {
      flush();
      kind = l.list;
    }
    rows.push("<li" + styleAttr(l) + ">" + body + "</li>");
  }
  flush();
  return out.join("");
}

// 去掉所有标记，给收起的卡片摘要用。
export function plainText(text: string): string {
  return text.split("\n")
    .map((raw) => parseLine(raw).text.replace(LINK, "$1").replace(BOLD, "$1").replace(ITALIC, "$1"))
    .join("\n");
}

const BLOCK = new Set(["DIV", "P", "BLOCKQUOTE", "LI", "SECTION", "ARTICLE", "PRE", "H1", "H2", "H3", "H4", "H5", "H6"]);
const isEl = (n: NodeLike) => n.nodeType === 1;
const name = (n: NodeLike) => n.nodeName.toUpperCase();

function alignOf(el: NodeLike): Align {
  const a = (el.style?.textAlign || el.getAttribute?.("align") || "").toLowerCase();
  return a === "center" ? "center" : a === "right" || a === "end" ? "right" : a === "justify" ? "justify" : "";
}

// 自己写的 2em 一级；浏览器 indent 命令给的是 40px 一级。
function levels(v?: string): number {
  const m = /^([\d.]+)(em|px)$/.exec((v ?? "").trim());
  return m ? Math.round(parseFloat(m[1]) / (m[2] === "em" ? 2 : 40)) : 0;
}

// 把两端空白挪到标记外面：" 词 " → " **词** "。
function mark(inner: string, m: string): string {
  if (!inner.trim()) return inner;
  const [, lead, core, trail] = /^(\s*)([\s\S]*?)(\s*)$/.exec(inner)!;
  return lead + m + core + m + trail;
}

// 只含文字和行内标签的节点 → 一段行内标记；里面有换行或块就返回 null，交给 walk 拆行。
function inline(node: NodeLike, bold = false, italic = false): string | null {
  if (node.nodeType === 3) return (node.nodeValue ?? "").replace(/\u00a0/g, " ").replace(/[\r\n]+/g, " ");
  if (!isEl(node)) return "";
  const n = name(node);
  if (n === "BR" || n === "UL" || n === "OL" || BLOCK.has(n)) return null;
  const weight = node.style?.fontWeight ?? "";
  const b = !bold && (n === "B" || n === "STRONG" || weight === "bold" || parseInt(weight, 10) >= 600);
  const i = !italic && (n === "I" || n === "EM" || node.style?.fontStyle === "italic");
  let out = "";
  for (const child of Array.from(node.childNodes)) {
    const s = inline(child, bold || b, italic || i);
    if (s === null) return null;
    out += s;
  }
  if (i) out = mark(out, "*");
  if (b) out = mark(out, "**");
  const href = n === "A" ? node.getAttribute?.("href") ?? "" : "";
  return /^https?:\/\/\S+$/.test(href) && out.trim() ? "[" + out + "](" + href + ")" : out;
}

type Ctx = { indent: number; align: Align; list: "" | "ul" | "ol" };

// 编辑框 DOM → 标记。singleLine（要点）只留行内标记，多行拼成一行。
export function domToMarkup(root: NodeLike, singleLine = false): string {
  const lines: Line[] = [];
  let cur: Line | null = null;
  const start = (ctx: Ctx) => (cur ??= { indent: Math.min(ctx.indent, MAX_INDENT), align: ctx.align, list: ctx.list, text: "" });
  const end = () => {
    if (cur) lines.push(cur);
    cur = null;
  };

  const walk = (node: NodeLike, ctx: Ctx) => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === 3) {
        const s = inline(child)!;
        if (cur || s.trim()) start(ctx).text += s;
        continue;
      }
      if (!isEl(child)) continue;
      const n = name(child);
      if (n === "BR") {
        start(ctx);
        end();
      } else if (n === "UL" || n === "OL") {
        end();
        walk(child, { indent: ctx.indent + (ctx.list ? 1 : 0), align: "", list: n === "UL" ? "ul" : "ol" });
        end();
      } else if (BLOCK.has(n)) {
        end();
        const extra = (n === "BLOCKQUOTE" ? 1 : 0) + levels(child.style?.marginLeft) + levels(child.style?.paddingLeft);
        walk(child, { indent: ctx.indent + extra, align: alignOf(child) || ctx.align, list: ctx.list });
        end();
      } else {
        const s = inline(child);
        if (s === null) walk(child, ctx);
        else if (cur || s.trim()) start(ctx).text += s;
      }
    }
  };
  walk(root, { indent: 0, align: "", list: "" });
  end();
  if (singleLine) return lines.map((l) => l.text.trim()).filter(Boolean).join(" ");
  return formatLines(lines);
}
