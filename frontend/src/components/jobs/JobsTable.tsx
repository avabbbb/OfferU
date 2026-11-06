"use client";

import { type ColumnDef, type ColumnSizingState, type Updater, getCoreRowModel, useReactTable } from "@tanstack/react-table";
import { AlignLeft, Calendar, ChevronRight, CircleChevronDown, Hash, List, Plus } from "lucide-react";
import { type ReactNode, useMemo, useRef, useState } from "react";

import { TagInput } from "@/components/core/TagInput";
import { JOB_STATUS, type Job, type JobStatus, write } from "@/lib/core";
import {
  FIELDS, MAX_WIDTH, MIN_WIDTH, PRIMARY, ROW_HEIGHT, STATUS_ORDER, STATUS_TONE, groupJobs, tagPatch,
  type FieldKey, type FieldType, type Group, type ViewConfig,
} from "@/lib/jobView";

import { FieldsPanel, Popover, ghost, type Patch } from "./ViewPanels";

// 表格视图（Notion 式极简扁平）：没有外框、卡片和竖线，只有很淡的横线；表头灰字 + 字段类型小图标。
// 分组时组头是「▸ 胶囊 数量」，组间留白；每组末尾一行灰色「+ 新建」在该组加一条（预填组的值），按状态分组时最下面「+ 新建分组」。
// 勾选框悬停才出现；主字段悬停出「打开」；勾选列 + 主字段冻结在左；拖表头右缘改列宽；双击（状态、标签单击）改单元格；勾选后底部出批量栏。

const TONE: Record<string, string> = {
  slate: "bg-slate-100 text-slate-700", blue: "bg-blue-50 text-blue-700", yellow: "bg-amber-50 text-amber-700",
  orange: "bg-orange-50 text-orange-700", green: "bg-emerald-50 text-emerald-700", red: "bg-rose-50 text-rose-700", gray: "bg-neutral-100 text-neutral-500",
};
// 单选 / 标签的选项没有固定颜色：按文字哈希挑一个很浅的底色，同一个值永远同一个色（同 Notion）。
const OPTION_TONES = [
  "bg-sky-50 text-sky-800", "bg-teal-50 text-teal-800", "bg-violet-50 text-violet-800", "bg-pink-50 text-pink-800",
  "bg-amber-50 text-amber-800", "bg-lime-50 text-lime-800", "bg-indigo-50 text-indigo-800", "bg-orange-50 text-orange-800",
];
// Notion 的 select：小圆角色块，不是胶囊。
const PILL = "inline-block max-w-full truncate whitespace-nowrap rounded px-1.5 text-[12.5px] leading-5 ";

export function optionTone(s: string): string {
  let h = 0;
  for (const ch of s) h = (h * 31 + (ch.codePointAt(0) ?? 0)) >>> 0;
  return OPTION_TONES[h % OPTION_TONES.length];
}

export function StatusPill({ status }: { status: JobStatus }) {
  return <span className={PILL + TONE[STATUS_TONE[status]]}>{JOB_STATUS[status]}</span>;
}

function OptionPill({ text }: { text: string }) {
  return <span className={PILL + optionTone(text)} title={text}>{text}</span>;
}

const TYPE_ICON: Record<FieldType, typeof AlignLeft> = {
  text: AlignLeft, select: CircleChevronDown, tags: List, number: Hash, date: Calendar,
};

export const saveJob = (job: Job, data: Record<string, unknown>) => write("save", { type: "job", id: job.id, data });
export const saveTags = (job: Job, tags: string[]) => saveJob(job, tagPatch(job, tags));

const DEFAULT_WIDTH: Record<FieldKey, number> = {
  company: 160, title: 220, status: 104, city: 90, hire_type: 100, tags: 160, score: 72, applied_at: 108, created_at: 108,
};
const LEAD = 32;
const ADD_COL = 40;
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

