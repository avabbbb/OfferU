"use client";

// 左侧表单：只改 doc.resume 这棵树（基本信息 + 模块 / 条目 / 要点），增删、排序、隐藏都在这里。
// 每个模块一张卡；条目平时只露一行摘要（标题 | 副标题 · 时间），点开才编辑。
// 预览里点到的 data-path 由上层换成 focus（模块 / 条目 id），这里展开并滚过去。
import { type PointerEvent as ReactPointerEvent, type ReactNode, useEffect, useRef, useState } from "react";

import { Menu } from "@/components/ui";

import {
  CONTACT_PRESETS, contactText, emptyItem, emptySection, ITEM_FIELDS, move, type Resume, type ResumeBasics, type ResumeContact,
  type ResumeItem, type ResumeSection,
  SECTION_LABEL, SECTION_TYPES, type SectionType, updateItem, updateSection,
} from "@/lib/resumeModel";
import { plainText } from "@/lib/richMarkup";
import { RichText } from "./RichText";

export type FormFocus = { sectionId?: string; itemId?: string; basics?: boolean; at: number };

// basicsExtra：放在基本信息卡片最下面（证件照、校徽），由上层给。
// readOnly：按岗位改写进行中，整张表单不可交互（inert 连 contentEditable 一起挡住）。
type Props = { resume: Resume; onChange: (next: Resume) => void; focus?: FormFocus | null; basicsExtra?: ReactNode; readOnly?: boolean };

// 每类模块一个线性图标（24 视框、1.6 线宽、currentColor），只为让卡片标题一眼可辨。
const ICON: Record<SectionType | "basics", string> = {
  basics: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm-7 8a7 7 0 0 1 14 0",
  education: "M3 9l9-4 9 4-9 4-9-4Zm4 2v4c0 1.5 2.2 3 5 3s5-1.5 5-3v-4",
  work: "M4 8h16v11H4zM9 8V5h6v3M4 13h16",
  internship: "M4 8h16v11H4zM9 8V5h6v3",
  project: "M4 5h7v6H4zM13 5h7v14h-7zM4 13h7v6H4z",
  campus: "M4 20V9l8-5 8 5v11M9 20v-6h6v6",
  skills: "M14 6l4 4-9 9H5v-4l9-9Zm-2 2l4 4",
  awards: "M12 14a5 5 0 1 0 0-10 5 5 0 0 0 0 10Zm-3 0-1 7 4-2 4 2-1-7",
  summary: "M5 5h14M5 10h14M5 15h9",
  custom: "M5 5h6v6H5zM13 5h6v6h-6zM5 13h6v6H5zM13 13h6v6h-6z",
};

function Icon({ kind }: { kind: SectionType | "basics" }) {
  return (
    <span className="rf-icon" aria-hidden>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
        <path d={ICON[kind]} />
      </svg>
    </span>
  );
}

// 操作按钮的线性小图标（同一套 24 视框、currentColor）。
const GLYPH = {
  up: "M12 19V5M6 11l6-6 6 6",
  down: "M12 5v14M6 13l6 6 6-6",
  trash: "M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6",
  eye: "M2 12s3.6-6 10-6 10 6 10 6-3.6 6-10 6S2 12 2 12Zm10 3a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z",
  eyeOff: "M3 3l18 18M10.6 6.1Q11.3 6 12 6c6.4 0 10 6 10 6a17 17 0 0 1-3 3.6M6.5 6.6C3.8 8.3 2 12 2 12s3.6 6 10 6c1.5 0 2.9-.3 4.1-.9M9.9 9.9a3 3 0 0 0 4.2 4.2",
  pencil: "M4 20h4L19 9l-4-4L4 16v4ZM13.5 6.5l4 4",
  chevron: "M6 9l6 6 6-6",
  plus: "M12 5v14M5 12h14",
  grip: "M9 6h.01M9 12h.01M9 18h.01M15 6h.01M15 12h.01M15 18h.01",
} as const;

