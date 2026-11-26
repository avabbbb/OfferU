// 邮箱网页上的 OfferU 浮层：写信页的「已填好」卡片、读信页的「交给 OfferU」胶囊。
// 挂在 all: initial 的 Shadow DOM 宿主上，不往邮箱 DOM 插节点；v3 Glass：磨砂纸面 + 墨黑胶囊主按钮，一次只有一个主操作。
// Shadow DOM 读不到网页版的 --ou-* Token，这里在 :host 上照 design-tokens.css 抄一份（和 smartfill 浮层同一套）。
import { FIELD_LABEL, type FillReport } from "./compose.js";

const HOST_ID = "offeru-mail-overlay";

const STYLE = `
  :host {
    all: initial;
    --ink: #231d19; --text-2: #69625d; --text-3: #827a75;
    --glass: rgba(255,255,255,.92); --field: rgba(60,50,80,.05);
    --capsule-shadow: 0 1px 2px rgba(60,50,80,.06), 0 4px 12px rgba(60,50,80,.07);
    --elev-3: 0 0 0 .5px rgba(60,50,80,.08), 0 12px 32px rgba(60,50,80,.16);
    --green-bg: #e5f5e8; --green-text: #2e693e;
    --yellow-bg: #fff3d6; --yellow-text: #7a5512;
    --red-bg: #ffe8e5; --red-text: #953734;
    --fast: 120ms; --base: 200ms; --glide: 300ms;
    --ease: cubic-bezier(.2,0,0,1); --spring: cubic-bezier(.2,.9,.25,1.2);
    --font: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
  }
  @media (prefers-reduced-motion: reduce) { :host { --fast: 0ms; --base: 0ms; --glide: 0ms; } }
  .card, .pill {
    position: fixed; right: 20px; bottom: 20px; box-sizing: border-box;
    background: var(--glass); -webkit-backdrop-filter: blur(24px) saturate(170%); backdrop-filter: blur(24px) saturate(170%);
    box-shadow: inset 0 1px 0 rgba(255,255,255,.7), var(--elev-3);
    color: var(--ink); font: 13px/1.5 var(--font);
    animation: rise var(--glide) var(--spring);
  }
  .card { width: min(340px, calc(100vw - 32px)); padding: 16px; border-radius: 20px; display: flex; flex-direction: column; gap: 10px; }
  .title { font-weight: 600; font-size: 14px; display: flex; align-items: center; gap: 8px; }
  .lead { color: var(--text-2); margin: 0; }
  ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
  li { display: flex; gap: 8px; align-items: baseline; }
  .tag { flex: none; padding: 1px 8px; border-radius: 999px; font-size: 11px; font-weight: 600; }
  .tag.ok { background: var(--green-bg); color: var(--green-text); }
  .tag.warn { background: var(--yellow-bg); color: var(--yellow-text); }
  .tag.bad { background: var(--red-bg); color: var(--red-text); }
  .note { color: var(--text-3); font-size: 12px; overflow-wrap: anywhere; }
  .actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 6px; }
  button {
    font: inherit; font-weight: 600; border: 0; border-radius: 999px; padding: 7px 14px; cursor: pointer;
    background: transparent; color: var(--text-2);
    transition: background-color var(--fast) var(--ease), box-shadow var(--fast) var(--ease), transform var(--fast) var(--ease);
  }
  button:hover:not(:disabled) { background: #fff; color: var(--ink); box-shadow: var(--capsule-shadow); }
  button:active:not(:disabled) { transform: scale(.97); }
  button:focus-visible { outline: 2px solid var(--ink); outline-offset: 2px; }
  button.primary { background: var(--ink); color: #fff; }
  button.primary:hover:not(:disabled) { background: #000; color: #fff; }
  button:disabled { opacity: .5; cursor: default; }
  .pill { display: flex; align-items: center; gap: 4px; padding: 5px; border-radius: 999px; }
  .pill .hint { padding: 0 6px 0 10px; color: var(--text-2); font-size: 12px; white-space: nowrap; }
  @keyframes rise { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }
`;

export interface ComposeOverlayView {
  provider: string;
  report: FillReport | null;
  /** 没找到写信页时的说明（如「先登录」）。 */
  message?: string;
  onCopy: () => Promise<boolean>;
  onDownload?: () => void;
}

