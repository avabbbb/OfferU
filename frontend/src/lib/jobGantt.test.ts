import { describe, expect, it } from "vitest";

import type { Event, Job } from "@/lib/core";
import { barLabel, barOf, fromDay, rangeOf, ticks, toDay } from "@/lib/jobGantt";

const job = (over: Partial<Job> = {}): Job => ({
  id: 1, type: "job", job_id: null, created_at: "2026-11-01T09:00:00", updated_at: "", status: "saved", ...over,
});
const ev = (id: number, at: string, over: Partial<Event> = {}): Event => ({
  id, type: "event", job_id: 1, created_at: "", updated_at: "", title: "事项" + id, kind: "interview", at, ...over,
});
const d = (s: string) => toDay(s) as number;
const NOW = d("2026-11-06");

describe("toDay / fromDay", () => {
  it("按日历日换算，忽略时刻", () => {
    expect(fromDay(d("2026-11-06T23:59:00"))).toBe("2026-11-06");
    expect(d("2026-11-07") - d("2026-11-06")).toBe(1);
    expect(toDay("")).toBeNull();
    expect(toDay("坏日期")).toBeNull();
  });
});

describe("barOf", () => {
  it("没投递、没事项：收藏日画到今天", () => {
    const b = barOf(job(), [], NOW);
    expect([fromDay(b.start), fromDay(b.end)]).toEqual(["2026-11-01", "2026-11-06"]);
    expect(barLabel(b, NOW)).toBe("收藏 5 天");
  });

  it("将来的面试把条拉到面试那天；只取本岗位、有日期的事项，按时间排", () => {
    const events = [ev(3, "2026-11-12T14:00:00"), ev(2, "2026-11-04", { kind: "test" }), ev(4, "2026-11-20", { job_id: 9 }), ev(5, "")];
    const b = barOf(job({ status: "interview", applied_at: "2026-11-02" }), events, NOW);
    expect(fromDay(b.end)).toBe("2026-11-12");
    expect(b.milestones.map((m) => m.id)).toEqual([2, 3]);
    expect(barLabel(b, NOW)).toBe("投递后 4 天");
  });

  it("早于收藏日的投递日把起点往前拉", () => {
    const b = barOf(job({ applied_at: "2026-10-28" }), [], NOW);
    expect(fromDay(b.start)).toBe("2026-10-28");
  });

  it("已结束的不再画到今天，停在最后一件事项", () => {
    const b = barOf(job({ status: "rejected", applied_at: "2026-11-02" }), [ev(2, "2026-11-03")], NOW);
    expect(fromDay(b.end)).toBe("2026-11-03");
    expect(b.ended).toBe(true);
    expect(barLabel(b, NOW)).toBe("投递后 1 天");
  });

  it("没有 created_at 也不出错：用投递日或今天", () => {
    expect(fromDay(barOf(job({ created_at: "" }), [], NOW).start)).toBe("2026-11-06");
  });
});

describe("rangeOf / ticks", () => {
  it("范围包住所有条和今天，左留 3 天右留 7 天", () => {
    const r = rangeOf([barOf(job(), [ev(2, "2026-11-20")], NOW)], NOW);
    expect([fromDay(r.from), fromDay(r.to)]).toEqual(["2026-10-29", "2026-11-27"]);
  });

  it("没有条时以今天为中心", () => {
    const r = rangeOf([], NOW);
    expect(r.to - r.from).toBe(14);
  });

  it("minDays 不够时往右补，够了不动", () => {
    const bars = [barOf(job(), [], NOW)];
    const r = rangeOf(bars, NOW, 60);
    expect(r.to - r.from + 1).toBe(60);
    expect(rangeOf(bars, NOW, 3)).toEqual(rangeOf(bars, NOW));
  });

  it("每天一个刻度，标出周末和月初；范围首日离月底不到 10 天不写月份，免得和下月 1 号重叠", () => {
    const t = ticks(d("2026-10-30"), d("2026-11-02"));
    expect(t.map((x) => x.dom)).toEqual([30, 31, 1, 2]);
    expect(t.map((x) => x.monthStart)).toEqual([false, false, true, false]);
    expect(ticks(d("2026-10-22"), d("2026-10-23"))[0].monthStart).toBe(true);
    expect(ticks(d("2026-10-23"), d("2026-10-24"))[0].monthStart).toBe(false);
    expect(t.find((x) => x.date === "2026-11-01")?.weekend).toBe(true);
    expect(t.find((x) => x.date === "2026-11-02")?.weekend).toBe(false);
  });
});
