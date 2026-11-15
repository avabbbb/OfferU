"use client";

import Link from "next/link";
import { AlignLeft, ChevronDown, ChevronRight, ChevronUp, ExternalLink, Link2, Maximize2, X } from "lucide-react";
import { type ReactNode, useEffect, useId, useState } from "react";
import { createPortal } from "react-dom";

import { JobTag, StatusSelect, TagPicker } from "@/components/jobs/JobPickers";
import { DatePicker, Input, Pill, toneOf } from "@/components/ui";
import { type Event, type Job, when } from "@/lib/core";
import { formatDay } from "@/lib/jobBoard";
import { FIELDS, type FieldKey } from "@/lib/jobView";

import { TYPE_ICON, saveJob } from "./JobsTable";

// 右侧记录详情（照金山文档「展开记录」）：标题 + ↑↓ 切换 + 展开到详情页 + 关闭；「详情 / 动态」两个 tab。
// 详情里每个字段一块：类型图标 + 灰色字段名，下面是整行宽的控件，改完失焦即存；不在卡片 / 表格上显示的字段收进「隐藏字段 (n)」。
// 动态：这个岗位的事项（笔试、面试、截止）和收藏 / 投递时间，按时间倒序。Esc 关闭。

const DETAIL_FIELDS: FieldKey[] = ["company", "title", "status", "city", "hire_type", "tags", "score", "applied_at", "created_at"];

function Block({ icon: Icon, label, children }: { icon: typeof AlignLeft; label: string; children: (id: string) => ReactNode }) {
  const id = useId();
  return (
    <div className="ou-record-field">
      <label htmlFor={id} className="ou-record-label"><Icon size={13} strokeWidth={1.75} aria-hidden />{label}</label>
      {children(id)}
    </div>
  );
}

function TextInput({ id, job, field, placeholder }: { id: string; job: Job; field: "company" | "title" | "city" | "url"; placeholder?: string }) {
  const initial = job[field] ?? "";
  const [v, setV] = useState(initial);
  useEffect(() => setV(initial), [initial, job.id]);
  return (
    <Input id={id} value={v} placeholder={placeholder ?? "填写" + (field === "url" ? "链接" : FIELDS[field].name)} onChange={(e) => setV(e.target.value)}
      onBlur={() => { const t = v.trim(); if (t !== initial) void saveJob(job, { [field]: t || null }); }}
      onKeyDown={(e) => { if (e.key === "Enter" && !e.nativeEvent.isComposing) e.currentTarget.blur(); }} />
  );
}

function Notes({ id, job }: { id: string; job: Job }) {
  const initial = job.notes ?? "";
  const [v, setV] = useState(initial);
  useEffect(() => setV(initial), [initial, job.id]);
  return (
    <textarea id={id} value={v} rows={4} placeholder="记点什么" onChange={(e) => setV(e.target.value)}
      onBlur={() => { if (v !== initial) void saveJob(job, { notes: v || null }); }}
      className="ou-input ou-record-notes" />
  );
}

const empty = <span className="ou-record-empty">—</span>;

function FieldControl({ id, job, field, tagOptions }: { id: string; job: Job; field: FieldKey; tagOptions: string[] }): ReactNode {
  switch (field) {
    case "company": case "title": case "city": return <TextInput id={id} job={job} field={field} />;
    case "status": return <div className="ou-record-box"><StatusSelect job={job} /></div>;
    case "hire_type": return <div className="ou-record-box" id={id}>{job.posting?.hire_type ? <Pill tone={toneOf(job.posting.hire_type)}>{job.posting.hire_type}</Pill> : empty}</div>;
    case "tags":
      return (
        <TagPicker job={job} options={tagOptions} align="start" trigger={
          <button type="button" id={id} className="ou-input ou-record-tags" aria-label="改标签">
            {(job.tags ?? []).map((t) => <JobTag key={t} text={t} />)}
            {!job.tags?.length && <span className="ou-record-empty">+ 标签</span>}
          </button>
        } />
      );
    case "score":
      return (
        <div className="ou-record-box ou-record-score" id={id}>
          {job.score != null ? <span className="tabular-nums">{job.score} 分</span> : <span className="ou-record-empty">还没评估</span>}
          {!!job.reasons?.length && <ul>{job.reasons.map((r, i) => <li key={i}>{r}</li>)}</ul>}
        </div>
      );
    case "applied_at": {
      const day = job.applied_at?.slice(0, 10) ?? "";
      // 选完即存（不等失焦）；清除 = 置空。
      return <DatePicker aria-label="投递日" placeholder="还没投" value={day} className="w-full"
        onChange={(v) => { if (v !== day) void saveJob(job, { applied_at: v || null }); }} />;
    }
    case "created_at": return <div className="ou-record-box tabular-nums" id={id}>{job.created_at ? formatDay(job.created_at) : empty}</div>;
    default: return null;
  }
}

type Activity = { key: string; at: string; title: string; done?: boolean };

function activity(job: Job, events: Event[]): Activity[] {
  const list: Activity[] = events.filter((e) => e.job_id === job.id && e.at).map((e) => ({ key: "e" + e.id, at: e.at!, title: e.title, done: e.done }));
  if (job.applied_at) list.push({ key: "applied", at: job.applied_at, title: "投递" });
  if (job.created_at) list.push({ key: "created", at: job.created_at, title: "收藏了这个岗位" });
  return list.sort((a, b) => b.at.localeCompare(a.at));
}

