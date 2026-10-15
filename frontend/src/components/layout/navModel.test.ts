import { describe, expect, it } from "vitest";
import { PRIMARY_NAV, SETTINGS_HREF, activePrimary } from "./navModel";

describe("primary navigation", () => {
  it("has exactly five entries and settings is not one of them", () => {
    expect(PRIMARY_NAV.map((item) => item.label)).toEqual(["今天", "投递", "岗位", "简历", "档案"]);
    expect(PRIMARY_NAV.some((item) => item.href === SETTINGS_HREF)).toBe(false);
  });

  it.each([
    ["/", "今天"],
    ["/applications", "投递"],
    ["/email", "投递"],
    ["/calendar", "投递"],
    ["/jobs", "岗位"],
    ["/jobs/42", "岗位"],
    ["/optimize", "简历"],
    ["/interview", "岗位"],
    ["/interview/ai", "岗位"],
    ["/profile", "档案"],
    ["/resume", "简历"],
    ["/resume/7", "简历"],
    ["/studio", "简历"],
  ])("every former entry stays reachable: %s → %s", (path, label) => {
    expect(activePrimary(path)?.label).toBe(label);
  });

  it("support pages do not highlight a primary entry", () => {
    expect(activePrimary("/settings")).toBeNull();
  });
});
