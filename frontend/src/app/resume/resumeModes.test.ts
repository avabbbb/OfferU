import { describe, expect, it } from "vitest";
import { parseResumeMode, resumeModeHref, tailorResumeHref } from "./resumeModes";

describe("简历模式地址", () => {
  it("未知模式回落到「我的简历」", () => {
    expect(parseResumeMode(null)).toBe("list");
    expect(parseResumeMode("studio")).toBe("list");
    expect(parseResumeMode("tailor")).toBe("tailor");
  });

  it("旧 /optimize 的 job_ids 在岗位定制里保留，切到其它模式时丢弃", () => {
    expect(resumeModeHref("tailor", "?job_ids=3,4")).toBe("/resume?job_ids=3%2C4&mode=tailor");
    expect(resumeModeHref("layout", "?job_ids=3")).toBe("/resume?mode=layout");
    expect(resumeModeHref("list", "?mode=layout")).toBe("/resume");
  });

  it("岗位定制直达地址", () => {
    expect(tailorResumeHref()).toBe("/resume?mode=tailor");
    expect(tailorResumeHref([9, 12])).toBe("/resume?mode=tailor&job_ids=9,12");
  });
});
