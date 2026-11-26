// 邮箱网页上的小工具：找字段、写值、贴附件。只写不提交，永远不点「发送」。

/** 页面本身 + 能读到的同源 iframe（QQ 旧版的 mainFrame、163 的编辑器 iframe）。 */
export function reachableDocuments(doc: Document, depth = 2): Document[] {
  const out: Document[] = [doc];
  if (depth <= 0) return out;
  for (const frame of Array.from(doc.querySelectorAll("iframe"))) {
    let inner: Document | null = null;
    try { inner = frame.contentDocument; } catch { inner = null; }
    if (inner && inner.documentElement) out.push(...reachableDocuments(inner, depth - 1));
  }
  return out;
}

/** 在几份文档里按顺序找第一个命中的选择器。 */
export function queryFirst<T extends Element = HTMLElement>(docs: Array<Document | Element> | Document | Element, selectors: string[]): T | null {
  const roots = Array.isArray(docs) ? docs : [docs];
  for (const selector of selectors) {
    for (const root of roots) {
      let found: T | null = null;
      try { found = root.querySelector<T>(selector) as T | null; } catch { found = null; }
      if (found) return found;
    }
  }
  return null;
}

const squash = (text: string | null | undefined) => (text ?? "").replace(/[\s\u3000]+/g, "");

/** 文字等于（去掉空格后）某个词的可点元素，用来找「写信 / 写 信」按钮。 */
export function findClickableByText(root: Document | Element, words: string[]): HTMLElement | null {
  const targets = new Set(words.map(squash));
  const candidates = Array.from(root.querySelectorAll<HTMLElement>("a, button, [role=button], li, span, div"));
  for (const element of candidates) {
    if (element.children.length > 3) continue;
    if (targets.has(squash(element.textContent))) {
      return (element.closest("a, button, [role=button], li") as HTMLElement | null) ?? element;
    }
  }
  return null;
}

/**
 * 按「标签文字」找输入框：aria-label / placeholder / title 含某个词，或同一行（往上三层内）有这段标签文字。
 * 邮箱的 class 名经常是混淆过的，标签文字比 class 稳。
 */
export function findLabeledInput(root: Document | Element, labels: string[]): HTMLInputElement | null {
  const inputs = Array.from(root.querySelectorAll<HTMLInputElement>("input:not([type]), input[type=text], input[type=email], input[type=search]"));
  const hit = (text: string | null | undefined) => {
    const value = squash(text).toLowerCase();
    return Boolean(value) && labels.some((label) => value.includes(squash(label).toLowerCase()));
  };
  for (const input of inputs) {
    if (hit(input.getAttribute("aria-label")) || hit(input.placeholder) || hit(input.title)) return input;
  }
  for (const input of inputs) {
    let node: Element | null = input.parentElement;
    for (let level = 0; node && level < 3; level += 1, node = node.parentElement) {
      const own = Array.from(node.childNodes)
        .filter((child) => child !== input && !(child instanceof Element && child.contains(input)))
        .map((child) => child.textContent ?? "")
        .join(" ");
      if (hit(node.getAttribute("aria-label")) || (own.length < 20 && hit(own))) return input;
    }
  }
  return null;
}

/** 受控输入框也认的写法：原型链原生 setter + input / change，再失焦让收件人变成「胶囊」。 */
export function setInputValue(input: HTMLInputElement | HTMLTextAreaElement, value: string): boolean {
  input.focus();
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")?.set;
  if (setter) setter.call(input, value);
  else input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
  input.dispatchEvent(new FocusEvent("blur"));
  input.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
  return input.value === value;
}

const escapeHtml = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** 富文本正文：一行一个 <div>，空行用 <br>；写完回读文字。 */
export function setEditableText(editable: HTMLElement, text: string): boolean {
  editable.focus();
  editable.innerHTML = text
    .split("\n")
    .map((line) => `<div>${line ? escapeHtml(line) : "<br>"}</div>`)
    .join("");
  editable.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
  const first = text.split("\n").find((line) => line.trim()) ?? "";
  return !first || (editable.textContent ?? "").includes(first.trim());
}

/** 正文已经有这段了（Gmail 的 URL 预填）就不重复写。 */
export function editableHas(editable: HTMLElement, text: string): boolean {
  const first = text.split("\n").find((line) => line.trim())?.trim();
  return Boolean(first) && squash(editable.textContent).includes(squash(first));
}

export type FileListFactory = (files: File[]) => FileList;

