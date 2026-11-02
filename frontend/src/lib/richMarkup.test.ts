import { describe, expect, it } from "vitest";
import { domToMarkup, inlineHtml, markupToHtml, type NodeLike, parseLine, plainText } from "./richMarkup";
import cases from "./richMarkup.cases.json";

const t = (s: string): NodeLike => ({ nodeType: 3, nodeName: "#text", nodeValue: s, childNodes: [] });
const h = (tag: string, props: { style?: NodeLike["style"]; href?: string } | null, ...kids: (NodeLike | string)[]): NodeLike => ({
  nodeType: 1, nodeName: tag.toUpperCase(), nodeValue: null, style: props?.style ?? {},
  getAttribute: (k) => (k === "href" ? props?.href ?? null : null),
  childNodes: kids.map((k) => (typeof k === "string" ? t(k) : k)),
});

describe("正文标记", () => {
  it("标记转成编辑框 HTML：对齐、缩进、列表、行内格式", () => {
    expect(markupToHtml("{center} **甲**\n  - 乙\n- [丙](https://x.dev)")).toBe(
      '<div style="text-align: center"><strong>甲</strong></div>'
      + '<ul><li style="margin-left: 2em">乙</li><li><a href="https://x.dev">丙</a></li></ul>',
    );
    expect(markupToHtml("")).toBe("");
    expect(markupToHtml("a\n\nb")).toBe("<div>a</div><div><br></div><div>b</div>");
  });

  it("浏览器编辑出来的 DOM 读回标记", () => {
    const root = h("div", null,
      "首行",
      h("div", { style: { textAlign: "center" } }, h("b", null, "居中")),
      h("div", null, h("br", null)),
      h("ul", null, h("li", null, "甲", h("i", null, " 斜体 ")), h("ul", null, h("li", null, "子"))),
      h("ol", null, h("li", null, "一"), h("li", null, "二")),
      h("blockquote", null, h("div", null, "缩进")),
      h("div", null, "看", h("a", { href: "https://x.dev" }, "主页"), h("a", { href: "javascript:alert(1)" }, "坏链")),
    );
    expect(domToMarkup(root)).toBe("首行\n{center} **居中**\n\n- 甲 *斜体* \n  - 子\n1. 一\n2. 二\n  缩进\n看[主页](https://x.dev)坏链");
  });

  it("要点只留行内标记、拼成一行；嵌套加粗不重复", () => {
    expect(domToMarkup(h("div", null, "甲", h("strong", null, "乙"), h("div", null, "丙")), true)).toBe("甲**乙** 丙");
    expect(domToMarkup(h("div", null, h("b", null, h("strong", null, "x"))))).toBe("**x**");
  });

  it("往返不丢格式", () => {
    const md = "{right} 落款\n  1. **一**\n  2. *二*";
    expect(markupToHtml(md)).toBe('<div style="text-align: right">落款</div><ol><li style="margin-left: 2em"><strong>一</strong></li><li style="margin-left: 2em"><em>二</em></li></ol>');
  });

  it("摘要去掉标记", () => {
    expect(plainText("{center} **甲** *乙* [丙](https://x.dev)\n- 丁")).toBe("甲 乙 丙\n丁");
  });
});

// 和 backend/tests/test_rich_markup_cases.py 跑同一份用例。
describe("前后端共用用例", () => {
  it.each(cases.inline)("行内 %#", (c) => expect(inlineHtml(c.in)).toBe(c.html));
  it.each(cases.lines)("拆行 %#", (c) => expect(parseLine(c.raw)).toEqual(c.line));
});
