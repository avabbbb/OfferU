import type { Event, EventKind } from "@/lib/core";

// 周日历的纯逻辑：一周的日期、事项落在哪一天哪个时刻、哪些事项挤在一起要叠成一摞。组件只管画。
// 事项只有开始时间（at），没有结束时间：按 VISUAL_MINUTES 画高度，同一天里画出来会重叠的叠成一摞（参考 Inspora「Event Swatch」）。

export const DAY_START = 8;   // 8:00 起
export const DAY_END = 24;    // 到 24:00
export const VISUAL_MINUTES = 110; // 一张卡画多高（分钟），够放图标 + 时间 + 两行标题
export const WEEKDAYS = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];

export const pad = (n: number) => String(n).padStart(2, "0");
export const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** 本地日历里 d 所在那一周的周一。 */
export function weekStart(d: Date): Date {
  const out = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  out.setDate(out.getDate() - ((out.getDay() + 6) % 7));
  return out;
}

export function weekDays(start: Date): Date[] {
  return Array.from({ length: 7 }, (_, i) => new Date(start.getFullYear(), start.getMonth(), start.getDate() + i));
}

/** ISO 周数。 */
export function isoWeek(d: Date): number {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7));
  const y0 = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return Math.ceil(((t.getTime() - y0.getTime()) / 86400000 + 1) / 7);
}

/** "2026-11-13T14:30" → 当天的分钟数；只有日期返回 null（算全天）。 */
export function minuteOf(at: string): number | null {
  const time = at.split("T")[1];
  if (!time) return null;
  const [h, m] = time.split(":").map(Number);
  return h * 60 + (m || 0);
}

export type Placed = { event: Event; start: number; top: number; height: number };
export type Stack = { key: string; top: number; height: number; items: Placed[] };

/** 一天里带时刻的事项 → 一摞一摞（画出来互相压住的放一摞），按时间排。 */
export function layoutDay(events: Event[]): Stack[] {
  const lo = DAY_START * 60;
  const hi = DAY_END * 60;
  const placed: Placed[] = events
    .flatMap((event) => {
      const start = event.at ? minuteOf(event.at) : null;
      if (start == null) return [];
      // 太晚的（比如 23:59 截止）往上挪，保证整张卡在格子里；太早的贴在顶上。
      const top = Math.min(Math.max(start, lo), hi - VISUAL_MINUTES) - lo;
      return [{ event, start, top, height: VISUAL_MINUTES }];
    })
    .sort((a, b) => a.top - b.top || a.event.id - b.event.id);
  const stacks: Stack[] = [];
  for (const p of placed) {
    const last = stacks[stacks.length - 1];
    if (last && p.top < last.top + last.height) {
      last.items.push(p);
      last.height = Math.max(last.height, p.top + p.height - last.top);
    } else {
      stacks.push({ key: "s" + p.event.id, top: p.top, height: p.height, items: [p] });
    }
  }
  return stacks;
}

/** 事项类型 → 色相：截止红、笔试黄、面试橙、待办蓝；做完的一律灰。 */
export const KIND_TONE: Record<EventKind, "blue" | "red" | "yellow" | "orange"> = {
  todo: "blue", deadline: "red", test: "yellow", interview: "orange",
};
export function eventTone(event: Event) {
  return event.done ? "gray" : KIND_TONE[event.kind ?? "todo"] ?? "blue";
}

/** 拖到某天某个位置：吸附到 15 分钟。 */
export function dropAt(day: Date, offsetMinutes: number): string {
  const m = Math.round(Math.min(Math.max(offsetMinutes, 0), (DAY_END - DAY_START) * 60 - 15) / 15) * 15 + DAY_START * 60;
  return `${ymd(day)}T${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
}
