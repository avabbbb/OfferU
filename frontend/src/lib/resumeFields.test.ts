import { describe, expect, it } from "vitest";

import { fromMonthInput, joinDate, joinDegree, splitDate, splitDegree, toMonthInput } from "@/lib/resumeFields";

describe("时间：item.date ↔ 开始 / 结束", () => {
  it("常见写法都拆得开，规范成 2021.09", () => {
    expect(splitDate("2021.09 – 2024.06")).toEqual({ start: "2021.09", end: "2024.06" });
    expect(splitDate("2021-9 - 2024-6")).toEqual({ start: "2021.09", end: "2024.06" });
    expect(splitDate("2021年9月至2024年6月")).toEqual({ start: "2021.09", end: "2024.06" });
    expect(splitDate("2023.11 ~ 至今")).toEqual({ start: "2023.11", end: "" });
    expect(splitDate("2021.09-2022.01")).toEqual({ start: "2021.09", end: "2022.01" });
    expect(splitDate("")).toEqual({ start: "", end: "" });
  });
  it("认不出的旧写法原样留在开始时间里，不丢字", () => {
    expect(splitDate("大二暑假")).toEqual({ start: "大二暑假", end: "" });
    expect(splitDate("2024")).toEqual({ start: "2024", end: "" });
  });
  it("结束不填即至今；往返不变", () => {
    expect(joinDate("2021.09", "")).toBe("2021.09 – 至今");
    expect(joinDate("2021-09", "2024-06")).toBe("2021.09 – 2024.06");
    expect(joinDate("", "")).toBe("");
    expect(joinDate("", "2024.06")).toBe("2024.06");
    for (const d of ["2021.09 – 2024.06", "2021.09 – 至今"]) {
      const { start, end } = splitDate(d);
      expect(joinDate(start, end)).toBe(d);
    }
  });
  it("月份选择框的值互转", () => {
    expect(toMonthInput("2021.09")).toBe("2021-09");
    expect(toMonthInput("大二")).toBe("");
    expect(fromMonthInput("2021-09")).toBe("2021.09");
  });
});

describe("学历：subtitle「专业 · 学历」", () => {
  it("最后一段是学历才拆", () => {
    expect(splitDegree("公共卫生 · 硕士")).toEqual({ major: "公共卫生", degree: "硕士" });
    expect(splitDegree("计算机 | 本科")).toEqual({ major: "计算机", degree: "本科" });
    expect(splitDegree("计算机科学与技术")).toEqual({ major: "计算机科学与技术", degree: "" });
    expect(joinDegree("公共卫生", "硕士")).toBe("公共卫生 · 硕士");
    expect(joinDegree("", "本科")).toBe("本科");
  });
});
