"use client";

import { AlignJustify, ArrowUpDown, Layers, ListFilter, RotateCcw, Search, SlidersHorizontal } from "lucide-react";
import { type ReactNode, useState } from "react";

import type { Job } from "@/lib/core";
import { VIEW_KINDS, VIEW_NAME, activeCounts, type ViewKind, type ViewState } from "@/lib/jobView";

import { FieldsPanel, FilterPanel, GroupPanel, Popover, RowHeightPanel, SortPanel, ctl, ghost, type Patch } from "./ViewPanels";

// 顶栏（Notion 式）：左边视图 tab，选中的是浅灰圆角底；右边一排灰色图标（筛选、分组、排序、搜索、字段、行高、重置），
// 生效的图标变深并带计数；搜索点了才展开输入框；最右墨黑主按钮「添加岗位」（全站唯一实心按钮样式，见 components/ui/Button）。
const icon = (Icon: typeof Search, name: string, count = 0): ReactNode => (
  <span title={name} aria-label={count ? count + " " + name : name} className="flex items-center gap-1">
    <Icon size={16} strokeWidth={1.75} aria-hidden />
    {count > 0 && <span className="text-[12px] tabular-nums">{count}</span>}
  </span>
);

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
  // 看板自带标签筛选、日历按周看事项，只有表格和甘特用这排工具；字段和行高只对表格有意义。
  const listing = state.active === "table" || state.active === "gantt";
  const [searching, setSearching] = useState(false);
  const showSearch = searching || search.length > 0;
  return (
    <div className="flex flex-wrap items-center gap-x-1 gap-y-2 pb-1">
      <div role="tablist" aria-label="视图" className="ou-segment">
        {VIEW_KINDS.map((k) => (
          <button key={k} type="button" role="tab" aria-selected={state.active === k} onClick={() => setActive(k)}
            className="ou-segment-item">
            {VIEW_NAME[k]}
          </button>
        ))}
      </div>
      <div className="ou-button-group ml-auto flex-wrap">
        {listing && (
          <>
            <Popover label={icon(ListFilter, "筛选", n.filter)} active={n.filter > 0} width={480}><FilterPanel view={view} jobs={jobs} patch={patch} /></Popover>
            <Popover label={icon(Layers, "分组", n.group)} active={n.group > 0} width={300}><GroupPanel view={view} patch={patch} /></Popover>
            <Popover label={icon(ArrowUpDown, "排序", n.sort)} active={n.sort > 0} width={340}><SortPanel view={view} patch={patch} /></Popover>
            {showSearch
              ? <input type="search" autoFocus value={search} onChange={(e) => setSearch(e.target.value)} onBlur={() => setSearching(false)}
                  onKeyDown={(e) => { if (e.key === "Escape") { setSearch(""); setSearching(false); } }}
                  placeholder="搜索公司、岗位、标签" aria-label="搜索岗位" className={ctl + " w-44"} />
              : <button type="button" className={ghost} onClick={() => setSearching(true)}>{icon(Search, "搜索")}</button>}
            {table && <Popover label={icon(SlidersHorizontal, n.hidden ? "隐藏字段" : "字段", n.hidden)} active={n.hidden > 0} width={240}><FieldsPanel view={view} patch={patch} /></Popover>}
            {table && <Popover label={icon(AlignJustify, "行高")} width={180}><RowHeightPanel view={view} patch={patch} /></Popover>}
            <button type="button" className={ghost} onClick={reset} title="恢复这个视图默认的筛选、分组、排序、字段和列宽">{icon(RotateCcw, "重置")}</button>
          </>
        )}
        <button type="button" onClick={onAdd} className="ou-button ou-button-primary ml-2">
          {adding ? "收起" : "添加岗位"}
        </button>
      </div>
    </div>
  );
}
