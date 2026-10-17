import { sanitizeInline } from "./resumeText";

/**
 * 行内格式的唯一实现（不用 document.execCommand）：
 * 把一段清洗过的行内 HTML 拆成「文字 + 格式」的片段，按字符区间改格式，再拼回 HTML。
 * 选区一律用「宿主里的字符偏移」表示，DOM 被重写后也能精确还原。
 */
export type Mark = "strong" | "em" | "u" | "s";
export interface Run { text: string; strong?: boolean; em?: boolean; u?: boolean; s?: boolean; color?: string; href?: string }
export type FormatOp = { mark: Mark; on: boolean } | { color: string | null } | { href: string | null };

const MARKS: Mark[] = ["strong", "em", "u", "s"];

export function parseRuns(html: string): Run[] {
  const root = new DOMParser().parseFromString(`<div>${sanitizeInline(html)}</div>`, "text/html").body.firstElementChild as HTMLElement;
  const runs: Run[] = [];
  const walk = (node: Node, format: Omit<Run, "text">) => {
    node.childNodes.forEach((child) => {
      if (child.nodeType === 3) { if (child.textContent) runs.push({ ...format, text: child.textContent }); return; }
      if (child.nodeType !== 1) return;
      const el = child as HTMLElement;
      const tag = el.tagName.toLowerCase();
      const next = { ...format };
      if ((MARKS as string[]).includes(tag)) next[tag as Mark] = true;
      if (tag === "span" && el.style.color) next.color = el.style.color;
      if (tag === "a") next.href = el.getAttribute("href") || undefined;
      walk(el, next);
    });
  };
  walk(root, {});
  return runs;
}

function escapeText(value: string) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function sameFormat(a: Run, b: Run) {
  return MARKS.every((mark) => Boolean(a[mark]) === Boolean(b[mark])) && a.color === b.color && a.href === b.href;
}

export function serializeRuns(runs: Run[]): string {
  const merged: Run[] = [];
  for (const run of runs) {
    const last = merged[merged.length - 1];
    if (last && sameFormat(last, run)) last.text += run.text;
    else if (run.text) merged.push({ ...run });
  }
  return merged.map((run) => {
    let html = escapeText(run.text);
    if (run.color) html = `<span style="color: ${run.color.replace(/"/g, "")}">${html}</span>`;
    if (run.s) html = `<s>${html}</s>`;
    if (run.u) html = `<u>${html}</u>`;
    if (run.em) html = `<em>${html}</em>`;
    if (run.strong) html = `<strong>${html}</strong>`;
    if (run.href) html = `<a href="${run.href.replace(/"/g, "%22")}">${html}</a>`;
    return html;
  }).join("");
}

/** 在 [start, end) 处切开片段，返回区间内片段的下标范围。 */
function split(runs: Run[], start: number, end: number) {
  const out: Run[] = [];
  let pos = 0; let from = -1; let to = -1;
  for (const run of runs) {
    const runEnd = pos + run.text.length;
    const cuts = [start, end].filter((cut) => cut > pos && cut < runEnd).map((cut) => cut - pos);
    let offset = 0;
    for (const cut of [...cuts, run.text.length]) {
      const piece = { ...run, text: run.text.slice(offset, cut) };
      const pieceStart = pos + offset;
      if (pieceStart >= start && pieceStart < end) { if (from < 0) from = out.length; to = out.length + 1; }
      out.push(piece); offset = cut;
    }
    pos = runEnd;
  }
  return { runs: out, from, to };
}

export function applyFormat(runs: Run[], start: number, end: number, op: FormatOp): Run[] {
  const parts = split(runs, start, end);
  if (parts.from < 0) return runs;
  return parts.runs.map((run, index) => {
    if (index < parts.from || index >= parts.to) return run;
    const next = { ...run };
    if ("mark" in op) { if (op.on) next[op.mark] = true; else delete next[op.mark]; }
    else if ("color" in op) { if (op.color) next.color = op.color; else delete next.color; }
    else if (op.href) next.href = op.href; else delete next.href;
    return next;
  });
}

/** 区间内每个字都有这个格式才算「已开启」（再点一次就是取消）。 */
export function hasMark(runs: Run[], start: number, end: number, mark: Mark) {
  const parts = split(runs, start, end);
  if (parts.from < 0) return false;
  return parts.runs.slice(parts.from, parts.to).every((run) => run[mark]);
}

export function textOffset(host: HTMLElement, node: Node, offset: number) {
  const range = document.createRange();
  range.selectNodeContents(host);
  range.setEnd(node, offset);
  return range.toString().length;
}

export function selectionOffsets(host: HTMLElement) {
  const selection = window.getSelection();
  if (!selection?.rangeCount) return null;
  const range = selection.getRangeAt(0);
  if (!host.contains(range.startContainer) || !host.contains(range.endContainer)) return null;
  return { start: textOffset(host, range.startContainer, range.startOffset), end: textOffset(host, range.endContainer, range.endOffset) };
}

export function selectOffsets(host: HTMLElement, start: number, end: number) {
  const range = document.createRange();
  const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
  let seen = 0; let node: Node | null; let started = false;
  range.selectNodeContents(host);
  range.collapse(false);
  while ((node = walker.nextNode())) {
    const length = node.textContent?.length || 0;
    if (!started && start <= seen + length) { range.setStart(node, start - seen); started = true; }
    if (started && end <= seen + length) { range.setEnd(node, end - seen); break; }
    seen += length;
  }
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

/** 改宿主里一段文字的格式，保持选区，并通知宿主立即提交（成为一步可撤销的修改）。 */
export function formatHost(host: HTMLElement, start: number, end: number, op: FormatOp) {
  if (end <= start) return;
  host.innerHTML = serializeRuns(applyFormat(parseRuns(host.innerHTML), start, end, op));
  host.focus();
  selectOffsets(host, start, end);
  host.dispatchEvent(new Event("paper-commit"));
}

export function toggleMark(host: HTMLElement, start: number, end: number, mark: Mark) {
  formatHost(host, start, end, { mark, on: !hasMark(parseRuns(host.innerHTML), start, end, mark) });
}

/** 在光标处插入纯文字（粘贴用）。 */
export function insertPlainText(host: HTMLElement, text: string) {
  const offsets = selectionOffsets(host);
  if (!offsets) return;
  const runs = parseRuns(host.innerHTML);
  const parts = split(runs, offsets.start, offsets.end);
  let pos = 0; const out: Run[] = []; let inserted = false;
  for (const run of parts.runs) {
    const runStart = pos; pos += run.text.length;
    if (runStart >= offsets.start && pos <= offsets.end && offsets.end > offsets.start) {
      if (!inserted) { out.push({ ...run, text }); inserted = true; }
      continue;
    }
    if (!inserted && runStart >= offsets.start) { out.push({ ...(out[out.length - 1] || {}), text }); inserted = true; }
    out.push(run);
  }
  if (!inserted) out.push({ ...(out[out.length - 1] || {}), text });
  host.innerHTML = serializeRuns(out);
  const caret = offsets.start + text.length;
  selectOffsets(host, caret, caret);
}
