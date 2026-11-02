"use client";

// 顶部一行排版工具栏（对齐超级简历）：智能一页 | 模板 | 字体 | 字号 | 行距 | 间距 ▾ | 外观 ▾。
// 数值都是「输入 + 下拉常用值」：能直接敲、能用 ↑↓ 微调，也能点箭头选；越界的输入不提交，失焦回到当前值。
// 只在 resumeStyle 的 RANGE 里取值；每次改动交给上层，上层停顿后整份 style 存一次（进最近改动，可撤销）。
import { type ReactNode, type RefObject, useEffect, useRef, useState } from "react";

import {
  ACCENTS, RANGE, RESUME_FONTS, RESUME_TEMPLATES, type ResumeFont, type ResumeStyle, type ResumeTemplate, withTemplate,
} from "@/lib/resumeStyle";

type Props = {
  style: ResumeStyle;
  onChange: (next: ResumeStyle) => void;
  onFit: () => void;
  fitting: boolean;
  notice: string | null;
};

// 常用值：都落在 RANGE 里。
const PRESET = {
  bodySize: [8.5, 9, 9.2, 9.5, 10, 10.5, 11, 12],
  lineHeight: [1.2, 1.3, 1.4, 1.42, 1.5, 1.6, 1.8],
  sectionGap: [6, 8, 10, 12, 16, 20],
  itemGap: [2, 3, 4, 5, 7, 10],
  margin: [6, 8, 10, 11, 13, 15, 20],
};

// 点外面或按 Esc 关闭。
function useDismiss(root: RefObject<HTMLElement | null>, open: boolean, close: () => void) {
  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent) => { if (!root.current?.contains(e.target as Node)) close(); };
    const key = (e: globalThis.KeyboardEvent) => { if (e.key === "Escape") close(); };
    document.addEventListener("mousedown", down);
    document.addEventListener("keydown", key);
    return () => { document.removeEventListener("mousedown", down); document.removeEventListener("keydown", key); };
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
}

