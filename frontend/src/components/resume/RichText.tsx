"use client";

// 正文 / 要点的块式编辑框（参照飞书文档）：平时就是一块干净的输入区，格式按需出现——
//   选中文字 → 上方浮出格式条（文本类型 ▾ · 对齐 ▾ | 加粗 斜体 | 链接 | 清除格式）；
//   输入 / 或中文输入法的 、 → 光标下弹出块菜单（正文、列表、对齐、缩进），可继续打字筛选（支持拼音首字母）；
//   行首打 "- " / "1. " 直接变列表，Tab / Shift+Tab 缩进；右上角「放大」在大弹窗里编辑同一份内容。
// 存的仍是轻量标记（lib/richMarkup），预览和 PDF 由后端按同一套标记渲染；撤销 / 重做走浏览器自带的编辑历史（⌘Z / ⇧⌘Z）。
import { type ClipboardEvent, type FormEvent, type KeyboardEvent, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import { Button, Dialog, Floating } from "@/components/ui";
import { domToMarkup, markupToHtml } from "@/lib/richMarkup";

const PATH = {
  text: "M5 6V4h14v2M12 4v16M9 20h6",
  bold: "M7 5h6a3.5 3.5 0 0 1 0 7H7zM7 12h7a3.5 3.5 0 0 1 0 7H7z",
  italic: "M19 4h-9M14 20H5M15 4 9 20",
  left: "M4 6h16M4 10h10M4 14h16M4 18h10",
  center: "M4 6h16M7 10h10M4 14h16M7 18h10",
  right: "M4 6h16M10 10h10M4 14h16M10 18h10",
  justify: "M4 6h16M4 10h16M4 14h16M4 18h16",
  ul: "M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01",
  ol: "M10 6h10M10 12h10M10 18h10M4 6h1v4M4 10h2M6 18H4c0-1 2-2 2-3s-1-1.5-2-1",
  indent: "M3 8l4 4-4 4M10 6h11M10 12h11M10 18h11",
  outdent: "M7 8l-4 4 4 4M10 6h11M10 12h11M10 18h11",
  link: "M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7",
  clear: "M4 7V4h16v3M12 4v9M9 20h6M3 3l18 18",
  expand: "M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7",
  chevron: "m6 9 6 6 6-6",
};
type Icon = keyof typeof PATH;

function Svg({ icon }: { icon: Icon }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={PATH[icon]} />
    </svg>
  );
}

// 块类型 / 对齐：名称、命令、筛选关键词（拼音首字母 + 英文）。"paragraph" 是取消列表。
type Block = { icon: Icon; name: string; cmd: string; keys: string };
const TYPES: Block[] = [
  { icon: "text", name: "正文", cmd: "paragraph", keys: "zw zhengwen text p" },
  { icon: "ul", name: "无序列表", cmd: "insertUnorderedList", keys: "wxlb wuxu liebiao list ul -" },
  { icon: "ol", name: "有序列表", cmd: "insertOrderedList", keys: "yxlb youxu liebiao number ol 1" },
];
const ALIGNS: Block[] = [
  { icon: "left", name: "左对齐", cmd: "justifyLeft", keys: "zdq zuo duiqi left" },
  { icon: "center", name: "居中", cmd: "justifyCenter", keys: "jz juzhong center" },
  { icon: "right", name: "右对齐", cmd: "justifyRight", keys: "ydq you duiqi right" },
  { icon: "justify", name: "两端对齐", cmd: "justifyFull", keys: "lddq liangduan justify" },
];
const INDENTS: Block[] = [
  { icon: "indent", name: "增加缩进", cmd: "indent", keys: "sj zjsj suojin indent tab" },
  { icon: "outdent", name: "减少缩进", cmd: "outdent", keys: "jssj suojin outdent" },
];
const SLASH = [...TYPES, ...ALIGNS, ...INDENTS];
const STATEFUL = ["bold", "italic", "insertUnorderedList", "insertOrderedList", "justifyCenter", "justifyRight", "justifyFull"];
const SLASH_KEYS = new Set(["/", "、", "／"]);