function el<K extends keyof HTMLElementTagNameMap>(doc: Document, tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export class MailOverlay {
  private root: ShadowRoot | null = null;
  private host: HTMLElement | null = null;

  constructor(private readonly doc: Document = document) {}

  private mount(): ShadowRoot {
    if (this.root && this.host?.isConnected) return this.root;
    const host = this.doc.createElement("div");
    host.id = HOST_ID;
    host.style.cssText = "all: initial; position: fixed; z-index: 2147483647; right: 0; bottom: 0;";
    const root = host.attachShadow({ mode: "open" });
    const style = this.doc.createElement("style");
    style.textContent = STYLE;
    root.appendChild(style);
    (this.doc.body ?? this.doc.documentElement).appendChild(host);
    this.host = host;
    this.root = root;
    return root;
  }

  private replace(node: HTMLElement): void {
    const root = this.mount();
    root.querySelectorAll(".card, .pill").forEach((item) => item.remove());
    root.appendChild(node);
  }

  close(): void {
    this.host?.remove();
    this.host = null;
    this.root = null;
  }

  /** 写信页的结果卡：逐项状态 + 「由你点发送」；有没填上的，主操作是「复制没填上的」。 */
  showCompose(view: ComposeOverlayView): HTMLElement {
    const doc = this.doc;
    const card = el(doc, "section", "card");
    card.setAttribute("role", "status");
    card.setAttribute("aria-label", "OfferU 写信助手");
    const failed = view.report ? view.report.steps.filter((step) => !step.ok) : [];
    const heading = !view.report ? "还没找到写信页" : failed.length ? "草稿填好了一部分" : "草稿已填好";
    card.appendChild(el(doc, "div", "title", `OfferU · ${heading}`));
    if (view.message) card.appendChild(el(doc, "p", "lead", view.message));
    if (view.report) {
      const list = el(doc, "ul");
      for (const step of view.report.steps) {
        const item = el(doc, "li");
        const warn = step.ok && step.field === "attachment" && !step.note?.startsWith("已附上");
        item.appendChild(el(doc, "span", `tag ${step.ok ? (warn ? "warn" : "ok") : "bad"}`, `${FIELD_LABEL[step.field]} ${step.ok ? (warn ? "请确认" : "已填") : "没填上"}`));
        if (step.note) item.appendChild(el(doc, "span", "note", step.note));
        list.appendChild(item);
      }
      card.appendChild(list);
      card.appendChild(el(doc, "p", "lead", `检查无误后，请你自己在${view.provider}里点「发送」。OfferU 不会替你发送。`));
    }
    const actions = el(doc, "div", "actions");
    const close = el(doc, "button", "", "关闭");
    close.type = "button";
    close.addEventListener("click", () => this.close());
    actions.appendChild(close);
    const attachmentFailed = failed.some((step) => step.field === "attachment");
    if (view.onDownload) {
      const download = el(doc, "button", attachmentFailed && failed.length === 1 ? "primary" : "", "下载简历 PDF");
      download.type = "button";
      download.addEventListener("click", () => view.onDownload?.());
      actions.appendChild(download);
    }
    if (!view.report || failed.some((step) => step.field !== "attachment")) {
      const copy = el(doc, "button", "primary", view.report ? "复制没填上的内容" : "复制邮件内容");
      copy.type = "button";
      copy.dataset.role = "copy";
      copy.addEventListener("click", () => {
        void view.onCopy().then((ok) => { copy.textContent = ok ? "已复制，粘贴进邮件即可" : "复制失败，请手动复制"; });
      });
      actions.appendChild(copy);
    }
    card.appendChild(actions);
    this.replace(card);
    return card;
  }

  /** 读信页：「交给 OfferU」胶囊。 */
  showHandoff(onHandoff: () => Promise<string>): HTMLElement {
    const doc = this.doc;
    const pill = el(doc, "div", "pill");
    const hint = el(doc, "span", "hint", "这封是邀约？");
    const button = el(doc, "button", "primary", "交给 OfferU");
    button.type = "button";
    button.dataset.role = "handoff";
    button.addEventListener("click", () => {
      button.disabled = true;
      button.textContent = "正在交给 OfferU…";
      void onHandoff().then((result) => {
        hint.textContent = result;
        button.textContent = "交给 OfferU";
        button.disabled = false;
      });
    });
    pill.append(hint, button);
    this.replace(pill);
    return pill;
  }

  hasHandoff(): boolean {
    return Boolean(this.root?.querySelector(".pill"));
  }
}

/** 复制到剪贴板：先 Clipboard API，不行再 execCommand（扩展有 clipboardWrite 权限）。 */
export async function copyText(text: string, doc: Document = document): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = doc.createElement("textarea");
    area.value = text;
    area.style.cssText = "position:fixed;left:-9999px;top:0";
    doc.body.appendChild(area);
    area.select();
    let ok = false;
    try { ok = doc.execCommand("copy"); } catch { ok = false; }
    area.remove();
    return ok;
  }
}
