"use client";

import { CalendarCheck, PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { type MouseEvent, type PointerEvent, useEffect, useMemo, useRef, useState } from "react";

import { EVENT_KIND, type Event, type EventKind, type Job, write } from "@/lib/core";
import { DAY_PX, SCALE_NAME, barLabel, barOf, dragDays, fromDay, rangeOf, shiftAt, ticks, today, type Scale } from "@/lib/jobGantt";
import { STATUS_TONE, groupJobs, type ViewConfig } from "@/lib/jobView";

import { flatten, type Item } from "./JobsTable";
import { ghost } from "./ViewPanels";

// 甘特视图：左边冻结岗位列，右边时间轴。条 = 收藏日到最后一件事项（进行中的画到今天），颜色跟状态；
// 条上的菱形是事项（截止 / 笔试 / 面试 / 待办），悬停看标题和日期，已完成的变淡。点条或岗位名打开右侧详情。
// 筛选、排序、分组用甘特视图自己的配置；缩放只有周 / 月两档。

// 低饱和填充色（和状态胶囊同一套色），圆角色块、不加左边框，照 Notion 时间线。
const BAR: Record<string, string> = {
  gray: "rgba(163, 163, 163, 0.22)", blue: "rgba(59, 130, 246, 0.18)", yellow: "rgba(245, 158, 11, 0.22)", orange: "rgba(234, 88, 12, 0.18)",
  green: "rgba(16, 185, 129, 0.2)", red: "rgba(244, 63, 94, 0.16)",
};
const DOT: Record<string, string> = { deadline: "rgb(225, 29, 72)", test: "rgb(217, 119, 6)", interview: "rgb(234, 88, 12)", todo: "rgb(115, 115, 115)" };
const LEFT = 240;
const ROW = 36;
const HEAD = 22;

export function JobsGantt({ jobs, events, view, openId, onOpen }: {
  jobs: Job[];
  events: Event[];
  view: ViewConfig;
  openId: number | null;
  onOpen: (id: number) => void;
}) {
  const [scale, setScale] = useState<Scale>("week");
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const scroller = useRef<HTMLDivElement>(null);
  // 拖菱形改事项日期：drag 是正在拖的那个（dx 像素，saving 时等写回），undo 是上一次改期，可撤销。
  const [drag, setDrag] = useState<{ id: number; x0: number; dx: number; saving?: boolean } | null>(null);
  const [undo, setUndo] = useState<{ id: number; title: string; from: string; to: string } | null>(null);
  // 点时间轴空白处：在那天给这个岗位加事项。
  const [adding, setAdding] = useState<{ jobId: number; day: number } | null>(null);
  // 左侧岗位列可折叠成一条窄边（« / »）；scrollX 跟着横向滚动，用来判断哪些条跑出了可视区。
  const [fold, setFold] = useState(false);
  const [scrollX, setScrollX] = useState(0);
  // 时间轴可视宽度：天数不够时往右补，网格总是铺满容器。
  const [viewW, setViewW] = useState(0);
  const shown = jobs.length > 0;
  useEffect(() => {
    const el = scroller.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([entry]) => setViewW(entry.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, [shown]);
  const now = today();
  const px = DAY_PX[scale];
  const left = fold ? 36 : LEFT;

  const bars = useMemo(() => new Map(jobs.map((j) => [j.id, barOf(j, events, now)])), [jobs, events, now]);
  const { from, to } = useMemo(() => rangeOf([...bars.values()], now, Math.ceil(Math.max(0, viewW - left) / px)), [bars, now, viewW, left, px]);
  const days = useMemo(() => ticks(from, to), [from, to]);
  const eventById = useMemo(() => new Map(events.map((e) => [e.id, e])), [events]);
  const items = useMemo(() => {
    if (!view.group.length) return jobs.map((job): Item => ({ kind: "row", job, key: String(job.id) }));
    const out: Item[] = [];
    flatten(groupJobs(jobs, view.group), collapsed, 0, out);
    return out;
  }, [jobs, view.group, collapsed]);

  const width = days.length * px;
  const nowX = (now - from) * px;
  // 周末底色（firstSat：第一个周六）和日分隔线用重复渐变画在每行背景上，不必每天一个元素。
  const firstSat = days.findIndex((t, i) => t.weekend && days[i + 1]?.weekend);
  const grid = {
    backgroundImage: "linear-gradient(90deg, color-mix(in srgb, var(--surface-hover) 55%, transparent) " + 2 * px + "px, transparent 0)"
      + (scale === "week" ? ", linear-gradient(90deg, color-mix(in srgb, var(--border) 40%, transparent) 1px, transparent 0)" : ""),
    backgroundSize: 7 * px + "px 100%" + (scale === "week" ? ", " + px + "px 100%" : ""),
    backgroundPosition: firstSat * px + "px 0" + (scale === "week" ? ", 0 0" : ""),
  };

  const toToday = () => {
    const el = scroller.current;
    if (el) el.scrollLeft = Math.max(0, nowX - (el.clientWidth - left) / 2);
  };
  // 打开和换缩放时把今天放到可视区中间。
  useEffect(toToday, [scale, from]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!jobs.length) return <p className="text-[13.5px] text-[var(--foreground-muted)]">没有符合条件的岗位。</p>;

  const toggle = (key: string) => setCollapsed((s) => { const n = new Set(s); if (n.has(key)) n.delete(key); else n.add(key); return n; });
  const leftCell = "sticky left-0 z-10 flex shrink-0 items-center bg-[var(--surface-opaque)] px-2";

  const moveEvent = (id: number, at: string) => write("save", { type: "event", id, data: { at } });
  const startDrag = (e: PointerEvent<HTMLElement>, id: number) => {
    if (e.button !== 0 || drag?.saving) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    setDrag({ id, x0: e.clientX, dx: 0 });
  };
  const moveDrag = (e: PointerEvent<HTMLElement>) => {
    if (drag && !drag.saving) setDrag({ ...drag, dx: e.clientX - drag.x0 });
  };
  // 松手：挪了整天才写回 event.at（保留时刻）；写回期间菱形停在新位置，刷新后由数据接管。
  const endDrag = async () => {
    if (!drag || drag.saving) return;
    const ev = eventById.get(drag.id);
    const days = dragDays(drag.dx, px);
    if (!ev?.at || !days) { setDrag(null); return; }
    const to = shiftAt(ev.at, days);
    setDrag({ ...drag, saving: true });
    try {
      await moveEvent(ev.id, to);
      setUndo({ id: ev.id, title: ev.title, from: ev.at, to });
    } finally {
      setDrag(null);
    }
  };
  const revert = async () => {
    if (!undo) return;
    await moveEvent(undo.id, undo.from);
    setUndo(null);
  };
  // 只认直接点在行背景上（条、菱形、表单本身不算），换算成那一天。
  const addAt = (e: MouseEvent<HTMLDivElement>, jobId: number) => {
    if (e.target !== e.currentTarget || drag) return;
    const x = e.clientX - e.currentTarget.getBoundingClientRect().left;
    setAdding({ jobId, day: from + Math.floor(x / px) });
  };

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2 text-[12.5px] text-[var(--foreground-muted)]">
        <div role="group" aria-label="缩放" className="flex gap-0.5">
          {(Object.keys(SCALE_NAME) as Scale[]).map((s) => (
            <button key={s} type="button" aria-pressed={scale === s} onClick={() => setScale(s)}
              className={ghost + (scale === s ? " bg-[var(--accent-bg)] text-[var(--foreground)]" : "")}>{SCALE_NAME[s]}</button>
          ))}
        </div>
        <button type="button" className={ghost + " inline-flex items-center gap-1"} onClick={toToday} title="滚到今天"><CalendarCheck size={14} strokeWidth={1.75} />今天</button>
        {undo && (
          <span role="status" className="flex items-center gap-1">
            已把「{undo.title}」改到 {undo.to.slice(5, 10)}
            <button type="button" className={ghost} onClick={revert}>撤销</button>
          </span>
        )}
        <span className="ml-auto flex flex-wrap items-center gap-3">
          {(["deadline", "test", "interview", "todo"] as const).map((k) => (
            <span key={k} className="flex items-center gap-1">
              <i className="inline-block h-2 w-2 rotate-45" style={{ background: DOT[k] }} />{EVENT_KIND[k]}
            </span>
          ))}
        </span>
      </div>

      <div ref={scroller} data-testid="jobs-gantt" onScroll={(e) => setScrollX(e.currentTarget.scrollLeft)} className="max-h-[70vh] overflow-auto border-t border-[var(--border)] text-[13px]">
        <div style={{ width: left + width }}>
          <div className="sticky top-0 z-20 flex border-b border-[var(--border)] bg-[var(--surface-opaque)]">
            <div className={leftCell + " z-30 justify-between gap-1 px-1.5 text-[var(--foreground-muted)]"} style={{ width: left, height: HEAD * 2 }}>
              {!fold && <span className="pl-0.5">岗位</span>}
              <button type="button" onClick={() => setFold(!fold)} aria-label={fold ? "展开岗位列" : "折叠岗位列"} title={fold ? "展开岗位列" : "折叠岗位列"}
                className="rounded p-1 hover:bg-[var(--surface-hover)] hover:text-[var(--foreground)]">{fold ? <PanelLeftOpen size={14} strokeWidth={1.75} /> : <PanelLeftClose size={14} strokeWidth={1.75} />}</button>
            </div>
            <div className="relative" style={{ width, height: HEAD * 2 }}>
              {days.map((t) => (
                <span key={t.day} className="absolute text-[11.5px] tabular-nums" style={{ left: (t.day - from) * px, width: px, top: HEAD }}>
                  {(scale === "week" || (t.dom % 5 === 1 && t.dom !== 31)) && (
                    <span className={"block text-center " + (t.day === now ? "font-semibold text-[var(--foreground)]" : t.weekend ? "text-[var(--foreground-faint)]" : "text-[var(--foreground-muted)]")}>{t.dom}</span>
                  )}
                </span>
              ))}
              {days.filter((t) => t.monthStart).map((t) => (
                <span key={"m" + t.day} className="absolute top-1 whitespace-nowrap pl-1 text-[12px] font-medium text-[var(--foreground-soft)]" style={{ left: (t.day - from) * px }}>
                  {t.date.slice(0, 4)}年{Number(t.date.slice(5, 7))}月
                </span>
              ))}
              <span aria-hidden className="absolute bottom-0 h-1.5 w-1.5 -translate-x-1/2 translate-y-1/2 rounded-full bg-rose-500" style={{ left: nowX + px / 2 }} />
            </div>
          </div>

          {items.map((it) => {
            if (it.kind === "group") {
              const shut = collapsed.has(it.g.key);
              return (
                <div key={"g" + it.g.key} className="flex border-b border-[var(--border)] bg-[var(--surface)]" style={{ height: ROW - 4 }}>
                  <button type="button" onClick={() => toggle(it.g.key)} className={leftCell + " gap-1.5 bg-[var(--surface)] text-left font-medium" + (fold ? " justify-center" : "")}
                    style={{ width: left, paddingLeft: fold ? 0 : 8 + it.depth * 14 }} aria-expanded={!shut} title={fold ? it.g.label + " " + it.g.jobs.length : undefined}>
                    <span className="text-[11px] text-[var(--foreground-muted)]">{shut ? "▸" : "▾"}</span>
                    {!fold && <span className="truncate">{it.g.label}</span>}
                    {!fold && <span className="text-[12px] font-normal text-[var(--foreground-muted)]">{it.g.jobs.length}</span>}
                  </button>
                  <div style={{ width }} />
                </div>
              );
            }
            const { job } = it;
            const bar = bars.get(job.id);
            if (!bar) return null;
            const fill = BAR[STATUS_TONE[job.status]];
            const active = job.id === openId;
            const wide = (bar.end - bar.start + 1) * px > 64;
            // 条整个在可视区左边或右边时，行内贴边出 ← / →，点了滚到条的起点。
            const x0 = (bar.start - from) * px;
            const x1 = (bar.end - from + 1) * px;
            const vis = viewW - left;
            const jump = vis <= 0 ? null : x1 < scrollX ? "←" : x0 > scrollX + vis ? "→" : null;
            return (
              <div key={it.key} className={"flex border-b border-[var(--border)] " + (active ? "bg-[var(--accent-bg)]" : "")} style={{ height: ROW }}>
                <button type="button" onClick={() => onOpen(job.id)} className={leftCell + " min-w-0 gap-1.5 overflow-hidden text-left hover:text-[var(--foreground)]" + (fold ? " justify-center px-0" : "") + (active ? " bg-[var(--accent-bg)]" : "")}
                  style={{ width: left }} title={[job.company, job.title].filter(Boolean).join(" · ")}>
                  {/* 折叠成窄边时只显示公司首字（Array.from 按字符取，不会切坏 emoji / 生僻字），全名看 title。 */}
                  <span className="shrink-0 font-medium">{fold ? Array.from(job.company || "?")[0] : job.company || "未填公司"}</span>
                  {!fold && <span className="truncate text-[var(--foreground-muted)]">{job.title}</span>}
                </button>
                <div className="relative cursor-cell" style={{ width, ...grid }} onClick={(e) => addAt(e, job.id)} title="点空白处在这天加事项">
                  <span aria-hidden className="absolute inset-y-0 w-px bg-rose-500/60" style={{ left: nowX + px / 2 }} />
                  {jump && (
                    <button type="button" data-testid="gantt-jump" aria-label={(jump === "←" ? "往左" : "往右") + "滚到这条"}
                      onClick={() => scroller.current?.scrollTo({ left: Math.max(0, x0 - 24), behavior: "smooth" })}
                      className="absolute z-[2] rounded border border-[var(--border)] bg-[var(--surface-opaque)] px-1 text-[12px] leading-[18px] text-[var(--foreground-muted)] hover:text-[var(--foreground)]"
                      style={{ left: jump === "←" ? scrollX + 4 : scrollX + vis - 28, top: ROW / 2 - 10 }}>{jump}</button>
                  )}
                  <button type="button" onClick={() => onOpen(job.id)} data-testid="gantt-bar"
                    title={fromDay(bar.start) + " → " + fromDay(bar.end)}
                    className={"absolute flex items-center overflow-hidden whitespace-nowrap rounded-md px-2 text-[12px] text-[var(--foreground)]" + (bar.ended ? " opacity-60" : "")}
                    style={{ left: (bar.start - from) * px + 1, width: Math.max(px - 2, (bar.end - bar.start + 1) * px - 2), top: 7, height: ROW - 14, background: fill }}>
                    {wide && barLabel(bar, now)}
                  </button>
                  {!wide && (
                    <span className="pointer-events-none absolute whitespace-nowrap text-[12px] leading-[18px] text-[var(--foreground-muted)]"
                      style={{ left: (bar.end - from + 1) * px + 4, top: ROW / 2 - 9 }}>{barLabel(bar, now)}</span>
                  )}
                  {bar.milestones.map((m) => {
                    const shift = drag?.id === m.id ? dragDays(drag.dx, px) : 0;
                    const moving = drag?.id === m.id;
                    const day = m.day + shift;
                    return (
                      <span key={m.id} role="img" aria-label={EVENT_KIND[m.kind] + " " + m.title} data-testid="gantt-milestone"
                        onPointerDown={(e) => startDrag(e, m.id)} onPointerMove={moveDrag} onPointerUp={endDrag} onPointerCancel={() => setDrag(null)}
                        className={"group absolute z-[1] flex touch-none select-none items-center justify-center hover:z-30 " + (moving ? "cursor-grabbing" : "cursor-grab")}
                        style={{ left: (day - from) * px + px / 2 - 7, top: ROW / 2 - 7, width: 14, height: 14 }}>
                        <i className={"block h-2.5 w-2.5 rotate-45 border border-white" + (m.done ? " opacity-40" : "")} style={{ background: DOT[m.kind] }} />
                        {moving && shift !== 0 && (
                          <span className="pointer-events-none absolute bottom-full mb-1 whitespace-nowrap rounded border border-[var(--border)] bg-[var(--surface-opaque)] px-1 text-[11px] tabular-nums">{fromDay(day).slice(5)}</span>
                        )}
                        {!moving && (
                          <span role="tooltip" data-testid="gantt-milestone-card"
                            className="pointer-events-none absolute left-1/2 top-full mt-1.5 hidden w-max max-w-[240px] -translate-x-1/2 rounded-md border border-[var(--border)] bg-[var(--surface-opaque)] px-2 py-1 text-left text-[12px] leading-[18px] shadow-sm group-hover:block">
                            <span className="block font-medium text-[var(--foreground)]">{m.title}</span>
                            <span className="block tabular-nums text-[var(--foreground-muted)]">
                              {EVENT_KIND[m.kind]} · {(eventById.get(m.id)?.at ?? fromDay(m.day)).replace("T", " ").slice(0, 16)}{m.done ? " · 已完成" : ""}
                            </span>
                            {eventById.get(m.id)?.notes && <span className="line-clamp-3 block text-[var(--foreground-soft)]">{eventById.get(m.id)?.notes}</span>}
                            <span className="block text-[11px] text-[var(--foreground-faint)]">拖动改日期</span>
                          </span>
                        )}
                      </span>
                    );
                  })}
                  {adding?.jobId === job.id && (
                    <AddEvent key={adding.day} jobId={job.id} day={adding.day} left={Math.max(scrollX, Math.min((adding.day - from) * px, scrollX + vis - 330, width - 330))} onDone={() => setAdding(null)} />
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// 点空白处弹出的小表单：类型 + 标题，日期就是点的那天；回车保存，Esc 或点别处取消。
function AddEvent({ jobId, day, left, onDone }: { jobId: number; day: number; left: number; onDone: () => void }) {
  const [title, setTitle] = useState("");
  const [kind, setKind] = useState<EventKind>("todo");
  const save = async () => {
    if (title.trim()) await write("save", { type: "event", data: { title: title.trim(), kind, at: fromDay(day), job_id: jobId } });
    onDone();
  };
  return (
    <form data-testid="gantt-add-event" aria-label="加事项"
      className="absolute z-30 flex items-center gap-1 rounded-md border border-[var(--border)] bg-[var(--surface-opaque)] p-1 text-[12px] shadow-sm"
      style={{ left, top: 3, height: ROW - 6 }}
      onSubmit={(e) => { e.preventDefault(); void save(); }}
      onKeyDown={(e) => { if (e.key === "Escape") onDone(); }}
      onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) onDone(); }}>
      <span className="shrink-0 whitespace-nowrap px-1 tabular-nums text-[var(--foreground-muted)]">{fromDay(day).slice(5)}</span>
      <select value={kind} onChange={(e) => setKind(e.target.value as EventKind)} aria-label="事项类型" className="bg-transparent">
        {(Object.keys(EVENT_KIND) as EventKind[]).map((k) => <option key={k} value={k}>{EVENT_KIND[k]}</option>)}
      </select>
      <input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="事项标题，回车保存" aria-label="事项标题"
        className="w-44 bg-transparent outline-none" />
    </form>
  );
}
