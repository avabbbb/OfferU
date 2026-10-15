"use client";

import { useEffect, useState, type ReactNode } from "react";
import { normalizeTemplateSettings, TEMPLATE_OPTIONS, type ResumeTemplateType } from "./templates/templateSettings";

function NumberSetting({ label, value, min, max, step, className, onChange }: {
  label: string; value: number; min: number; max: number; step: number;
  className: string; onChange: (value: string) => void;
}) {
  const [text, setText] = useState(String(value));
  const [focused, setFocused] = useState(false);
  useEffect(() => { if (!focused) setText(String(value)); }, [value, focused]);
  return <label className="block text-[11px]">{label}
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

const THEME_COLORS = [
  ["#1B365D", "墨蓝"],
  ["#2F4A3A", "松绿"],
  ["#7A3B2E", "赭红"],
  ["#4A3B6B", "黛紫"],
  ["#2B2B2B", "墨黑"],
] as const;

const round = (value: number, digits = 1) => String(Math.round(value * 10 ** digits) / 10 ** digits);

/** 以模板自身默认值为“标准”，紧凑/宽松按比例推算，避免每个模板各维护一套数字。 */
function densityPreset(template: ResumeTemplateType, density: "compact" | "standard" | "loose"): Record<string, string> {
  const base = normalizeTemplateSettings({ template });
  const k = density === "compact" ? { font: 0.95, line: -0.1, gap: 0.65, margin: -2 } : density === "loose" ? { font: 1.05, line: 0.1, gap: 1.3, margin: 2 } : { font: 1, line: 0, gap: 1, margin: 0 };
  const { exact, margins } = base;
  return {
    bodySize: round(exact.bodySize * k.font),
    lineHeight: round(exact.lineHeight + k.line, 2),
    sectionGap: round(exact.sectionGap * k.gap),
    itemGap: round(exact.itemGap * k.gap),
    marginTop: round(Math.max(3, margins.top + k.margin)),
    marginBottom: round(Math.max(3, margins.bottom + k.margin)),
    marginLeft: round(Math.max(3, margins.left + k.margin)),
    marginRight: round(Math.max(3, margins.right + k.margin)),
  };
}

export default function ResumeDesignPanel({ config, onChange, onPatch, onUpload, uploading, renderThumbnail }: {
  config: Record<string, string>;
  onChange: (key: string, value: string) => void;
  onPatch: (patch: Record<string, string>) => void;
  onUpload: (kind: "photo" | "logo", file: File | null) => Promise<void>;
  uploading: boolean;
  renderThumbnail?: (template: ResumeTemplateType) => ReactNode;
}) {
  const settings = normalizeTemplateSettings(config);
  const exact = settings.exact;
  const paper = settings.template === "paper";
  const control = "mt-1 w-full rounded-md border border-[var(--border-strong)]/15 bg-white px-2 py-1.5 text-xs";
  const numberInput = (key: string, label: string, value: number, min: number, max: number, step = 0.5) => (
    <NumberSetting key={key} label={label} value={value} min={min} max={max} step={step} className={control} onChange={(next) => onChange(key, next)} />
  );
  const densities = (["compact", "standard", "loose"] as const).map((id) => ({ id, label: { compact: "紧凑", standard: "标准", loose: "宽松" }[id], patch: densityPreset(settings.template, id) }));
  const current = { bodySize: String(exact.bodySize), lineHeight: String(exact.lineHeight), sectionGap: String(exact.sectionGap), itemGap: String(exact.itemGap), marginTop: String(settings.margins.top), marginBottom: String(settings.margins.bottom), marginLeft: String(settings.margins.left), marginRight: String(settings.margins.right) } as Record<string, string>;
  const activeDensity = densities.find(({ patch }) => Object.entries(patch).every(([key, value]) => Number(current[key]) === Number(value)))?.id;
  const chip = (active: boolean) => `rounded-md border px-2 py-1.5 text-[11px] ${active ? "border-black bg-black text-white" : "border-[var(--border-strong)]/15 hover:bg-black/5"}`;
  const label = "mb-1.5 text-[11px] font-bold text-[var(--foreground-muted)]";

  return (
    <fieldset disabled={uploading} className="space-y-4 rounded-xl border border-[var(--border-strong)]/15 bg-[var(--surface)] p-3" data-testid="resume-design-panel">
      <div>
        <p className={label}>模板</p>
        <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="简历模板">
          {TEMPLATE_OPTIONS.map((template) => (
            <button key={template.id} type="button" role="radio" aria-checked={settings.template === template.id} title={template.description} onClick={() => onChange("template", template.id)} className={`overflow-hidden rounded-lg border text-left ${settings.template === template.id ? "border-black ring-1 ring-black" : "border-[var(--border-strong)]/15 hover:border-[var(--border-strong)]/40"}`} data-testid={`resume-template-${template.id}`}>
              <div className="pointer-events-none h-[150px] overflow-hidden bg-[#e3e0d6]" aria-hidden="true">
                {renderThumbnail ? <div className="origin-top-left scale-[0.19]">{renderThumbnail(template.id)}</div> : null}
              </div>
              <p className="truncate px-2 py-1.5 text-[11px] font-bold">{template.name}</p>
            </button>
          ))}
        </div>
      </div>

      <div>
        <p className={label}>疏密</p>
        <div className="grid grid-cols-3 gap-1.5">{densities.map(({ id, label: text, patch }) => <button key={id} type="button" aria-pressed={activeDensity === id} onClick={() => onPatch(patch)} className={chip(activeDensity === id)} data-testid={`resume-density-${id}`}>{text}</button>)}</div>
      </div>

      <div>
        <p className={label}>主题色</p>
        <div className="flex items-center gap-2">
          {THEME_COLORS.map(([hex, name]) => <button key={hex} type="button" aria-label={name} title={name} aria-pressed={exact.headingColor.toLowerCase() === hex.toLowerCase()} onClick={() => onChange("accentColorHex", hex)} className={`h-6 w-6 rounded-full border-2 ${exact.headingColor.toLowerCase() === hex.toLowerCase() ? "border-black" : "border-white shadow-[0_0_0_1px_rgba(0,0,0,0.15)]"}`} style={{ background: hex }} />)}
          <label className="ml-1 text-[10px] text-[var(--foreground-muted)]" title="自定义颜色">自定义<input aria-label="自定义主题色" type="color" value={exact.headingColor} onChange={(event) => onChange("accentColorHex", event.target.value)} className="ml-1 h-6 w-6 cursor-pointer rounded border-0 bg-transparent p-0 align-middle" /></label>
        </div>
      </div>

      {paper && <div className="grid grid-cols-2 gap-3">
        <div><p className={label}>字体</p><div className="grid grid-cols-2 gap-1.5">{([["song", "宋体", "系统自带的宋体系，可免费商用"], ["kai", "今楷", "Kami 用的仓耳今楷：第一次使用要下载约 38 MB，仅限个人非商业使用"]] as const).map(([id, text, hint]) => { const active = (config.paperFont === "kai" ? "kai" : "song") === id; return <button key={id} type="button" title={hint} aria-pressed={active} onClick={() => onChange("paperFont", id)} className={chip(active)} data-testid={`resume-font-${id}`}>{text}</button>; })}</div>{config.paperFont === "kai" && <p className="mt-1 text-[10px] leading-snug text-[var(--foreground-muted)]">今楷仅限个人非商业使用，首次需下载约 38 MB。</p>}</div>
        <div><p className={label}>纸色</p><div className="grid grid-cols-2 gap-1.5">{([["parchment", "暖纸"], ["white", "白纸"]] as const).map(([id, text]) => { const active = (config.paperTone === "white" ? "white" : "parchment") === id; return <button key={id} type="button" aria-pressed={active} onClick={() => onChange("paperTone", id)} className={chip(active)} data-testid={`resume-paper-tone-${id}`}>{text}</button>; })}</div></div>
      </div>}

      <div>
        <p className={label}>照片与校徽</p>
        <div className="grid grid-cols-2 gap-1.5">
          {([["photo", "照片"], ["logo", "校徽"]] as const).map(([kind, text]) => (
            <div key={kind} className="flex items-center justify-between rounded-md border border-[var(--border-strong)]/15 px-2 py-1.5 text-[11px]">
              <label className="cursor-pointer underline-offset-2 hover:underline">上传{text}<input aria-label={`上传${text}`} type="file" accept="image/jpeg,image/png,image/webp" className="hidden" onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ""; if (file) void onUpload(kind, file); }} /></label>
              <button type="button" className="text-[var(--foreground-muted)] hover:text-black" onClick={() => void onUpload(kind, null)}>移除</button>
            </div>
          ))}
        </div>
        {paper && <p className="mt-1.5 text-[10px] text-[var(--foreground-muted)]">填好学校后会自动配校徽；也可以在页眉上直接点。</p>}
      </div>

      <details className="group rounded-md border border-[var(--border-strong)]/10 px-2 py-1.5" data-testid="resume-design-advanced">
        <summary className="cursor-pointer text-[11px] font-bold text-[var(--foreground-muted)]">精细调整</summary>
        <div className="mt-2 space-y-3">
          <label className="block text-[11px]">纸张
            <select aria-label="页面尺寸" value={settings.pageSize} onChange={(event) => onChange("pageSize", event.target.value)} className={control}><option value="A4">A4</option><option value="LETTER">Letter</option></select>
          </label>
          <div className="grid grid-cols-2 gap-2">
            {numberInput("bodySize", "正文字号 (pt)", exact.bodySize, 8, 20)}
            {numberInput("headingSize", "标题字号 (pt)", exact.headingSize, 8, 28)}
            {numberInput("nameSize", "姓名字号 (pt)", exact.nameSize, 10, 40)}
            {numberInput("lineHeight", "行高", exact.lineHeight, 1, 2, 0.01)}
            {numberInput("sectionGap", "模块间距 (pt)", exact.sectionGap, 0, 30)}
            {numberInput("itemGap", "条目间距 (pt)", exact.itemGap, 0, 20)}
            {numberInput("paragraphGap", "段落间距 (pt)", exact.paragraphGap, 0, 16)}
            {numberInput("headerGap", "抬头间距 (pt)", exact.headerGap, 0, 30)}
            <label className="text-[11px]">分隔线颜色<input aria-label="分隔线颜色" type="color" value={exact.ruleColor} onChange={(event) => onChange("ruleColor", event.target.value)} className={`${control} h-8 p-1`} /></label>
          </div>
          <div className="grid grid-cols-2 gap-2">
            {([["top", "上"], ["right", "右"], ["bottom", "下"], ["left", "左"]] as const).map(([key, text]) => numberInput(`margin${key[0].toUpperCase()}${key.slice(1)}`, `${text}边距 (mm)`, settings.margins[key], 3, 30))}
          </div>
          <div className="grid grid-cols-2 gap-2">
            {numberInput("photoWidth", "照片宽 (mm)", exact.photoWidth, 10, 50)}
            {numberInput("photoHeight", "照片高 (mm)", exact.photoHeight, 10, 60)}
            {numberInput("logoWidth", "校徽宽 (mm)", exact.logoWidth, 10, 65)}
            {numberInput("logoHeight", "校徽高 (mm)", exact.logoHeight, 5, 40)}
          </div>
        </div>
      </details>
      {uploading && <p role="status" className="text-xs">正在保存图片…</p>}
    </fieldset>
  );
}