function Caret() {
  return (
    <svg className="rs-caret-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

// 下拉层：trigger 是按钮内容，children 拿到 close。
function Pop({ label, trigger, panel, children }: {
  label: string; trigger: ReactNode; panel?: boolean; children: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const close = () => setOpen(false);
  useDismiss(root, open, close);
  return (
    <div ref={root} className="rs-pop">
      <button type="button" className="rs-trigger" aria-haspopup="true" aria-expanded={open} title={label} onClick={() => setOpen(!open)}>
        {trigger}<Caret />
      </button>
      {open && <div role={panel ? "dialog" : "menu"} aria-label={label} className={"rs-menu" + (panel ? " rs-menu-panel" : "")}>{children(close)}</div>}
    </div>
  );
}

function Choice<T extends string>({ label, value, options, onPick, fontOf }: {
  label: string; value: T; options: Record<T, string>; onPick: (v: T) => void; fontOf?: (v: T) => string;
}) {
  return (
    <Pop label={label} trigger={<><span className="rs-label">{label}</span><span>{options[value]}</span></>}>
      {(close) => (Object.keys(options) as T[]).map((id) => (
        <button key={id} type="button" role="menuitemradio" aria-checked={id === value} className="rs-option"
          style={fontOf ? { fontFamily: fontOf(id) } : undefined} onClick={() => { onPick(id); close(); }}>
          {options[id]}
        </button>
      ))}
    </Pop>
  );
}

const decimals = (step: number) => (String(step).split(".")[1] ?? "").length;

function Combo({ label, value, presets, min, max, step, unit, onChange }: {
  label: string; value: number; presets: number[]; min: number; max: number; step: number; unit: string; onChange: (v: number) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useDismiss(root, open, () => setOpen(false));
  const fix = (v: number) => Number(Math.min(max, Math.max(min, v)).toFixed(decimals(step)));
  const typed = (raw: string) => {
    setDraft(raw);
    const v = Number(raw);
    if (raw.trim() && Number.isFinite(v) && v >= min && v <= max) onChange(fix(v));
  };
  const nudge = (dir: 1 | -1) => { setDraft(null); onChange(fix(value + dir * step)); };
  return (
    <div ref={root} className="rs-combo" title={label + (unit ? "（" + unit + "）" : "") + "：可输入，也可选常用值"}>
      <span className="rs-label">{label}</span>
      <input inputMode="decimal" aria-label={label} value={draft ?? String(value)}
        onChange={(e) => typed(e.target.value)} onBlur={() => setDraft(null)}
        onKeyDown={(e) => {
          if (e.key === "ArrowUp" || e.key === "ArrowDown") { e.preventDefault(); nudge(e.key === "ArrowUp" ? 1 : -1); }
          if (e.key === "Enter") e.currentTarget.blur();
        }} />
      {unit && <span className="rs-unit">{unit}</span>}
      <button type="button" className="rs-caret" aria-label={label + "常用值"} aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Caret />
      </button>
      {open && (
        <div role="listbox" aria-label={label + "常用值"} className="rs-menu">
          {presets.filter((p) => p >= min && p <= max).map((p) => (
            <button key={p} type="button" role="option" aria-selected={p === value} className="rs-option"
              onClick={() => { setDraft(null); onChange(p); setOpen(false); }}>
              {p}{unit && " " + unit}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

const FONT_FAMILY: Record<ResumeFont, string> = {
  sans: '"PingFang SC", "Microsoft YaHei", sans-serif',
  serif: '"Source Han Serif SC", "Noto Serif SC", "SimSun", serif',
  kai: '"Kaiti SC", "KaiTi", "STKaiti", serif',
};

export function StylePanel({ style, onChange, onFit, fitting, notice }: Props) {
  const set = (patch: Partial<ResumeStyle>) => onChange({ ...style, ...patch });

  return (
    <div role="toolbar" aria-label="排版" className="rs-bar">
      <button type="button" onClick={onFit} disabled={fitting} className="rs-btn">{fitting ? "排版中…" : "智能一页"}</button>
      <span className="rs-sep" aria-hidden />
      <Choice label="模板" value={style.template} options={RESUME_TEMPLATES} onPick={(t: ResumeTemplate) => onChange(withTemplate(style, t))} />
      <Choice label="字体" value={style.font} options={RESUME_FONTS} fontOf={(f: ResumeFont) => FONT_FAMILY[f]} onPick={(font: ResumeFont) => set({ font })} />
      <span className="rs-sep" aria-hidden />
      <Combo label="字号" value={style.bodySize} presets={PRESET.bodySize} min={RANGE.bodySize[0]} max={RANGE.bodySize[1]} step={0.1} unit="pt"
        onChange={(bodySize) => set({ bodySize })} />
      <Combo label="行距" value={style.lineHeight} presets={PRESET.lineHeight} min={RANGE.lineHeight[0]} max={RANGE.lineHeight[1]} step={0.05} unit=""
        onChange={(lineHeight) => set({ lineHeight })} />
      <span className="rs-sep" aria-hidden />
      <Pop label="间距" panel trigger={<span>间距</span>}>
        {() => (
          <>
            <Combo label="模块间距" value={style.sectionGap} presets={PRESET.sectionGap} min={RANGE.sectionGap[0]} max={RANGE.sectionGap[1]} step={0.5} unit="pt"
              onChange={(sectionGap) => set({ sectionGap })} />
            <Combo label="条目间距" value={style.itemGap} presets={PRESET.itemGap} min={RANGE.itemGap[0]} max={RANGE.itemGap[1]} step={0.5} unit="pt"
              onChange={(itemGap) => set({ itemGap })} />
            <Combo label="上下边距" value={style.margin.top} presets={PRESET.margin} min={RANGE.margin[0]} max={RANGE.margin[1]} step={0.5} unit="mm"
              onChange={(v) => set({ margin: { ...style.margin, top: v, bottom: v } })} />
            <Combo label="左右边距" value={style.margin.left} presets={PRESET.margin} min={RANGE.margin[0]} max={RANGE.margin[1]} step={0.5} unit="mm"
              onChange={(v) => set({ margin: { ...style.margin, left: v, right: v } })} />
          </>
        )}
      </Pop>
      <Pop label="外观" panel trigger={<><span className="rs-dot" style={{ background: style.accent }} aria-hidden /><span>外观</span></>}>
        {() => (
          <>
            <div className="rs-row">
              <span className="rs-label">主题色</span>
              <div role="radiogroup" aria-label="主题色" className="flex items-center gap-1.5">
                {ACCENTS.map((color) => (
                  <button key={color} type="button" role="radio" aria-checked={style.accent === color} aria-label={"主题色 " + color}
                    onClick={() => set({ accent: color })} style={{ background: color }} className="rs-swatch" />
                ))}
              </div>
            </div>
          </>
        )}
      </Pop>
      {notice && <p role="status" className="rs-status">{notice}</p>}
    </div>
  );
}
