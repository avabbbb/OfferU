// Cases adapted from avabbbb/Flovart@28c79bf:tests/agentQuote.test.ts (MIT).
import { describe, expect, it } from "vitest";
import { quotePreview, quoteForSend, splitQuote, truncateText, withQuote } from "./agentQuote";

describe("agentQuote", () => {
  it("truncates by code point and keeps emoji whole", () => {
    expect(truncateText("abc", 5)).toBe("abc");
    expect(truncateText("😀😀😀😀", 3)).toBe("😀😀…");
  });

  it("previews on one line and keeps newlines for sending", () => {
    expect(quotePreview("第一行\n\n\n第二行")).toBe("第一行 第二行");
    expect(quoteForSend("a\r\n\n\n\nb")).toBe("a\n\nb");
  });

  it("prefixes the quote as a markdown block and splits it back", () => {
    const text = withQuote("正文", "第一行\n\n第二行");
    expect(text).toBe("> 第一行\n>\n> 第二行\n\n正文");
    expect(splitQuote(text)).toEqual({ quote: "第一行\n\n第二行", body: "正文" });
    expect(withQuote("正文", "")).toBe("正文");
    expect(withQuote("", "只有引用")).toBe("> 只有引用");
  });

  it("leaves messages without a leading quote alone", () => {
    expect(splitQuote("普通 > 消息")).toEqual({ body: "普通 > 消息" });
    expect(splitQuote(">")).toEqual({ body: ">" });
  });
});
