"use client";

/**
 * 「纸」画布顶部的常驻排版工具栏（对标超级简历）：
 * 智能一页 · 字号 · 行距 · 模块管理 · 样式，右侧显示页数。
 * 只放高频操作；纸色、照片、主题色这些设一次就不动的仍在右侧「排版」里。
 */

import { useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowDown, ArrowUp, Eye, EyeOff, LayoutList, Minus, Plus, Sparkles } from "lucide-react";
import { missingModules } from "@/lib/resumeModules";

export interface ToolbarSection {
  id: number;
  section_type: string;
  title: string;
  visible: boolean;
  sort_order: number;
}

const LINE_HEIGHTS = [1.25, 1.35, 1.45, 1.6, 1.8];

function Group({ children, label }: { children: ReactNode; label?: string }) {
  return (
    <div className="flex items-center gap-0.5 rounded-lg bg-white px-1 py-0.5 shadow-[0_0_0_1px_rgba(20,20,19,0.08)]" role="group" aria-label={label}>
      {children}
    </div>
  );
}

const btn = "inline-flex h-7 items-center gap-1 rounded-md px-2 text-[12px] text-[#37352f] hover:bg-black/[0.05] disabled:opacity-40";

export function PaperToolbar({
  bodySize, lineHeight, paperStyle, pages, fitting, sections,
  onBodySize, onLineHeight, onPaperStyle, onFit, onSections, onAddModule, trailing,
}: {
  bodySize: number;
  lineHeight: number;
  paperStyle: "cv" | "kami";
  pages: number;
  fitting: boolean;
  sections: ToolbarSection[];
  onBodySize: (value: number) => void;
  onLineHeight: (value: number) => void;
  onPaperStyle: (value: "cv" | "kami") => void;
  onFit: () => void;
  onSections: (sections: ToolbarSection[]) => void;
  onAddModule: (type: string, label: string) => void;
  trailing?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const popRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => { if (!popRef.current?.contains(event.target as Node)) setOpen(false); };
    const esc = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", close); document.removeEventListener("keydown", esc); };
  }, [open]);

  const ordered = [...sections].sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));
  const move = (index: number, delta: number) => {
    const next = [...ordered];
    const [item] = next.splice(index, 1);
    next.splice(index + delta, 0, item);
    onSections(next.map((section, order) => ({ ...section, sort_order: order })));
  };
  const toggle = (id: number) => onSections(ordered.map((section) => section.id === id ? { ...section, visible: section.visible === false } : section));
  const size = Math.round(bodySize * 2) / 2;
  const lineOptions = LINE_HEIGHTS.includes(lineHeight) ? LINE_HEIGHTS : [...LINE_HEIGHTS, lineHeight].sort((a, b) => a - b);
  const missing = missingModules(sections);

  return (
    <div className="sticky top-0 z-20 -mx-1 mb-3 flex flex-wrap items-center gap-2 rounded-xl bg-[#ebe9e1]/90 px-1 py-1 backdrop-blur" data-testid="paper-toolbar">
      <Group label="智能一页">
        <button type="button" className={`${btn} font-medium`} onClick={onFit} disabled={fitting} title="自动调整字号、行距和间距，尽量放进一页；放不下就按两页排" data-testid="paper-fit-one-page">
          <Sparkles size={13} />{fitting ? "调整中…" : "智能一页"}
        </button>
      </Group>

      <Group label="字号">
        <button type="button" className={btn} aria-label="字号减小" onClick={() => onBodySize(Math.max(8, size - 0.5))} disabled={size <= 8}><Minus size={12} /></button>
        <span className="min-w-[44px] text-center text-[12px] tabular-nums text-[#37352f]" title="正文字号" data-testid="paper-font-size">{size} pt</span>
        <button type="button" className={btn} aria-label="字号增大" onClick={() => onBodySize(Math.min(14, size + 0.5))} disabled={size >= 14}><Plus size={12} /></button>
      </Group>

      <Group label="行距">
        <label className="flex items-center gap-1 px-1 text-[12px] text-[#787774]">行距
          <select aria-label="行距" value={lineHeight} onChange={(event) => onLineHeight(Number(event.target.value))} className="h-7 rounded-md bg-transparent px-1 text-[12px] text-[#37352f] hover:bg-black/[0.05] focus:outline-none" data-testid="paper-line-height">
            {lineOptions.map((value) => <option key={value} value={value}>{value.toFixed(2).replace(/0$/, "")}</option>)}
          </select>
        </label>
      </Group>

      <div className="relative" ref={popRef}>
        <Group label="模块管理">
          <button type="button" className={btn} aria-expanded={open} aria-haspopup="dialog" onClick={() => setOpen((value) => !value)} data-testid="paper-modules">
            <LayoutList size={13} />模块管理
          </button>
        </Group>
        {open && (
          <div role="dialog" aria-label="模块管理" className="absolute left-0 top-[calc(100%+6px)] z-30 w-[280px] rounded-xl bg-white p-2 shadow-[0_0_0_1px_rgba(20,20,19,0.08),0_12px_32px_rgba(20,20,19,0.14)]" data-testid="paper-modules-panel">
            <p className="px-2 pb-1 pt-0.5 text-[11px] text-[#787774]">显示顺序</p>
            <ul className="space-y-0.5">
              {ordered.map((section, index) => {
                const hidden = section.visible === false;
                return (
                  <li key={section.id} className={`group flex items-center gap-1 rounded-md px-2 py-1 text-[13px] hover:bg-black/[0.04] ${hidden ? "text-[#a8a59c]" : "text-[#37352f]"}`} data-testid="paper-module-row">
                    <span className={`flex-1 truncate ${hidden ? "line-through" : ""}`}>{section.title || "未命名模块"}</span>
                    <button type="button" className="rounded p-1 opacity-60 hover:bg-black/[0.06] hover:opacity-100 disabled:invisible" aria-label={`上移「${section.title}」`} disabled={index === 0} onClick={() => move(index, -1)}><ArrowUp size={12} /></button>
                    <button type="button" className="rounded p-1 opacity-60 hover:bg-black/[0.06] hover:opacity-100 disabled:invisible" aria-label={`下移「${section.title}」`} disabled={index === ordered.length - 1} onClick={() => move(index, 1)}><ArrowDown size={12} /></button>
                    <button type="button" className="rounded p-1 opacity-60 hover:bg-black/[0.06] hover:opacity-100" aria-label={hidden ? `显示「${section.title}」` : `隐藏「${section.title}」`} aria-pressed={hidden} onClick={() => toggle(section.id)}>{hidden ? <EyeOff size={12} /> : <Eye size={12} />}</button>
                  </li>
                );
              })}
            </ul>
            {missing.length > 0 && (
              <>
                <p className="mt-2 border-t border-black/[0.06] px-2 pb-1 pt-2 text-[11px] text-[#787774]">添加模块</p>
                <div className="flex flex-wrap gap-1 px-1 pb-1">
                  {missing.map(([type, label]) => (
                    <button key={type} type="button" className="rounded-md px-2 py-1 text-[12px] text-[#37352f] shadow-[0_0_0_1px_rgba(20,20,19,0.1)] hover:bg-black/[0.04]" onClick={() => onAddModule(type, label)} data-testid={`paper-add-module-${type}`}>+ {label}</button>
                  ))}
                </div>
              </>
            )}
          </div>
        )}
      </div>

      <Group label="样式">
        {(([["cv", "清晰"], ["kami", "留白"]]) as const).map(([id, text]) => (
          <button key={id} type="button" aria-pressed={paperStyle === id} onClick={() => onPaperStyle(id)} className={`${btn} ${paperStyle === id ? "bg-[#37352f] text-white hover:bg-[#37352f]" : ""}`} title={id === "cv" ? "参考超级简历：黑体、照片在左、紧凑" : "参考 Kami：宋体、留白多"} data-testid={`paper-style-${id}`}>{text}</button>
        ))}
      </Group>

      <div className="ml-auto flex items-center gap-2 text-[11px] text-[#787774]">
        {trailing}
        <span className={`rounded-md px-2 py-1 ${pages > 1 ? "bg-white text-[#37352f] shadow-[0_0_0_1px_rgba(20,20,19,0.08)]" : ""}`} data-testid="paper-page-count">A4 · {pages} 页</span>
      </div>
    </div>
  );
}

export default PaperToolbar;
