"use client";

// 左侧表单：只改 doc.resume 这棵树（基本信息 + 模块 / 条目 / 要点），增删、排序、隐藏都在这里。
// 预览里点到的 data-path 由上层换成 focus（模块 / 条目 id），这里展开并滚过去。
import { useEffect, useRef, useState } from "react";

import {
  emptyItem, emptySection, ITEM_FIELDS, move, type Resume, type ResumeBasics, type ResumeItem, type ResumeSection,
  SECTION_LABEL, SECTION_TYPES, type SectionType, updateItem, updateSection,
} from "@/lib/resumeModel";

export type FormFocus = { sectionId?: string; itemId?: string; basics?: boolean; at: number };

type Props = { resume: Resume; onChange: (next: Resume) => void; focus?: FormFocus | null };

const input = "w-full rounded border border-[var(--border)] bg-transparent px-2 py-1 text-[13px] text-[var(--foreground)] outline-none focus:border-[var(--foreground-muted)]";
const label = "block text-[12px] text-[var(--foreground-muted)]";
const ghost = "px-1 text-[12px] text-[var(--foreground-muted)] hover:text-[var(--foreground)] disabled:opacity-30";

function Arrows({ index, count, onMove }: { index: number; count: number; onMove: (to: number) => void }) {
  return (
    <>
      <button type="button" className={ghost} disabled={index === 0} onClick={() => onMove(index - 1)} aria-label="上移">↑</button>
      <button type="button" className={ghost} disabled={index === count - 1} onClick={() => onMove(index + 1)} aria-label="下移">↓</button>
    </>
  );
}

function Bullets({ bullets, onChange }: { bullets: string[]; onChange: (next: string[]) => void }) {
  const set = (i: number, value: string) => onChange(bullets.map((b, k) => (k === i ? value : b)));
  return (
    <div className="space-y-1.5">
      {bullets.map((b, i) => (
        <div key={i} className="flex items-start gap-1.5">
          <span className="pt-1 text-[13px] text-[var(--foreground-muted)]">·</span>
          <textarea value={b} rows={2} onChange={(e) => set(i, e.target.value)} aria-label={"要点 " + (i + 1)}
            className={input + " resize-y"} />
          <div className="flex shrink-0 items-center pt-1">
            <Arrows index={i} count={bullets.length} onMove={(to) => onChange(move(bullets, i, to))} />
            <button type="button" className={ghost} aria-label="删除要点" onClick={() => onChange(bullets.filter((_, k) => k !== i))}>×</button>
          </div>
        </div>
      ))}
      <button type="button" className={ghost} onClick={() => onChange([...bullets, ""])}>+ 要点</button>
    </div>
  );
}

function ItemForm({ type, item, onPatch }: { type: SectionType; item: ResumeItem; onPatch: (patch: Partial<ResumeItem>) => void }) {
  const fields = ITEM_FIELDS[type];
  const field = (key: "title" | "subtitle" | "location" | "date", name: string) => name ? (
    <label className="block space-y-1">
      <span className={label}>{name}</span>
      <input value={item[key]} onChange={(e) => onPatch({ [key]: e.target.value } as Partial<ResumeItem>)} className={input} />
    </label>
  ) : null;
  return (
    <div className="space-y-2">
      {fields && (
        <div className="grid grid-cols-2 gap-2">
          {field("title", fields.title)}{field("subtitle", fields.subtitle)}{field("location", fields.location)}{field("date", fields.date)}
        </div>
      )}
      <label className="block space-y-1">
        <span className={label}>{fields ? "描述（可选）" : "内容"}</span>
        <textarea value={item.text} rows={fields ? 2 : 3} onChange={(e) => onPatch({ text: e.target.value })} className={input + " resize-y"} />
      </label>
      <div className="space-y-1">
        <span className={label}>要点</span>
        <Bullets bullets={item.bullets} onChange={(bullets) => onPatch({ bullets })} />
      </div>
    </div>
  );
}

