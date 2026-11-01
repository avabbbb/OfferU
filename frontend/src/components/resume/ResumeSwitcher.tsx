"use client";

// 简历名即切换器（对齐超级简历，替代原来的左侧简历列表）：
// 点名字下拉列出全部简历，点一份切过去；每行悬停出现改名 / 复制 / 删除；底部从档案新建、空白新建。名字旁的铅笔直接改当前这份。
import Link from "next/link";
import { useEffect, useRef, useState } from "react";

import type { Doc, Job } from "@/lib/core";

type Props = {
  docs: Doc[];
  current: Doc;
  jobs: Job[];
  /** 当前这份的名字（编辑器里的状态，可能还没回写到 docs）。 */
  title: string;
  onRename: (doc: Doc, title: string) => void;
  onCreate: (fromProfile: boolean) => void;
  onCopy: (doc: Doc) => void;
  onDelete: (doc: Doc) => void;
};

const PATH = {
  caret: "m6 9 6 6 6-6",
  pencil: "M4 20h4L19 9l-4-4L4 16zM13.5 6.5l4 4",
  copy: "M9 9h11v11H9zM5 15H4V4h11v1",
  trash: "M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13",
  plus: "M12 5v14M5 12h14",
};

function Glyph({ name }: { name: keyof typeof PATH }) {
  return (
    <svg className="rw-glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={PATH[name]} />
    </svg>
  );
}

export function ResumeSwitcher({ docs, current, jobs, title, onRename, onCreate, onCopy, onDelete }: Props) {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<number | null>(null);
  const [draft, setDraft] = useState("");
  const cancelled = useRef(false);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent) => { if (!root.current?.contains(e.target as Node)) { setOpen(false); setEditing(null); } };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape" && editing === null) setOpen(false); };
    document.addEventListener("mousedown", down);
    document.addEventListener("keydown", key);
    return () => { document.removeEventListener("mousedown", down); document.removeEventListener("keydown", key); };
  }, [open, editing]);

  const nameOf = (d: Doc) => (d.id === current.id ? title : d.title ?? "").trim() || "未命名简历";
  const jobOf = (d: Doc) => (d.job_id ? jobs.find((j) => j.id === d.job_id)?.label : undefined);
  const startEdit = (d: Doc) => { cancelled.current = false; setDraft(nameOf(d)); setEditing(d.id); };
  const finish = (d: Doc) => {
    const next = draft.trim();
    setEditing(null);
    if (!cancelled.current && next && next !== nameOf(d)) onRename(d, next);
  };
  const nameInput = (d: Doc, className: string) => (
    <input autoFocus value={draft} aria-label="简历名称" className={className}
      onChange={(e) => setDraft(e.target.value)} onBlur={() => finish(d)} onFocus={(e) => e.currentTarget.select()}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
        if (e.key === "Escape") { e.stopPropagation(); cancelled.current = true; e.currentTarget.blur(); }
      }} />
  );

  return (
    <div ref={root} className="rw">
      {editing === current.id && !open ? nameInput(current, "rw-input") : (
        <button type="button" className="rw-name" aria-haspopup="menu" aria-expanded={open} title="切换或管理简历"
          onClick={() => setOpen(!open)}>
          <span className="rw-title">{nameOf(current)}</span>
          <Glyph name="caret" />
        </button>
      )}
      {!(editing === current.id && !open) && (
        <button type="button" className="rw-icon" aria-label="改简历名" title="改简历名" onClick={() => { setOpen(false); startEdit(current); }}>
          <Glyph name="pencil" />
        </button>
      )}
      {open && (
        <div role="menu" aria-label="我的简历" className="rw-menu">
          <p className="rw-caption">我的简历 · {docs.length} 份</p>
          <ul className="rw-list">
            {docs.map((d) => (
              <li key={d.id} className="rw-row" data-current={d.id === current.id || undefined}>
                {editing === d.id ? nameInput(d, "rw-input rw-input-row") : (
                  <Link href={"/resume/" + d.id} role="menuitem" className="rw-link" onClick={() => setOpen(false)}>
                    <span className="rw-row-title">{nameOf(d)}</span>
                    {jobOf(d) && <span className="rw-row-sub">{jobOf(d)}</span>}
                  </Link>
                )}
                {editing !== d.id && (
                  <span className="rw-acts">
                    <button type="button" className="rw-icon" aria-label={"改名：" + nameOf(d)} title="改名" onClick={() => startEdit(d)}>
                      <Glyph name="pencil" />
                    </button>
                    <button type="button" className="rw-icon" aria-label={"复制：" + nameOf(d)} title="复制一份"
                      onClick={() => { setOpen(false); onCopy(d); }}>
                      <Glyph name="copy" />
                    </button>
                    <button type="button" className="rw-icon" data-danger aria-label={"删除：" + nameOf(d)} title="删除"
                      onClick={() => { if (window.confirm("删除「" + nameOf(d) + "」？")) { setOpen(false); onDelete(d); } }}>
                      <Glyph name="trash" />
                    </button>
                  </span>
                )}
              </li>
            ))}
          </ul>
          <div className="rw-foot">
            <button type="button" className="rw-new" onClick={() => { setOpen(false); onCreate(true); }}><Glyph name="plus" />从档案新建</button>
            <button type="button" className="rw-new" onClick={() => { setOpen(false); onCreate(false); }}><Glyph name="plus" />空白新建</button>
          </div>
        </div>
      )}
    </div>
  );
}
