"use client";

// 右栏「编辑内容」（参考 offershow 简历编辑器）：一次只编辑左栏选中的一个模块。
// 顶上是模块名（可改）；每个条目一块：「教育经历 1」+ 删除 / 上移 / 下移，两列表单（学校、专业、学历下拉、开始 / 结束时间，结束不填即至今），
// 带常驻格式条的描述、要点，底部「AI 润色」交给右侧 OfferU Agent；最后「+ 添加条目」。
// 字段换算见 lib/resumeFields（不加新字段，后端和 PDF 不变）。
import { ArrowDown, ArrowUp, Pencil, Plus, Sparkles, Trash2, X } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";

import { Button, Field, Input, Select } from "@/components/ui";
import { composeToAgent } from "@/lib/agentCompose";
import { DEGREES, fromMonthInput, joinDate, joinDegree, splitDate, splitDegree, toMonthInput } from "@/lib/resumeFields";
import {
  CONTACT_PRESETS, emptyItem, ITEM_FIELDS, move, type Resume, type ResumeBasics, type ResumeContact, type ResumeItem,
  type ResumeSection, SECTION_LABEL, type SectionType, updateItem, updateSection,
} from "@/lib/resumeModel";
import { plainText } from "@/lib/richMarkup";

import { Bullets } from "./Bullets";
import { RichText } from "./RichText";

// 单个年月：能用月份选择框就用；旧数据里认不出的写法（「大二暑假」）退回文本框，不丢字。
function MonthField({ label, value, onChange, placeholder }: { label: string; value: string; onChange: (v: string) => void; placeholder?: string }) {
  const month = toMonthInput(value);
  return (
    <Field label={label}>
      {(id) => month || !value
        ? <Input id={id} type="month" value={month} placeholder={placeholder} onChange={(e) => onChange(fromMonthInput(e.target.value))} />
        : <Input id={id} value={value} placeholder="2021.09" onChange={(e) => onChange(e.target.value)} />}
    </Field>
  );
}

function TextField({ label, value, onChange, required, placeholder }: {
  label: string; value: string; onChange: (v: string) => void; required?: boolean; placeholder?: string;
}) {
  return (
    <Field label={required ? <>{label}<span className="re-required" aria-hidden> *</span></> : label}>
      {(id) => <Input id={id} value={value} placeholder={placeholder} aria-required={required || undefined} onChange={(e) => onChange(e.target.value)} />}
    </Field>
  );
}

// 时间字段：工作 / 项目这类是开始 + 结束；奖项只有一个时间。
const RANGED: SectionType[] = ["education", "work", "internship", "project", "campus", "custom"];

function ItemFields({ type, item, onPatch }: { type: SectionType; item: ResumeItem; onPatch: (patch: Partial<ResumeItem>) => void }) {
  const f = ITEM_FIELDS[type];
  if (!f) return null;
  const { start, end } = splitDate(item.date);
  const { major, degree } = splitDegree(item.subtitle);
  return (
    <div className="re-fields">
      <TextField label={f.title} required value={item.title} onChange={(title) => onPatch({ title })} />
      {type === "education" ? (
        <>
          <TextField label="专业" value={major} onChange={(m) => onPatch({ subtitle: joinDegree(m, degree) })} />
          <Field label="学历">
            {(id) => (
              <Select id={id} value={degree || undefined} placeholder="选择学历" aria-label="学历"
                options={DEGREES.map((d) => ({ value: d, label: d }))} onValueChange={(d) => onPatch({ subtitle: joinDegree(major, d) })} />
            )}
          </Field>
        </>
      ) : (
        f.subtitle && <TextField label={f.subtitle} value={item.subtitle} onChange={(subtitle) => onPatch({ subtitle })} />
      )}
      {f.location && <TextField label={f.location} value={item.location} onChange={(location) => onPatch({ location })} />}
      {RANGED.includes(type) ? (
        <>
          <MonthField label="开始时间" value={start} onChange={(s) => onPatch({ date: joinDate(s, end) })} />
          <MonthField label="结束时间（不填即为：至今）" value={end} onChange={(e) => onPatch({ date: joinDate(start, e) })} />
        </>
      ) : (
        <MonthField label={f.date} value={item.date} onChange={(date) => onPatch({ date })} />
      )}
    </div>
  );
}

// 交给右侧 OfferU Agent 润色这一条：说清是哪份简历的哪一条、只用已有事实、改完直接存回（一条改动，可撤销）。
function polishPrompt(doc: { id: number; title: string }, section: ResumeSection, index: number, item: ResumeItem) {
  const where = "「" + (section.title || SECTION_LABEL[section.type]) + "」第 " + (index + 1) + " 条" + (item.title.trim() ? "（" + item.title.trim() + "）" : "");
  const current = [plainText(item.text), ...item.bullets.map((b) => "- " + plainText(b))].filter((s) => s.trim()).join("\n");
  return "帮我润色简历《" + (doc.title || "未命名简历") + "》（doc #" + doc.id + "）里" + where + "的描述和要点。\n"
    + "要求：只用档案和记忆里有的事实，不加没有的数字；动词开头，写清做了什么、结果怎样；保留原来的加粗和列表格式。\n"
    + "改完直接 save 回这份简历（只改 doc.resume 里 id 为 " + item.id + " 的条目的 text / bullets，其他原样保留），再告诉我改了哪几句。\n\n"
    + "现在的内容：\n" + (current || "（还没写，先按标题和档案起个草）");
}

