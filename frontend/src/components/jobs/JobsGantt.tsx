"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import { EVENT_KIND, type Event, type Job } from "@/lib/core";
import { DAY_PX, SCALE_NAME, barLabel, barOf, fromDay, rangeOf, ticks, today, type Scale } from "@/lib/jobGantt";
import { STATUS_TONE, groupJobs, type ViewConfig } from "@/lib/jobView";

import { flatten, type Item } from "./JobsTable";
import { ghost } from "./ViewPanels";

// 甘特视图：左边冻结岗位列，右边时间轴。条 = 收藏日到最后一件事项（进行中的画到今天），颜色跟状态；
// 条上的菱形是事项（截止 / 笔试 / 面试 / 待办），悬停看标题和日期，已完成的变淡。点条或岗位名打开右侧详情。
// 筛选、排序、分组用甘特视图自己的配置；缩放只有周 / 月两档。

// [填充, 左边框]，和状态胶囊同一套色。
const BAR: Record<string, [string, string]> = {
  slate: ["rgba(100, 116, 139, 0.16)", "rgb(100, 116, 139)"],
  blue: ["rgba(59, 130, 246, 0.16)", "rgb(37, 99, 235)"],
  yellow: ["rgba(245, 158, 11, 0.18)", "rgb(217, 119, 6)"],
  orange: ["rgba(249, 115, 22, 0.18)", "rgb(234, 88, 12)"],
  green: ["rgba(16, 185, 129, 0.18)", "rgb(5, 150, 105)"],
  red: ["rgba(244, 63, 94, 0.14)", "rgb(225, 29, 72)"],
  gray: ["rgba(163, 163, 163, 0.18)", "rgb(115, 115, 115)"],
};
const DOT: Record<string, string> = { deadline: "rgb(225, 29, 72)", test: "rgb(217, 119, 6)", interview: "rgb(234, 88, 12)", todo: "rgb(100, 116, 139)" };
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

  const bars = useMemo(() => new Map(jobs.map((j) => [j.id, barOf(j, events, now)])), [jobs, events, now]);
  const { from, to } = useMemo(() => rangeOf([...bars.values()], now, Math.ceil(Math.max(0, viewW - LEFT) / px)), [bars, now, viewW, px]);
  const days = useMemo(() => ticks(from, to), [from, to]);
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
    backgroundImage: "linear-gradient(90deg, var(--surface-hover) " + 2 * px + "px, transparent 0)"
      + (scale === "week" ? ", linear-gradient(90deg, var(--border) 1px, transparent 0)" : ""),
    backgroundSize: 7 * px + "px 100%" + (scale === "week" ? ", " + px + "px 100%" : ""),
    backgroundPosition: firstSat * px + "px 0" + (scale === "week" ? ", 0 0" : ""),
  };

  const toToday = () => {
    const el = scroller.current;
    if (el) el.scrollLeft = Math.max(0, nowX - (el.clientWidth - LEFT) / 2);
  };
  // 打开和换缩放时把今天放到可视区中间。
  useEffect(toToday, [scale, from]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!jobs.length) return <p className="text-[13.5px] text-[var(--foreground-muted)]">没有符合条件的岗位。</p>;

  const toggle = (key: string) => setCollapsed((s) => { const n = new Set(s); if (n.has(key)) n.delete(key); else n.add(key); return n; });
  const leftCell = "sticky left-0 z-10 flex shrink-0 items-center border-r border-[var(--border)] bg-[var(--surface-opaque)] px-2";

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2 text-[12.5px] text-[var(--foreground-muted)]">
        <div role="group" aria-label="缩放" className="flex gap-0.5">
          {(Object.keys(SCALE_NAME) as Scale[]).map((s) => (
            <button key={s} type="button" aria-pressed={scale === s} onClick={() => setScale(s)}
              className={ghost + (scale === s ? " bg-[var(--accent-bg)] text-[var(--foreground)]" : "")}>{SCALE_NAME[s]}</button>
          ))}
        </div>
        <button type="button" className={ghost} onClick={toToday}>今天</button>
        <span className="ml-auto flex flex-wrap items-center gap-3">
          {(["deadline", "test", "interview", "todo"] as const).map((k) => (
            <span key={k} className="flex items-center gap-1">
              <i className="inline-block h-2 w-2 rotate-45" style={{ background: DOT[k] }} />{EVENT_KIND[k]}
            </span>
          ))}
        </span>
      </div>

      <div ref={scroller} data-testid="jobs-gantt" className="max-h-[70vh] overflow-auto rounded-lg border border-[var(--border)] text-[13px]">
        <div style={{ width: LEFT + width }}>
          <div className="sticky top-0 z-20 flex border-b border-[var(--border)] bg-[var(--surface-opaque)]">
            <div className={leftCell + " z-30 text-[var(--foreground-muted)]"} style={{ width: LEFT, height: HEAD * 2 }}>岗位</div>
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
            </div>
          </div>

          {items.map((it) => {
            if (it.kind === "group") {
              const shut = collapsed.has(it.g.key);
              return (
                <div key={"g" + it.g.key} className="flex border-b border-[var(--border)] bg-[var(--surface)]" style={{ height: ROW - 4 }}>
                  <button type="button" onClick={() => toggle(it.g.key)} className={leftCell + " gap-1.5 bg-[var(--surface)] text-left font-medium"}
                    style={{ width: LEFT, paddingLeft: 8 + it.depth * 14 }} aria-expanded={!shut}>
                    <span className="text-[11px] text-[var(--foreground-muted)]">{shut ? "▸" : "▾"}</span>
                    <span className="truncate">{it.g.label}</span>
                    <span className="text-[12px] font-normal text-[var(--foreground-muted)]">{it.g.jobs.length}</span>
                  </button>
                  <div style={{ width }} />
                </div>
              );
            }
            const { job } = it;
            const bar = bars.get(job.id);
            if (!bar) return null;
            const [fill, edge] = BAR[STATUS_TONE[job.status]];
            const active = job.id === openId;
            const wide = (bar.end - bar.start + 1) * px > 64;
            return (
              <div key={it.key} className={"flex border-b border-[var(--border)] " + (active ? "bg-[var(--accent-bg)]" : "")} style={{ height: ROW }}>
                <button type="button" onClick={() => onOpen(job.id)} className={leftCell + " min-w-0 gap-1.5 text-left hover:text-[var(--foreground)]" + (active ? " bg-[var(--accent-bg)]" : "")}
                  style={{ width: LEFT }} title={[job.company, job.title].filter(Boolean).join(" · ")}>
                  <span className="shrink-0 font-medium">{job.company || "未填公司"}</span>
                  <span className="truncate text-[var(--foreground-muted)]">{job.title}</span>
                </button>
                <div className="relative" style={{ width, ...grid }}>
                  <span aria-hidden className="absolute inset-y-0 w-px bg-rose-400" style={{ left: nowX + px / 2 }} />
                  <button type="button" onClick={() => onOpen(job.id)} data-testid="gantt-bar"
                    title={fromDay(bar.start) + " → " + fromDay(bar.end)}
                    className={"absolute flex items-center overflow-hidden whitespace-nowrap rounded px-1.5 text-[12px] text-[var(--foreground)]" + (bar.ended ? " opacity-60" : "")}
                    style={{ left: (bar.start - from) * px + 1, width: Math.max(px - 2, (bar.end - bar.start + 1) * px - 2), top: 7, height: ROW - 14, background: fill, borderLeft: "3px solid " + edge }}>
                    {wide && barLabel(bar, now)}
                  </button>
                  {!wide && (
                    <span className="pointer-events-none absolute whitespace-nowrap text-[12px] leading-[18px] text-[var(--foreground-muted)]"
                      style={{ left: (bar.end - from + 1) * px + 4, top: ROW / 2 - 9 }}>{barLabel(bar, now)}</span>
                  )}
                  {bar.milestones.map((m) => (
                    <i key={m.id} role="img" aria-label={EVENT_KIND[m.kind]} title={EVENT_KIND[m.kind] + " · " + m.title + " · " + fromDay(m.day) + (m.done ? "（已完成）" : "")}
                      className={"absolute block h-2.5 w-2.5 rotate-45 border border-white" + (m.done ? " opacity-40" : "")}
                      style={{ left: (m.day - from) * px + px / 2 - 5, top: ROW / 2 - 5, background: DOT[m.kind] }} />
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
