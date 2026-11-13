import { describe, expect, it } from "vitest";
import { TONES, toneOf } from "./Pill";
import { contextUsage } from "./agent/ContextUsageRing";

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
