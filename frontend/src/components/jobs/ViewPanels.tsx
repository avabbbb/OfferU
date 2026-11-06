"use client";

import { type ReactNode, useEffect, useRef, useState } from "react";

import { JOB_STATUS, type Job } from "@/lib/core";
import {
  FIELDS, FIELD_KEYS, MAX_GROUP, OPS, OP_NAME, PRIMARY, STATUS_ORDER, cell,
  type Condition, type FieldKey, type Op, type RowHeight, type ViewConfig,
} from "@/lib/jobView";

// 工具栏弹出面板：筛选、分组、排序、字段、行高。改动立刻写回当前视图配置。

export const ctl = "rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-[13px] text-[var(--foreground)] outline-none focus:border-[var(--foreground-muted)]";
export const ghost = "rounded-md px-2 py-1 text-[13px] text-[var(--foreground-muted)] hover:bg-[var(--surface-hover)] hover:text-[var(--foreground)] disabled:opacity-40";

export type Patch = (p: Partial<ViewConfig>) => void;

// 按钮 + 浮层；点别处或按 Esc 关掉。
export function Popover({ label, active, width = 360, children }: { label: ReactNode; active?: boolean; width?: number; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", down);
    document.addEventListener("keydown", key);
    return () => { document.removeEventListener("mousedown", down); document.removeEventListener("keydown", key); };
  }, [open]);
  return (
    <div ref={ref} className="relative">
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)}
        className={"rounded-md px-2 py-1 text-[13px] " + (active || open
          ? "bg-[var(--accent-bg)] text-[var(--foreground)]"
          : "text-[var(--foreground-muted)] hover:bg-[var(--surface-hover)] hover:text-[var(--foreground)]")}>
        {label}
      </button>
      {open && (
        <div role="dialog" style={{ width, boxShadow: "0 8px 24px var(--shadow-medium)" }}
          className="absolute right-0 z-30 mt-1 rounded-lg border border-[var(--border)] bg-[var(--surface-opaque)] p-3 text-[13px] text-[var(--foreground)]">
          {children}
        </div>
      )}
    </div>
  );
}

// 单选 / 标签字段的可选值：状态用固定顺序，其余取现有岗位里出现过的值。
export function fieldOptions(jobs: Job[], field: FieldKey): Array<[string, string]> {
  if (field === "status") return STATUS_ORDER.map((s) => [s, JOB_STATUS[s]]);
  const seen = new Set<string>();
  for (const job of jobs) {
    const v = cell(job, field);
    for (const x of Array.isArray(v) ? v : v === undefined ? [] : [String(v)]) seen.add(x);
  }
  return [...seen].sort((a, b) => a.localeCompare(b, "zh")).map((x) => [x, x]);
}

function ValueInput({ c, jobs, onChange }: { c: Condition; jobs: Job[]; onChange: (value: string[]) => void }) {
  const type = FIELDS[c.field].type;
  if (type === "select" || type === "tags") {
    const opts = fieldOptions(jobs, c.field);
    const name = (v: string) => opts.find(([k]) => k === v)?.[1] ?? v;
    return (
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
        {c.value.map((v) => (
          <button key={v} type="button" className="tag-pill" title="去掉" onClick={() => onChange(c.value.filter((x) => x !== v))}>{name(v)} ×</button>
        ))}
        <select value="" aria-label="选值" className={ctl + " min-w-0 flex-1"} onChange={(e) => { if (e.target.value) onChange([...c.value, e.target.value]); }}>
          <option value="">{c.value.length ? "再加一个…" : "选择…"}</option>
          {opts.filter(([k]) => !c.value.includes(k)).map(([k, n]) => <option key={k} value={k}>{n}</option>)}
        </select>
      </div>
    );
  }
  return (
    <input type={type === "date" ? "date" : type === "number" ? "number" : "text"} value={c.value[0] ?? ""} aria-label="值" placeholder="输入值"
      className={ctl + " min-w-0 flex-1"} onChange={(e) => onChange([e.target.value])} />
  );
}

export function FilterPanel({ view, jobs, patch }: { view: ViewConfig; jobs: Job[]; patch: Patch }) {
  const { mode, conditions } = view.filter;
  const set = (next: Condition[], m: "and" | "or" = mode) => patch({ filter: { mode: m, conditions: next } });
  const edit = (i: number, c: Partial<Condition>) => set(conditions.map((x, j) => (j === i ? { ...x, ...c } : x)));
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 text-[var(--foreground-muted)]">
        <span>符合以下</span>
        <select value={mode} aria-label="条件关系" className={ctl} onChange={(e) => set(conditions, e.target.value === "or" ? "or" : "and")}>
          <option value="and">所有</option>
          <option value="or">任一</option>
        </select>
        <span>条件</span>
      </div>
      {conditions.map((c, i) => {
        const none = c.op === "empty" || c.op === "notEmpty";
        return (
          <div key={i} className="flex items-start gap-1.5">
            <select value={c.field} aria-label="字段" className={ctl + " w-24 shrink-0"}
              onChange={(e) => { const f = e.target.value as FieldKey; edit(i, { field: f, op: OPS[FIELDS[f].type][0], value: [] }); }}>
              {FIELD_KEYS.map((k) => <option key={k} value={k}>{FIELDS[k].name}</option>)}
            </select>
            <select value={c.op} aria-label="条件" className={ctl + " w-20 shrink-0"} onChange={(e) => edit(i, { op: e.target.value as Op })}>
              {OPS[FIELDS[c.field].type].map((op) => <option key={op} value={op}>{OP_NAME[op]}</option>)}
            </select>
            {none ? <span className="flex-1" /> : <ValueInput c={c} jobs={jobs} onChange={(value) => edit(i, { value })} />}
            <button type="button" aria-label="删除条件" className={ghost} onClick={() => set(conditions.filter((_, j) => j !== i))}>×</button>
          </div>
        );
      })}
      <button type="button" className={ghost} onClick={() => set([...conditions, { field: "status", op: "is", value: [] }])}>+ 添加条件</button>
    </div>
  );
}

