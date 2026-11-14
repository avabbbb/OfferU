"use client";

import { CalendarClock, ChevronLeft, ChevronRight, Flag, MoreHorizontal, PenLine, Plus, Users } from "lucide-react";
import { useRouter } from "next/navigation";
import { type CSSProperties, type DragEvent, useEffect, useMemo, useRef, useState } from "react";

import { Button, DatePicker, Menu, Popover, Select } from "@/components/ui";
import { liftDragImage } from "@/lib/dragLift";
import { EVENT_KIND, type Event, type EventKind, write } from "@/lib/core";
import {
  DAY_END, DAY_START, VISUAL_MINUTES, WEEKDAYS, dropAt, eventTone, isoWeek, layoutDay, minuteOf, pad, type Placed, type Stack, weekDays, weekStart, ymd,
} from "@/lib/weekCalendar";

// 周日历（参考 Inspora · sam「Event Swatch」）：安静的无框网格 + 只有胶囊的工具条；
// 事项是一块块浮起来的色块（按类型取 --ou-tone-*：浅色面、内侧白边、底边略深像有厚度、16px 圆角）；
// 只有「今天 / 现在」用橙色；悬停轻轻放大（弹簧），拖起来微倾 + 阴影变深，拖到别的格子就改时间；
// 同一时段挤在一起的叠成一摞，右上角「+N 隐藏」，点开并排展开。

const KIND_ICON: Record<EventKind, typeof Users> = { interview: Users, test: PenLine, deadline: Flag, todo: CalendarClock };
const HOURS = Array.from({ length: DAY_END - DAY_START }, (_, i) => DAY_START + i);
const vars = (v: Record<string, string | number>) => v as CSSProperties;

function useNow() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(t);
  }, []);
  return now;
}

function Swatch({ p, onDragStart, hiddenCount, onExpand }: { p: Placed; onDragStart: (e: DragEvent<HTMLElement>, p: Placed) => void; hiddenCount?: number; onExpand?: () => void }) {
  const router = useRouter();
  const { event } = p;
  const Icon = KIND_ICON[event.kind ?? "todo"] ?? CalendarClock;
  const time = event.at ? event.at.split("T")[1]?.slice(0, 5) : "";
  const meta = [time, EVENT_KIND[event.kind ?? "todo"], event.job_label?.split(" · ")[0]].filter(Boolean).join(" · ");
  return (
    <article draggable data-testid="calendar-event" className={`ou-swatch ou-tone-${eventTone(event)} ou-cal-event`} data-done={event.done || undefined}
      title={[event.title, event.job_label].filter(Boolean).join(" · ")}
      onDragStart={(e) => onDragStart(e, p)}>
      <div className="ou-swatch-top">
        <Icon size={15} strokeWidth={1.9} aria-hidden />
        {hiddenCount ? (
          <button type="button" className="ou-swatch-hidden" onClick={onExpand} aria-label={`还有 ${hiddenCount} 件，展开`}>+{hiddenCount} 隐藏</button>
        ) : null}
        <Menu align="end" label="事项操作" items={[
          { heading: event.title },
          { label: event.done ? "标记为没做完" : "标记完成", onSelect: () => void write("save", { type: "event", id: event.id, data: { done: !event.done } }) },
          ...(event.job_id != null ? [{ label: "打开岗位", onSelect: () => router.push("/jobs/" + event.job_id) }] : []),
          "separator" as const,
          { label: "删除", danger: true, onSelect: () => void write("delete", { type: "event", id: event.id }) },
        ]} trigger={
          <button type="button" className="ou-swatch-more" aria-label={"「" + event.title + "」的更多操作"}><MoreHorizontal size={15} strokeWidth={2} /></button>
        } />
      </div>
      <div className="ou-swatch-body">
        <p className="ou-swatch-meta">{meta}</p>
        <p className="ou-swatch-title">{event.title}</p>
      </div>
    </article>
  );
}

