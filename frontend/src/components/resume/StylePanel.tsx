"use client";

// 顶部横向工具栏：模板、字体、字号、行距、间距、页边距、主题色、照片、校徽、智能一页，下载放最右。
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

function Num({ label, value, min, max, step, unit, onChange }: {
  label: string; value: number; min: number; max: number; step: number; unit: string; onChange: (v: number) => void;
}) {
  return (
    <label className="flex items-center gap-1">
      <span className={muted}>{label}</span>
      <input type="number" min={min} max={max} step={step} value={value} aria-label={label}
        onChange={(e) => { const v = Number(e.target.value); if (Number.isFinite(v) && v >= min && v <= max) onChange(v); }}
        className="w-14 rounded border border-[var(--border)] bg-transparent px-1 py-0.5 text-right tabular-nums text-[var(--foreground)] outline-none" />
      {unit && <span className={muted}>{unit}</span>}
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

  const select = "rounded border border-[var(--border)] bg-transparent px-1.5 py-0.5 text-[var(--foreground)] outline-none";
  return (
    <div role="toolbar" aria-label="排版" style={{ fontSize: 12.5 }}
      className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-[var(--border)] px-6 py-2 text-[12.5px]">
      <button type="button" onClick={onFit} disabled={fitting} style={{ fontSize: 12.5 }}
        className="rounded border border-[var(--border)] px-2.5 py-0.5 text-[var(--foreground)] hover:bg-[var(--surface)] disabled:opacity-50">
        {fitting ? "排版中…" : "智能一页"}
      </button>
      <label className="flex items-center gap-1">
        <span className={muted}>模板</span>
        <select value={style.template} aria-label="模板" className={select}
          onChange={(e) => onChange(withTemplate(style, e.target.value as ResumeTemplate))}>
          {(Object.keys(RESUME_TEMPLATES) as ResumeTemplate[]).map((id) => <option key={id} value={id}>{RESUME_TEMPLATES[id]}</option>)}
        </select>
      </label>
      <label className="flex items-center gap-1">
        <span className={muted}>字体</span>
        <select value={style.font} aria-label="字体" className={select} onChange={(e) => set({ font: e.target.value as ResumeFont })}>
          {(Object.keys(RESUME_FONTS) as ResumeFont[]).map((id) => <option key={id} value={id}>{RESUME_FONTS[id]}</option>)}
        </select>
      </label>
      <Num label="字号" value={style.bodySize} min={RANGE.bodySize[0]} max={RANGE.bodySize[1]} step={0.1} unit="pt"
        onChange={(v) => set({ bodySize: v })} />
      <Num label="行距" value={style.lineHeight} min={RANGE.lineHeight[0]} max={RANGE.lineHeight[1]} step={0.05} unit=""
        onChange={(v) => set({ lineHeight: v })} />
      <Num label="分节" value={style.sectionGap} min={RANGE.sectionGap[0]} max={RANGE.sectionGap[1]} step={0.5} unit="pt"
        onChange={(v) => set({ sectionGap: v })} />
      <Num label="条目" value={style.itemGap} min={RANGE.itemGap[0]} max={RANGE.itemGap[1]} step={0.5} unit="pt"
        onChange={(v) => set({ itemGap: v })} />
      <Num label="上下边距" value={style.margin.top} min={RANGE.margin[0]} max={RANGE.margin[1]} step={0.5} unit="mm"
        onChange={(v) => set({ margin: { ...style.margin, top: v, bottom: v } })} />
      <Num label="左右边距" value={style.margin.left} min={RANGE.margin[0]} max={RANGE.margin[1]} step={0.5} unit="mm"
        onChange={(v) => set({ margin: { ...style.margin, left: v, right: v } })} />
      <div role="radiogroup" aria-label="主题色" className="flex items-center gap-1.5">
        {ACCENTS.map((color) => (
          <button key={color} type="button" role="radio" aria-checked={style.accent === color} aria-label={"主题色 " + color}
            onClick={() => set({ accent: color })} style={{ background: color }}
            className={"h-3.5 w-3.5 rounded-full " + (style.accent === color ? "ring-2 ring-[var(--foreground)] ring-offset-1" : "")} />
        ))}
      </div>
      <label className={"flex items-center gap-1 " + (hasPhoto ? "text-[var(--foreground)]" : muted)} title={hasPhoto ? undefined : "先在档案里上传证件照"}>
        <input type="checkbox" checked={style.photo} disabled={!hasPhoto} onChange={(e) => set({ photo: e.target.checked })} />
        证件照
      </label>
      <span className="flex items-center gap-1.5">
        <span className={muted}>校徽</span>
        <button type="button" onClick={() => file.current?.click()} disabled={uploading} style={{ fontSize: 12.5 }}
          className={chip(false)}>{uploading ? "上传中…" : style.logo ? "更换" : "上传"}</button>
        {style.logo && <button type="button" onClick={() => set({ logo: null })} style={{ fontSize: 12.5 }} className={chip(false)}>去掉</button>}
        <input ref={file} type="file" accept="image/png,image/jpeg,image/svg+xml,image/webp" hidden
          onChange={(e) => void uploadLogo(e.target.files?.[0])} />
      </span>
      {(notice || error) && <span role="status" className={error ? "text-red-600" : muted}>{error ?? notice}</span>}
      <span className="flex-1" />
      {/* globals.css 里的 a { color: inherit } 不在 layer 里，会压过 Tailwind 的 text-，文字色只能写在 style 里 */}
      <a href={pdfHref} download style={{ fontSize: 12.5, color: "var(--background)" }}
        className="rounded bg-[var(--foreground)] px-3 py-1 font-medium">下载 PDF</a>
    </div>
  );
}