export function RecordDrawer({ job, index, total, tagOptions, hidden = [], events = [], onPrev, onNext, onClose }: {
  job: Job;
  index: number;
  total: number;
  tagOptions: string[];
  /** 收进「隐藏字段」的字段（当前视图里没显示的）。 */
  hidden?: FieldKey[];
  events?: Event[];
  onPrev: () => void;
  onNext: () => void;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<"detail" | "activity">("detail");
  const [showHidden, setShowHidden] = useState(false);
  const tabsId = useId();
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      // 浮层（日期、状态、标签）自己处理 Esc：Radix 关浮层时会 preventDefault，这里就不再连带关掉抽屉。
      if (e.key === "Escape" && !e.defaultPrevented && !(t && t.closest("input, textarea, select"))) onClose();
    };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, [onClose]);

  const tucked: FieldKey[] = hidden.filter((k) => k !== "company" && k !== "title");
  const visible = DETAIL_FIELDS.filter((k) => !tucked.includes(k));
  const hiddenFields = DETAIL_FIELDS.filter((k) => tucked.includes(k));
  const block = (k: FieldKey) => (
    <Block key={k} icon={TYPE_ICON[FIELDS[k].type]} label={FIELDS[k].name}>{(id) => <FieldControl id={id} job={job} field={k} tagOptions={tagOptions} />}</Block>
  );
  const title = [job.company, job.title].filter(Boolean).join(" · ") || "未填公司";
  const items = activity(job, events);

  // 挂到 body：主内容区的玻璃面板会成为 fixed 的包含块，抽屉不挂出去就被裁在面板里、够不到窗口顶和底。
  return createPortal(
    <aside aria-label="岗位详情" className="ou-record">
      <header className="ou-record-head">
        <h2 className="ou-record-title" title={title}>{title}</h2>
        {index >= 0 && <span className="ou-record-index tabular-nums">{index + 1} / {total}</span>}
        <button type="button" aria-label="上一条" title="上一条" disabled={index <= 0} onClick={onPrev} className="ou-record-icon"><ChevronUp size={17} strokeWidth={1.75} aria-hidden /></button>
        <button type="button" aria-label="下一条" title="下一条" disabled={index < 0 || index >= total - 1} onClick={onNext} className="ou-record-icon"><ChevronDown size={17} strokeWidth={1.75} aria-hidden /></button>
        <Link href={"/jobs/" + job.id} aria-label="展开到岗位详情页" title="展开到详情页（JD、评估、投递）" className="ou-record-icon"><Maximize2 size={15} strokeWidth={1.75} aria-hidden /></Link>
        <button type="button" aria-label="关闭" title="关闭（Esc）" onClick={onClose} className="ou-record-icon"><X size={17} strokeWidth={1.75} aria-hidden /></button>
      </header>
      <div role="tablist" aria-label="记录内容" className="ou-record-tabs">
        {([["detail", "详情"], ["activity", "动态"]] as const).map(([k, name]) => (
          <button key={k} type="button" role="tab" id={tabsId + k} aria-selected={tab === k} aria-controls={tabsId + k + "-panel"}
            onClick={() => setTab(k)} className="ou-record-tab">{name}</button>
        ))}
      </div>
      <div role="tabpanel" id={tabsId + tab + "-panel"} aria-labelledby={tabsId + tab} className="ou-record-body">
        {tab === "detail" ? (
          <>
            {job.posting?.essence && (
              <p className="ou-record-essence" title="由 JD 概括，不是原文">{job.posting.essence}<span>推断</span></p>
            )}
            {visible.map(block)}
            <Block icon={Link2} label="链接">{(id) => (
              <div className="flex items-center gap-1">
                <TextInput id={id} job={job} field="url" placeholder="岗位链接" />
                {job.url && <a href={job.url} target="_blank" rel="noreferrer" aria-label="打开岗位链接" title="打开链接" className="ou-record-icon"><ExternalLink size={15} strokeWidth={1.75} aria-hidden /></a>}
              </div>
            )}</Block>
            <Block icon={AlignLeft} label="备注">{(id) => <Notes id={id} job={job} />}</Block>
            {hiddenFields.length > 0 && (
              <section className="ou-record-hidden">
                <button type="button" aria-expanded={showHidden} onClick={() => setShowHidden((v) => !v)} className="ou-record-hidden-toggle">
                  <ChevronRight size={14} strokeWidth={1.9} aria-hidden data-open={showHidden || undefined} />隐藏字段 ({hiddenFields.length})
                </button>
                {showHidden && hiddenFields.map(block)}
              </section>
            )}
          </>
        ) : (
          <ol className="ou-record-activity" aria-label="动态">
            {items.map((a) => (
              <li key={a.key} data-done={a.done || undefined}>
                <span className="ou-record-activity-at tabular-nums">{when(a.at)}</span>
                <span className="ou-record-activity-title">{a.title}</span>
              </li>
            ))}
          </ol>
        )}
      </div>
    </aside>,
    document.body,
  );
}
