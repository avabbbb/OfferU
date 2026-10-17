import { describe, expect, it } from "vitest";
import { applyFormat, hasMark, parseRuns, serializeRuns } from "./richFormat";

const fmt = (html: string, start: number, end: number, op: Parameters<typeof applyFormat>[3]) => serializeRuns(applyFormat(parseRuns(html), start, end, op));

describe("richFormat", () => {
  it("给一段文字加粗、再取消", () => {
    const bold = fmt("降到 40 秒", 3, 7, { mark: "strong", on: true });
    expect(bold).toBe("降到 <strong>40 秒</strong>");
    expect(hasMark(parseRuns(bold), 3, 7, "strong")).toBe(true);
    expect(fmt(bold, 3, 5, { mark: "strong", on: false })).toBe("降到 40<strong> 秒</strong>");
  });

  it("跨越已有格式时只改选中的字，并合并相同格式", () => {
    const html = "<em>延迟</em>从 15 分钟";
    expect(fmt(html, 1, 4, { mark: "u", on: true })).toBe("<em>延</em><em><u>迟</u></em><u>从 </u>15 分钟");
    expect(fmt("<strong>ab</strong>cd", 2, 4, { mark: "strong", on: true })).toBe("<strong>abcd</strong>");
  });

  it("颜色、链接可以加也可以去掉", () => {
    const colored = fmt("40 秒", 0, 2, { color: "#2463eb" });
    expect(colored).toContain("color");
    expect(fmt(colored, 0, 4, { color: null })).toBe("40 秒");
    const linked = fmt("看 demo", 2, 6, { href: "https://github.com/x" });
    expect(linked).toBe('看 <a href="https://github.com/x">demo</a>');
    expect(fmt(linked, 2, 6, { href: null })).toBe("看 demo");
  });

  it("文字里的尖括号不会变成标签", () => {
    expect(fmt("a &lt;script&gt; b", 0, 1, { mark: "em", on: true })).toBe("<em>a</em> &lt;script&gt; b");
  });
});
