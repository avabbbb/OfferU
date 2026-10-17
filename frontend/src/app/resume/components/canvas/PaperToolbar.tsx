"use client";

/**
 * 纸面上方的排版工具栏：智能一页 · 字号 · 行距 · 模块 · 清晰/留白 · 排版（全部数值），右侧显示页数。
 * 「排版」参考超级简历：一处调全局，不需要选文字。
 */

import { useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowDown, ArrowUp, ChevronDown, Eye, EyeOff, Minus, Plus, Sparkles } from "lucide-react";
import { missingModules } from "@/lib/resumeModules";

export interface ToolbarSection {
  id: number;
  section_type: string;
  title: string;
  visible: boolean;
  sort_order: number;
}

export interface ToolbarLayout {
  font: "sans" | "serif" | "kai";
  sectionGap: number;
  itemGap: number;
  marginVertical: number;
  marginHorizontal: number;
  themeColor: string | null;
}

const FONTS = [["sans", "黑体"], ["serif", "宋体"], ["kai", "楷体"]] as const;
const THEMES = ["#1f3a5f", "#2f5d50", "#8a2c2c", "#4b3f72", "#595959"];

const LINE_HEIGHTS = [1.25, 1.35, 1.45, 1.6, 1.8];
const btn = "inline-flex h-8 items-center gap-1 rounded-md px-2.5 text-[13px] text-[#37352f] hover:bg-black/[0.04] disabled:opacity-40";
const Divider = () => <span className="mx-1 h-4 w-px bg-black/[0.08]" aria-hidden />;

/** 点外面或按 Esc 关闭的小浮层。 */
function usePopover() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => { if (!ref.current?.contains(event.target as Node)) setOpen(false); };
    const esc = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", close); document.removeEventListener("keydown", esc); };
  }, [open]);
  return { open, setOpen, ref };
}

const popoverClass = "absolute top-[calc(100%+8px)] z-30 rounded-xl bg-white p-2 shadow-[0_0_0_1px_rgba(15,15,15,0.06),0_12px_32px_rgba(15,15,15,0.12)]";

function Stepper({ label, value, unit, min, max, step, onChange, testId }: {
  label: string; value: number; unit: string; min: number; max: number; step: number; onChange: (value: number) => void; testId?: string;
}) {
  return (
    <div className="flex items-center justify-between gap-3 px-2 py-1 text-[13px] text-[#37352f]">
      <span>{label}</span>
      <span className="flex items-center">
        <button type="button" className={btn} aria-label={`${label}减小`} disabled={value <= min} onClick={() => onChange(Math.max(min, value - step))}><Minus size={12} /></button>
        <span className="min-w-[48px] text-center tabular-nums" data-testid={testId}>{value} {unit}</span>
        <button type="button" className={btn} aria-label={`${label}增大`} disabled={value >= max} onClick={() => onChange(Math.min(max, value + step))}><Plus size={12} /></button>
      </span>
    </div>
  );
}

