import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { AgentMarkdown } from "./AgentMarkdown";

const html = (text: string) => renderToStaticMarkup(<AgentMarkdown text={text} />);
const STAR = String.fromCharCode(42);
const bold = (text: string) => STAR + STAR + text + STAR + STAR;
const link = (label: string, href: string) => String.fromCharCode(91) + label + String.fromCharCode(93) + String.fromCharCode(40) + href + String.fromCharCode(41);

describe("AgentMarkdown", () => {
  it("renders headings, nested lists, bold and tables as rich text", () => {
    const out = html(
      "## 当前求职进度\n\n1. 目标公司A\n   - 状态：" + bold("面试中") + "\n\n| 表 | 条数 |\n|---|---|\n| 总表 | 2 |"
    );
    expect(out).toContain("<h2>当前求职进度</h2>");
    expect(out).toContain("<ol>");
    expect(out).toContain("<ul>");
    expect(out).toContain("<strong>面试中</strong>");
    expect(out).toContain("<table>");
    expect(out).not.toContain("##");
  });

  it("escapes raw HTML and drops javascript: links from model output", () => {
    const out = html('<img src=x onerror="alert(1)"> ' + link("点我", "javascript:alert(1)"));
    expect(out).not.toContain("<img");
    expect(out).not.toContain("javascript:");
  });

  it("opens links in a new tab", () => {
    expect(html(link("岗位", "/jobs/1"))).toContain('target="_blank"');
  });
});