function ItemBlock({ section, item, index, count, single, doc, canPolish, flash, onPatch, onMove, onDelete }: {
  section: ResumeSection; item: ResumeItem; index: number; count: number; single: boolean; doc: { id: number; title: string };
  canPolish: boolean; flash: boolean; onPatch: (patch: Partial<ResumeItem>) => void; onMove: (to: number) => void; onDelete: () => void;
}) {
  const fields = ITEM_FIELDS[section.type];
  const label = (section.title.trim() || SECTION_LABEL[section.type]) + " " + (index + 1);
  return (
    <article id={"re-item-" + item.id} className="re-item" data-flash={flash || undefined} aria-label={single ? undefined : label}>
      {!single && (
        <header className="re-item-head">
          <h3 className="re-item-title">{label}</h3>
          <button type="button" className="ou-icon-button re-icon-danger" aria-label={"删除" + label} title="删除这一条"
            onClick={() => { if (window.confirm("删除「" + (item.title.trim() || label) + "」？（可以在「最近改动」里撤销）")) onDelete(); }}>
            <Trash2 size={15} aria-hidden />
          </button>
          <span className="re-item-rule" aria-hidden />
          <button type="button" className="ou-icon-button" aria-label={"下移" + label} title="下移" disabled={index === count - 1} onClick={() => onMove(index + 1)}>
            <ArrowDown size={15} aria-hidden />
          </button>
          <button type="button" className="ou-icon-button" aria-label={"上移" + label} title="上移" disabled={index === 0} onClick={() => onMove(index - 1)}>
            <ArrowUp size={15} aria-hidden />
          </button>
        </header>
      )}
      <ItemFields type={section.type} item={item} onPatch={onPatch} />
      <div className="re-rich">
        <span className="ou-field-label">{fields ? "描述" : "内容"}</span>
        <RichText value={item.text} rows={fields ? 3 : 6} toolbar label={fields ? label + " 描述" : section.title || SECTION_LABEL[section.type]}
          placeholder={fields ? "写几句做了什么、结果怎样；输入 / 或 、 选择格式" : "写几句，输入 / 或 、 选择格式"} onChange={(text) => onPatch({ text })} />
      </div>
      {(fields || item.bullets.length > 0) && (
        <div className="re-bullets">
          <span className="ou-field-label">要点</span>
          <Bullets bullets={item.bullets} onChange={(bullets) => onPatch({ bullets })} />
        </div>
      )}
      <footer className="re-item-foot">
        <Button size="sm" variant="secondary" className="re-polish" disabled={!canPolish} title={canPolish ? "交给右侧 OfferU 润色这一条，改完可在「最近改动」撤销" : "保存中，存好再润色"}
          onClick={() => composeToAgent({ message: polishPrompt(doc, section, index, item) })}>
          <Sparkles size={14} aria-hidden />AI 润色
        </Button>
      </footer>
    </article>
  );
}

function ContactRow({ contact, onChange, onDelete }: { contact: ResumeContact; onChange: (next: ResumeContact) => void; onDelete: () => void }) {
  return (
    <div className="re-contact">
      <Input value={contact.label} placeholder="字段名" aria-label="字段名" className="re-contact-label"
        onChange={(e) => onChange({ ...contact, label: e.target.value })} />
      <Input value={contact.value} placeholder="内容" aria-label={(contact.label || "联系方式") + " 内容"}
        onChange={(e) => onChange({ ...contact, value: e.target.value })} />
      <button type="button" className="ou-icon-button re-icon-danger" aria-label={"删除" + (contact.label || "这一项")} title="删除" onClick={onDelete}>
        <X size={15} aria-hidden />
      </button>
    </div>
  );
}

