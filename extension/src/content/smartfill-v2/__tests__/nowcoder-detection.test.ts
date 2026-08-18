import { describe, it, expect } from "vitest";
import { atsRegistry } from "../ats/registry.js";
import "../ats/adapters/self-built.adapter.js";

// 验证 self-built 通用适配器能识别牛客网申页面（clean-room：仅站点识别，
// 不复制牛客代码；填表由 OfferU 通用控件驱动 + 职业事实计划执行）。
describe("nowcoder site detection via self-built adapter", () => {
  it("registers self-built adapter", () => {
    const adapter = atsRegistry.get("self-built");
    expect(adapter).toBeDefined();
  });

  it("self-built url-pattern matches nowcoder.com pages", () => {
    const adapter = atsRegistry.get("self-built");
    const signals = adapter!.getDetectionSignals().filter((s) => s.type === "url-pattern");
    const nowcoderPattern = signals.find((s) => s.value.includes("nowcoder"));
    expect(nowcoderPattern).toBeDefined();
    expect(new RegExp(nowcoderPattern!.value).test("https://www.nowcoder.com/apply/123")).toBe(true);
    expect(new RegExp(nowcoderPattern!.value).test("https://d.nowcoder.com/job/apply?jobId=1")).toBe(true);
  });

  it("self-built covers antd + element controls used by nowcoder forms", () => {
    const adapter = atsRegistry.get("self-built");
    const overrides = adapter!.getSelectorOverrides();
    const custom = overrides.pageStructure?.customControlSelectors ?? [];
    expect(custom.join(" ")).toContain(".ant-select");
    expect(custom.join(" ")).toContain(".el-select");
    const dropdown = overrides.optionSelectorConfig?.dropdownSelector ?? "";
    expect(dropdown).toContain(".ant-select-dropdown");
    expect(dropdown).toContain(".el-select-dropdown");
  });

  it("self-built intent aliases cover core resume fields", () => {
    const adapter = atsRegistry.get("self-built");
    const aliases = adapter!.getIntentAliases();
    expect(aliases["姓名"]).toBe("full_name");
    expect(aliases["学校"]).toBe("school_name");
    expect(aliases["专业"]).toBe("major");
    expect(aliases["期望薪资"]).toBe("expected_salary");
  });
});
