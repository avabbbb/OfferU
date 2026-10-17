"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { formatHost, hasMark, parseRuns, textOffset, toggleMark, type Mark } from "@/lib/richFormat";

/**
 * 选中纸上文字时浮出的格式工具栏（参考飞书划词工具栏）。
 * 常用：加粗 / 斜体 / 下划线 / 文字颜色 / 序号；其余收进「…」：删除线、缩进、链接。
 * 只有要点和个人简介支持格式；其它字段选中时只显示「让 Agent 改」。
 */
export interface AskAgentRequest {
  quote: string;
  section: string;
  top: number;
  left: number;
}

interface Anchor {
  top: number;
  left: number;
  rich: boolean;
  sectionId: string | null;
  inBullet: boolean;
  indented: boolean;
  quote: string;
  section: string;
}

const PALETTE = ["#141413", "#595959", "#8c8c8c", "#1f3a5f", "#2463eb", "#2f5d50", "#16a34a", "#8a2c2c", "#dc2626", "#b45309", "#7c3aed", "#db2777"];
const RECENT_KEY = "offeru.recentTextColors";

function readRecent(): string[] {
  try { return JSON.parse(localStorage.getItem(RECENT_KEY) || "[]").filter((item: unknown) => typeof item === "string").slice(0, 6); } catch { return []; }
}

function editableHost(node: Node | null) {
  const element = node instanceof Element ? node : node?.parentElement;
  return element?.closest<HTMLElement>(".paper-sheet [data-paper-editable]") || null;
}

