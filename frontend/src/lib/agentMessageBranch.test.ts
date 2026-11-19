import { afterEach, describe, expect, it } from "vitest";
import { branchUpto, canBranchFrom, isLocalNoticeMessage, isWelcomeMessage, selectionWithin } from "./agentMessageBranch";

const messages = [
  { id: "welcome", role: "assistant", content: "你好" },
  { id: "conv-0", role: "user", content: "嗨" },
  { id: "conv-1", role: "assistant", content: "你好！" },
  { id: "assistant-abort-1", role: "assistant", content: "已取消当前 Run。" },
  { id: "user-turn-1", role: "user", content: "再来" },
  { id: "assistant-turn-1", role: "assistant", content: "第二轮" },
];

describe("branchUpto", () => {
  it("counts persisted messages through the target, skipping welcome + local notices", () => {
    expect(branchUpto(messages, "conv-0")).toBe(1);
    expect(branchUpto(messages, "conv-1")).toBe(2);
    expect(branchUpto(messages, "user-turn-1")).toBe(3);
    expect(branchUpto(messages, "assistant-turn-1")).toBe(4);
  });
  it("returns 0 for welcome, local notices and unknown ids", () => {
    expect(branchUpto(messages, "welcome")).toBe(0);
    expect(branchUpto(messages, "assistant-abort-1")).toBe(0);
    expect(branchUpto(messages, "nope")).toBe(0);
    expect(branchUpto([{ id: "welcome-123" }, { id: "x" }], "x")).toBe(1);
  });
});

describe("message kinds", () => {
  it("knows welcome and local notices", () => {
    expect(isWelcomeMessage({ id: "welcome" })).toBe(true);
    expect(isWelcomeMessage({ id: "welcome-1700" })).toBe(true);
    expect(isWelcomeMessage({ id: "conv-0" })).toBe(false);
    expect(isLocalNoticeMessage({ id: "assistant-abort-1" })).toBe(true);
    expect(isLocalNoticeMessage({ id: "assistant-partial-turn-2" })).toBe(true);
    expect(isLocalNoticeMessage({ id: "assistant-turn-1" })).toBe(false);
  });
  it("only persisted, non-empty messages can be branched from", () => {
    expect(canBranchFrom(messages[0])).toBe(false);
    expect(canBranchFrom(messages[3])).toBe(false);
    expect(canBranchFrom(messages[2])).toBe(true);
    expect(canBranchFrom({ id: "conv-9", content: "  " })).toBe(false);
  });
});

describe("selectionWithin", () => {
  afterEach(() => { window.getSelection()?.removeAllRanges(); document.body.innerHTML = ""; });

  it("returns the selected text only when the selection is inside the element", () => {
    document.body.innerHTML = `<div id="a"><p>第一段 被选中的文字 结尾</p></div><div id="b"><p>别处</p></div>`;
    const a = document.getElementById("a")!;
    const b = document.getElementById("b")!;
    const text = a.querySelector("p")!.firstChild!;
    const range = document.createRange();
    range.setStart(text, 4);
    range.setEnd(text, 10);
    window.getSelection()!.addRange(range);
    expect(selectionWithin(a)).toBe("被选中的文字");
    expect(selectionWithin(b)).toBe("");
    expect(selectionWithin(null)).toBe("");
  });

  it("is empty with no / collapsed selection", () => {
    document.body.innerHTML = `<div id="a">文字</div>`;
    expect(selectionWithin(document.getElementById("a"))).toBe("");
  });
});