export const defaultFileList: FileListFactory = (files) => {
  const transfer = new DataTransfer();
  for (const file of files) transfer.items.add(file);
  return transfer.files;
};

/** 附件：把 File 放进写信页的 <input type=file>，再发 change，等同用户自己选了文件。 */
export function attachToInput(input: HTMLInputElement, file: File, makeList: FileListFactory = defaultFileList): boolean {
  const list = makeList([file]);
  try {
    input.files = list;
  } catch {
    Object.defineProperty(input, "files", { value: list, configurable: true });
  }
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
  return input.files?.[0]?.name === file.name;
}

/** 没有文件框时的退路：把文件「拖」进写信区（Gmail 支持拖放附件）。 */
export function dropFileOn(target: HTMLElement, file: File, makeList: FileListFactory = defaultFileList): boolean {
  const files = makeList([file]);
  const transfer = { files, types: ["Files"], items: [], dropEffect: "copy", effectAllowed: "all", getData: () => "" };
  for (const type of ["dragenter", "dragover", "drop"]) {
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(event, "dataTransfer", { value: transfer });
    target.dispatchEvent(event);
  }
  return true;
}

/** 选第一个能收文档的文件框（跳过只收图片的「插入图片」）。 */
export function pickFileInput(roots: Array<Document | Element>, preferred: string[] = []): HTMLInputElement | null {
  const first = queryFirst<HTMLInputElement>(roots, preferred);
  if (first) return first;
  for (const root of roots) {
    for (const input of Array.from(root.querySelectorAll<HTMLInputElement>("input[type=file]"))) {
      const accept = (input.accept || "").toLowerCase();
      if (accept && !/pdf|\*|application/.test(accept)) continue;
      return input;
    }
  }
  return null;
}

/** 正文文字（去掉脚本、样式），保留段落换行。 */
export function readableText(element: Element | null): string {
  if (!element) return "";
  const clone = element.cloneNode(true) as Element;
  clone.querySelectorAll("script, style, noscript").forEach((node) => node.remove());
  clone.querySelectorAll("br").forEach((node) => node.replaceWith("\n"));
  clone.querySelectorAll("p, div, li, tr, h1, h2, h3").forEach((node) => node.append("\n"));
  return (clone.textContent ?? "").replace(/[ \t\u00a0]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

export function linksIn(element: Element | null): string[] {
  if (!element) return [];
  return Array.from(element.querySelectorAll<HTMLAnchorElement>("a[href]"))
    .map((anchor) => anchor.getAttribute("href") ?? "")
    .filter((href) => /^https?:\/\//i.test(href));
}

/** 写信正文：先试选择器，再找可编辑区（含同源 iframe 编辑器的 body）。 */
export function findEditable(root: Document | Element, selectors: string[] = []): HTMLElement | null {
  const direct = queryFirst<HTMLElement>(root, [...selectors, "[contenteditable=true]", "[contenteditable=\"\"]", "textarea"]);
  if (direct) return direct;
  for (const frame of Array.from(root.querySelectorAll("iframe"))) {
    let inner: Document | null = null;
    try { inner = frame.contentDocument; } catch { inner = null; }
    const body = inner?.body;
    if (body && (body.isContentEditable || body.getAttribute("contenteditable") === "true" || inner?.designMode === "on")) return body;
  }
  return null;
}

/** 收件人已经在了（Gmail 的地址胶囊、输入框里的值、或页面文字）。 */
export function recipientPresent(root: Document | Element, address: string, input: HTMLInputElement | HTMLTextAreaElement | null): boolean {
  const lower = address.toLowerCase();
  if (input && input.value.toLowerCase().includes(lower)) return true;
  const scope = root instanceof Document ? root.body : root;
  if (!scope) return false;
  const quoted = address.replace(/["\\]/g, "\\$&");
  if (scope.querySelector(`[email="${quoted}"], [data-hovercard-id="${quoted}"]`)) return true;
  return Array.from(scope.querySelectorAll("input")).some((item) => item.type !== "file" && item.value.toLowerCase().includes(lower));
}

/** 写信表单的范围：从标题框往上找，第一个同时装着正文编辑区（或编辑器 iframe）的祖先。 */
export function composeRoot(subject: Element, preferred: string[] = []): Element | Document {
  for (const selector of preferred) {
    const hit = subject.closest(selector);
    if (hit) return hit;
  }
  let node: Element | null = subject.parentElement;
  for (let level = 0; node && level < 10; level += 1, node = node.parentElement) {
    if (node.querySelector("[contenteditable=true], iframe, textarea")) return node;
  }
  return subject.ownerDocument;
}
