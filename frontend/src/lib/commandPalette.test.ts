import { describe, expect, it } from "vitest";
import { ACTION_ITEMS, ASK_SUGGESTIONS, PAGE_ITEMS, modifierLabel, moveIndex, paletteItems } from "./commandPalette";

describe("paletteItems", () => {
  it("空输入的搜索模式给出全部页面和动作，页面在前", () => {
    const items = paletteItems("search", "");
    expect(items).toHaveLength(PAGE_ITEMS.length + ACTION_ITEMS.length);
    expect(items[0].group).toBe("pages");
    expect(items[items.length - 1].group).toBe("actions");
  });

  it("搜索时按标签 / 提示 / 关键词过滤，并在末尾兜底一条问 OfferU", () => {
    const items = paletteItems("search", "面试");
    expect(items.map((item) => item.id)).toEqual(["interview", "act-review", "ask-query"]);
    const last = items[items.length - 1];
    expect(last.group === "ask" && last.prompt).toBe("面试");
  });

  it("没有匹配时仍然可以回车把输入交给 OfferU", () => {
    const items = paletteItems("search", "  字节跳动截止时间  ");
    expect(items).toHaveLength(1);
    expect(items[0].group === "ask" && items[0].prompt).toBe("字节跳动截止时间");
  });

  it("问 OfferU 模式：空输入给示例问题，有输入只有这一条", () => {
    expect(paletteItems("ask", "")).toEqual(ASK_SUGGESTIONS);
    const items = paletteItems("ask", "我适合投哪些岗位");
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe("ask-query");
  });
});

describe("moveIndex", () => {
  it("上下键首尾循环", () => {
    expect(moveIndex(0, -1, 3)).toBe(2);
    expect(moveIndex(2, 1, 3)).toBe(0);
    expect(moveIndex(1, 1, 3)).toBe(2);
    expect(moveIndex(0, 1, 0)).toBe(0);
  });
});

describe("modifierLabel", () => {
  it("macOS 用 ⌘，其余用 Ctrl", () => {
    expect(modifierLabel("MacIntel")).toBe("⌘");
    expect(modifierLabel("Win32")).toBe("Ctrl");
    expect(modifierLabel("")).toBe("Ctrl");
  });
});