const escAttr = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
const matches = (b: Block, q: string) => !q || b.name.includes(q) || b.keys.split(" ").some((k) => k.startsWith(q.toLowerCase()));

function caret(): { node: Node; offset: number; rect: DOMRect } | null {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount || !sel.isCollapsed) return null;
  const r = sel.getRangeAt(0);
  let rect = r.getBoundingClientRect();
  // 空行的折叠选区量不出位置，退回到所在元素。
  if (!rect.width && !rect.height && r.startContainer instanceof Element) rect = r.startContainer.getBoundingClientRect();
  return { node: r.startContainer, offset: r.startOffset, rect };
}

// 选中 [node:from, 光标) 这一段再删掉，走 execCommand 保留撤销历史。
function deleteBack(node: Node, from: number) {
  const sel = window.getSelection();
  if (!sel?.rangeCount) return;
  const end = sel.getRangeAt(0);
  const r = document.createRange();
  r.setStart(node, from);
  r.setEnd(end.startContainer, end.startOffset);
  sel.removeAllRanges();
  sel.addRange(r);
  document.execCommand("delete");
}

function caretToEnd(el: HTMLElement) {
  el.focus();
  const r = document.createRange();
  r.selectNodeContents(el);
  r.collapse(false);
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(r);
}

function atEdge(el: HTMLElement, end: boolean) {
  const sel = window.getSelection();
  if (!sel?.rangeCount || !sel.isCollapsed) return false;
  const r = document.createRange();
  r.selectNodeContents(el);
  const cur = sel.getRangeAt(0);
  if (end) r.setStart(cur.endContainer, cur.endOffset);
  else r.setEnd(cur.startContainer, cur.startOffset);
  return r.toString().length === 0;
}

export type BlockKeys = {
  onEnter?: () => void; // 要点：回车在下面新建一块
  onRemove?: () => void; // 要点：空块里退格删掉这块
  onPrev?: () => void; // 光标在开头按 ↑
  onNext?: () => void; // 光标在结尾按 ↓
};