function Glyph({ name }: { name: keyof typeof GLYPH }) {
  return (
    <svg className="rf-glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round"
      strokeLinejoin="round" aria-hidden>
      <path d={GLYPH[name]} />
    </svg>
  );
}

function Btn({ label, onClick, disabled, danger, children }: {
  label: string; onClick: () => void; disabled?: boolean; danger?: boolean; children: ReactNode;
}) {
  return (
    <button type="button" className="rf-btn" data-danger={danger || undefined} aria-label={label} title={label} disabled={disabled}
      onClick={(e) => { e.stopPropagation(); onClick(); }}>
      {children}
    </button>
  );
}

// 收起时朝下，展开时朝上。
function Chevron({ open }: { open: boolean }) {
  return <span className="rf-chevron" data-open={open || undefined} aria-hidden><Glyph name="chevron" /></span>;
}

function Arrows({ index, count, onMove }: { index: number; count: number; onMove: (to: number) => void }) {
  return (
    <>
      <Btn label="上移" disabled={index === 0} onClick={() => onMove(index - 1)}><Glyph name="up" /></Btn>
      <Btn label="下移" disabled={index === count - 1} onClick={() => onMove(index + 1)}><Glyph name="down" /></Btn>
    </>
  );
}

function Field({ name, wide, children }: { name: string; wide?: boolean; children: ReactNode }) {
  return (
    <label className={"rf-field" + (wide ? " col-span-2" : "")}>
      <span className="rf-label">{name}</span>
      {children}
    </label>
  );
}

// 联系方式一项：上面一行是字段名（可改）和删除，下面是内容。
function ContactField({ contact, onChange, onDelete }: {
  contact: ResumeContact; onChange: (next: ResumeContact) => void; onDelete: () => void;
}) {
  return (
    <div className="rf-field">
      <div className="flex items-center gap-1">
        <input value={contact.label} placeholder="字段名" aria-label="字段名" className="rf-contact-label"
          onChange={(e) => onChange({ ...contact, label: e.target.value })} />
        <Btn label={"删除" + (contact.label || "这一项")} danger onClick={onDelete}><Glyph name="trash" /></Btn>
      </div>
      <input value={contact.value} aria-label={contact.label || "内容"} className="rf-input"
        onChange={(e) => onChange({ ...contact, value: e.target.value })} />
    </div>
  );
}

