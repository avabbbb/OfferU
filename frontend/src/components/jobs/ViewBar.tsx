"use client";

import type { Job } from "@/lib/core";
import { VIEW_KINDS, VIEW_NAME, activeCounts, type ViewKind, type ViewState } from "@/lib/jobView";

import { FieldsPanel, FilterPanel, GroupPanel, Popover, RowHeightPanel, SortPanel, ctl, ghost, type Patch } from "./ViewPanels";

// 顶栏：左边切视图，右边搜索、筛选、分组、排序、字段、行高、添加岗位。生效的项带计数（如「2 筛选」）。
export function ViewBar({ state, jobs, search, adding, setActive, setSearch, patch, reset, onAdd }: {
  state: ViewState;
  jobs: Job[];
  search: string;
  adding: boolean;
  setActive: (kind: ViewKind) => void;
  setSearch: (q: string) => void;
  patch: Patch;
  reset: () => void;
  onAdd: () => void;
}) {
  const view = state.views[state.active];
  const n = activeCounts(view);
  const table = state.active === "table";
  return (
    <div className="flex flex-wrap items-center gap-x-1 gap-y-2 border-b border-[var(--border)] pb-2">
      <div role="tablist" aria-label="视图" className="flex items-center gap-0.5">
        {VIEW_KINDS.map((k) => (
          <button key={k} type="button" role="tab" aria-selected={state.active === k} onClick={() => setActive(k)}
            className={"rounded-md px-2.5 py-1 text-[13px] " + (state.active === k
              ? "bg-[var(--accent-bg)] font-medium text-[var(--foreground)]"
              : "text-[var(--foreground-muted)] hover:bg-[var(--surface-hover)] hover:text-[var(--foreground)]")}>
            {VIEW_NAME[k]}
          </button>
        ))}
      </div>
      <div className="ml-auto flex flex-wrap items-center gap-1">
        {table && (
          <>
            <input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="搜索公司、岗位、标签" aria-label="搜索岗位" className={ctl + " w-44"} />
            <Popover label={n.filter ? n.filter + " 筛选" : "筛选"} active={n.filter > 0} width={480}><FilterPanel view={view} jobs={jobs} patch={patch} /></Popover>
            <Popover label={n.group ? n.group + " 分组" : "分组"} active={n.group > 0} width={300}><GroupPanel view={view} patch={patch} /></Popover>
            <Popover label={n.sort ? n.sort + " 排序" : "排序"} active={n.sort > 0} width={340}><SortPanel view={view} patch={patch} /></Popover>
            <Popover label={n.hidden ? n.hidden + " 隐藏字段" : "字段"} active={n.hidden > 0} width={240}><FieldsPanel view={view} patch={patch} /></Popover>
            <Popover label="行高" width={180}><RowHeightPanel view={view} patch={patch} /></Popover>
            <button type="button" className={ghost} onClick={reset} title="恢复这个视图默认的筛选、分组、排序、字段和列宽">重置</button>
          </>
        )}
        <button type="button" onClick={onAdd} className="ml-1 rounded-md bg-[var(--foreground)] px-3 py-1 text-[13px] font-medium text-[var(--background)]">
          {adding ? "收起" : "+ 添加岗位"}
        </button>
      </div>
    </div>
  );
}
