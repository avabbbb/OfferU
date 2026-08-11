// =============================================
// normalizer 与 path-glob 测试
// =============================================

import { describe, expect, it } from "vitest";
import { applyNormalizers, NORMALIZERS, normalizeToken } from "./normalizers.js";
import { compilePathGlob } from "./path-glob.js";

describe("normalizers", () => {
  it("trims and collapses whitespace", () => {
    expect(NORMALIZERS.trim("  hello  ")).toBe("hello");
    expect(NORMALIZERS["collapse-space"]("a\n\t b   c")).toBe("a b c");
  });

  it("resolves absolute urls against base without following", () => {
    expect(NORMALIZERS["absolute-url"]("/jobs/1", "https://jobs.acme.invalid")).toBe("https://jobs.acme.invalid/jobs/1");
    expect(NORMALIZERS["absolute-url"]("https://x.invalid/a", "https://y.invalid")).toBe("https://x.invalid/a");
  });

  it("strips label prefixes", () => {
    expect(NORMALIZERS["strip-label-prefix"]("职位：前端工程师")).toBe("前端工程师");
    expect(NORMALIZERS["strip-label-prefix"]("Job Title: Engineer")).toBe("Engineer");
  });

  it("normalizes unambiguous iso dates and keeps ambiguous text", () => {
    expect(NORMALIZERS["iso-date-if-unambiguous"]("2026/8/10")).toBe("2026-08-10");
    expect(NORMALIZERS["iso-date-if-unambiguous"]("2026-08-10")).toBe("2026-08-10");
    expect(NORMALIZERS["iso-date-if-unambiguous"]("8月10日")).toBe("8月10日");
    expect(NORMALIZERS["iso-date-if-unambiguous"]("2026-13-40")).toBe("2026-13-40");
  });

  it("applies a chain in order", () => {
    expect(applyNormalizers("  职位：  Senior   Engineer  ", ["strip-label-prefix", "collapse-space"])).toBe(
      "Senior Engineer",
    );
  });

  it("normalizes tokens for literal matching", () => {
    expect(normalizeToken("  Senior   Engineer！ ")).toBe("senior engineer");
  });
});

describe("path-glob", () => {
  it("matches single-segment star", () => {
    const re = compilePathGlob("/jobs/*");
    expect(re.test("/jobs/1")).toBe(true);
    expect(re.test("/jobs/abc-123")).toBe(true);
    expect(re.test("/jobs/1/sub")).toBe(false);
    expect(re.test("/jobs")).toBe(false);
    expect(re.test("/other/1")).toBe(false);
  });

  it("matches multi-segment double star", () => {
    const re = compilePathGlob("/applications/**");
    expect(re.test("/applications/1")).toBe(true);
    expect(re.test("/applications/1/status")).toBe(true);
    expect(re.test("/other/1")).toBe(false);
  });

  it("treats dots literally", () => {
    expect(compilePathGlob("/jobs/1.x").test("/jobs/1ax")).toBe(false);
    expect(compilePathGlob("/jobs/1.x").test("/jobs/1.x")).toBe(true);
  });
});