function SectionForm({ resume, section, index, open, onToggle, onChange }: {
  resume: Resume; section: ResumeSection; index: number; open: boolean; onToggle: () => void; onChange: (next: Resume) => void;
}) {
  const patch = (fn: (s: ResumeSection) => ResumeSection) => onChange(updateSection(resume, section.id, fn));
  return (
    <section id={"rf-sec-" + section.id} className="border-b border-[var(--border)] py-3">
      <div className="flex items-center gap-1">
        <button type="button" className={ghost} onClick={onToggle} aria-expanded={open} aria-label={open ? "收起" : "展开"}>{open ? "▾" : "▸"}</button>
        <input value={section.title} onChange={(e) => patch((s) => ({ ...s, title: e.target.value }))} aria-label="模块标题"
          className={"min-w-0 flex-1 bg-transparent text-[14px] font-medium outline-none " + (section.hidden ? "text-[var(--foreground-muted)] line-through" : "text-[var(--foreground)]")} />
        <button type="button" className={ghost} onClick={() => patch((s) => ({ ...s, hidden: !s.hidden }))}>{section.hidden ? "显示" : "隐藏"}</button>
        <Arrows index={index} count={resume.sections.length} onMove={(to) => onChange({ ...resume, sections: move(resume.sections, index, to) })} />
        <button type="button" className={ghost} aria-label="删除模块"
          onClick={() => onChange({ ...resume, sections: resume.sections.filter((s) => s.id !== section.id) })}>删除</button>
      </div>
      {open && (
        <div className="mt-2 space-y-3 pl-5">
          {section.items.map((item, j) => (
            <div key={item.id} id={"rf-item-" + item.id} className="space-y-2 border-l border-[var(--border)] pl-3">
              <div className="flex items-center gap-1">
                <span className="flex-1 truncate text-[12px] text-[var(--foreground-muted)]">{item.title || "条目 " + (j + 1)}</span>
                <Arrows index={j} count={section.items.length} onMove={(to) => patch((s) => ({ ...s, items: move(s.items, j, to) }))} />
                <button type="button" className={ghost} aria-label="删除条目"
                  onClick={() => patch((s) => ({ ...s, items: s.items.filter((it) => it.id !== item.id) }))}>删除</button>
              </div>
              <ItemForm type={section.type} item={item} onPatch={(p) => onChange(updateItem(resume, section.id, item.id, p))} />
            </div>
          ))}
          <button type="button" className={ghost} onClick={() => patch((s) => ({ ...s, items: [...s.items, emptyItem()] }))}>+ 条目</button>
        </div>
      )}
    </section>
  );
}

export function ResumeForm({ resume, onChange, focus }: Props) {
  const root = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState<Set<string>>(() => new Set(resume.sections.slice(0, 1).map((s) => s.id)));
  const [adding, setAdding] = useState<SectionType>("project");

  useEffect(() => {
    if (!focus) return;
    const sectionId = focus.sectionId;
    if (sectionId) setOpen((prev) => new Set(prev).add(sectionId));
    const target = focus.itemId ? "rf-item-" + focus.itemId : sectionId ? "rf-sec-" + sectionId : focus.basics ? "rf-basics" : "";
    if (!target) return;
    requestAnimationFrame(() => {
      const el = root.current?.querySelector<HTMLElement>("#" + CSS.escape(target));
      el?.scrollIntoView({ block: "start", behavior: "smooth" });
      el?.querySelector<HTMLElement>("input, textarea")?.focus({ preventScroll: true });
    });
  }, [focus]);

  const toggle = (id: string) => setOpen((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  });
  const setBasics = (patch: Partial<ResumeBasics>) => onChange({ ...resume, basics: { ...resume.basics, ...patch } });
  const addSection = () => {
    const section = emptySection(adding);
    onChange({ ...resume, sections: [...resume.sections, section] });
    setOpen((prev) => new Set(prev).add(section.id));
  };

  return (
    <div ref={root} className="min-w-0 flex-1 overflow-auto px-6 py-4">
      <section id="rf-basics" className="space-y-2 border-b border-[var(--border)] pb-4">
        <h2 className="text-[14px] font-medium text-[var(--foreground)]">基本信息</h2>
        <div className="grid grid-cols-2 gap-2">
          <label className="block space-y-1">
            <span className={label}>姓名</span>
            <input value={resume.basics.name} onChange={(e) => setBasics({ name: e.target.value })} className={input} />
          </label>
          <label className="block space-y-1">
            <span className={label}>求职意向</span>
            <input value={resume.basics.target} onChange={(e) => setBasics({ target: e.target.value })} className={input} />
          </label>
        </div>
        <label className="block space-y-1">
          <span className={label}>联系方式（一行一项：电话、邮箱、城市、主页）</span>
          <textarea value={resume.basics.contacts.join("\n")} rows={3} onChange={(e) => setBasics({ contacts: e.target.value.split("\n") })}
            className={input + " resize-y"} />
        </label>
      </section>
      {resume.sections.map((section, i) => (
        <SectionForm key={section.id} resume={resume} section={section} index={i} open={open.has(section.id)}
          onToggle={() => toggle(section.id)} onChange={onChange} />
      ))}
      <div className="flex items-center gap-2 py-4">
        <select value={adding} onChange={(e) => setAdding(e.target.value as SectionType)} aria-label="模块类型"
          className="rounded border border-[var(--border)] bg-transparent px-2 py-1 text-[13px] text-[var(--foreground)]">
          {SECTION_TYPES.map((t) => <option key={t} value={t}>{SECTION_LABEL[t]}</option>)}
        </select>
        <button type="button" onClick={addSection} className="text-[13px] text-[var(--foreground)] hover:underline">+ 添加模块</button>
      </div>
    </div>
  );
}
