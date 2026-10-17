const BULLET_MARKER_RE = /^\s*(?:[•●▪◦·*-]|\d+[.)、]|[（(]?\d+[）)]|[a-zA-Z][.)])\s*/;

function decodeEntities(value: string) {
  return value
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

export function textFromHtml(value: string) {
  return decodeEntities(value || "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>\s*<p[^>]*>/gi, "\n")
    .replace(/<li[^>]*>/gi, "\n")
    .replace(/<\/li>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/\r/g, "\n")
    .trim();
}

export function stripBulletMarker(value: string) {
  return (value || "").replace(BULLET_MARKER_RE, "").trim();
}

function splitInlineBullets(line: string) {
  const normalized = (line || "").trim();
  if (!normalized) return [];
  const pieces = normalized.split(/(?=\s*(?:[•●▪◦·*-]|\d+[.)、]|[（(]?\d+[）)])\s+)/g);
  return pieces.map((piece) => stripBulletMarker(piece)).filter(Boolean);
}

export function splitBullets(value: string): string[] {
  const text = textFromHtml(value);
  if (!text) return [];

  const result: string[] = [];
  for (const rawLine of text.split(/\n+/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const pieces = splitInlineBullets(line);
    if (pieces.length > 0) {
      result.push(...pieces);
    }
  }
  return result;
}

export function visibleBullets(value: string, hiddenIndexes: unknown): string[] {
  const hidden = new Set(
    Array.isArray(hiddenIndexes)
      ? hiddenIndexes.map((item) => Number(item)).filter((item) => Number.isInteger(item))
      : [],
  );
  return splitBullets(value).filter((_, index) => !hidden.has(index));
}

export function reorderBullets(
  value: string,
  hiddenIndexes: unknown,
  from: number,
  to: number,
): { description: string; hiddenBulletIndexes: number[] } {
  const bullets = splitBullets(value);
  if (from < 0 || to < 0 || from >= bullets.length || to >= bullets.length || from === to) {
    return {
      description: value,
      hiddenBulletIndexes: Array.isArray(hiddenIndexes) ? hiddenIndexes.map(Number) : [],
    };
  }

  const hidden = new Set(
    Array.isArray(hiddenIndexes)
      ? hiddenIndexes.map((item) => Number(item)).filter((item) => Number.isInteger(item))
      : [],
  );
  const entries = bullets.map((text, index) => ({ text, hidden: hidden.has(index) }));
  const [entry] = entries.splice(from, 1);
  entries.splice(to, 0, entry);

  let description = entries.map((item) => item.text).join("\n");
  if (typeof DOMParser !== "undefined" && /<\s*li\b/i.test(value)) {
    const document = new DOMParser().parseFromString(`<div>${value}</div>`, "text/html");
    const root = document.body.firstElementChild;
    const list = root?.querySelector("ul,ol");
    const listItems = list
      ? Array.from(list.children).filter((item): item is HTMLElement => item.tagName.toLowerCase() === "li")
      : [];
    if (root && list && listItems.length === bullets.length) {
      const moving = listItems[from];
      const reference = listItems[to];
      list.insertBefore(moving, from < to ? reference.nextSibling : reference);
      description = root.innerHTML;
    }
  }

  return {
    description,
    hiddenBulletIndexes: entries.flatMap((item, index) => (item.hidden ? [index] : [])),
  };
}

export function descriptionLinesToPlainText(lines: string[]) {
  return (lines || [])
    .map((item) => stripBulletMarker(String(item || "")))
    .filter(Boolean)
    .join("\n");
}

/*
 * 要点富文本：存储是标准 HTML。每条要点内部只允许
 * <strong> <em> <u> <s> <a href> <span style="color">，其余标签一律拆掉只留文字。
 * 二级要点（缩进）在要点字符串最前面用一个私有区字符标记，写回时变成 <li data-indent="1">。
 */
export const INDENT_MARK = "\uE002";
const COLOR_RE = /^(#[0-9a-f]{3,8}|rgba?\([\d\s.,%]+\))$/i;

function escapeText(value: string) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function escapeAttr(value: string) {
  return escapeText(value).replace(/"/g, "&quot;");
}

function inlineFromNode(node: Node): string {
  let out = "";
  node.childNodes.forEach((child) => {
    if (child.nodeType === 3) { out += escapeText(child.textContent || ""); return; }
    if (child.nodeType !== 1) return;
    const el = child as HTMLElement;
    const tag = el.tagName.toLowerCase();
    if (tag === "br") { out += " "; return; }
    let inner = inlineFromNode(el);
    if (!inner) return;
    const style = el.style;
    const deco = `${style?.textDecoration || ""} ${style?.textDecorationLine || ""}`;
    const color = tag === "font" ? el.getAttribute("color") || "" : style?.color || "";
    if (color && COLOR_RE.test(color.trim())) inner = `<span style="color: ${escapeAttr(color.trim())}">${inner}</span>`;
    if (/line-through/.test(deco) || ["s", "strike", "del"].includes(tag)) inner = `<s>${inner}</s>`;
    if (/underline/.test(deco) || (tag === "u" || tag === "ins")) inner = `<u>${inner}</u>`;
    if (style?.fontStyle === "italic" || tag === "em" || tag === "i") inner = `<em>${inner}</em>`;
    const weight = style?.fontWeight || "";
    if (tag === "strong" || tag === "b" || weight === "bold" || Number.parseInt(weight, 10) >= 600) inner = `<strong>${inner}</strong>`;
    if (tag === "a") {
      const href = (el.getAttribute("href") || "").trim();
      if (/^(https?:|mailto:)/i.test(href)) inner = `<a href="${escapeAttr(href)}">${inner}</a>`;
    }
    out += inner;
  });
  return out;
}

function parseHtml(html: string): HTMLElement {
  const doc = new DOMParser().parseFromString(`<div>${html}</div>`, "text/html");
  return doc.body.firstElementChild as HTMLElement;
}

/** 任意 HTML（含 contenteditable 的产物）→ 一条要点允许的安全行内 HTML。 */
export function sanitizeInline(html: string): string {
  if (!html) return "";
  if (!/[<&]/.test(html)) return escapeText(html);
  return inlineFromNode(parseHtml(html)).replace(/<\/(strong|em|u|s)><\1>/g, "");
}

/** 去掉标签和缩进标记后的纯文字。 */
export function plainBullet(text: string): string {
  return textFromHtml((text || "").replace(INDENT_MARK, "")).replace(/\s+/g, " ").replace(/\u200b/g, "");
}

/** 和 splitBullets 一样拆要点，但保留行内格式和缩进。 */
export function splitRichBullets(value: string): string[] {
  if (!/<\s*li\b/i.test(value || "")) return splitBullets(value).map(escapeText);
  const root = parseHtml(value);
  return Array.from(root.querySelectorAll("li")).map((li) => {
    const html = sanitizeInline(li.innerHTML.replace(/<\/p>\s*<p[^>]*>/gi, " "));
    return (li.getAttribute("data-indent") === "1" ? INDENT_MARK : "") + html.trim();
  }).filter((item) => plainBullet(item).trim() || item.includes("\u200b"));
}

/** 一条要点 → <li> 的内部 HTML（已清洗）。 */
export function richBulletToHtml(text: string): string {
  return sanitizeInline((text || "").replace(INDENT_MARK, ""));
}

export function isIndented(text: string) {
  return (text || "").startsWith(INDENT_MARK);
}

export function bulletLi(text: string, keepEmpty = false) {
  const body = richBulletToHtml(text) || (keepEmpty ? "\u200b" : "");
  return `<li${isIndented(text) ? ' data-indent="1"' : ""}><p>${body}</p></li>`;
}