function StackView({ s, onDragStart }: { s: Stack; onDragStart: (e: DragEvent<HTMLElement>, p: Placed) => void }) {
  const [open, setOpen] = useState(false);
  const n = s.items.length;
  if (n === 1 || open) {
    return (
      <div className="ou-cal-stack" data-open={n > 1 || undefined} style={vars({ "--t": s.top, "--h": s.height, "--n": n })}
        onMouseLeave={() => setOpen(false)}>
        {s.items.map((p, i) => (
          <div key={p.event.id} className="ou-cal-slot" style={vars({ "--t": p.top - s.top, "--i": i })}>
            <Swatch p={p} onDragStart={onDragStart} />
          </div>
        ))}
      </div>
    );
  }
  // 叠起来：后面的往下错开、略小，只露出底边；最上面那张带「+N 隐藏」。
  const [first, ...rest] = s.items;
  return (
    <div className="ou-cal-stack" data-stacked style={vars({ "--t": first.top, "--h": first.height })}>
      {rest.slice(0, 2).reverse().map((p, i, arr) => (
        <div key={p.event.id} className="ou-cal-behind" style={vars({ "--k": arr.length - i })} aria-hidden>
          <div className={`ou-swatch ou-tone-${eventTone(p.event)} ou-cal-event`} />
        </div>
      ))}
      <div className="ou-cal-front"><Swatch p={first} onDragStart={onDragStart} hiddenCount={n - 1} onExpand={() => setOpen(true)} /></div>
    </div>
  );
}