function BasicsEditor({ basics, onChange, extra }: { basics: ResumeBasics; onChange: (patch: Partial<ResumeBasics>) => void; extra?: ReactNode }) {
  const contacts = basics.contacts;
  const setContacts = (next: ResumeContact[]) => onChange({ contacts: next });
  return (
    <article id="re-item-basics" className="re-item">
      <div className="re-fields">
        <TextField label="姓名" required value={basics.name} onChange={(name) => onChange({ name })} />
        <TextField label="求职意向" value={basics.target} placeholder="如：数据分析实习" onChange={(target) => onChange({ target })} />
      </div>
      <div className="re-contacts">
        <span className="ou-field-label">联系方式</span>
        {contacts.map((c, i) => (
          <ContactRow key={i} contact={c} onChange={(next) => setContacts(contacts.map((x, k) => (k === i ? next : x)))}
            onDelete={() => setContacts(contacts.filter((_, k) => k !== i))} />
        ))}
        <div className="re-chips">
          {CONTACT_PRESETS.filter((label) => !contacts.some((c) => c.label === label)).map((label) => (
            <button key={label} type="button" className="ou-chip" onClick={() => setContacts([...contacts, { label, value: "" }])}>
              <Plus size={13} aria-hidden />{label}
            </button>
          ))}
          <button type="button" className="ou-chip" onClick={() => setContacts([...contacts, { label: "", value: "" }])}><Plus size={13} aria-hidden />自定义</button>
        </div>
      </div>
      {extra}
    </article>
  );
}

export type EditorFocus = { itemId?: string; at: number };

type Props = {
  resume: Resume;
  onChange: (next: Resume) => void;
  /** BASICS（"basics"）或 section.id。 */
  selected: string;
  doc: { id: number; title: string };
  /** 改动都存好了才能交给 Agent 润色，免得它读到旧内容。 */
  canPolish: boolean;
  /** 预览里点到某一条：滚过去并闪一下。 */
  focus?: EditorFocus | null;
  basicsExtra?: ReactNode;
  readOnly?: boolean;
};

export function ModuleEditor({ resume, onChange, selected, doc, canPolish, focus, basicsExtra, readOnly }: Props) {
  const root = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const section = resume.sections.find((s) => s.id === selected);

  // 切模块回到顶上；预览里点到的条目滚过去、闪一下，并把光标放进第一个输入框。
  useEffect(() => { root.current?.closest(".re-editor")?.scrollTo({ top: 0 }); }, [selected]);
  useEffect(() => {
    if (!focus?.itemId) return;
    const id = focus.itemId;
    const t = requestAnimationFrame(() => {
      const el = root.current?.querySelector<HTMLElement>("#" + CSS.escape("re-item-" + id));
      el?.scrollIntoView({ block: "start", behavior: "smooth" });
      el?.querySelector<HTMLElement>("input, [contenteditable]")?.focus({ preventScroll: true });
      setFlash(id);
    });
    const off = setTimeout(() => setFlash(null), 1200);
    return () => { cancelAnimationFrame(t); clearTimeout(off); };
  }, [focus]);

  const inert = { inert: readOnly ? "" : undefined } as Record<string, unknown>;

  if (!section) {
    return (
      <div ref={root} className="re-module" aria-readonly={readOnly || undefined} {...inert}>
        <header className="re-module-head"><h2 className="re-module-title">基础信息</h2></header>
        <BasicsEditor basics={resume.basics} onChange={(patch) => onChange({ ...resume, basics: { ...resume.basics, ...patch } })} extra={basicsExtra} />
      </div>
    );
  }

  const patch = (fn: (s: ResumeSection) => ResumeSection) => onChange(updateSection(resume, section.id, fn));
  const single = ITEM_FIELDS[section.type] === null;
  const items = single && !section.items.length ? [] : section.items;
  const add = () => {
    const item = emptyItem();
    patch((s) => ({ ...s, items: [...s.items, item] }));
    requestAnimationFrame(() => root.current?.querySelector("#" + CSS.escape("re-item-" + item.id))?.scrollIntoView({ block: "start", behavior: "smooth" }));
  };

  return (
    <div ref={root} className="re-module" aria-readonly={readOnly || undefined} title={readOnly ? "正在按岗位改写，写完再改" : undefined} {...inert}>
      <header className="re-module-head">
        <input ref={titleRef} value={section.title} aria-label="模块名称" className="re-module-title" size={Math.max(4, section.title.length + 1)}
          placeholder={SECTION_LABEL[section.type]} onChange={(e) => patch((s) => ({ ...s, title: e.target.value }))} />
        <button type="button" className="ou-icon-button" aria-label="改模块名" title="改模块名" onClick={() => titleRef.current?.select()}>
          <Pencil size={15} aria-hidden />
        </button>
        {section.hidden && <span className="re-hidden-note">已在左栏关掉，暂不显示在简历里</span>}
      </header>
      {items.map((item, j) => (
        <ItemBlock key={item.id} section={section} item={item} index={j} count={items.length} single={single && items.length === 1}
          doc={doc} canPolish={canPolish} flash={flash === item.id}
          onPatch={(p) => onChange(updateItem(resume, section.id, item.id, p))}
          onMove={(to) => patch((s) => ({ ...s, items: move(s.items, j, to) }))}
          onDelete={() => patch((s) => ({ ...s, items: s.items.filter((it) => it.id !== item.id) }))} />
      ))}
      {(!single || items.length === 0) && (
        <Button variant="secondary" className="re-add-item" onClick={add}><Plus size={15} aria-hidden />{single ? "填写" + (section.title || SECTION_LABEL[section.type]) : "添加条目"}</Button>
      )}
    </div>
  );
}
