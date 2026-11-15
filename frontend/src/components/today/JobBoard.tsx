"use client";

import { CalendarClock, ChevronsLeftRight, MoreHorizontal, PanelLeftClose, Plus } from "lucide-react";
import { useRouter } from "next/navigation";
import { type DragEvent, type KeyboardEvent, type ReactNode, useCallback, useMemo, useState } from "react";

import { JobTag } from "@/components/jobs/JobPickers";
import { TYPE_ICON } from "@/components/jobs/JobsTable";
import { Menu, Pill, toneOf } from "@/components/ui";
import { liftDragImage } from "@/lib/dragLift";
import {
  type BoardColumn, boardColumns, boardGroupField, canWriteGroup, cardFields, formatDay, groupPatch, toggleCollapsed,
} from "@/lib/jobBoard";
import { FIELDS, STATUS_TONE, applyView, defaultView, type FieldKey, type ViewConfig } from "@/lib/jobView";
import { type Event, JOB_STATUS, type Job, useTool, when, write } from "@/lib/core";
import { useScrollEdges } from "@/lib/scrollEdges";

// 看板（照金山文档多维表格的看板，换成 Glass 的颜色）：
// 列 = 固定宽、带组色浅底的圆角分区；列头 = 和表格同色的胶囊 + 数量 + 「…」（折叠该列、在此列添加记录）；折叠后是一条竖窄条。
// 卡片 = 白纸面 + 细边，标题「公司 · 岗位」，下面逐个显示「卡片管理」里勾选的字段（类型图标 + 字段名，值在下一行）。
// 悬停：细边变深 + 轻微浮起（不放大、不位移）；在右侧面板里打开的那张描一圈强调色。
// 拖到别的列 = 改分组字段（一条改动，可撤销），目标列底部出现落位占位；招聘类型来自 JD，不能拖。

/** 新建一条岗位（预填分组的值），返回新记录。 */
export async function createJob(data: Record<string, unknown> = {}): Promise<Job> {
  const { record } = await write<{ record: Job }>("save", { type: "job", data: { status: "saved", ...data } });
  return record;
}

/** 卡片上一个字段的值；空值返回 null（不显示这一行）。颜色和表格里同一个值的胶囊一致。 */
export function fieldValue(job: Job, field: FieldKey): ReactNode {
  switch (field) {
    case "status": return <Pill tone={STATUS_TONE[job.status]}>{JOB_STATUS[job.status]}</Pill>;
    case "city": return job.city ? <Pill tone={toneOf(job.city)}>{job.city}</Pill> : null;
    case "hire_type": return job.posting?.hire_type ? <Pill tone={toneOf(job.posting.hire_type)}>{job.posting.hire_type}</Pill> : null;
    case "tags": return job.tags?.length ? <span className="ou-board-tags">{job.tags.map((t) => <JobTag key={t} text={t} />)}</span> : null;
    case "score": return job.score != null ? <span className="tabular-nums" title={(job.reasons ?? []).join("\n") || undefined}>{job.score} 分</span> : null;
    case "applied_at": case "created_at": {
      const day = job[field]?.slice(0, 10);
      return day ? <span className="tabular-nums">{formatDay(day)}</span> : null;
    }
    default: return job[field] || null;
  }
}

