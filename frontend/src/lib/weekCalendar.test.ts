import { describe, expect, it } from "vitest";

import type { Event } from "@/lib/core";
import { DAY_START, VISUAL_MINUTES, dropAt, isoWeek, layoutDay, weekStart, ymd } from "./weekCalendar";

const ev = (id: number, at: string): Event => ({ id, type: "event", job_id: null, created_at: "", updated_at: "", title: "e" + id, at });

describe("weekCalendar", () => {
  it("周一开始，周日算上一周", () => {
    expect(ymd(weekStart(new Date(2026, 10, 13)))).toBe("2026-11-09");
    expect(ymd(weekStart(new Date(2026, 10, 15)))).toBe("2026-11-09");
    expect(isoWeek(new Date(2026, 10, 13))).toBe(46);
  });

  it("画出来互相压住的事项叠成一摞，分开的各自一摞；只有日期的不进时间轴", () => {
    const stacks = layoutDay([ev(1, "2026-11-13T14:00"), ev(2, "2026-11-13T14:30"), ev(3, "2026-11-13T15:00"), ev(4, "2026-11-13T20:00"), ev(5, "2026-11-13")]);
    expect(stacks.map((s) => s.items.map((p) => p.event.id))).toEqual([[1, 2, 3], [4]]);
    expect(stacks[0].top).toBe((14 - DAY_START) * 60);
  });

  it("太晚的截止往上挪，整张卡留在格子里", () => {
    const [s] = layoutDay([ev(1, "2026-11-13T23:59")]);
    expect(s.top + VISUAL_MINUTES).toBe((24 - DAY_START) * 60);
  });

  it("拖放吸附到 15 分钟并夹在当天范围内", () => {
    expect(dropAt(new Date(2026, 10, 12), 67)).toBe("2026-11-12T09:00");
    expect(dropAt(new Date(2026, 10, 12), 68)).toBe("2026-11-12T09:15");
    expect(dropAt(new Date(2026, 10, 12), -40)).toBe("2026-11-12T08:00");
  });
});