export function FormatBar({ numberedSections, onToggleNumbered, onAskAgent }: {
  numberedSections: Set<string>;
  onToggleNumbered: (sectionId: string) => void;
  onAskAgent?: (request: AskAgentRequest) => void;
}) {
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  const [panel, setPanel] = useState<null | "color" | "more" | "link">(null);
  const [link, setLink] = useState("");
  const [recent, setRecent] = useState<string[]>([]);
  const [, force] = useState(0);
  const rangeRef = useRef<{ start: number; end: number } | null>(null);
  const hostRef = useRef<HTMLElement | null>(null);
  const panelRef = useRef(panel);
  panelRef.current = panel;

  useEffect(() => {
    const update = () => {
      if (panelRef.current) return;
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed || !selection.rangeCount) { setAnchor(null); return; }
      const range = selection.getRangeAt(0);
      const host = editableHost(range.commonAncestorContainer);
      if (!host) { setAnchor(null); return; }
      const quote = selection.toString().trim();
      if (!quote) { setAnchor(null); return; }
      rangeRef.current = { start: textOffset(host, range.startContainer, range.startOffset), end: textOffset(host, range.endContainer, range.endOffset) };
      hostRef.current = host;
      const rect = range.getBoundingClientRect();
      const sectionNode = host.closest<HTMLElement>("[data-section-id]");
      const li = host.closest("li");
      setAnchor({
        top: rect.top,
        left: rect.left + rect.width / 2,
        rich: host.hasAttribute("data-paper-rich"),
        sectionId: sectionNode?.dataset.sectionId || null,
        inBullet: Boolean(li && host.hasAttribute("data-paper-rich")),
        indented: Boolean(li?.classList.contains("paper-bullet-sub")),
        quote: quote.slice(0, 400),
        section: sectionNode?.querySelector(".paper-section-title")?.textContent?.trim() || (host.closest(".paper-header") ? "抬头" : "简介"),
      });
    };
    const hide = () => { if (!panelRef.current) setAnchor(null); };
    document.addEventListener("selectionchange", update);
    window.addEventListener("scroll", hide, true);
    return () => {
      document.removeEventListener("selectionchange", update);
      window.removeEventListener("scroll", hide, true);
    };
  }, []);

  if (!anchor || typeof document === "undefined") return null;

  // 失焦提交后 React 可能重写宿主的 innerHTML，所以只认宿主和字符偏移。
  const target = () => {
    const host = hostRef.current;
    const saved = rangeRef.current;
    return host?.isConnected && saved ? { host, ...saved } : null;
  };
  const restore = () => {
    const hit = target();
    if (!hit) return false;
    hit.host.focus();
    return true;
  };
  const mark = (name: Mark) => {
    const hit = target();
    if (hit) toggleMark(hit.host, hit.start, hit.end, name);
    force((n) => n + 1);
  };
  const close = () => { setPanel(null); setLink(""); };
  const applyColor = (value: string | null) => {
    const hit = target();
    if (hit) formatHost(hit.host, hit.start, hit.end, { color: value });
    if (value) {
      const next = [value, ...readRecent().filter((item) => item !== value)].slice(0, 6);
      try { localStorage.setItem(RECENT_KEY, JSON.stringify(next)); } catch { /* 隐私模式下不记最近颜色 */ }
    }
    close();
  };
  const applyLink = (href: string | null) => {
    const hit = target();
    if (hit) formatHost(hit.host, hit.start, hit.end, { href });
    close();
  };
  const active = (name: Mark) => {
    const hit = target();
    return hit ? hasMark(parseRuns(hit.host.innerHTML), hit.start, hit.end, name) : false;
  };
  const indent = (value: boolean) => {
    restore();
    hostRef.current?.dispatchEvent(new CustomEvent("paper-indent", { detail: value }));
    close();
    setAnchor(null);
  };
  const keep = (event: { preventDefault: () => void }) => event.preventDefault();
  const numbered = anchor.sectionId ? numberedSections.has(anchor.sectionId) : false;

  return createPortal(
    <div className="paper-format-bar" data-paper-chrome="" role="toolbar" aria-label="文字格式"
      style={{ left: anchor.left, top: anchor.top }} onMouseDown={(event) => { if (panel !== "link" && panel !== "color") keep(event); }}>
      <div className="paper-format-row">
        {anchor.rich && (
          <>
            <button type="button" aria-label="加粗" title="加粗（⌘/Ctrl + B）" aria-pressed={active("strong")} onClick={() => mark("strong")}><b>B</b></button>
            <button type="button" aria-label="斜体" title="斜体（⌘/Ctrl + I）" aria-pressed={active("em")} onClick={() => mark("em")}><i style={{ fontFamily: "Georgia, serif" }}>I</i></button>
            <button type="button" aria-label="下划线" title="下划线（⌘/Ctrl + U）" aria-pressed={active("u")} onClick={() => mark("u")}><u>U</u></button>
            <button type="button" aria-label="文字颜色" title="文字颜色" aria-expanded={panel === "color"}
              onClick={() => { setRecent(readRecent()); setPanel(panel === "color" ? null : "color"); }}>
              <span className="paper-format-color">A</span>
            </button>
            {anchor.inBullet && anchor.sectionId && (
              <>
                <span className="paper-format-sep" />
                <button type="button" aria-label="序号列表" title="这个模块的要点改用 1. 2. 3." aria-pressed={numbered}
                  onClick={() => onToggleNumbered(anchor.sectionId!)}>1. 序号</button>
              </>
            )}
            <button type="button" aria-label="更多格式" aria-expanded={panel === "more"} onClick={() => setPanel(panel === "more" ? null : "more")}>…</button>
          </>
        )}
        {onAskAgent && (
          <>
            {anchor.rich && <span className="paper-format-sep" />}
            <button type="button" onClick={() => {
              onAskAgent({ quote: anchor.quote, section: anchor.section, top: anchor.top, left: anchor.left });
              setAnchor(null);
            }}>让 Agent 改</button>
          </>
        )}
      </div>
      {panel === "color" && (
        <div className="paper-format-pop" data-testid="paper-color-panel">
          {recent.length > 0 && (
            <>
              <p>最近使用</p>
              <div className="paper-format-swatches">
                {recent.map((value) => <button key={value} type="button" aria-label={`颜色 ${value}`} style={{ background: value }} onMouseDown={keep} onClick={() => applyColor(value)} />)}
              </div>
            </>
          )}
          <p>颜色</p>
          <div className="paper-format-swatches">
            {PALETTE.map((value) => <button key={value} type="button" aria-label={`颜色 ${value}`} style={{ background: value }} onMouseDown={keep} onClick={() => applyColor(value)} />)}
          </div>
          <div className="paper-format-pop-foot">
            <button type="button" onMouseDown={keep} onClick={() => applyColor(null)}>恢复默认</button>
            <label>自定义
              <input type="color" aria-label="自定义颜色" onChange={(event) => applyColor(event.currentTarget.value)} />
            </label>
          </div>
        </div>
      )}
      {panel === "more" && (
        <div className="paper-format-pop paper-format-menu">
          <button type="button" onClick={() => { mark("s"); close(); }}>删除线</button>
          {anchor.inBullet && <button type="button" onClick={() => indent(!anchor.indented)}>{anchor.indented ? "取消缩进" : "缩进为二级要点"}</button>}
          <button type="button" onClick={() => setPanel("link")}>链接</button>
        </div>
      )}
      {panel === "link" && (
        <form className="paper-format-pop paper-format-link" onSubmit={(event) => {
          event.preventDefault();
          const url = link.trim();
          applyLink(url ? (/^(https?:|mailto:)/i.test(url) ? url : `https://${url}`) : null);
        }}>
          <input autoFocus value={link} onChange={(event) => setLink(event.target.value)} placeholder="粘贴链接，例如 github.com/you" aria-label="链接地址" />
          <button type="submit">确定</button>
        </form>
      )}
    </div>,
    document.body,
  );
}
