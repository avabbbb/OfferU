"use client";

import { useEffect, useState } from "react";
import { normalizeTemplateSettings, TEMPLATE_OPTIONS } from "./templates/templateSettings";

function NumberSetting({ label, value, min, max, step, className, onChange }: {
  label: string; value: number; min: number; max: number; step: number;
  className: string; onChange: (value: string) => void;
}) {
  const [text, setText] = useState(String(value));
  const [focused, setFocused] = useState(false);
  useEffect(() => { if (!focused) setText(String(value)); }, [value, focused]);
  return <label className="block text-[11px] font-bold">{label}
    <input aria-label={label} type="number" min={min} max={max} step={step} value={text} className={className}
      onFocus={() => setFocused(true)}
      onChange={(event) => {
        const next = event.target.value;
        setText(next);
        const number = Number(next);
        if (next !== "" && Number.isFinite(number) && number >= min && number <= max) onChange(next);
      }}
      onBlur={() => {
        const number = text === "" ? value : Number(text);
        const next = String(Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : value);
        onChange(next); setText(next); setFocused(false);
      }} />
  </label>;
}

export default function ResumeDesignPanel({ config, onChange, onUpload, uploading }: {
  config: Record<string, string>;
  onChange: (key: string, value: string) => void;
  onUpload: (kind: "photo" | "logo", file: File | null) => Promise<void>;
  uploading: boolean;
}) {
  const settings = normalizeTemplateSettings(config);
  const exact = settings.exact;
  const control = "mt-1 w-full rounded-lg border border-[var(--border-strong)]/15 bg-white px-2 py-2 text-xs";
  const numberInput = (key: string, label: string, value: number, min: number, max: number, step = 0.5) => (
    <NumberSetting key={key} label={label} value={value} min={min} max={max} step={step} className={control} onChange={(next) => onChange(key, next)} />
  );
  return (
    <fieldset disabled={uploading} className="space-y-3 rounded-xl border border-[var(--border-strong)]/15 bg-[var(--surface)] p-3" data-testid="resume-design-panel">
      <label className="block text-[11px] font-bold">模板
        <select aria-label="简历模板" value={settings.template} onChange={(event) => onChange("template", event.target.value)} className={control}>
          {TEMPLATE_OPTIONS.map((template) => <option key={template.id} value={template.id}>{template.name}</option>)}
        </select>
      </label>
      <label className="block text-[11px] font-bold">页面
        <select aria-label="页面尺寸" value={settings.pageSize} onChange={(event) => onChange("pageSize", event.target.value)} className={control}><option value="A4">A4</option><option value="LETTER">Letter</option></select>
      </label>
      <div className="grid grid-cols-2 gap-2">
        <label className="text-[11px] font-bold">标题颜色<input aria-label="标题颜色" type="color" value={exact.headingColor} onChange={(event) => onChange("accentColorHex", event.target.value)} className={`${control} h-9 p-1`} /></label>
        <label className="text-[11px] font-bold">分隔线颜色<input aria-label="分隔线颜色" type="color" value={exact.ruleColor} onChange={(event) => onChange("ruleColor", event.target.value)} className={`${control} h-9 p-1`} /></label>
        {numberInput("bodySize", "正文字号 (pt)", exact.bodySize, 8, 20)}
        {numberInput("headingSize", "标题字号 (pt)", exact.headingSize, 8, 28)}
        {numberInput("nameSize", "姓名字号 (pt)", exact.nameSize, 10, 40)}
        {numberInput("lineHeight", "行高", exact.lineHeight, 1, 2, 0.01)}
        {numberInput("sectionGap", "模块间距 (pt)", exact.sectionGap, 0, 30)}
        {numberInput("itemGap", "条目间距 (pt)", exact.itemGap, 0, 20)}
        {numberInput("paragraphGap", "段落间距 (pt)", exact.paragraphGap, 0, 16)}
        {numberInput("headerGap", "抬头间距 (pt)", exact.headerGap, 0, 30)}
      </div>
      <p className="text-[11px] font-bold">页边距</p>
      <div className="grid grid-cols-2 gap-2">
        {([ ["top", "上"], ["right", "右"], ["bottom", "下"], ["left", "左"] ] as const).map(([key, label]) => numberInput(`margin${key[0].toUpperCase()}${key.slice(1)}`, `${label}边距 (mm)`, settings.margins[key], 3, 30))}
      </div>
      <p className="text-[11px] font-bold">照片与校徽 · 中文经典模板</p>
      <p className="text-[10px] text-[var(--foreground-muted)]">支持 JPG、PNG、WebP，最大 5 MB。照片按区域裁切，校徽保持原比例。</p>
      {([ ["photo", "照片"], ["logo", "校徽"] ] as const).map(([kind, label]) => (
        <div key={kind} className="space-y-2">
          <button type="button" className="text-[11px] underline" onClick={() => void onUpload(kind, null)}>移除{label}</button>
          <label className="block text-[11px] font-bold">上传{label}
            <input aria-label={`上传${label}`} type="file" accept="image/jpeg,image/png,image/webp" className="mt-2 block w-full text-[10px]" onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (file) void onUpload(kind, file);
            }} />
          </label>
          <div className="grid grid-cols-2 gap-2">
            {numberInput(`${kind}Width`, `${label}宽 (mm)`, exact[`${kind}Width`], 10, kind === "photo" ? 50 : 65)}
            {numberInput(`${kind}Height`, `${label}高 (mm)`, exact[`${kind}Height`], kind === "photo" ? 10 : 5, kind === "photo" ? 60 : 40)}
          </div>
        </div>
      ))}
      {uploading && <p role="status" className="text-xs">正在保存图片…</p>}
    </fieldset>
  );
}