// 在某个组里加一条：把组的值预填进去（创建时间、招聘类型这类不能直接写的不填）。
export function presetOf(groups: Group[]): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  for (const g of groups) {
    if (g.value == null) continue;
    switch (g.field) {
      case "company": case "title": case "status": case "city": data[g.field] = g.value; break;
      case "tags": data.tags = [...((data.tags as string[] | undefined) ?? []), g.value]; break;
      case "score": data.score = Number(g.value); break;
      case "applied_at": data.applied_at = g.value; break;
      default: break;
    }
  }
  return data;
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
      <span className={line + " block cursor-text" + (field === PRIMARY ? " pr-12 font-medium" : "")} title={value || undefined} onDoubleClick={start}>
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
      return <button type="button" title="改状态" onClick={start} className="flex max-w-full"><StatusPill status={job.status} /></button>;
    case "tags":
      if (on) return <TagInput value={job.tags ?? []} options={tagOptions} onClose={close} onChange={(tags) => void saveTags(job, tags)} />;
      return (
        <button type="button" title="改标签" onClick={start} className={"flex w-full min-w-0 gap-1 text-left " + (wrap ? "flex-wrap" : "overflow-hidden")}>
          {(job.tags ?? []).map((t) => <span key={t} className="shrink-0"><OptionPill text={t} /></span>)}
          {!job.tags?.length && <span className="opacity-0 hover:opacity-100">{faint("+ 标签")}</span>}
        </button>
      );
    case "hire_type":
      return job.posting?.hire_type ? <span className="flex"><OptionPill text={job.posting.hire_type} /></span> : null;
    case "score":
      return <span className="block text-right tabular-nums" title={(job.reasons ?? []).join("\n") || undefined}>{job.score ?? ""}</span>;
    case "applied_at":
      if (on) {
        return <TextEdit type="date" initial={job.applied_at?.slice(0, 10) ?? ""} onCancel={close}
          onDone={(v) => { close(); if (v !== (job.applied_at?.slice(0, 10) ?? "")) void saveJob(job, { applied_at: v || null }); }} />;
      }
      return <span className="block cursor-text tabular-nums" onDoubleClick={start}>{job.applied_at?.slice(0, 10).replace(/-/g, "/") ?? ""}</span>;
    case "created_at":
      return <span className="block tabular-nums">{job.created_at?.slice(0, 10).replace(/-/g, "/") ?? ""}</span>;
    default:
      return null;
  }
}

function GroupLabel({ g }: { g: Group }) {
  if (g.field === "status" && g.value) return <StatusPill status={g.value as JobStatus} />;
  if (g.value == null) return <span className={PILL + "bg-neutral-100 text-neutral-500"}>{g.label}</span>;
  return <OptionPill text={g.label} />;
}

