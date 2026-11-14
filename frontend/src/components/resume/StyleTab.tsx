"use client";

// 右栏「排版美化」（参考 offershow；取代原来挤在顶栏的 StylePanel）：智能一页 · 字体 · 字号 / 行距 · 间距 · 边距 · 主题色。
// 数值只在 resumeStyle 的 RANGE 里取；越界的输入不提交，失焦回到当前值。每次改动交给上层，上层停顿后整份 style 存一次（可撤销）。
import { Minus, Plus, Wand2 } from "lucide-react";
import { useState } from "react";

import { Button, Field, Input, Select } from "@/components/ui";
import { ACCENTS, RANGE, RESUME_FONTS, type ResumeFont, type ResumeStyle } from "@/lib/resumeStyle";

type Props = { style: ResumeStyle; onChange: (next: ResumeStyle) => void; onFit: () => void; fitting: boolean; notice: string | null };

const decimals = (step: number) => (String(step).split(".")[1] ?? "").length;

// 数字：可直接敲，也可用 − / + 或 ↑↓ 微调。
function Stepper({ label, value, min, max, step, unit, onChange }: {
  label: string; value: number; min: number; max: number; step: number; unit: string; onChange: (v: number) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const fix = (v: number) => Number(Math.min(max, Math.max(min, v)).toFixed(decimals(step)));
  const nudge = (dir: 1 | -1) => { setDraft(null); onChange(fix(value + dir * step)); };
  return (
    <Field label={label} hint={min + "–" + max + (unit ? " " + unit : "")}>
      {(id) => (
        <div className="re-stepper">
          <button type="button" className="ou-icon-button" aria-label={label + "减小"} disabled={value <= min} onClick={() => nudge(-1)}><Minus size={14} aria-hidden /></button>
          <Input id={id} inputMode="decimal" value={draft ?? String(value)} aria-label={label + (unit ? "（" + unit + "）" : "")}
            onChange={(e) => {
              setDraft(e.target.value);
              const v = Number(e.target.value);
              if (e.target.value.trim() && Number.isFinite(v) && v >= min && v <= max) onChange(fix(v));
            }}
            onBlur={() => setDraft(null)}
            onKeyDown={(e) => {
              if (e.key === "ArrowUp" || e.key === "ArrowDown") { e.preventDefault(); nudge(e.key === "ArrowUp" ? 1 : -1); }
              if (e.key === "Enter") e.currentTarget.blur();
            }} />
          <button type="button" className="ou-icon-button" aria-label={label + "增大"} disabled={value >= max} onClick={() => nudge(1)}><Plus size={14} aria-hidden /></button>
        </div>
      )}
    </Field>
  );
}

// 和 resumeStyle.ACCENTS 一一对应（按顺序）。
const ACCENT_NAMES = ["墨黑", "藏蓝", "墨绿", "酒红", "黛紫"];

export function StyleTab({ style, onChange, onFit, fitting, notice }: Props) {
  const set = (patch: Partial<ResumeStyle>) => onChange({ ...style, ...patch });
  return (
    <div className="re-module re-style">
      <section className="re-style-group">
        <div className="re-fit">
          <Button variant="secondary" onClick={onFit} disabled={fitting}><Wand2 size={15} aria-hidden />{fitting ? "排版中…" : "智能一页"}</Button>
          <p className="re-fit-note" role="status">{notice ?? "按内容自动调字号、行距和间距，刚好排满一页"}</p>
        </div>
      </section>
      <section className="re-style-group" aria-label="文字">
        <h3 className="re-style-heading">文字</h3>
        <Field label="字体">
          {(id) => <Select id={id} aria-label="字体" value={style.font} onValueChange={(font) => set({ font: font as ResumeFont })}
            options={(Object.keys(RESUME_FONTS) as ResumeFont[]).map((f) => ({ value: f, label: RESUME_FONTS[f] }))} />}
        </Field>
        <div className="re-fields">
          <Stepper label="字号" value={style.bodySize} min={RANGE.bodySize[0]} max={RANGE.bodySize[1]} step={0.1} unit="pt" onChange={(bodySize) => set({ bodySize })} />
          <Stepper label="行距" value={style.lineHeight} min={RANGE.lineHeight[0]} max={RANGE.lineHeight[1]} step={0.05} unit="倍" onChange={(lineHeight) => set({ lineHeight })} />
        </div>
      </section>
      <section className="re-style-group" aria-label="间距">
        <h3 className="re-style-heading">间距与页边距</h3>
        <div className="re-fields">
          <Stepper label="模块间距" value={style.sectionGap} min={RANGE.sectionGap[0]} max={RANGE.sectionGap[1]} step={0.5} unit="pt" onChange={(sectionGap) => set({ sectionGap })} />
          <Stepper label="条目间距" value={style.itemGap} min={RANGE.itemGap[0]} max={RANGE.itemGap[1]} step={0.5} unit="pt" onChange={(itemGap) => set({ itemGap })} />
          <Stepper label="上下边距" value={style.margin.top} min={RANGE.margin[0]} max={RANGE.margin[1]} step={0.5} unit="mm"
            onChange={(v) => set({ margin: { ...style.margin, top: v, bottom: v } })} />
          <Stepper label="左右边距" value={style.margin.left} min={RANGE.margin[0]} max={RANGE.margin[1]} step={0.5} unit="mm"
            onChange={(v) => set({ margin: { ...style.margin, left: v, right: v } })} />
        </div>
      </section>
      <section className="re-style-group" aria-label="主题色">
        <h3 className="re-style-heading">主题色</h3>
        {/* 简历纸面上的颜色是用户文档的一部分（PDF 模板配色独立于应用外壳），色值来自 resumeStyle.ACCENTS。 */}
        <div role="radiogroup" aria-label="主题色" className="re-swatches">
          {ACCENTS.map((color, i) => (
            <button key={color} type="button" role="radio" aria-checked={style.accent.toLowerCase() === color.toLowerCase()}
              aria-label={"主题色 " + (ACCENT_NAMES[i] ?? color)} title={ACCENT_NAMES[i] ?? color}
              className="re-swatch" style={{ background: color }} onClick={() => set({ accent: color })} />
          ))}
        </div>
      </section>
    </div>
  );
}
