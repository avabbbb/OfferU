"use client";

import { type ColumnDef, type ColumnSizingState, type Updater, getCoreRowModel, useReactTable } from "@tanstack/react-table";
import { type ReactNode, useMemo, useRef, useState } from "react";

import { TagInput } from "@/components/core/TagInput";
import { JOB_STATUS, type Job, type JobStatus, write } from "@/lib/core";
import {
  FIELDS, MAX_WIDTH, MIN_WIDTH, PRIMARY, ROW_HEIGHT, STATUS_ORDER, STATUS_TONE, groupJobs, tagPatch,
  type FieldKey, type Group, type ViewConfig,
} from "@/lib/jobView";

import { ghost, type Patch } from "./ViewPanels";

// 表格视图：勾选列 + 主字段冻结在左；拖表头右缘改列宽；双击（状态、标签单击）改单元格；按配置分组；勾选后底部出批量栏。

const TONE: Record<string, string> = {
  slate: "bg-slate-100 text-slate-700", blue: "bg-blue-50 text-blue-700", yellow: "bg-amber-50 text-amber-700",
  orange: "bg-orange-50 text-orange-700", green: "bg-emerald-50 text-emerald-700", red: "bg-rose-50 text-rose-700", gray: "bg-neutral-100 text-neutral-500",
};

export function StatusPill({ status }: { status: JobStatus }) {
  return <span className={"inline-block whitespace-nowrap rounded px-1.5 py-0.5 text-[12px] leading-4 " + TONE[STATUS_TONE[status]]}>{JOB_STATUS[status]}</span>;
}

export const saveJob = (job: Job, data: Record<string, unknown>) => write("save", { type: "job", id: job.id, data });
export const saveTags = (job: Job, tags: string[]) => saveJob(job, tagPatch(job, tags));

const DEFAULT_WIDTH: Record<FieldKey, number> = {
  company: 160, title: 220, status: 104, city: 90, hire_type: 100, tags: 160, score: 72, applied_at: 108, created_at: 108,
};
const LEAD = 72;
const EDITABLE_TEXT: FieldKey[] = ["company", "title", "city"];

type Editing = { id: number; field: FieldKey } | null;
export type Item = { kind: "group"; g: Group; depth: number } | { kind: "row"; job: Job; key: string };

// 分组展开成行；甘特也用。
export function flatten(groups: Group[], collapsed: Set<string>, depth: number, out: Item[]) {
  for (const g of groups) {
    out.push({ kind: "group", g, depth });
    if (collapsed.has(g.key)) continue;
    if (g.children.length) flatten(g.children, collapsed, depth + 1, out);
    else for (const job of g.jobs) out.push({ kind: "row", job, key: g.key + "#" + job.id });
  }
}

function TextEdit({ initial, type = "text", onDone, onCancel }: { initial: string; type?: string; onDone: (v: string) => void; onCancel: () => void }) {
  const [v, setV] = useState(initial);
  const cancelled = useRef(false);
  return (
    <input autoFocus type={type} value={v} aria-label="编辑" onChange={(e) => setV(e.target.value)}
      onBlur={() => { if (!cancelled.current) onDone(v.trim()); }}
      onKeyDown={(e) => {
        if (e.nativeEvent.isComposing) return;
        if (e.key === "Enter") e.currentTarget.blur();
        else if (e.key === "Escape") { cancelled.current = true; onCancel(); }
      }}
      className="w-full min-w-0 rounded border border-[var(--foreground-muted)] bg-[var(--surface)] px-1 py-0.5 text-[13px] text-[var(--foreground)] outline-none" />
  );
}

const faint = (s: string) => <span className="text-[var(--foreground-faint)]">{s}</span>;