export function RichText({ value, onChange, rows = 2, label, compact, zoomable = !compact, focusSignal, placeholder, keys }: {
  value: string; onChange: (next: string) => void; rows?: number; label: string; compact?: boolean;
  zoomable?: boolean; focusSignal?: number; placeholder?: string; keys?: BlockKeys;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const last = useRef<string | null>(null);
  const [on, setOn] = useState<string[]>([]);
  const [bubble, setBubble] = useState<DOMRect | null>(null);
  const [sub, setSub] = useState<"" | "type" | "align">("");
  const [slash, setSlash] = useState<{ node: Node; at: number; query: string; rect: DOMRect; active: number } | null>(null);
  const [zoom, setZoom] = useState(false);

  // 只有外面换了值（切简历、版本回退、智能改写、放大框里改了）才重写 DOM；自己刚发出去的值不碰，光标和编辑历史都留着。
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || value === last.current) return;
    el.innerHTML = markupToHtml(value);
    last.current = value;
  }, [value]);

  useEffect(() => {
    if (!focusSignal) return;
    // 等弹窗自己的初始聚焦做完再把光标放进来。
    const id = requestAnimationFrame(() => { if (ref.current) caretToEnd(ref.current); });
    return () => cancelAnimationFrame(id);
  }, [focusSignal]);

  const sync = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const next = domToMarkup(el, compact);
    if (next === last.current) return;
    last.current = next;
    onChange(next);
  }, [compact, onChange]);

  // 选区变了：有选中文字就浮出格式条，并刷新按钮的按下状态。
  useEffect(() => {
    const onSel = () => {
      const el = ref.current;
      const sel = window.getSelection();
      if (!el || !sel?.rangeCount || !el.contains(sel.anchorNode)) { setBubble(null); setSub(""); return; }
      setOn(STATEFUL.filter((c) => document.queryCommandState(c)));
      if (sel.isCollapsed || !sel.toString().trim()) { setBubble(null); setSub(""); return; }
      setBubble(sel.getRangeAt(0).getBoundingClientRect());
    };
    document.addEventListener("selectionchange", onSel);
    return () => document.removeEventListener("selectionchange", onSel);
  }, []);

  const run = (cmd: string) => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    if (cmd === "link") {
      const url = window.prompt("链接地址", "https://")?.trim() ?? "";
      if (!/^https?:\/\/\S+$/.test(url) || url === "https://") return;
      if (window.getSelection()?.isCollapsed) document.execCommand("insertHTML", false, '<a href="' + escAttr(url) + '">' + escAttr(url) + "</a>");
      else document.execCommand("createLink", false, url);
    } else if (cmd === "clear") {
      document.execCommand("removeFormat");
      document.execCommand("unlink");
    } else if (cmd === "paragraph") {
      for (const list of ["insertUnorderedList", "insertOrderedList"]) if (document.queryCommandState(list)) document.execCommand(list);
    } else {
      document.execCommand(cmd);
    }
    setSub("");
    sync();
    setOn(STATEFUL.filter((c) => document.queryCommandState(c)));
  };

  const options = slash ? SLASH.filter((b) => matches(b, slash.query)) : [];
  const pick = (b: Block) => {
    if (!slash) return;
    deleteBack(slash.node, slash.at);
    setSlash(null);
    run(b.cmd);
  };

  const onInput = (e: FormEvent<HTMLDivElement>) => {
    const data = (e.nativeEvent as InputEvent).data ?? "";
    const c = caret();
    if (!compact && c && c.node.nodeType === Node.TEXT_NODE) {
      const before = (c.node.textContent ?? "").slice(0, c.offset);
      // 行首 markdown：「- 」「* 」→ 无序，「1. 」「1、」→ 有序。
      if (/\s$/.test(data) && !document.queryCommandState("insertUnorderedList") && !document.queryCommandState("insertOrderedList")) {
        const list = /^[-*·•][\s\u00a0]$/.test(before) ? "insertUnorderedList" : /^1[.、．][\s\u00a0]$/.test(before) ? "insertOrderedList" : "";
        const first = !c.node.previousSibling || c.node.previousSibling.nodeName === "BR";
        if (list && first) {
          deleteBack(c.node, 0);
          document.execCommand(list);
          setSlash(null);
          sync();
          return;
        }
      }
      if (SLASH_KEYS.has(data.slice(-1))) {
        setSlash({ node: c.node, at: c.offset - 1, query: "", rect: c.rect, active: 0 });
      } else if (slash) {
        const query = c.node === slash.node && c.offset > slash.at ? (c.node.textContent ?? "").slice(slash.at + 1, c.offset) : null;
        const char = (c.node.textContent ?? "")[slash.at];
        if (query === null || !SLASH_KEYS.has(char) || /\s/.test(query) || !SLASH.some((b) => matches(b, query))) setSlash(null);
        else setSlash({ ...slash, query, rect: c.rect, active: 0 });
      }
    }
    sync();
  };

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const el = ref.current;
    if (!el || e.nativeEvent.isComposing) return;
    if (slash && options.length) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const step = e.key === "ArrowDown" ? 1 : -1;
        setSlash({ ...slash, active: (slash.active + step + options.length) % options.length });
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); pick(options[Math.min(slash.active, options.length - 1)]); return; }
      if (e.key === "Escape") { e.preventDefault(); setSlash(null); return; }
    }
    if (e.key === "Escape" && bubble) { setBubble(null); return; }
    if (compact) {
      if (e.key === "Enter") { e.preventDefault(); keys?.onEnter?.(); return; }
      if (e.key === "Backspace" && !el.textContent && keys?.onRemove) { e.preventDefault(); keys.onRemove(); return; }
    } else if (e.key === "Tab") {
      e.preventDefault();
      run(e.shiftKey ? "outdent" : "indent");
      return;
    }
    if (e.key === "ArrowUp" && keys?.onPrev && atEdge(el, false)) { e.preventDefault(); keys.onPrev(); }
    if (e.key === "ArrowDown" && keys?.onNext && atEdge(el, true)) { e.preventDefault(); keys.onNext(); }
  };

  // 粘贴只收纯文字，别把网页 / Word 的样式带进来。
  const onPaste = (e: ClipboardEvent<HTMLDivElement>) => {
    e.preventDefault();
    const text = e.clipboardData.getData("text/plain");
    document.execCommand("insertText", false, compact ? text.replace(/\s*\n\s*/g, " ") : text);
  };

  const btn = (icon: Icon, name: string, cmd: string, pressed?: boolean) => (
    <button key={icon} type="button" title={name} aria-label={name} className="rt-btn" aria-pressed={pressed} onClick={() => run(cmd)}>
      <Svg icon={icon} />
    </button>
  );
  const typeNow = TYPES.find((t) => on.includes(t.cmd)) ?? TYPES[0];
  const alignNow = ALIGNS.find((a) => on.includes(a.cmd)) ?? ALIGNS[0];
  const drop = (which: "type" | "align", now: Block, title: string) => (
    <button type="button" className="rt-btn rt-drop" title={title} aria-label={title + "：" + now.name} aria-expanded={sub === which}
      onClick={() => setSub(sub === which ? "" : which)}>
      <Svg icon={now.icon} /><span className="rt-chevron"><Svg icon="chevron" /></span>
    </button>
  );
  const list = (items: Block[], now: Block) => (
    <div className="rt-sub" role="listbox" aria-label="选择">
      {items.map((b) => (
        <button key={b.cmd} type="button" role="option" aria-selected={b === now} className="rt-option" onClick={() => run(b.cmd)}>
          <Svg icon={b.icon} /><span>{b.name}</span>
        </button>
      ))}
    </div>
  );

  return (
    <div className={"rt" + (compact ? " rt-compact" : "")}>
      <div ref={ref} role="textbox" aria-label={label} aria-multiline={!compact} contentEditable suppressContentEditableWarning
        data-placeholder={placeholder ?? (compact ? "写一条要点，回车新建下一条" : "写几句，输入 / 或 、 选择格式")}
        className="rf-input rt-edit" style={{ minHeight: (compact ? 1.6 : rows * 1.6) + 0.25 + "em" }}
        onInput={onInput} onBlur={() => { sync(); setSlash(null); }} onKeyDown={onKey} onPaste={onPaste} />
      {zoomable && (
        <button type="button" className="rt-zoom-btn" title="放大编辑" aria-label={"放大编辑" + label}
          onMouseDown={(e) => e.preventDefault()} onClick={() => { sync(); setZoom(true); }}>
          <Svg icon="expand" />
        </button>
      )}

      <Floating open={!!bubble && !slash} rect={bubble} onClose={() => { setBubble(null); setSub(""); }} label={label + "格式"} className="rt-bubble">
        <div className="rt-bar" role="toolbar" aria-label={label + "格式"}>
          {!compact && <span className="rt-group">{drop("type", typeNow, "文本类型")}{drop("align", alignNow, "对齐")}</span>}
          <span className="rt-group">{btn("bold", "加粗 ⌘B", "bold", on.includes("bold"))}{btn("italic", "斜体 ⌘I", "italic", on.includes("italic"))}</span>
          <span className="rt-group">{btn("link", "链接", "link")}{btn("clear", "清除格式", "clear")}</span>
        </div>
        {sub === "type" && list(TYPES, typeNow)}
        {sub === "align" && list(ALIGNS, alignNow)}
      </Floating>

      <Floating open={!!slash && options.length > 0} rect={slash?.rect ?? null} side="bottom" align="start" onClose={() => setSlash(null)}
        label="插入格式" className="rt-slash">
        <div role="listbox" aria-label="插入格式">
          {options.map((b, i) => (
            <button key={b.cmd} type="button" role="option" aria-selected={i === slash?.active} className="rt-option" onClick={() => pick(b)}>
              <Svg icon={b.icon} /><span>{b.name}</span>
            </button>
          ))}
        </div>
      </Floating>

      {zoomable && (
        <Dialog open={zoom} onOpenChange={setZoom} title={label} className="rt-zoom"
          footer={<Button variant="primary" onClick={() => setZoom(false)}>完成</Button>}>
          <RichText value={value} onChange={onChange} rows={14} label={label} zoomable={false} focusSignal={zoom ? 1 : 0} placeholder={placeholder} />
        </Dialog>
      )}
    </div>
  );
}
