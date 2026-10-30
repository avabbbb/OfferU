import { describe, expect, it } from "vitest";

import { fitOnePage, PAGE_PX, resolveStyle, type ResumeStyle, withTemplate } from "@/lib/resumeStyle";

// 假的排版：行数 × 字号 × 行高 + 上下边距，单位 px。
const fake = (lines: number) => (s: ResumeStyle) => lines * s.bodySize * s.lineHeight * 1.333 + (s.margin.top + s.margin.bottom) * 3.78;

describe("resolveStyle", () => {
  it("旧 doc.template 和部分覆盖都能补全", () => {
    const legacy = resolveStyle(null, "photo");
    expect(legacy.template).toBe("clear");
    expect(legacy.photo).toBe(true);
    expect(resolveStyle({ template: "compact", margin: { top: 5 } }).margin).toEqual({ top: 5, right: 12, bottom: 10, left: 12 });
    expect(resolveStyle({ template: "fancy" as never }).template).toBe("clear");
  });
  it("换模板保留照片和校徽", () => {
    const s = withTemplate(resolveStyle({ photo: true, logo: "pku.png", bodySize: 12 }), "kami");
    expect(s).toMatchObject({ template: "kami", photo: true, logo: "pku.png", bodySize: 9.2, font: "serif" });
  });
});

describe("fitOnePage", () => {
  const base = resolveStyle({ template: "clear" });
  it("超一页时压到放得下，但不低于下限", async () => {
    const { style, outcome } = await fitOnePage(base, fake(65));
    expect(outcome).toBe("shrunk");
    expect(fake(65)(style)).toBeLessThanOrEqual(PAGE_PX);
    expect(style.bodySize).toBeGreaterThanOrEqual(8.5);
    expect(style.bodySize).toBeLessThan(base.bodySize);
  });
  it("下限也放不下就不动，交给用户删减", async () => {
    expect(await fitOnePage(base, fake(100))).toEqual({ style: base, outcome: "overflow" });
  });
  it("太空时放大，最多到 94%", async () => {
    const { style, outcome } = await fitOnePage(base, fake(40));
    expect(outcome).toBe("grown");
    expect(fake(40)(style)).toBeLessThanOrEqual(PAGE_PX * 0.94);
    expect(style.margin).toEqual(base.margin);
  });
  it("已经刚好一页就不动", async () => {
    expect((await fitOnePage(base, () => PAGE_PX * 0.95)).outcome).toBe("fits");
  });
});