// 要点 = 一行一块（文档式，参照 Notion / Bleep）：回车在下面新建、空块退格删掉并回到上一块、↑↓ 在块之间走。
// 悬停时左侧留白里浮出「+」（下面加一条）和「⋮⋮」把手：拖动把手排序，单击把手开菜单（上移 / 下移 / 删除）。
// 把手和按钮都绝对定位在左边留白里，藏起来时不占正文宽度。
function Bullets({ bullets, onChange }: { bullets: string[]; onChange: (next: string[]) => void }) {
  const [focus, setFocus] = useState<{ i: number; n: number }>({ i: -1, n: 0 });
  const [menuFor, setMenuFor] = useState(-1);
  const [drag, setDrag] = useState<{ from: number; to: number } | null>(null);
  const list = useRef<HTMLDivElement>(null);
  const keepFocus = useRef(false); // 菜单里选了「在下面加一条」：关菜单时别把焦点抢回把手
  const go = (i: number) => setFocus((f) => ({ i, n: f.n + 1 }));
  const set = (i: number, value: string) => onChange(bullets.map((b, k) => (k === i ? value : b)));
  const insert = (i: number) => { onChange([...bullets.slice(0, i), "", ...bullets.slice(i)]); go(i); };
  const remove = (i: number) => onChange(bullets.filter((_, k) => k !== i));

  // 按下把手：移动超过 4px 就是拖动排序（落点 = 指针在哪一行的上半 / 下半），否则松手时当单击，打开菜单。
  const grab = (i: number, e: ReactPointerEvent<HTMLButtonElement>) => {
    if (e.button !== 0) return;
    e.preventDefault(); // 不让 Radix 在按下时就开菜单
    const x0 = e.clientX, y0 = e.clientY;
    let to = -1;
    const onMove = (ev: PointerEvent) => {
      if (to < 0 && Math.hypot(ev.clientX - x0, ev.clientY - y0) < 4) return;
      const rows = Array.from(list.current?.querySelectorAll<HTMLElement>(":scope > .rf-bullet") ?? []);
      const at = rows.findIndex((row) => { const r = row.getBoundingClientRect(); return ev.clientY < r.top + r.height / 2; });
      to = at < 0 ? rows.length : at;
      setDrag({ from: i, to });
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      setDrag(null);
      if (to < 0) { setMenuFor(i); return; }
      const dest = to > i ? to - 1 : to;
      if (dest !== i) onChange(move(bullets, i, dest));
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  return (
    <div ref={list} className="rf-blocks" data-dragging={drag ? "" : undefined}>
      {bullets.map((b, i) => (
        <div key={i} className="rf-bullet" data-dragged={drag?.from === i || undefined}
          data-drop={drag && drag.to !== drag.from && drag.to !== drag.from + 1 ? (drag.to === i ? "before" : drag.to === i + 1 && i === bullets.length - 1 ? "after" : undefined) : undefined}>
          <div className="rf-gutter" data-open={menuFor === i || undefined}>
            <button type="button" className="rf-gutter-btn" aria-label={"在要点 " + (i + 1) + " 下面加一条"} title="在下面加一条"
              onClick={() => insert(i + 1)}>
              <Glyph name="plus" />
            </button>
            <Menu align="start" side="bottom" open={menuFor === i} onOpenChange={(open) => setMenuFor(open ? i : -1)}
              onCloseAutoFocus={(e) => { if (keepFocus.current) { e.preventDefault(); keepFocus.current = false; } }}
              trigger={
                <button type="button" className="rf-gutter-btn rf-grip" aria-label={"要点 " + (i + 1) + "：拖动排序，单击更多操作"}
                  title="拖动排序 · 单击更多" onPointerDown={(e) => grab(i, e)}>
                  <Glyph name="grip" />
                </button>
              }
              items={[
                { label: "上移", icon: <Glyph name="up" />, disabled: i === 0, onSelect: () => onChange(move(bullets, i, i - 1)) },
                { label: "下移", icon: <Glyph name="down" />, disabled: i === bullets.length - 1, onSelect: () => onChange(move(bullets, i, i + 1)) },
                { label: "在下面加一条", icon: <Glyph name="plus" />, onSelect: () => { keepFocus.current = true; insert(i + 1); } },
                "separator",
                { label: "删除要点", icon: <Glyph name="trash" />, danger: true, onSelect: () => remove(i) },
              ]} />
          </div>
          <span className="rf-dot" aria-hidden />
          <RichText value={b} rows={1} compact label={"要点 " + (i + 1)} onChange={(v) => set(i, v)}
            focusSignal={focus.i === i ? focus.n : 0}
            keys={{
              onEnter: () => insert(i + 1),
              onRemove: () => { remove(i); if (i > 0) go(i - 1); },
              onPrev: i > 0 ? () => go(i - 1) : undefined,
              onNext: i < bullets.length - 1 ? () => go(i + 1) : undefined,
            }} />
        </div>
      ))}
      <button type="button" className="rf-link rf-add-line" onClick={() => insert(bullets.length)}><Glyph name="plus" />添加要点</button>
    </div>
  );
}

function ItemForm({ type, item, onPatch }: { type: SectionType; item: ResumeItem; onPatch: (patch: Partial<ResumeItem>) => void }) {
  const fields = ITEM_FIELDS[type];
  const field = (key: "title" | "subtitle" | "location" | "date", name: string) => name ? (
    <Field name={name}>
      <input value={item[key]} onChange={(e) => onPatch({ [key]: e.target.value } as Partial<ResumeItem>)} className="rf-input" />
    </Field>
  ) : null;
  const [desc, setDesc] = useState(0);
  return (
    <div className="rf-doc">
      {fields && (
        <div className="rf-props">
          {field("title", fields.title)}{field("subtitle", fields.subtitle)}{field("location", fields.location)}{field("date", fields.date)}
        </div>
      )}
      {/* 描述是可选的：没写时只留一行「+ 添加描述」，点开才出编辑框。不用 label 包：里面有放大按钮。 */}
      {/* 正文直接写在纸面上，不套灰框；标签只给读屏（aria-label）。 */}
      {fields && !item.text && !desc ? (
        <button type="button" className="rf-link rf-add-line" onClick={() => setDesc(1)}><Glyph name="plus" />添加描述</button>
      ) : (
        <RichText value={item.text} rows={fields ? 1 : 3} label={fields ? "描述" : "内容"} focusSignal={desc} onChange={(text) => onPatch({ text })} />
      )}
      {/* 个人总结 / 技能这类只有正文的模块不给要点；老数据里已有要点的照常显示，免得看不见。 */}
      {(fields || item.bullets.length > 0) && <Bullets bullets={item.bullets} onChange={(bullets) => onPatch({ bullets })} />}
    </div>
  );
}

// 条目摘要两行：第一行标题（没填用正文开头），第二行 副标题 | 城市 | 时间。
function summaryOf(item: ResumeItem, j: number) {
  return item.title.trim() || plainText(item.text).split("\n")[0] || item.bullets.find(Boolean) || "第 " + (j + 1) + " 段";
}

const detailOf = (item: ResumeItem) =>
  item.title.trim() ? [item.subtitle, item.location, item.date].map((s) => s.trim()).filter(Boolean).join(" | ") : item.date.trim();

const addLabel = (type: SectionType) => {
  const name = SECTION_LABEL[type];
  return "添加" + (name.endsWith("经历") ? "一段" + name : name);
};

function ItemCard({ section, item, index, open, onToggle, onPatch, onMove, onDelete }: {
  section: ResumeSection; item: ResumeItem; index: number; open: boolean; onToggle: () => void;
  onPatch: (patch: Partial<ResumeItem>) => void; onMove: (to: number) => void; onDelete: () => void;
}) {
  return (
    <div id={"rf-item-" + item.id} className="rf-item" data-open={open || undefined}>
      <div className="rf-item-head" role="button" tabIndex={0} aria-expanded={open} onClick={onToggle}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onToggle(); } }}>
        <span className="rf-item-main">
          <span className="rf-item-title">{summaryOf(item, index)}</span>
          {detailOf(item) && <span className="rf-item-sub">{detailOf(item)}</span>}
        </span>
        <div className="rf-actions">
          <span className="rf-hover"><Arrows index={index} count={section.items.length} onMove={onMove} /></span>
          <Btn label="删除这段" danger onClick={onDelete}><Glyph name="trash" /></Btn>
          <Chevron open={open} />
        </div>
      </div>
      {open && <div className="rf-item-body"><ItemForm type={section.type} item={item} onPatch={onPatch} /></div>}
    </div>
  );
}