export function PaperToolbar({
  bodySize, lineHeight, paperStyle, pages, fitting, sections, layout, pageSize,
  onBodySize, onLineHeight, onPaperStyle, onFit, onSections, onAddModule, onStyle, onReset, trailing,
}: {
  bodySize: number;
  lineHeight: number;
  paperStyle: "cv" | "kami";
  pages: number;
  fitting: boolean;
  sections: ToolbarSection[];
  layout: ToolbarLayout;
  pageSize: "A4" | "LETTER";
  onBodySize: (value: number) => void;
  onLineHeight: (value: number) => void;
  onPaperStyle: (value: "cv" | "kami") => void;
  onFit: () => void;
  onSections: (sections: ToolbarSection[]) => void;
  onAddModule: (type: string, label: string) => void;
  onStyle: (patch: Record<string, string>) => void;
  onReset: () => void;
  trailing?: ReactNode;
}) {
  const modules = usePopover();
  const more = usePopover();
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
    <div className="sticky top-3 z-20 mx-auto flex w-fit max-w-full flex-col items-center gap-2" data-testid="paper-toolbar">
      <div className="flex flex-wrap items-center rounded-xl bg-white px-1.5 py-1 shadow-[0_0_0_1px_rgba(15,15,15,0.06),0_2px_8px_rgba(15,15,15,0.05)]">
        <button type="button" className={btn} onClick={onFit} disabled={fitting} title="自动调整字号、行距和间距：多了压进一页，少了铺满一页" data-testid="paper-fit-one-page">
          <Sparkles size={13} />{fitting ? "调整中…" : "智能一页"}
        </button>
        <Divider />
        <button type="button" className={btn} aria-label="字号减小" onClick={() => onBodySize(Math.max(8, size - 0.5))} disabled={size <= 8}><Minus size={12} /></button>
        <span className="min-w-[44px] text-center text-[13px] tabular-nums text-[#37352f]" title="正文字号" data-testid="paper-font-size">{size} pt</span>
        <button type="button" className={btn} aria-label="字号增大" onClick={() => onBodySize(Math.min(14, size + 0.5))} disabled={size >= 14}><Plus size={12} /></button>
        <Divider />
        <label className="relative inline-flex h-8 items-center rounded-md pl-2.5 pr-6 text-[13px] text-[#37352f] hover:bg-black/[0.04]">
          行距&nbsp;
          <select aria-label="行距" value={lineHeight} onChange={(event) => onLineHeight(Number(event.target.value))} className="cursor-pointer appearance-none bg-transparent tabular-nums focus:outline-none" data-testid="paper-line-height">
            {lineOptions.map((value) => <option key={value} value={value}>{value.toFixed(2).replace(/0$/, "")}</option>)}
          </select>
          <ChevronDown size={12} className="pointer-events-none absolute right-1.5 text-[#9b9a97]" />
        </label>
        <Divider />
        <div className="relative" ref={modules.ref}>
          <button type="button" className={btn} aria-expanded={modules.open} aria-haspopup="dialog" onClick={() => modules.setOpen((value) => !value)} data-testid="paper-modules">模块</button>
          {modules.open && (
            <div role="dialog" aria-label="模块" className={`${popoverClass} left-0 w-[280px]`} data-testid="paper-modules-panel">
              <p className="px-2 pb-1 pt-0.5 text-[12px] text-[#9b9a97]">显示顺序</p>
              <ul className="space-y-0.5">
                {ordered.map((section, index) => {
                  const hidden = section.visible === false;
                  return (
                    <li key={section.id} className={`flex items-center gap-1 rounded-md px-2 py-1 text-[13px] hover:bg-black/[0.03] ${hidden ? "text-[#b4b2ac]" : "text-[#37352f]"}`} data-testid="paper-module-row">
                      <span className={`flex-1 truncate ${hidden ? "line-through" : ""}`}>{section.title || "未命名模块"}</span>
                      <button type="button" className="rounded p-1 text-[#9b9a97] hover:bg-black/[0.05] hover:text-[#37352f] disabled:invisible" aria-label={`上移「${section.title}」`} disabled={index === 0} onClick={() => move(index, -1)}><ArrowUp size={12} /></button>
                      <button type="button" className="rounded p-1 text-[#9b9a97] hover:bg-black/[0.05] hover:text-[#37352f] disabled:invisible" aria-label={`下移「${section.title}」`} disabled={index === ordered.length - 1} onClick={() => move(index, 1)}><ArrowDown size={12} /></button>
                      <button type="button" className="rounded p-1 text-[#9b9a97] hover:bg-black/[0.05] hover:text-[#37352f]" aria-label={hidden ? `显示「${section.title}」` : `隐藏「${section.title}」`} aria-pressed={hidden} onClick={() => toggle(section.id)}>{hidden ? <EyeOff size={12} /> : <Eye size={12} />}</button>
                    </li>
                  );
                })}
              </ul>
              {missing.length > 0 && (
                <>
                  <p className="mt-2 border-t border-black/[0.06] px-2 pb-1 pt-2 text-[12px] text-[#9b9a97]">添加模块</p>
                  <div className="flex flex-wrap gap-1 px-1 pb-1">
                    {missing.map(([type, label]) => (
                      <button key={type} type="button" className="rounded-md px-2 py-1 text-[12px] text-[#37352f] shadow-[0_0_0_1px_rgba(15,15,15,0.1)] hover:bg-black/[0.03]" onClick={() => onAddModule(type, label)} data-testid={`paper-add-module-${type}`}>+ {label}</button>
                    ))}
                  </div>
                </>
              )}
            </div>
          )}
        </div>
        <Divider />
        <div className="flex rounded-lg bg-[#f1f1ef] p-0.5" role="group" aria-label="样式">
          {(([["cv", "清晰"], ["kami", "留白"]]) as const).map(([id, text]) => (
            <button key={id} type="button" aria-pressed={paperStyle === id} onClick={() => onPaperStyle(id)}
              className={`h-7 rounded-md px-3 text-[13px] ${paperStyle === id ? "bg-white text-[#191919] shadow-[0_1px_2px_rgba(15,15,15,0.08)]" : "text-[#787774] hover:text-[#37352f]"}`}
              title={id === "cv" ? "黑体、照片在左、紧凑" : "宋体、留白多（Kami 风格）"} data-testid={`paper-style-${id}`}>{text}</button>
          ))}
        </div>
        <Divider />
        <div className="relative" ref={more.ref}>
          <button type="button" className={btn} aria-expanded={more.open} aria-haspopup="dialog" onClick={() => more.setOpen((value) => !value)} data-testid="paper-more">排版</button>
          {more.open && (
            <div role="dialog" aria-label="排版" className={`${popoverClass} right-0 w-[290px] p-3`} data-testid="paper-more-panel">
              <p className="px-2 pb-1.5 text-[12px] text-[#9b9a97]">字体</p>
              <div className="mx-2 flex rounded-lg bg-[#f1f1ef] p-0.5" role="group" aria-label="字体">
                {FONTS.map(([id, text]) => (
                  <button key={id} type="button" aria-pressed={layout.font === id} onClick={() => onStyle({ font: id })} data-testid={`paper-font-${id}`}
                    className={`h-7 flex-1 rounded-md text-[13px] ${layout.font === id ? "bg-white text-[#191919] shadow-[0_1px_2px_rgba(15,15,15,0.08)]" : "text-[#787774] hover:text-[#37352f]"}`}>{text}</button>
                ))}
              </div>
              <p className="px-2 pb-0.5 pt-3 text-[12px] text-[#9b9a97]">文字</p>
              <Stepper label="正文字号" unit="pt" value={Math.round(bodySize * 2) / 2} min={8} max={14} step={0.5} onChange={(value) => onBodySize(value)} />
              <Stepper label="行距" unit="" value={Math.round(lineHeight * 100) / 100} min={1} max={2} step={0.05} onChange={(value) => onLineHeight(Math.round(value * 100) / 100)} testId="paper-line-height-step" />
              <p className="px-2 pb-0.5 pt-3 text-[12px] text-[#9b9a97]">间距</p>
              <Stepper label="模块间距" unit="pt" value={layout.sectionGap} min={0} max={24} step={1} onChange={(value) => onStyle({ sectionGap: String(value) })} testId="paper-section-gap" />
              <Stepper label="条目间距" unit="pt" value={layout.itemGap} min={0} max={14} step={0.5} onChange={(value) => onStyle({ itemGap: String(value) })} testId="paper-item-gap" />
              <Stepper label="页边距 上下" unit="mm" value={layout.marginVertical} min={5} max={25} step={1} onChange={(value) => onStyle({ marginTop: String(value), marginBottom: String(value) })} testId="paper-margin-vertical" />
              <Stepper label="页边距 左右" unit="mm" value={layout.marginHorizontal} min={5} max={25} step={1} onChange={(value) => onStyle({ marginLeft: String(value), marginRight: String(value) })} testId="paper-margin-horizontal" />
              <p className="px-2 pb-1.5 pt-3 text-[12px] text-[#9b9a97]">主题色 · 姓名、模块标题和分隔线</p>
              <div className="flex items-center gap-2.5 px-2">
                <button type="button" aria-label="默认主题色" aria-pressed={!layout.themeColor} onClick={() => onStyle({ accentColorHex: "" })}
                  className={`h-5 w-5 rounded-full bg-[#141413] ${!layout.themeColor ? "shadow-[0_0_0_2px_#fff,0_0_0_3.5px_#191919]" : ""}`} />
                {THEMES.map((value) => (
                  <button key={value} type="button" aria-label={`主题色 ${value}`} aria-pressed={layout.themeColor === value} onClick={() => onStyle({ accentColorHex: value })}
                    className={`h-5 w-5 rounded-full ${layout.themeColor === value ? "shadow-[0_0_0_2px_#fff,0_0_0_3.5px_#191919]" : ""}`} style={{ background: value }} />
                ))}
                <label className="relative h-5 w-5 cursor-pointer overflow-hidden rounded-full bg-[conic-gradient(#e11d48,#f59e0b,#16a34a,#2563eb,#7c3aed,#e11d48)]" title="自定义主题色">
                  <input type="color" aria-label="自定义主题色" className="absolute inset-0 cursor-pointer opacity-0" value={layout.themeColor || "#141413"} onChange={(event) => onStyle({ accentColorHex: event.currentTarget.value })} />
                </label>
              </div>
              <div className="mt-3 flex items-center justify-between border-t border-black/[0.06] px-2 pt-2 text-[12.5px]">
                <button type="button" className="text-[#787774] hover:text-[#37352f]" onClick={onReset} data-testid="paper-reset-layout">恢复默认</button>
                <span className="flex rounded-md bg-[#f1f1ef] p-0.5" role="group" aria-label="纸张">
                  {(["A4", "LETTER"] as const).map((id) => (
                    <button key={id} type="button" aria-pressed={pageSize === id} onClick={() => onStyle({ pageSize: id })}
                      className={`h-6 rounded px-2 ${pageSize === id ? "bg-white text-[#191919] shadow-[0_1px_2px_rgba(15,15,15,0.08)]" : "text-[#787774]"}`}>{id === "A4" ? "A4" : "Letter"}</button>
                  ))}
                </span>
              </div>
            </div>
          )}
        </div>
        <Divider />
        <span className={`px-2 text-[13px] tabular-nums ${pages > 1 ? "text-[#37352f]" : "text-[#9b9a97]"}`} data-testid="paper-page-count">{pageSize === "LETTER" ? "Letter" : "A4"} · {pages} 页</span>
      </div>
      {trailing}
    </div>
  );
}

export default PaperToolbar;
