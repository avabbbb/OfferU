import { describe, expect, it } from "vitest";
import { TONES, toneOf } from "./Pill";
import { contextUsage } from "./agent/ContextUsageRing";
import { formatDateValue, monthGrid, parseDateValue } from "./DatePicker";

describe("toneOf", () => {
  it("is stable for the same text and always a known tone", () => {
    for (const t of ["字节跳动", "远程", "Python", "", "🚀"]) {
      expect(toneOf(t)).toBe(toneOf(t));
      expect(TONES).toContain(toneOf(t));
    }
  });
});

describe("contextUsage", () => {
  it("classifies ok / near / full", () => {
    expect(contextUsage(10, 100).tone).toBe("ok");
    expect(contextUsage(85, 100).tone).toBe("near");
    expect(contextUsage(120, 100).tone).toBe("full");
  });
  it("survives a zero limit", () => {
    expect(() => contextUsage(5, 0)).not.toThrow();
  });
});

describe("DatePicker helpers", () => {
  it("parses date and datetime values like the native inputs", () => {
    expect(parseDateValue("2026-11-16T14:00").time).toBe("14:00");
    expect(parseDateValue("2026-11-16").date?.getDate()).toBe(16);
    expect(parseDateValue("").date).toBeNull();
    expect(parseDateValue("明天").date).toBeNull();
  });
  it("lays a month out as 6 Monday-first weeks", () => {
    const days = monthGrid(2026, 10); // 2026 年 11 月，1 号是周日
    expect(days).toHaveLength(42);
    expect(days[0].getDay()).toBe(1);
    expect(days[6].getDate()).toBe(1);
  });
  it("formats with weekday and drops the current year", () => {
    expect(formatDateValue("2026-11-16T14:00", new Date(2026, 0, 1))).toBe("11月16日 周一 14:00");
    expect(formatDateValue("2027-01-04", new Date(2026, 0, 1))).toBe("2027年1月4日 周一");
  });
});