function SectionCard({ resume, section, index, open, openItems, onToggle, onToggleItem, onOpenItem, onChange }: {
  resume: Resume; section: ResumeSection; index: number; open: boolean; openItems: Set<string>;
  onToggle: () => void; onToggleItem: (id: string) => void; onOpenItem: (id: string) => void; onChange: (next: Resume) => void;
}) {
  const patch = (fn: (s: ResumeSection) => ResumeSection) => onChange(updateSection(resume, section.id, fn));
  const titleRef = useRef<HTMLInputElement>(null);
  const single = ITEM_FIELDS[section.type] === null;
  const addItem = () => {
    const item = emptyItem();
    patch((s) => ({ ...s, items: [...s.items, item] }));
    onOpenItem(item.id);
  };
  return (
    <section id={"rf-sec-" + section.id} className="rf-card" data-hidden={section.hidden || undefined}>
      <header className="rf-card-head">
        <Icon kind={section.type} />
        <input ref={titleRef} value={section.title} onChange={(e) => patch((s) => ({ ...s, title: e.target.value }))} aria-label="模块标题"
          className="rf-card-title" style={{ width: Math.max(2, section.title.length) + 0.5 + "em" }} />
        <Btn label="改模块名" onClick={() => titleRef.current?.select()}><Glyph name="pencil" /></Btn>
        {section.hidden && <span className="rf-muted">已隐藏</span>}
        <div className="rf-actions">
          <span className="rf-hover">
            <Btn label={section.hidden ? "在简历里显示" : "在简历里隐藏"} onClick={() => patch((s) => ({ ...s, hidden: !s.hidden }))}>
              <Glyph name={section.hidden ? "eyeOff" : "eye"} />
            </Btn>
            <Arrows index={index} count={resume.sections.length} onMove={(to) => onChange({ ...resume, sections: move(resume.sections, index, to) })} />
          </span>
          <Btn label="删除模块" danger onClick={() => onChange({ ...resume, sections: resume.sections.filter((s) => s.id !== section.id) })}>
            <Glyph name="trash" />
          </Btn>
          <Btn label={open ? "收起" : "展开"} onClick={onToggle}><Chevron open={open} /></Btn>
        </div>
      </header>
      {open && (
        <div className="rf-card-body">
          {single && section.items.length <= 1 ? (
            section.items[0]
              ? <div id={"rf-item-" + section.items[0].id}>
                  <ItemForm type={section.type} item={section.items[0]} onPatch={(p) => onChange(updateItem(resume, section.id, section.items[0].id, p))} />
                </div>
              : <button type="button" className="rf-add" onClick={addItem}><Glyph name="plus" />填写{section.title || SECTION_LABEL[section.type]}</button>
          ) : (
            <>
              {section.items.map((item, j) => (
                <ItemCard key={item.id} section={section} item={item} index={j} open={openItems.has(item.id)}
                  onToggle={() => onToggleItem(item.id)}
                  onPatch={(p) => onChange(updateItem(resume, section.id, item.id, p))}
                  onMove={(to) => patch((s) => ({ ...s, items: move(s.items, j, to) }))}
                  onDelete={() => patch((s) => ({ ...s, items: s.items.filter((it) => it.id !== item.id) }))} />
              ))}
              <button type="button" className="rf-add" onClick={addItem}><Glyph name="plus" />{addLabel(section.type)}</button>
            </>
          )}
        </div>
      )}
      {!open && single && section.items[0]?.text.trim() && <p className="rf-card-body rf-clamp">{plainText(section.items[0].text)}</p>}
    </section>
  );
}

