import { describe, expect, it } from "vitest";
import { PRIMARY_NAV, activePrimary, activeTab } from "./navModel";

describe("primary navigation", () => {
  it("has exactly six entries", () => {
    expect(PRIMARY_NAV.map((item) => item.label)).toEqual(["今天", "岗位", "投递", "简历", "面试", "设置"]);
  });

  it.each([
    ["/", "今天"],
    ["/applications", "投递"],
    ["/email", "投递"],
    ["/calendar", "投递"],
    ["/jobs", "岗位"],
    ["/jobs/42", "岗位"],
    ["/optimize", "简历"],
    ["/profile", "简历"],
    ["/resume", "简历"],
    ["/resume/7", "简历"],
    ["/interview", "面试"],
    ["/interview/ai", "面试"],
    ["/interview/review", "面试"],
    ["/settings", "设置"],
  ])("every former entry stays reachable: %s → %s", (path, label) => {
    expect(activePrimary(path)?.label).toBe(label);
  });

  it("review is its own tab, not 准备", () => {
    const interview = PRIMARY_NAV.find((item) => item.label === "面试")!;
    expect(activeTab(interview, "/interview/review")?.label).toBe("复盘");
    expect(activeTab(interview, "/interview")?.label).toBe("准备");
    expect(activeTab(interview, "/interview/ai")?.label).toBe("准备");
  });
});
