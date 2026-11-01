"use client";

// 正文 / 要点的所见即所得编辑框（对齐超级简历）：contentEditable + 工具栏，改的是看到的样子，不用手敲标记。
// 存的仍是轻量标记（lib/richMarkup），预览和 PDF 由后端按同一套标记渲染；撤销 / 重做走浏览器自带的编辑历史。
import { type ClipboardEvent, type KeyboardEvent, useLayoutEffect, useRef, useState } from "react";

import { domToMarkup, markupToHtml } from "@/lib/richMarkup";

const PATH = {
  undo: "M9 14 4 9l5-5M4 9h10a6 6 0 0 1 0 12h-3",
  redo: "m15 14 5-5-5-5M20 9H10a6 6 0 0 0 0 12h3",
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
};

// [图标, 名称, execCommand 命令；link / clear 自己处理]
type Tool = [keyof typeof PATH, string, string];
const HISTORY: Tool[] = [["undo", "撤销", "undo"], ["redo", "重做", "redo"]];
const INLINE: Tool[] = [["bold", "加粗", "bold"], ["italic", "斜体", "italic"]];
const ALIGN: Tool[] = [["left", "左对齐", "justifyLeft"], ["center", "居中", "justifyCenter"], ["right", "右对齐", "justifyRight"], ["justify", "两端对齐", "justifyFull"]];
const LISTS: Tool[] = [["ul", "无序列表", "insertUnorderedList"], ["ol", "有序列表", "insertOrderedList"], ["outdent", "减少缩进", "outdent"], ["indent", "增加缩进", "indent"]];
const EXTRA: Tool[] = [["link", "插入链接", "link"], ["clear", "清除格式", "clear"]];
// 要点是一行字：只给撤销、行内格式和链接。
const FULL = [HISTORY, INLINE, ALIGN, LISTS, EXTRA];
const COMPACT = [HISTORY, INLINE, EXTRA];
const STATEFUL = ["bold", "italic", "justifyCenter", "justifyRight", "justifyFull", "insertUnorderedList", "insertOrderedList"];

const escAttr = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

export function RichText({ value, onChange, rows = 2, label, compact }: {
  value: string; onChange: (next: string) => void; rows?: number; label: string; compact?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const last = useRef<string | null>(null);
  const [on, setOn] = useState<string[]>([]);

  // 只有外面换了值（切简历、版本回退、智能改写）才重写 DOM；自己刚发出去的值不碰，光标和编辑历史都留着。
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || value === last.current) return;
    el.innerHTML = markupToHtml(value);
    last.current = value;
  }, [value]);

  const sync = () => {
    const el = ref.current;
    if (!el) return;
    const next = domToMarkup(el, compact);
    if (next === last.current) return;
    last.current = next;
    onChange(next);
  };
  const refresh = () => {
    const sel = window.getSelection();
    if (!ref.current || !sel?.anchorNode || !ref.current.contains(sel.anchorNode)) return setOn([]);
    setOn(STATEFUL.filter((c) => document.queryCommandState(c)));
  };

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
    } else {
      document.execCommand(cmd);
    }
    sync();
    refresh();
  };

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (compact && e.key === "Enter") e.preventDefault();
  };
  // 粘贴只收纯文字，别把网页 / Word 的样式带进来。
  const onPaste = (e: ClipboardEvent<HTMLDivElement>) => {
    e.preventDefault();
    const text = e.clipboardData.getData("text/plain");
    document.execCommand("insertText", false, compact ? text.replace(/\s*\n\s*/g, " ") : text);
  };

  return (
    <div className={"rt" + (compact ? " rt-compact" : "")}>
      <div className="rt-bar" role="toolbar" aria-label={label + "格式"}>
        {(compact ? COMPACT : FULL).map((group, g) => (
          <span key={g} className="rt-group">
            {group.map(([icon, name, cmd]) => (
              <button key={icon} type="button" title={name} aria-label={name} className="rt-btn"
                aria-pressed={STATEFUL.includes(cmd) ? on.includes(cmd) : undefined}
                onMouseDown={(e) => e.preventDefault()} onClick={() => run(cmd)}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d={PATH[icon]} />
                </svg>
              </button>
            ))}
          </span>
        ))}
      </div>
      <div ref={ref} role="textbox" aria-label={label} aria-multiline={!compact} contentEditable suppressContentEditableWarning
        className="rf-input rt-edit" style={{ minHeight: (compact ? 0.9 + rows * 1.6 : 1 + Math.max(rows, 6) * 1.6) + "em" }}
        onInput={sync} onBlur={sync} onKeyDown={onKey} onKeyUp={refresh} onMouseUp={refresh} onFocus={refresh} onPaste={onPaste} />
    </div>
  );
}