function CellView({ job, field, editing, setEditing, tagOptions, wrap }: {
  job: Job; field: FieldKey; editing: Editing; setEditing: (e: Editing) => void; tagOptions: string[]; wrap: boolean;
}): ReactNode {
  const on = editing?.id === job.id && editing.field === field;
  const close = () => setEditing(null);
  const start = () => setEditing({ id: job.id, field });
  const line = wrap ? "line-clamp-2 whitespace-normal break-all" : "truncate";

  if (EDITABLE_TEXT.includes(field)) {
    const key = field as "company" | "title" | "city";
    const value = job[key] ?? "";
    if (on) return <TextEdit initial={value} onCancel={close} onDone={(v) => { close(); if (v !== value) void saveJob(job, { [key]: v || null }); }} />;
    return (
      <span className={line + " block cursor-text" + (field === PRIMARY ? " font-medium" : "")} title={value || undefined} onDoubleClick={start}>
        {value || (field === PRIMARY ? faint("未填公司") : "")}
      </span>
    );
  }
  switch (field) {
    case "status":
      if (on) {
        return (
          <select autoFocus value={job.status} aria-label="投递状态" onBlur={close}
            onChange={(e) => { close(); void saveJob(job, { status: e.target.value }); }}
            className="w-full rounded border border-[var(--foreground-muted)] bg-[var(--surface)] px-1 py-0.5 text-[13px] outline-none">
            {STATUS_ORDER.map((s) => <option key={s} value={s}>{JOB_STATUS[s]}</option>)}
          </select>
        );
      }
      return <button type="button" title="改状态" onClick={start} className="max-w-full"><StatusPill status={job.status} /></button>;
    case "tags":
      if (on) return <TagInput value={job.tags ?? []} options={tagOptions} onClose={close} onChange={(tags) => void saveTags(job, tags)} />;
      return (
        <button type="button" title="改标签" onClick={start} className={"flex w-full min-w-0 gap-1 text-left " + (wrap ? "flex-wrap" : "overflow-hidden")}>
          {(job.tags ?? []).map((t) => <span key={t} className="tag-pill shrink-0">#{t}</span>)}
          {!job.tags?.length && <span className="opacity-0 hover:opacity-100">{faint("+ 标签")}</span>}
        </button>
      );
    case "hire_type":
      return <span className={line + " block"}>{job.posting?.hire_type ?? ""}</span>;
    case "score":
      return <span className="block text-right tabular-nums" title={(job.reasons ?? []).join("\n") || undefined}>{job.score ?? ""}</span>;
    case "applied_at":
      if (on) {
        return <TextEdit type="date" initial={job.applied_at?.slice(0, 10) ?? ""} onCancel={close}
          onDone={(v) => { close(); if (v !== (job.applied_at?.slice(0, 10) ?? "")) void saveJob(job, { applied_at: v || null }); }} />;
      }
      return <span className="block cursor-text tabular-nums" onDoubleClick={start}>{job.applied_at?.slice(0, 10) ?? ""}</span>;
    case "created_at":
      return <span className="block tabular-nums">{job.created_at?.slice(0, 10) ?? ""}</span>;
    default:
      return null;
  }
}

export function JobsTable({ jobs, view, patch, openId, onOpen, onAdd }: {
  jobs: Job[];
  view: ViewConfig;
  patch: Patch;
  openId: number | null;
  onOpen: (id: number) => void;
  onAdd: () => void;
}) {
  const [editing, setEditing] = useState<Editing>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [batchBusy, setBatchBusy] = useState(false);

  const fields = view.order.filter((k) => !view.hidden.includes(k));
  const fieldsKey = fields.join(",");
  const columns = useMemo<ColumnDef<Job>[]>(
    () => fieldsKey.split(",").map((f) => ({ id: f, header: FIELDS[f as FieldKey].name, size: DEFAULT_WIDTH[f as FieldKey] })),
    [fieldsKey],
  );
  const sizing = view.widths as ColumnSizingState;
  const table = useReactTable({
    data: jobs,
    columns,
    getRowId: (job) => String(job.id),
    getCoreRowModel: getCoreRowModel(),
    columnResizeMode: "onChange",
    defaultColumn: { minSize: MIN_WIDTH, maxSize: MAX_WIDTH },
    state: { columnSizing: sizing },
    onColumnSizingChange: (u: Updater<ColumnSizingState>) => {
      const next = typeof u === "function" ? u(sizing) : u;
      const widths: ViewConfig["widths"] = {};
      for (const [k, w] of Object.entries(next)) widths[k as FieldKey] = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(w)));
      patch({ widths });
    },
  });
  const headers = table.getHeaderGroups()[0]?.headers ?? [];
  const width = (f: FieldKey) => table.getColumn(f)?.getSize() ?? DEFAULT_WIDTH[f];
  const total = LEAD + fields.reduce((s, f) => s + width(f), 0);

  const tagOptions = useMemo(() => [...new Set(jobs.flatMap((j) => j.tags ?? []))].sort((a, b) => a.localeCompare(b, "zh")), [jobs]);
  const items = useMemo(() => {
    if (!view.group.length) return jobs.map((job): Item => ({ kind: "row", job, key: String(job.id) }));
    const out: Item[] = [];
    flatten(groupJobs(jobs, view.group), collapsed, 0, out);
    return out;
  }, [jobs, view.group, collapsed]);

  const visibleIds = jobs.map((j) => j.id);
  const chosen = visibleIds.filter((id) => selected.has(id));
  const allOn = visibleIds.length > 0 && chosen.length === visibleIds.length;
  const toggle = (id: number) => setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const height = ROW_HEIGHT[view.rowHeight];
  const wrap = view.rowHeight === "high";
  const sortOf = (f: FieldKey) => view.sort.find((s) => s.field === f);
  const clickHeader = (f: FieldKey) => {
    const s = sortOf(f);
    patch({ sort: !s ? [{ field: f, desc: false }] : !s.desc ? [{ field: f, desc: true }] : [] });
  };

  const batch = async (fn: (job: Job) => Promise<unknown>) => {
    setBatchBusy(true);
    try {
      for (const job of jobs.filter((j) => selected.has(j.id))) await fn(job);
      setSelected(new Set());
    } finally {
      setBatchBusy(false);
    }
  };

  const lead = "sticky left-0 z-10 bg-[var(--surface)]";
  const primary = "sticky z-10 bg-[var(--surface)]";
  let rowNo = 0;

  return (
    <div className="relative">
      <div className="overflow-auto rounded-lg border border-[var(--border)] bg-[var(--surface)]" style={{ maxHeight: "calc(100vh - 220px)" }}>
        <table className="border-separate text-[13px] text-[var(--foreground)]" style={{ width: total, tableLayout: "fixed", borderSpacing: 0 }}>
          <colgroup>
            <col style={{ width: LEAD }} />
            {fields.map((f) => <col key={f} style={{ width: width(f) }} />)}
          </colgroup>
          <thead className="sticky top-0 z-20">
            <tr className="h-9 text-left text-[12.5px] text-[var(--foreground-muted)]">
              <th className={lead + " border-b border-r border-[var(--border)] px-2 font-normal"}>
                <input type="checkbox" aria-label="全选" checked={allOn} onChange={() => setSelected(allOn ? new Set() : new Set(visibleIds))} />
              </th>
              {headers.map((h) => {
                const f = h.column.id as FieldKey;
                const s = sortOf(f);
                return (
                  <th key={h.id} style={f === PRIMARY ? { left: LEAD } : undefined}
                    className={(f === PRIMARY ? primary + " " : "bg-[var(--surface)] ") + "relative border-b border-r border-[var(--border)] px-2 font-normal"}>
                    <button type="button" onClick={() => clickHeader(f)} title="点一下排序" className="flex w-full items-center gap-1 truncate hover:text-[var(--foreground)]">
                      {FIELDS[f].name}{s && <span aria-label={s.desc ? "降序" : "升序"}>{s.desc ? "↓" : "↑"}</span>}
                    </button>
                    <div role="separator" aria-label={"调整" + FIELDS[f].name + "列宽"} onMouseDown={h.getResizeHandler()} onTouchStart={h.getResizeHandler()}
                      onDoubleClick={() => patch({ widths: Object.fromEntries(Object.entries(view.widths).filter(([k]) => k !== f)) })}
                      className={"absolute right-0 top-0 h-full w-1.5 cursor-col-resize select-none hover:bg-[var(--border-strong)] " + (h.column.getIsResizing() ? "bg-[var(--foreground-muted)]" : "")} />
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {items.map((it) => {
              if (it.kind === "group") {
                const folded = collapsed.has(it.g.key);
                return (
                  <tr key={"g:" + it.g.key} className="h-9 bg-[var(--surface-muted)]">
                    <td colSpan={fields.length + 1} className="border-b border-[var(--border)] p-0">
                      <button type="button" aria-expanded={!folded} onClick={() => setCollapsed((c) => { const n = new Set(c); if (n.has(it.g.key)) n.delete(it.g.key); else n.add(it.g.key); return n; })}
                        style={{ paddingLeft: it.depth ? 30 : 10 }} className="sticky left-0 flex items-center gap-2 py-1.5 pr-3 text-left">
                        <span className="w-3 text-[11px] text-[var(--foreground-muted)]">{folded ? "▸" : "▾"}</span>
                        <span className="text-[11.5px] text-[var(--foreground-muted)]">{FIELDS[it.g.field].name}</span>
                        {it.g.field === "status" && it.g.value ? <StatusPill status={it.g.value as JobStatus} /> : <span className="font-medium">{it.g.label}</span>}
                        <span className="text-[12px] tabular-nums text-[var(--foreground-muted)]">{it.g.jobs.length}</span>
                      </button>
                    </td>
                  </tr>
                );
              }
              const job = it.job;
              rowNo += 1;
              const on = selected.has(job.id);
              const open = openId === job.id;
              const bg = open ? "bg-[var(--accent-bg)]" : on ? "bg-[var(--surface-muted)]" : "bg-[var(--surface)] group-hover:bg-[var(--surface-hover)]";
              return (
                <tr key={it.key} className="group" style={{ height }}>
                  <td className={lead + " border-b border-r border-[var(--border)] px-2 " + bg}>
                    <div className="flex items-center gap-1">
                      <input type="checkbox" aria-label={"选中 " + (job.company ?? "") + " " + (job.title ?? "")} checked={on} onChange={() => toggle(job.id)}
                        className={on ? "" : "opacity-0 group-hover:opacity-100 focus:opacity-100"} />
                      <span className={"w-5 text-right text-[11.5px] tabular-nums text-[var(--foreground-faint)] " + (on ? "hidden" : "group-hover:hidden")}>{rowNo}</span>
                      <button type="button" aria-label="展开详情" title="展开详情" onClick={() => onOpen(job.id)}
                        className="ml-auto rounded px-1 text-[12px] text-[var(--foreground-muted)] opacity-0 hover:bg-[var(--surface-hover)] hover:text-[var(--foreground)] group-hover:opacity-100 focus:opacity-100">⤢</button>
                    </div>
                  </td>
                  {fields.map((f) => (
                    <td key={f} style={f === PRIMARY ? { left: LEAD } : undefined}
                      className={(f === PRIMARY ? primary + " " : "") + "border-b border-r border-[var(--border)] px-2 align-middle " + bg}>
                      <CellView job={job} field={f} editing={editing} setEditing={setEditing} tagOptions={tagOptions} wrap={wrap} />
                    </td>
                  ))}
                </tr>
              );
            })}
            <tr className="h-9">
              <td colSpan={fields.length + 1} className="p-0">
                <button type="button" onClick={onAdd} className="sticky left-0 px-3 py-2 text-[13px] text-[var(--foreground-muted)] hover:text-[var(--foreground)]">+ 添加岗位</button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p className="mt-1.5 text-[12px] text-[var(--foreground-muted)]">{jobs.length} 条记录</p>

      {chosen.length > 0 && (
        <div role="toolbar" aria-label="批量操作" style={{ boxShadow: "0 8px 24px var(--shadow-medium)" }}
          className="fixed bottom-6 left-1/2 z-40 flex -translate-x-1/2 items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--surface-opaque)] px-3 py-2 text-[13px]">
          <span>已选 {chosen.length} 个</span>
          <select value="" disabled={batchBusy} aria-label="批量改状态"
            onChange={(e) => { const status = e.target.value; if (status) void batch((job) => saveJob(job, { status })); }}
            className="rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-[13px]">
            <option value="">改状态…</option>
            {STATUS_ORDER.map((s) => <option key={s} value={s}>{JOB_STATUS[s]}</option>)}
          </select>
          <button type="button" disabled={batchBusy} className={ghost + " text-red-600 hover:text-red-700"}
            onClick={() => { if (window.confirm("删除选中的 " + chosen.length + " 个岗位？每条都能在「最近改动」里撤销。")) void batch((job) => write("delete", { type: "job", id: job.id })); }}>
            删除
          </button>
          <button type="button" className={ghost} onClick={() => setSelected(new Set())}>取消</button>
          {batchBusy && <span className="text-[12px] text-[var(--foreground-muted)]">正在处理…</span>}
        </div>
      )}
    </div>
  );
}
