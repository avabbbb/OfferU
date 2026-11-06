import type { Event, EventKind, Job } from "@/lib/core";

// 甘特视图的时间计算：岗位的条从收藏日画到最后一件事项（进行中的画到今天），事项是条上的节点。
// 日期一律按日历日算（YYYY-MM-DD → 自 1970-01-01 起的天数），不受时区影响。纯函数，组件只管画。

export type Scale = "week" | "month";
export const SCALE_NAME: Record<Scale, string> = { week: "周", month: "月" };
// 每天占多少像素。
export const DAY_PX: Record<Scale, number> = { week: 32, month: 10 };

const MS_DAY = 86_400_000;
const ENDED: Record<string, true> = { offer: true, rejected: true, closed: true };

// "2026-11-06" 或 "2026-11-06T10:00:00" → 天序号；格式不对返回 null。
export function toDay(at?: string | null): number | null {
  const m = at ? /^(\d{4})-(\d{2})-(\d{2})/.exec(at) : null;
  return m ? Math.floor(Date.UTC(+m[1], +m[2] - 1, +m[3]) / MS_DAY) : null;
}

export function fromDay(day: number): string {
  return new Date(Date.UTC(1970, 0, 1 + day)).toISOString().slice(0, 10);
}

// 本地日历的今天。
export function today(now = new Date()): number {
  return Math.floor(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) / MS_DAY);
}

export type Milestone = { id: number; day: number; kind: EventKind; title: string; done: boolean };
export type Bar = { start: number; end: number; applied: number | null; milestones: Milestone[]; ended: boolean };

// 一个岗位的条：
// 起点：收藏日（created_at），没有就用投递日，再没有就用今天；早于起点的投递日 / 事项会把起点往前拉。
// 终点：已结束（offer / 未通过 / 不投了）画到最后一件事项或投递日；进行中的画到今天，有将来的事项就画到那件事项。
export function barOf(job: Job, events: Event[], now: number): Bar {
  const milestones = events
    .filter((e) => e.job_id === job.id && toDay(e.at) != null)
    .map((e) => ({ id: e.id, day: toDay(e.at) as number, kind: e.kind ?? "todo", title: e.title, done: !!e.done }))
    .sort((a, b) => a.day - b.day || a.id - b.id);
  const applied = toDay(job.applied_at);
  const days = [applied, ...milestones.map((m) => m.day)].filter((d): d is number => d != null);
  const created = toDay(job.created_at) ?? applied ?? now;
  const start = Math.min(created, ...days);
  const ended = ENDED[job.status] === true;
  const end = Math.max(start, ...days, ended ? start : now);
  return { start, end, applied, milestones, ended };
}

// 时间轴范围：所有条和今天都放得下，左边留 3 天、右边留 7 天；没有条就以今天为中心看两周。
// minDays：至少这么多天（组件按可视宽度算，让网格铺满），不够就往右补。
export function rangeOf(bars: Bar[], now: number, minDays = 0): { from: number; to: number } {
  const from = bars.length ? Math.min(now, ...bars.map((b) => b.start)) - 3 : now - 7;
  const to = bars.length ? Math.max(now, ...bars.map((b) => b.end)) + 7 : now + 7;
  return { from, to: Math.max(to, from + minDays - 1) };
}

export type Tick = { day: number; date: string; dom: number; weekend: boolean; monthStart: boolean };

// from..to 每天一个刻度。monthStart：每月 1 号；范围第一天离月底还有 10 天以上也算（轴头好写月份，又不和下月 1 号的月份挤在一起）。
export function ticks(from: number, to: number): Tick[] {
  const out: Tick[] = [];
  for (let day = from; day <= to; day++) {
    const date = fromDay(day);
    const dom = Number(date.slice(8, 10));
    const dow = new Date(Date.UTC(1970, 0, 1 + day)).getUTCDay();
    // 当月天数 = 下个月的第 0 天。
    const roomy = day === from && new Date(Date.UTC(+date.slice(0, 4), +date.slice(5, 7), 0)).getUTCDate() - dom >= 9;
    out.push({ day, date, dom, weekend: dow === 0 || dow === 6, monthStart: dom === 1 || roomy });
  }
  return out;
}

// 条上的字：投递了写「投递后 N 天」（到今天或结束为止），没投写「收藏 N 天」。
export function barLabel(bar: Bar, now: number): string {
  const until = bar.ended ? bar.end : Math.min(now, bar.end);
  if (bar.applied != null) return "投递后 " + Math.max(0, until - bar.applied) + " 天";
  return "收藏 " + Math.max(0, until - bar.start) + " 天";
}

// 甘特里拖菱形：拖了 dx 像素 -> 挪几天（四舍五入到整天，不返回 -0）。
export function dragDays(dx: number, px: number): number {
  return Math.round(dx / px) || 0;
}

// 事项时间挪 days 天，保留时刻部分（"2026-11-06T14:00:00" -> "2026-11-08T14:00:00"）；格式不对原样返回。
export function shiftAt(at: string, days: number): string {
  const day = toDay(at);
  return day == null ? at : fromDay(day + days) + at.slice(10);
}