export function JobsTable({ jobs, view, patch, openId, onOpen }: {
  jobs: Job[];
  view: ViewConfig;
  patch: Patch;
  openId: number | null;
  onOpen: (id: number) => void;
  onAdd?: () => void;
}) {
  const [editing, setEditing] = useState<Editing>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [batchBusy, setBatchBusy] = useState(false);
  const [error, setError] = useState("");

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
  const grid = LEAD + fields.reduce((s, f) => s + width(f), 0);
  const total = grid + ADD_COL;

  const tagOptions = useMemo(() => [...new Set(jobs.flatMap((j) => j.tags ?? []))].sort((a, b) => a.localeCompare(b, "zh")), [jobs]);
  const groups = useMemo(() => (view.group.length ? groupJobs(jobs, view.group) : null), [jobs, view.group]);

  const visibleIds = jobs.map((j) => j.id);
  const chosen = visibleIds.filter((id) => selected.has(id));
  const allOn = visibleIds.length > 0 && chosen.length === visibleIds.length;
  const toggle = (id: number) => setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const fold = (key: string) => setCollapsed((c) => { const n = new Set(c); if (n.has(key)) n.delete(key); else n.add(key); return n; });
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

  // 新加一条空记录（预填组的值），然后直接编辑公司名。
  const addIn = async (data: Record<string, unknown>) => {
    setError("");
    try {
      const res = (await write("save", { type: "job", data })) as unknown as { record?: { id?: number } } | undefined;
      const id = res?.record?.id;
      if (typeof id === "number") setEditing({ id, field: PRIMARY });
    } catch (e) {
      setError(e instanceof Error ? e.message : "没能新建记录");
    }
  };

  const lead = "sticky left-0 z-10";
  const primaryLeft = { left: LEAD };
  const cols = (
    <colgroup>
      <col style={{ width: LEAD }} />
      {fields.map((f) => <col key={f} style={{ width: width(f) }} />)}
      <col style={{ width: ADD_COL }} />
    </colgroup>
  );
  const tableCls = "border-separate text-[13.5px] text-[var(--foreground)]";
  const tableStyle = { width: total, tableLayout: "fixed" as const, borderSpacing: 0 };
  // 冻结的格子要不透明底；悬停 / 选中用一层内阴影叠色，冻结格和普通格颜色一致。
  const line = "border-b border-[var(--border)]";
  const hover = "group-hover:shadow-[inset_0_0_0_9999px_var(--surface-hover)]";

  const rows = (list: Job[], prefix: string) => (
    <table className={tableCls} style={tableStyle}>
      {cols}
      <tbody>
        {list.map((job) => {
          const on = selected.has(job.id);
          const open = openId === job.id;
          const bg = "bg-[var(--surface-opaque)] " + (open || on ? "shadow-[inset_0_0_0_9999px_var(--accent-bg)]" : hover);
          return (
            <tr key={prefix + "#" + job.id} className="group" data-testid="jobs-row" style={{ height }}>
              <td className={lead + " " + bg}>
                <div className="flex items-center justify-center">
                  <input type="checkbox" aria-label={"选中 " + (job.company ?? "") + " " + (job.title ?? "")} checked={on} onChange={() => toggle(job.id)}
                    className={on ? "" : "opacity-0 group-hover:opacity-100 focus:opacity-100"} />
                </div>
              </td>
              {fields.map((f) => (
                <td key={f} style={f === PRIMARY ? primaryLeft : undefined}
                  className={(f === PRIMARY ? "sticky z-10 " : "") + line + " px-2 align-middle " + bg}>
                  <CellView job={job} field={f} editing={editing} setEditing={setEditing} tagOptions={tagOptions} wrap={wrap} />
                  {f === PRIMARY && (
                    <button type="button" aria-label="打开详情" title="打开详情" onClick={() => onOpen(job.id)}
                      className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded border border-[var(--border)] bg-[var(--surface-opaque)] px-1.5 text-[11px] leading-5 tracking-wide text-[var(--foreground-muted)] opacity-0 hover:text-[var(--foreground)] group-hover:opacity-100 focus:opacity-100">
                      打开
                    </button>
                  )}
                </td>
              ))}
              <td className={line + " " + bg} />
            </tr>
          );
        })}
      </tbody>
    </table>
  );

  const addRow = (data: Record<string, unknown>, label: string) => (
    <button type="button" aria-label={label} title={label} onClick={() => void addIn(data)} style={{ width: grid, paddingLeft: LEAD + 8 }}
      className={"flex h-8 items-center gap-1.5 text-[13.5px] text-[var(--foreground-faint)] hover:bg-[var(--surface-hover)] hover:text-[var(--foreground-muted)] " + line}>
      <Plus size={14} strokeWidth={1.75} /> 新建
    </button>
  );

  const head = (g: Group, depth: number) => {
    const folded = collapsed.has(g.key);
    return (
      <div className={"flex items-center " + (depth ? "h-8" : "h-9")} style={{ width: grid }}>
        <button type="button" aria-expanded={!folded} onClick={() => fold(g.key)} data-testid="group-head"
          style={{ paddingLeft: depth ? LEAD + 8 : 4 }}
          className="sticky left-0 z-10 flex h-full max-w-full items-center gap-1.5 rounded pr-2 text-left hover:bg-[var(--surface-hover)]">
          <ChevronRight size={14} className={"shrink-0 text-[var(--foreground-muted)] transition-transform " + (folded ? "" : "rotate-90")} />
          {depth > 0 && <span className="shrink-0 text-[12px] text-[var(--foreground-muted)]">{FIELDS[g.field].name}</span>}
          <span className="flex min-w-0"><GroupLabel g={g} /></span>
          <span className="shrink-0 text-[12.5px] tabular-nums text-[var(--foreground-faint)]">{g.jobs.length}</span>
        </button>
      </div>
    );
  };

  const section = (key: string, children: ReactNode, first = false) => (
    <section key={key} data-testid="group-section" style={{ width: total }} className={first ? "" : "mt-5"}>
      {children}
    </section>
  );

  const groupSection = (g: Group, i: number) => section(g.key, (
    <>
      {head(g, 0)}
      {!collapsed.has(g.key) && (
        <div className="border-t border-[var(--border)]">
          {g.children.length
            ? g.children.map((c) => (
              <div key={c.key}>
                {head(c, 1)}
                {!collapsed.has(c.key) && <div className="border-t border-[var(--border)]">{rows(c.jobs, c.key)}{addRow(presetOf([g, c]), "在「" + c.label + "」组里加一条")}</div>}
              </div>
            ))
            : <>{rows(g.jobs, g.key)}{addRow(presetOf([g]), "在「" + g.label + "」组里加一条")}</>}
        </div>
      )}
    </>
  ), i === 0);

  // 按状态分组时，「新建分组」= 选一个还没出现的状态，在里面加第一条。
  const byStatus = view.group[0] === "status";
  const missing = byStatus && groups ? STATUS_ORDER.filter((s) => !groups.some((g) => g.value === s)) : [];

  return (
    <div className="relative">
      <div className="overflow-auto" style={{ maxHeight: "calc(100vh - 220px)" }}>
        <div style={{ width: total }} className="pb-3">
          <div className="sticky top-0 z-20 bg-[var(--surface-opaque)]">
            <table className={tableCls} style={tableStyle}>
              {cols}
              <thead>
                <tr className="h-9 text-left text-[13px] text-[var(--foreground-muted)]">
                  <th className={lead + " bg-[var(--surface-opaque)] font-normal " + line}>
                    <div className="flex justify-center">
                      <input type="checkbox" aria-label="全选" checked={allOn} onChange={() => setSelected(allOn ? new Set() : new Set(visibleIds))}
                        className={allOn || chosen.length ? "" : "opacity-0 hover:opacity-100 focus:opacity-100"} />
                    </div>
                  </th>
                  {headers.map((h) => {
                    const f = h.column.id as FieldKey;
                    const s = sortOf(f);
                    const Icon = TYPE_ICON[FIELDS[f].type];
                    return (
                      <th key={h.id} style={f === PRIMARY ? primaryLeft : undefined}
                        className={(f === PRIMARY ? "sticky z-10 " : "") + "group/th relative bg-[var(--surface-opaque)] px-2 font-normal " + line}>
                        <button type="button" onClick={() => clickHeader(f)} title="点一下排序"
                          className="-mx-1 flex w-[calc(100%+0.5rem)] min-w-0 items-center gap-1.5 rounded px-1 py-1 hover:bg-[var(--surface-hover)]">
                          <Icon size={14} strokeWidth={1.75} className="shrink-0 opacity-70" aria-hidden />
                          <span className="truncate">{FIELDS[f].name}</span>
                          {s && <span aria-label={s.desc ? "降序" : "升序"}>{s.desc ? "↓" : "↑"}</span>}
                        </button>
                        <div role="separator" aria-label={"调整" + FIELDS[f].name + "列宽"} onMouseDown={h.getResizeHandler()} onTouchStart={h.getResizeHandler()}
                          onDoubleClick={() => patch({ widths: Object.fromEntries(Object.entries(view.widths).filter(([k]) => k !== f)) })}
                          className={"absolute right-0 top-1.5 bottom-1.5 w-[3px] cursor-col-resize select-none rounded-full group-hover/th:bg-[var(--border)] hover:!bg-[var(--border-strong)] " + (h.column.getIsResizing() ? "!bg-[var(--foreground-muted)]" : "")} />
                      </th>
                    );
                  })}
                  <th className={"bg-[var(--surface-opaque)] p-0 font-normal " + line}>
                    <div className="flex justify-center" title="显示 / 隐藏字段">
                      <Popover label={<Plus size={14} strokeWidth={1.75} aria-label="字段" />} width={240}><FieldsPanel view={view} patch={patch} /></Popover>
                    </div>
                  </th>
                </tr>
              </thead>
            </table>
          </div>

          {groups
            ? <div className="pt-3">{groups.map(groupSection)}</div>
            : section("all", <>{rows(jobs, "all")}{addRow({}, "加一条")}</>, true)}

          {byStatus && missing.length > 0 && (
            <label style={{ width: grid }} className="mt-4 flex h-8 items-center gap-1.5 rounded px-1 text-[13.5px] text-[var(--foreground-faint)] hover:bg-[var(--surface-hover)] hover:text-[var(--foreground-muted)]">
              <Plus size={14} strokeWidth={1.75} />
              <span>新建分组</span>
              <select value="" aria-label="新建分组" onChange={(e) => { const status = e.target.value; if (status) void addIn({ status }); }}
                className="ml-1 bg-transparent text-[13px] text-[var(--foreground-muted)] outline-none">
                <option value="">选一个状态…</option>
                {missing.map((s) => <option key={s} value={s}>{JOB_STATUS[s]}</option>)}
              </select>
            </label>
          )}
        </div>
      </div>
      <p className="mt-1.5 pl-1 text-[12px] text-[var(--foreground-faint)]">
        计数 {jobs.length}{error && <span role="alert" className="ml-3 text-[var(--primary-red)]">{error}</span>}
      </p>

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
