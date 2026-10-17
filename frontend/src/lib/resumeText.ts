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
 * 要点里的加粗：存储仍是标准 HTML（<strong>），纸模板内部用两个私有区字符标记加粗区间，
 * 这样按纯文本拆要点、比对、编辑都不受影响，导出时再还原成 <strong>。
 */
export const BOLD_OPEN = "\uE000";
export const BOLD_CLOSE = "\uE001";

/** 去掉多余/不配对的标记和空的加粗区间。 */
export function normalizeBold(text: string): string {
  let out = "";
  let open = false;
  for (const ch of text) {
    if (ch === BOLD_OPEN) { if (!open) { out += ch; open = true; } continue; }
    if (ch === BOLD_CLOSE) { if (open) { out += ch; open = false; } continue; }
    out += ch;
  }
  if (open) out += BOLD_CLOSE;
  return out.split(BOLD_OPEN + BOLD_CLOSE).join("");
}

export function plainBullet(text: string): string {
  return text.replace(/[\uE000\uE001]/g, "");
}

/** 与 splitBullets 相同的拆分，但保留 <strong>/<b> 加粗。 */
export function splitRichBullets(value: string): string[] {
  const marked = (value || "")
    .replace(/<\s*(?:strong|b)(?:\s[^>]*)?>/gi, BOLD_OPEN)
    .replace(/<\s*\/\s*(?:strong|b)\s*>/gi, BOLD_CLOSE);
  return splitBullets(marked).map(normalizeBold);
}

function escapeText(value: string) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** 带加粗标记的要点 → 安全 HTML（只会出现 <strong>）。 */
export function richBulletToHtml(text: string): string {
  return escapeText(normalizeBold(text)).split(BOLD_OPEN).join("<strong>").split(BOLD_CLOSE).join("</strong>");
}
