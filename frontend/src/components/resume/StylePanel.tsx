"use client";

// 排版栏：模板、字体、字号、行距、间距、页边距、强调色、照片、校徽，加智能一页和导出 PDF。
// 只在 resumeStyle 的 RANGE 里取值；每次改动交给上层，上层停顿后整份 style 存一次（进最近改动，可撤销）。
import { useRef, useState } from "react";

import { apiUrl } from "@/lib/core";
import {
  ACCENTS, RANGE, RESUME_FONTS, RESUME_TEMPLATES, type ResumeFont, type ResumeStyle, type ResumeTemplate, withTemplate,
} from "@/lib/resumeStyle";

type Props = {
  style: ResumeStyle;
  onChange: (next: ResumeStyle) => void;
  onFit: () => void;
  fitting: boolean;
  notice: string | null;
  hasPhoto: boolean;
  pdfHref: string;
};

const muted = "text-[var(--foreground-muted)]";
const chip = (on: boolean) =>
  on ? "font-medium text-[var(--foreground)]" : muted + " hover:text-[var(--foreground)]";

function Slider({ label, value, min, max, step, unit, onChange }: {
  label: string; value: number; min: number; max: number; step: number; unit: string; onChange: (v: number) => void;
}) {
  return (
    <label className="flex items-center gap-2 text-[12px]" style={{ fontSize: 12 }}>
      <span className={"w-12 shrink-0 " + muted}>{label}</span>
      <input type="range" min={min} max={max} step={step} value={value} aria-label={label}
        onChange={(e) => onChange(Number(e.target.value))} className="min-w-0 flex-1 accent-[var(--foreground)]" />
      <span className="w-14 shrink-0 text-right tabular-nums text-[var(--foreground)]">{value}{unit}</span>
    </label>
  );
}

export function StylePanel({ style, onChange, onFit, fitting, notice, hasPhoto, pdfHref }: Props) {
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const set = (patch: Partial<ResumeStyle>) => onChange({ ...style, ...patch });

  const uploadLogo = async (picked: File | undefined) => {
    if (!picked) return;
    setUploading(true);
    setError(null);
    try {
      const form = new FormData();
      form.append("file", picked);
      const res = await fetch(apiUrl("/api/files"), { method: "POST", body: form });
      if (!res.ok) throw new Error(await res.text());
      const { name } = (await res.json()) as { name: string };
      set({ logo: name });
    } catch {
      setError("校徽上传失败");
    } finally {
      setUploading(false);
      if (file.current) file.current.value = "";
    }
  };

  return (
    <div className="space-y-3 border-b border-[var(--border)] px-4 py-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-[13px]" style={{ fontSize: 13 }}>
        <div role="radiogroup" aria-label="模板" className="flex gap-3">
          {(Object.keys(RESUME_TEMPLATES) as ResumeTemplate[]).map((id) => (
            <button key={id} type="button" role="radio" aria-checked={style.template === id} style={{ fontSize: 13 }}
              onClick={() => { if (style.template !== id) onChange(withTemplate(style, id)); }} className={chip(style.template === id)}>
              {RESUME_TEMPLATES[id]}
            </button>
          ))}
        </div>
        <div role="radiogroup" aria-label="字体" className="flex gap-3">
          {(Object.keys(RESUME_FONTS) as ResumeFont[]).map((id) => (
            <button key={id} type="button" role="radio" aria-checked={style.font === id} style={{ fontSize: 13 }}
              onClick={() => set({ font: id })} className={chip(style.font === id)}>{RESUME_FONTS[id]}</button>
          ))}
        </div>
        <div role="radiogroup" aria-label="强调色" className="flex gap-1.5">
          {ACCENTS.map((color) => (
            <button key={color} type="button" role="radio" aria-checked={style.accent === color} aria-label={"强调色 " + color}
              onClick={() => set({ accent: color })} style={{ background: color }}
              className={"h-4 w-4 rounded-full " + (style.accent === color ? "ring-2 ring-[var(--foreground)] ring-offset-1" : "")} />
          ))}
        </div>
        <span className="flex-1" />
        <button type="button" onClick={onFit} disabled={fitting} style={{ fontSize: 13 }}
          className="rounded-md border border-[var(--border)] px-3 py-1.5 text-[var(--foreground)] hover:bg-[var(--surface)] disabled:opacity-50">
          {fitting ? "排版中…" : "智能一页"}
        </button>
        <a href={pdfHref} download style={{ fontSize: 13 }}
          className="rounded-md bg-[var(--foreground)] px-3 py-1.5 font-medium text-[var(--background)]">导出 PDF</a>
      </div>
      <div className="grid grid-cols-1 gap-x-6 gap-y-1.5 sm:grid-cols-2">
        <Slider label="字号" value={style.bodySize} min={RANGE.bodySize[0]} max={RANGE.bodySize[1]} step={0.1} unit="pt"
          onChange={(v) => set({ bodySize: v })} />
        <Slider label="行距" value={style.lineHeight} min={RANGE.lineHeight[0]} max={RANGE.lineHeight[1]} step={0.01} unit=""
          onChange={(v) => set({ lineHeight: v })} />
        <Slider label="分节间距" value={style.sectionGap} min={RANGE.sectionGap[0]} max={RANGE.sectionGap[1]} step={0.5} unit="pt"
          onChange={(v) => set({ sectionGap: v })} />
        <Slider label="条目间距" value={style.itemGap} min={RANGE.itemGap[0]} max={RANGE.itemGap[1]} step={0.5} unit="pt"
          onChange={(v) => set({ itemGap: v })} />
        <Slider label="上下边距" value={style.margin.top} min={RANGE.margin[0]} max={RANGE.margin[1]} step={0.5} unit="mm"
          onChange={(v) => set({ margin: { ...style.margin, top: v, bottom: v } })} />
        <Slider label="左右边距" value={style.margin.left} min={RANGE.margin[0]} max={RANGE.margin[1]} step={0.5} unit="mm"
          onChange={(v) => set({ margin: { ...style.margin, left: v, right: v } })} />
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-[12.5px]" style={{ fontSize: 12.5 }}>
        <label className={"flex items-center gap-1.5 " + (hasPhoto ? "text-[var(--foreground)]" : muted)}
          title={hasPhoto ? undefined : "先在档案里上传证件照"}>
          <input type="checkbox" checked={style.photo} disabled={!hasPhoto} onChange={(e) => set({ photo: e.target.checked })} />
          证件照
        </label>
        <span className="flex items-center gap-2">
          <span className={muted}>校徽</span>
          <button type="button" onClick={() => file.current?.click()} disabled={uploading} style={{ fontSize: 12.5 }}
            className={chip(false)}>{uploading ? "上传中…" : style.logo ? "更换" : "上传"}</button>
          {style.logo && (
            <button type="button" onClick={() => set({ logo: null })} style={{ fontSize: 12.5 }} className={chip(false)}>去掉</button>
          )}
          <input ref={file} type="file" accept="image/png,image/jpeg,image/svg+xml,image/webp" hidden
            onChange={(e) => void uploadLogo(e.target.files?.[0])} />
        </span>
        {(notice || error) && <span role="status" className={error ? "text-red-600" : muted}>{error ?? notice}</span>}
      </div>
    </div>
  );
}