const toggled = (set: Set<string>, id: string, on?: boolean) => {
  const next = new Set(set);
  if (on ?? !next.has(id)) next.add(id);
  else next.delete(id);
  return next;
};

export function ResumeForm({ resume, onChange, focus, basicsExtra, readOnly }: Props) {
  const root = useRef<HTMLDivElement>(null);
  // 模块默认全展开（记收起的）；条目默认只露摘要（记展开的）。
  const [closed, setClosed] = useState<Set<string>>(() => new Set());
  const [openItems, setOpenItems] = useState<Set<string>>(() => new Set());
  const [basicsOpen, setBasicsOpen] = useState(true);

  useEffect(() => {
    if (!focus) return;
    const { sectionId, itemId } = focus;
    if (sectionId) setClosed((prev) => toggled(prev, sectionId, false));
    if (itemId) setOpenItems((prev) => toggled(prev, itemId, true));
    if (focus.basics) setBasicsOpen(true);
    const target = itemId ? "rf-item-" + itemId : sectionId ? "rf-sec-" + sectionId : focus.basics ? "rf-basics" : "";
    if (!target) return;
    requestAnimationFrame(() => {
      const el = root.current?.querySelector<HTMLElement>("#" + CSS.escape(target));
      el?.scrollIntoView({ block: "start", behavior: "smooth" });
      el?.querySelector<HTMLElement>("input, textarea, [contenteditable]")?.focus({ preventScroll: true });
    });
  }, [focus]);

  const setBasics = (patch: Partial<ResumeBasics>) => onChange({ ...resume, basics: { ...resume.basics, ...patch } });
  const contacts = resume.basics.contacts;
  const setContacts = (next: ResumeContact[]) => setBasics({ contacts: next });
  const addSection = (type: SectionType) => {
    const section = emptySection(type);
    onChange({ ...resume, sections: [...resume.sections, section] });
    setOpenItems((prev) => new Set([...prev, ...section.items.map((it) => it.id)]));
    requestAnimationFrame(() => root.current?.querySelector("#" + CSS.escape("rf-sec-" + section.id))?.scrollIntoView({ block: "start", behavior: "smooth" }));
  };

  return (
    <div ref={root} className="rf-scroll" aria-readonly={readOnly || undefined} title={readOnly ? "正在按岗位改写，写完再改" : undefined}
      style={readOnly ? { opacity: 0.55 } : undefined} {...({ inert: readOnly ? "" : undefined } as Record<string, unknown>)}>
      <section id="rf-basics" className="rf-card">
        <header className="rf-card-head">
          <Icon kind="basics" />
          <h2 className="rf-card-title">基本信息</h2>
          <div className="rf-actions">
            <Btn label={basicsOpen ? "收起" : "展开"} onClick={() => setBasicsOpen(!basicsOpen)}><Chevron open={basicsOpen} /></Btn>
          </div>
        </header>
        {basicsOpen ? (
          <div className="rf-card-body">
            <div className="rf-props">
              <Field name="姓名">
                <input value={resume.basics.name} onChange={(e) => setBasics({ name: e.target.value })} className="rf-input" />
              </Field>
              <Field name="求职意向">
                <input value={resume.basics.target} onChange={(e) => setBasics({ target: e.target.value })} className="rf-input" />
              </Field>
              {contacts.map((c, i) => (
                <ContactField key={i} contact={c} onChange={(next) => setContacts(contacts.map((x, k) => (k === i ? next : x)))}
                  onDelete={() => setContacts(contacts.filter((_, k) => k !== i))} />
              ))}
            </div>
            <div className="flex flex-wrap gap-2">
              {CONTACT_PRESETS.filter((label) => !contacts.some((c) => c.label === label)).map((label) => (
                <button key={label} type="button" className="rf-chip" onClick={() => setContacts([...contacts, { label, value: "" }])}>+ {label}</button>
              ))}
              <button type="button" className="rf-chip" onClick={() => setContacts([...contacts, { label: "", value: "" }])}>+ 自定义</button>
            </div>
            {basicsExtra}
          </div>
        ) : (
          <p className="rf-card-body rf-muted truncate">
            {[resume.basics.name, ...contacts.filter((c) => c.value.trim()).map(contactText)].filter(Boolean).join(" | ") || "还没填"}
          </p>
        )}
      </section>
      {resume.sections.map((section, i) => (
        <SectionCard key={section.id} resume={resume} section={section} index={i} open={!closed.has(section.id)} openItems={openItems}
          onToggle={() => setClosed((prev) => toggled(prev, section.id))}
          onToggleItem={(id) => setOpenItems((prev) => toggled(prev, id))}
          onOpenItem={(id) => setOpenItems((prev) => toggled(prev, id, true))}
          onChange={onChange} />
      ))}
      <div className="rf-card rf-card-dashed">
        <span className="rf-label">添加模块</span>
        <div className="mt-2 flex flex-wrap gap-2">
          {SECTION_TYPES.map((t) => (
            <button key={t} type="button" className="rf-chip" onClick={() => addSection(t)}>+ {SECTION_LABEL[t]}</button>
          ))}
        </div>
      </div>
    </div>
  );
}
