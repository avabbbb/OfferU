"use client";

import { ArrowUpDown, Eye, EyeOff, GripVertical, LayoutPanelTop, Layers, ListFilter, PlusCircle, Search } from "lucide-react";
import { type ReactNode, useState } from "react";

import { Input, Menu, Popover, Switch } from "@/components/ui";
import type { Job } from "@/lib/core";
import { BOARD_GROUP_FIELDS, CARD_FIELD_KEYS, boardGroupField, moveField, toggleCardField } from "@/lib/jobBoard";
import { FIELDS, activeCounts, type FieldKey, type ViewConfig } from "@/lib/jobView";

import { TYPE_ICON } from "./JobsTable";
import { FilterPanel, SortPanel, type Patch } from "./ViewPanels";

// 看板工具栏（照金山文档）：⊕ 添加记录 · 卡片管理 · 分组依据：状态 · 筛选(n) · 排序(n) · 查找。
// 筛选 / 排序沿用表格的面板和逻辑；生效的按钮是带计数的浅底胶囊。

const tool = (active?: boolean) => ({ className: "ou-board-tool", "data-active": active || undefined });

function ToolPopover({ trigger, width, label, children }: { trigger: ReactNode; width: number; label: string; children: ReactNode }) {
  return <Popover align="start" label={label} style={{ width }} trigger={trigger}>{children}</Popover>;
}

/** 卡片管理：显示字段名称的开关、搜字段、每个字段一行（拖动把手排序 + 眼睛切换显示）。 */
export function CardPanel({ view, patch }: { view: ViewConfig; patch: Patch }) {
  const [query, setQuery] = useState("");
  const [drag, setDrag] = useState<FieldKey | null>(null);
  const [over, setOver] = useState<FieldKey | null>(null);
  const keys = view.order.filter((k) => CARD_FIELD_KEYS.includes(k));
  const shown = keys.filter((k) => FIELDS[k].name.includes(query.trim()));
  const move = (from: FieldKey, dir: -1 | 1) => {
    const to = keys[keys.indexOf(from) + dir];
    if (to) patch(moveField(view, from, to));
  };
  return (
    <div className="ou-card-panel">
      <label className="ou-card-panel-row">
        <span>显示字段名称</span>
        <Switch checked={view.showNames} aria-label="显示字段名称" onCheckedChange={(v) => patch({ showNames: v })} />
      </label>
      <p className="ou-card-panel-caption">卡片显示的字段（拖动或 Alt + ↑↓ 调整顺序）</p>
      <Input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜索字段" aria-label="搜索字段" />
      <ul className="ou-card-panel-list" aria-label="卡片字段">
        {shown.map((k) => {
          const Icon = TYPE_ICON[FIELDS[k].type];
          const off = view.hidden.includes(k);
          return (
            <li key={k} className="ou-card-field" draggable data-off={off || undefined} data-over={(over === k && drag !== k) || undefined}
              onDragStart={(e) => { e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", k); setDrag(k); }}
              onDragOver={(e) => { e.preventDefault(); setOver(k); }}
              onDragLeave={() => setOver((cur) => (cur === k ? null : cur))}
              onDrop={(e) => { e.preventDefault(); if (drag && drag !== k) patch(moveField(view, drag, k)); setDrag(null); setOver(null); }}
              onDragEnd={() => { setDrag(null); setOver(null); }}>
              <GripVertical size={14} className="ou-card-field-grip" aria-hidden />
              <Icon size={14} strokeWidth={1.75} className="ou-card-field-icon" aria-hidden />
              <span className="ou-card-field-name">{FIELDS[k].name}</span>
              <button type="button" className="ou-card-field-eye" aria-pressed={!off}
                aria-label={(off ? "在卡片上显示「" : "在卡片上隐藏「") + FIELDS[k].name + "」"}
                title={off ? "显示" : "隐藏"} onClick={() => patch(toggleCardField(view, k))}
                onKeyDown={(e) => {
                  if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) { e.preventDefault(); move(k, e.key === "ArrowUp" ? -1 : 1); }
                }}>
                {off ? <EyeOff size={15} strokeWidth={1.75} aria-hidden /> : <Eye size={15} strokeWidth={1.75} aria-hidden />}
              </button>
            </li>
          );
        })}
        {!shown.length && <li className="ou-card-panel-caption">没有匹配的字段</li>}
      </ul>
    </div>
  );
}

export function BoardToolbar({ view, jobs, search, setSearch, patch, onAddRecord }: {
  view: ViewConfig;
  jobs: Job[];
  search: string;
  setSearch: (q: string) => void;
  patch: Patch;
  onAddRecord: () => void;
}) {
  const n = activeCounts(view);
  const group = boardGroupField(view);
  const [searching, setSearching] = useState(false);
  return (
    <div className="ou-board-toolbar" role="toolbar" aria-label="看板工具栏">
      <button type="button" className="ou-board-tool ou-board-tool-accent" onClick={onAddRecord}>
        <PlusCircle size={15} strokeWidth={1.9} aria-hidden />添加记录
      </button>
      <span className="ou-board-tool-sep" aria-hidden />
      <ToolPopover label="卡片管理" width={320} trigger={
        <button type="button" {...tool()}><LayoutPanelTop size={15} strokeWidth={1.75} aria-hidden />卡片管理</button>
      }><CardPanel view={view} patch={patch} /></ToolPopover>
      <Menu align="start" label="分组依据" trigger={
        <button type="button" {...tool()} aria-label={"分组依据：" + FIELDS[group].name}>
          <Layers size={15} strokeWidth={1.75} aria-hidden />分组依据：{FIELDS[group].name}
        </button>
      } items={[
        { heading: "请指定分组依据" },
        ...BOARD_GROUP_FIELDS.map((k) => {
          const Icon = TYPE_ICON[FIELDS[k].type];
          return { label: FIELDS[k].name, icon: <Icon size={15} strokeWidth={1.75} />, checked: k === group, onSelect: () => patch({ group: [k] }) };
        }),
      ]} />
      <ToolPopover label="筛选" width={480} trigger={
        <button type="button" {...tool(n.filter > 0)}><ListFilter size={15} strokeWidth={1.75} aria-hidden />筛选{n.filter > 0 && <span className="tabular-nums">({n.filter})</span>}</button>
      }><FilterPanel view={view} jobs={jobs} patch={patch} /></ToolPopover>
      <ToolPopover label="排序" width={340} trigger={
        <button type="button" {...tool(n.sort > 0)}><ArrowUpDown size={15} strokeWidth={1.75} aria-hidden />排序{n.sort > 0 && <span className="tabular-nums">({n.sort})</span>}</button>
      }><SortPanel view={view} patch={patch} /></ToolPopover>
      {searching || search
        ? <Input type="search" autoFocus value={search} onChange={(e) => setSearch(e.target.value)} onBlur={() => setSearching(false)}
            onKeyDown={(e) => { if (e.key === "Escape") { setSearch(""); setSearching(false); } }}
            placeholder="查找公司、岗位、标签" aria-label="查找岗位" className="ou-board-search" />
        : <button type="button" {...tool()} onClick={() => setSearching(true)}><Search size={15} strokeWidth={1.75} aria-hidden />查找</button>}
    </div>
  );
}