const GROUPABLE: FieldKey[] = ["status", "city", "hire_type", "tags", "company"];

export function GroupPanel({ view, patch }: { view: ViewConfig; patch: Patch }) {
  const g = view.group;
  return (
    <div className="space-y-2">
      {g.map((f, i) => (
        <div key={i} className="flex items-center gap-1.5">
          <span className="w-10 shrink-0 text-[var(--foreground-muted)]">{i ? "再按" : "按"}</span>
          <select value={f} aria-label="分组字段" className={ctl + " flex-1"} onChange={(e) => patch({ group: g.map((x, j) => (j === i ? (e.target.value as FieldKey) : x)) })}>
            {GROUPABLE.filter((k) => k === f || !g.includes(k)).map((k) => <option key={k} value={k}>{FIELDS[k].name}</option>)}
          </select>
          <button type="button" aria-label="删除分组" className={ghost} onClick={() => patch({ group: g.filter((_, j) => j !== i) })}>×</button>
        </div>
      ))}
      {g.length < MAX_GROUP && (
        <button type="button" className={ghost} onClick={() => { const f = GROUPABLE.find((k) => !g.includes(k)); if (f) patch({ group: [...g, f] }); }}>+ 添加分组条件</button>
      )}
      <p className="text-[12px] text-[var(--foreground-muted)]">最多两层。按标签分组时，一个岗位会出现在它的每个标签下。</p>
    </div>
  );
}

export function SortPanel({ view, patch }: { view: ViewConfig; patch: Patch }) {
  const s = view.sort;
  return (
    <div className="space-y-2">
      {s.map((x, i) => (
        <div key={i} className="flex items-center gap-1.5">
          <span className="w-10 shrink-0 text-[var(--foreground-muted)]">{i ? "然后" : "按"}</span>
          <select value={x.field} aria-label="排序字段" className={ctl + " flex-1"} onChange={(e) => patch({ sort: s.map((y, j) => (j === i ? { ...y, field: e.target.value as FieldKey } : y)) })}>
            {FIELD_KEYS.filter((k) => k === x.field || !s.some((y) => y.field === k)).map((k) => <option key={k} value={k}>{FIELDS[k].name}</option>)}
          </select>
          <select value={x.desc ? "desc" : "asc"} aria-label="方向" className={ctl + " w-20"} onChange={(e) => patch({ sort: s.map((y, j) => (j === i ? { ...y, desc: e.target.value === "desc" } : y)) })}>
            <option value="asc">升序</option>
            <option value="desc">降序</option>
          </select>
          <button type="button" aria-label="删除排序" className={ghost} onClick={() => patch({ sort: s.filter((_, j) => j !== i) })}>×</button>
        </div>
      ))}
      <button type="button" className={ghost} onClick={() => { const f = FIELD_KEYS.find((k) => !s.some((y) => y.field === k)); if (f) patch({ sort: [...s, { field: f, desc: false }] }); }}>+ 添加排序条件</button>
      <p className="text-[12px] text-[var(--foreground-muted)]">空值总排在最后。</p>
    </div>
  );
}

export function FieldsPanel({ view, patch }: { view: ViewConfig; patch: Patch }) {
  const move = (i: number, d: number) => {
    const o = [...view.order];
    const j = i + d;
    if (j < 1 || j >= o.length) return;
    [o[i], o[j]] = [o[j], o[i]];
    patch({ order: o });
  };
  return (
    <ul className="space-y-0.5">
      {view.order.map((k, i) => {
        const shown = !view.hidden.includes(k);
        return (
          <li key={k} className="flex items-center gap-1 rounded px-1 py-0.5 hover:bg-[var(--surface-hover)]">
            <label className="flex flex-1 items-center gap-2">
              <input type="checkbox" checked={shown} disabled={k === PRIMARY}
                onChange={() => patch({ hidden: shown ? [...view.hidden, k] : view.hidden.filter((x) => x !== k) })} />
              {FIELDS[k].name}
              {k === PRIMARY && <span className="text-[11px] text-[var(--foreground-faint)]">主字段</span>}
            </label>
            {k !== PRIMARY && (
              <>
                <button type="button" aria-label={"上移" + FIELDS[k].name} className={ghost + " px-1"} disabled={i <= 1} onClick={() => move(i, -1)}>↑</button>
                <button type="button" aria-label={"下移" + FIELDS[k].name} className={ghost + " px-1"} disabled={i === view.order.length - 1} onClick={() => move(i, 1)}>↓</button>
              </>
            )}
          </li>
        );
      })}
    </ul>
  );
}

const HEIGHT_NAME: Record<RowHeight, string> = { low: "低", medium: "中", high: "高" };

export function RowHeightPanel({ view, patch }: { view: ViewConfig; patch: Patch }) {
  return (
    <div className="flex gap-1">
      {(Object.keys(HEIGHT_NAME) as RowHeight[]).map((h) => (
        <button key={h} type="button" aria-pressed={view.rowHeight === h} onClick={() => patch({ rowHeight: h })}
          className={"flex-1 rounded-md px-2 py-1 " + (view.rowHeight === h ? "bg-[var(--accent-bg)] text-[var(--foreground)]" : "text-[var(--foreground-muted)] hover:bg-[var(--surface-hover)]")}>
          {HEIGHT_NAME[h]}
        </button>
      ))}
    </div>
  );
}