export function JobBoard({ jobs: given, view: givenView, patch: givenPatch, openId = null, onOpen, events: givenEvents, embedded = false }: {
  /** 已经筛选、排序好的岗位；不传就自己取（「今天」页）。 */
  jobs?: Job[];
  view?: ViewConfig;
  patch?: (p: Partial<ViewConfig>) => void;
  openId?: number | null;
  onOpen?: (id: number) => void;
  events?: Event[];
  embedded?: boolean;
} = {}) {
  const router = useRouter();
  const own = given === undefined;
  const { data: fetched } = useTool<{ items: Job[] }>("list", { type: "job", limit: 500 }, own ? 5000 : 0);
  const { data: eventData } = useTool<{ items: Event[] }>("list", { type: "event", done: false, limit: 500 }, 5000);
  const [localView, setLocalView] = useState<ViewConfig>(() => defaultView("board"));
  const view = givenView ?? localView;
  const patch = useCallback((p: Partial<ViewConfig>) => (givenPatch ? givenPatch(p) : setLocalView((v) => ({ ...v, ...p }))), [givenPatch]);
  const open = useCallback((id: number) => (onOpen ? onOpen(id) : router.push("/jobs/" + id)), [onOpen, router]);
  const [over, setOver] = useState<string | null>(null);
  const [dragId, setDragId] = useState<number | null>(null);
  const [error, setError] = useState("");
  const trackRef = useScrollEdges<HTMLDivElement>("x");

  const jobs = useMemo(() => given ?? (fetched ? applyView(fetched.items, view) : undefined), [given, fetched, view]);
  const field = boardGroupField(view);
  const fields = cardFields(view);
  const columns = useMemo(() => (jobs ? boardColumns(jobs, field) : []), [jobs, field]);
  const upcoming = useMemo(() => {
    const map = new Map<number, Event>();
    [...(givenEvents ?? eventData?.items ?? [])]
      .filter((e) => e.job_id != null && e.at && !e.done)
      .sort((a, b) => a.at!.localeCompare(b.at!))
      .forEach((e) => { if (!map.has(e.job_id!)) map.set(e.job_id!, e); });
    return map;
  }, [givenEvents, eventData]);

  if (!jobs) return null;
  const writable = canWriteGroup(field);
  const fromKey = dragId == null ? null : columns.find((c) => c.jobs.some((j) => j.id === dragId))?.key ?? null;

  const drop = (column: BoardColumn, raw: string) => {
    setOver(null);
    setDragId(null);
    const job = jobs.find((j) => String(j.id) === raw);
    const data = groupPatch(field, column.value);
    if (!job || !data || columns.find((c) => c.jobs.includes(job))?.key === column.key) return;
    void write("save", { type: "job", id: job.id, data }).catch((e) => setError(e instanceof Error ? e.message : "没能移动这条记录"));
  };
  const dropZone = (column: BoardColumn) => writable ? {
    "data-over": over === column.key || undefined,
    onDragOver: (e: DragEvent) => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; if (over !== column.key) setOver(column.key); },
    onDragLeave: (e: DragEvent) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver((cur) => (cur === column.key ? null : cur)); },
    onDrop: (e: DragEvent) => { e.preventDefault(); drop(column, e.dataTransfer.getData("text/plain")); },
  } : {};
  const addIn = async (column: BoardColumn) => {
    setError("");
    try {
      const record = await createJob(groupPatch(field, column.value) ?? {});
      open(record.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : "没能新建记录");
    }
  };

  const card = (job: Job) => {
    const event = upcoming.get(job.id);
    const name = [job.company, job.title].filter(Boolean).join(" · ");
    const onKey = (e: KeyboardEvent) => {
      if (e.target !== e.currentTarget) return;
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(job.id); }
    };
    return (
      <li key={job.id} data-testid="job-card" role="button" tabIndex={0} draggable={writable}
        aria-label={(name || "未填公司") + "，打开记录"} aria-current={openId === job.id || undefined}
        data-selected={openId === job.id || undefined}
        onClick={() => open(job.id)} onKeyDown={onKey}
        onDragStart={(e) => { e.dataTransfer.setData("text/plain", String(job.id)); e.dataTransfer.effectAllowed = "move"; liftDragImage(e); setDragId(job.id); }}
        onDragEnd={() => { setDragId(null); setOver(null); }}
        className="ou-board-card">
        <p className="ou-board-card-title" title={name || undefined}>
          {job.company || <span className="ou-board-faint">未填公司</span>}
          {job.title && <span className="ou-board-card-sub"> · {job.title}</span>}
        </p>
        {event && (
          <p className="ou-board-card-event"><CalendarClock size={13} strokeWidth={1.75} aria-hidden /><span className="truncate">{when(event.at)} {event.title}</span></p>
        )}
        {fields.map((k) => {
          const value = fieldValue(job, k);
          if (value == null) return null;
          const Icon = TYPE_ICON[FIELDS[k].type];
          return (
            <div key={k} className="ou-board-field">
              {view.showNames && <p className="ou-board-field-name"><Icon size={12} strokeWidth={1.75} aria-hidden />{FIELDS[k].name}</p>}
              <div className="ou-board-field-value">{value}</div>
            </div>
          );
        })}
      </li>
    );
  };

  const addButton = (column: BoardColumn, sticky: boolean) => (
    <button type="button" onClick={() => void addIn(column)} aria-label={"在「" + column.label + "」添加记录"}
      className={"ou-board-add" + (sticky ? " ou-board-add-sticky" : "")}>
      <Plus size={14} strokeWidth={1.9} aria-hidden /> 添加记录
    </button>
  );

  const column = (c: BoardColumn) => {
    const collapsed = view.collapsed.includes(c.key);
    const tone = "ou-tone-" + c.tone;
    if (collapsed) {
      return (
        <section key={c.key} aria-label={c.label + "（已折叠）"} className={"ou-board-column ou-board-column-collapsed " + tone} {...dropZone(c)}>
          <button type="button" className="ou-board-strip" aria-expanded={false} aria-label={"展开「" + c.label + "」列，" + c.jobs.length + " 条"}
            title="展开该列" onClick={() => patch(toggleCollapsed(view, c.key))}>
            <ChevronsLeftRight size={14} strokeWidth={1.75} aria-hidden />
            <span className="ou-board-strip-name">{c.label}</span>
            <span className="tabular-nums ou-board-count">{c.jobs.length}</span>
          </button>
        </section>
      );
    }
    const showPlaceholder = over === c.key && dragId != null && fromKey !== c.key;
    return (
      <section key={c.key} aria-label={c.label} className={"ou-board-column " + tone} {...dropZone(c)}>
        <header className="ou-board-head">
          <Pill tone={c.tone}>{c.label}</Pill>
          <span className="tabular-nums ou-board-count">{c.jobs.length}</span>
          <Menu label={"「" + c.label + "」列操作"} trigger={
            <button type="button" className="ou-board-more" aria-label={"「" + c.label + "」列操作"}><MoreHorizontal size={16} strokeWidth={1.75} aria-hidden /></button>
          } items={[
            { label: "折叠该列", icon: <PanelLeftClose size={15} strokeWidth={1.75} />, onSelect: () => patch(toggleCollapsed(view, c.key)) },
            { label: "在此列添加记录", icon: <Plus size={15} strokeWidth={1.75} />, onSelect: () => void addIn(c) },
          ]} />
        </header>
        {!c.jobs.length && !showPlaceholder && addButton(c, false)}
        {(c.jobs.length > 0 || showPlaceholder) && (
          <ul className="ou-board-list">
            {c.jobs.map(card)}
            {showPlaceholder && <li className="ou-board-placeholder" aria-hidden />}
          </ul>
        )}
        {c.jobs.length > 0 && addButton(c, true)}
      </section>
    );
  };

  return (
    <section data-testid="today-board" className="ou-board">
      {(!embedded || error) && (
        <div className="ou-board-top">
          {!embedded && <h2 className="ou-board-heading">投递看板</h2>}
          {error && <span className="ou-field-error" role="alert">{error}</span>}
        </div>
      )}
      {own && !jobs.length && <p className="ou-board-empty">还没有岗位。可以在任意一列点「添加记录」，或去岗位页贴链接添加。</p>}
      <div ref={trackRef} className="ou-board-track ou-scroll-fade-x" aria-label={"看板，按" + FIELDS[field].name + "分组"}>
        {columns.map(column)}
      </div>
    </section>
  );
}