function AddEventButton({ defaultAt }: { defaultAt: string }) {
  const [title, setTitle] = useState("");
  const [kind, setKind] = useState<EventKind>("todo");
  const [at, setAt] = useState(defaultAt);
  const [busy, setBusy] = useState(false);
  const add = async () => {
    if (!title.trim()) return;
    setBusy(true);
    try {
      await write("save", { type: "event", data: { title: title.trim(), kind, at: at || null } });
      setTitle("");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Popover label="新建事项" className="ou-cal-add" trigger={
      <button type="button" className="ou-icon-button ou-cal-plus" aria-label="新建事项" title="新建事项"><Plus size={16} strokeWidth={2} /></button>
    }>
      <form className="flex flex-col gap-2" onSubmit={(e) => { e.preventDefault(); void add(); }}>
        <input className="ou-input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="加一件事，比如「字节二面」" aria-label="事项" autoFocus />
        <div className="flex gap-2">
          <Select size="sm" className="w-28 shrink-0" aria-label="类型" value={kind} onValueChange={(v) => setKind(v as EventKind)}
            options={Object.entries(EVENT_KIND).map(([value, label]) => ({ value, label }))} />
          <DatePicker withTime size="sm" className="min-w-0 flex-1" value={at} onChange={setAt} aria-label="时间" />
        </div>
        <Button type="submit" variant="primary" disabled={!title.trim() || busy}>{busy ? "正在加…" : "加到日历"}</Button>
      </form>
    </Popover>
  );
}

export function JobsCalendar({ events }: { events: Event[] }) {
  const now = useNow();
  const [start, setStart] = useState(() => weekStart(new Date()));
  const [over, setOver] = useState<string | null>(null);
  const grab = useRef<{ id: number; dy: number } | null>(null);
  const days = useMemo(() => weekDays(start), [start]);
  const today = ymd(now);
  const byDay = useMemo(() => {
    const map = new Map<string, Event[]>();
    for (const e of events) {
      if (!e.at) continue;
      const day = e.at.slice(0, 10);
      map.set(day, [...(map.get(day) ?? []), e]);
    }
    return map;
  }, [events]);

  const shift = (weeks: number) => setStart((s) => new Date(s.getFullYear(), s.getMonth(), s.getDate() + weeks * 7));
  const last = days[6];
  const label = start.getMonth() === last.getMonth()
    ? `${start.getFullYear()} 年 ${start.getMonth() + 1} 月`
    : `${start.getMonth() + 1} 月 – ${last.getMonth() + 1} 月`;
  const nowMinute = now.getHours() * 60 + now.getMinutes();
  const showNow = days.some((d) => ymd(d) === today) && nowMinute >= DAY_START * 60 && nowMinute < DAY_END * 60;
  const nextHour = `${today}T${pad(Math.min(now.getHours() + 1, 23))}:00`;

  const onDragStart = (e: DragEvent<HTMLElement>, p: Placed) => {
    const rect = e.currentTarget.getBoundingClientRect();
    grab.current = { id: p.event.id, dy: e.clientY - rect.top };
    e.dataTransfer.setData("text/plain", String(p.event.id));
    e.dataTransfer.effectAllowed = "move";
    liftDragImage(e);
  };
  const onDrop = (e: DragEvent<HTMLDivElement>, day: Date) => {
    e.preventDefault();
    setOver(null);
    const g = grab.current;
    grab.current = null;
    const event = events.find((x) => String(x.id) === e.dataTransfer.getData("text/plain"));
    if (!event || !g) return;
    const col = e.currentTarget.getBoundingClientRect();
    const minutesPerPx = ((DAY_END - DAY_START) * 60) / col.height;
    const at = dropAt(day, (e.clientY - col.top - g.dy) * minutesPerPx);
    if (at !== event.at) void write("save", { type: "event", id: event.id, data: { at } });
  };

  const allDay = days.map((d) => (byDay.get(ymd(d)) ?? []).filter((e) => e.at && minuteOf(e.at) == null));

  return (
    <section className="ou-cal ou-sheet" data-testid="jobs-calendar" aria-label="本周日历">
      <div className="ou-cal-toolbar">
        <button type="button" className="ou-button ou-button-secondary" onClick={() => setStart(weekStart(new Date()))}>今天</button>
        <div className="ou-button-group">
          <button type="button" className="ou-icon-button" aria-label="上一周" onClick={() => shift(-1)}><ChevronLeft size={16} strokeWidth={1.9} /></button>
          <button type="button" className="ou-icon-button" aria-label="下一周" onClick={() => shift(1)}><ChevronRight size={16} strokeWidth={1.9} /></button>
        </div>
        <h2 className="ou-cal-title">{label}<span className="ou-cal-week">第 {isoWeek(start)} 周</span></h2>
        <div className="ml-auto"><AddEventButton key={nextHour} defaultAt={nextHour} /></div>
      </div>

      <div className="ou-cal-scroll">
        <div className="ou-cal-grid" style={vars({ "--hours": DAY_END - DAY_START, "--vm": VISUAL_MINUTES })}>
          <div className="ou-cal-corner" />
          {days.map((d, i) => (
            <div key={ymd(d)} className="ou-cal-dayhead" data-today={ymd(d) === today || undefined} data-weekend={i >= 5 || undefined}>
              <span className="ou-cal-weekday">{WEEKDAYS[i]}</span>
              <span className="ou-cal-date">{d.getDate()}</span>
              {allDay[i].map((e) => <span key={e.id} className={`ou-tag ou-cal-allday`}><span className={`ou-tag-dot ou-tone-${eventTone(e)}`} />{e.title}</span>)}
            </div>
          ))}

          <div className="ou-cal-gutter" aria-hidden>
            {HOURS.map((h) => <span key={h} className="ou-cal-hour" style={vars({ "--t": (h - DAY_START) * 60 })}>{pad(h)}:00</span>)}
            {showNow && <span className="ou-cal-now-pill" style={vars({ "--t": nowMinute - DAY_START * 60 })}>{pad(now.getHours())}:{pad(now.getMinutes())}</span>}
          </div>
          {days.map((d, i) => {
            const key = ymd(d);
            const stacks = layoutDay(byDay.get(key) ?? []);
            return (
              <div key={key} className="ou-cal-col" data-today={key === today || undefined} data-weekend={i >= 5 || undefined} data-over={over === key || undefined}
                onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; if (over !== key) setOver(key); }}
                onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setOver((c) => (c === key ? null : c)); }}
                onDrop={(e) => onDrop(e, d)}>
                {HOURS.map((h) => <span key={h} className="ou-cal-line" style={vars({ "--t": (h - DAY_START) * 60 })} />)}
                {key === today && showNow && <span className="ou-cal-now" style={vars({ "--t": nowMinute - DAY_START * 60 })} />}
                {stacks.map((s) => <StackView key={s.key + ":" + s.items.length} s={s} onDragStart={onDragStart} />)}
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
